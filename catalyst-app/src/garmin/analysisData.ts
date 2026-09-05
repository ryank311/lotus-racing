// Build chart-ready data for the Analysis page.
// Port of garmin/html_report.py's data fetchers — keeps the raw arrays
// (distance, speed, G, lat/lon, segment splits, corner stats) so the renderer
// can lay them out and theme them however it wants.

import fs from 'node:fs'
import path from 'node:path'
import { DuckDBConnection } from '@duckdb/node-api'
import { openDb } from './loadToDb.js'
import { DB_PATH, TRACKS_DIR } from './paths.js'
import { loadTrackYaml, resolveTrackYamlPath, TrackCorner, TrackSegment } from './trackYaml.js'
import { buildTrackGeometry, projectLatLon, TrackGeometry } from './trackGeometry.js'
import { DEFAULT_UNIT_SYSTEM, speedFromMps, speedUnitLabel, type UnitSystem } from '../shared/units.js'

// Canonical m/s → the active display unit. Threaded from buildAnalysis so a unit
// toggle reflows the whole Analysis page on the next fetch.
type SpeedConv = (mps: number | null | undefined) => number | null
const G = (mps2: number | null | undefined): number | null =>
  mps2 == null ? null : mps2 / 9.81

export interface LapMeta {
  sg: string
  sgShort: string
  lapIdx: number
  durationMs: number
  sampleCount: number
  sessionStart: string
  isBest: boolean
}

export interface SpeedTrace extends LapMeta {
  dist: number[]
  speed_mph: number[]
}

export interface LateralTrace extends LapMeta {
  dist: number[]
  pos: number[]
}

export interface LongGTrace extends LapMeta {
  dist: number[]
  long_g: number[]
}

export interface TimeDeltaTrace extends LapMeta {
  dist: number[]
  delta_s: number[]
}

export interface CornerBrakingRow extends LapMeta {
  turn: string
  name: string
  apex_dist_m: number
  onset_dist_m: number
  release_dist_m: number
  peak_brake_g: number
}

export interface GGData {
  lat_g: number[]
  long_g: number[]
  speed_mph: number[]
  dist: number[]
  p95_g: number
  circle: { x: number[]; y: number[] }
}

export interface TrackMapData {
  dist: number[]
  lat: number[]
  lon: number[]
  speed_mph: number[]
}

// One lap projected into track-local meters for the SVG track map.
export interface RacingLineLap extends LapMeta {
  x: number[]            // east, metres from projection origin
  y: number[]            // north, metres from projection origin
  dist: number[]         // cumulative metres along the lap
  speed_mph: number[]
  long_g: number[]
  lat_g: number[]
  // Exact raw telemetry sample where minimum speed occurred in each named
  // corner. These are intentionally not snapped to the 5 m racing-line trace.
  cornerVMins: CornerVMinPoint[]
}

export interface CornerVMinPoint {
  turn: string
  name: string
  dist: number
  x: number
  y: number
  speed_mph: number
}

// Lightweight, transport-friendly subset of TrackGeometry — we drop the
// `projection` (renderer doesn't need it; lap samples are pre-projected)
// and keep only the polylines + sector marks the SVG needs.
export interface TrackGeometryPayload {
  meanLineGuid: string
  trackName: string
  configName: string
  totalDistM: number
  widthM: number
  bbox: { minX: number; maxX: number; minY: number; maxY: number }
  centerline: { x: number; y: number; dist: number; lat: number; lon: number }[]
  leftEdge: { x: number; y: number }[]
  rightEdge: { x: number; y: number }[]
  sectorMarks: { distM: number; type: 'start' | 'end' }[]
}

export interface HeatmapData {
  z: (number | null)[][]
  text: string[][]
  cols: string[]
  rows: string[]
  zmax: number
}

export interface CornerRow {
  sg: string
  lapIdx: number
  turn: string
  name: string
  lapLbl: string
  isBest: boolean
  entry_mph: number
  apex_mph: number
  vmin_dist_m: number
  exit_mph: number
  max_lat_g: number
}

export interface CoachLinePoint {
  dist: number
  x: number
  y: number
}

export interface AnalysisData {
  config: string
  totalDistM: number
  segments: TrackSegment[]
  corners: TrackCorner[]
  sessions: Array<{
    sg: string; start: string | null; bestLapMs: number | null; trackConfig: string | null
    // Per-session weather snapshot (captured at session start). Used by the
    // Analysis CONDITIONS panel to correlate pace with conditions.
    weather: string | null; tempC: number | null; humidityPct: number | null
    windMps: number | null; windDeg: number | null
  }>
  laps: LapMeta[]
  bestLap: LapMeta | null
  speedTraces: SpeedTrace[]
  lateralTraces: LateralTrace[]
  longgTraces: LongGTrace[]
  timeDeltaTraces: TimeDeltaTrace[]
  optimalTimeDeltaTraces: TimeDeltaTrace[]
  cornerBrakingRows: CornerBrakingRow[]
  gg: GGData
  trackMap: TrackMapData
  trackGeometry: TrackGeometryPayload | null
  racingLines: RacingLineLap[]
  heatmap: HeatmapData | null
  cornerRows: CornerRow[]
  // Theoretical best = sum of personal-best per segment (only when segments exist)
  theoreticalBestMs: number | null
  // Averages
  avgLapMs: number | null
  // Optimal racing line stitched from per-segment personal bests
  coachLine: CoachLinePoint[] | null
  // Display unit label for every speed field above ("mph" or "km/h").
  speedUnit: string
}

