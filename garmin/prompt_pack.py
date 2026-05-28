#!/usr/bin/env python3
"""
Generate an LLM coaching-brief from selected Catalyst sessions.

The brief is a self-contained markdown document containing:

  1. Your car/setup context (inlined from lotus/Lotus.md)
  2. Driver-improvement guide + track guide (inlined from lotus/*.md)
  3. Track reference: official Garmin reference segments + named corners
  4. Session summaries (date, weather, best lap)
  5. Per-lap aggregates (duration, max speed, max G, etc.)
  6. Per-segment splits per lap (THE coaching gold — which sectors lose time)
  7. Per-corner samples around each detected apex (for deep-dives)
  8. Field-label heuristics (which f4..f15 we think are speed/G-force/etc.)
  9. A "Your Task" instruction block telling the LLM to emit a coaching .md

Paste the resulting brief into Claude Desktop / Code / web and the LLM will
produce a coaching analysis in coaching/<date>-<topic>.md.

Note on Garmin's reference segments: they're coarse — one segment can span
multiple racing corners (e.g. at VIR Full Course, segment 4 covers both the
Snake AND the Climbing Esses). For corner-level granularity, use the named
corner list from tracks/<config>.yaml.

Usage:
    catalyst-prompt --last 5
    catalyst-prompt --session <guid1> --session <guid2>
    catalyst-prompt --all --scope overview
    catalyst-prompt --last 3 --scope compare --output coaching/may-vir.md
"""
from __future__ import annotations

import argparse
import json
import sys
import textwrap
from datetime import date, datetime
from pathlib import Path
from typing import Any

import duckdb

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
DATA_DIR = SCRIPT_DIR / "data"
DB_PATH = DATA_DIR / "catalyst.duckdb"
LOTUS_DIR = REPO_ROOT / "lotus"
TRACKS_DIR = REPO_ROOT / "tracks"
COACHING_DIR = REPO_ROOT / "coaching"


# Heuristic labels for f4..f15. These are best guesses based on value ranges
# (speed_mph at lap start ≈ 50, heading ≈ 80° east, longitudinal G near zero
# on straights, etc.) and the labeled string constants in libgecko.so. Mark
# all as PROVISIONAL in the brief so the LLM can flag inconsistencies.
PROVISIONAL_FIELD_LABELS = {
    "f4":  ("speed_mph",          "GPS speed in mph (best guess — 50.46 at lap start matches typical Exige T1 entry)"),
    "f5":  ("speed_kph_or_wheel", "speed in kph, or wheel-speed (slightly differs from GPS at limit)"),
    "f6":  ("unknown_a",          ""),
    "f7":  ("throttle_norm",      "throttle position, normalized [0,1] (matches 0.42 at low-speed start)"),
    "f8":  ("heading_deg",        "GPS heading 0-360° (80° at VIR start = ENE, matches geometry)"),
    "f9":  ("brake_norm",         "brake position, normalized [0,1] (or some related normalized signal)"),
    "f10": ("unknown_b",          ""),
    "f11": ("altitude_or_lat_pos","altitude_m relative-to-reference OR lateral_position_m from meanline"),
    "f12": ("accel_g_x",          "longitudinal accel G (braking negative, accel positive)"),
    "f13": ("accel_g_y",          "lateral / cornering G (large at apex)"),
    "f14": ("accel_g_z",          "vertical G or another axis"),
    "f15": ("unknown_c",          "small positive float, possibly slip angle or steering normalized"),
}


# ---------------------------------------------------------------------------
# YAML loading (stdlib only — accepts the subset our YAML emits)
# ---------------------------------------------------------------------------

def load_track_yaml(path: Path) -> dict:
    """Minimal YAML loader that handles the structure detect_corners.py emits.

    We deliberately avoid pulling in PyYAML for one file. Only handles:
      - top-level scalar key: value
      - top-level list: 'segments:' / 'corners:' followed by '  - key: val' items
    """
    out: dict[str, Any] = {"segments": [], "corners": []}
    if not path.exists():
        return out

    current_list: list | None = None
    current_item: dict | None = None
    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue

        # New top-level list section
        if line in ("segments:", "corners:"):
            current_list = []
            out[line[:-1]] = current_list
            current_item = None
            continue

        # New list item
        if line.startswith("  - "):
            current_item = {}
            current_list.append(current_item)
            tail = line[4:]
            if ":" in tail:
                k, v = tail.split(":", 1)
                current_item[k.strip()] = _coerce(v.strip())
            continue

        # Continuation of list item
        if line.startswith("    ") and current_item is not None:
            tail = line.strip()
            if ":" in tail:
                k, v = tail.split(":", 1)
                current_item[k.strip()] = _coerce(v.strip())
            continue

        # Top-level scalar
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
# DB queries
# ---------------------------------------------------------------------------

