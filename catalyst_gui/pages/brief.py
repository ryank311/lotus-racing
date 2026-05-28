"""
Brief-generation dialog — pick sessions + scope, then write the brief.

Generation is synchronous (DuckDB-only, ~1 second). On success the dialog
accepts with `output_path` set so the caller can show the file inline.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QRadioButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

from .. import paths


def _ms_to_lap(ms: int | None) -> str:
    if not ms:
        return "—"
    s = ms / 1000.0
    m = int(s // 60)
    return f"{m}:{s - m*60:06.3f}"


class BriefDialog(QDialog):
    """
    Picks: which sessions (last N | selected | all) + scope, then runs
    `garmin.prompt_pack.main()` in-process and offers to open the result.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Generate coaching brief")
        self.resize(820, 560)
        self.output_path: Path | None = None
        self._build()
        self._load_sessions()

    def _build(self) -> None:
        layout = QVBoxLayout(self)

        # Selection mode
        mode_row = QHBoxLayout()
        self._mode_last = QRadioButton("Last N sessions")
        self._mode_selected = QRadioButton("Selected sessions only")
        self._mode_all = QRadioButton("All sessions")
        self._mode_last.setChecked(True)
        for r in (self._mode_last, self._mode_selected, self._mode_all):
            r.toggled.connect(self._update_enabled)
            mode_row.addWidget(r)
        mode_row.addStretch()
        layout.addLayout(mode_row)

        # Knobs
        form = QFormLayout()
        self._last_n = QComboBox()
        for n in (3, 5, 10, 20, 50):
            self._last_n.addItem(str(n))
        self._last_n.setCurrentText("5")

        self._scope = QComboBox()
        self._scope.addItems(["overview", "compare", "corner"])

        form.addRow("Last N:", self._last_n)
        form.addRow("Scope:", self._scope)
        layout.addLayout(form)

        # Session table (for "Selected" mode)
        self._table = QTableWidget()
        cols = ["Date", "Config", "Best Lap", "Laps", "Session GUID"]
        self._table.setColumnCount(len(cols))
        self._table.setHorizontalHeaderLabels(cols)
        self._table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.MultiSelection)
        self._table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self._table.verticalHeader().setVisible(False)
        for i, w in enumerate([170, 140, 90, 60, 290]):
            self._table.setColumnWidth(i, w)
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        layout.addWidget(self._table, 1)

        # Status line
        self._status = QLabel("")
        self._status.setStyleSheet("color: #888;")
        layout.addWidget(self._status)

        # Buttons
        btns = QDialogButtonBox(QDialogButtonBox.Cancel)
        self._generate_btn = btns.addButton("Generate", QDialogButtonBox.AcceptRole)
        btns.rejected.connect(self.reject)
        self._generate_btn.clicked.connect(self._run)
        layout.addWidget(btns)

        self._update_enabled()

    def _load_sessions(self) -> None:
        if not paths.DB_PATH.exists():
            self._status.setText("⚠ no database — run 'Reload database' first")
            self._generate_btn.setEnabled(False)
            return
        try:
            import duckdb
            con = duckdb.connect(str(paths.DB_PATH), read_only=True)
            try:
                rows = con.execute("""
                    SELECT
                      CAST(s.session_start AS VARCHAR),
                      tc.track_configuration_name,
                      s.best_lap_ms,
                      (SELECT COUNT(*) FROM laps l WHERE l.session_guid = s.session_guid),
                      s.session_guid
                    FROM sessions s
                    LEFT JOIN track_configs tc
                      ON tc.track_configuration_id = s.track_configuration_id
                    ORDER BY s.session_start DESC NULLS LAST
                """).fetchall()
            finally:
                con.close()
        except Exception as e:
            self._status.setText(f"DB read failed: {e}")
            return

        self._table.setRowCount(len(rows))
        for r, row in enumerate(rows):
            dt, cfg, best_ms, n_laps, guid = row
            cells = [str(dt or ""), str(cfg or ""), _ms_to_lap(best_ms),
                     str(n_laps or 0), str(guid)]
            for c, text in enumerate(cells):
                item = QTableWidgetItem(text)
                self._table.setItem(r, c, item)
        self._status.setText(f"{len(rows)} sessions available")

    def _update_enabled(self) -> None:
        self._last_n.setEnabled(self._mode_last.isChecked())
        self._table.setEnabled(self._mode_selected.isChecked())

    def _run(self) -> None:
        # Build argv for prompt_pack.main()
        from garmin import prompt_pack
        argv: list[str] = ["--scope", self._scope.currentText()]

        if self._mode_last.isChecked():
            argv.extend(["--last", self._last_n.currentText()])
        elif self._mode_all.isChecked():
            argv.append("--all")
        else:
            sels = self._table.selectionModel().selectedRows()
            if not sels:
                QMessageBox.warning(self, "No sessions selected",
                                    "Pick one or more rows or switch mode.")
                return
            for idx in sels:
                guid = self._table.item(idx.row(), 4).text()
                argv.extend(["--session", guid])

        out_path = paths.REPO_ROOT / "coaching" / (
            f"{date.today().isoformat()}-{self._scope.currentText()}-brief.md"
        )
        argv.extend(["--output", str(out_path)])

        try:
            rc = prompt_pack.main(argv)
        except SystemExit as e:
            rc = e.code
        except Exception as e:
            QMessageBox.critical(self, "Generation failed", f"{type(e).__name__}: {e}")
            return

        if rc != 0:
            QMessageBox.critical(self, "Generation failed",
                                 "prompt_pack returned non-zero. See the terminal log.")
            return

        self.output_path = out_path
        self.accept()
