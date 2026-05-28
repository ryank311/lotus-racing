#!/usr/bin/env python3
"""
Detect corner apexes on a Catalyst meanline using GPS curvature.

Approach:
  1. Project the meanline lat/lon to local meters (equirectangular).
  2. Compute discrete curvature κ at each point using three-point method:
         κ_i = | (Δx_a × Δy_b) - (Δx_b × Δy_a) | / (|a|·|b|·|a+b|/2)
     This is robust to GPS noise after light smoothing.
  3. Smooth κ with a moving average (window ~25 points = ~25 m).
  4. Find local maxima above a threshold; merge peaks closer than min_separation.
  5. For each peak, expand outward to the surrounding "corner zone" — the
     distance range where κ is above 50% of the peak.
  6. Match peaks to canonical names in driving order (e.g. "T1 Horse Shoe",
     "T4 NASCAR Bend") using a track config file like `tracks/vir-full.yaml`.

Usage:
    python detect_corners.py data/mean_lines/<guid>.pb
    python detect_corners.py data/mean_lines/<guid>.pb --names tracks/vir-full.yaml

Output: writes the corner list to tracks/<config-slug>.yaml, ready to consume
from the prompt-pack generator.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

try:
    from .decode_performance import decode_mean_line
except ImportError:  # standalone script invocation
    from decode_performance import decode_mean_line

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
TRACKS_DIR = REPO_ROOT / "tracks"


# ----------------------------------------------------------------------------
# Geometry
# ----------------------------------------------------------------------------

def latlon_to_meters(lat0: float, lat: float, lon: float) -> tuple[float, float]:
    """
    Equirectangular projection to local meters around (lat0, *).
    Good enough for a single track (errors <0.01% over a few km).
    """
    R = 6371000.0  # earth radius m
    x = math.radians(lon) * R * math.cos(math.radians(lat0))
    y = math.radians(lat) * R
    return x, y


def smooth(values: list[float], window: int) -> list[float]:
    """Moving-average smoothing, window in samples (odd recommended)."""
    n = len(values)
    half = window // 2
    out = [0.0] * n
    s = sum(values[:window]) if n >= window else sum(values)
    if n < window:
        avg = s / n
        return [avg] * n
    for i in range(n):
        if i <= half:
            window_vals = values[: i + half + 1]
        elif i >= n - half:
            window_vals = values[i - half:]
        else:
            window_vals = values[i - half: i + half + 1]
        out[i] = sum(window_vals) / len(window_vals)
    return out


def discrete_curvature(xs: list[float], ys: list[float]) -> list[float]:
    """
    Three-point discrete curvature in 1/meters. Returns 0 at endpoints.
    Formula: κ = 2·|((p2-p1)×(p3-p2))| / (|p1p2|·|p2p3|·|p1p3|)
    """
    n = len(xs)
    out = [0.0] * n
    for i in range(1, n - 1):
        x1, y1 = xs[i - 1], ys[i - 1]
        x2, y2 = xs[i], ys[i]
        x3, y3 = xs[i + 1], ys[i + 1]
        ax, ay = x2 - x1, y2 - y1
        bx, by = x3 - x2, y3 - y2
        cross = ax * by - ay * bx
        len_a = math.hypot(ax, ay)
        len_b = math.hypot(bx, by)
        len_c = math.hypot(x3 - x1, y3 - y1)
        denom = len_a * len_b * len_c
        if denom < 1e-9:
            continue
        out[i] = 2.0 * abs(cross) / denom
    return out


def find_corner_apexes(
    curvature: list[float],
    min_curvature: float = 0.005,   # 1/m — corresponds to ~200m radius max
    min_separation_pts: int = 50,    # ~50 m apart minimum
) -> list[int]:
    """Pick the index of the curvature peak for each corner."""
    n = len(curvature)
    apexes: list[int] = []
    i = 0
    while i < n:
        if curvature[i] < min_curvature:
            i += 1
            continue
        # Climb to local max
        j = i
        while j + 1 < n and curvature[j + 1] >= curvature[j]:
            j += 1
        # Walk back down — that's the descending side
        peak_idx = j
        while j + 1 < n and curvature[j + 1] < curvature[j] and curvature[j + 1] >= min_curvature * 0.3:
            j += 1
        if not apexes or peak_idx - apexes[-1] >= min_separation_pts:
            apexes.append(peak_idx)
        i = j + 1
    return apexes


def corner_zone(curvature: list[float], apex: int) -> tuple[int, int]:
    """Range of indices around `apex` where curvature ≥ 50% of peak value."""
    peak = curvature[apex]
    thresh = peak * 0.5
    lo = apex
    while lo > 0 and curvature[lo - 1] >= thresh:
        lo -= 1
    hi = apex
    n = len(curvature)
    while hi + 1 < n and curvature[hi + 1] >= thresh:
        hi += 1
    return lo, hi


# ----------------------------------------------------------------------------
# YAML output (stdlib-only mini-emitter; we don't add PyYAML as a dep)
# ----------------------------------------------------------------------------

def dump_track_yaml(track_name: str, config_name: str, meanline_guid: str,
                    total_dist_m: float, point_count: int,
                    corners: list[dict],
                    segments: list[dict] | None = None) -> str:
    """Write a track-config YAML by hand to avoid the PyYAML dep."""
    lines = []
    lines.append(f"# Auto-generated by detect_corners.py")
    lines.append(f"# Segments are Garmin's official reference segments from the meanline.")
    lines.append(f"# Corner list is derived from GPS curvature + canonical name lookup.")
    lines.append(f"track_name: {track_name}")
    lines.append(f"track_configuration_name: {config_name}")
    lines.append(f"mean_line_guid: {meanline_guid}")
    lines.append(f"total_dist_m: {total_dist_m:.2f}")
    lines.append(f"point_count: {point_count}")
    lines.append("")
    if segments:
        lines.append("# Garmin reference segments (from meanline.pb field 7). Use these as the")
        lines.append("# primary unit for per-sector time analysis — they're official, not derived.")
        lines.append("segments:")
        for s in segments:
            length = s["end_dist_m"] - s["start_dist_m"]
            lines.append(f"  - id: {s['id']}")
            lines.append(f"    start_dist_m: {s['start_dist_m']}")
            lines.append(f"    end_dist_m: {s['end_dist_m']}")
            lines.append(f"    length_m: {length}")
            lines.append(f"    flag: {s['flag']}")
        lines.append("")
    lines.append("# Named corners, in driving order. apex/start/end are dist_idx values that")
    lines.append("# match the per-sample dist_idx in performance.pb (each unit ≈ 1 m at VIR Full).")
    lines.append("corners:")
    for c in corners:
        lines.append(f"  - turn: {c['turn']}")
        lines.append(f"    name: \"{c['name']}\"")
        if c.get("direction"):
            lines.append(f"    direction: {c['direction']}")
        if c.get("character"):
            lines.append(f"    character: \"{c['character']}\"")
        lines.append(f"    apex_idx: {c['apex_idx']}")
        lines.append(f"    dist_idx_start: {c['dist_idx_start']}")
        lines.append(f"    dist_idx_end: {c['dist_idx_end']}")
        lines.append(f"    apex_lat: {c['apex_lat']:.7f}")
        lines.append(f"    apex_lon: {c['apex_lon']:.7f}")
        lines.append(f"    apex_radius_m: {c['apex_radius_m']:.1f}")
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------------
# Name-list loaders
# ----------------------------------------------------------------------------

# Canonical named corner list for VIR Full Course. Garmin doesn't give us turn
# names (their API only returns the config name "Full Course"), so this list is
# compiled from public driver guides: Wikipedia, racingcircuits.info, and
# https://racetrackdriving.com/track-guide/vir-full/ .
#
# Note: official spec is 17 turns, but several "turns" (T5a/T5b/T6a/T6b in the
# Snake, T8a/T8b in the Esses) are sub-sections of one geometric corner. The
# auto-detector typically finds ~14 physical corner peaks. This list reflects
# named SECTIONS in driving order — edit the generated YAML manually if you
# want to split or merge them differently.
VIR_FULL_TURNS = [
    {"turn": "T1",      "name": "Horse Shoe",       "direction": "right", "character": "long slow right off the front straight; heavy braking from high speed"},
    {"turn": "T2-T3",   "name": "Connectors",       "direction": "right", "character": "fast transition corners after 2014 repave"},
    {"turn": "T4",      "name": "NASCAR Bend",      "direction": "left",  "character": "slow tight left, sets up the Snake"},
    {"turn": "T5a-T5b", "name": "Snake Entry",      "direction": "L→R",   "character": "cambered medium-speed, near flat-throttle exit"},
    {"turn": "T6a-T6b", "name": "Snake Exit",       "direction": "L→R",   "character": "full throttle ideal, avoid inside curb"},
    {"turn": "T7",      "name": "Climbing Esses",   "direction": "right", "character": "uphill, blind crest, late apex — most exciting feature of VIR"},
    {"turn": "T8a-T8b", "name": "Climbing Esses 2", "direction": "R→L",   "character": "crests, blind uphill"},
    {"turn": "T9",      "name": "Esses Exit",       "direction": "left",  "character": "more open, partial→full throttle"},
    {"turn": "T10",     "name": "South Bend",       "direction": "left",  "character": "fast downhill blind-crested left"},
    {"turn": "T11",     "name": "Oak Tree Entry",   "direction": "left",  "character": "approach to Oak Tree"},
    {"turn": "T12",     "name": "Oak Tree",         "direction": "right", "character": "MOST IMPORTANT corner for lap time — feeds 4000ft back straight"},
    {"turn": "T13",     "name": "RC Entry",         "direction": "left",  "character": "short uphill jog, very brief braking zone after long back straight"},
    {"turn": "T14",     "name": "Roller Coaster",   "direction": "right", "character": "cresting hill, trailbrake — VIR's mirror of Laguna Corkscrew"},
    {"turn": "T15",     "name": "RC Exit",          "direction": "left",  "character": "downhill, full or partial throttle"},
    {"turn": "T16-T17", "name": "Hog Pen",          "direction": "L→R",   "character": "late apex; getting to full throttle early is critical for front straight speed"},
]


def get_canonical_turns(track_name: str, config_name: str) -> list[dict]:
    """Return the canonical turn list for known track configs, else []."""
    if track_name == "Virginia International Raceway" and config_name == "Full Course":
        return VIR_FULL_TURNS
    return []  # unknown — corners get generic numbers


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Detect corners on a Catalyst meanline")
    ap.add_argument("meanline_pb", help="path to a meanLine .pb file")
    ap.add_argument("--out", help="output yaml path (default: tracks/<config-slug>.yaml)")
    ap.add_argument("--min-curvature", type=float, default=0.005,
                    help="minimum κ to count as a corner (1/m). Default 0.005 = ~200m radius")
    ap.add_argument("--smooth", type=int, default=25,
                    help="smoothing window in samples")
    ap.add_argument("--print", dest="print_only", action="store_true",
                    help="print to stdout instead of writing a file")
    args = ap.parse_args()

    raw = Path(args.meanline_pb).read_bytes()
    ml = decode_mean_line(raw)
    pts = ml.get("points", [])
    if len(pts) < 10:
        print(f"[ERROR] meanline has only {len(pts)} points", file=sys.stderr)
        sys.exit(1)

    print(f"[detect] {ml['track_name']} — {ml['track_configuration_name']}: {len(pts)} points, "
          f"{pts[-1]['dist']:.1f}m total")

    lat0 = pts[0]["lat"]
    xs = [latlon_to_meters(lat0, p["lat"], p["lon"])[0] for p in pts]
    ys = [latlon_to_meters(lat0, p["lat"], p["lon"])[1] for p in pts]

    kappa = discrete_curvature(xs, ys)
    kappa = smooth(kappa, args.smooth)

    apexes = find_corner_apexes(kappa, min_curvature=args.min_curvature)
    print(f"[detect] found {len(apexes)} apex candidates")

    # Match to canonical names
    canonical = get_canonical_turns(ml["track_name"], ml["track_configuration_name"])
    corners = []
    for i, apex in enumerate(apexes):
        lo, hi = corner_zone(kappa, apex)
        radius = 1.0 / kappa[apex] if kappa[apex] > 1e-9 else 9999.0
        info = {
            "turn": f"C{i+1}",
            "name": f"Corner {i+1}",
            "direction": "",
            "character": "",
            "apex_idx": apex,
            "dist_idx_start": lo,
            "dist_idx_end": hi,
            "apex_lat": pts[apex]["lat"],
            "apex_lon": pts[apex]["lon"],
            "apex_radius_m": radius,
        }
        if i < len(canonical):
            info.update({
                "turn": canonical[i]["turn"],
                "name": canonical[i]["name"],
                "direction": canonical[i].get("direction", ""),
                "character": canonical[i].get("character", ""),
            })
        corners.append(info)

    if not args.print_only and len(corners) != len(canonical) and canonical:
        print(
            f"[warn] detected {len(corners)} corners but canonical list has "
            f"{len(canonical)}. Auto-mapping may be off — review the YAML "
            f"and tune --min-curvature if needed.",
            file=sys.stderr,
        )

    yaml_text = dump_track_yaml(
        ml["track_name"], ml["track_configuration_name"],
        ml.get("mean_line_guid", ""),
        pts[-1]["dist"], len(pts), corners,
        segments=ml.get("segments", []),
    )

    if args.print_only:
        print(yaml_text)
        return

    if args.out:
        out_path = Path(args.out)
    else:
        TRACKS_DIR.mkdir(parents=True, exist_ok=True)
        slug = (ml["track_configuration_name"] or "track").lower().replace(" ", "-")
        out_path = TRACKS_DIR / f"vir-{slug}.yaml"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(yaml_text)
    print(f"[detect] wrote {out_path}")


if __name__ == "__main__":
    main()
