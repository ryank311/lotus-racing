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

def init_garmin(email: str, password: str) -> "object":
    """
    Log in to Garmin SSO and return a Garmin client. The client's underlying
    `.garth` attribute is what we use for all API calls — it handles token
    refresh and Bearer header injection automatically.

    First call: tries to restore tokens from TOKEN_STORE. If that fails,
    prompts for credentials (and MFA if configured on the account) and saves
    fresh tokens to TOKEN_STORE.

    Subsequent calls: just restores from TOKEN_STORE. Tokens auto-refresh.
    """
    try:
        from garminconnect import (
            Garmin,
            GarminConnectAuthenticationError,
            GarminConnectConnectionError,
            GarminConnectTooManyRequestsError,
        )
    except ImportError:
        print("[ERROR] garminconnect not installed. Run: pip install garminconnect")
        sys.exit(1)

    tokenstore = str(TOKEN_STORE)

    # Try saved tokens first
    try:
        garmin = Garmin()
        garmin.garth.sess.headers.update({"User-Agent": BROWSER_UA})
        garmin.login(tokenstore)
        print("[auth] Resumed session from saved tokens")
        return garmin
    except (GarminConnectAuthenticationError, GarminConnectConnectionError, FileNotFoundError):
        print("[auth] No valid saved tokens — performing fresh login")
    except Exception as e:
        print(f"[auth] Token restore failed ({type(e).__name__}: {e}); doing fresh login")

    # Fresh login
    garmin = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("MFA code (from Garmin app/email): ").strip(),
    )
    garmin.garth.sess.headers.update({"User-Agent": BROWSER_UA})

    try:
        garmin.login(tokenstore)
        print(f"[auth] Login successful; tokens saved to {tokenstore}/")
    except GarminConnectAuthenticationError as e:
        print(f"[ERROR] Wrong credentials: {e}")
        sys.exit(1)
    except GarminConnectTooManyRequestsError as e:
        print(f"[ERROR] Rate limited: {e}")
        sys.exit(1)

    return garmin


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
        garmin: Optional["object"] = None,
        bearer_token: Optional[str] = None,
        extra_headers: Optional[dict] = None,
    ):
        if garmin is None and not bearer_token:
            raise ValueError("Must provide either garmin client or bearer_token")

        self.garmin = garmin
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

        if self.garmin is not None:
            # Use garth — token refresh and Bearer header are handled internally
            resp = self.garmin.garth.request(
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

    if args.clear_tokens and TOKEN_STORE.exists():
        import shutil
        shutil.rmtree(TOKEN_STORE)
        print(f"[auth] Cleared token store at {TOKEN_STORE}")

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
        garmin = init_garmin(email, password)
        api = CatalystAPI(garmin=garmin)

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
