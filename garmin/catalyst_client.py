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

Auth: reads config.json. Uses python-garminconnect for Garmin SSO login.
Tokens are cached in .token_cache.json so subsequent runs skip re-authentication.
If garminconnect login fails, fall back to a raw Bearer token from config or --token.
"""

import argparse
import json
import os
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
TOKEN_CACHE_PATH = SCRIPT_DIR / ".token_cache.json"
DEFAULT_DATA_DIR = SCRIPT_DIR / "data" / "sessions"

API_BASE = "https://api.gcs.garmin.com"
AUTOSPORT = "/autosport/api/v1"


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

def _save_token_cache(access_token: str, customer_id: str) -> None:
    with open(TOKEN_CACHE_PATH, "w") as f:
        json.dump({"access_token": access_token, "customer_id": customer_id}, f)


def _load_token_cache() -> Tuple[str, str]:
    if TOKEN_CACHE_PATH.exists():
        try:
            with open(TOKEN_CACHE_PATH) as f:
                data = json.load(f)
            return data.get("access_token", ""), data.get("customer_id", "")
        except Exception:
            pass
    return "", ""


def build_session_garminconnect(email: str, password: str) -> Tuple[requests.Session, str]:
    """
    Authenticate via python-garminconnect. Returns a requests.Session with the
    Authorization header pre-set and the customerId string.

    Caches the token in .token_cache.json so subsequent runs skip login.
    """
    try:
        from garminconnect import Garmin, GarminConnectAuthenticationError
    except ImportError:
        print("[ERROR] garminconnect not installed. Run: pip install garminconnect")
        sys.exit(1)

    # Try cached token first
    cached_token, cached_customer_id = _load_token_cache()
    if cached_token:
        print("[auth] Using cached access token")
        session = build_session_token(cached_token)
        return session, cached_customer_id

    print(f"[auth] Logging in as {email} via Garmin SSO...")
    try:
        client = Garmin(email, password)
        client.login()
        print("[auth] Login successful")
    except GarminConnectAuthenticationError as e:
        print(f"[ERROR] Garmin login failed (wrong credentials?): {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] Garmin login failed: {e}")
        sys.exit(1)

    # python-garminconnect stores a requests.Session internally.
    # We want the raw access token so we can use our own session for the GCS API.
    access_token = ""
    customer_id = ""

    try:
        # The client session has the Garmin auth cookies/headers baked in.
        # Extract the Bearer token from the underlying session headers or client state.
        if hasattr(client, "garth"):
            # newer versions embed garth
            access_token = client.garth.oauth2_token.access_token
            customer_id = str(getattr(client.garth, "display_name", "") or "")
        elif hasattr(client, "session") and hasattr(client.session, "headers"):
            auth_header = client.session.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                access_token = auth_header.split(" ", 1)[1]
        if not access_token and hasattr(client, "oauth_token"):
            access_token = client.oauth_token
    except Exception as e:
        print(f"[WARN] Could not extract access token from garminconnect client: {e}")

    if not access_token:
        # Fall back: use the client's internal session directly for GCS calls.
        # This won't work against api.gcs.garmin.com unless it shares the same
        # SSO cookie domain — but worth trying.
        print("[WARN] Could not extract raw Bearer token; will try using garminconnect session directly.")
        http_session = client.session if hasattr(client, "session") else requests.Session()
        http_session.headers.update({"Accept": "application/json"})
        return http_session, customer_id

    _save_token_cache(access_token, customer_id)
    session = build_session_token(access_token)
    return session, customer_id


def build_session_token(token: str) -> requests.Session:
    """Build a requests.Session using a raw Bearer token (e.g. from mitmproxy capture)."""
    session = requests.Session()
    session.headers.update({
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    })
    return session


def get_auth_session(cfg: dict, token_override: Optional[str]) -> Tuple[requests.Session, str]:
    """
    Returns (requests.Session with auth headers, customer_id).

    Priority:
      1. --token CLI flag (raw Bearer token, no customer_id lookup)
      2. config.json bearer_token field (same)
      3. garminconnect login via config.json email/password
    """
    auth = cfg.get("auth", {})

    raw_token = (token_override or auth.get("bearer_token", "")).strip()
    if raw_token:
        print("[auth] Using raw Bearer token")
        session = build_session_token(raw_token)
        customer_id = auth.get("customer_id", "").strip()
        if auth.get("x_garmin_client_id"):
            session.headers["X-Garmin-Client-Id"] = auth["x_garmin_client_id"]
        if auth.get("x_garmin_unit_id"):
            session.headers["X-Garmin-Unit-Id"] = auth["x_garmin_unit_id"]
        return session, customer_id

    email = auth.get("email", "").strip()
    password = auth.get("password", "").strip()
    if not email or not password:
        print(
            "[ERROR] No auth configured.\n"
            "  Option A: set email + password in config.json\n"
            "  Option B: set bearer_token to a token captured from mitmproxy/Charles Proxy\n"
            "  Option C: use --token <raw_token> on the CLI"
        )
        sys.exit(1)

    session, customer_id = build_session_garminconnect(email, password)
    if not customer_id:
        customer_id = auth.get("customer_id", "").strip()
    return session, customer_id


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class CatalystAPI:
    """
    Thin wrapper around the GCS autosport REST API.

    All endpoints live at:
        https://api.gcs.garmin.com/autosport/api/v1/<resource>

    Authentication is a Bearer token in the Authorization header, set on the
    requests.Session passed to __init__.

    customerId is the Garmin account UUID — required for most list endpoints.
    It is discovered automatically via GET /customer if not provided.

    NOTE: Field names in API responses are unconfirmed until real traffic is
    captured. The code is annotated where assumptions are made — inspect the
    raw probe output and update field names as needed.
    """

    def __init__(self, session: requests.Session, customer_id: str = "", base_url: str = API_BASE):
        self.session = session
        self.base_url = base_url.rstrip("/")
        self.customer_id = customer_id
        self._page_size = 50

    def _url(self, path: str) -> str:
        return f"{self.base_url}{AUTOSPORT}/{path.lstrip('/')}"

    def _get(self, path: str, params: Optional[dict] = None) -> object:
        url = self._url(path)
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------

    def get_customer(self) -> dict:
        """
        Fetch account/customer record. Sets self.customer_id as a side effect.
        NOTE: Inspect the raw response from --probe to find the correct ID field name.
        """
        data = self._get("customer")
        for field in ("customerId", "id", "customerNumber", "uuid", "guid"):
            if isinstance(data, dict) and data.get(field):
                self.customer_id = str(data[field])
                break
        return data

    def get_user(self) -> dict:
        return self._get("user")

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def get_sessions_count(self, **filters) -> int:
        params = self._filter_params(**filters)
        data = self._get("sessions/count", params=params)
        if isinstance(data, int):
            return data
        if isinstance(data, dict):
            for field in ("count", "total", "totalCount"):
                if field in data:
                    return int(data[field])
        return 0

    def get_sessions(self, limit: Optional[int] = None, offset: int = 0, **filters) -> List[dict]:
        """
        Fetch sessions. Pass limit=None to auto-paginate all sessions.
        filters: start, end, track_config_id, reverse (see _filter_params)
        """
        if limit is not None:
            params = {"limit": limit, "offset": offset}
            params.update(self._filter_params(**filters))
            result = self._get("sessions", params=params)
            return result if isinstance(result, list) else []

        all_sessions = []
        page_offset = 0
        while True:
            params = {"limit": self._page_size, "offset": page_offset}
            params.update(self._filter_params(**filters))
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
        params = self._filter_params(**filters)
        return self._get("sessions/metadata", params=params)

    def get_session(self, session_id: str) -> dict:
        """
        Fetch full detail for a single session by GUID.
        The detail response should include lap list, performance data, weather, and
        the optimal lap composition. Inspect session_detail.json to understand the
        full schema before building analysis on top of it.
        """
        return self._get("session", params={"sessionId": session_id})

    def get_session_track_days(self, **filters) -> list:
        params = self._filter_params(**filters)
        return self._get("session-track-days", params=params)

    # ------------------------------------------------------------------
    # Telemetry
    # ------------------------------------------------------------------

    def get_mean_line(self, session_id: str) -> dict:
        """
        Fetch the mean driven GPS line for a session. Contains the reference
        lat/lon path that the Catalyst uses to calculate lateral position and
        draw the track map.

        The query param name is unconfirmed. sessionId is the best guess.
        The meanline_guid field in a session response may be the correct key.
        Inspect mean_line.json after first run.
        """
        return self._get("meanLine", params={"sessionId": session_id})

    # ------------------------------------------------------------------
    # Tracks
    # ------------------------------------------------------------------

    def get_track(self, track_id: Optional[str] = None) -> dict:
        params = {"trackId": track_id} if track_id else None
        return self._get("track", params=params)

    def get_track_configurations(self, track_id: Optional[str] = None) -> list:
        params = {"trackId": track_id} if track_id else None
        return self._get("trackConfigurations", params=params)

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
        """Map friendly keyword args to API query param names, drop None values."""
        mapping = {
            "start": "filterStartDateTime",
            "end": "filterEndDateTime",
            "track_config_id": "filterTrackConfigurationId",
            "reverse": "filterTrackIsReverse",
        }
        params = {}
        for k, v in kwargs.items():
            if v is None:
                continue
            params[mapping.get(k, k)] = v
        return params


# ---------------------------------------------------------------------------
# Data saving
# ---------------------------------------------------------------------------

def save_json(data: object, path: Path, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2 if pretty else None, default=str)


def extract_session_id(s: dict) -> Optional[str]:
    """
    Extract the session ID from a session record.
    Field name is unconfirmed — update this list once real responses are seen.
    """
    for field in ("sessionId", "id", "guid", "uuid"):
        val = s.get(field)
        if val:
            return str(val)
    return None


def fetch_and_save_session(api: CatalystAPI, session_id: str, data_dir: Path, pretty: bool) -> None:
    """
    Fetch all available data for one session and write to data_dir/<session_id>/.

    Files written:
        session_detail.json  — full session + lap list from GET /session
        mean_line.json       — reference GPS path from GET /meanLine
        leaderboard.json     — session leaderboard position
    """
    out = data_dir / session_id
    out.mkdir(parents=True, exist_ok=True)
    print(f"  [session] {session_id}")

    try:
        detail = api.get_session(session_id)
        save_json(detail, out / "session_detail.json", pretty)
        print(f"    wrote session_detail.json")
    except requests.HTTPError as e:
        print(f"    [WARN] session detail failed ({e.response.status_code}): {e}")

    try:
        mean_line = api.get_mean_line(session_id)
        save_json(mean_line, out / "mean_line.json", pretty)
        print(f"    wrote mean_line.json")
    except requests.HTTPError as e:
        print(f"    [WARN] mean line failed ({e.response.status_code}): {e}")

    try:
        lb = api.get_leaderboard_session(session_id)
        save_json(lb, out / "leaderboard.json", pretty)
        print(f"    wrote leaderboard.json")
    except requests.HTTPError as e:
        print(f"    [WARN] leaderboard failed ({e.response.status_code}): {e}")


def fetch_all_sessions(api: CatalystAPI, data_dir: Path, pretty: bool) -> None:
    """
    Fetch every session. Already-downloaded sessions (session_detail.json exists) are skipped.
    Writes sessions_index.json to data_dir/../ as a master manifest.
    """
    print("[sessions] Fetching session list...")
    sessions = api.get_sessions()
    print(f"[sessions] Found {len(sessions)} sessions")

    save_json(sessions, data_dir.parent / "sessions_index.json", pretty)
    print(f"[sessions] Wrote sessions_index.json")

    for s in sessions:
        session_id = extract_session_id(s)
        if not session_id:
            print(f"  [WARN] Could not find session ID in record: {json.dumps(s)[:200]}")
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
    This is the most important step when running for the first time — the raw
    responses reveal the actual field names, which may differ from our guesses.
    """
    probe_dir = data_dir.parent / "probe"
    probe_dir.mkdir(parents=True, exist_ok=True)
    print(f"[probe] Writing raw API responses to {probe_dir}")

    endpoints = [
        ("customer", "customer", {}),
        ("user", "user", {}),
        ("sessions_count", "sessions/count", {}),
        ("sessions_first_5", "sessions", {"limit": 5}),
        ("sessions_metadata", "sessions/metadata", {}),
        ("track_facilities", "trackFacilities", {"limit": 5}),
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
            body = ""
            try:
                body = e.response.text[:300]
            except Exception:
                pass
            print(f"    FAILED {e.response.status_code}: {body}")
        except Exception as e:
            print(f"    FAILED: {e}")


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
    p.add_argument("--clear-cache", action="store_true",
                   help="Delete cached token and re-authenticate")
    return p.parse_args()


def main():
    args = parse_args()
    cfg = load_config()

    api_cfg = cfg.get("api", {})
    out_cfg = cfg.get("output", {})

    base_url = api_cfg.get("base_url", API_BASE)
    pretty = out_cfg.get("pretty_json", True)
    data_dir = Path(args.data_dir or out_cfg.get("data_dir", DEFAULT_DATA_DIR))

    if args.clear_cache and TOKEN_CACHE_PATH.exists():
        TOKEN_CACHE_PATH.unlink()
        print("[auth] Cleared token cache")

    http_session, customer_id = get_auth_session(cfg, args.token)

    api = CatalystAPI(http_session, customer_id=customer_id, base_url=base_url)
    api._page_size = api_cfg.get("page_size", 50)

    if not api.customer_id:
        print("[account] Fetching customer ID from API...")
        try:
            api.get_customer()
            print(f"[account] customer_id = {api.customer_id}")
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