def fetch_sessions(con, guids: list[str] | None, last_n: int | None) -> list[dict]:
    """Return sessions sorted by start time descending, with track config joined."""
    if guids:
        q = """
            SELECT s.*, tc.track_name, tc.track_configuration_name, tc.reverse
            FROM sessions s
            LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
            WHERE s.session_guid = ANY(?)
            ORDER BY s.session_start DESC
        """
        rows = con.execute(q, [guids]).fetchall()
    else:
        limit = last_n if last_n else 50
        q = """
            SELECT s.*, tc.track_name, tc.track_configuration_name, tc.reverse
            FROM sessions s
            LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
            ORDER BY s.session_start DESC
            LIMIT ?
        """
        rows = con.execute(q, [limit]).fetchall()
    cols = [d[0] for d in con.description]
    return [dict(zip(cols, r)) for r in rows]


def fetch_laps(con, session_guid: str) -> list[dict]:
    rows = con.execute("""
        SELECT lap_index, lap_number_raw, duration_ms, sample_count
        FROM laps WHERE session_guid = ?
        ORDER BY lap_index
    """, [session_guid]).fetchall()
    return [dict(zip([d[0] for d in con.description], r)) for r in rows]


def fetch_lap_speed_stats(con, session_guid: str) -> dict[int, dict]:
    """Per-lap max/min/avg of f4 (speed) and f13 (lateral G), keyed by lap_index."""
    rows = con.execute("""
        SELECT
          lap_index,
          MAX(f4)  AS max_speed,
          MIN(f4)  AS min_speed,
          AVG(f4)  AS avg_speed,
          MAX(ABS(f13)) AS max_lat_g,
          MAX(f12) AS max_accel_g,
          MIN(f12) AS min_accel_g
        FROM samples
        WHERE session_guid = ?
        GROUP BY lap_index
        ORDER BY lap_index
    """, [session_guid]).fetchall()
    return {r[0]: dict(zip([d[0] for d in con.description], r)) for r in rows}


def fetch_segment_splits(con, session_guid: str, segments: list[dict]) -> list[list[float]]:
    """
    Per-lap, per-segment estimated split times in seconds.

    Method: each sample's dist_idx is approximately meters along the track
    (verified: 5256 samples ≈ 5255m for VIR Full Course). We approximate the
    time-share of each sample as 1 / speed_field, then scale so the per-lap
    total equals duration_ms exactly. This gives accurate proportional splits
    even if f4's unit is uncertain.

    Returns: rows[lap_index] = [seg1_sec, seg2_sec, ...] (None if missing data).
    """
    if not segments:
        return []

    lap_durations: dict[int, int] = {
        r[0]: r[1] for r in con.execute(
            "SELECT lap_index, duration_ms FROM laps WHERE session_guid = ?",
            [session_guid],
        ).fetchall()
    }

    # Pull samples grouped by lap; we need only dist_idx and a speed signal
    rows = con.execute("""
        SELECT lap_index, dist_idx, f4
        FROM samples WHERE session_guid = ? AND f4 IS NOT NULL AND f4 > 0
        ORDER BY lap_index, dist_idx
    """, [session_guid]).fetchall()

    # Group by lap
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

        # Per-sample weight ∝ 1/speed (slow points = more time)
        weights = [1.0 / sp for _, sp in samples]
        total_w = sum(weights)
        if total_w <= 0:
            out.append([None] * len(segments))
            continue
        scale = (lap_ms / 1000.0) / total_w  # seconds per unit weight

        seg_times: list[float] = [0.0] * len(segments)
        for (d, _sp), w in zip(samples, weights):
            for i, seg in enumerate(segments):
                if seg["start_dist_m"] <= d < seg["end_dist_m"]:
                    seg_times[i] += w * scale
                    break
        out.append(seg_times)
    return out