// ---------------------------------------------------------------------------

async function rows(con: DuckDBConnection, sql: string, params: unknown[] = []): Promise<any[]> {
  const reader = await con.runAndReadAll(sql, params as any)
  return reader.getRowsJson()
}

async function fetchLapMeta(con: DuckDBConnection, sgList: string[]): Promise<LapMeta[]> {
  if (!sgList.length) return []
  const placeholders = sgList.map(() => '?').join(',')
  const r = await rows(con, `
    SELECT l.session_guid, l.lap_index, l.duration_ms, l.sample_count,
           CAST(s.session_start AS VARCHAR) AS session_start
    FROM laps l
    JOIN sessions s ON s.session_guid = l.session_guid
    WHERE l.session_guid IN (${placeholders}) AND l.lap_type = 'DRIVEN'
    ORDER BY s.session_start DESC, l.lap_index
  `, sgList)
  const laps: LapMeta[] = r.map(row => ({
    sg: row[0],
    sgShort: String(row[0]).slice(0, 8),
    lapIdx: Number(row[1]),
    durationMs: Number(row[2] ?? 0),
    sampleCount: Number(row[3] ?? 0),
    sessionStart: String(row[4] ?? ''),
    isBest: false,
  }))
  if (laps.length) {
    let best = laps[0]
    for (const L of laps) if (L.durationMs && (!best.durationMs || L.durationMs < best.durationMs)) best = L
    best.isBest = true
  }
  return laps
}

async function fetchSpeedTraces(con: DuckDBConnection, laps: LapMeta[], conv: SpeedConv, strideM = 25): Promise<SpeedTrace[]> {
  const out: SpeedTrace[] = []
  for (const lap of laps) {
    const r = await rows(con, `
      SELECT distance_m, gnss_speed_mps
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m % ? = 0
        AND gnss_speed_mps IS NOT NULL
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, strideM])
    if (!r.length) continue
    out.push({
      ...lap,
      dist: r.map(x => Number(x[0])),
      speed_mph: r.map(x => conv(Number(x[1])) ?? 0),
    })
  }
  return out
}

async function fetchLateralTraces(con: DuckDBConnection, laps: LapMeta[], strideM = 25): Promise<LateralTrace[]> {
  const out: LateralTrace[] = []
  for (const lap of laps) {
    const r = await rows(con, `
      SELECT distance_m, lateral_position
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m % ? = 0
        AND lateral_position IS NOT NULL
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, strideM])
    if (!r.length) continue
    out.push({
      ...lap,
      dist: r.map(x => Number(x[0])),
      pos: r.map(x => Number(x[1])),
    })
  }
  return out
}

