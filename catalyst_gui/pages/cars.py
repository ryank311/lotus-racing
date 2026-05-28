"""
Cars page — markdown viewer/editor for files in the `lotus/` directory.

This is the user's source of car-setup truth: Lotus.md, plus guide files
(VIR-Full-Course-Guide.md, etc.). The same files will later feed an LLM coach.
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
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

from .. import paths


class CarsPage(QWidget):
    def __init__(self):
        super().__init__()
        self._current: Path | None = None
        self._dirty = False
        self._build()
        self.refresh()

    def _build(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 16, 20, 16)

        # Header
        header = QHBoxLayout()
        self._heading = QLabel("Garage")
        self._heading.setStyleSheet("font-size: 18px; font-weight: bold;")
        self._save_btn = QPushButton("Save")
        self._save_btn.clicked.connect(self._save)
        self._save_btn.setEnabled(False)
        self._reload_btn = QPushButton("Reload")
        self._reload_btn.clicked.connect(self.refresh)
        header.addWidget(self._heading)
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
        self._editor.setAcceptRichText(False)  # markdown is plain text
        self._editor.setStyleSheet("font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px;")
        self._editor.textChanged.connect(self._on_changed)
        splitter.addWidget(self._editor)

        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter)

        self._status = QLabel("")
        self._status.setStyleSheet("color: #888; font-size: 12px;")
        root.addWidget(self._status)

    def refresh(self) -> None:
        if not paths.LOTUS_DIR.exists():
            self._status.setText(f"No directory at {paths.LOTUS_DIR} — create it and add .md files.")
            self._list.clear()
            self._editor.setPlainText("")
            return

        if self._dirty:
            if QMessageBox.question(
                self, "Unsaved changes",
                "Discard unsaved edits?",
            ) != QMessageBox.Yes:
                return

        self._list.clear()
        files = sorted(paths.LOTUS_DIR.glob("*.md"))
        # Show Lotus.md first if present
        files.sort(key=lambda p: (0 if p.name.lower() == "lotus.md" else 1, p.name))
        for f in files:
            item = QListWidgetItem(f.name)
            item.setData(Qt.UserRole, str(f))
            self._list.addItem(item)

        if files:
            self._list.setCurrentRow(0)
        else:
            self._editor.setPlainText("")
            self._status.setText("No .md files in lotus/")

    def _on_select(self) -> None:
        if self._dirty:
            r = QMessageBox.question(
                self, "Unsaved changes",
                "Discard unsaved edits?",
            )
            if r != QMessageBox.Yes:
                # Revert selection silently — but we don't track previous index,
                # so just block the load by returning early.
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
