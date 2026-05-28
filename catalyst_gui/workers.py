"""
Background QThread workers — anything that hits the network or does heavy I/O
must run off the GUI thread or the window freezes.

We emit Qt signals for progress lines, errors, and completion. The view connects
to those signals and updates labels / progress bars / status banners.
"""
from __future__ import annotations

import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from PySide6.QtCore import QObject, QThread, Signal

from . import paths


class _StreamToSignal(io.TextIOBase):
    """Pipe `print()` from worker code into a Qt signal line-by-line."""
    def __init__(self, signal):
        super().__init__()
        self._sig = signal
        self._buf = ""

    def write(self, s: str) -> int:
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.strip():
                self._sig.emit(line)
        return len(s)

    def flush(self) -> None:
        if self._buf.strip():
            self._sig.emit(self._buf)
            self._buf = ""


class SyncWorker(QObject):
    """
    Run garmin.catalyst_client.fetch_all_sessions() in a background thread.

    Signals:
        log(str)      — each progress line from the sync (suitable for a log pane)
        failed(str)   — fatal error message
        finished(int) — emitted with the number of sessions touched (0 if unknown)
    """

    log = Signal(str)
    failed = Signal(str)
    finished = Signal(int)

    def __init__(self, email: str | None, password: str | None):
        super().__init__()
        self._email = email
        self._password = password

    def run(self) -> None:
        try:
            # Imports here so the GUI process boots fast even if garth/requests
            # are slow to import.
            from garmin import catalyst_client as cc

            # If no credentials in config, the user has to provide them via the
            # login dialog. We stash them temporarily in env so cc.init_garth
            # can pick them up without rewriting config.json.
            email = self._email
            password = self._password
            if not email or not password:
                # Fall back to config.json contents
                cfg = cc.load_config()
                email = (cfg.get("auth", {}).get("email") or "").strip()
                password = (cfg.get("auth", {}).get("password") or "").strip()
            if not email or not password:
                self.failed.emit(
                    "No credentials. Either fill in garmin/config.json or "
                    "enter them in the Login dialog."
                )
                return

            stream = _StreamToSignal(self.log)
            with redirect_stdout(stream), redirect_stderr(stream):
                # Use cached Catalyst token if it's valid; otherwise full flow
                token = cc.load_catalyst_token()
                if not token:
                    garth_client, fresh = cc.init_garth(email, password)
                    if not fresh:
                        # Resume path doesn't have SSO cookies — force fresh login
                        import shutil
                        if paths.GARTH_TOKEN_DIR.exists():
                            shutil.rmtree(paths.GARTH_TOKEN_DIR)
                        garth_client, _ = cc.init_garth(email, password)
                    ticket, service_url = cc._get_catalyst_ticket_via_sso_session(
                        garth_client
                    )
                    if not ticket:
                        self.failed.emit(
                            "SSO ticket request failed. The account may need "
                            "MFA — run `catalyst-fetch --probe` from the "
                            "terminal once to complete the browser fallback."
                        )
                        return
                    token = cc._exchange_ticket_for_token(
                        garth_client.sess, ticket, service_url
                    )

                api = cc.CatalystAPI(bearer_token=token)
                api._page_size = 50
                cc.fetch_all_sessions(api, paths.SESSIONS_DIR, pretty=True)

            self.finished.emit(0)
        except Exception as e:
            tb = traceback.format_exc()
            self.failed.emit(f"{type(e).__name__}: {e}\n\n{tb}")


class DbLoadWorker(QObject):
    """Run garmin.load_to_db.main() in a background thread."""
    log = Signal(str)
    failed = Signal(str)
    finished = Signal()

    def run(self) -> None:
        try:
            from garmin import load_to_db
            stream = _StreamToSignal(self.log)
            with redirect_stdout(stream), redirect_stderr(stream):
                con = __import__("duckdb").connect(str(paths.DB_PATH))
                load_to_db.init_schema(con)
                load_to_db.load_track_configs(con)
                targets = sorted(p for p in paths.SESSIONS_DIR.iterdir() if p.is_dir())
                for i, d in enumerate(targets, 1):
                    try:
                        n = load_to_db.load_session(con, d)
                        self.log.emit(f"[{i}/{len(targets)}] {d.name}: {n:,} samples")
                    except Exception as e:
                        self.log.emit(f"[{i}/{len(targets)}] {d.name}: FAILED ({e})")
                con.close()
            self.finished.emit()
        except Exception as e:
            tb = traceback.format_exc()
            self.failed.emit(f"{type(e).__name__}: {e}\n\n{tb}")


def run_in_thread(worker: QObject) -> QThread:
    """
    Move `worker` onto a new QThread, start it, and return the thread.
    Caller is responsible for connecting `worker.finished` / `worker.failed`
    to a slot that calls `thread.quit()` if you want clean shutdown.
    """
    thread = QThread()
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    # Tie worker lifecycle to the thread so it doesn't get garbage collected
    worker.setParent(None)
    thread._worker = worker  # type: ignore[attr-defined]  # keep a reference alive
    thread.start()
    return thread