async function fetchLongGTraces(con: DuckDBConnection, laps: LapMeta[], strideM = 25): Promise<LongGTrace[]> {
  const out: LongGTrace[] = []
  for (const lap of laps) {
    const r = await rows(con, `
      SELECT distance_m, accel_x_mps2
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m % ? = 0
        AND accel_x_mps2 IS NOT NULL
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, strideM])
    if (!r.length) continue
    out.push({
      ...lap,
      dist: r.map(x => Number(x[0])),
      long_g: r.map(x => G(Number(x[1])) ?? 0),
    })
  }
  return out
}

function interpolateAt(xs: number[], ys: number[], target: number): number | null {
  if (!xs.length || target < xs[0] || target > xs[xs.length - 1]) return null
  let lo = 0, hi = xs.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1
    if (xs[mid] <= target) lo = mid
    else hi = mid
  }
  if (lo === hi || xs[hi] === xs[lo]) return ys[lo]
  const t = (target - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + (ys[hi] - ys[lo]) * t
}

// Elapsed-time difference at the same distance versus the overall fastest lap.
// Negative means the lap is ahead/faster; positive means it has lost time.
async function fetchTimeDeltaTraces(
  con: DuckDBConnection,
  laps: LapMeta[],
  best: LapMeta,
  segments: TrackSegment[],
  totalDistM: number,
  strideM = 25,
): Promise<{ fastest: TimeDeltaTrace[]; optimal: TimeDeltaTrace[] }> {
  const raw = new Map<string, { dist: number[]; elapsedMs: number[] }>()
  for (const lap of laps) {
    const r = await rows(con, `
      SELECT distance_m, time_ms
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m % ? = 0 AND time_ms IS NOT NULL
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, strideM])
    if (!r.length) continue
    const firstMs = Number(r[0][1])
    raw.set(`${lap.sg}:${lap.lapIdx}`, {
      dist: r.map(x => Number(x[0])),
      elapsedMs: r.map(x => Number(x[1]) - firstMs),
    })
  }

  const reference = raw.get(`${best.sg}:${best.lapIdx}`)
  if (!reference) return { fastest: [], optimal: [] }
  const out: TimeDeltaTrace[] = []
  for (const lap of laps) {
    const trace = raw.get(`${lap.sg}:${lap.lapIdx}`)
    if (!trace) continue
    const dist: number[] = []
    const delta_s: number[] = []
    for (let i = 0; i < trace.dist.length; i++) {
      const refMs = interpolateAt(reference.dist, reference.elapsedMs, trace.dist[i])
      if (refMs == null) continue
      dist.push(trace.dist[i])
      delta_s.push((trace.elapsedMs[i] - refMs) / 1000)
    }
    if (totalDistM > 0 && lap.durationMs > 0 && best.durationMs > 0) {
      const finishDelta = (lap.durationMs - best.durationMs) / 1000
      if (dist.length && dist[dist.length - 1] === totalDistM) delta_s[delta_s.length - 1] = finishDelta
      else {
        dist.push(totalDistM)
        delta_s.push(finishDelta)
      }
    }
    out.push({ ...lap, dist, delta_s })
  }
  // Build a continuous attainable reference by using the quickest observed
  // elapsed-time slice for each configured segment.
  const pieces: Array<{
    start: number
    end: number
    trace: { dist: number[]; elapsedMs: number[] }
    traceStartMs: number
    gainBeforeMs: number
    gainMs: number
  }> = []
  let cumulativeGainMs = 0
  for (const segment of [...segments].sort((a, b) => a.start_dist_m - b.start_dist_m)) {
    const referenceStartMs = interpolateAt(reference.dist, reference.elapsedMs, segment.start_dist_m)
    const referenceEndMs = interpolateAt(reference.dist, reference.elapsedMs, segment.end_dist_m)
    if (referenceStartMs == null || referenceEndMs == null) continue
    const referenceDurationMs = referenceEndMs - referenceStartMs
    let winner: { trace: { dist: number[]; elapsedMs: number[] }; startMs: number; durationMs: number } | null = null
    for (const trace of raw.values()) {
      const startMs = interpolateAt(trace.dist, trace.elapsedMs, segment.start_dist_m)
      const endMs = interpolateAt(trace.dist, trace.elapsedMs, segment.end_dist_m)
      if (startMs == null || endMs == null || endMs <= startMs) continue
      const durationMs = endMs - startMs
      if (!winner || durationMs < winner.durationMs) winner = { trace, startMs, durationMs }
    }
    if (!winner) continue
    const gainMs = Math.max(0, referenceDurationMs - winner.durationMs)
    pieces.push({
      start: segment.start_dist_m,
      end: segment.end_dist_m,
      trace: winner.trace,
      traceStartMs: winner.startMs,
      gainBeforeMs: cumulativeGainMs,
      gainMs,
    })
    cumulativeGainMs += gainMs
  }

  const optimalAt = (distance: number): number | null => {
    const piece = pieces.find(item => distance >= item.start && distance <= item.end)
    if (piece) {
      const elapsed = interpolateAt(piece.trace.dist, piece.trace.elapsedMs, distance)
      const referenceStartMs = interpolateAt(reference.dist, reference.elapsedMs, piece.start)
      return elapsed == null || referenceStartMs == null
        ? null
        : referenceStartMs - piece.gainBeforeMs + elapsed - piece.traceStartMs
    }
    const referenceMs = interpolateAt(reference.dist, reference.elapsedMs, distance)
    if (referenceMs == null) return null
    const completedGainMs = pieces
      .filter(item => item.end < distance)
      .reduce((sum, item) => sum + item.gainMs, 0)
    return referenceMs - completedGainMs
  }
  const optimalDurationMs = best.durationMs - cumulativeGainMs
  const optimal: TimeDeltaTrace[] = []
  if (pieces.length) {
    for (const lap of laps) {
      const trace = raw.get(`${lap.sg}:${lap.lapIdx}`)
      if (!trace) continue
      const dist: number[] = [], delta_s: number[] = []
      for (let i = 0; i < trace.dist.length; i++) {
        const optimalMs = optimalAt(trace.dist[i])
        if (optimalMs == null) continue
        dist.push(trace.dist[i])
        delta_s.push((trace.elapsedMs[i] - optimalMs) / 1000)
      }
      if (totalDistM > 0 && lap.durationMs > 0 && optimalDurationMs > 0) {
        const finishDelta = (lap.durationMs - optimalDurationMs) / 1000
        if (dist.length && dist[dist.length - 1] === totalDistM) delta_s[delta_s.length - 1] = finishDelta
        else { dist.push(totalDistM); delta_s.push(finishDelta) }
      }
      optimal.push({ ...lap, dist, delta_s })
    }
  }
  return { fastest: out, optimal }
}

