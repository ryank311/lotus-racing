#!/usr/bin/env python3
"""
Generate a self-contained HTML coaching dashboard from Catalyst session data.
Uses Plotly.js (CDN) — no build step, opens directly in any browser.

Seven interactive tabs:
  1. Speed Traces      — multi-lap speed vs distance, corner zones + segment lines
  2. Segment Heatmap   — split delta-from-PB across all laps × segments (green=fast)
  3. G-G Diagram       — friction circle scatter coloured by speed
  4. Corner Analysis   — entry/apex/exit scatter per corner; all laps as dots
  5. Track Map         — best-lap GPS trace coloured by speed
  6. Lateral Position  — track-width placement vs distance, all laps
  7. Longitudinal G    — braking/acceleration trace vs distance, all laps
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

# ── Aesthetics ─────────────────────────────────────────────────────────────────

_BEST_COLOR = "#FFD700"          # gold — personal-best lap
_LAP_PALETTE = [
    "#4fc3f7", "#81c784", "#ffb74d", "#ba68c8", "#ff8a65",
    "#4dd0e1", "#aed581", "#ffd54f", "#f06292", "#4db6ac",
    "#7986cb", "#a1887f", "#90a4ae", "#e57373", "#64b5f6",
]
_BG        = "#0f0f1a"
_PANEL     = "#16213e"
_GRID      = "#1e2a45"
_TEXT      = "#d0d0d0"
_SUBTEXT   = "#888888"


def _dark_layout(**overrides) -> dict:
    """Return a Plotly layout dict with the dark motorsport theme applied."""
    base: dict[str, Any] = {
        "paper_bgcolor": _BG,
        "plot_bgcolor":  _PANEL,
        "font":          {"color": _TEXT, "family": "-apple-system,system-ui,sans-serif", "size": 12},
        "xaxis":         {"color": _TEXT, "gridcolor": _GRID, "linecolor": "#444", "zerolinecolor": "#444"},
        "yaxis":         {"color": _TEXT, "gridcolor": _GRID, "linecolor": "#444", "zerolinecolor": "#444"},
        "legend":        {"bgcolor": "#1a1a2e", "bordercolor": "#444", "font": {"color": _TEXT}},
        "margin":        {"l": 60, "r": 20, "t": 50, "b": 60},
        "hovermode":     "x unified",
    }
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k].update(v)
        else:
            base[k] = v
    return base


def _lap_color(i: int, is_best: bool) -> str:
    return _BEST_COLOR if is_best else _LAP_PALETTE[i % len(_LAP_PALETTE)]


def _ms_to_lap(ms: int | float | None) -> str:
    if not ms or ms <= 0:
        return "—"
    s = ms / 1000.0
    m = int(s // 60)
    return f"{m}:{s - m*60:06.3f}"


def _mph(mps: float | None) -> float | None:
    return None if mps is None else mps * 2.23694


def _g(mps2: float | None) -> float | None:
    return None if mps2 is None else mps2 / 9.81


# ── Track geometry helpers ─────────────────────────────────────────────────────

def _corner_shapes(corners: list[dict]) -> list[dict]:
    """Semi-transparent rect behind corner zones (distance axis = x)."""
    shapes = []
    for c in corners:
        lo, hi = c.get("dist_idx_start"), c.get("dist_idx_end")
        if lo is None or hi is None:
            continue
        shapes.append({
            "type": "rect", "layer": "below",
            "x0": lo, "x1": hi, "y0": 0, "y1": 1, "yref": "paper",
            "fillcolor": "rgba(100,140,255,0.07)", "line": {"width": 0},
        })
    return shapes


def _corner_annotations(corners: list[dict], y: float = 1.03) -> list[dict]:
    anns = []
    for c in corners:
        lo, hi = c.get("dist_idx_start"), c.get("dist_idx_end")
        if lo is None or hi is None:
            continue
        anns.append({
            "x": (lo + hi) / 2, "y": y, "yref": "paper",
            "text": c.get("turn", "?"), "showarrow": False,
            "font": {"size": 9, "color": _SUBTEXT}, "xanchor": "center",
        })
    return anns


def _segment_vlines(segments: list[dict]) -> list[dict]:
    return [
        {
            "type": "line", "layer": "above",
            "x0": s["start_dist_m"], "x1": s["start_dist_m"],
            "y0": 0, "y1": 1, "yref": "paper",
            "line": {"color": "rgba(255,200,0,0.20)", "width": 1, "dash": "dot"},
        }
        for s in segments
    ]


# ── DuckDB data fetchers ───────────────────────────────────────────────────────

def _fetch_lap_meta(con, sg_list: list[str]) -> list[dict]:
    """Return one dict per driven lap, sorted session-desc then lap-asc."""
    rows = con.execute("""
        SELECT l.session_guid, l.lap_index, l.duration_ms, l.sample_count,
               s.session_start
        FROM laps l
        JOIN sessions s ON s.session_guid = l.session_guid
        WHERE l.session_guid = ANY(?) AND l.lap_type = 'DRIVEN'
        ORDER BY s.session_start DESC, l.lap_index
    """, [sg_list]).fetchall()

    laps = [
        {"sg": r[0], "sg_short": r[0][:8],
         "lap_idx": r[1], "duration_ms": r[2],
         "sample_count": r[3], "session_start": str(r[4]),
         "is_best": False}
        for r in rows
    ]
    if laps:
        best = min(laps, key=lambda l: l["duration_ms"] or 1e12)
        best["is_best"] = True
    return laps


def _fetch_speed_traces(con, sg_list: list[str], laps: list[dict],
                        stride_m: int = 25) -> list[dict]:
    """Per-lap arrays of distance_m and gnss_speed_mps."""
    traces = []
    for lap in laps:
        rows = con.execute("""
            SELECT distance_m, gnss_speed_mps
            FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND distance_m % ? = 0
              AND gnss_speed_mps IS NOT NULL
            ORDER BY distance_m
        """, [lap["sg"], lap["lap_idx"], stride_m]).fetchall()
        if not rows:
            continue
        traces.append({
            **lap,
            "dist":  [r[0] for r in rows],
            "speed": [_mph(r[1]) for r in rows],
        })
    return traces


def _fetch_gg_data(con, sg_list: list[str], laps: list[dict],
                   n_best: int = 12, every_nth: int = 4) -> dict:
    """Fetch accel_x / accel_y / speed for the n_best laps (sorted by duration)."""
    sorted_laps = sorted(
        (l for l in laps if l["duration_ms"]),
        key=lambda l: l["duration_ms"]
    )[:n_best]

    lat_g, long_g, speed_mph = [], [], []
    for lap in sorted_laps:
        rows = con.execute(f"""
            SELECT accel_y_mps2, accel_x_mps2, gnss_speed_mps
            FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND accel_x_mps2 IS NOT NULL AND accel_y_mps2 IS NOT NULL
              AND distance_m % {every_nth} = 0
            ORDER BY distance_m
        """, [lap["sg"], lap["lap_idx"]]).fetchall()
        lat_g  += [_g(r[0]) for r in rows]
        long_g += [_g(r[1]) for r in rows]
        speed_mph += [_mph(r[2]) for r in rows]

    # Reference circle radius
    all_g = [math.hypot(x, y) for x, y in zip(lat_g, long_g) if x is not None]
    p95 = sorted(all_g)[int(0.95 * len(all_g))] if all_g else 1.5

    theta = [i * math.pi / 60 for i in range(121)]
    circle_x = [p95 * math.cos(t) for t in theta]
    circle_y = [p95 * math.sin(t) for t in theta]

    return {"lat_g": lat_g, "long_g": long_g, "speed_mph": speed_mph,
            "circle_x": circle_x, "circle_y": circle_y, "p95_g": round(p95, 2)}


def _fetch_track_map(con, best_lap: dict, stride_m: int = 10) -> dict:
    """Best-lap GPS trace (lat, lon) coloured by speed."""
    rows = con.execute("""
        SELECT lat, lon, gnss_speed_mps
        FROM samples
        WHERE session_guid = ? AND lap_index = ?
          AND distance_m % ? = 0
          AND lat IS NOT NULL AND lon IS NOT NULL
        ORDER BY distance_m
    """, [best_lap["sg"], best_lap["lap_idx"], stride_m]).fetchall()
    return {
        "lat":   [r[0] for r in rows],
        "lon":   [r[1] for r in rows],
        "speed": [_mph(r[2]) for r in rows],
    }


def _fetch_lateral_traces(con, laps: list[dict], stride_m: int = 25) -> list[dict]:
    traces = []
    for lap in laps:
        rows = con.execute("""
            SELECT distance_m, lateral_position
            FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND distance_m % ? = 0
              AND lateral_position IS NOT NULL
            ORDER BY distance_m
        """, [lap["sg"], lap["lap_idx"], stride_m]).fetchall()
        if not rows:
            continue
        traces.append({**lap, "dist": [r[0] for r in rows], "pos": [r[1] for r in rows]})
    return traces


def _fetch_longg_traces(con, laps: list[dict], stride_m: int = 25) -> list[dict]:
    traces = []
    for lap in laps:
        rows = con.execute("""
            SELECT distance_m, accel_x_mps2
            FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND distance_m % ? = 0
              AND accel_x_mps2 IS NOT NULL
            ORDER BY distance_m
        """, [lap["sg"], lap["lap_idx"], stride_m]).fetchall()
        if not rows:
            continue
        traces.append({**lap, "dist": [r[0] for r in rows],
                       "long_g": [_g(r[1]) for r in rows]})
    return traces


def _compute_splits(con, sg: str, segments: list[dict]) -> dict[int, list[float | None]]:
    """Weighted 1/speed integration per segment per lap. Returns {lap_idx: [sec…]}."""
    lap_durations = dict(con.execute(
        "SELECT lap_index, duration_ms FROM laps WHERE session_guid = ?", [sg]
    ).fetchall())

    rows = con.execute("""
        SELECT lap_index, distance_m, gnss_speed_mps FROM samples
        WHERE session_guid = ? AND gnss_speed_mps IS NOT NULL AND gnss_speed_mps > 0
        ORDER BY lap_index, distance_m
    """, [sg]).fetchall()

    by_lap: dict[int, list] = {}
    for lap_idx, d, sp in rows:
        by_lap.setdefault(lap_idx, []).append((d, sp))

    result: dict[int, list] = {}
    for lap_idx, samples in by_lap.items():
        dur_ms = lap_durations.get(lap_idx, 0)
        if not dur_ms or not samples:
            result[lap_idx] = [None] * len(segments)
            continue
        weights = [1.0 / sp for _, sp in samples]
        scale = (dur_ms / 1000.0) / sum(weights)
        seg_times: list[float] = [0.0] * len(segments)
        for (d, _), w in zip(samples, weights):
            for i, seg in enumerate(segments):
                if seg["start_dist_m"] <= d < seg["end_dist_m"]:
                    seg_times[i] += w * scale
                    break
        result[lap_idx] = seg_times
    return result


def _fetch_heatmap_data(con, sg_list: list[str], laps: list[dict],
                        segments: list[dict]) -> dict:
    """Build arrays for the segment split heatmap."""
    seg_ids = [s["id"] for s in segments]

    # Per-segment personal bests (minimum split across all laps)
    pb = [float("inf")] * len(segments)

    all_splits: list[tuple[str, list[float | None]]] = []  # (label, [sec per seg])
    for lap in laps:
        sg = lap["sg"]
        splits_by_lap = _compute_splits(con, sg, segments)
        row = splits_by_lap.get(lap["lap_idx"], [None] * len(segments))
        label = f"{lap['sg_short']}… L{lap['lap_idx']+1} ({_ms_to_lap(lap['duration_ms'])})"
        all_splits.append((label, row))
        for i, v in enumerate(row):
            if v is not None and v < pb[i]:
                pb[i] = v

    # Build delta matrix (rows=laps, cols=segments)
    z_mat, text_mat, y_labels = [], [], []
    for label, row in all_splits:
        z_row, t_row = [], []
        for i, v in enumerate(row):
            if v is None or pb[i] == float("inf"):
                z_row.append(None)
                t_row.append("—")
            else:
                delta = v - pb[i]
                z_row.append(round(delta, 3))
                t_row.append(f"{v:.2f}s (+{delta:.2f})")
        z_mat.append(z_row)
        text_mat.append(t_row)
        y_labels.append(label)

    # Theoretical best row
    tb_row, tb_text = [], []
    for i, p in enumerate(pb):
        if p == float("inf"):
            tb_row.append(None); tb_text.append("—")
        else:
            tb_row.append(0.0); tb_text.append(f"{p:.2f}s (PB)")
    z_mat.append(tb_row); text_mat.append(tb_text)
    y_labels.append("⭐ Theoretical best")

    return {
        "z": z_mat, "text": text_mat,
        "x": [f"S{s}" for s in seg_ids],
        "y": y_labels,
        "zmax": max((v for row in z_mat for v in row if v is not None), default=5.0),
    }


def _fetch_corner_data(con, sg_list: list[str], laps: list[dict],
                       corners: list[dict]) -> list[dict]:
    """Per-lap per-corner entry/apex/exit speeds (mph) and G values."""
    rows_out = []
    for lap in laps:
        for c in corners:
            lo, hi = c.get("dist_idx_start"), c.get("dist_idx_end")
            if lo is None or hi is None:
                continue
            rows = con.execute("""
                SELECT gnss_speed_mps, accel_y_mps2
                FROM samples
                WHERE session_guid = ? AND lap_index = ?
                  AND distance_m BETWEEN ? AND ?
                  AND gnss_speed_mps IS NOT NULL
                ORDER BY distance_m
            """, [lap["sg"], lap["lap_idx"], lo, hi]).fetchall()
            if len(rows) < 3:
                continue
            speeds = [r[0] for r in rows]
            n_edge = min(5, max(1, len(speeds) // 8))
            rows_out.append({
                "turn":    c.get("turn", "?"),
                "name":    c.get("name", "?"),
                "lap_lbl": f"{lap['sg_short']}… L{lap['lap_idx']+1}",
                "is_best": lap["is_best"],
                "entry":   _mph(sum(speeds[:n_edge]) / n_edge),
                "apex":    _mph(min(speeds)),
                "exit":    _mph(sum(speeds[-n_edge:]) / n_edge),
                "max_lat": max((_g(abs(r[1])) for r in rows if r[1] is not None), default=0.0),
            })
    return rows_out


# ── Plotly figure builders ─────────────────────────────────────────────────────

def fig_speed(traces: list[dict], corners: list[dict], segments: list[dict]) -> dict:
    data = []
    for i, t in enumerate(traces):
        is_best = t.get("is_best", False)
        label = (f"⭐ {t['sg_short']}… L{t['lap_idx']+1} {_ms_to_lap(t['duration_ms'])}"
                 if is_best
                 else f"{t['sg_short']}… L{t['lap_idx']+1} {_ms_to_lap(t['duration_ms'])}")
        data.append({
            "x": t["dist"], "y": t["speed"],
            "name": label, "type": "scatter", "mode": "lines",
            "line": {"color": _lap_color(i, is_best),
                     "width": 3 if is_best else 1.5},
            "opacity": 1.0 if is_best else 0.55,
            "hovertemplate": "%{y:.1f} mph @ %{x}m<extra>" + label + "</extra>",
        })
    layout = _dark_layout(
        title={"text": "Speed Traces — all laps", "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Distance (m)"},
        yaxis={"title": "Speed (mph)"},
        shapes=_corner_shapes(corners) + _segment_vlines(segments),
        annotations=_corner_annotations(corners),
    )
    return {"data": data, "layout": layout}


def fig_heatmap(hm: dict) -> dict:
    zmax = hm["zmax"]
    data = [{
        "type": "heatmap",
        "x": hm["x"], "y": hm["y"], "z": hm["z"],
        "text": hm["text"],
        "hovertemplate": "%{text}<extra>%{y}</extra>",
        "texttemplate": "%{text}",
        "textfont": {"size": 10, "color": "#fff"},
        "colorscale": [
            [0,   "#2d7d46"],   # at PB — green
            [0.1, "#5ab05a"],
            [0.25,"#f0c040"],   # +0.25× zmax — yellow
            [0.6, "#e05030"],   # getting slow — orange-red
            [1,   "#8b0000"],   # worst — dark red
        ],
        "zmin": 0, "zmax": max(zmax, 0.1),
        "showscale": True,
        "colorbar": {
            "title": {"text": "Δ PB (s)", "font": {"color": _TEXT}},
            "tickfont": {"color": _TEXT},
        },
    }]
    layout = _dark_layout(
        title={"text": "Segment Splits — Δ from personal best", "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Segment", "side": "top"},
        yaxis={"autorange": "reversed"},
        hovermode="closest",
        margin={"l": 260, "r": 100, "t": 80, "b": 40},
    )
    return {"data": data, "layout": layout}


def fig_gg(gg: dict) -> dict:
    scatter = {
        "type": "scatter",
        "x": gg["lat_g"], "y": gg["long_g"],
        "mode": "markers",
        "marker": {
            "color": gg["speed_mph"],
            "colorscale": "Plasma",
            "size": 3, "opacity": 0.5,
            "colorbar": {"title": {"text": "Speed (mph)", "font": {"color": _TEXT}},
                         "tickfont": {"color": _TEXT}},
        },
        "name": "Samples",
        "hovertemplate": "Lat: %{x:.2f}g  Long: %{y:.2f}g<extra></extra>",
    }
    circle = {
        "type": "scatter",
        "x": gg["circle_x"], "y": gg["circle_y"],
        "mode": "lines",
        "line": {"color": "rgba(255,215,0,0.4)", "width": 1.5, "dash": "dash"},
        "name": f"95th-pct G ({gg['p95_g']:.2f}g)",
        "hoverinfo": "skip",
    }
    layout = _dark_layout(
        title={"text": "G-G Diagram (friction circle) — top 12 laps",
               "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Lateral G (negative = left turn)", "zeroline": True,
               "zerolinecolor": "#555", "scaleanchor": "y"},
        yaxis={"title": "Longitudinal G (negative = braking)", "zeroline": True,
               "zerolinecolor": "#555"},
        hovermode="closest",
        shapes=[
            {"type": "line", "x0": 0, "x1": 0, "y0": -2, "y1": 2,
             "line": {"color": "#444", "width": 1}},
            {"type": "line", "x0": -2, "x1": 2, "y0": 0, "y1": 0,
             "line": {"color": "#444", "width": 1}},
        ],
        annotations=[
            {"x": gg["p95_g"] * 0.71, "y": gg["p95_g"] * 0.71,
             "text": f"≈{gg['p95_g']:.2f}g", "showarrow": False,
             "font": {"color": "#aaa", "size": 10}},
        ],
    )
    return {"data": [scatter, circle], "layout": layout}


def fig_trackmap(mp: dict, corners: list[dict]) -> dict:
    # Aspect correction: at ~36.5°N, lon deg ≈ 0.808 × lat deg
    lat_span = max(mp["lat"]) - min(mp["lat"])
    lon_span = max(mp["lon"]) - min(mp["lon"])
    aspect = (lat_span / lon_span) * (1 / 0.808) if lon_span else 1.0

    speed_trace = {
        "type": "scatter",
        "x": mp["lon"], "y": mp["lat"],
        "mode": "markers+lines",
        "marker": {
            "color": mp["speed"],
            "colorscale": "RdYlGn",
            "size": 4, "opacity": 0.9,
            "colorbar": {"title": {"text": "Speed (mph)", "font": {"color": _TEXT}},
                         "tickfont": {"color": _TEXT}},
        },
        "line": {"width": 0},
        "name": "Best lap",
        "hovertemplate": "%{marker.color:.0f} mph<extra></extra>",
    }
    # Corner apex labels
    corner_anns = []
    for c in corners:
        apex_idx = c.get("apex_idx")
        if apex_idx is None:
            continue
        row = con_lat_lon_at_dist(mp, corners, c)
        if row:
            corner_anns.append({
                "x": row[0], "y": row[1],
                "text": c.get("turn", "?"),
                "showarrow": False,
                "font": {"size": 9, "color": "#ffb74d"},
                "bgcolor": "rgba(0,0,0,0.5)",
                "borderpad": 2,
            })

    layout = _dark_layout(
        title={"text": "Track Map — best lap coloured by speed",
               "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Longitude", "scaleanchor": "y", "scaleratio": aspect},
        yaxis={"title": "Latitude"},
        hovermode="closest",
        annotations=corner_anns,
    )
    return {"data": [speed_trace], "layout": layout}


def con_lat_lon_at_dist(mp: dict, corners: list[dict], c: dict):
    """Return (lon, lat) near the corner apex_idx distance. Used for map labels."""
    apex = c.get("apex_idx")
    if apex is None or not mp["lat"]:
        return None
    # mp data is at stride_m intervals; find closest index
    # We don't have the distance array here so just skip if not found
    return None


def fig_lateral(traces: list[dict], corners: list[dict]) -> dict:
    data = []
    for i, t in enumerate(traces):
        is_best = t.get("is_best", False)
        label = f"{'⭐ ' if is_best else ''}{t['sg_short']}… L{t['lap_idx']+1}"
        data.append({
            "x": t["dist"], "y": t["pos"],
            "name": label, "type": "scatter", "mode": "lines",
            "line": {"color": _lap_color(i, is_best),
                     "width": 3 if is_best else 1.5},
            "opacity": 1.0 if is_best else 0.5,
            "hovertemplate": "pos: %{y:.3f} @ %{x}m<extra>" + label + "</extra>",
        })
    layout = _dark_layout(
        title={"text": "Lateral Position (0=left edge, 1=right edge, 0.5=centre)",
               "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Distance (m)"},
        yaxis={"title": "Lateral position (0–1)", "range": [-0.05, 1.05]},
        shapes=_corner_shapes(corners),
        annotations=_corner_annotations(corners),
        hovermode="x unified",
    )
    return {"data": data, "layout": layout}


def fig_longg(traces: list[dict], corners: list[dict], segments: list[dict]) -> dict:
    data = []
    for i, t in enumerate(traces):
        is_best = t.get("is_best", False)
        label = f"{'⭐ ' if is_best else ''}{t['sg_short']}… L{t['lap_idx']+1}"
        data.append({
            "x": t["dist"], "y": t["long_g"],
            "name": label, "type": "scatter", "mode": "lines",
            "line": {"color": _lap_color(i, is_best),
                     "width": 3 if is_best else 1.5},
            "opacity": 1.0 if is_best else 0.50,
            "hovertemplate": "%{y:.2f}g @ %{x}m<extra>" + label + "</extra>",
        })
    layout = _dark_layout(
        title={"text": "Longitudinal G — braking (neg) and acceleration (pos)",
               "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Distance (m)"},
        yaxis={"title": "Long. G  (neg=braking, pos=accel)"},
        shapes=_corner_shapes(corners) + _segment_vlines(segments) + [
            {"type": "line", "x0": 0, "x1": 5500, "y0": 0, "y1": 0,
             "line": {"color": "#555", "width": 1}},
        ],
        annotations=_corner_annotations(corners),
        hovermode="x unified",
    )
    return {"data": data, "layout": layout}


def fig_corners(rows: list[dict], corners: list[dict]) -> dict:
    """
    Scatter chart: per-corner entry/apex/exit distribution across all laps.
    X = corner turn key, Y = speed (mph), three separate traces.
    Best-lap points shown as stars.
    """
    turn_order = [c["turn"] for c in corners if any(r["turn"] == c["turn"] for r in rows)]

    def make_trace(metric: str, color: str, symbol_normal: str, symbol_best: str) -> dict:
        x_norm, y_norm, lbl_norm = [], [], []
        x_best, y_best, lbl_best = [], [], []
        for r in rows:
            if r["turn"] not in turn_order:
                continue
            val = r.get(metric)
            if val is None:
                continue
            lbl = r["lap_lbl"]
            if r["is_best"]:
                x_best.append(r["turn"]); y_best.append(val); lbl_best.append(lbl)
            else:
                x_norm.append(r["turn"]); y_norm.append(val); lbl_norm.append(lbl)

        traces = [{
            "type": "scatter", "x": x_norm, "y": y_norm,
            "mode": "markers", "name": metric.capitalize(),
            "marker": {"color": color, "size": 6, "opacity": 0.55, "symbol": symbol_normal},
            "text": lbl_norm,
            "hovertemplate": "%{y:.1f} mph — %{text}<extra>" + metric + "</extra>",
            "legendgroup": metric, "showlegend": True,
        }]
        if x_best:
            traces.append({
                "type": "scatter", "x": x_best, "y": y_best,
                "mode": "markers", "name": f"{metric.capitalize()} (best lap)",
                "marker": {"color": _BEST_COLOR, "size": 14, "opacity": 1.0,
                           "symbol": symbol_best, "line": {"color": "#000", "width": 1}},
                "text": lbl_best,
                "hovertemplate": "⭐ %{y:.1f} mph — %{text}<extra>" + metric + " (best)</extra>",
                "legendgroup": metric, "showlegend": True,
            })
        return traces

    data = []
    for t in make_trace("entry", "#4fc3f7", "circle", "star"):
        data.append(t)
    for t in make_trace("apex", "#ff8a65", "diamond", "star-diamond"):
        data.append(t)
    for t in make_trace("exit", "#81c784", "square", "star-square"):
        data.append(t)

    layout = _dark_layout(
        title={"text": "Corner Analysis — entry / apex / exit speed per lap",
               "font": {"color": _BEST_COLOR, "size": 15}},
        xaxis={"title": "Corner", "categoryorder": "array", "categoryarray": turn_order},
        yaxis={"title": "Speed (mph)"},
        hovermode="closest",
        margin={"l": 60, "r": 20, "t": 60, "b": 80},
    )
    return {"data": data, "layout": layout}


# ── Stat cards HTML ────────────────────────────────────────────────────────────

def _stat_cards_html(sessions: list[dict], laps: list[dict]) -> str:
    best = next((l for l in laps if l["is_best"]), None)
    total_laps = len(laps)
    sessions_count = len(sessions)
    best_lap_str = _ms_to_lap(best["duration_ms"]) if best else "—"

    # Theoretical best from segment PB sums is computed during heatmap build;
    # we just show available quick stats here.
    avg_ms = (sum(l["duration_ms"] for l in laps if l["duration_ms"])
              / max(1, sum(1 for l in laps if l["duration_ms"])))

    cards = [
        ("Best Lap", best_lap_str, f"Session {best['sg_short']}… L{best['lap_idx']+1}" if best else ""),
        ("Avg Lap",  _ms_to_lap(avg_ms), f"across {total_laps} laps"),
        ("Sessions", str(sessions_count), "in this brief"),
        ("Laps",     str(total_laps), "driven laps"),
    ]
    html = ""
    for label, value, sub in cards:
        html += (
            f'<div class="stat-card">'
            f'<div class="stat-label">{label}</div>'
            f'<div class="stat-value">{value}</div>'
            f'<div class="stat-sub">{sub}</div>'
            f'</div>'
        )
    return html


# ── HTML template ──────────────────────────────────────────────────────────────

_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coaching Dashboard — __TITLE__</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
<style>
:root{--bg:#0f0f1a;--panel:#16213e;--border:#1e2a45;--text:#d0d0d0;--sub:#888;--accent:#ffd700}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,system-ui,sans-serif;min-height:100vh}
header{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:16px}
h1{font-size:1.3em;color:var(--accent);white-space:nowrap}
.meta{font-size:0.8em;color:var(--sub)}
.tabs{display:flex;gap:2px;padding:6px 12px;background:var(--panel);border-bottom:1px solid var(--border);flex-wrap:wrap}
.tb{padding:7px 14px;border:1px solid transparent;border-radius:4px;background:none;color:#aaa;cursor:pointer;font-size:0.85em;transition:all .15s}
.tb:hover{background:#2d3a55;color:var(--text)}
.tb.active{background:var(--accent);color:#000;font-weight:700;border-color:var(--accent)}
.pane{display:none;padding:14px}
.pane.active{display:block}
.cw{background:var(--panel);border:1px solid var(--border);border-radius:6px;margin-bottom:14px;padding:8px}
.ch{width:100%;height:520px}
.ch-lg{width:100%;height:680px}
.sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:14px}
.sc{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px}
.sl{font-size:.72em;color:var(--sub);text-transform:uppercase;letter-spacing:.05em}
.sv{font-size:1.55em;font-weight:700;color:var(--accent);margin-top:2px}
.ss{font-size:.78em;color:#555}
</style>
</head>
<body>
<header>
  <h1>⏱ Coaching Dashboard — __TITLE__</h1>
  <span class="meta">__META__</span>
</header>
<nav class="tabs">
  <button class="tb active" onclick="showTab(this,0)">Speed Traces</button>
  <button class="tb" onclick="showTab(this,1)">Segment Heatmap</button>
  <button class="tb" onclick="showTab(this,2)">G-G Diagram</button>
  <button class="tb" onclick="showTab(this,3)">Corner Analysis</button>
  <button class="tb" onclick="showTab(this,4)">Track Map</button>
  <button class="tb" onclick="showTab(this,5)">Lateral Position</button>
  <button class="tb" onclick="showTab(this,6)">Long. Accel</button>
  <button class="tb" onclick="showTab(this,7)" style="border-color:#4fc3f7;color:#4fc3f7">Annotate Corners</button>
</nav>

<div id="p0" class="pane active">
  <div class="sg">__STAT_CARDS__</div>
  <div class="cw"><div id="c0" class="ch-lg"></div></div>
</div>
<div id="p1" class="pane"><div class="cw"><div id="c1" class="ch"></div></div></div>
<div id="p2" class="pane"><div class="cw"><div id="c2" class="ch"></div></div></div>
<div id="p3" class="pane"><div class="cw"><div id="c3" class="ch-lg"></div></div></div>
<div id="p4" class="pane"><div class="cw"><div id="c4" class="ch"></div></div></div>
<div id="p5" class="pane"><div class="cw"><div id="c5" class="ch"></div></div></div>
<div id="p6" class="pane"><div class="cw"><div id="c6" class="ch"></div></div></div>

<div id="p7" class="pane">
  <div class="cw">
    <p style="padding:8px 4px 6px;color:var(--sub);font-size:.85em">
      Click anywhere on the speed trace to drop a corner marker. Enter the turn label when prompted (e.g. <em>T1 Horseshoe</em>).
      When finished, click <strong style="color:var(--accent)">Copy YAML</strong> and paste it back to Claude.
    </p>
    <div id="c-anno" class="ch-lg"></div>
  </div>
  <div class="cw" style="padding:14px">
    <div style="display:flex;gap:10px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <button onclick="copyAnno()" style="background:var(--accent);color:#000;border:none;padding:8px 18px;border-radius:4px;cursor:pointer;font-weight:700">Copy YAML</button>
      <button onclick="clearAnno()" style="background:transparent;color:var(--text);border:1px solid #555;padding:8px 18px;border-radius:4px;cursor:pointer">Clear all</button>
      <span id="anno-msg" style="color:var(--accent);font-size:.85em"></span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:.85em;margin-bottom:14px">
      <thead><tr style="color:var(--sub);text-align:left;border-bottom:1px solid var(--border)">
        <th style="padding:6px 10px">Turn</th>
        <th style="padding:6px 10px">apex_dist_m</th>
        <th style="padding:6px 10px">speed_mph</th>
        <th></th>
      </tr></thead>
      <tbody id="anno-tbody"></tbody>
    </table>
    <pre id="anno-pre" style="background:#0a0a14;border:1px solid var(--border);border-radius:4px;padding:14px;font-size:.78em;color:#adf;white-space:pre-wrap"># Click the chart above, then paste this back to Claude
corners: []</pre>
  </div>
</div>

<script>
const FIGS=__FIGS_JSON__;
const BEST_LAP=__BEST_LAP_JSON__;
const DIVS=['c0','c1','c2','c3','c4','c5','c6'];
const KEYS=['speed','heatmap','gg','corners','map','lateral','longg'];
const done={};
const CFG={responsive:true,displayModeBar:true,
  modeBarButtonsToRemove:['sendDataToCloud','lasso2d','select2d'],
  toImageButtonOptions:{format:'png',scale:2}};

function render(idx){
  if(done[idx])return;done[idx]=true;
  if(idx===7){_renderAnnotator();return;}
  const f=FIGS[KEYS[idx]];
  Plotly.newPlot(DIVS[idx],f.data,f.layout,CFG);
}
function showTab(btn,idx){
  document.querySelectorAll('.tb').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('p'+idx).classList.add('active');
  render(idx);
}
render(0);

// ── Corner Annotator ────────────────────────────────────────────────────────
let annos=[];
function _renderAnnotator(){
  const lyt={
    paper_bgcolor:'#0f0f1a',plot_bgcolor:'#16213e',
    font:{color:'#d0d0d0',family:'-apple-system,system-ui,sans-serif',size:12},
    xaxis:{title:'Distance (m)',color:'#d0d0d0',gridcolor:'#1e2a45',linecolor:'#444'},
    yaxis:{title:'Speed (mph)',color:'#d0d0d0',gridcolor:'#1e2a45',linecolor:'#444'},
    title:{text:'Best Lap Speed — click to mark a corner apex',font:{color:'#d0d0d0',size:14}},
    margin:{l:60,r:20,t:50,b:60},hovermode:'x unified',
    legend:{bgcolor:'#1a1a2e',bordercolor:'#444',font:{color:'#d0d0d0'}}
  };
  Plotly.newPlot('c-anno',[{
    x:BEST_LAP.x,y:BEST_LAP.y,mode:'lines',name:'Best lap',
    line:{color:'#FFD700',width:2},hovertemplate:'%{y:.1f} mph<extra></extra>'
  }],lyt,CFG);
  document.getElementById('c-anno').on('plotly_click',function(data){
    const pt=data.points[0];
    const dist=Math.round(pt.x);
    const spd=parseFloat(pt.y.toFixed(1));
    const nm=prompt('Turn label (e.g. "T1 Horseshoe" or just "T1"):');
    if(!nm||!nm.trim())return;
    annos.push({turn:nm.trim(),apex_dist_m:dist,apex_speed_mph:spd});
    annos.sort((a,b)=>a.apex_dist_m-b.apex_dist_m);
    _redrawMarkers();
    _updateAnnoUI();
  });
}
function _redrawMarkers(){
  const el=document.getElementById('c-anno');
  if(!el||!el.data)return;
  const toRm=[];
  for(let t=1;t<el.data.length;t++)toRm.push(t);
  if(toRm.length)Plotly.deleteTraces('c-anno',toRm);
  if(!annos.length)return;
  Plotly.addTraces('c-anno',{
    x:annos.map(a=>a.apex_dist_m),
    y:annos.map(a=>a.apex_speed_mph),
    mode:'markers+text',
    text:annos.map(a=>a.turn),
    textposition:'top center',
    textfont:{color:'#FFD700',size:11},
    marker:{color:'#FFD700',size:10,symbol:'triangle-up'},
    showlegend:false,hoverinfo:'none',type:'scatter'
  });
}
function _updateAnnoUI(){
  document.getElementById('anno-tbody').innerHTML=annos.map((a,i)=>
    '<tr style="border-bottom:1px solid #1e2a45">'+
    '<td style="padding:5px 10px;color:#FFD700">'+a.turn+'</td>'+
    '<td style="padding:5px 10px">'+a.apex_dist_m+'</td>'+
    '<td style="padding:5px 10px">'+a.apex_speed_mph+'</td>'+
    '<td style="padding:5px 10px"><button onclick="delAnno('+i+')" style="background:none;border:1px solid #555;color:#888;cursor:pointer;border-radius:3px;padding:2px 8px">✕</button></td>'+
    '</tr>'
  ).join('');
  const yaml='corners:\\n'+annos.map(a=>
    '  - turn: "'+a.turn+'"\\n'+
    '    apex_dist_m: '+a.apex_dist_m+'\\n'+
    '    apex_speed_mph: '+a.apex_speed_mph
  ).join('\\n');
  document.getElementById('anno-pre').textContent=
    '# Paste this back to Claude to update vir-full-course.yaml\\n'+yaml;
}
function delAnno(i){annos.splice(i,1);_redrawMarkers();_updateAnnoUI();}
function copyAnno(){
  navigator.clipboard.writeText(document.getElementById('anno-pre').textContent)
    .then(()=>{
      const m=document.getElementById('anno-msg');
      m.textContent='✓ Copied to clipboard!';
      setTimeout(()=>m.textContent='',2500);
    }).catch(()=>{
      document.getElementById('anno-msg').textContent='Select + copy the text below manually';
    });
}
function clearAnno(){
  if(!annos.length||confirm('Clear all annotations?')){
    annos=[];_redrawMarkers();_updateAnnoUI();
  }
}
</script>
</body>
</html>
"""


