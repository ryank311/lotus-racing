#!/usr/bin/env python3
"""
Decode Garmin Catalyst performance.pb / optimal_lap.pb files into JSON+Parquet.

We don't have the .proto schema (Garmin doesn't ship one and they're compiled
into libgecko.so), so we use a hand-rolled protobuf wire-format reader and map
field numbers to names based on observed value ranges and libgecko.so debug strings.

Field map (best understood so far — verify on real data with `--inspect`):

    PerformanceData {
      DeviceInfo device_info = 2
      string session_guid (3.1)
      string mean_line_guid (4.1)
      int64 customer_int = 5
      int32 _6, _7
      float _8, _9, _10
      Lap first_lap = 11        <- the out/warm-up lap
      repeated Lap laps = 12 {  <- timed laps (same Lap schema as field 11)
        int32 lap_number = 1
        int32 duration_ms = 2     <- VERIFIED (107106 = 1:47.106)
        int32 _3, _4, _5
        float lap_min_speed = 6   <- likely m/s
        float lap_max_speed = 7
        float lap_avg_speed = 8
        float _9, _10
        repeated Sample samples = 11 {
          float relative_time_s = 1
          int32 sample_seq = 2
          Position position = 3 { double lat = 1; double lon = 2 }
          float speed_a = 4         <- one of these is speed_mps, another speed_kph
          float speed_b = 5
          float _6, _7, _8, _9, _10
          float _11                 <- maybe altitude_m
          float _12, _13, _14       <- accel_g, cornering_g, ?
          float _15
        }
      }
    }
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Any, Iterator


# ---------------------------------------------------------------------------
# Minimal protobuf wire reader (no schema needed)
# ---------------------------------------------------------------------------

WIRE_VARINT = 0
WIRE_FIXED64 = 1
WIRE_LENGTH = 2
WIRE_FIXED32 = 5


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 64:
            raise ValueError("varint too long")


def parse(buf: bytes) -> dict[int, list[Any]]:
    """
    Parse a protobuf message into {field_number: [value, ...]}.
    Length-delimited fields are returned as bytes (caller decides whether to
    decode as sub-message, string, or packed array).
    """
    out: dict[int, list[Any]] = {}
    pos = 0
    while pos < len(buf):
        tag, pos = _read_varint(buf, pos)
        field_no = tag >> 3
        wire_type = tag & 0x7
        if wire_type == WIRE_VARINT:
            v, pos = _read_varint(buf, pos)
        elif wire_type == WIRE_FIXED64:
            v = struct.unpack_from("<Q", buf, pos)[0]
            pos += 8
        elif wire_type == WIRE_LENGTH:
            ln, pos = _read_varint(buf, pos)
            v = buf[pos:pos + ln]
            pos += ln
        elif wire_type == WIRE_FIXED32:
            v = struct.unpack_from("<I", buf, pos)[0]
            pos += 4
        else:
            raise ValueError(f"unknown wire type {wire_type}")
        out.setdefault(field_no, []).append(v)
    return out


def get_one(msg: dict[int, list[Any]], field: int, default=None):
    """Return the single value at `field` or `default`."""
    vs = msg.get(field)
    return vs[0] if vs else default


def get_all(msg: dict[int, list[Any]], field: int) -> list[Any]:
    return msg.get(field, [])


def as_str(b: bytes) -> str:
    return b.decode("utf-8", errors="replace") if isinstance(b, bytes) else b


def as_f32(v: int) -> float:
    """Reinterpret an unsigned 32-bit int as IEEE-754 float."""
    return struct.unpack("<f", struct.pack("<I", v))[0]


def as_f64(v: int) -> float:
    """Reinterpret an unsigned 64-bit int as IEEE-754 double."""
    return struct.unpack("<d", struct.pack("<Q", v))[0]


# ---------------------------------------------------------------------------
# Catalyst-specific decoding
# ---------------------------------------------------------------------------

def decode_position(buf: bytes) -> dict | None:
    m = parse(buf)
    lat = get_one(m, 1)
    lon = get_one(m, 2)
    if lat is None or lon is None:
        return None
    return {"lat": as_f64(lat), "lon": as_f64(lon)}


def decode_sample(buf: bytes) -> dict:
    """One telemetry sample inside a lap."""
    m = parse(buf)
    pos = get_one(m, 3)
    sample = {
        "t_s": as_f32(get_one(m, 1, 0)),
        "seq": get_one(m, 2),
        "position": decode_position(pos) if pos else None,
    }
    # Generic float fields 4..15 — we don't know which is which yet, so keep
    # them as f4..f15 for now. Visual inspection should let us label them.
    for fn in range(4, 16):
        vs = m.get(fn)
        if not vs:
            continue
        v = vs[0]
        # If it's bytes, leave as hex (sub-message we haven't analysed)
        if isinstance(v, bytes):
            sample[f"f{fn}_bytes"] = v.hex()
        else:
            sample[f"f{fn}"] = as_f32(v) if v <= 0xFFFFFFFF else v
    return sample


def decode_lap(buf: bytes) -> dict:
    """One lap — header fields plus samples."""
    m = parse(buf)
    lap = {
        "lap_number": get_one(m, 1),
        "duration_ms": get_one(m, 2),
        "f3": get_one(m, 3),
        "f4": get_one(m, 4),
        "f5": get_one(m, 5),
    }
    # Lap-level float aggregates
    for fn in range(6, 11):
        v = get_one(m, fn)
        if v is not None and isinstance(v, int):
            lap[f"f{fn}"] = as_f32(v)
    # Sub-samples
    lap["samples"] = [decode_sample(b) for b in get_all(m, 11) if isinstance(b, bytes)]
    return lap


def decode_performance(buf: bytes) -> dict:
    """Top-level PerformanceData decode."""
    m = parse(buf)
    out: dict[str, Any] = {}

    # 2 = DeviceInfo { 1: int, 2: "006-B3721-00", ... }
    di_b = get_one(m, 2)
    if isinstance(di_b, bytes):
        di = parse(di_b)
        out["device"] = {
            "unit_id": get_one(di, 1),
            "part_number": as_str(get_one(di, 2, b"")),
        }
    # 3.1 = sessionGuid
    s3 = get_one(m, 3)
    if isinstance(s3, bytes):
        out["session_guid"] = as_str(get_one(parse(s3), 1, b""))
    # 4.1 = meanLineGuid
    s4 = get_one(m, 4)
    if isinstance(s4, bytes):
        out["mean_line_guid"] = as_str(get_one(parse(s4), 1, b""))
    for fn in (5, 6, 7):
        v = get_one(m, fn)
        if v is not None:
            out[f"f{fn}"] = v
    for fn in (8, 9, 10):
        v = get_one(m, fn)
        if v is not None:
            out[f"f{fn}_float"] = as_f32(v)

    # Lap 1 is at field 11, subsequent laps at field 12 (both share the Lap schema)
    laps: list[dict] = []
    for b in get_all(m, 11):
        if isinstance(b, bytes):
            laps.append(decode_lap(b))
    for b in get_all(m, 12):
        if isinstance(b, bytes):
            laps.append(decode_lap(b))
    out["laps"] = laps
    return out


def decode_optimal_lap(buf: bytes) -> dict:
    """
    Optimal-lap files have a session_guid at field 2.1 and a SINGLE composite
    "lap" at field 4, structurally identical to a performance.pb lap.
    """
    m = parse(buf)
    out: dict[str, Any] = {}
    s2 = get_one(m, 2)
    if isinstance(s2, bytes):
        out["session_guid"] = as_str(get_one(parse(s2), 1, b""))
    s4 = get_one(m, 4)
    if isinstance(s4, bytes):
        out["optimal_lap"] = decode_lap(s4)
    return out


def decode_mean_line(buf: bytes) -> dict:
    """
    Mean-line files: header (device + meanLineGuid + track config) followed
    by ~5,256 GPS points at top-level field 8. Each point has:
        field 1 = cumulative distance (float, meters)
        field 2 = Position { lat: double, lon: double }
        fields 3..8 = six per-point floats (curvature, altitude, heading,
                      banking, etc. — exact mapping TBD)

    The point count is the same as the per-lap sample count: each lap sample
    aligns 1:1 to a meanline point by distance index along the track.
    """
    m = parse(buf)
    out: dict[str, Any] = {}

    di_b = get_one(m, 2)
    if isinstance(di_b, bytes):
        di = parse(di_b)
        out["device"] = {
            "unit_id": get_one(di, 1),
            "part_number": as_str(get_one(di, 2, b"")),
        }

    s3 = get_one(m, 3)
    if isinstance(s3, bytes):
        out["mean_line_guid"] = as_str(get_one(parse(s3), 1, b""))

    s4 = get_one(m, 4)
    if isinstance(s4, bytes):
        cfg = parse(s4)
        out["track_cartography_id"] = get_one(cfg, 1)
        out["track_configuration_id"] = get_one(cfg, 2)
        out["track_name"] = as_str(get_one(cfg, 3, b""))
        out["track_configuration_name"] = as_str(get_one(cfg, 4, b""))
        out["reverse"] = bool(get_one(cfg, 5, 0))

    # Field 7 = ReferenceSegments — Garmin's pre-computed sector boundaries for
    # the track. Each segment is { id, type, flag, start_dist_m, end_dist_m }.
    # Flag (field 3) is likely sector category — 1=primary, 0=transition based
    # on observed VIR Full Course pattern, but unverified for other tracks.
    segments_raw = get_one(m, 7)
    out["segments"] = []
    if isinstance(segments_raw, bytes):
        seg_msg = parse(segments_raw)
        for raw in get_all(seg_msg, 1):
            if not isinstance(raw, bytes):
                continue
            sm = parse(raw)
            out["segments"].append({
                "id":           get_one(sm, 1),
                "type":         get_one(sm, 2),
                "flag":         get_one(sm, 3),
                "start_dist_m": get_one(sm, 4),
                "end_dist_m":   get_one(sm, 5),
            })

    points: list[dict] = []
    for raw in get_all(m, 8):
        if not isinstance(raw, bytes):
            continue
        pm = parse(raw)
        cumulative_dist = as_f32(get_one(pm, 1, 0))
        pos = decode_position(get_one(pm, 2, b""))
        if not pos:
            continue
        pt = {
            "dist": cumulative_dist,
            "lat": pos["lat"],
            "lon": pos["lon"],
        }
        # Capture remaining per-point floats for diagnostic use
        for fn in range(3, 9):
            v = get_one(pm, fn)
            if v is not None and isinstance(v, int):
                pt[f"f{fn}"] = as_f32(v)
        points.append(pt)
    out["points"] = points
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Decode Garmin Catalyst .pb files")
    ap.add_argument("path", help="Path to .pb file")
    ap.add_argument("--kind", choices=["performance", "optimal_lap", "mean_line"],
                    help="If omitted, inferred from filename")
    ap.add_argument("--inspect", action="store_true",
                    help="Print structural summary instead of full JSON dump")
    args = ap.parse_args()

    path = Path(args.path)
    kind = args.kind
    if not kind:
        name = path.name.lower()
        if "performance" in name:
            kind = "performance"
        elif "optimal" in name:
            kind = "optimal_lap"
        elif "mean" in name:
            kind = "mean_line"
        else:
            print("Cannot infer kind — pass --kind", file=sys.stderr)
            sys.exit(2)

    raw = path.read_bytes()
    if kind == "performance":
        data = decode_performance(raw)
    elif kind == "optimal_lap":
        data = decode_optimal_lap(raw)
    else:
        data = decode_mean_line(raw)

    if args.inspect:
        if kind == "performance":
            laps = data.get("laps", [])
            print(f"session={data.get('session_guid')}  laps={len(laps)}")
            for lap in laps[:5]:
                print(f"  lap {lap['lap_number']:>2}  "
                      f"duration={lap.get('duration_ms', 0)/1000:.3f}s  "
                      f"samples={len(lap.get('samples', []))}")
            if laps:
                s = laps[0]["samples"][0] if laps[0].get("samples") else None
                if s:
                    print(f"  first sample: {json.dumps(s, indent=2)}")
        elif kind == "optimal_lap":
            ol = data.get("optimal_lap", {})
            print(f"session={data.get('session_guid')}  "
                  f"optimal_duration={ol.get('duration_ms', 0)/1000:.3f}s  "
                  f"samples={len(ol.get('samples', []))}")
            if ol.get("samples"):
                print(f"  first sample: {json.dumps(ol['samples'][0], indent=2)}")
        else:
            pts = data.get("points", [])
            summary = {k: v for k, v in data.items() if k != "points"}
            print(json.dumps(summary, indent=2))
            print(f"  points: {len(pts)}")
            if pts:
                print(f"  first: {json.dumps(pts[0], indent=2)}")
                print(f"  last : {json.dumps(pts[-1], indent=2)}")
    else:
        print(json.dumps(data, indent=2, default=str))


if __name__ == "__main__":
    main()
