"""
Main window — left-rail navigation + stacked pages.

Structure:
    [ Home ]      ← summary tiles, sync button, status
    [ Sessions ]  ← table of sessions from the DuckDB
    [ Cars ]      ← markdown viewer/editor (lotus/)

Background sync and DB-load run on QThread workers; their log lines feed a
status bar at the bottom of the window.
"""
from __future__ import annotations

from PySide6.QtCore import Qt, QThread
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from . import paths, state, workers
from .pages.brief import BriefDialog
from .pages.briefs import BriefsPage
from .pages.cars import CarsPage
from .pages.home import HomePage
from .pages.login import LoginDialog
from .pages.sessions import SessionsPage


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Catalyst Coach")
        self.resize(1180, 760)

        self._thread: QThread | None = None
        self._worker = None  # keep ref alive

        self._build()

    # ── UI build ───────────────────────────────────────────────────────

    def _build(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        layout = QHBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Left nav rail
        nav = QListWidget()
        nav.setFixedWidth(180)
        nav.setStyleSheet(
            "QListWidget { background: #1e1e22; border: none; padding: 16px 0; }"
            "QListWidget::item { padding: 10px 18px; font-size: 14px; color: #ddd; }"
            "QListWidget::item:selected { background: #3b6ea5; color: white; }"
        )
        for label in ("Home", "Sessions", "Briefs", "Garage"):
            item = QListWidgetItem(label)
            nav.addItem(item)
        nav.currentRowChanged.connect(self._on_nav)
        layout.addWidget(nav)
        self._nav = nav

        # Right stacked area
        self._stack = QStackedWidget()
        layout.addWidget(self._stack, 1)

        self._home = HomePage()
        self._sessions = SessionsPage()
        self._briefs = BriefsPage()
        self._cars = CarsPage()
        self._stack.addWidget(self._home)
        self._stack.addWidget(self._sessions)
        self._stack.addWidget(self._briefs)
        self._stack.addWidget(self._cars)

        self._home.sync_requested.connect(self.start_sync)
        self._home.load_db_requested.connect(self.start_load_db)
        self._home.brief_requested.connect(self.show_brief_dialog)
        self._briefs.new_brief_requested.connect(self.show_brief_dialog)

        nav.setCurrentRow(0)

        # Menu (Import/Export, etc.)
        self._build_menu()

        # Status bar
        sb = QStatusBar()
        self.setStatusBar(sb)
        sb.showMessage("Ready")

    def _build_menu(self) -> None:
        m_file = self.menuBar().addMenu("&File")

        act_export = QAction("Export data…", self)
        act_export.setShortcut(QKeySequence.Save)
        act_export.triggered.connect(self.export_data)
        m_file.addAction(act_export)

        act_open_data = QAction("Open data folder", self)
        act_open_data.triggered.connect(self.open_data_folder)
        m_file.addAction(act_open_data)

        m_file.addSeparator()
        act_quit = QAction("Quit", self)
        act_quit.setShortcut(QKeySequence.Quit)
        act_quit.triggered.connect(self.close)
        m_file.addAction(act_quit)

        m_account = self.menuBar().addMenu("&Account")
        act_login = QAction("Sign in…", self)
        act_login.triggered.connect(self.show_login)
        m_account.addAction(act_login)

        act_clear = QAction("Clear cached token", self)
        act_clear.triggered.connect(self.clear_tokens)
        m_account.addAction(act_clear)

    # ── navigation ─────────────────────────────────────────────────────

    def _on_nav(self, idx: int) -> None:
        self._stack.setCurrentIndex(idx)
        # Refresh pages lazily so they reflect the latest on-disk state
        if idx == 0:
            self._home.refresh()
        elif idx == 1:
            self._sessions.refresh()
        elif idx == 2:
            self._briefs.refresh()

    # ── workers ────────────────────────────────────────────────────────

    def start_sync(self) -> None:
        if self._thread is not None:
            return  # already running

        # Prompt for login if no credentials in config and no valid token
        email = state.read_account_email()
        password = None
        auth = state.read_auth_state()
        if not auth.token_valid and not email:
            ok = self.show_login()
            if not ok:
                return
            email = self._login_email
            password = self._login_password
        elif not auth.token_valid:
            # We have email but token's gone — still need password for first SSO
            r = QMessageBox.question(
                self,
                "Sign in needed",
                "The cached Garmin token is expired. Sign in again to refresh "
                "(your password isn't stored).",
                QMessageBox.Ok | QMessageBox.Cancel,
            )
            if r != QMessageBox.Ok:
                return
            ok = self.show_login()
            if not ok:
                return
            email = self._login_email
            password = self._login_password

        self._home.set_busy(True)
        self.statusBar().showMessage("Syncing from Garmin Catalyst…")

        worker = workers.SyncWorker(email=email, password=password)
        worker.log.connect(self._on_worker_log)
        worker.failed.connect(self._on_sync_failed)
        worker.finished.connect(self._on_sync_finished)
        self._worker = worker
        self._thread = workers.run_in_thread(worker)

    def start_load_db(self) -> None:
        if self._thread is not None:
            return
        self._home.set_busy(True)
        self.statusBar().showMessage("Loading database…")

        worker = workers.DbLoadWorker()
        worker.log.connect(self._on_worker_log)
        worker.failed.connect(self._on_load_failed)
        worker.finished.connect(self._on_load_finished)
        self._worker = worker
        self._thread = workers.run_in_thread(worker)

    def _on_worker_log(self, line: str) -> None:
        self._home.set_log_line(line)
        self.statusBar().showMessage(line[:200])

    def _on_sync_finished(self, _n: int) -> None:
        self._teardown_thread()
        self._home.refresh()
        self.statusBar().showMessage("Sync complete. Reload DB to update the Sessions view.", 5000)
        # Auto-trigger DB reload after sync
        self.start_load_db()

    def _on_sync_failed(self, msg: str) -> None:
        self._teardown_thread()
        QMessageBox.critical(self, "Sync failed", msg)

    def _on_load_finished(self) -> None:
        self._teardown_thread()
        self._home.refresh()
        self._sessions.refresh()
        self.statusBar().showMessage("Database reloaded", 5000)

    def _on_load_failed(self, msg: str) -> None:
        self._teardown_thread()
        QMessageBox.critical(self, "Database load failed", msg)

    def _teardown_thread(self) -> None:
        self._home.set_busy(False)
        if self._thread is not None:
            self._thread.quit()
            self._thread.wait(2000)
        self._thread = None
        self._worker = None

    # ── account actions ────────────────────────────────────────────────

    def show_login(self) -> bool:
        dlg = LoginDialog(self)
        if dlg.exec() != LoginDialog.Accepted:
            return False
        self._login_email = dlg.email
        self._login_password = dlg.password
        return True

    def clear_tokens(self) -> None:
        if QMessageBox.question(
            self, "Clear tokens",
            "Delete the cached Garmin tokens? Next sync will require sign-in.",
        ) != QMessageBox.Yes:
            return
        import shutil
        if paths.GARTH_TOKEN_DIR.exists():
            shutil.rmtree(paths.GARTH_TOKEN_DIR)
        if paths.CATALYST_TOKEN_CACHE.exists():
            paths.CATALYST_TOKEN_CACHE.unlink()
        self._home.refresh()
        QMessageBox.information(self, "Tokens cleared", "All cached tokens removed.")

    # ── data actions ───────────────────────────────────────────────────

    def export_data(self) -> None:
        """Export all session JSONs + DB as a zip archive."""
        path, _ = QFileDialog.getSaveFileName(
            self, "Export data", "catalyst-export.zip", "Zip Archive (*.zip)"
        )
        if not path:
            return
        try:
            import zipfile
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
                for sub in ("sessions", "mean_lines"):
                    d = paths.DATA_DIR / sub
                    if not d.exists():
                        continue
                    for f in d.rglob("*"):
                        if f.is_file():
                            zf.write(f, f.relative_to(paths.DATA_DIR))
                for filename in ("sessions_index.json", "track_facilities.json",
                                 "track_configurations.json", "catalyst.duckdb"):
                    f = paths.DATA_DIR / filename
                    if f.exists():
                        zf.write(f, filename)
            QMessageBox.information(self, "Export complete", f"Wrote {path}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def show_brief_dialog(self) -> None:
        dlg = BriefDialog(self)
        if dlg.exec() == BriefDialog.Accepted and dlg.output_path:
            # Switch to the Briefs page and show the freshly-generated file.
            self._nav.setCurrentRow(2)  # index of "Briefs" in the nav
            self._briefs.select_file(dlg.output_path)

    def open_data_folder(self) -> None:
        import subprocess, sys as _sys
        if _sys.platform == "darwin":
            subprocess.run(["open", str(paths.DATA_DIR)])
        elif _sys.platform == "win32":
            subprocess.run(["explorer", str(paths.DATA_DIR)])
        else:
            subprocess.run(["xdg-open", str(paths.DATA_DIR)])
