#!/usr/bin/env python3
"""
Decode Garmin Catalyst performance.pb / optimal_lap.pb files into JSON+Parquet.

Schema reverse-engineered from embedded proto descriptor strings in libgecko.so
(Racing.Core.Proto namespace, RacingTypes.pb.cc build artifact) and cross-validated
against real telemetry data.

    PerformanceData {                     // Session.proto
      int32 proto_version = 1
      ProductIdentifier product_identifier = 2   // unit_id, software_part_number, version
      GUID session_guid = 3              // string UUID in GUID.uuid sub-field
      GUID meanline_guid = 4
      int64 start_time_utc_s = 5
      int64 duration_s = 6
      int64 utc_to_local_offset_s = 7
      float best_three_seq_var = 8       // lap-time consistency: best 3 sequential laps
      float top_three_var = 9            // variance of top-3 lap times
      float top_five_var = 10            // variance of top-5 lap times
      Lap average_lap = 11               // Lap.type=AVERAGE (synthesised composite)
      repeated Lap driven_laps = 12      // Lap.type=DRIVEN, one per timed lap

      Lap {                              // RacingTypes.proto
        int32 _lap_seq_id = 1            // internal ID (2,4,6,… for driven; 1 for average)
        int32 duration_ms = 2            // VERIFIED
        int32 start_time_session_ms = 3  // ms since session start
        int32 type = 4                   // Lap.Type enum: DRIVEN=0, OPTIMAL=1, AVERAGE=2
        int32 lap_descriptor = 5         // DescriptorBitMask: NORMAL, DIVERGENT, INVALID, PAUSED, BAD_GPS
        float min_speed_mps = 6
        float max_speed_mps = 7
        float avg_speed_mps = 8
        float max_decel_mps2 = 9         // most-negative longitudinal G (braking)
        float max_accel_mps2 = 10        // most-positive longitudinal G (acceleration)
        repeated GroupedSensorData data = 11

        GroupedSensorData {              // RacingTypes.proto — one sample per ~1 m of track
          float  distance_m = 1          // cumulative distance along lap (integer-valued)
          int32  time_ms = 2             // ms since lap start
          LatLong gnss_position_deg = 3  // {double lat=1, double lon=2}
          float  gnss_speed_mps = 4      // VERIFIED ~185 kph on S/F straight
          float  gnss_heading_deg = 5    // compass heading 0-360
          float  gnss_heading_deriv_dps = 6  // heading rate of change
          float  gnss_accuracy_m = 7     // GPS fix accuracy
          float  gnss_altitude_m = 8     // MSL altitude
          float  accel_x_mps2 = 9        // longitudinal: braking<0, accel>0; VERIFIED -1.07g peak brake
          float  accel_y_mps2 = 10       // lateral cornering G; VERIFIED -1.25g peak corner
          float  accel_z_mps2 = 11       // vertical + gravity (~-10.95 on flat, gravity is negative)
          float  gyro_roll_dps = 12      // roll rate
          float  gyro_pitch_dps = 13     // pitch rate
          float  gyro_yaw_dps = 14       // yaw rate
          float  lateral_position = 15   // position relative to track centerline
        }
      }
    }

    OptimalLap {                         // Session.proto
      int32 proto_version = 1
      GUID session_guid = 2
      GUID optimal_lap_video_guid = 3
      Lap optimal_lap = 4                // same Lap schema, Lap.type=OPTIMAL
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


_SAMPLE_FLOAT_FIELDS = {
    4: "gnss_speed_mps",
    5: "gnss_heading_deg",
    6: "gnss_heading_deriv_dps",
    7: "gnss_accuracy_m",
    8: "gnss_altitude_m",
    9: "accel_x_mps2",
    10: "accel_y_mps2",
    11: "accel_z_mps2",
    12: "gyro_roll_dps",
    13: "gyro_pitch_dps",
    14: "gyro_yaw_dps",
    15: "lateral_position",
}


def decode_sample(buf: bytes) -> dict:
    """One telemetry sample (GroupedSensorData) inside a lap."""
    m = parse(buf)
    pos = get_one(m, 3)
    sample = {
        "distance_m": as_f32(get_one(m, 1, 0)),
        "time_ms": get_one(m, 2),
        "position": decode_position(pos) if pos else None,
    }
    for fn, name in _SAMPLE_FLOAT_FIELDS.items():
        vs = m.get(fn)
        if not vs:
            continue
        v = vs[0]
        sample[name] = as_f32(v) if isinstance(v, int) and v <= 0xFFFFFFFF else v
    return sample


_LAP_TYPE_NAMES = {0: "DRIVEN", 1: "OPTIMAL", 2: "AVERAGE", 3: "UNKNOWN"}

_LAP_DESCRIPTOR_BITS = {
    0x01: "NORMAL", 0x02: "DIVERGENT", 0x04: "INVALID",
    0x08: "PAUSED", 0x10: "BAD_GPS",
}


def decode_lap(buf: bytes) -> dict:
    """One Lap message — header aggregates plus per-sample data."""
    m = parse(buf)
    lap_type_raw = get_one(m, 4) or 0
    lap = {
        "_lap_seq_id": get_one(m, 1),
        "duration_ms": get_one(m, 2),
        "start_time_session_ms": get_one(m, 3),
        "type": _LAP_TYPE_NAMES.get(lap_type_raw, lap_type_raw),
        "lap_descriptor": get_one(m, 5),
    }
    # Lap-level speed/G aggregates
    for fn, name in (
        (6, "min_speed_mps"), (7, "max_speed_mps"), (8, "avg_speed_mps"),
        (9, "max_decel_mps2"), (10, "max_accel_mps2"),
    ):
        v = get_one(m, fn)
        if v is not None and isinstance(v, int):
            lap[name] = as_f32(v)
    lap["samples"] = [decode_sample(b) for b in get_all(m, 11) if isinstance(b, bytes)]
    return lap


def decode_performance(buf: bytes) -> dict:
    """Top-level PerformanceData decode."""
    m = parse(buf)
    out: dict[str, Any] = {}

    # 2 = ProductIdentifier { unit_id, software_part_number, software_version_number }
    di_b = get_one(m, 2)
    if isinstance(di_b, bytes):
        di = parse(di_b)
        out["device"] = {
            "unit_id": get_one(di, 1),
            "software_part_number": as_str(get_one(di, 2, b"")),
            "software_version": as_str(get_one(di, 3, b"")),
        }
    # 3 = session_guid (GUID sub-message, uuid string at field 1)
    s3 = get_one(m, 3)
    if isinstance(s3, bytes):
        out["session_guid"] = as_str(get_one(parse(s3), 1, b""))
    # 4 = meanline_guid
    s4 = get_one(m, 4)
    if isinstance(s4, bytes):
        out["mean_line_guid"] = as_str(get_one(parse(s4), 1, b""))
    for fn, name in (
        (5, "start_time_utc_s"), (6, "duration_s"), (7, "utc_to_local_offset_s"),
    ):
        v = get_one(m, fn)
        if v is not None:
            out[name] = v
    for fn, name in (
        (8, "best_three_seq_var"), (9, "top_three_var"), (10, "top_five_var"),
    ):
        v = get_one(m, fn)
        if v is not None:
            out[name] = as_f32(v)

    # 11 = average_lap (Lap.type=AVERAGE — synthesised composite)
    avg_b = get_one(m, 11)
    if isinstance(avg_b, bytes):
        out["average_lap"] = decode_lap(avg_b)
    # 12 = driven_laps (repeated, Lap.type=DRIVEN)
    out["driven_laps"] = [decode_lap(b) for b in get_all(m, 12) if isinstance(b, bytes)]
    return out


def decode_optimal_lap(buf: bytes) -> dict:
    """OptimalLap: proto_version(1), session_guid(2), optimal_lap_video_guid(3), optimal_lap(4)."""
    m = parse(buf)
    out: dict[str, Any] = {}
    s2 = get_one(m, 2)
    if isinstance(s2, bytes):
        out["session_guid"] = as_str(get_one(parse(s2), 1, b""))
    s3 = get_one(m, 3)
    if isinstance(s3, bytes):
        out["optimal_lap_video_guid"] = as_str(get_one(parse(s3), 1, b""))
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
            driven = data.get("driven_laps", [])
            avg = data.get("average_lap", {})
            print(f"session={data.get('session_guid')}  driven_laps={len(driven)}")
            print(f"  average_lap duration={avg.get('duration_ms', 0)/1000:.3f}s  "
                  f"samples={len(avg.get('samples', []))}")
            for i, lap in enumerate(driven[:5]):
                print(f"  driven[{i}] duration={lap.get('duration_ms', 0)/1000:.3f}s  "
                      f"type={lap.get('type')}  samples={len(lap.get('samples', []))}")
            if driven:
                s = driven[0]["samples"][0] if driven[0].get("samples") else None
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
