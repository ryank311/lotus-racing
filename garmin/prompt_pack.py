#!/usr/bin/env python3
"""
Generate a data-dense LLM coaching brief from selected Catalyst sessions.

Default output is one self-contained markdown file at coaching/<date>-<scope>-brief.md.
With --csv, also writes a parallel coaching/<date>-<scope>-data/ folder containing
CSV exports of every lap, segment, corner, and downsampled sample so a code-execution
LLM (Claude Code, ChatGPT with Code Interpreter) can crunch the raw numbers.

Brief contents (lean by default):
  1. Car context (lotus/Lotus.md only — full car spec)
  2. Track reference: Garmin segments + named corners + segment naming
  3. Sessions analysed: date, conditions, best lap, lap count
  4. ALL laps × per-segment splits (one row per lap)
  5. ALL laps × per-corner stats (entry/apex/exit speed, max G, brake/throttle)
  6. Personal-best baselines per segment + per corner (for delta computation)
  7. Best-lap sample trace at fixed distance intervals (~50 m)
  8. Confirmed field labels with units and interpretation for all 12 telemetry channels
  9. Coaching task instructions

Add --include-guides to inline the HPDE / suspension / track guides too (adds
~50 KB of text but useful when asking for setup/alignment advice).

Usage:
    catalyst-prompt --last 5
    catalyst-prompt --last 10 --csv --include-guides
    catalyst-prompt --session <guid> --scope corner
"""
from __future__ import annotations

import argparse
import csv
import sys
import textwrap
from datetime import date
from pathlib import Path
from typing import Any

import duckdb

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
DATA_DIR = SCRIPT_DIR / "data"
DB_PATH = DATA_DIR / "catalyst.duckdb"
TRACKS_DIR = REPO_ROOT / "tracks"
COACHING_DIR = REPO_ROOT / "coaching"


def resolve_profile_dir(name: str | None) -> Path:
    """
    Resolve a profile name (e.g. "Lotus", "Vette") to its garage directory.

    If `name` is None, auto-detect: prefer 'Lotus' if present, then 'Vette',
    then the first directory containing a Car.md.
    """
    if name:
        d = REPO_ROOT / name
        if d.is_dir() and (d / "Car.md").exists():
            return d
        # Case-insensitive fallback for macOS users typing lowercase
        for child in REPO_ROOT.iterdir():
            if child.is_dir() and child.name.lower() == name.lower() \
               and (child / "Car.md").exists():
                return child
        raise SystemExit(f"[ERROR] no profile '{name}' (missing {name}/Car.md)")

    for candidate in ("Lotus", "Vette"):
        d = REPO_ROOT / candidate
        if (d / "Car.md").exists():
            return d
    for child in sorted(REPO_ROOT.iterdir()):
        if child.is_dir() and (child / "Car.md").exists():
            return child
    raise SystemExit("[ERROR] no profile found — need a folder with Car.md")


# Confirmed field labels from embedded proto descriptor strings in libgecko.so
# (Racing.Core.Proto.GroupedSensorData, RacingTypes.pb.cc). All verified
# against observed value ranges on real VIR Full Course data.
CONFIRMED_FIELD_LABELS = {
    # name              proto field name        units / interpretation
    "gnss_speed_mps":     ("m/s",    "GPS speed. Multiply by 3.6 for kph, 2.237 for mph. "
                                     "Use this for all speed-dependent analysis. "
                                     "Typical range: 0–60 m/s at VIR."),
    "gnss_heading_deg":   ("°",      "Compass heading 0–360°. Increases clockwise (N=0, E=90). "
                                     "Rate of change indicates yaw; near-constant = straight."),
    "gnss_heading_deriv_dps": ("°/s","Heading rate of change (yaw rate from GPS). "
                                     "Near zero on straights, peaks in corners. "
                                     "Positive = turning right."),
    "gnss_accuracy_m":    ("m",      "GPS fix accuracy estimate. Smaller = better. "
                                     "Typical: 0.4–1.5 m. Not a driver input channel."),
    "gnss_altitude_m":    ("m MSL",  "GPS altitude above mean sea level. "
                                     "VIR Full Course ranges ~75–190 m. "
                                     "Use to identify elevation changes and their effect on grip."),
    "accel_x_mps2":       ("m/s²",   "Longitudinal acceleration in the vehicle frame. "
                                     "Braking = NEGATIVE (peak ~−1.4 g = −13.7 m/s²). "
                                     "Acceleration = POSITIVE (peak ~+0.9 g = +8.8 m/s²). "
                                     "Divide by 9.81 for g-force."),
    "accel_y_mps2":       ("m/s²",   "Lateral (cornering) acceleration. "
                                     "Left turn = NEGATIVE, right turn = POSITIVE. "
                                     "Peak ±1.5 g (±14.7 m/s²) on grippy tires. "
                                     "Divide by 9.81 for lateral g. "
                                     "This is the primary cornering-grip channel."),
    "accel_z_mps2":       ("m/s²",   "Vertical acceleration including gravity. "
                                     "Flat ground at rest ≈ −9.81 m/s² (gravity pulls down). "
                                     "More negative = more downforce / bump. "
                                     "Typical range −16 to −4 m/s² (−1.6 to −0.4 g)."),
    "gyro_roll_dps":      ("°/s",    "Roll angular rate (body rotation about longitudinal axis). "
                                     "Near zero on flat track; non-zero in elevation changes or "
                                     "over bumps. NOT a lateral G channel."),
    "gyro_pitch_dps":     ("°/s",    "Pitch angular rate (nose-up/nose-down rotation). "
                                     "Positive = nose rising. Peaks under acceleration / "
                                     "at crest of hills. NOT a longitudinal G channel."),
    "gyro_yaw_dps":       ("°/s",    "Yaw angular rate from IMU (rotation about vertical axis). "
                                     "Complements gnss_heading_deriv_dps. "
                                     "Used internally for stability estimation."),
    "lateral_position":   ("0–1",    "Normalised position across the track width relative to "
                                     "the GPS meanline. Interpretation: 0 = one edge, 1 = other "
                                     "edge, 0.5 = centerline. Exact edge mapping (inside vs "
                                     "outside) depends on track direction. "
                                     "Use to track apexing behaviour and line width."),
}


