// Decode Garmin Catalyst performance.pb / optimal_lap.pb / mean_line.pb files.
//
// 1:1 port of garmin/decode_performance.py. Schema reverse-engineered from
// embedded proto descriptor strings in libgecko.so (Racing.Core.Proto namespace).
//
// Wire types we handle: VARINT, FIXED64, LENGTH-DELIMITED, FIXED32.
// Length-delimited fields are returned as raw bytes; the caller decides whether
// to decode as sub-message, string, or packed array.

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

type ProtoValue = number | bigint | Uint8Array
type ProtoMessage = Map<number, ProtoValue[]>

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  while (true) {
    const b = buf[pos]
    pos += 1
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [result, pos]
    shift += 7n
    if (shift > 64n) throw new Error('varint too long')
  }
}

export function parse(buf: Uint8Array): ProtoMessage {
  const out: ProtoMessage = new Map()
  let pos = 0
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos)
    pos = p1
    const tagN = Number(tag)
    const fieldNo = tagN >>> 3
    const wireType = tagN & 0x7
    let value: ProtoValue
    if (wireType === WIRE_VARINT) {
      const [v, p2] = readVarint(buf, pos)
      value = v
      pos = p2
    } else if (wireType === WIRE_FIXED64) {
      value = new DataView(buf.buffer, buf.byteOffset + pos, 8).getBigUint64(0, true)
      pos += 8
    } else if (wireType === WIRE_LENGTH) {
      const [ln, p2] = readVarint(buf, pos)
      pos = p2
      const len = Number(ln)
      value = buf.subarray(pos, pos + len)
      pos += len
    } else if (wireType === WIRE_FIXED32) {
      value = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true)
      pos += 4
    } else {
      throw new Error(`unknown wire type ${wireType}`)
    }
    const arr = out.get(fieldNo)
    if (arr) arr.push(value)
    else out.set(fieldNo, [value])
  }
  return out
}

function getOne<T extends ProtoValue>(m: ProtoMessage, field: number, fallback?: T): T | undefined {
  const vs = m.get(field)
  return (vs && vs.length ? (vs[0] as T) : fallback) as T | undefined
}

function getAll(m: ProtoMessage, field: number): ProtoValue[] {
  return m.get(field) ?? []
}

function asStr(v: ProtoValue | undefined): string {
  if (!v) return ''
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return String(v)
}

function asF32(v: ProtoValue | undefined): number {
  if (v === undefined || v === null) return 0
  // We stored FIXED32 as a JS number; reinterpret the bits as float.
  const n = typeof v === 'bigint' ? Number(v) : (v as number)
  const buf = new ArrayBuffer(4)
  new DataView(buf).setUint32(0, n >>> 0, true)
  return new DataView(buf).getFloat32(0, true)
}

function asF64(v: ProtoValue | undefined): number {
  if (v === undefined || v === null) return 0
  // FIXED64 stored as bigint; reinterpret bits as double.
  const big = typeof v === 'bigint' ? v : BigInt(v as number)
  const buf = new ArrayBuffer(8)
  new DataView(buf).setBigUint64(0, big, true)
  return new DataView(buf).getFloat64(0, true)
}

function asI32(v: ProtoValue | undefined): number {
  if (v === undefined) return 0
  return typeof v === 'bigint' ? Number(v) : (v as number)
}

// ---------------------------------------------------------------------------
// Catalyst types
// ---------------------------------------------------------------------------

export interface Position {
  lat: number
  lon: number
}

export interface Sample {
  distance_m: number
  time_ms: number
  position: Position | null
  gnss_speed_mps?: number
  gnss_heading_deg?: number
  gnss_heading_deriv_dps?: number
  gnss_accuracy_m?: number
  gnss_altitude_m?: number
  accel_x_mps2?: number
  accel_y_mps2?: number
  accel_z_mps2?: number
  gyro_roll_dps?: number
  gyro_pitch_dps?: number
  gyro_yaw_dps?: number
  lateral_position?: number
}

export interface Lap {
  _lap_seq_id: number
  duration_ms: number
  start_time_session_ms: number
  type: 'DRIVEN' | 'OPTIMAL' | 'AVERAGE' | 'UNKNOWN'
  lap_descriptor: number
  min_speed_mps?: number
  max_speed_mps?: number
  avg_speed_mps?: number
  max_decel_mps2?: number
  max_accel_mps2?: number
  samples: Sample[]
}

