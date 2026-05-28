#!/usr/bin/env python3
"""
Load all downloaded Catalyst session data into a DuckDB database.

Reads from data/sessions/<guid>/{summary,metadata,weather}.json and the decoded
performance.pb protobuf, populates these tables:

    track_configs(track_cartography_id, track_name, track_configuration_id,
                  track_configuration_name, reverse, direction)
    sessions(session_guid PRIMARY KEY, session_start, best_lap_ms, best_lap_normal_ms,
             track_configuration_id, mean_line_guid, garmin_guid, unit_id,
             weather_description, temperature_c, humidity_pct,
             wind_speed_mps, wind_direction_deg)
    laps(session_guid, lap_index, lap_number_raw, duration_ms, sample_count,
         PRIMARY KEY (session_guid, lap_index))
    samples(session_guid, lap_index, dist_idx, lat, lon, f4..f15)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb

try:
    from .decode_performance import decode_performance
except ImportError:
    from decode_performance import decode_performance


SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"
SESSIONS_DIR = DATA_DIR / "sessions"
DEFAULT_DB = DATA_DIR / "catalyst.duckdb"


def iso_duration_to_ms(s: str | None) -> int | None:
    """Parse ISO-8601 duration like 'PT1M45.629S' → milliseconds."""
    if not s or not isinstance(s, str) or not s.startswith("PT"):
        return None
    total = 0.0
    num = ""
    for c in s[2:]:
        if c.isdigit() or c == ".":
            num += c
        elif c == "M":
            total += float(num) * 60
            num = ""
        elif c == "S":
            total += float(num)
            num = ""
        elif c == "H":
            total += float(num) * 3600
            num = ""
    return int(round(total * 1000))


def init_schema(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
    CREATE TABLE IF NOT EXISTS track_configs (
        track_cartography_id INTEGER,
        track_name VARCHAR,
        track_configuration_id INTEGER PRIMARY KEY,
        track_configuration_name VARCHAR,
        reverse BOOLEAN,
        direction VARCHAR,
        session_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
        session_guid VARCHAR PRIMARY KEY,
        session_start TIMESTAMP,
        best_lap_ms INTEGER,
        best_lap_normal_ms INTEGER,
        track_cartography_id INTEGER,
        track_configuration_id INTEGER,
        mean_line_guid VARCHAR,
        garmin_guid VARCHAR,
        unit_id BIGINT,
        product_part_number VARCHAR,
        weather_description VARCHAR,
        temperature_c DOUBLE,
        humidity_pct DOUBLE,
        wind_speed_mps DOUBLE,
        wind_direction_deg DOUBLE
    );

    CREATE TABLE IF NOT EXISTS laps (
        session_guid VARCHAR,
        lap_index INTEGER,
        lap_number_raw INTEGER,
        duration_ms INTEGER,
        sample_count INTEGER,
        lap_f3 INTEGER,
        lap_f4 INTEGER,
        lap_f5 INTEGER,
        lap_f6 DOUBLE,
        lap_f7 DOUBLE,
        lap_f8 DOUBLE,
        lap_f9 DOUBLE,
        lap_f10 DOUBLE,
        PRIMARY KEY (session_guid, lap_index)
    );

    CREATE TABLE IF NOT EXISTS samples (
        session_guid VARCHAR,
        lap_index INTEGER,
        dist_idx INTEGER,
        seq INTEGER,
        lat DOUBLE,
        lon DOUBLE,
        f4 DOUBLE,
        f5 DOUBLE,
        f6 DOUBLE,
        f7 DOUBLE,
        f8 DOUBLE,
        f9 DOUBLE,
        f10 DOUBLE,
        f11 DOUBLE,
        f12 DOUBLE,
        f13 DOUBLE,
        f14 DOUBLE,
        f15 DOUBLE
    );

    CREATE INDEX IF NOT EXISTS idx_samples_session_lap
        ON samples(session_guid, lap_index);
    """)