# ---------------------------------------------------------------------------
# YAML loading (stdlib only — accepts the subset our YAML emits)
# ---------------------------------------------------------------------------

def load_track_yaml(path: Path) -> dict:
    out: dict[str, Any] = {"segments": [], "corners": []}
    if not path.exists():
        return out
    current_list: list | None = None
    current_item: dict | None = None
    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if line in ("segments:", "corners:"):
            current_list = []
            out[line[:-1]] = current_list
            current_item = None
            continue
        if line.startswith("  - "):
            current_item = {}
            current_list.append(current_item)
            tail = line[4:]
            if ":" in tail:
                k, v = tail.split(":", 1)
                current_item[k.strip()] = _coerce(v.strip())
            continue
        if line.startswith("    ") and current_item is not None:
            tail = line.strip()
            if ":" in tail:
                k, v = tail.split(":", 1)
                current_item[k.strip()] = _coerce(v.strip())
            continue
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            out[k.strip()] = _coerce(v.strip())
            current_list = None
            current_item = None
    return out


def _coerce(s: str):
    s = s.strip().strip('"')
    if s == "":
        return ""
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    if s.lower() in ("true", "false"):
        return s.lower() == "true"
    return s


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ms_to_lap(ms: int | float | None) -> str:
    if ms is None:
        return "—"
    s = ms / 1000.0 if ms > 1000 else ms
    if s <= 0:
        return "—"
    m = int(s // 60)
    return f"{m}:{s - m*60:06.3f}"


def _inline_md(path: Path, heading_demote: int = 1) -> str:
    if not path.exists():
        return f"_(missing: {path.name})_"
    text = path.read_text(encoding="utf-8")
    if heading_demote > 0:
        text = "\n".join(
            ("#" * heading_demote + line) if line.startswith("#") else line
            for line in text.splitlines()
        )
    return text


def _rows_to_dicts(cursor) -> list[dict]:
    cols = [d[0] for d in cursor.description]
    return [dict(zip(cols, r)) for r in cursor.fetchall()]


# ---------------------------------------------------------------------------
# Data fetchers
# ---------------------------------------------------------------------------

def fetch_sessions(con, guids: list[str] | None, last_n: int | None) -> list[dict]:
    if guids:
        rows = con.execute("""
            SELECT s.*, tc.track_name, tc.track_configuration_name, tc.reverse
            FROM sessions s
            LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
            WHERE s.session_guid = ANY(?)
            ORDER BY s.session_start DESC
        """, [guids])
    else:
        limit = last_n if last_n else 50
        rows = con.execute("""
            SELECT s.*, tc.track_name, tc.track_configuration_name, tc.reverse
            FROM sessions s
            LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
            ORDER BY s.session_start DESC
            LIMIT ?
        """, [limit])
    return _rows_to_dicts(rows)


def fetch_lap_table(con, session_guids: list[str]) -> list[dict]:
    """One row per lap across all selected sessions, with aggregates joined."""
    rows = con.execute("""
        WITH stats AS (
          SELECT
            session_guid,
            lap_index,
            MAX(gnss_speed_mps)       AS max_speed,
            MIN(gnss_speed_mps)       AS min_speed,
            AVG(gnss_speed_mps)       AS avg_speed,
            MAX(ABS(accel_y_mps2))    AS max_lat_g,
            MAX(accel_x_mps2)         AS max_long_accel,
            MIN(accel_x_mps2)         AS min_long_accel
          FROM samples WHERE session_guid = ANY(?)
          GROUP BY session_guid, lap_index
        )
        SELECT
          s.session_guid,
          CAST(s.session_start AS VARCHAR) AS session_start,
          tc.track_configuration_name      AS config,
          l.lap_index,
          l.lap_type,
          l.duration_ms,
          l.sample_count,
          st.max_speed, st.min_speed, st.avg_speed,
          st.max_lat_g, st.max_long_accel, st.min_long_accel
        FROM laps l
        JOIN sessions s ON s.session_guid = l.session_guid
        LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
        LEFT JOIN stats st
          ON st.session_guid = l.session_guid AND st.lap_index = l.lap_index
        WHERE l.session_guid = ANY(?)
        ORDER BY s.session_start DESC, l.lap_index
    """, [session_guids, session_guids])
    return _rows_to_dicts(rows)


def fetch_segment_splits(con, session_guid: str, segments: list[dict]) -> list[list[float | None]]:
    """
    Per-lap, per-segment estimated split times in seconds.

    For each sample, weight ∝ 1/gnss_speed_mps (slower samples = more time). Scale so
    the per-lap weighted sum equals duration_ms / 1000.
    """
    if not segments:
        return []
    lap_durations = {
        r[0]: r[1] for r in con.execute(
            "SELECT lap_index, duration_ms FROM laps WHERE session_guid = ?",
            [session_guid],
        ).fetchall()
    }
    rows = con.execute("""
        SELECT lap_index, distance_m, gnss_speed_mps FROM samples
        WHERE session_guid = ? AND gnss_speed_mps IS NOT NULL AND gnss_speed_mps > 0
        ORDER BY lap_index, distance_m
    """, [session_guid]).fetchall()

    by_lap: dict[int, list[tuple[int, float]]] = {}
    for lap_idx, d, sp in rows:
        by_lap.setdefault(lap_idx, []).append((d, sp))

    out: list[list[float | None]] = []
    for lap_idx in sorted(by_lap.keys()):
        samples = by_lap[lap_idx]
        lap_ms = lap_durations.get(lap_idx, 0)
        if not lap_ms or not samples:
            out.append([None] * len(segments))
            continue
        weights = [1.0 / sp for _, sp in samples]
        total_w = sum(weights)
        if total_w <= 0:
            out.append([None] * len(segments))
            continue
        scale = (lap_ms / 1000.0) / total_w
        seg_times: list[float | None] = [0.0] * len(segments)
        for (d, _), w in zip(samples, weights):
            for i, seg in enumerate(segments):
                if seg["start_dist_m"] <= d < seg["end_dist_m"]:
                    seg_times[i] += w * scale  # type: ignore
                    break
        out.append(seg_times)
    return out


def fetch_corner_stats(con, session_guid: str, lap_idx: int,
                       corners: list[dict]) -> dict[str, dict]:
    """
    Per-corner aggregates for one lap. Returns {turn_key: {entry, apex, exit, max_lat_g, ...}}.

    Approximations:
      - entry_speed = avg(gnss_speed_mps) for the first 5 samples in the zone
      - apex_speed  = min(gnss_speed_mps) within the corner
      - exit_speed  = avg(gnss_speed_mps) for the last 5 samples in the zone
      - max_lat_g   = max(|accel_y_mps2|) — lateral g in m/s², divide by 9.81 for g
      - min_accel_g = min(accel_x_mps2) — most negative = hardest braking (m/s²)
      - max_accel_g = max(accel_x_mps2) — peak acceleration (m/s²)
    """
    out: dict[str, dict] = {}
    for c in corners:
        lo, hi = c.get("dist_idx_start"), c.get("dist_idx_end")
        if lo is None or hi is None:
            continue
        rows = con.execute("""
            SELECT distance_m, gnss_speed_mps, accel_x_mps2, accel_y_mps2
            FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND distance_m BETWEEN ? AND ?
            ORDER BY distance_m
        """, [session_guid, lap_idx, lo, hi]).fetchall()
        if not rows:
            continue
        speeds = [r[1] for r in rows if r[1] is not None]
        longs  = [r[2] for r in rows if r[2] is not None]   # accel_x_mps2 (braking=neg)
        lats   = [abs(r[3]) for r in rows if r[3] is not None]  # accel_y_mps2 (cornering)
        if not speeds:
            continue
        n_edge = min(5, max(1, len(speeds) // 8))
        out[c.get("turn", "?")] = {
            "name": c.get("name", ""),
            "n_samples": len(rows),
            "entry_speed": sum(speeds[:n_edge]) / n_edge,
            "apex_speed":  min(speeds),
            "exit_speed":  sum(speeds[-n_edge:]) / n_edge,
            "speed_drop":  (sum(speeds[:n_edge]) / n_edge) - min(speeds),
            "max_lat_g":   max(lats) if lats else 0.0,
            "min_accel_g": min(longs) if longs else 0.0,
            "max_accel_g": max(longs) if longs else 0.0,
        }
    return out


def fetch_best_lap_trace(con, session_guid: str, lap_idx: int,
                         stride_m: int = 50, max_dist_m: int | None = None
                         ) -> list[dict]:
    """
    One sample every ~stride_m metres on the chosen lap. Returns a compact
    list of dicts suitable for inline markdown.
    """
    where_max = "AND distance_m <= ?" if max_dist_m else ""
    params: list = [session_guid, lap_idx, stride_m]
    if max_dist_m:
        params.append(max_dist_m)
    rows = con.execute(f"""
        SELECT distance_m, gnss_speed_mps, accel_x_mps2, accel_y_mps2,
               gnss_altitude_m, lateral_position, gnss_heading_deg
        FROM samples
        WHERE session_guid = ? AND lap_index = ?
          AND distance_m % ? = 0
          {where_max}
        ORDER BY distance_m
    """, params).fetchall()
    return [
        {
            "dist": r[0], "speed": r[1], "long_accel": r[2],
            "lat_g": r[3], "altitude": r[4], "lateral_pos": r[5], "heading": r[6],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Brief assembly
# ---------------------------------------------------------------------------

def build_brief(
    sessions: list[dict],
    track_yaml: dict,
    scope: str,
    con,
    profile_dir: Path,
    include_guides: bool = False,
    data_dir_relpath: str | None = None,
) -> str:
    today = date.today().isoformat()
    config_name = track_yaml.get("track_configuration_name", "Unknown")
    segments = track_yaml.get("segments", [])
    corners = track_yaml.get("corners", [])
    sg_list = [s["session_guid"] for s in sessions]

    parts: list[str] = []
    parts.append(f"# Coaching Brief — {config_name} ({scope})")
    parts.append(f"_Generated: {today}_  ·  _Sessions: {len(sessions)}_")
    if sessions:
        dates = [str(s["session_start"]) for s in sessions if s.get("session_start")]
        if dates:
            parts.append(f"_Date range: {min(dates)} — {max(dates)}_")
    if data_dir_relpath:
        parts.append("")
        parts.append(f"**Raw data CSVs in `{data_dir_relpath}/`** "
                     f"(laps.csv, segment_splits.csv, corner_stats.csv, "
                     f"best_lap_trace.csv). Use them if you have code execution.")
    parts.append("")
    parts.append("---")
    parts.append("")

    # ── Car context (compact) ───────────────────────────────────────────
    parts.append(f"## Car & driver — {profile_dir.name}")
    parts.append(_inline_md(profile_dir / "Car.md", heading_demote=2))
    parts.append("")

    # ── Track reference ─────────────────────────────────────────────────
    parts.append(f"## Track — {config_name}")
    parts.append(f"_{track_yaml.get('total_dist_m', '?')} m total_")
    parts.append("")
    parts.append("### Garmin reference segments (primary unit for pacing analysis)")
    parts.append("")
    parts.append("| # | Start m | End m | Length m | Flag |")
    parts.append("|---|--------:|------:|---------:|:----:|")
    for s in segments:
        parts.append(f"| S{s.get('id','?')} | {s.get('start_dist_m','?')} | "
                     f"{s.get('end_dist_m','?')} | {s.get('length_m','?')} | "
                     f"{s.get('flag','?')} |")
    parts.append("")

    if corners:
        parts.append("### Named corners (canonical, in driving order)")
        parts.append("Each corner's `range` corresponds to `distance_m` in the samples table "
                     "(metres along the track from lap start).")
        parts.append("")
        parts.append("| Turn | Name | Dir | Apex | Range | R(m) | Notes |")
        parts.append("|------|------|-----|-----:|------:|-----:|-------|")
        for c in corners:
            rng = f"{c.get('dist_idx_start','?')}-{c.get('dist_idx_end','?')}"
            parts.append(
                f"| {c.get('turn','?')} | {c.get('name','?')} | "
                f"{c.get('direction','')} | {c.get('apex_idx','?')} | {rng} | "
                f"{c.get('apex_radius_m','?')} | {c.get('character','')} |"
            )
        parts.append("")

    # ── Sessions ────────────────────────────────────────────────────────
    parts.append("## Sessions")
    parts.append("")
    parts.append("| Date | Config | Weather | Temp °C | Best Lap | Laps |")
    parts.append("|------|--------|---------|--------:|---------:|-----:|")
    for s in sessions:
        nlaps = con.execute(
            "SELECT COUNT(*) FROM laps WHERE session_guid = ?",
            [s["session_guid"]],
        ).fetchone()[0]
        parts.append(
            f"| {s.get('session_start','?')} | "
            f"{s.get('track_configuration_name','?')} | "
            f"{s.get('weather_description','') or ''} | "
            f"{s.get('temperature_c','') or ''} | "
            f"{_ms_to_lap(s.get('best_lap_ms'))} | {nlaps} |"
        )
    parts.append("")

    # ── ALL laps table ──────────────────────────────────────────────────
    parts.append("## All laps")
    parts.append("One row per lap across every selected session. "
                 "Δ best = duration minus the session's best lap.")
    parts.append("")
    lap_rows = fetch_lap_table(con, sg_list)
    # group by session for readability
    by_session: dict[str, list[dict]] = {}
    for L in lap_rows:
        by_session.setdefault(L["session_guid"], []).append(L)

    parts.append("| Session | Lap | Type | Duration | Δ best | Max speed (m/s) | Max |lat_g| (m/s²) | Max long_accel (m/s²) | Min long_accel (m/s²) |")
    parts.append("|---------|----:|------|----------:|-------:|----------------:|------------------:|----------------------:|----------------------:|")
    for sg, laps in by_session.items():
        best_ms = min((L["duration_ms"] for L in laps if L["duration_ms"]), default=0)
        for L in laps:
            delta = (L["duration_ms"] - best_ms) / 1000.0 if best_ms and L["duration_ms"] else 0.0
            parts.append(
                f"| {sg[:8]}… | {L['lap_index']+1} | {L.get('lap_type','') or ''} | "
                f"{_ms_to_lap(L['duration_ms'])} | {delta:+.3f}s | "
                f"{(L.get('max_speed') or 0):.2f} | "
                f"{(L.get('max_lat_g') or 0):.3f} | "
                f"{(L.get('max_long_accel') or 0):+.3f} | "
                f"{(L.get('min_long_accel') or 0):+.3f} |"
            )
    parts.append("")

    # ── Per-segment splits across every lap ─────────────────────────────
    parts.append(f"## Per-segment splits (sec) — all laps")
    parts.append("Computed by integrating 1/gnss_speed_mps over distance, scaled so the "
                 "per-lap sum equals lap duration. Lap-relative; comparable "
                 "across laps and sessions.")
    parts.append("")
    seg_ids = [seg["id"] for seg in segments]
    hdr = " | ".join(f"S{i}" for i in seg_ids)
    sep = "|".join(["------:"] * (len(seg_ids) + 2))
    parts.append(f"| Session | Lap | {hdr} |")
    parts.append(f"|{sep}|")

    # Track per-segment personal bests for the baseline section
    pb_per_segment = [float("inf")] * len(segments)

    for sg in sg_list:
        splits = fetch_segment_splits(con, sg, segments)
        sess_laps_dur = {
            L["lap_index"]: L["duration_ms"]
            for L in by_session.get(sg, [])
        }
        for lap_idx, row in enumerate(splits):
            if all(v is None for v in row):
                continue
            cells = []
            for i, v in enumerate(row):
                if v is None:
                    cells.append("  —  ")
                else:
                    cells.append(f"{v:6.2f}")
                    if v < pb_per_segment[i]:
                        pb_per_segment[i] = v
            parts.append(f"| {sg[:8]}… | {lap_idx+1} | " + " | ".join(cells) + " |")
    parts.append("")

    # ── Personal-best baselines (segment) ───────────────────────────────
    parts.append("### Personal-best per segment (this brief's data)")
    parts.append("")
    parts.append("| Metric | " + " | ".join(f"S{i}" for i in seg_ids) + " |")
    parts.append("|---|" + "|".join(["----:"] * len(seg_ids)) + "|")
    parts.append("| PB sec | " + " | ".join(
        f"{v:6.2f}" if v < float("inf") else "  —  " for v in pb_per_segment
    ) + " |")
    parts.append("")

    # ── Per-corner stats × all laps ─────────────────────────────────────
    if corners:
        parts.append("## Per-corner stats — every lap")
        parts.append("**entry**=avg gnss_speed_mps first 5 samples of zone, **apex**=min speed in zone, "
                     "**exit**=avg speed last 5 samples, **drop**=entry-apex. "
                     "max_lat_g = max(|accel_y_mps2|) in m/s² (divide by 9.81 for g). "
                     "min_accel_g = min(accel_x_mps2) in m/s² — most negative = hardest braking. "
                     "Use these to find late-braking opportunities "
                     "(low apex speed + high entry speed = high drop) and missed pickup "
                     "(low exit speed relative to others).")
        parts.append("")

        # Build personal-best per (corner, metric) maps
        all_corner_rows = []
        for sg in sg_list:
            sess_laps = by_session.get(sg, [])
            for L in sess_laps:
                stats = fetch_corner_stats(con, sg, L["lap_index"], corners)
                for turn_key, st in stats.items():
                    all_corner_rows.append({
                        "sg": sg, "lap": L["lap_index"] + 1, "turn": turn_key, **st,
                    })

        # Compute corner-level PBs
        pb_corner: dict[str, dict] = {}
        for row in all_corner_rows:
            tk = row["turn"]
            cur = pb_corner.setdefault(tk, {
                "best_apex_speed": 0.0,    # max apex = best
                "best_exit_speed": 0.0,    # max exit  = best
                "best_min_accel":  0.0,    # most negative = hardest braking
                "best_max_lat_g":  0.0,    # most lat G = best grip use
            })
            cur["best_apex_speed"] = max(cur["best_apex_speed"], row["apex_speed"])
            cur["best_exit_speed"] = max(cur["best_exit_speed"], row["exit_speed"])
            cur["best_min_accel"]  = min(cur["best_min_accel"],  row["min_accel_g"])
            cur["best_max_lat_g"]  = max(cur["best_max_lat_g"],  row["max_lat_g"])

        parts.append("### One row per (lap, corner)")
        parts.append("Speed columns in m/s. lat_g = |accel_y_mps2| m/s². "
                     "min_accel_g = min(accel_x_mps2) m/s² (negative = braking). "
                     "Divide m/s² by 9.81 for g-force.")
        parts.append("| Sess | Lap | Turn | Name | Entry (m/s) | Apex (m/s) | Exit (m/s) | Drop | LatG (m/s²) | MinAccX (m/s²) |")
        parts.append("|------|----:|------|------|------------:|-----------:|-----------:|-----:|------------:|---------------:|")
        for row in all_corner_rows:
            parts.append(
                f"| {row['sg'][:8]}… | {row['lap']} | {row['turn']} | "
                f"{row['name']} | "
                f"{row['entry_speed']:.2f} | {row['apex_speed']:.2f} | "
                f"{row['exit_speed']:.2f} | {row['speed_drop']:.2f} | "
                f"{row['max_lat_g']:.3f} | {row['min_accel_g']:+.3f} |"
            )
        parts.append("")

        parts.append("### Personal-best per corner")
        parts.append("| Turn | Name | Best apex (m/s) | Best exit (m/s) | Hardest braking min(accel_x) m/s² | Max LatG |accel_y| m/s² |")
        parts.append("|------|------|----------------:|----------------:|----------------------------------:|---------------------:|")
        for c in corners:
            tk = c.get("turn", "?")
            if tk not in pb_corner:
                continue
            pb = pb_corner[tk]
            parts.append(
                f"| {tk} | {c.get('name','?')} | "
                f"{pb['best_apex_speed']:.1f} | {pb['best_exit_speed']:.1f} | "
                f"{pb['best_min_accel']:+.2f} | {pb['best_max_lat_g']:.2f} |"
            )
        parts.append("")

    # ── Best lap trace ──────────────────────────────────────────────────
    if sessions:
        best_session = min(sessions, key=lambda s: s.get("best_lap_ms") or 1e12)
        sess_laps = by_session.get(best_session["session_guid"], [])
        best_lap = min(sess_laps, key=lambda L: L["duration_ms"] or 1e12)
        parts.append(f"## Best-lap trace — every ~50 m")
        parts.append(f"_{best_session['session_guid'][:8]}… lap "
                     f"{best_lap['lap_index']+1} ({_ms_to_lap(best_lap['duration_ms'])})_")
        parts.append("")
        trace = fetch_best_lap_trace(con, best_session["session_guid"],
                                     best_lap["lap_index"], stride_m=50)
        parts.append("speed=gnss_speed_mps (m/s), long_accel=accel_x_mps2 (m/s², neg=braking), "
                     "lat_g=accel_y_mps2 (m/s², |val|/9.81=g), altitude=gnss_altitude_m (m MSL), "
                     "lateral_pos=lateral_position (0–1), heading=gnss_heading_deg (°)")
        parts.append("")
        parts.append("| dist_m | speed (m/s) | long_accel (m/s²) | lat_g (m/s²) | altitude (m) | lateral_pos | heading (°) |")
        parts.append("|-------:|------------:|------------------:|-------------:|-------------:|------------:|------------:|")
        for p in trace:
            parts.append(
                f"| {p['dist']} | {p.get('speed') or 0:.2f} | "
                f"{p.get('long_accel') or 0:+.3f} | {p.get('lat_g') or 0:+.3f} | "
                f"{p.get('altitude') or 0:.1f} | {p.get('lateral_pos') or 0:.3f} | "
                f"{p.get('heading') or 0:.1f} |"
            )
        parts.append("")

    # ── Optional setup / improvement guides ─────────────────────────────
    if include_guides:
        # Pull every .md from the profile dir except Car.md (already inlined above).
        # This makes guides automatically profile-specific — a vette/ folder with
        # Aero-Guide.md and Brake-Guide.md will inline those instead of the Lotus ones.
        parts.append("## Setup & improvement guides (from profile)")
        guides = sorted(p for p in profile_dir.glob("*.md") if p.name.lower() != "car.md")
        if guides:
            for g in guides:
                parts.append(f"### {g.name}")
                parts.append(_inline_md(g, heading_demote=3))
                parts.append("")
        else:
            parts.append(f"_(no additional .md files in {profile_dir.name}/)_")
            parts.append("")

    # ── Field labels + observed value ranges ────────────────────────────
    parts.append("## Field labels — confirmed")
    parts.append("")
    parts.append("Field names confirmed from embedded proto descriptor strings in `libgecko.so` "
                 "(`Racing.Core.Proto.GroupedSensorData`, `RacingTypes.pb.cc`). All verified "
                 "against observed value ranges on real VIR Full Course data. "
                 "The **observed ranges across this brief's data** are tabulated below.")
    parts.append("")

    # Compute per-field stats across the selected sessions
    field_stats = con.execute("""
        SELECT
          MIN(gnss_speed_mps),         MAX(gnss_speed_mps),         AVG(gnss_speed_mps),
          MIN(gnss_heading_deg),       MAX(gnss_heading_deg),       AVG(gnss_heading_deg),
          MIN(gnss_heading_deriv_dps), MAX(gnss_heading_deriv_dps), AVG(gnss_heading_deriv_dps),
          MIN(gnss_accuracy_m),        MAX(gnss_accuracy_m),        AVG(gnss_accuracy_m),
          MIN(gnss_altitude_m),        MAX(gnss_altitude_m),        AVG(gnss_altitude_m),
          MIN(accel_x_mps2),           MAX(accel_x_mps2),           AVG(accel_x_mps2),
          MIN(accel_y_mps2),           MAX(accel_y_mps2),           AVG(accel_y_mps2),
          MIN(accel_z_mps2),           MAX(accel_z_mps2),           AVG(accel_z_mps2),
          MIN(gyro_roll_dps),          MAX(gyro_roll_dps),          AVG(gyro_roll_dps),
          MIN(gyro_pitch_dps),         MAX(gyro_pitch_dps),         AVG(gyro_pitch_dps),
          MIN(gyro_yaw_dps),           MAX(gyro_yaw_dps),           AVG(gyro_yaw_dps),
          MIN(lateral_position),       MAX(lateral_position),       AVG(lateral_position)
        FROM samples WHERE session_guid = ANY(?)
    """, [sg_list]).fetchone()

    parts.append("| Column | Units | Interpretation | min | max | avg |")
    parts.append("|--------|-------|----------------|----:|----:|----:|")
    for i, (col, (units, note)) in enumerate(CONFIRMED_FIELD_LABELS.items()):
        mn, mx, av = field_stats[i*3:i*3+3]
        fmt = ".3f" if abs(mx or 0) < 10 and abs(mn or 0) < 10 else ".2f"
        parts.append(
            f"| `{col}` | {units} | {note} | "
            f"{(mn or 0):{fmt}} | {(mx or 0):{fmt}} | {(av or 0):{fmt}} |"
        )
    parts.append("")

    # ── Task ────────────────────────────────────────────────────────────
    parts.append("---")
    parts.append("")
    parts.append("## Your task")
    parts.append("")
    parts.append(textwrap.dedent(f"""
        You are a **professional HPDE coach** analyzing this driver's Catalyst
        telemetry. The driver (Ryan) is intermediate. The car for this brief is
        described in the "Car & driver — {profile_dir.name}" section above —
        use its specs, mods, and driver notes as primary context (handling
        tendencies, target lap times, modification history all matter).

        Use the tables above to produce a **data-grounded coaching report**.
        Every claim must cite a specific lap, segment, or corner from the
        data — do not generalize. Computation is encouraged: deltas vs PB,
        consistency variance per segment, correlations.

        **Required sections** (markdown headings):

        1. **Headline** — overall pace vs PB potential. Compute: best
           theoretical lap = sum of best splits per segment. Compare to actual
           best lap. The gap is "consistency loss." Quote the number.
        2. **Per-segment analysis** — for each S1..S{len(segments) or 'N'} segment,
           identify (a) whether the driver is consistent, (b) average gap to
           PB, (c) which corners live in that segment and what's happening
           there. Specifically call out the 3 segments with largest avg gap-to-PB.
        3. **Per-corner analysis** — for each named corner with notable data,
           cite entry/apex/exit speeds vs PB. Identify:
             - Late-braking opportunities (low apex + high entry on PB lap
               but consistently higher apex on other laps)
             - Missed throttle pickup (lower exit speed vs PB)
             - Mid-corner deficit (lower apex vs PB)
        4. **Cross-lap consistency** — which laps are outliers; describe what
           is different (which segments/corners drove the variance).
        5. **Cross-session trends** — if multiple sessions, find improvement
           or regression; correlate to weather (temp/conditions table above)
           if there's a clear pattern.
        6. **Prioritised recommendations** — top 3 concrete changes to work
           on. For each: which corner/segment, what specifically to change,
           expected lap-time gain in seconds (with reasoning).
        7. **Drills** — specific exercises for next track day, one per priority.

        **Output format**: write your analysis to:

            coaching/{today}-{scope}.md

        Be terse and specific. Cite lap numbers, segment IDs, dist_idx ranges,
        and exact deltas (e.g. "Lap 4 S6 31.50s vs PB 30.70s = +0.80s").
        Skip generic HPDE advice — only conclusions that follow from the
        data above are useful.
    """).strip())
    parts.append("")

    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# Optional CSV exports — same data, machine-friendly
# ---------------------------------------------------------------------------

def write_csv_pack(out_dir: Path, sessions: list[dict], track_yaml: dict,
                   con) -> dict[str, int]:
    """
    Write CSV companion files into `out_dir`. Returns row counts per file.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    segments = track_yaml.get("segments", [])
    corners = track_yaml.get("corners", [])
    sg_list = [s["session_guid"] for s in sessions]
    counts: dict[str, int] = {}

    # 1. sessions.csv
    with (out_dir / "sessions.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["session_guid", "session_start", "config", "best_lap_ms",
                    "weather", "temperature_c", "humidity_pct",
                    "wind_speed_mps", "wind_direction_deg"])
        for s in sessions:
            w.writerow([s["session_guid"], s.get("session_start"),
                        s.get("track_configuration_name"), s.get("best_lap_ms"),
                        s.get("weather_description"), s.get("temperature_c"),
                        s.get("humidity_pct"), s.get("wind_speed_mps"),
                        s.get("wind_direction_deg")])
        counts["sessions.csv"] = len(sessions)

    # 2. laps.csv
    laps = fetch_lap_table(con, sg_list)
    with (out_dir / "laps.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(laps[0].keys()) if laps else ["session_guid"])
        w.writeheader()
        for row in laps:
            w.writerow(row)
        counts["laps.csv"] = len(laps)

    # 3. segment_splits.csv (long format: one row per lap × segment)
    with (out_dir / "segment_splits.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["session_guid", "lap_index", "segment_id",
                    "start_m", "end_m", "split_sec"])
        rows = 0
        for sg in sg_list:
            splits = fetch_segment_splits(con, sg, segments)
            for lap_idx, row in enumerate(splits):
                for seg, val in zip(segments, row):
                    w.writerow([sg, lap_idx, seg["id"], seg["start_dist_m"],
                                seg["end_dist_m"], val])
                    rows += 1
        counts["segment_splits.csv"] = rows

    # 4. corner_stats.csv (long format: one row per lap × corner)
    with (out_dir / "corner_stats.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["session_guid", "lap_index", "turn", "corner_name",
                    "entry_speed_mps", "apex_speed_mps", "exit_speed_mps", "speed_drop_mps",
                    "max_lat_g_mps2", "min_accel_x_mps2", "max_accel_x_mps2"])
        rows = 0
        for sg in sg_list:
            sess_laps = con.execute(
                "SELECT lap_index FROM laps WHERE session_guid = ? ORDER BY lap_index",
                [sg],
            ).fetchall()
            for (lap_idx,) in sess_laps:
                stats = fetch_corner_stats(con, sg, lap_idx, corners)
                for turn_key, st in stats.items():
                    w.writerow([sg, lap_idx, turn_key, st["name"],
                                st["entry_speed"], st["apex_speed"],
                                st["exit_speed"], st["speed_drop"],
                                st["max_lat_g"], st["min_accel_g"], st["max_accel_g"]])
                    rows += 1
        counts["corner_stats.csv"] = rows

    # 5. best_lap_trace.csv — every-50 m of every lap of every session
    with (out_dir / "best_lap_trace.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["session_guid", "lap_index", "distance_m",
                    "gnss_speed_mps", "accel_x_mps2", "accel_y_mps2",
                    "gnss_altitude_m", "lateral_position", "gnss_heading_deg"])
        rows = 0
        for sg in sg_list:
            sess_laps = con.execute(
                "SELECT lap_index FROM laps WHERE session_guid = ? ORDER BY lap_index",
                [sg],
            ).fetchall()
            for (lap_idx,) in sess_laps:
                trace = fetch_best_lap_trace(con, sg, lap_idx, stride_m=50)
                for p in trace:
                    w.writerow([sg, lap_idx, p["dist"], p.get("speed"),
                                p.get("long_accel"), p.get("lat_g"),
                                p.get("altitude"), p.get("lateral_pos"),
                                p.get("heading")])
                    rows += 1
        counts["best_lap_trace.csv"] = rows

    return counts


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--last", type=int, help="Include the last N sessions")
    g.add_argument("--session", action="append", default=[],
                   help="Specific session GUID (repeatable)")
    g.add_argument("--all", action="store_true", help="Include all sessions")

    ap.add_argument("--scope", choices=["overview", "corner", "compare"],
                    default="overview")
    ap.add_argument("--track-yaml", default=None)
    ap.add_argument("--output", "-o", default=None,
                    help="Output .md path; default coaching/<date>-<scope>-brief.md")
    ap.add_argument("--csv", action="store_true",
                    help="Also write CSV companion files in a sibling data/ folder")
    ap.add_argument("--include-guides", action="store_true",
                    help="Inline every non-Car .md file from the profile folder")
    ap.add_argument("--profile", default=None,
                    help="Car profile name (folder name, e.g. 'Lotus', 'Vette'). "
                         "Default: read from GUI's saved selection or auto-detect.")
    ap.add_argument("--db", default=str(DB_PATH))
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not Path(args.db).exists():
        print(f"[ERROR] no database at {args.db}. Run `catalyst-load` first.")
        return 1

    con = duckdb.connect(args.db, read_only=True)
    if args.session:
        sessions = fetch_sessions(con, guids=args.session, last_n=None)
    elif args.all:
        sessions = fetch_sessions(con, guids=None, last_n=10_000)
    else:
        last_n = args.last or 5
        sessions = fetch_sessions(con, guids=None, last_n=last_n)

    if not sessions:
        print("[ERROR] no sessions matched.")
        return 1

    if args.track_yaml:
        track_path = Path(args.track_yaml)
    else:
        from collections import Counter
        configs = Counter(s.get("track_configuration_name", "") for s in sessions)
        cfg = configs.most_common(1)[0][0]
        slug = cfg.lower().replace(" ", "-")
        track_path = TRACKS_DIR / f"vir-{slug}.yaml"
    track_yaml = load_track_yaml(track_path)
    if not track_yaml.get("segments"):
        print(f"[warn] no track yaml at {track_path}", file=sys.stderr)

    profile_dir = resolve_profile_dir(args.profile)

    # Choose output path; CSV folder is sibling with -data suffix
    if args.output:
        out_path = Path(args.output)
    else:
        COACHING_DIR.mkdir(parents=True, exist_ok=True)
        slug = profile_dir.name.lower()
        out_path = COACHING_DIR / f"{date.today().isoformat()}-{slug}-{args.scope}-brief.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    data_dir: Path | None = None
    data_relpath: str | None = None
    if args.csv:
        data_dir = out_path.with_name(out_path.stem.replace("-brief", "") + "-data")
        data_relpath = data_dir.name

    brief = build_brief(
        sessions, track_yaml, args.scope, con,
        profile_dir=profile_dir,
        include_guides=args.include_guides,
        data_dir_relpath=data_relpath,
    )
    out_path.write_text(brief, encoding="utf-8")

    csv_counts: dict[str, int] = {}
    if data_dir is not None:
        csv_counts = write_csv_pack(data_dir, sessions, track_yaml, con)
    con.close()

    print(f"[ok] wrote {out_path} ({len(brief):,} chars, "
          f"{len(brief.encode('utf-8'))/1024:.1f} KB)")
    if csv_counts:
        print(f"     + CSVs in {data_dir.name}/:")
        for fn, n in csv_counts.items():
            print(f"       {fn}: {n:,} rows")
    print(f"     covering {len(sessions)} session(s), "
          f"profile={profile_dir.name}, "
          f"config={track_yaml.get('track_configuration_name','?')}, "
          f"scope={args.scope}, guides={'on' if args.include_guides else 'off'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
