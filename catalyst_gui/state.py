"""
Read-only inspection of auth/sync state.

The GUI uses this to decide what to show on the home screen and whether the
login flow needs to run. We deliberately avoid duplicating the auth logic —
that lives in `garmin.catalyst_client` — we just check whether its outputs exist.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths


@dataclass
class AuthState:
    has_catalyst_token: bool
    token_expires_at: float | None  # epoch seconds
    has_garth_tokens: bool

    @property
    def token_valid(self) -> bool:
        if not self.has_catalyst_token or not self.token_expires_at:
            return False
        return time.time() < self.token_expires_at - 300  # 5-min buffer

    @property
    def token_days_remaining(self) -> int | None:
        if not self.token_expires_at:
            return None
        return max(0, int((self.token_expires_at - time.time()) / 86400))


def read_auth_state() -> AuthState:
    expires_at: float | None = None
    has_cat = paths.CATALYST_TOKEN_CACHE.exists()
    if has_cat:
        try:
            d = json.loads(paths.CATALYST_TOKEN_CACHE.read_text())
            expires_at = float(d.get("expires_at", 0)) or None
        except Exception:
            has_cat = False
    return AuthState(
        has_catalyst_token=has_cat,
        token_expires_at=expires_at,
        has_garth_tokens=paths.GARTH_TOKEN_DIR.exists(),
    )


def read_account_email() -> str | None:
    """Try to read the configured email from config.json. Returns None if missing."""
    if not paths.CONFIG_PATH.exists():
        return None
    try:
        cfg = json.loads(paths.CONFIG_PATH.read_text())
        return (cfg.get("auth", {}).get("email") or "").strip() or None
    except Exception:
        return None


@dataclass
class SyncStats:
    """Quick on-disk summary used before the DB is loaded."""
    session_count: int
    total_size_bytes: int
    last_sync_epoch: float | None

    @property
    def last_sync_ago_human(self) -> str:
        if not self.last_sync_epoch:
            return "never"
        delta = time.time() - self.last_sync_epoch
        if delta < 90:
            return f"{int(delta)}s ago"
        if delta < 5400:
            return f"{int(delta // 60)} min ago"
        if delta < 172800:
            return f"{int(delta // 3600)} h ago"
        return f"{int(delta // 86400)} days ago"


def read_sync_stats() -> SyncStats:
    if not paths.SESSIONS_DIR.exists():
        return SyncStats(0, 0, None)
    sessions = [d for d in paths.SESSIONS_DIR.iterdir() if d.is_dir()]
    total = 0
    latest = 0.0
    for s in sessions:
        for f in s.iterdir():
            if f.is_file():
                st = f.stat()
                total += st.st_size
                if st.st_mtime > latest:
                    latest = st.st_mtime
    return SyncStats(
        session_count=len(sessions),
        total_size_bytes=total,
        last_sync_epoch=latest or None,
    )


def humanise_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n:.1f} TB"