def load_track_configs(con: duckdb.DuckDBPyConnection) -> None:
    fac_path = DATA_DIR / "track_facilities.json"
    cfg_path = DATA_DIR / "track_configurations.json"
    if not (fac_path.exists() and cfg_path.exists()):
        print("[track_configs] No track_facilities.json / track_configurations.json — skipped")
        return

    configs_by_track = json.loads(cfg_path.read_text())
    rows = []
    for _track_id, configs in configs_by_track.items():
        for c in configs:
            rows.append((
                c.get("trackCartographyId"),
                c.get("trackName"),
                c.get("trackConfigurationId"),
                c.get("trackConfigurationName"),
                c.get("trackIsReverse", False),
                c.get("trackDirection"),
                c.get("sessionCount"),
            ))
    con.executemany(
        "INSERT OR REPLACE INTO track_configs VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    print(f"[track_configs] {len(rows)} rows")


def load_session(con: duckdb.DuckDBPyConnection, session_dir: Path) -> int:
    """
    Load one session directory's data. Returns the sample count written
    (useful for progress reporting).
    """
    sg = session_dir.name
    summary_p = session_dir / "summary.json"
    metadata_p = session_dir / "metadata.json"
    weather_p = session_dir / "weather.json"
    perf_p = session_dir / "performance.pb"

    if not summary_p.exists() or not perf_p.exists():
        return 0

    summary = json.loads(summary_p.read_text())
    metadata = json.loads(metadata_p.read_text()) if metadata_p.exists() else {}
    weather = json.loads(weather_p.read_text()) if weather_p.exists() else {}

    con.execute(
        "INSERT OR REPLACE INTO sessions VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            sg,
            summary.get("sessionStart"),
            iso_duration_to_ms(summary.get("bestLap")),
            iso_duration_to_ms(summary.get("bestLapNormal")),
            summary.get("trackCartographyId"),
            summary.get("trackConfigurationId"),
            summary.get("meanLineGuid"),
            metadata.get("garminGuid"),
            (metadata.get("productIdentifier") or {}).get("unitId"),
            (metadata.get("productIdentifier") or {}).get("productSku"),
            weather.get("description"),
            weather.get("temperature"),
            weather.get("relativeHumidity"),
            weather.get("windSpeed"),
            weather.get("windDirection"),
        ],
    )

    decoded = decode_performance(perf_p.read_bytes())
    lap_rows = []
    sample_rows = []
    for lap_idx, lap in enumerate(decoded.get("laps", [])):
        samples = lap.get("samples", [])
        lap_rows.append((
            sg, lap_idx,
            lap.get("lap_number"),
            lap.get("duration_ms"),
            len(samples),
            lap.get("f3"), lap.get("f4"), lap.get("f5"),
            lap.get("f6"), lap.get("f7"), lap.get("f8"), lap.get("f9"), lap.get("f10"),
        ))
        for s in samples:
            pos = s.get("position") or {}
            sample_rows.append((
                sg, lap_idx, int(s.get("t_s", 0)), s.get("seq"),
                pos.get("lat"), pos.get("lon"),
                s.get("f4"), s.get("f5"), s.get("f6"), s.get("f7"),
                s.get("f8"), s.get("f9"), s.get("f10"), s.get("f11"),
                s.get("f12"), s.get("f13"), s.get("f14"), s.get("f15"),
            ))

    if lap_rows:
        con.executemany(
            "INSERT OR REPLACE INTO laps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            lap_rows,
        )

    if sample_rows:
        # DuckDB executemany() is slow for large batches; we register a Python
        # list-of-tuples as a relation and INSERT FROM it in a single statement.
        # This is ~100x faster than per-row inserts for sample-scale loads.
        con.execute("DELETE FROM samples WHERE session_guid = ?", [sg])
        cols = ["session_guid", "lap_index", "dist_idx", "seq",
                "lat", "lon", "f4", "f5", "f6", "f7", "f8", "f9",
                "f10", "f11", "f12", "f13", "f14", "f15"]
        # Build a single Arrow table by column for fastest ingest
        import pyarrow as pa
        cols_data = list(zip(*sample_rows))
        table = pa.Table.from_arrays(
            [pa.array(c) for c in cols_data], names=cols
        )
        con.register("_samples_in", table)
        try:
            con.execute("INSERT INTO samples SELECT * FROM _samples_in")
        finally:
            con.unregister("_samples_in")

    return len(sample_rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DEFAULT_DB), help="DuckDB file path")
    ap.add_argument("--session", help="Load just one session GUID")
    args = ap.parse_args()

    con = duckdb.connect(args.db)
    init_schema(con)
    load_track_configs(con)

    targets = []
    if args.session:
        d = SESSIONS_DIR / args.session
        if not d.exists():
            print(f"[ERROR] no such session dir: {d}")
            sys.exit(1)
        targets = [d]
    else:
        targets = sorted(SESSIONS_DIR.iterdir())

    total_samples = 0
    for i, d in enumerate(targets, 1):
        if not d.is_dir():
            continue
        try:
            n = load_session(con, d)
            total_samples += n
            print(f"[{i}/{len(targets)}] {d.name}: {n:,} samples")
        except Exception as e:
            print(f"[{i}/{len(targets)}] {d.name}: FAILED ({type(e).__name__}: {e})")

    print(f"\n[done] total samples loaded: {total_samples:,}")
    print(f"[done] db at {args.db}")

    # Quick stats
    rows = con.execute("""
        SELECT
          (SELECT COUNT(*) FROM sessions) AS sessions,
          (SELECT COUNT(*) FROM laps) AS laps,
          (SELECT COUNT(*) FROM samples) AS samples,
          (SELECT COUNT(*) FROM track_configs) AS track_configs
    """).fetchone()
    print(f"[stats] sessions={rows[0]}  laps={rows[1]}  samples={rows[2]:,}  "
          f"track_configs={rows[3]}")


if __name__ == "__main__":
    main()
