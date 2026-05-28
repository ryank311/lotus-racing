#!/usr/bin/env python3
"""
Garmin Catalyst data fetcher.

Pulls session telemetry from the undocumented GCS autosport REST API discovered
by decompiling the Catalyst Android APK. See README.md for full API documentation.

Usage:
    python catalyst_client.py                  # fetch all sessions
    python catalyst_client.py --session <guid> # fetch one session by ID
    python catalyst_client.py --list           # print session list only, no download
    python catalyst_client.py --probe          # hit endpoints and print raw JSON (debug)
    python catalyst_client.py --token <tok>    # override auth with a raw Bearer token

Auth: uses python-garminconnect (which wraps garth) for Garmin SSO login.
Tokens are saved to .garth/ in this directory and auto-refresh on use, so
subsequent runs skip re-authentication.

Garth's default mobile User-Agent is blocked by Garmin's Cloudflare setup, so
we override it with a desktop browser UA before login. See:
https://github.com/matin/garth/issues for the upstream tracker.

API requests go through garmin.garth.request() with subdomain="api.gcs", which
routes to https://api.gcs.garmin.com/ — the host that serves Catalyst data,
not the standard connectapi.garmin.com that Garmin Connect uses.
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
TOKEN_STORE = SCRIPT_DIR / ".garth"
DEFAULT_DATA_DIR = SCRIPT_DIR / "data" / "sessions"

GCS_SUBDOMAIN = "api.gcs"            # → https://api.gcs.garmin.com/
AUTOSPORT_PREFIX = "/autosport/api/v1"

# The Catalyst Android app's OAuth client ID. Discovered by string-searching
# libgecko.so in the decompiled APK. The autosport API rejects tokens issued
# under the default Garmin Connect mobile client_id — we have to exchange our
# token for one issued under this Catalyst-specific client_id.
CATALYST_CLIENT_ID = "GARMIN_MOBILE_CATALYST_ANDROID"
# Endpoint discovered by strings-analysis of libgecko.so (the native auth library)
SSO_TOKEN_URL = "https://services.garmin.com/api/oauth/token"
CATALYST_TOKEN_CACHE = SCRIPT_DIR / ".catalyst_token.json"

# Browser UA to bypass Cloudflare block on garth's default mobile UA.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print(
            f"[ERROR] config.json not found at {CONFIG_PATH}\n"
            f"        Copy config.example.json to config.json and fill in your credentials."
        )
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def init_garth(email: str, password: str):
    """
    Authenticate with Garmin SSO via garth and return (garth_client, had_fresh_login).

    On first run: performs a full SSO form login (sets SSO TGT cookies in the
    session), saves garth OAuth1+OAuth2 tokens to TOKEN_STORE, and returns
    had_fresh_login=True so the caller can immediately use the live SSO session
    to get a Catalyst service ticket before the cookies expire.

    On subsequent runs: loads tokens from TOKEN_STORE (no SSO cookies in
    session) and returns had_fresh_login=False.
    """
    try:
        import garth
    except ImportError:
        print("[ERROR] garth not installed. Run: pip install garth")
        sys.exit(1)

    tokenstore = str(TOKEN_STORE)
    garth.client.sess.headers.update({"User-Agent": BROWSER_UA})

    try:
        garth.resume(tokenstore)
        print("[auth] Resumed session from saved tokens")
        return garth.client, False
    except (FileNotFoundError, Exception) as e:
        if isinstance(e, FileNotFoundError):
            print("[auth] No saved tokens — performing fresh login")
        else:
            print(f"[auth] Token restore failed ({type(e).__name__}: {e}); fresh login")

    try:
        garth.login(
            email,
            password,
            prompt_mfa=lambda: input("MFA code (from Garmin app/email): ").strip(),
        )
        garth.save(tokenstore)
        print(f"[auth] Login successful; tokens saved to {tokenstore}/")
    except Exception as e:
        print(f"[ERROR] Login failed ({type(e).__name__}): {e}")
        sys.exit(1)

    return garth.client, True  # fresh login — SSO TGT cookies are live


def _get_catalyst_ticket_via_sso_session(garth_client) -> Tuple[Optional[str], str]:
    """
    Use the live SSO session (TGT cookies in garth_client.sess) to request a
    Catalyst-scoped CAS service ticket without re-entering credentials.

    Returns (ticket, service_url). Ticket is None on any failure.
    """
    import re

    sso_base = f"https://sso.{garth_client.domain}"
    service_url = f"{sso_base}/sso/embed"

    try:
        resp = garth_client.sess.get(
            f"{sso_base}/sso/login",
            params={
                "service": service_url,
                "mobile": "true",
                "clientId": CATALYST_CLIENT_ID,
            },
            timeout=30,
            allow_redirects=False,
        )
        print(f"[auth] SSO ticket request: {resp.status_code} "
              f"Location={resp.headers.get('Location','')[:100]}")

        location = resp.headers.get("Location", "")
        m = re.search(r"[?&]ticket=([^&\s]+)", location)
        if m:
            return m.group(1), service_url

        if resp.status_code == 200:
            m = re.search(r"[?&]ticket=([^&\"'\s]+)", resp.text)
            if m:
                return m.group(1), service_url
    except Exception as e:
        print(f"[auth] SSO session ticket request failed: {e}")

    return None, service_url


def browser_login_fallback(garth_client) -> Optional[Tuple[str, str]]:
    """
    Open a browser to let the user complete login (MFA, captcha, etc.).
    Spins up a tiny localhost HTTP server to capture the ticket from the
    redirect back. Returns (ticket, service_url) on success, None on cancel.
    """
    import http.server
    import socketserver
    import threading
    import urllib.parse
    import webbrowser

    sso_base = f"https://sso.{garth_client.domain}"
    # Use localhost as the service URL — the SSO will redirect there with
    # ?ticket=ST-... after successful login.
    callback_port = 8765
    service_url = f"http://localhost:{callback_port}/callback"

    login_url = (
        f"{sso_base}/sso/embed?"
        + urllib.parse.urlencode({
            "id": "gauth-widget",
            "embedWidget": "true",
            "gauthHost": sso_base,
            "service": service_url,
            "source": service_url,
            "redirectAfterAccountLoginUrl": service_url,
            "redirectAfterAccountCreationUrl": service_url,
            "mobile": "true",
            "clientId": CATALYST_CLIENT_ID,
        })
    )

    captured: dict = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if "ticket" in qs:
                captured["ticket"] = qs["ticket"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<h1>Login complete</h1>"
                    b"<p>You can close this tab and return to the terminal.</p>"
                )
                done.set()
            else:
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<h1>Waiting for ticket...</h1>"
                    b"<p>This page should be reached after completing login. "
                    b"If you see this without logging in, something went wrong.</p>"
                )

        def log_message(self, *args, **kwargs):
            pass  # silence noisy default access log

    try:
        server = socketserver.TCPServer(("127.0.0.1", callback_port), Handler)
    except OSError as e:
        print(f"[ERROR] Could not bind port {callback_port}: {e}")
        return None

    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    print(f"\n[auth] Opening browser for MFA/manual login...")
    print(f"       If the browser doesn't open, visit this URL manually:")
    print(f"       {login_url}\n")
    webbrowser.open(login_url)

    print(f"[auth] Waiting for login callback on http://localhost:{callback_port}/callback")
    print(f"       (Ctrl-C to cancel)")
    try:
        if not done.wait(timeout=300):
            print("[auth] Browser login timed out after 5 minutes")
            return None
    except KeyboardInterrupt:
        print("[auth] Cancelled")
        return None
    finally:
        server.shutdown()

    ticket = captured.get("ticket")
    if not ticket:
        return None
    print(f"[auth] Captured ticket: {ticket[:25]}...")
    return ticket, service_url


def load_catalyst_token() -> Optional[str]:
    """Load cached Catalyst token if it hasn't expired."""
    if not CATALYST_TOKEN_CACHE.exists():
        return None
    try:
        with open(CATALYST_TOKEN_CACHE) as f:
            data = json.load(f)
        expires_at = data.get("expires_at", 0)
        if time.time() < expires_at - 300:  # 5-min buffer
            return data["access_token"]
    except Exception:
        pass
    return None