async function fetchGGData(con: DuckDBConnection, laps: LapMeta[], conv: SpeedConv, nBest = 12, everyNth = 4): Promise<GGData> {
  const sorted = [...laps].filter(L => L.durationMs).sort((a, b) => a.durationMs - b.durationMs).slice(0, nBest)
  const lat_g: number[] = []
  const long_g: number[] = []
  const speed_mph: number[] = []
  const dist: number[] = []
  for (const lap of sorted) {
    const r = await rows(con, `
      SELECT accel_y_mps2, accel_x_mps2, gnss_speed_mps, distance_m
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND accel_x_mps2 IS NOT NULL AND accel_y_mps2 IS NOT NULL
        AND distance_m % ? = 0
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, everyNth])
    for (const row of r) {
      lat_g.push(G(Number(row[0]))!)
      long_g.push(G(Number(row[1]))!)
      speed_mph.push(conv(Number(row[2])) ?? 0)
      dist.push(Number(row[3]))
    }
  }
  // 95th percentile of total G magnitude — reference circle radius
  const mags = lat_g.map((x, i) => Math.hypot(x, long_g[i])).sort((a, b) => a - b)
  const p95 = mags.length ? mags[Math.floor(0.95 * mags.length)] : 1.5
  const theta = Array.from({ length: 121 }, (_, i) => (i * Math.PI) / 60)
  const circle = {
    x: theta.map(t => p95 * Math.cos(t)),
    y: theta.map(t => p95 * Math.sin(t)),
  }
  return { lat_g, long_g, speed_mph, dist, p95_g: Math.round(p95 * 100) / 100, circle }
}

async function fetchRacingLines(
  con: DuckDBConnection,
  laps: LapMeta[],
  geom: TrackGeometry,
  conv: SpeedConv,
  corners: TrackCorner[],
  strideM = 5,
): Promise<RacingLineLap[]> {
  const out: RacingLineLap[] = []
  for (const lap of laps) {
    const r = await rows(con, `
      SELECT distance_m, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m % ? = 0
        AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, strideM])
    if (!r.length) continue
    const xs: number[] = [], ys: number[] = [], ds: number[] = []
    const speeds: number[] = [], lg: number[] = [], yg: number[] = []
    for (const row of r) {
      const pos = projectLatLon(Number(row[1]), Number(row[2]), geom.projection)
      xs.push(pos.x); ys.push(pos.y); ds.push(Number(row[0]))
      speeds.push(conv(Number(row[3])) ?? 0)
      lg.push(G(Number(row[4])) ?? 0)
      yg.push(G(Number(row[5])) ?? 0)
    }
    const cornerVMins: CornerVMinPoint[] = []
    const validCorners = corners.filter(c => c.dist_idx_start != null && c.dist_idx_end != null)
    if (validCorners.length) {
      const zoneSql = validCorners.map(() => '(distance_m BETWEEN ? AND ?)').join(' OR ')
      const zoneParams = validCorners.flatMap(c => [c.dist_idx_start, c.dist_idx_end])
      const cornerSamples = await rows(con, `
        SELECT distance_m, lat, lon, gnss_speed_mps
        FROM samples
        WHERE session_guid = ? AND lap_index = ?
          AND lat IS NOT NULL AND lon IS NOT NULL AND gnss_speed_mps IS NOT NULL
          AND (${zoneSql})
        ORDER BY distance_m
      `, [lap.sg, lap.lapIdx, ...zoneParams])

      for (const corner of validCorners) {
        let minimum: any[] | null = null
        for (const sample of cornerSamples) {
          const dist = Number(sample[0])
          if (dist < corner.dist_idx_start || dist > corner.dist_idx_end) continue
          if (!minimum || Number(sample[3]) < Number(minimum[3])) minimum = sample
        }
        if (!minimum) continue
        const pos = projectLatLon(Number(minimum[1]), Number(minimum[2]), geom.projection)
        cornerVMins.push({
          turn: corner.turn,
          name: corner.name ?? '',
          dist: Number(minimum[0]),
          x: pos.x,
          y: pos.y,
          speed_mph: conv(Number(minimum[3])) ?? 0,
        })
      }
    }
    out.push({ ...lap, x: xs, y: ys, dist: ds, speed_mph: speeds, long_g: lg, lat_g: yg, cornerVMins })
  }
  return out
}

async function fetchTrackMap(con: DuckDBConnection, best: LapMeta, conv: SpeedConv, strideM = 10): Promise<TrackMapData> {
  const r = await rows(con, `
    SELECT distance_m, lat, lon, gnss_speed_mps
    FROM samples
    WHERE session_guid = ? AND lap_index = ?
      AND distance_m % ? = 0
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY distance_m
  `, [best.sg, best.lapIdx, strideM])
  return {
    dist: r.map(x => Number(x[0])),
    lat: r.map(x => Number(x[1])),
    lon: r.map(x => Number(x[2])),
    speed_mph: r.map(x => conv(Number(x[3])) ?? 0),
  }
}