export interface PerformanceData {
  device?: { unit_id: number; software_part_number: string; software_version: string }
  session_guid?: string
  mean_line_guid?: string
  start_time_utc_s?: number
  duration_s?: number
  utc_to_local_offset_s?: number
  best_three_seq_var?: number
  top_three_var?: number
  top_five_var?: number
  average_lap?: Lap
  driven_laps: Lap[]
}

export interface OptimalLap {
  session_guid?: string
  optimal_lap_video_guid?: string
  optimal_lap?: Lap
}

export interface MeanLineSegment {
  id: number
  type: number
  flag: number
  start_dist_m: number
  end_dist_m: number
}

export interface MeanLinePoint {
  dist: number
  lat: number
  lon: number
  f3?: number
  f4?: number
  f5?: number
  f6?: number
  f7?: number
  f8?: number
}

export interface MeanLine {
  device?: { unit_id: number; part_number: string }
  mean_line_guid?: string
  track_cartography_id?: number
  track_configuration_id?: number
  track_name?: string
  track_configuration_name?: string
  reverse?: boolean
  segments: MeanLineSegment[]
  points: MeanLinePoint[]
}

const LAP_TYPE_NAMES: Record<number, Lap['type']> = {
  0: 'DRIVEN',
  1: 'OPTIMAL',
  2: 'AVERAGE',
  3: 'UNKNOWN',
}

const SAMPLE_FLOAT_FIELDS: Array<[number, keyof Sample]> = [
  [4, 'gnss_speed_mps'],
  [5, 'gnss_heading_deg'],
  [6, 'gnss_heading_deriv_dps'],
  [7, 'gnss_accuracy_m'],
  [8, 'gnss_altitude_m'],
  [9, 'accel_x_mps2'],
  [10, 'accel_y_mps2'],
  [11, 'accel_z_mps2'],
  [12, 'gyro_roll_dps'],
  [13, 'gyro_pitch_dps'],
  [14, 'gyro_yaw_dps'],
  [15, 'lateral_position'],
]

function decodePosition(buf: Uint8Array | undefined): Position | null {
  if (!buf) return null
  const m = parse(buf)
  const lat = m.get(1)?.[0]
  const lon = m.get(2)?.[0]
  if (lat === undefined || lon === undefined) return null
  return { lat: asF64(lat), lon: asF64(lon) }
}

function decodeSample(buf: Uint8Array): Sample {
  const m = parse(buf)
  const distRaw = getOne(m, 1, 0n)
  const distance_m = asF32(distRaw)
  const time_ms = asI32(getOne(m, 2))
  const posBuf = getOne(m, 3) as Uint8Array | undefined
  const sample: Sample = {
    distance_m,
    time_ms,
    position: posBuf instanceof Uint8Array ? decodePosition(posBuf) : null,
  }
  for (const [fn, name] of SAMPLE_FLOAT_FIELDS) {
    const v = m.get(fn)?.[0]
    if (v === undefined) continue
    // Sample telemetry fields are stored as FIXED32 → reinterpret as float.
    ;(sample as any)[name] = asF32(v)
  }
  return sample
}

export function decodeLap(buf: Uint8Array): Lap {
  const m = parse(buf)
  const lapTypeRaw = asI32(getOne(m, 4, 0n))
  const lap: Lap = {
    _lap_seq_id: asI32(getOne(m, 1)),
    duration_ms: asI32(getOne(m, 2)),
    start_time_session_ms: asI32(getOne(m, 3)),
    type: LAP_TYPE_NAMES[lapTypeRaw] ?? 'UNKNOWN',
    lap_descriptor: asI32(getOne(m, 5)),
    samples: [],
  }
  for (const [fn, name] of [
    [6, 'min_speed_mps'],
    [7, 'max_speed_mps'],
    [8, 'avg_speed_mps'],
    [9, 'max_decel_mps2'],
    [10, 'max_accel_mps2'],
  ] as const) {
    const v = m.get(fn)?.[0]
    if (v !== undefined) (lap as any)[name] = asF32(v)
  }
  const sampleBufs = getAll(m, 11)
  lap.samples = sampleBufs.flatMap(b => (b instanceof Uint8Array ? [decodeSample(b)] : []))
  return lap
}

