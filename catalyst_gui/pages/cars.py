"""
Garage page — markdown viewer/editor for the active car profile.

Each profile is a directory at the repo root (e.g. `Lotus/`, `Vette/`)
containing a `Car.md` plus any number of setup / guide files. A dropdown
at the top selects the active profile; selection persists via QSettings.
The same active profile is read by the prompt-pack generator so coaching
briefs reference the correct car.
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .. import profiles


class CarsPage(QWidget):
    def __init__(self):
        super().__init__()
        self._current: Path | None = None
        self._dirty = False
        self._build()
        self.refresh_profiles()

    # ── UI ──────────────────────────────────────────────────────────────

    def _build(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 16, 20, 16)

        # Header
        header = QHBoxLayout()
        heading = QLabel("Garage")
        heading.setStyleSheet("font-size: 18px; font-weight: bold;")

        self._profile_picker = QComboBox()
        self._profile_picker.setMinimumWidth(140)
        self._profile_picker.currentIndexChanged.connect(self._on_profile_changed)

        self._save_btn = QPushButton("Save")
        self._save_btn.clicked.connect(self._save)
        self._save_btn.setEnabled(False)

        self._reload_btn = QPushButton("Reload")
        self._reload_btn.clicked.connect(self.refresh)

        header.addWidget(heading)
        header.addSpacing(20)
        header.addWidget(QLabel("Profile:"))
        header.addWidget(self._profile_picker)
        header.addStretch()
        header.addWidget(self._reload_btn)
        header.addWidget(self._save_btn)
        root.addLayout(header)

        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(6)

        self._list = QListWidget()
        self._list.setMaximumWidth(280)
        self._list.itemSelectionChanged.connect(self._on_select)
        splitter.addWidget(self._list)

        self._editor = QTextEdit()
        self._editor.setAcceptRichText(False)
        self._editor.setStyleSheet(
            "font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px;"
        )
        self._editor.textChanged.connect(self._on_changed)
        splitter.addWidget(self._editor)

        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter)

        self._status = QLabel("")
        self._status.setStyleSheet("color: #888; font-size: 12px;")
        root.addWidget(self._status)

    # ── profile selection ───────────────────────────────────────────────

    def refresh_profiles(self) -> None:
        """Re-scan the repo for profile directories; preserve the active one if possible."""
        profiles_list = profiles.discover_profiles()
        active_name = profiles.get_active_profile_name()

        self._profile_picker.blockSignals(True)
        self._profile_picker.clear()
        for p in profiles_list:
            self._profile_picker.addItem(p.name, p)
        # Restore previous selection
        for i in range(self._profile_picker.count()):
            if self._profile_picker.itemText(i) == active_name:
                self._profile_picker.setCurrentIndex(i)
                break
        self._profile_picker.blockSignals(False)

        if not profiles_list:
            self._status.setText(
                "No profiles found. Add a folder with a `Car.md` next to "
                "`Lotus/` and `Vette/`."
            )
            self._list.clear()
            self._editor.setPlainText("")
            return

        self.refresh()

    def _on_profile_changed(self, _idx: int) -> None:
        if not self._maybe_abort_for_dirty():
            return
        p = self._profile_picker.currentData()
        if isinstance(p, profiles.Profile):
            profiles.set_active_profile_name(p.name)
        self.refresh()

    # ── file list / editor ─────────────────────────────────────────────

    def refresh(self) -> None:
        p = self._profile_picker.currentData()
        if not isinstance(p, profiles.Profile):
            return

        self._list.clear()
        files = sorted(p.dir.glob("*.md"))
        # Car.md always first
        files.sort(key=lambda fp: (0 if fp.name.lower() == "car.md" else 1, fp.name))
        for f in files:
            item = QListWidgetItem(f.name)
            item.setData(Qt.UserRole, str(f))
            self._list.addItem(item)

        if files:
            self._list.setCurrentRow(0)
        else:
            self._editor.setPlainText("")
            self._status.setText(f"No .md files in {p.dir.name}/")

    def _on_select(self) -> None:
        if not self._maybe_abort_for_dirty():
            return
        item = self._list.currentItem()
        if not item:
            return
        path = Path(item.data(Qt.UserRole))
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as e:
            self._status.setText(f"Read failed: {e}")
            return
        self._current = path
        self._editor.blockSignals(True)
        self._editor.setPlainText(text)
        self._editor.blockSignals(False)
        self._dirty = False
        self._save_btn.setEnabled(False)
        self._status.setText(f"{path.name}  ({len(text):,} chars)")

    def _on_changed(self) -> None:
        self._dirty = True
        self._save_btn.setEnabled(True)
        if self._current:
            self._status.setText(f"{self._current.name}  • unsaved changes")

    def _save(self) -> None:
        if not self._current:
            return
        try:
            self._current.write_text(self._editor.toPlainText(), encoding="utf-8")
        except Exception as e:
            QMessageBox.critical(self, "Save failed", str(e))
            return
        self._dirty = False
        self._save_btn.setEnabled(False)
        self._status.setText(f"{self._current.name}  • saved")

    # ── helpers ─────────────────────────────────────────────────────────

    def _maybe_abort_for_dirty(self) -> bool:
        """If there are unsaved edits, ask before discarding. Returns False to abort."""
        if not self._dirty:
            return True
        return QMessageBox.question(
            self, "Unsaved changes", "Discard unsaved edits?",
        ) == QMessageBox.Yes