def save_catalyst_token(access_token: str, expires_in: int) -> None:
    with open(CATALYST_TOKEN_CACHE, "w") as f:
        json.dump({
            "access_token": access_token,
            "expires_at": time.time() + expires_in,
        }, f)


def _exchange_ticket_for_token(sess: requests.Session, ticket: str,
                               service_url: str) -> str:
    """
    POST a CAS service ticket to /api/oauth/token to get a Catalyst-scoped
    OAuth2 access token. Format reverse-engineered from libgecko.so:
        grant_type=service_ticket&client_id=GARMIN_MOBILE_CATALYST_ANDROID
        &service_ticket=ST-...&service_url=<service used to mint ticket>
    """
    resp = sess.post(
        SSO_TOKEN_URL,
        data={
            "grant_type": "service_ticket",
            "client_id": CATALYST_CLIENT_ID,
            "service_ticket": ticket,
            "service_url": service_url,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    print(f"[auth] token exchange: {resp.status_code}")
    if not resp.ok:
        print(f"       body: {resp.text[:500]}")
        resp.raise_for_status()
    payload = resp.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"No access_token in response: {payload}")
    expires_in = int(payload.get("expires_in", 7776000))
    save_catalyst_token(token, expires_in)
    print(f"[auth] Catalyst token obtained "
          f"(expires_in={expires_in}s ≈ {expires_in // 86400}d); "
          f"cached to {CATALYST_TOKEN_CACHE.name}")
    return token


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class CatalystAPI:
    """
    Thin wrapper around the GCS autosport REST API.

    All endpoints live at:
        https://api.gcs.garmin.com/autosport/api/v1/<resource>

    There are two ways this class can be initialized:

    1. From a logged-in Garmin client (preferred):
           api = CatalystAPI(garmin=garmin)
       All requests go through garmin.garth.request(), which attaches the
       Bearer token and auto-refreshes it on expiry.

    2. From a raw Bearer token (e.g. captured from mitmproxy):
           api = CatalystAPI(bearer_token="...")
       Uses plain requests.Session with the token in the Authorization header.
       No auto-refresh — token will eventually expire.

    NOTE: API response field names are unconfirmed until real traffic is
    captured. Code is annotated where assumptions are made — run --probe
    first and inspect the raw output before relying on field names.
    """

    def __init__(
        self,
        garth_client=None,
        bearer_token: Optional[str] = None,
        extra_headers: Optional[dict] = None,
    ):
        if garth_client is None and not bearer_token:
            raise ValueError("Must provide either garth_client or bearer_token")

        self.garth_client = garth_client
        self.bearer_token = bearer_token
        self.extra_headers = extra_headers or {}
        self.customer_id = ""
        self._page_size = 50

        if bearer_token:
            self._session = requests.Session()
            self._session.headers.update({
                "Authorization": f"Bearer {bearer_token}",
                "Accept": "application/json",
                "User-Agent": BROWSER_UA,
                **self.extra_headers,
            })

    def _get(self, path: str, params: Optional[dict] = None) -> object:
        """
        GET an autosport endpoint. `path` is relative to /autosport/api/v1/.
        """
        full_path = f"{AUTOSPORT_PREFIX}/{path.lstrip('/')}"

        if self.garth_client is not None:
            # Garth handles token refresh and Bearer header automatically
            resp = self.garth_client.request(
                "GET", GCS_SUBDOMAIN, full_path,
                api=True,
                params=params,
                headers=self.extra_headers,
            )
        else:
            url = f"https://api.gcs.garmin.com{full_path}"
            resp = self._session.get(url, params=params, timeout=30)

        resp.raise_for_status()
        if resp.status_code == 204:
            return None
        return resp.json()

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------

    def get_customer(self) -> dict:
        """
        Fetch account record. Sets self.customer_id as a side effect.
        Inspect probe output to confirm the correct ID field name.
        """
        data = self._get("customer")
        if isinstance(data, dict):
            for field in ("customerId", "id", "customerNumber", "uuid", "guid"):
                if data.get(field):
                    self.customer_id = str(data[field])
                    break
        return data

    def get_user(self) -> dict:
        return self._get("user")

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def get_sessions_count(self, **filters) -> int:
        data = self._get("sessions/count", params=self._filter_params(**filters))
        if isinstance(data, int):
            return data
        if isinstance(data, dict):
            for field in ("count", "total", "totalCount"):
                if field in data:
                    return int(data[field])
        return 0

    def get_sessions(self, limit: Optional[int] = None, offset: int = 0, **filters) -> List[dict]:
        """
        Fetch sessions. Pass limit=None to auto-paginate.
        Filter kwargs: start, end, track_config_id, reverse (see _filter_params).
        """
        if limit is not None:
            params = {"limit": limit, "offset": offset, **self._filter_params(**filters)}
            result = self._get("sessions", params=params)
            return result if isinstance(result, list) else []

        all_sessions = []
        page_offset = 0
        while True:
            params = {"limit": self._page_size, "offset": page_offset, **self._filter_params(**filters)}
            page = self._get("sessions", params=params)
            if not page or not isinstance(page, list):
                break
            all_sessions.extend(page)
            print(f"  [sessions] fetched {len(all_sessions)} so far...")
            if len(page) < self._page_size:
                break
            page_offset += self._page_size
            time.sleep(0.2)
        return all_sessions

    def get_sessions_metadata(self, **filters) -> list:
        return self._get("sessions/metadata", params=self._filter_params(**filters))

    def get_session(self, session_id: str) -> dict:
        """
        Full detail for one session: lap list, performance data, weather, optimal lap.
        Inspect session_detail.json after first probe to learn the full schema.
        """
        return self._get("session", params={"sessionId": session_id})

    def get_session_track_days(self, **filters) -> list:
        return self._get("session-track-days", params=self._filter_params(**filters))

    # ------------------------------------------------------------------
    # Telemetry
    # ------------------------------------------------------------------

    def get_mean_line(self, session_id: str) -> dict:
        """
        Reference GPS line for a session — the lat/lon path the Catalyst uses
        to compute lateral position and draw the track map. Query param name
        unconfirmed; the meanline_guid field in a session response may be the
        right key. Inspect mean_line.json after first run.
        """
        return self._get("meanLine", params={"sessionId": session_id})

    # ------------------------------------------------------------------
    # Tracks
    # ------------------------------------------------------------------

    def get_track(self, track_id: Optional[str] = None) -> dict:
        return self._get("track", params={"trackId": track_id} if track_id else None)

    def get_track_configurations(self, track_id: Optional[str] = None) -> list:
        return self._get("trackConfigurations", params={"trackId": track_id} if track_id else None)

    def get_track_facilities(self) -> list:
        return self._get("trackFacilities", params={"limit": self._page_size})

    # ------------------------------------------------------------------
    # Leaderboards
    # ------------------------------------------------------------------

    def get_leaderboard_session(self, session_id: str) -> dict:
        return self._get("leaderboard/session", params={"sessionId": session_id})

    def get_leaderboard_day(self, track_day_id: str) -> dict:
        return self._get("leaderboard/day", params={"trackDayId": track_day_id})

    def get_leaderboard_annual(self) -> dict:
        return self._get("leaderboard/annual")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _filter_params(self, **kwargs) -> dict:
        """Map friendly kwargs to API query param names, drop None values."""
        mapping = {
            "start": "filterStartDateTime",
            "end": "filterEndDateTime",
            "track_config_id": "filterTrackConfigurationId",
            "reverse": "filterTrackIsReverse",
        }
        return {mapping.get(k, k): v for k, v in kwargs.items() if v is not None}


# ---------------------------------------------------------------------------
# Data saving
# ---------------------------------------------------------------------------

def save_json(data: object, path: Path, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2 if pretty else None, default=str)


def extract_session_id(s: dict) -> Optional[str]:
    """Extract session ID from a record. Field name unconfirmed — update after probe."""
    for field in ("sessionId", "id", "guid", "uuid"):
        if s.get(field):
            return str(s[field])
    return None


def fetch_and_save_session(api: CatalystAPI, session_id: str, data_dir: Path, pretty: bool) -> None:
    """
    Fetch one session's data and write to data_dir/<session_id>/.

    Files written:
        session_detail.json  — full session + lap list (GET /session)
        mean_line.json       — reference GPS path (GET /meanLine)
        leaderboard.json     — session leaderboard
    """
    out = data_dir / session_id
    out.mkdir(parents=True, exist_ok=True)
    print(f"  [session] {session_id}")

    for label, fetch, filename in [
        ("session detail", lambda: api.get_session(session_id), "session_detail.json"),
        ("mean line",      lambda: api.get_mean_line(session_id), "mean_line.json"),
        ("leaderboard",    lambda: api.get_leaderboard_session(session_id), "leaderboard.json"),
    ]:
        try:
            data = fetch()
            save_json(data, out / filename, pretty)
            print(f"    wrote {filename}")
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else "?"
            print(f"    [WARN] {label} failed ({code}): {e}")
        except Exception as e:
            print(f"    [WARN] {label} failed ({type(e).__name__}): {e}")


def fetch_all_sessions(api: CatalystAPI, data_dir: Path, pretty: bool) -> None:
    """
    Fetch every session. Already-downloaded sessions (session_detail.json exists)
    are skipped. Writes sessions_index.json as a master manifest.
    """
    print("[sessions] Fetching session list...")
    sessions = api.get_sessions()
    print(f"[sessions] Found {len(sessions)} sessions")

    save_json(sessions, data_dir.parent / "sessions_index.json", pretty)
    print(f"[sessions] Wrote sessions_index.json")

    for s in sessions:
        session_id = extract_session_id(s)
        if not session_id:
            print(f"  [WARN] No session ID in record: {json.dumps(s)[:200]}")
            continue
        if (data_dir / session_id / "session_detail.json").exists():
            print(f"  [skip] {session_id} (already downloaded)")
            continue
        fetch_and_save_session(api, session_id, data_dir, pretty)
        time.sleep(0.3)


# ---------------------------------------------------------------------------
# Probe — diagnostic first-run tool
# ---------------------------------------------------------------------------

def probe_endpoints(api: CatalystAPI, data_dir: Path, pretty: bool) -> None:
    """
    Hit each key endpoint and write the raw response to data_dir/../probe/.
    Run this first — the raw responses reveal the actual field names which
    may differ from our guesses.
    """
    probe_dir = data_dir.parent / "probe"
    probe_dir.mkdir(parents=True, exist_ok=True)
    print(f"[probe] Writing raw API responses to {probe_dir}")

    endpoints = [
        ("customer",          "customer",         {}),
        ("user",              "user",             {}),
        ("sessions_count",    "sessions/count",   {}),
        ("sessions_first_5",  "sessions",         {"limit": 5}),
        ("sessions_metadata", "sessions/metadata", {}),
        ("track_facilities",  "trackFacilities",  {"limit": 5}),
        ("leaderboard_annual", "leaderboard/annual", {}),
    ]

    for name, path, params in endpoints:
        print(f"  GET /autosport/api/v1/{path} ...")
        try:
            data = api._get(path, params=params or None)
            out_path = probe_dir / f"{name}.json"
            save_json(data, out_path, pretty=True)
            preview = json.dumps(data, default=str)[:300]
            print(f"    -> {out_path.name}  preview: {preview}")
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else "?"
            body = ""
            try:
                body = e.response.text[:300]
            except Exception:
                pass
            print(f"    FAILED {code}: {body}")
        except Exception as e:
            print(f"    FAILED ({type(e).__name__}): {e}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Fetch Garmin Catalyst session data via GCS autosport API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  python catalyst_client.py --probe           # inspect raw API responses (do this first)
  python catalyst_client.py --list            # print session list
  python catalyst_client.py                   # download all sessions
  python catalyst_client.py --session <guid>  # download one session
  python catalyst_client.py --token <tok>     # use a captured Bearer token
        """,
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--probe", action="store_true",
                      help="Hit all endpoints and save raw responses to data/probe/ (run this first)")
    mode.add_argument("--list", action="store_true",
                      help="Print session list only, no download")
    mode.add_argument("--session", metavar="GUID",
                      help="Download one session by ID")
    p.add_argument("--token", metavar="TOKEN",
                   help="Raw Bearer token (overrides config auth, useful with mitmproxy capture)")
    p.add_argument("--data-dir", metavar="PATH",
                   help=f"Output directory (default: {DEFAULT_DATA_DIR})")
    p.add_argument("--clear-tokens", action="store_true",
                   help="Delete the garth token store and force a fresh login")
    return p.parse_args()


def main():
    args = parse_args()
    cfg = load_config()

    out_cfg = cfg.get("output", {})
    auth_cfg = cfg.get("auth", {})

    pretty = out_cfg.get("pretty_json", True)
    data_dir = Path(args.data_dir or out_cfg.get("data_dir", DEFAULT_DATA_DIR))

    if args.clear_tokens:
        import shutil
        if TOKEN_STORE.exists():
            shutil.rmtree(TOKEN_STORE)
            print(f"[auth] Cleared garth token store at {TOKEN_STORE}")
        if CATALYST_TOKEN_CACHE.exists():
            CATALYST_TOKEN_CACHE.unlink()
            print(f"[auth] Cleared Catalyst token cache")

    # Decide auth path
    raw_token = (args.token or auth_cfg.get("bearer_token", "")).strip()

    if raw_token:
        print("[auth] Using raw Bearer token (skipping garth)")
        extra_headers = {}
        if auth_cfg.get("x_garmin_client_id"):
            extra_headers["X-Garmin-Client-Id"] = auth_cfg["x_garmin_client_id"]
        if auth_cfg.get("x_garmin_unit_id"):
            extra_headers["X-Garmin-Unit-Id"] = auth_cfg["x_garmin_unit_id"]
        api = CatalystAPI(bearer_token=raw_token, extra_headers=extra_headers)
        api.customer_id = auth_cfg.get("customer_id", "").strip()
    else:
        email = auth_cfg.get("email", "").strip()
        password = auth_cfg.get("password", "").strip()
        if not email or not password:
            print(
                "[ERROR] No auth configured.\n"
                "  Option A: set email + password in config.json (recommended)\n"
                "  Option B: set bearer_token to a token captured from mitmproxy/Charles\n"
                "  Option C: use --token <raw_token> on the CLI"
            )
            sys.exit(1)
        # Try cached Catalyst token first (90-day lifetime)
        catalyst_token = load_catalyst_token()
        if catalyst_token:
            print("[auth] Using cached Catalyst token")
        else:
            garth_client, fresh_login = init_garth(email, password)
            if not fresh_login:
                # Resumed session has no SSO cookies — force a fresh login to
                # get TGT cookies in the live session.
                print("[auth] Need fresh SSO session to mint Catalyst ticket; "
                      "clearing garth tokens and re-logging in...")
                import shutil
                if TOKEN_STORE.exists():
                    shutil.rmtree(TOKEN_STORE)
                garth_client, _ = init_garth(email, password)

            ticket, service_url = _get_catalyst_ticket_via_sso_session(garth_client)
            if not ticket:
                print("[auth] Headless SSO ticket request failed "
                      "(may require MFA or extra verification). "
                      "Falling back to browser login.")
                result = browser_login_fallback(garth_client)
                if not result:
                    print("[ERROR] Browser login failed or was cancelled.")
                    sys.exit(1)
                ticket, service_url = result

            catalyst_token = _exchange_ticket_for_token(
                garth_client.sess, ticket, service_url
            )

        api = CatalystAPI(bearer_token=catalyst_token)

    api._page_size = cfg.get("api", {}).get("page_size", 50)

    if not api.customer_id:
        print("[account] Fetching customer ID from API...")
        try:
            api.get_customer()
            print(f"[account] customer_id = {api.customer_id or '(not found in response)'}")
        except Exception as e:
            print(f"[WARN] Could not fetch customer ID: {e}")

    if args.probe:
        probe_endpoints(api, data_dir, pretty)
        return

    if args.list:
        sessions = api.get_sessions()
        print(f"\n{'ID':<40} {'Date':<25} {'Track':<30} {'Best Lap'}")
        print("-" * 110)
        for s in sessions:
            sid = extract_session_id(s) or "?"
            date = s.get("startDateTime") or s.get("startTime") or s.get("date") or ""
            track = s.get("trackName") or s.get("track_name") or s.get("trackConfigurationName") or ""
            best = s.get("bestLapDurationNormal") or s.get("bestLap") or ""
            print(f"{sid:<40} {str(date):<25} {str(track):<30} {best}")
        print(f"\nTotal: {len(sessions)} sessions")
        return

    if args.session:
        fetch_and_save_session(api, args.session, data_dir, pretty)
        return

    fetch_all_sessions(api, data_dir, pretty)


if __name__ == "__main__":
    main()