def fetch_corner_traces(con, session_guid: str, lap_idx: int,
                        corners: list[dict], every_n: int = 5) -> dict[str, list[dict]]:
    """
    For one lap, sample telemetry inside each corner zone.

    Returns: { "T12 Oak Tree": [ {dist, speed, lat_g, ...}, ... ], ... }
    """
    out: dict[str, list[dict]] = {}
    for c in corners:
        lo, hi = c.get("dist_idx_start"), c.get("dist_idx_end")
        if lo is None or hi is None:
            continue
        rows = con.execute("""
            SELECT dist_idx, f4, f7, f9, f12, f13
            FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND dist_idx BETWEEN ? AND ?
            ORDER BY dist_idx
        """, [session_guid, lap_idx, lo, hi]).fetchall()
        if not rows:
            continue
        # Downsample to keep brief size sane
        rows = rows[::every_n] or rows[:1]
        label = f"{c.get('turn', '')} {c.get('name', '')}".strip()
        out[label] = [
            {
                "dist": r[0], "speed": r[1], "throttle": r[2],
                "brake": r[3], "accel_g": r[4], "lat_g": r[5],
            } for r in rows
        ]
    return out


# ---------------------------------------------------------------------------
# Brief assembly
# ---------------------------------------------------------------------------

def _ms_to_lap(ms: int | float | None) -> str:
    if not ms:
        return "—"
    s = ms / 1000.0 if ms > 1000 else ms
    m = int(s // 60)
    return f"{m}:{s - m*60:06.3f}"


def _inline_md(path: Path, heading_demote: int = 1) -> str:
    """Inline a markdown file, optionally demoting its headings by N levels."""
    if not path.exists():
        return f"_(missing: {path.name})_"
    text = path.read_text(encoding="utf-8")
    if heading_demote > 0:
        text = "\n".join(
            ("#" * heading_demote + line) if line.startswith("#") else line
            for line in text.splitlines()
        )
    return text


def build_brief(
    sessions: list[dict],
    track_yaml: dict,
    scope: str,
    con,
) -> str:
    today = date.today().isoformat()
    config_name = track_yaml.get("track_configuration_name", "Unknown")
    segments = track_yaml.get("segments", [])
    corners = track_yaml.get("corners", [])

    parts: list[str] = []
    parts.append(f"# Coaching Brief — {config_name} ({scope})")
    parts.append(f"_Generated: {today}_  ·  _Sessions covered: {len(sessions)}_")
    parts.append("")
    if sessions:
        dates = [s["session_start"] for s in sessions if s.get("session_start")]
        if dates:
            parts.append(f"_Date range: {min(dates)} — {max(dates)}_")
    parts.append("")
    parts.append("---")
    parts.append("")

    # ── Car & driver ────────────────────────────────────────────────────
    parts.append("## Car & driver context")
    parts.append(_inline_md(LOTUS_DIR / "Lotus.md", heading_demote=2))
    parts.append("")

    # ── Track reference ─────────────────────────────────────────────────
    parts.append(f"## Track reference — {config_name}")
    parts.append(f"_Total distance: {track_yaml.get('total_dist_m', '?')} m_")
    parts.append("")
    parts.append("### Garmin official reference segments")
    parts.append("Use these as the **primary unit for per-sector pacing analysis.** "
                 "Note that segments are coarse: at VIR Full Course, segment 4 spans "
                 "both the Snake and the Climbing Esses — use the corner list below "
                 "for finer-grained per-corner analysis.")
    parts.append("")
    parts.append("| # | Start (m) | End (m) | Length (m) | Flag |")
    parts.append("|---|----------:|--------:|-----------:|:----:|")
    for s in segments:
        parts.append(f"| {s.get('id','?')} | {s.get('start_dist_m','?')} | "
                     f"{s.get('end_dist_m','?')} | {s.get('length_m','?')} | "
                     f"{s.get('flag','?')} |")
    parts.append("")

    if corners:
        parts.append("### Named corners (canonical, in driving order)")
        parts.append("`dist_idx` ranges match the per-sample `dist_idx` in performance data "
                     "(each unit ≈ 1 m at VIR Full Course).")
        parts.append("")
        parts.append("| Turn | Name | Dir | Apex idx | Range | Radius (m) | Character |")
        parts.append("|------|------|-----|---------:|------:|-----------:|-----------|")
        for c in corners:
            rng = f"{c.get('dist_idx_start','?')}-{c.get('dist_idx_end','?')}"
            parts.append(
                f"| {c.get('turn','?')} | {c.get('name','?')} | "
                f"{c.get('direction','')} | {c.get('apex_idx','?')} | "
                f"{rng} | {c.get('apex_radius_m','?')} | {c.get('character','')} |"
            )
        parts.append("")

    # ── Guides ──────────────────────────────────────────────────────────
    parts.append("## Driver improvement guide")
    parts.append(_inline_md(LOTUS_DIR / "Driver-Improvement-Guide.md", heading_demote=2))
    parts.append("")
    parts.append("## Alignment & handling guide")
    parts.append(_inline_md(LOTUS_DIR / "Alignment-and-Handling-Guide.md", heading_demote=2))
    parts.append("")
    parts.append("## Suspension tuning guide")
    parts.append(_inline_md(LOTUS_DIR / "Suspension-Tuning-Guide.md", heading_demote=2))
    parts.append("")
    if "Full Course" in config_name:
        parts.append("## VIR Full Course guide")
        parts.append(_inline_md(LOTUS_DIR / "VIR-Full-Course-Guide.md", heading_demote=2))
        parts.append("")

    # ── Session data ────────────────────────────────────────────────────
    parts.append("## Sessions analysed")
    parts.append("")
    parts.append("| Date | Track / Config | Weather | Best Lap | Laps |")
    parts.append("|------|----------------|---------|---------:|-----:|")
    for s in sessions:
        nlaps = con.execute(
            "SELECT COUNT(*) FROM laps WHERE session_guid = ?",
            [s["session_guid"]],
        ).fetchone()[0]
        weather = s.get("weather_description") or ""
        temp = s.get("temperature_c")
        if temp is not None:
            weather += f" {temp:.0f}°C"
        parts.append(
            f"| {s.get('session_start','?')} | "
            f"{s.get('track_name','?')} / {s.get('track_configuration_name','?')} | "
            f"{weather.strip()} | "
            f"{_ms_to_lap(s.get('best_lap_ms'))} | {nlaps} |"
        )
    parts.append("")

    # ── Per-lap stats per session ───────────────────────────────────────
    parts.append("## Per-lap details")
    for s in sessions:
        sg = s["session_guid"]
        parts.append("")
        parts.append(f"### {s.get('session_start','?')}  ·  "
                     f"{s.get('track_configuration_name','?')}  ·  "
                     f"best {_ms_to_lap(s.get('best_lap_ms'))}")
        parts.append(f"_session: `{sg}`_")
        parts.append("")
        laps = fetch_laps(con, sg)
        stats = fetch_lap_speed_stats(con, sg)
        parts.append("| Lap | Duration | Δ best | Max f4 | Max |f13| | Min f12 | Max f12 |")
        parts.append("|----:|---------:|-------:|-------:|---------:|--------:|--------:|")
        best_ms = s.get("best_lap_ms") or 0
        for L in laps:
            st = stats.get(L["lap_index"], {})
            delta = (L["duration_ms"] - best_ms) / 1000.0 if best_ms else 0
            parts.append(
                f"| {L['lap_index']+1} | {_ms_to_lap(L['duration_ms'])} | "
                f"{delta:+.3f}s | "
                f"{st.get('max_speed',0):.1f} | "
                f"{st.get('max_lat_g',0):.2f} | "
                f"{st.get('min_accel_g',0):.2f} | "
                f"{st.get('max_accel_g',0):.2f} |"
            )

        # Per-segment splits — only for sessions on a track config we know
        if segments and s.get("track_configuration_name") == config_name:
            parts.append("")
            parts.append("**Per-segment estimated splits (seconds)** "
                         f"— segments 1–{len(segments)} from meanline:")
            parts.append("")
            splits = fetch_segment_splits(con, sg, segments)
            hdr_cols = "|".join(f" S{seg['id']} " for seg in segments)
            sep_cols = "|".join("------:" for _ in segments)
            parts.append(f"| Lap |{hdr_cols}|")
            parts.append(f"|----:|{sep_cols}|")
            for lap_idx, row in enumerate(splits):
                cells = []
                for v in row:
                    cells.append(f"{v:6.2f}" if v is not None else "  —  ")
                parts.append(f"| {lap_idx+1} | " + " | ".join(cells) + " |")

    # ── Best-lap corner trace (1 session, 1 lap) ────────────────────────
    if scope in ("corner", "compare") and sessions and corners:
        best = min(sessions, key=lambda s: s.get("best_lap_ms") or 1e12)
        # Find the lap_index of the best lap in this session
        laps = fetch_laps(con, best["session_guid"])
        best_lap_idx = min(laps, key=lambda L: L["duration_ms"] or 1e12)["lap_index"]
        parts.append("")
        parts.append(f"## Best-lap corner traces — session {best['session_guid'][:8]}…  "
                     f"lap {best_lap_idx+1}")
        parts.append(f"Downsampled to every 5th sample.")
        traces = fetch_corner_traces(con, best["session_guid"], best_lap_idx, corners, every_n=5)
        for label, pts in traces.items():
            if not pts:
                continue
            parts.append("")
            parts.append(f"### {label}")
            parts.append("| dist_idx | speed (f4) | throttle (f7) | brake (f9) | accel_g (f12) | lat_g (f13) |")
            parts.append("|---------:|-----------:|--------------:|-----------:|--------------:|------------:|")
            for p in pts:
                parts.append(
                    f"| {p['dist']} | {p.get('speed') or 0:.1f} | "
                    f"{p.get('throttle') or 0:.3f} | {p.get('brake') or 0:.3f} | "
                    f"{p.get('accel_g') or 0:+.3f} | {p.get('lat_g') or 0:+.3f} |"
                )

    # ── Field labels (heuristic) ────────────────────────────────────────
    parts.append("")
    parts.append("## Field label heuristics  ⚠ PROVISIONAL")
    parts.append("")
    parts.append("Each sample has 12 float fields whose names Garmin doesn't expose. "
                 "Below are best-guess labels from value-range analysis (e.g. f4 = 50.46 at lap "
                 "start matches a typical Exige in low gear). **Trust the relative trends "
                 "between samples and laps, not the absolute units.** Flag any inconsistencies.")
    parts.append("")
    parts.append("| Field | Best-guess name | Notes |")
    parts.append("|-------|-----------------|-------|")
    for f, (name, note) in PROVISIONAL_FIELD_LABELS.items():
        parts.append(f"| `{f}` | `{name}` | {note} |")
    parts.append("")

    # ── Task ────────────────────────────────────────────────────────────
    parts.append("---")
    parts.append("")
    parts.append("## Your task")
    parts.append("")
    parts.append(textwrap.dedent(f"""
        You are acting as a **professional HPDE coach** with deep knowledge of
        Lotus Exige dynamics and Virginia International Raceway. The driver
        (Ryan) is an intermediate HPDE driver targeting 2:14 at VIR Full Course.

        Analyse the data above and produce a coaching report covering:

        1. **Headline assessment** — overall pace vs. potential, biggest single
           opportunity.
        2. **Per-segment analysis** — for each Garmin segment 1–{len(segments) or 'N'},
           identify whether the driver is at, near, or away from their personal best.
           Specifically call out segments where there's consistent time loss
           across laps (vs. random one-lap variance).
        3. **Per-corner analysis** — for the named corners, use the corner trace
           tables to find: late braking opportunities, early-throttle pickup
           candidates, mid-corner speed deficits.
        4. **Cross-lap consistency** — flag laps that are outliers in either
           direction; describe what they're doing differently.
        5. **Cross-session trends** — if multiple sessions are included, find
           directional improvement or regression; correlate to weather where
           possible.
        6. **Prioritised recommendations** — top 3 concrete things to work on
           next session, with the expected lap-time gain if each is fixed.
        7. **Drills** — specific exercises the driver can do at the next track
           day to address each priority.

        **Output format**: write your analysis as a Markdown file at:

            coaching/{today}-{scope}.md

        Use this structure (you may add subsections):

            # {config_name} coaching — {today}

            ## Headline
            ## Per-segment analysis
            ## Per-corner analysis
            ## Cross-lap consistency
            ## Cross-session trends
            ## Recommendations (prioritised)
            ## Drills

        Be specific: cite exact lap numbers, segment IDs, and dist_idx ranges.
        When you flag a problem, propose a concrete fix and an estimated
        lap-time gain. Don't pad with generic HPDE advice — every paragraph
        should reference real data from above.
    """).strip())
    parts.append("")

    return "\n".join(parts) + "\n"


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
                    default="overview",
                    help="What to ask the LLM to focus on")
    ap.add_argument("--track-yaml", default=None,
                    help="Path to a tracks/*.yaml; auto-detected from sessions if omitted")
    ap.add_argument("--output", "-o", default=None,
                    help="Output path; default coaching/<date>-<scope>.md")
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

    # Pick a track yaml. Prefer the configuration most-represented across the
    # selected sessions.
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
        print(f"[warn] no track yaml at {track_path}; segments + corners will be empty",
              file=sys.stderr)

    brief = build_brief(sessions, track_yaml, args.scope, con)
    con.close()

    if args.output:
        out_path = Path(args.output)
    else:
        COACHING_DIR.mkdir(parents=True, exist_ok=True)
        out_path = COACHING_DIR / f"{date.today().isoformat()}-{args.scope}-brief.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(brief, encoding="utf-8")

    print(f"[ok] wrote {out_path} ({len(brief):,} chars, "
          f"{len(brief.encode('utf-8'))/1024:.1f} KB)")
    print(f"     covering {len(sessions)} session(s), "
          f"config={track_yaml.get('track_configuration_name','?')}, "
          f"scope={args.scope}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