async function computeSplits(con: DuckDBConnection, sg: string, segments: TrackSegment[]): Promise<Map<number, Array<number | null>>> {
  const lapDur = new Map<number, number>()
  for (const row of await rows(con, 'SELECT lap_index, duration_ms FROM laps WHERE session_guid = ?', [sg])) {
    lapDur.set(Number(row[0]), Number(row[1] ?? 0))
  }
  const sampleRows = await rows(con, `
    SELECT lap_index, distance_m, gnss_speed_mps FROM samples
    WHERE session_guid = ? AND gnss_speed_mps IS NOT NULL AND gnss_speed_mps > 0
    ORDER BY lap_index, distance_m
  `, [sg])
  const byLap = new Map<number, Array<[number, number]>>()
  for (const r of sampleRows) {
    const li = Number(r[0])
    if (!byLap.has(li)) byLap.set(li, [])
    byLap.get(li)!.push([Number(r[1]), Number(r[2])])
  }
  const out = new Map<number, Array<number | null>>()
  for (const [li, samples] of byLap) {
    const durMs = lapDur.get(li) ?? 0
    if (!durMs || !samples.length) {
      out.set(li, new Array(segments.length).fill(null))
      continue
    }
    let totalW = 0
    for (const [, sp] of samples) totalW += 1 / sp
    const scale = durMs / 1000 / totalW
    const segTimes: Array<number | null> = new Array(segments.length).fill(0)
    for (const [d, sp] of samples) {
      const w = 1 / sp
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        if (d >= seg.start_dist_m && d < seg.end_dist_m) {
          ;(segTimes[i] as number) += w * scale
          break
        }
      }
    }
    out.set(li, segTimes)
  }
  return out
}

