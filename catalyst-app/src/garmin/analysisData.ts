// Build chart-ready data for the Analysis page.
// Port of garmin/html_report.py's data fetchers — keeps the raw arrays
// (distance, speed, G, lat/lon, segment splits, corner stats) so the renderer
// can lay them out and theme them however it wants.

import fs from 'node:fs'
import { DuckDBConnection } from '@duckdb/node-api'
import { openDb } from './loadToDb.js'
import { DB_PATH } from './paths.js'
import { loadTrackYaml, resolveTrackYamlPath, TrackCorner, TrackSegment } from './trackYaml.js'
import { buildTrackGeometry, projectLatLon, TrackGeometry } from './trackGeometry.js'
import { DEFAULT_UNIT_SYSTEM, speedFromMps, speedUnitLabel, type UnitSystem } from '../shared/units.js'
import { cornerPhases, plausibleMin, segmentBounds, spanTimeMs, valueAt, type LapSeries, type SplitBound } from './lapPhases.js'
import { fetchLapSeries, fetchOptimalLapSeries, fetchOptimalLapTimes, fetchValidLaps, lapLabel, representativeKeys } from './lapData.js'
import { selectLaps, type LapFilter } from '../shared/coachingScope.js'

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
  // "May 24 16:15 · L3" — the one label every chart and the map use.
  label: string
  // Stable palette slot so a lap has the same colour on every chart and the map.
  colorIndex: number
  representative: boolean
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
  stages: number        // >1: brake–coast–re-brake
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

// Per lap and corner. "entry" is the speed where braking starts (or at the
// zone start when there is no braking); "exit" is 100 m after the minimum.
// Corners without a distinct minimum of their own are omitted.
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
  // Theoretical best = sum of plausible per-segment bests (splits tile the lap
  // and come from real timestamps; implausibly fast splits are ignored).
  theoreticalBestMs: number | null
  // Mean of representative laps (within 5% of their session best and 4% of
  // the fastest lap), so out-laps and cool-downs do not distort it.
  avgLapMs: number | null
  avgLapCount: number
  // Garmin's own optimal lap (fastest across the selected sessions) and the
  // time delta of each lap against it.
  garminOptimalMs: number | null
  garminOptimalTimeDeltaTraces: TimeDeltaTrace[]
  // Laps flagged invalid by Garmin or excluded on Session Review.
  excludedLapCount: number
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
  const valid = await fetchValidLaps(con, sgList)
  const counts = new Map((await rows(con, `
    SELECT session_guid, lap_index, sample_count FROM laps WHERE session_guid IN (${sgList.map(() => '?').join(',')})
  `, sgList)).map(r => [`${r[0]}:${r[1]}`, Number(r[2] ?? 0)]))
  const repKeys = representativeKeys(valid)
  const laps: LapMeta[] = valid.map((lap, i) => ({
    sg: lap.sg,
    sgShort: lap.sg.slice(0, 8),
    lapIdx: lap.lapIndex,
    durationMs: lap.durationMs,
    sampleCount: counts.get(`${lap.sg}:${lap.lapIndex}`) ?? 0,
    sessionStart: lap.sessionStart ?? '',
    isBest: false,
    label: lapLabel(lap.sessionStart, lap.lapIndex),
    colorIndex: i,
    representative: repKeys.has(`${lap.sg}:${lap.lapIndex}`),
  }))
  if (laps.length) laps.reduce((best, lap) => (lap.durationMs < best.durationMs ? lap : best)).isBest = true
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

// Long G from the calibrated lap series, so the chart shows what the braking
// detection measures (mounting misalignment removed).
function longGTraces(laps: LapMeta[], series: Map<string, LapSeries>, strideM = 25): LongGTrace[] {
  return laps.flatMap(lap => {
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    if (!trace) return []
    const dist: number[] = [], long_g: number[] = []
    trace.dist.forEach((d, i) => {
      if (d % strideM === 0 && Number.isFinite(trace.longG[i])) { dist.push(d); long_g.push(trace.longG[i]) }
    })
    return dist.length ? [{ ...lap, dist, long_g }] : []
  })
}

