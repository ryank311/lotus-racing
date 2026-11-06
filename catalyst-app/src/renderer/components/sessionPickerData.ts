import type { DbSessionRow } from '../../shared/types'
import { startLabel } from './reviewTimeline'

export type SessionOrder = 'recent' | 'fastest'
export const validLapTime = (ms: number | null | undefined): ms is number => ms != null && Number.isFinite(ms) && ms > 0
const clean = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

export function sessionCar(row: DbSessionRow): string {
  return [row.vehicle_make, row.vehicle_model].filter(Boolean).join(' ') || 'Unknown car'
}

export function sessionCourseKey(row: DbSessionRow): string {
  if (row.track_configuration_id != null) return `course:${row.track_configuration_id}`
  if (row.layout_key) return JSON.stringify(['layout', row.layout_key, clean(row.track_name), clean(row.track_configuration_name)])
  if (row.track_name?.trim() && row.track_configuration_name?.trim()) return JSON.stringify(['name', clean(row.track_name), clean(row.track_configuration_name)])
  return 'unknown'
}

const benchmarkKey = (row: DbSessionRow) => row.vehicle_guid && sessionCourseKey(row) !== 'unknown'
  ? JSON.stringify([sessionCourseKey(row), row.vehicle_guid, row.account ?? null]) : null

/** Compute before searching/filtering: narrowing the list must not invent a PB. */
export function sessionBenchmarks(rows: DbSessionRow[]) {
  const bests = new Map<string, number>()
  for (const row of rows) {
    const key = benchmarkKey(row)
    if (!key) continue
    for (const ms of [row.best_lap_ms, row.layout_best_ms]) {
      if (validLapTime(ms)) bests.set(key, Math.min(bests.get(key) ?? Infinity, ms))
    }
  }
  return new Map(rows.map(row => {
    const best = bests.get(benchmarkKey(row) ?? '')
    const gapMs = best != null && validLapTime(row.best_lap_ms) ? Math.max(0, row.best_lap_ms - best) : null
    return [row.session_guid, { gapMs, isPb: gapMs === 0 }]
  }))
}

export function newestSessionFirst(a: DbSessionRow, b: DbSessionRow): number {
  return (b.session_start ?? '').localeCompare(a.session_start ?? '') || a.session_guid.localeCompare(b.session_guid)
}

export interface SessionGroup {
  key: string
  track: string
  layout: string
  rows: DbSessionRow[]
}

/** Layouts stay in recent-visit order; pace sorting happens only inside each layout. */
export function sessionPickerGroups(rows: DbSessionRow[], order: SessionOrder, search = '', car = ''): SessionGroup[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const groups = new Map<string, SessionGroup>()
  for (const row of [...rows].sort(newestSessionFirst)) {
    if (car && row.vehicle_guid !== car) continue
    const haystack = [row.track_name, row.track_configuration_name, sessionCar(row), row.vehicle_year,
      row.session_start, startLabel(row.session_start), row.weather_description].join(' ').toLowerCase()
    if (!terms.every(term => haystack.includes(term))) continue
    const key = sessionCourseKey(row)
    if (!groups.has(key)) groups.set(key, { key, track: row.track_name || 'Unknown track', layout: row.track_configuration_name || 'Unknown layout', rows: [] })
    groups.get(key)!.rows.push(row)
  }
  if (order === 'fastest') for (const group of groups.values()) group.rows.sort((a, b) => {
    const aMs = validLapTime(a.best_lap_ms) ? a.best_lap_ms : Infinity
    const bMs = validLapTime(b.best_lap_ms) ? b.best_lap_ms : Infinity
    return (aMs === bMs ? 0 : aMs - bMs) || newestSessionFirst(a, b)
  })
  return [...groups.values()]
}
