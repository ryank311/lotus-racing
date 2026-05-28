"""Home page — account, sync status, summary stats, sync button."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .. import state


class StatCard(QFrame):
    """A boxed label+value pair, used as a tile on the home grid."""

    def __init__(self, title: str, value: str = "—"):
        super().__init__()
        self.setFrameShape(QFrame.StyledPanel)
        self.setFrameShadow(QFrame.Sunken)
        self.setMinimumWidth(180)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 12)

        self._title = QLabel(title)
        self._title.setStyleSheet("color: #999; font-size: 11px; text-transform: uppercase;")
        self._value = QLabel(value)
        f = QFont()
        f.setPointSize(20)
        f.setBold(True)
        self._value.setFont(f)
        self._value.setStyleSheet("color: #fff;")

        layout.addWidget(self._title)
        layout.addWidget(self._value)

    def set_value(self, v: str) -> None:
        self._value.setText(v)


class HomePage(QWidget):
    """
    Landing page. Shows the logged-in email, sync status, summary tiles,
    and the sync-now button.

    Signals:
        sync_requested  — user clicked "Sync now"
        load_db_requested — user clicked "Reload DB"
    """

    sync_requested = Signal()
    load_db_requested = Signal()

    def __init__(self):
        super().__init__()
        self._build()
        self.refresh()

    def _build(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(28, 24, 28, 24)
        root.setSpacing(20)

        # Header — account + sync status
        header = QHBoxLayout()
        self._account_label = QLabel("Account: …")
        self._account_label.setStyleSheet("font-size: 14px;")
        self._status_label = QLabel("Status: …")
        self._status_label.setStyleSheet("font-size: 14px; color: #aaa;")
        header.addWidget(self._account_label)
        header.addStretch()
        header.addWidget(self._status_label)
        root.addLayout(header)

        # Tile row
        tiles = QHBoxLayout()
        tiles.setSpacing(12)
        self._tile_sessions = StatCard("Sessions on disk")
        self._tile_size = StatCard("Total data")
        self._tile_token = StatCard("Token expires in")
        self._tile_last_sync = StatCard("Last sync")
        for t in (self._tile_sessions, self._tile_size, self._tile_token, self._tile_last_sync):
            tiles.addWidget(t)
        root.addLayout(tiles)

        # Action row
        actions = QHBoxLayout()
        self._sync_btn = QPushButton("Sync sessions from Garmin")
        self._sync_btn.setMinimumHeight(36)
        self._sync_btn.clicked.connect(self.sync_requested.emit)
        self._load_db_btn = QPushButton("Reload local database")
        self._load_db_btn.setMinimumHeight(36)
        self._load_db_btn.clicked.connect(self.load_db_requested.emit)
        actions.addWidget(self._sync_btn)
        actions.addWidget(self._load_db_btn)
        actions.addStretch()
        root.addLayout(actions)

        # Status / log line below the actions
        self._log_line = QLabel("")
        self._log_line.setStyleSheet("color: #888; font-family: monospace;")
        self._log_line.setMinimumHeight(20)
        root.addWidget(self._log_line)

        root.addStretch()

    # ── public API ──────────────────────────────────────────────────────

    def refresh(self) -> None:
        """Re-read on-disk state and update the labels."""
        auth = state.read_auth_state()
        stats = state.read_sync_stats()
        email = state.read_account_email() or "(not configured)"

        self._account_label.setText(f"Account: {email}")

        if auth.token_valid:
            self._status_label.setText("Status: ✓ logged in")
            self._status_label.setStyleSheet("font-size: 14px; color: #6c6;")
        elif auth.has_garth_tokens:
            self._status_label.setText("Status: token expired — sync to refresh")
            self._status_label.setStyleSheet("font-size: 14px; color: #c96;")
        else:
            self._status_label.setText("Status: not logged in")
            self._status_label.setStyleSheet("font-size: 14px; color: #c66;")

        self._tile_sessions.set_value(str(stats.session_count))
        self._tile_size.set_value(state.humanise_bytes(stats.total_size_bytes))
        self._tile_token.set_value(
            f"{auth.token_days_remaining} days" if auth.token_valid else "—"
        )
        self._tile_last_sync.set_value(stats.last_sync_ago_human)

    def set_log_line(self, line: str) -> None:
        self._log_line.setText(line[:200])

    def set_busy(self, busy: bool) -> None:
        """Disable action buttons while a worker is running."""
        self._sync_btn.setEnabled(not busy)
        self._load_db_btn.setEnabled(not busy)
        self._sync_btn.setText("Syncing…" if busy else "Sync sessions from Garmin")