function deltaTrace(lap: LapMeta, trace: LapSeries, referenceAt: (d: number) => number | null, referenceMs: number, totalDistM: number, strideM: number): TimeDeltaTrace {
  const dist: number[] = [], delta_s: number[] = []
  for (let i = 0; i < trace.dist.length; i++) {
    const d = trace.dist[i]
    if (d % strideM !== 0 || !Number.isFinite(trace.timeMs[i])) continue
    const refMs = referenceAt(d)
    if (refMs == null) continue
    dist.push(d)
    delta_s.push((trace.timeMs[i] - refMs) / 1000)
  }
  if (totalDistM > 0 && lap.durationMs > 0 && referenceMs > 0) {
    const finishDelta = (lap.durationMs - referenceMs) / 1000
    if (dist.length && dist[dist.length - 1] === totalDistM) delta_s[delta_s.length - 1] = finishDelta
    else { dist.push(totalDistM); delta_s.push(finishDelta) }
  }
  return { ...lap, dist, delta_s }
}

// Elapsed-time difference at the same distance versus the fastest lap, the
// stitched optimal lap, and Garmin's optimal lap. Negative = ahead.
function buildTimeDeltaTraces(
  laps: LapMeta[],
  series: Map<string, LapSeries>,
  best: LapMeta,
  bounds: SplitBound[],
  winners: Array<string | null>,
  totalDistM: number,
  garminOptimal: { series: LapSeries; durationMs: number } | null,
  strideM = 25,
): { fastest: TimeDeltaTrace[]; optimal: TimeDeltaTrace[]; garmin: TimeDeltaTrace[] } {
  const reference = series.get(`${best.sg}:${best.lapIdx}`)
  if (!reference) return { fastest: [], optimal: [], garmin: [] }
  const at = (s: LapSeries) => (d: number) => valueAt(s, s.timeMs, d)
  const fastest = laps.flatMap(lap => {
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    return trace ? [deltaTrace(lap, trace, at(reference), best.durationMs, totalDistM, strideM)] : []
  })

  // The optimal lap stitches each split's plausible best: the same splits
  // that make up the theoretical best, so its finish equals that time.
  const pieces = bounds.map((b, i) => {
    const s = winners[i] ? series.get(winners[i]!) : null
    const start = s ? valueAt(s, s.timeMs, b.startM) : null
    return s && start != null ? { b, s, start } : null
  })
  let optimalMs = 0
  const offsets: number[] = []
  for (const piece of pieces) {
    offsets.push(optimalMs)
    const span = piece ? spanTimeMs(piece.s, piece.b.startM, piece.b.endM) : null
    if (span == null) { optimalMs = NaN; break }
    optimalMs += span
  }
  const optimalAt = (d: number): number | null => {
    const i = bounds.findIndex(b => d >= b.startM && d <= b.endM)
    const piece = i >= 0 ? pieces[i] : null
    if (!piece) return null
    const elapsed = valueAt(piece.s, piece.s.timeMs, d)
    return elapsed == null ? null : offsets[i] + elapsed - piece.start
  }
  const optimal = Number.isFinite(optimalMs) && bounds.length ? laps.flatMap(lap => {
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    return trace ? [deltaTrace(lap, trace, optimalAt, optimalMs, totalDistM, strideM)] : []
  }) : []

  const garmin = garminOptimal ? laps.flatMap(lap => {
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    return trace ? [deltaTrace(lap, trace, at(garminOptimal.series), garminOptimal.durationMs, totalDistM, strideM)] : []
  }) : []
  return { fastest, optimal, garmin }
}