export function decodePerformance(buf: Uint8Array): PerformanceData {
  const m = parse(buf)
  const out: PerformanceData = { driven_laps: [] }

  const diB = getOne(m, 2)
  if (diB instanceof Uint8Array) {
    const di = parse(diB)
    out.device = {
      unit_id: asI32(getOne(di, 1)),
      software_part_number: asStr(getOne(di, 2)),
      software_version: asStr(getOne(di, 3)),
    }
  }
  const s3 = getOne(m, 3)
  if (s3 instanceof Uint8Array) out.session_guid = asStr(getOne(parse(s3), 1))
  const s4 = getOne(m, 4)
  if (s4 instanceof Uint8Array) out.mean_line_guid = asStr(getOne(parse(s4), 1))

  for (const [fn, name] of [
    [5, 'start_time_utc_s'],
    [6, 'duration_s'],
    [7, 'utc_to_local_offset_s'],
  ] as const) {
    const v = m.get(fn)?.[0]
    if (v !== undefined) (out as any)[name] = asI32(v)
  }
  for (const [fn, name] of [
    [8, 'best_three_seq_var'],
    [9, 'top_three_var'],
    [10, 'top_five_var'],
  ] as const) {
    const v = m.get(fn)?.[0]
    if (v !== undefined) (out as any)[name] = asF32(v)
  }

  const avgB = getOne(m, 11)
  if (avgB instanceof Uint8Array) out.average_lap = decodeLap(avgB)

  out.driven_laps = getAll(m, 12).flatMap(b => (b instanceof Uint8Array ? [decodeLap(b)] : []))
  return out
}

export function decodeOptimalLap(buf: Uint8Array): OptimalLap {
  const m = parse(buf)
  const out: OptimalLap = {}
  const s2 = getOne(m, 2)
  if (s2 instanceof Uint8Array) out.session_guid = asStr(getOne(parse(s2), 1))
  const s3 = getOne(m, 3)
  if (s3 instanceof Uint8Array) out.optimal_lap_video_guid = asStr(getOne(parse(s3), 1))
  const s4 = getOne(m, 4)
  if (s4 instanceof Uint8Array) out.optimal_lap = decodeLap(s4)
  return out
}

export function decodeMeanLine(buf: Uint8Array): MeanLine {
  const m = parse(buf)
  const out: MeanLine = { segments: [], points: [] }

  const diB = getOne(m, 2)
  if (diB instanceof Uint8Array) {
    const di = parse(diB)
    out.device = {
      unit_id: asI32(getOne(di, 1)),
      part_number: asStr(getOne(di, 2)),
    }
  }
  const s3 = getOne(m, 3)
  if (s3 instanceof Uint8Array) out.mean_line_guid = asStr(getOne(parse(s3), 1))

  const s4 = getOne(m, 4)
  if (s4 instanceof Uint8Array) {
    const cfg = parse(s4)
    out.track_cartography_id = asI32(getOne(cfg, 1))
    out.track_configuration_id = asI32(getOne(cfg, 2))
    out.track_name = asStr(getOne(cfg, 3))
    out.track_configuration_name = asStr(getOne(cfg, 4))
    out.reverse = !!asI32(getOne(cfg, 5, 0n))
  }

  const segmentsRaw = getOne(m, 7)
  if (segmentsRaw instanceof Uint8Array) {
    const segMsg = parse(segmentsRaw)
    for (const raw of getAll(segMsg, 1)) {
      if (!(raw instanceof Uint8Array)) continue
      const sm = parse(raw)
      out.segments.push({
        id: asI32(getOne(sm, 1)),
        type: asI32(getOne(sm, 2)),
        flag: asI32(getOne(sm, 3)),
        start_dist_m: asI32(getOne(sm, 4)),
        end_dist_m: asI32(getOne(sm, 5)),
      })
    }
  }

  for (const raw of getAll(m, 8)) {
    if (!(raw instanceof Uint8Array)) continue
    const pm = parse(raw)
    const cumDist = asF32(getOne(pm, 1, 0n))
    const pos = decodePosition(getOne(pm, 2) as Uint8Array | undefined)
    if (!pos) continue
    const pt: MeanLinePoint = { dist: cumDist, lat: pos.lat, lon: pos.lon }
    for (let fn = 3; fn < 9; fn++) {
      const v = pm.get(fn)?.[0]
      if (v !== undefined) (pt as any)[`f${fn}`] = asF32(v)
    }
    out.points.push(pt)
  }
  return out
}
