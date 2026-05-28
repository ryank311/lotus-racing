"""Sessions page — table of all downloaded sessions from the DuckDB."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .. import paths


def _ms_to_laptime(ms: int | None) -> str:
    if not ms:
        return "—"
    s = ms / 1000.0
    m = int(s // 60)
    return f"{m}:{s - m*60:06.3f}"


class SessionsPage(QWidget):
    """
    Read-only table of sessions. Loads from DuckDB. Falls back to summary.json
    files if the DB isn't built yet.
    """

    COLUMNS = [
        ("Date", 170),
        ("Track", 200),
        ("Config", 140),
        ("Best Lap", 90),
        ("Laps", 60),
        ("Samples", 90),
        ("Weather", 130),
        ("Session GUID", 280),
    ]

    def __init__(self):
        super().__init__()
        self._build()
        self.refresh()

    def _build(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 16, 20, 16)
        root.setSpacing(10)

        header = QHBoxLayout()
        self._summary = QLabel("…")
        self._summary.setStyleSheet("font-size: 13px; color: #aaa;")
        refresh = QPushButton("Refresh")
        refresh.clicked.connect(self.refresh)
        header.addWidget(self._summary)
        header.addStretch()
        header.addWidget(refresh)
        root.addLayout(header)

        self._table = QTableWidget()
        self._table.setColumnCount(len(self.COLUMNS))
        self._table.setHorizontalHeaderLabels([c[0] for c in self.COLUMNS])
        self._table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self._table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self._table.setAlternatingRowColors(True)
        self._table.verticalHeader().setVisible(False)
        for i, (_, w) in enumerate(self.COLUMNS):
            self._table.setColumnWidth(i, w)
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        self._table.setSortingEnabled(True)
        root.addWidget(self._table)

    def refresh(self) -> None:
        rows = self._load_from_db() if paths.DB_PATH.exists() else self._load_from_disk()
        self._populate(rows)

    def _load_from_db(self) -> list[tuple]:
        try:
            import duckdb
            con = duckdb.connect(str(paths.DB_PATH), read_only=True)
            try:
                return con.execute("""
                    SELECT
                      CAST(s.session_start AS VARCHAR) AS dt,
                      COALESCE(tc.track_name, 'Unknown') AS track,
                      COALESCE(tc.track_configuration_name, '') AS cfg,
                      s.best_lap_ms,
                      (SELECT COUNT(*) FROM laps l WHERE l.session_guid = s.session_guid) AS lap_count,
                      (SELECT COUNT(*) FROM samples sm WHERE sm.session_guid = s.session_guid) AS sample_count,
                      COALESCE(s.weather_description, ''),
                      s.session_guid
                    FROM sessions s
                    LEFT JOIN track_configs tc
                      ON tc.track_configuration_id = s.track_configuration_id
                    ORDER BY s.session_start DESC NULLS LAST
                """).fetchall()
            finally:
                con.close()
        except Exception as e:
            self._summary.setText(f"DB read failed: {e}")
            return []

    def _load_from_disk(self) -> list[tuple]:
        import json
        rows = []
        if not paths.SESSIONS_DIR.exists():
            return rows
        for d in sorted(paths.SESSIONS_DIR.iterdir(), reverse=True):
            sp = d / "summary.json"
            if not sp.exists():
                continue
            try:
                s = json.loads(sp.read_text())
            except Exception:
                continue
            # Convert ISO duration to ms for sortability
            ms = _iso_to_ms(s.get("bestLap"))
            rows.append((
                s.get("sessionStart", ""),
                s.get("trackName", ""),
                s.get("trackConfigurationName", ""),
                ms,
                None, None,  # laps + samples unknown without DB
                "",
                s.get("sessionGuid", d.name),
            ))
        return rows

    def _populate(self, rows: list[tuple]) -> None:
        self._table.setSortingEnabled(False)
        self._table.setRowCount(len(rows))
        for r, row in enumerate(rows):
            dt, track, cfg, best_ms, laps, samples, weather, guid = row
            cells = [
                str(dt or ""),
                str(track),
                str(cfg),
                _ms_to_laptime(best_ms),
                str(laps) if laps is not None else "—",
                f"{samples:,}" if samples else "—",
                str(weather),
                str(guid),
            ]
            for c, text in enumerate(cells):
                item = QTableWidgetItem(text)
                # Sortable lap time uses the ms value as user role data
                if c == 3 and best_ms:
                    item.setData(Qt.UserRole, best_ms)
                self._table.setItem(r, c, item)
        self._table.setSortingEnabled(True)
        self._summary.setText(
            f"{len(rows)} sessions" +
            (" (from DuckDB)" if paths.DB_PATH.exists() else " (from disk — load DB for full data)")
        )


def _iso_to_ms(s: str | None) -> int | None:
    """Same parser as load_to_db.iso_duration_to_ms (kept inline so this page
    can be used before the DB is loaded)."""
    if not s or not isinstance(s, str) or not s.startswith("PT"):
        return None
    total = 0.0
    num = ""
    for c in s[2:]:
        if c.isdigit() or c == ".":
            num += c
        elif c == "M":
            total += float(num) * 60; num = ""
        elif c == "S":
            total += float(num); num = ""
        elif c == "H":
            total += float(num) * 3600; num = ""
    return int(round(total * 1000))