function ggData(laps: LapMeta[], series: Map<string, LapSeries>, conv: SpeedConv, nBest = 12, everyNth = 4): GGData {
  const sorted = [...laps].filter(L => L.durationMs).sort((a, b) => a.durationMs - b.durationMs).slice(0, nBest)
  const lat_g: number[] = []
  const long_g: number[] = []
  const speed_mph: number[] = []
  const dist: number[] = []
  for (const lap of sorted) {
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    if (!trace) continue
    trace.dist.forEach((d, i) => {
      if (d % everyNth !== 0 || !Number.isFinite(trace.longG[i]) || !Number.isFinite(trace.latG[i])) return
      lat_g.push(trace.latG[i])
      long_g.push(trace.longG[i])
      speed_mph.push(conv(trace.speed[i]) ?? 0)
      dist.push(d)
    })
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
  series: Map<string, LapSeries>,
  totalM: number,
  strideM = 5,
): Promise<RacingLineLap[]> {
  const out: RacingLineLap[] = []
  for (const lap of laps) {
    const r = await rows(con, `
      SELECT distance_m, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx])
    if (!r.length) continue
    const xs: number[] = [], ys: number[] = [], ds: number[] = []
    const speeds: number[] = [], lg: number[] = [], yg: number[] = []
    const exact = new Map<number, { x: number; y: number }>()
    for (const row of r) {
      const d = Number(row[0])
      const pos = projectLatLon(Number(row[1]), Number(row[2]), geom.projection)
      exact.set(d, pos)
      if (d % strideM !== 0) continue
      xs.push(pos.x); ys.push(pos.y); ds.push(d)
      speeds.push(conv(Number(row[3])) ?? 0)
      lg.push(G(Number(row[4])) ?? 0)
      yg.push(G(Number(row[5])) ?? 0)
    }
    // The exact sample where each corner's own minimum speed happened.
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    const cornerVMins: CornerVMinPoint[] = []
    for (const phase of trace ? cornerPhases(trace, corners, totalM) : []) {
      if (phase.vminM == null || phase.vminMps == null) continue
      const pos = exact.get(phase.vminM)
      if (!pos) continue
      const corner = corners.find(c => c.turn === phase.turn)
      cornerVMins.push({ turn: phase.turn, name: corner?.name ?? '', dist: phase.vminM, x: pos.x, y: pos.y, speed_mph: conv(phase.vminMps) ?? 0 })
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

// Split times from real timestamps over the tiled segment bounds; they sum
// to the lap time.
function lapSplits(trace: LapSeries | undefined, bounds: SplitBound[]): Array<number | null> {
  return bounds.map(b => (trace ? spanTimeMs(trace, b.startM, b.endM) : null)).map(ms => (ms == null ? null : ms / 1000))
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
function computeCoachLine(
  racingLines: RacingLineLap[],
  bounds: SplitBound[],
  winners: Array<string | null>,
): CoachLinePoint[] | null {
  if (!racingLines.length || !bounds.length) return null
  const byKey = new Map(racingLines.map(lap => [`${lap.sg}:${lap.lapIdx}`, lap]))
  // Each split's plausible best lap, when it is among the drawn racing lines.
  const bestLapForSeg = bounds.map((_, i) => (winners[i] ? byKey.get(winners[i]!) : undefined) ?? racingLines[0])

  // Stitch XY points from each split's best lap. Apply a ±30 m linear
  // blend at each boundary to suppress discontinuities where the best lap
  // changes.
  const BLEND_M = 30
  const result: CoachLinePoint[] = []
  for (let si = 0; si < bounds.length; si++) {
    const seg = bounds[si]
    const lap = bestLapForSeg[si]
    const nextLap = si + 1 < bounds.length ? bestLapForSeg[si + 1] : null
    for (let i = 0; i < lap.dist.length; i++) {
      const d = lap.dist[i]
      if (d < seg.startM || d >= seg.endM) continue
      let x = lap.x[i]
      let y = lap.y[i]
      if (nextLap && nextLap !== lap) {
        const distToEnd = seg.endM - d
        if (distToEnd < BLEND_M) {
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

// Laps × splits; zero is each split's plausible best. The last row is the
// theoretical best built from those bests.
function buildHeatmap(laps: LapMeta[], splits: Map<string, Array<number | null>>, bounds: SplitBound[], pb: Array<number | null>): HeatmapData | null {
  if (!bounds.length || !laps.length) return null
  const z: Array<Array<number | null>> = []
  const text: string[][] = []
  const yLabels: string[] = []
  for (const lap of laps) {
    const row = splits.get(`${lap.sg}:${lap.lapIdx}`) ?? bounds.map(() => null)
    z.push(row.map((v, i) => (v == null || pb[i] == null ? null : Math.round((v - pb[i]!) * 1000) / 1000)))
    text.push(row.map((v, i) => {
      if (v == null || pb[i] == null) return '—'
      const delta = v - pb[i]!
      return delta < 0 ? `${v.toFixed(2)} (ignored: implausibly fast)` : `${v.toFixed(2)} (+${delta.toFixed(2)})`
    }))
    yLabels.push(`${lap.label}  ${msToLap(lap.durationMs)}`)
  }
  z.push(pb.map(p => (p == null ? null : 0)))
  text.push(pb.map(p => (p == null ? '—' : `${p.toFixed(2)} PB`)))
  yLabels.push('★ Theoretical best')
  const flat = z.flat().filter((v): v is number => v != null && v >= 0)
  const zmax = flat.length ? Math.max(...flat, 0.1) : 5
  return { z, text, cols: bounds.map(b => b.id), rows: yLabels, zmax }
}

// Corner rows and braking episodes from the shared phase detector, so the
// Analysis page shows exactly what the AI coach reads.
function cornerTables(laps: LapMeta[], series: Map<string, LapSeries>, corners: TrackCorner[], totalM: number, conv: SpeedConv): { rows: CornerRow[]; braking: CornerBrakingRow[] } {
  const rowsOut: CornerRow[] = []
  const braking: CornerBrakingRow[] = []
  if (!corners.length) return { rows: rowsOut, braking }
  for (const lap of laps) {
    const trace = series.get(`${lap.sg}:${lap.lapIdx}`)
    if (!trace) continue
    for (const phase of cornerPhases(trace, corners, totalM)) {
      const corner = corners.find(c => c.turn === phase.turn)!
      if (phase.braking) {
        braking.push({
          ...lap, turn: phase.turn, name: corner.name ?? '', apex_dist_m: corner.apex_idx,
          onset_dist_m: phase.braking.onsetM, release_dist_m: phase.braking.releaseM,
          peak_brake_g: phase.braking.peakG, stages: phase.braking.stages,
        })
      }
      if (phase.vminMps == null || phase.vminM == null) continue
      const entryMps = valueAt(trace, trace.speed, phase.braking?.onsetM ?? corner.dist_idx_start)
      if (entryMps == null || phase.exit100Mps == null) continue
      rowsOut.push({
        sg: lap.sg, lapIdx: lap.lapIdx, turn: phase.turn, name: corner.name, lapLbl: lap.label, isBest: lap.isBest,
        entry_mph: conv(entryMps)!, apex_mph: conv(phase.vminMps)!, vmin_dist_m: phase.vminM,
        exit_mph: conv(phase.exit100Mps)!, max_lat_g: phase.maxLatG ?? 0,
      })
    }
  }
  return { rows: rowsOut, braking }
}

// ---------------------------------------------------------------------------

export async function buildAnalysis(
  sessionGuids: string[],
  system: UnitSystem = DEFAULT_UNIT_SYSTEM,
  lapFilter?: LapFilter,
): Promise<AnalysisData> {
  if (!fs.existsSync(DB_PATH)) throw new Error(`no database at ${DB_PATH} — run "Rebuild DB" first`)
  console.log(`[analysis] building for ${sessionGuids.length} session(s)`)
  const analysisDb = await openDb(DB_PATH)
  const con = analysisDb.con
  try {
    // Canonical m/s → the active display unit. All speed fields below carry
    // this unit; `speedUnit` labels it for the renderer.
    const toSpeed: SpeedConv = (mps) => mps == null ? null : speedFromMps(mps, system)
    const speedUnit = speedUnitLabel(system)

    const placeholders = sessionGuids.map(() => '?').join(',')
    const sessRows = await rows(con, `
      SELECT s.session_guid, CAST(s.session_start AS VARCHAR), s.best_lap_ms,
        COALESCE(s.track_configuration_name, tc.track_configuration_name), tc.track_configuration_id, s.mean_line_guid,
        s.weather_description, s.temperature_c, s.humidity_pct,
        s.wind_speed_mps, s.wind_direction_deg, COALESCE(s.track_name, tc.track_name)
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

    // Pick the layout the majority of selected sessions share, by mean line.
    const majority = <T,>(values: T[]): T | null => {
      const counts = new Map<T, number>()
      for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1)
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    }
    const meanLineGuid = majority(sessRows.map(r => (r[5] != null ? String(r[5]) : null)).filter(Boolean) as string[])
    const config = majority(sessions.map(s => s.trackConfig).filter(Boolean) as string[]) ?? 'Unknown'
    const trackName = majority(sessRows.map(r => (r[11] != null ? String(r[11]) : null)).filter(Boolean) as string[]) ?? ''
    // Resolve by mean line first (the Tracks editor stamps it), then by track
    // and configuration name together so another track's "Full Course" is
    // never used.
    const trackYaml = loadTrackYaml(resolveTrackYamlPath(trackName, config, meanLineGuid).path)
    const compatible = !trackYaml.mean_line_guid || !meanLineGuid || trackYaml.mean_line_guid === meanLineGuid
    const segments = compatible ? trackYaml.segments ?? [] : []
    const corners = compatible ? trackYaml.corners ?? [] : []
    const totalDistM = Number(trackYaml.total_dist_m) || 0

    const driven = (await rows(con, `SELECT COUNT(*) FROM laps WHERE session_guid IN (${placeholders}) AND lap_type = 'DRIVEN'`, sessionGuids))[0]?.[0]
    const allLaps = await fetchLapMeta(con, sessionGuids)
    const excludedLapCount = Math.max(0, Number(driven ?? 0) - allLaps.length)
    const laps = selectLaps(allLaps, lapFilter)
    console.log(`[analysis] ${sessions.length} sessions, ${laps.length} laps, config="${config}"`)
    const empty: AnalysisData = {
      config, totalDistM, segments, corners, sessions, laps: [], bestLap: null,
      speedTraces: [], lateralTraces: [], longgTraces: [], timeDeltaTraces: [], optimalTimeDeltaTraces: [], cornerBrakingRows: [],
      gg: { lat_g: [], long_g: [], speed_mph: [], dist: [], p95_g: 0, circle: { x: [], y: [] } },
      trackMap: { dist: [], lat: [], lon: [], speed_mph: [] },
      trackGeometry: null, racingLines: [],
      heatmap: null, cornerRows: [],
      theoreticalBestMs: null, avgLapMs: null, avgLapCount: 0, coachLine: null,
      garminOptimalMs: null, garminOptimalTimeDeltaTraces: [], excludedLapCount,
      speedUnit,
    }
    if (!laps.length) return empty
    for (const lap of allLaps) lap.isBest = false
    const bestLap = laps.reduce((best, lap) => (lap.durationMs < best.durationMs ? lap : best))
    bestLap.isBest = true

    // IMPORTANT: serialize. @duckdb/node-api crashes (SIGSEGV in
    // duckdb_destroy_result) when multiple prepared-statement Execute workers
    // overlap on the same connection. Every fetcher below runs sequentially.
    const series = new Map<string, LapSeries>()
    for (const lap of laps) series.set(`${lap.sg}:${lap.lapIdx}`, await fetchLapSeries(con, lap.sg, lap.lapIdx))

    const speedTraces = await fetchSpeedTraces(con, laps, toSpeed, 25)
    const lateralTraces = await fetchLateralTraces(con, laps, 25)
    const longgTraces = longGTraces(laps, series, 25)

    // Splits tile the lap from each segment start to the next; a split more
    // than 5% faster than the representative median is treated as a cut or
    // timing glitch.
    const bounds = segmentBounds(segments, totalDistM)
    const splits = new Map(laps.map(lap => [`${lap.sg}:${lap.lapIdx}`, lapSplits(series.get(`${lap.sg}:${lap.lapIdx}`), bounds)]))
    const repLaps = laps.filter(lap => lap.representative)
    const pb = bounds.map((_, i) => plausibleMin(
      laps.map(lap => splits.get(`${lap.sg}:${lap.lapIdx}`)![i]),
      repLaps.map(lap => splits.get(`${lap.sg}:${lap.lapIdx}`)![i]),
    ))
    const winners = bounds.map((_, i) => {
      const lap = laps.find(l => pb[i] != null && splits.get(`${l.sg}:${l.lapIdx}`)![i] === pb[i])
      return lap ? `${lap.sg}:${lap.lapIdx}` : null
    })
    const theoreticalBestMs = pb.length && pb.every(v => v != null)
      ? Math.round(pb.reduce((a, b) => a! + b!, 0)! * 1000) : null

    const optimalTimes = await fetchOptimalLapTimes(con, sessions.map(s => s.sg))
    const garminEntry = [...optimalTimes.entries()].sort((a, b) => a[1] - b[1])[0]
    const garminSeries = garminEntry ? await fetchOptimalLapSeries(con, garminEntry[0]) : null
    const garminOptimal = garminEntry && garminSeries ? { series: garminSeries, durationMs: garminEntry[1] } : null

    const deltas = buildTimeDeltaTraces(laps, series, bestLap, bounds, winners, totalDistM, garminOptimal, 25)
    const { rows: cornerRows, braking: cornerBrakingRows } = cornerTables(laps, series, corners, totalDistM, toSpeed)
    const gg = ggData(laps, series, toSpeed)
    const trackMap = await fetchTrackMap(con, bestLap, toSpeed, 10)

    // SVG track geometry plus projected racing lines for the fastest eight
    // laps; the map draws the best prominently and the rest faintly.
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
        const top = [...laps].sort((a, b) => a.durationMs - b.durationMs).slice(0, 8)
        racingLines = await fetchRacingLines(con, top, geom, toSpeed, corners, series, totalDistM, 5)
      }
    }

    const heatmap = buildHeatmap(laps, splits, bounds, pb)
    const coachLine = racingLines.length && bounds.length ? computeCoachLine(racingLines, bounds, winners) : null

    const representative = laps.filter(l => l.representative)
    const avgLapMs = representative.length
      ? Math.round(representative.reduce((a, l) => a + l.durationMs, 0) / representative.length)
      : null

    console.log(`[analysis] complete — ${racingLines.length} racing lines, theoretical best: ${theoreticalBestMs ? (theoreticalBestMs / 1000).toFixed(3) + 's' : 'n/a'}`)
    return {
      ...empty,
      laps, bestLap,
      speedTraces, lateralTraces, longgTraces,
      timeDeltaTraces: deltas.fastest, optimalTimeDeltaTraces: deltas.optimal, cornerBrakingRows,
      gg, trackMap, trackGeometry, racingLines, heatmap, cornerRows,
      theoreticalBestMs, avgLapMs, avgLapCount: representative.length, coachLine,
      garminOptimalMs: garminOptimal?.durationMs ?? null, garminOptimalTimeDeltaTraces: deltas.garmin,
    }
  } finally {
    await analysisDb.close()
  }
}
