// Database access shared by Analysis, the coaching packet and the focus
// tracker: which laps are valid, how they are labelled, and their telemetry.

import type { DuckDBConnection } from '@duckdb/node-api'
import { calibrateLongG, G0, type LapSeries } from './lapPhases.js'

// Garmin lap_descriptor bits: 2 Divergent, 4 Invalid, 8 Paused, 16 Bad GPS.
export const INVALID_DESCRIPTOR_MASK = 2 | 4 | 8 | 16

export interface ValidLap {
  sg: string
  lapIndex: number
  durationMs: number
  sessionStart: string | null
}

async function hasTable(con: DuckDBConnection, name: string): Promise<boolean> {
  const rows = (await con.runAndReadAll(
    "SELECT 1 FROM duckdb_tables() WHERE table_name = ? AND schema_name = 'main'", [name],
  )).getRowsJson()
  return rows.length > 0
}

// SQL predicate over `laps l`: driven, positive duration, no Garmin invalid
// flag, and not excluded by the driver on Session Review.
export async function validLapPredicate(con: DuckDBConnection): Promise<string> {
  const excluded = await hasTable(con, 'review_lap_exclusions')
    ? ' AND NOT EXISTS (SELECT 1 FROM review_lap_exclusions x WHERE x.session_guid = l.session_guid AND x.lap_index = l.lap_index)'
    : ''
  return `l.lap_type = 'DRIVEN' AND l.duration_ms > 0 AND (COALESCE(l.lap_descriptor, 0) & ${INVALID_DESCRIPTOR_MASK}) = 0${excluded}`
}

export async function fetchValidLaps(con: DuckDBConnection, sessionGuids: string[]): Promise<ValidLap[]> {
  if (!sessionGuids.length) return []
  const predicate = await validLapPredicate(con)
  const rows = (await con.runAndReadAll(`
    SELECT l.session_guid, l.lap_index, l.duration_ms, CAST(s.session_start AS VARCHAR) AS session_start
    FROM laps l JOIN sessions s ON s.session_guid = l.session_guid
    WHERE l.session_guid IN (${sessionGuids.map(() => '?').join(',')}) AND ${predicate}
    ORDER BY s.session_start DESC, l.lap_index
  `, sessionGuids)).getRowObjectsJson() as any[]
  return rows.map(r => ({
    sg: String(r.session_guid),
    lapIndex: Number(r.lap_index),
    durationMs: Number(r.duration_ms),
    sessionStart: r.session_start == null ? null : String(r.session_start),
  }))
}

// Representative pace: within 5% of the lap's own session best and within
// 4% of the fastest lap in the set, so a cold or wet session does not drag
// every median down.
export const SESSION_WINDOW = 1.05
export const SELECTION_WINDOW = 1.04
export function representativeKeys<T extends { sg: string; durationMs: number; lapIndex: number }>(laps: T[]): Set<string> {
  const best = new Map<string, number>()
  for (const lap of laps) best.set(lap.sg, Math.min(best.get(lap.sg) ?? Infinity, lap.durationMs))
  const overall = Math.min(...laps.map(l => l.durationMs))
  return new Set(laps
    .filter(lap => lap.durationMs <= (best.get(lap.sg) ?? 0) * SESSION_WINDOW && lap.durationMs <= overall * SELECTION_WINDOW)
    .map(lap => `${lap.sg}:${lap.lapIndex}`))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "May 24 16:15" — session start in local track time.
export function shortSessionLabel(start: string | null | undefined): string {
  const m = String(start ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/)
  if (!m) return 'Session'
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`
}

// "May 24 16:15 · L3" — the one lap label used by every chart and report.
export function lapLabel(start: string | null | undefined, lapIndex: number): string {
  return `${shortSessionLabel(start)} · L${lapIndex + 1}`
}

export async function fetchLapSeries(con: DuckDBConnection, sg: string, lapIndex: number): Promise<LapSeries> {
  const rows = (await con.runAndReadAll(`
    SELECT distance_m, time_ms, gnss_speed_mps, accel_x_mps2, accel_y_mps2
    FROM samples WHERE session_guid = ? AND lap_index = ? AND distance_m IS NOT NULL
    ORDER BY distance_m, time_ms
  `, [sg, lapIndex])).getRowsJson()
  return seriesFromRows(rows)
}

export async function fetchOptimalLapSeries(con: DuckDBConnection, sg: string): Promise<LapSeries | null> {
  if (!await hasTable(con, 'optimal_lap_samples')) return null
  const rows = (await con.runAndReadAll(`
    SELECT distance_m, time_ms, gnss_speed_mps, accel_x_mps2, accel_y_mps2
    FROM optimal_lap_samples WHERE session_guid = ? AND distance_m IS NOT NULL
    ORDER BY distance_m, time_ms
  `, [sg])).getRowsJson()
  return rows.length ? seriesFromRows(rows) : null
}

export async function fetchOptimalLapTimes(con: DuckDBConnection, sessionGuids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!sessionGuids.length || !await hasTable(con, 'optimal_laps')) return out
  const rows = (await con.runAndReadAll(
    `SELECT session_guid, duration_ms FROM optimal_laps WHERE session_guid IN (${sessionGuids.map(() => '?').join(',')}) AND duration_ms > 0`,
    sessionGuids,
  )).getRowsJson()
  for (const [sg, ms] of rows) out.set(String(sg), Number(ms))
  return out
}

// Rounded distances can repeat; keep the last sample at each metre so the
// series is strictly ascending.
function seriesFromRows(rows: unknown[][]): LapSeries {
  const series: LapSeries = { dist: [], timeMs: [], speed: [], longG: [], latG: [] }
  const num = (v: unknown) => (v == null ? NaN : Number(v))
  for (const row of rows) {
    const d = num(row[0])
    if (!Number.isFinite(d)) continue
    const last = series.dist.length - 1
    const values = [num(row[1]), num(row[2]), num(row[3]) / G0, num(row[4]) / G0]
    if (last >= 0 && series.dist[last] === d) {
      series.timeMs[last] = values[0]; series.speed[last] = values[1]; series.longG[last] = values[2]; series.latG[last] = values[3]
    } else {
      series.dist.push(d); series.timeMs.push(values[0]); series.speed.push(values[1]); series.longG.push(values[2]); series.latG.push(values[3])
    }
  }
  // Elapsed time from the first sample.
  const t0 = series.timeMs.find(Number.isFinite) ?? 0
  series.timeMs = series.timeMs.map(t => t - t0)
  // Remove mounting misalignment so braking and throttle are measured along
  // the track, whatever angle the unit sat at that day.
  calibrateLongG(series)
  return series
}