# ── Main entry point ───────────────────────────────────────────────────────────

def generate_html_report(
    sessions: list[dict],
    track_yaml: dict,
    con,
    profile_name: str = "",
) -> str:
    """
    Build and return a self-contained HTML string for the coaching dashboard.
    `sessions` is the list of session dicts (same format as prompt_pack fetches).
    `con` is an open DuckDB connection.
    """
    sg_list = [s["session_guid"] for s in sessions]
    corners  = track_yaml.get("corners", [])
    segments = track_yaml.get("segments", [])
    config   = track_yaml.get("track_configuration_name", "Unknown")

    # ── Gather metadata ────────────────────────────────────────────────────────
    laps = _fetch_lap_meta(con, sg_list)
    if not laps:
        return "<html><body><p>No driven laps found for selected sessions.</p></body></html>"
    best_lap = next((l for l in laps if l["is_best"]), laps[0])

    # ── Build chart data ───────────────────────────────────────────────────────
    speed_tr  = _fetch_speed_traces(con, sg_list, laps, stride_m=25)
    gg_data   = _fetch_gg_data(con, sg_list, laps)
    map_data  = _fetch_track_map(con, best_lap, stride_m=10)
    lat_tr    = _fetch_lateral_traces(con, laps, stride_m=25)
    longg_tr  = _fetch_longg_traces(con, laps, stride_m=25)
    hm_data   = _fetch_heatmap_data(con, sg_list, laps, segments) if segments else {}
    corner_rows = _fetch_corner_data(con, sg_list, laps, corners) if corners else []

    # ── Build Plotly figures ───────────────────────────────────────────────────
    figs: dict[str, dict] = {}
    figs["speed"]   = fig_speed(speed_tr, corners, segments)
    figs["heatmap"] = fig_heatmap(hm_data) if hm_data else {"data": [], "layout": _dark_layout(title="No segment data")}
    figs["gg"]      = fig_gg(gg_data)
    figs["corners"] = fig_corners(corner_rows, corners) if corner_rows else {"data": [], "layout": _dark_layout(title="No corner data")}
    figs["map"]     = fig_trackmap(map_data, corners)
    figs["lateral"] = fig_lateral(lat_tr, corners)
    figs["longg"]   = fig_longg(longg_tr, corners, segments)

    # ── Best-lap trace for annotation tab (every 5 m) ─────────────────────────
    _best_rows = con.execute("""
        SELECT distance_m, gnss_speed_mps * 2.23694
        FROM samples
        WHERE session_guid = ? AND lap_index = ?
          AND gnss_speed_mps IS NOT NULL
          AND distance_m % 5 = 0
        ORDER BY distance_m
    """, [best_lap["sg"], best_lap["lap_idx"]]).fetchall()
    best_lap_json = json.dumps({
        "x": [r[0] for r in _best_rows],
        "y": [round(r[1], 1) if r[1] is not None else None for r in _best_rows],
    })

    # ── Serialise ──────────────────────────────────────────────────────────────
    figs_json = json.dumps(figs, allow_nan=False,
                           default=lambda o: None)  # drop any stray non-serializables

    # ── Stat cards ─────────────────────────────────────────────────────────────
    stat_cards_html = _stat_cards_html(sessions, laps)

    # ── Meta line ─────────────────────────────────────────────────────────────
    dates = sorted(s.get("session_start", "") for s in sessions if s.get("session_start"))
    date_range = f"{str(dates[0])[:10]} – {str(dates[-1])[:10]}" if dates else ""
    meta = (f"{len(sessions)} session(s)  ·  {len(laps)} driven laps  ·  "
            f"Profile: {profile_name}  ·  {date_range}")
    title = f"{config}"

    html = (
        _HTML_TEMPLATE
        .replace("__TITLE__", title)
        .replace("__META__", meta)
        .replace("__STAT_CARDS__", stat_cards_html)
        .replace("__FIGS_JSON__", figs_json)
        .replace("__BEST_LAP_JSON__", best_lap_json)
    )
    return html