function msToLap(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—'
  const s = ms / 1000
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`
}

// Stitch together the optimal racing line from per-segment personal-best laps.
// For each Garmin segment, finds which of the top racing-line laps had the
// fastest split, then takes that lap's XY trace through that segment. The
// result is a dense polyline in track-local metres at ~5 m spacing.
async function computeCoachLine(
  con: DuckDBConnection,
  racingLines: RacingLineLap[],
  segments: TrackSegment[],
): Promise<CoachLinePoint[] | null> {
  if (!racingLines.length || !segments.length) return null

  // Compute splits for each unique session in the racing line set.
  const splitsCache = new Map<string, Map<number, Array<number | null>>>()
  for (const lap of racingLines) {
    if (!splitsCache.has(lap.sg)) {
      splitsCache.set(lap.sg, await computeSplits(con, lap.sg, segments))
    }
  }

  // For each segment pick the racing-line lap with the best split time.
  const bestLapForSeg: RacingLineLap[] = segments.map((_, si) => {
    let best = racingLines[0]
    let bestTime = Infinity
    for (const lap of racingLines) {
      const t = splitsCache.get(lap.sg)?.get(lap.lapIdx)?.[si]
      if (t != null && t < bestTime) { bestTime = t; best = lap }
    }
    return best
  })

  // Stitch XY points from each segment's best lap. Apply a ±30 m linear
  // blend at each segment boundary to suppress discontinuities where the
  // best lap changes.
  const BLEND_M = 30
  const result: CoachLinePoint[] = []

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    const lap = bestLapForSeg[si]
    const nextLap = si + 1 < segments.length ? bestLapForSeg[si + 1] : null

    for (let i = 0; i < lap.dist.length; i++) {
      const d = lap.dist[i]
      if (d < seg.start_dist_m || d >= seg.end_dist_m) continue

      let x = lap.x[i]
      let y = lap.y[i]

      // Blend toward the next segment's lap near the boundary.
      if (nextLap && nextLap !== lap) {
        const distToEnd = seg.end_dist_m - d
        if (distToEnd < BLEND_M) {
          // Find the nearest point in nextLap at this distance.
          let ni = 0, nearD = Infinity
          for (let j = 0; j < nextLap.dist.length; j++) {
            const dd = Math.abs(nextLap.dist[j] - d)
            if (dd < nearD) { nearD = dd; ni = j }
          }
          const t = 1 - distToEnd / BLEND_M
          x = x + (nextLap.x[ni] - x) * t
          y = y + (nextLap.y[ni] - y) * t
        }
      }

      result.push({ dist: d, x, y })
    }
  }

  return result.length ? result : null
}

async function buildHeatmap(con: DuckDBConnection, laps: LapMeta[], segments: TrackSegment[]): Promise<HeatmapData | null> {
  if (!segments.length || !laps.length) return null
  const pb: number[] = new Array(segments.length).fill(Infinity)
  type Row = { label: string; row: Array<number | null> }
  const allSplits: Row[] = []

  // Cache splits per session
  const cache = new Map<string, Map<number, Array<number | null>>>()
  for (const lap of laps) {
    if (!cache.has(lap.sg)) cache.set(lap.sg, await computeSplits(con, lap.sg, segments))
    const splits = cache.get(lap.sg)!.get(lap.lapIdx) ?? new Array(segments.length).fill(null)
    const label = `L${lap.lapIdx + 1}  ${msToLap(lap.durationMs)}`
    allSplits.push({ label, row: splits })
    for (let i = 0; i < splits.length; i++) {
      const v = splits[i]
      if (v != null && v < pb[i]) pb[i] = v
    }
  }

  const z: Array<Array<number | null>> = []
  const text: string[][] = []
  const yLabels: string[] = []
  for (const { label, row } of allSplits) {
    const zRow: Array<number | null> = []
    const tRow: string[] = []
    for (let i = 0; i < row.length; i++) {
      const v = row[i]
      if (v == null || pb[i] === Infinity) {
        zRow.push(null); tRow.push('—')
      } else {
        const delta = v - pb[i]
        zRow.push(Math.round(delta * 1000) / 1000)
        tRow.push(`${v.toFixed(2)} (+${delta.toFixed(2)})`)
      }
    }
    z.push(zRow); text.push(tRow); yLabels.push(label)
  }
  // Append theoretical-best row
  z.push(pb.map(p => (p === Infinity ? null : 0)))
  text.push(pb.map(p => (p === Infinity ? '—' : `${p.toFixed(2)} PB`)))
  yLabels.push('★ Theoretical best')

  const flat = z.flat().filter((v): v is number => v != null)
  const zmax = flat.length ? Math.max(...flat, 0.1) : 5

  return {
    z, text,
    cols: segments.map(s => `S${s.id}`),
    rows: yLabels,
    zmax,
  }
}

async function fetchCornerRows(con: DuckDBConnection, laps: LapMeta[], corners: TrackCorner[], conv: SpeedConv): Promise<CornerRow[]> {
  if (!corners.length) return []
  const out: CornerRow[] = []
  for (const lap of laps) {
    for (const c of corners) {
      const lo = c.dist_idx_start, hi = c.dist_idx_end
      if (lo == null || hi == null) continue
      const r = await rows(con, `
        SELECT distance_m, gnss_speed_mps, accel_y_mps2
        FROM samples
        WHERE session_guid = ? AND lap_index = ?
          AND distance_m BETWEEN ? AND ?
          AND gnss_speed_mps IS NOT NULL
        ORDER BY distance_m
      `, [lap.sg, lap.lapIdx, lo, hi])
      if (r.length < 3) continue
      const speeds = r.map(x => Number(x[1]))
      const nEdge = Math.min(5, Math.max(1, Math.floor(speeds.length / 8)))
      const entry = speeds.slice(0, nEdge).reduce((a, b) => a + b, 0) / nEdge
      const exit = speeds.slice(-nEdge).reduce((a, b) => a + b, 0) / nEdge
      const apex = Math.min(...speeds)
      const vminIdx = speeds.indexOf(apex)
      const maxLat = Math.max(...r.map(x => Math.abs(G(Number(x[2])) ?? 0)))
      out.push({
        sg: lap.sg,
        lapIdx: lap.lapIdx,
        turn: c.turn,
        name: c.name,
        lapLbl: `${lap.sgShort}… L${lap.lapIdx + 1}`,
        isBest: lap.isBest,
        entry_mph: conv(entry)!,
        apex_mph: conv(apex)!,
        vmin_dist_m: Number(r[vminIdx][0]),
        exit_mph: conv(exit)!,
        max_lat_g: maxLat,
      })
    }
  }
  return out
}

// Derive the brake episode feeding each corner from lightly smoothed raw
// longitudinal acceleration. Onset/release use a -0.08 g threshold; the
// episode must contain at least -0.18 g so coast-only corners are omitted.
async function fetchCornerBrakingRows(
  con: DuckDBConnection,
  laps: LapMeta[],
  corners: TrackCorner[],
): Promise<CornerBrakingRow[]> {
  if (!corners.length) return []
  const out: CornerBrakingRow[] = []
  for (const lap of laps) {
    const raw = await rows(con, `
      SELECT distance_m, accel_x_mps2
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m IS NOT NULL AND accel_x_mps2 IS NOT NULL
      ORDER BY distance_m, time_ms
    `, [lap.sg, lap.lapIdx])
    if (raw.length < 5) continue
    const dist = raw.map(row => Number(row[0]))
    const gs = raw.map(row => G(Number(row[1])) ?? 0)
    const smooth = gs.map((_, i) => {
      const lo = Math.max(0, i - 2), hi = Math.min(gs.length - 1, i + 2)
      let sum = 0
      for (let j = lo; j <= hi; j++) sum += gs[j]
      return sum / (hi - lo + 1)
    })

    for (const corner of corners) {
      const apex = corner.apex_idx
      if (!Number.isFinite(apex)) continue
      const loDist = Math.max(0, corner.dist_idx_start - 450)
      const hiDist = corner.dist_idx_end + 150
      let peakIdx = -1
      // The last meaningful braking peak before/near apex is the episode that
      // feeds this corner, avoiding an earlier corner in an overlapping window.
      for (let i = 0; i < dist.length && dist[i] <= apex + 30; i++) {
        if (dist[i] < loDist || smooth[i] > -0.18) continue
        if (peakIdx < 0 || dist[i] > dist[peakIdx] + 35 || smooth[i] < smooth[peakIdx]) peakIdx = i
      }
      if (peakIdx < 0) continue

      let onsetIdx = peakIdx
      while (onsetIdx > 0 && dist[onsetIdx - 1] >= loDist && smooth[onsetIdx - 1] <= -0.08) onsetIdx--

      let releaseIdx = peakIdx
      let clearCount = 0
      for (let i = peakIdx + 1; i < dist.length && dist[i] <= hiDist; i++) {
        if (smooth[i] > -0.08) clearCount++
        else clearCount = 0
        if (clearCount >= 3) { releaseIdx = i - 2; break }
        releaseIdx = i
      }
      if (releaseIdx <= onsetIdx) continue
      out.push({
        ...lap,
        turn: corner.turn,
        name: corner.name ?? '',
        apex_dist_m: apex,
        onset_dist_m: dist[onsetIdx],
        release_dist_m: dist[releaseIdx],
        peak_brake_g: Math.abs(smooth[peakIdx]),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------

export async function buildAnalysis(
  sessionGuids: string[],
  system: UnitSystem = DEFAULT_UNIT_SYSTEM,
  lapLimit?: 3 | 5 | 10 | null,
): Promise<AnalysisData> {
  if (!fs.existsSync(DB_PATH)) throw new Error(`no database at ${DB_PATH} — run "Rebuild DB" first`)
  console.log(`[analysis] building for ${sessionGuids.length} session(s)`)
  const analysisDb = await openDb(DB_PATH)
  const con = analysisDb.con

  // Canonical m/s → the active display unit. All speed fields below carry this
  // unit; `speedUnit` labels it for the renderer.
  const toSpeed: SpeedConv = (mps) => mps == null ? null : speedFromMps(mps, system)
  const speedUnit = speedUnitLabel(system)

  const placeholders = sessionGuids.map(() => '?').join(',')
  const sessRows = await rows(con, `
    SELECT s.session_guid, CAST(s.session_start AS VARCHAR), s.best_lap_ms,
      tc.track_configuration_name, tc.track_configuration_id, s.mean_line_guid,
      s.weather_description, s.temperature_c, s.humidity_pct,
      s.wind_speed_mps, s.wind_direction_deg
    FROM sessions s
    LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    WHERE s.session_guid IN (${placeholders})
    ORDER BY s.session_start DESC
  `, sessionGuids)

  const sessions = sessRows.map(r => ({
    sg: String(r[0]),
    start: r[1] ? String(r[1]) : null,
    bestLapMs: r[2] != null ? Number(r[2]) : null,
    trackConfig: r[3] ? String(r[3]) : null,
    weather: r[6] != null ? String(r[6]) : null,
    tempC: r[7] != null ? Number(r[7]) : null,
    humidityPct: r[8] != null ? Number(r[8]) : null,
    windMps: r[9] != null ? Number(r[9]) : null,
    windDeg: r[10] != null ? Number(r[10]) : null,
  }))

  // Pick the mean_line_guid that the majority of selected sessions share.
  const meanLineGuids = sessRows.map(r => (r[5] != null ? String(r[5]) : null)).filter(Boolean) as string[]
  const mlgCounts = new Map<string, number>()
  for (const g of meanLineGuids) mlgCounts.set(g, (mlgCounts.get(g) ?? 0) + 1)
  const meanLineGuid = [...mlgCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // Use the most-common config to pick which track YAML to load.
  const configCounts = new Map<string, number>()
  for (const s of sessions) {
    if (!s.trackConfig) continue
    configCounts.set(s.trackConfig, (configCounts.get(s.trackConfig) ?? 0) + 1)
  }
  const config = [...configCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown'
  // Resolve via the shared resolver — finds the YAML by mean_line_guid first,
  // which matters because the Tracks editor writes the file using that key.
  // We don't have track_name on this query, so the resolver falls back on
  // config_name + guid alone (still reliable for VIR's 3 configs).
  const trackPath = resolveTrackYamlPath('', config, meanLineGuid).path
  const trackYaml = loadTrackYaml(trackPath)
  const segments = trackYaml.segments ?? []
  const corners = trackYaml.corners ?? []

  const allLaps = await fetchLapMeta(con, sessionGuids)
  const laps = lapLimit
    ? [...allLaps].filter(lap => lap.durationMs > 0).sort((a, b) => a.durationMs - b.durationMs).slice(0, lapLimit)
    : allLaps
  console.log(`[analysis] ${sessions.length} sessions, ${laps.length} laps, config="${config}"`)
  if (!laps.length) {
    await analysisDb.close()
    return {
      config, totalDistM: trackYaml.total_dist_m ?? 0,
      segments, corners, sessions, laps: [], bestLap: null,
      speedTraces: [], lateralTraces: [], longgTraces: [], timeDeltaTraces: [], optimalTimeDeltaTraces: [], cornerBrakingRows: [],
      gg: { lat_g: [], long_g: [], speed_mph: [], dist: [], p95_g: 0, circle: { x: [], y: [] } },
      trackMap: { dist: [], lat: [], lon: [], speed_mph: [] },
      trackGeometry: null, racingLines: [],
      heatmap: null, cornerRows: [],
      theoreticalBestMs: null, avgLapMs: null, coachLine: null,
      speedUnit,
    }
  }
  const bestLap = laps.find(L => L.isBest) ?? laps[0]

  // IMPORTANT: serialize. @duckdb/node-api crashes (SIGSEGV in
  // duckdb_destroy_result) when multiple prepared-statement Execute workers
  // overlap on the same connection — one frees its result while another is
  // still tearing down the optimizer state. Each fetcher already does many
  // sequential queries internally; running the seven of them serially keeps
  // total wall-clock fine (~couple of seconds for typical analysis sizes).
  const speedTraces = await fetchSpeedTraces(con, laps, toSpeed, 25)
  const lateralTraces = await fetchLateralTraces(con, laps, 25)
  const longgTraces = await fetchLongGTraces(con, laps, 25)
  const timeDeltas = await fetchTimeDeltaTraces(con, laps, bestLap, segments, trackYaml.total_dist_m ?? 0, 25)
  const timeDeltaTraces = timeDeltas.fastest
  const optimalTimeDeltaTraces = timeDeltas.optimal
  const cornerBrakingRows = await fetchCornerBrakingRows(con, laps, corners)
  const gg = await fetchGGData(con, laps, toSpeed)
  const trackMap = await fetchTrackMap(con, bestLap, toSpeed, 10)

  // Build the SVG-ready track geometry + projected racing lines for each lap.
  // Cap the lap count so we don't ship a megabyte of polylines to the renderer
  // for huge session sets; the SVG draws best-lap prominently and a handful
  // of the next fastest as faint comparison traces.
  let trackGeometry: TrackGeometryPayload | null = null
  let racingLines: RacingLineLap[] = []
  if (meanLineGuid) {
    const geom = buildTrackGeometry(meanLineGuid)
    if (geom) {
      trackGeometry = {
        meanLineGuid: geom.meanLineGuid,
        trackName: geom.trackName,
        configName: geom.configName,
        totalDistM: geom.totalDistM,
        widthM: geom.widthM,
        bbox: geom.bbox,
        centerline: geom.centerline.map(p => ({ x: p.x, y: p.y, dist: p.dist, lat: p.lat, lon: p.lon })),
        leftEdge: geom.leftEdge,
        rightEdge: geom.rightEdge,
        sectorMarks: geom.sectorMarks,
      }
      const top = [...laps]
        .filter(L => L.durationMs > 0)
        .sort((a, b) => a.durationMs - b.durationMs)
        .slice(0, 8)
      racingLines = await fetchRacingLines(con, top, geom, toSpeed, corners, 5)
    }
  }

  const heatmap = await buildHeatmap(con, laps, segments)
  const cornerRows = await fetchCornerRows(con, laps, corners, toSpeed)
  const coachLine = racingLines.length && segments.length
    ? await computeCoachLine(con, racingLines, segments)
    : null

  // Theoretical best = sum of segment personal bests
  let theoreticalBestMs: number | null = null
  if (heatmap) {
    const segPbs: number[] = []
    for (let col = 0; col < heatmap.cols.length; col++) {
      let minSplit = Infinity
      for (let r = 0; r < heatmap.z.length - 1; r++) {
        const z = heatmap.z[r][col]
        const t = heatmap.text[r][col]
        // The text holds the absolute time; parse it (e.g. "31.50 (+0.80)")
        const m = t.match(/^([\d.]+)/)
        if (m && z != null) {
          const v = parseFloat(m[1])
          if (v < minSplit) minSplit = v
        }
      }
      if (minSplit !== Infinity) segPbs.push(minSplit)
    }
    if (segPbs.length === heatmap.cols.length && segPbs.length) {
      theoreticalBestMs = Math.round(segPbs.reduce((a, b) => a + b, 0) * 1000)
    }
  }

  // Average lap (excluding outliers > 1.5× best)
  const durs = laps.map(L => L.durationMs).filter(d => d > 0)
  const avgLapMs = durs.length
    ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)
    : null

  await analysisDb.close()
  console.log(`[analysis] complete — ${racingLines.length} racing lines, theoretical best: ${theoreticalBestMs ? (theoreticalBestMs/1000).toFixed(3)+'s' : 'n/a'}`)
  return {
    config,
    totalDistM: trackYaml.total_dist_m ?? 0,
    segments, corners, sessions,
    laps, bestLap,
    speedTraces, lateralTraces, longgTraces, timeDeltaTraces, optimalTimeDeltaTraces, cornerBrakingRows,
    gg, trackMap, trackGeometry, racingLines, heatmap, cornerRows,
    theoreticalBestMs, avgLapMs, coachLine,
    speedUnit,
  }
}
