"""
Briefs page — list and view markdown documents in coaching/.

Shows generated coaching briefs and any AI-written analyses the user pastes
back in. View is read-only (briefs are regenerated, not hand-edited); a "Copy
to clipboard" button makes it easy to paste the whole brief into an LLM.
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QGuiApplication, QTextCursor
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .. import paths


class BriefsPage(QWidget):
    """Read-only markdown browser for `coaching/`.

    Public:
        refresh()                  — re-scan the folder
        select_file(path: Path)    — show a specific file
    """

    new_brief_requested = Signal()

    def __init__(self):
        super().__init__()
        self._current: Path | None = None
        self._build()
        self.refresh()

    def _build(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 16, 20, 16)
        root.setSpacing(8)

        # Header
        header = QHBoxLayout()
        heading = QLabel("Briefs & coaching analyses")
        heading.setStyleSheet("font-size: 18px; font-weight: bold;")
        self._new_btn = QPushButton("Generate new brief…")
        self._new_btn.clicked.connect(self.new_brief_requested.emit)
        self._copy_btn = QPushButton("Copy to clipboard")
        self._copy_btn.clicked.connect(self._copy_to_clipboard)
        self._copy_btn.setEnabled(False)
        self._reveal_btn = QPushButton("Show in finder")
        self._reveal_btn.clicked.connect(self._reveal)
        self._reveal_btn.setEnabled(False)
        header.addWidget(heading)
        header.addStretch()
        header.addWidget(self._new_btn)
        header.addWidget(self._copy_btn)
        header.addWidget(self._reveal_btn)
        root.addLayout(header)

        # Splitter — file list on the left, content on the right
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(6)

        self._list = QListWidget()
        self._list.setMaximumWidth(320)
        self._list.itemSelectionChanged.connect(self._on_select)
        splitter.addWidget(self._list)

        # Content view — plain monospace, read-only. Briefs are markdown
        # source, not rendered HTML — the LLM consumes the source, and the
        # user copies the source.
        self._view = QPlainTextEdit()
        self._view.setReadOnly(True)
        self._view.setLineWrapMode(QPlainTextEdit.WidgetWidth)
        self._view.setStyleSheet(
            "font-family: ui-monospace, Menlo, Consolas, monospace; "
            "font-size: 12px;"
        )
        splitter.addWidget(self._view)

        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter, 1)

        self._status = QLabel("")
        self._status.setStyleSheet("color: #888; font-size: 12px;")
        root.addWidget(self._status)

    # ── public API ─────────────────────────────────────────────────────

    def refresh(self) -> None:
        """Re-scan coaching/ and update the file list. Preserves selection if possible."""
        coaching = paths.REPO_ROOT / "coaching"
        prev = self._current

        self._list.blockSignals(True)
        self._list.clear()

        if not coaching.exists():
            self._status.setText(f"No coaching folder at {coaching}.")
            self._list.blockSignals(False)
            self._view.setPlainText("")
            return

        # Briefs first (latest at top), then any other .md files (likely
        # AI-written analyses or the README).
        files = sorted(coaching.glob("*.md"), reverse=True)
        # Float README to the bottom
        files.sort(key=lambda p: (p.name.lower() == "readme.md", -p.stat().st_mtime))

        for f in files:
            item = QListWidgetItem(f.name)
            item.setData(Qt.UserRole, str(f))
            size_kb = f.stat().st_size / 1024
            item.setToolTip(f"{f.name}\n{size_kb:.1f} KB")
            self._list.addItem(item)
        self._list.blockSignals(False)

        # Restore prior selection if still present, otherwise pick the first
        target_row = 0
        if prev:
            for i in range(self._list.count()):
                if self._list.item(i).data(Qt.UserRole) == str(prev):
                    target_row = i
                    break
        if self._list.count():
            self._list.setCurrentRow(target_row)
        else:
            self._view.setPlainText("")
            self._status.setText("No briefs yet. Click 'Generate new brief…'.")

    def select_file(self, path: Path) -> None:
        """Programmatically select and show a specific file."""
        self.refresh()
        for i in range(self._list.count()):
            if self._list.item(i).data(Qt.UserRole) == str(path):
                self._list.setCurrentRow(i)
                return

    # ── handlers ───────────────────────────────────────────────────────

    def _on_select(self) -> None:
        item = self._list.currentItem()
        if not item:
            self._current = None
            self._view.setPlainText("")
            self._copy_btn.setEnabled(False)
            self._reveal_btn.setEnabled(False)
            return
        path = Path(item.data(Qt.UserRole))
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as e:
            self._status.setText(f"Read failed: {e}")
            self._view.setPlainText("")
            self._copy_btn.setEnabled(False)
            return

        self._current = path
        self._view.setPlainText(text)
        self._view.moveCursor(QTextCursor.Start)
        self._copy_btn.setEnabled(True)
        self._reveal_btn.setEnabled(True)
        kb = path.stat().st_size / 1024
        self._status.setText(f"{path.name}  ·  {len(text):,} chars  ·  {kb:.1f} KB")

    def _copy_to_clipboard(self) -> None:
        if not self._current:
            return
        clip = QGuiApplication.clipboard()
        clip.setText(self._view.toPlainText())
        self._status.setText(
            f"{self._current.name}  ·  copied to clipboard — paste into your LLM"
        )

    def _reveal(self) -> None:
        if not self._current:
            return
        import subprocess, sys as _sys
        if _sys.platform == "darwin":
            subprocess.run(["open", "-R", str(self._current)])
        elif _sys.platform == "win32":
            subprocess.run(["explorer", "/select,", str(self._current)])
        else:
            subprocess.run(["xdg-open", str(self._current.parent)])
