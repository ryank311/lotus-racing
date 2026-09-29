// The coaching packet: every number the AI coach may cite, computed in code
// from valid laps and labelled with an evidence ID. The model interprets the
// packet; it never recomputes lap, split or corner times.

import type { DuckDBConnection } from '@duckdb/node-api'
import type { CoachingContext, FocusCheck, FocusItem, FocusUnit } from '../shared/types.js'
import { speedFromMps, speedUnitLabel, tempFromC, tempUnitLabel, type UnitSystem } from '../shared/units.js'
import { lapFilterPhrase, selectLaps, type LapFilter } from '../shared/coachingScope.js'
import {
  complexesFromSegments, complexPhases, deriveComplexes, median, plausibleMin, segmentBounds, stdev,
  type ComplexDef, type ComplexPhase, type LapSeries,
} from './lapPhases.js'
import {
  fetchLapSeries, fetchOptimalLapTimes, fetchValidLaps, lapLabel, representativeKeys,
  shortSessionLabel, validLapPredicate, type ValidLap,
} from './lapData.js'
import { loadTrackYaml, resolveTrackYamlPath, saveTrackYamlComplexes, type TrackYaml } from './trackYaml.js'

// ─── Metrics ────────────────────────────────────────────────────────────────

export type MetricKey =
  | 'time' | 'time_sd' | 'brake_onset' | 'brake_onset_sd' | 'brake_peak' | 'brake_release'
  | 'vmin' | 'vmin_at' | 'throttle_at' | 'neutral' | 'exit100' | 'exit200'

interface MetricMeta {
  label: string
  unit: FocusUnit
  better: 'lower' | 'higher' | null   // null: a position, neither is better
  value?: (p: ComplexPhase) => number | null
  spreadOf?: MetricKey                // set-level: spread of another metric
}

export const METRICS: Record<MetricKey, MetricMeta> = {
  time: { label: 'Time through the complex', unit: 'ms', better: 'lower', value: p => p.timeMs },
  time_sd: { label: 'Lap-to-lap spread of complex time', unit: 'ms', better: 'lower', spreadOf: 'time' },
  brake_onset: { label: 'Braking point', unit: 'm', better: null, value: p => p.braking?.onsetM ?? null },
  brake_onset_sd: { label: 'Lap-to-lap spread of the braking point', unit: 'm', better: 'lower', spreadOf: 'brake_onset' },
  brake_peak: { label: 'Peak braking', unit: 'g', better: 'higher', value: p => p.braking?.peakG ?? null },
  brake_release: { label: 'Brake release point', unit: 'm', better: null, value: p => p.braking?.releaseM ?? null },
  vmin: { label: 'Minimum speed', unit: 'mps', better: 'higher', value: p => p.vminMps },
  vmin_at: { label: 'Where the minimum speed happens', unit: 'm', better: null, value: p => p.vminM },
  throttle_at: { label: 'Throttle pickup point', unit: 'm', better: 'lower', value: p => p.throttleM },
  neutral: { label: 'Coasting between brake release and throttle', unit: 'm', better: 'lower', value: p => p.neutralM },
  exit100: { label: 'Speed 100 m after the minimum', unit: 'mps', better: 'higher', value: p => p.exit100Mps },
  exit200: { label: 'Speed 200 m after the minimum', unit: 'mps', better: 'higher', value: p => p.exit200Mps },
}
// Metrics a focus item may be scored on.
const SUCCESS_METRICS: MetricKey[] = ['time', 'time_sd', 'brake_onset_sd', 'brake_peak', 'vmin', 'throttle_at', 'neutral', 'exit100', 'exit200']

export const FOCUS_PHASES = ['braking', 'turn-in', 'mid-corner', 'throttle', 'exit', 'straight', 'consistency'] as const

export interface MetricStat {
  n: number
  median: number | null
  spread: number | null        // sample standard deviation
  best: number | null          // best by direction (plausible for time)
  bestLap: string | null       // lap id of the best complex time
  bestExec: number | null      // value on the lap with the best complex time
  onBestLap: number | null     // value on the selection's fastest lap
}

// ─── Packet shape ───────────────────────────────────────────────────────────

export interface PacketSession {
  id: string
  sg: string
  label: string
  start: string | null
  weather: string | null
  tempC: number | null
  humidityPct: number | null
  windMps: number | null
  windDeg: number | null
  bestMs: number | null
  medianMs: number | null
  spreadMs: number | null
  laps: number
  notes: string | null
}

export interface PacketLap extends ValidLap {
  id: string
  sessionId: string
  label: string
  representative: boolean
  phases: ComplexPhase[]
}

export interface Opportunity {
  complexId: string
  medianGapMs: number
  spreadMs: number | null
  compare: string
}

export interface CoachPacket {
  version: 2
  units: UnitSystem
  trackLabel: string
  totalM: number
  context: CoachingContext
  vehicleLabel: string
  sessions: PacketSession[]
  laps: PacketLap[]
  complexes: ComplexDef[]
  complexSource: 'track' | 'derived' | 'segments'
  stats: Record<string, Record<MetricKey, MetricStat>>
  bestLap: PacketLap | null
  idealMs: number | null
  allTimePb: { ms: number; label: string } | null
  garminOptimalMs: number | null
  opportunities: Opportunity[]
  lapNumberPace: Array<{ lapNumber: number; n: number; medianGapMs: number; sessionBests: number }>
  previousFocus: Array<{ item: FocusItem; check: FocusCheck }>
  evidence: Record<string, string>
  successMetrics: string[]
}

export interface PacketOptions {
  sessionGuids: string[]
  lapFilter?: LapFilter
  system: UnitSystem
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatters(system: UnitSystem) {
  const spdU = speedUnitLabel(system)
  const lapTime = (ms: number | null | undefined): string => {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
    const s = ms / 1000, m = Math.floor(s / 60)
    return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`
  }
  const value = (unit: FocusUnit, v: number | null | undefined, signed = false): string => {
    if (v == null || !Number.isFinite(v)) return '—'
    const sign = signed && v > 0 ? '+' : ''
    if (unit === 'ms') return `${sign}${(v / 1000).toFixed(2)} s`
    if (unit === 'mps') return `${sign}${speedFromMps(v, system).toFixed(1)} ${spdU}`
    if (unit === 'g') return `${sign}${v.toFixed(2)} g`
    return `${sign}${Math.round(v)} m`
  }
  const temp = (c: number | null | undefined) => (c == null ? '—' : `${tempFromC(c, system).toFixed(0)}${tempUnitLabel(system)}`)
  const wind = (mps: number | null | undefined, deg: number | null | undefined) => {
    if (mps == null) return '—'
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    const dir = deg == null ? '' : ` from ${dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8]}`
    return `${speedFromMps(mps, system).toFixed(0)} ${spdU}${dir}`
  }
  return { lapTime, value, temp, wind, spdU }
}

// ─── Building ───────────────────────────────────────────────────────────────

async function rows(con: DuckDBConnection, sql: string, params: unknown[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params as any)).getRowObjectsJson() as any[]
}

async function hasTable(con: DuckDBConnection, name: string): Promise<boolean> {
  return (await rows(con, "SELECT 1 FROM duckdb_tables() WHERE table_name = ? AND schema_name = 'main'", [name])).length > 0
}

export interface SessionMeta {
  session_guid: string
  start: string | null
  track_name: string | null
  track_configuration_name: string | null
  track_configuration_id: number | null
  mean_line_guid: string | null
  vehicle_guid: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_year: number | null
  account: string | null
  weather_description: string | null
  temperature_c: number | null
  humidity_pct: number | null
  wind_speed_mps: number | null
  wind_direction_deg: number | null
  best_lap_ms: number | null
}

export async function fetchSessionMeta(con: DuckDBConnection, guids: string[]): Promise<SessionMeta[]> {
  if (!guids.length) return []
  return rows(con, `
    SELECT s.session_guid, CAST(s.session_start AS VARCHAR) AS start,
      COALESCE(s.track_name, tc.track_name) AS track_name,
      COALESCE(s.track_configuration_name, tc.track_configuration_name) AS track_configuration_name,
      s.track_configuration_id, s.mean_line_guid, s.vehicle_guid, s.vehicle_make, s.vehicle_model, s.vehicle_year,
      s.account, s.weather_description, s.temperature_c, s.humidity_pct, s.wind_speed_mps, s.wind_direction_deg, s.best_lap_ms
    FROM sessions s LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    WHERE s.session_guid IN (${guids.map(() => '?').join(',')})
    ORDER BY s.session_start
  `, guids)
}

// Coaching compares like with like: one layout and one car per packet.
export function assertComparable(sessions: SessionMeta[]): void {
  const layouts = new Set(sessions.map(s => s.mean_line_guid ?? String(s.track_configuration_id ?? s.track_configuration_name ?? '')))
  if (layouts.size > 1) {
    const names = [...new Set(sessions.map(s => [s.track_name, s.track_configuration_name].filter(Boolean).join(' · ')))]
    throw new Error(`AI coaching requires one track layout at a time. Selected: ${names.join(', ')}.`)
  }
  const vehicles = new Set(sessions.map(s => s.vehicle_guid).filter(Boolean))
  if (vehicles.size > 1) throw new Error('AI coaching requires sessions from one vehicle at a time so setup and pace comparisons stay valid.')
}

export function vehicleLabelOf(s: SessionMeta | undefined): string {
  if (!s) return 'Unknown vehicle'
  return [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ') || 'Unknown vehicle'
}

export function trackYamlFor(session: SessionMeta): { path: string; yaml: TrackYaml; exists: boolean } {
  const resolved = resolveTrackYamlPath(session.track_name ?? '', session.track_configuration_name ?? '', session.mean_line_guid)
  return { ...resolved, yaml: loadTrackYaml(resolved.path) }
}

// Complex boundaries must stay put between sessions so focus items can be
// checked later. They live in the track YAML; the first time a layout is
// coached they are derived from its fastest valid lap and saved there.
export async function resolveComplexes(
  con: DuckDBConnection,
  session: SessionMeta,
): Promise<{ complexes: ComplexDef[]; source: CoachPacket['complexSource']; totalM: number }> {
  const { path, yaml, exists } = trackYamlFor(session)
  const compatible = !yaml.mean_line_guid || !session.mean_line_guid || yaml.mean_line_guid === session.mean_line_guid
  const totalM = Number(yaml.total_dist_m) || 0
  if (compatible && yaml.complexes?.length) {
    return {
      source: 'track', totalM,
      complexes: yaml.complexes.map(c => ({
        id: String(c.id), name: String(c.name), startM: Number(c.start_m), endM: Number(c.end_m),
        corners: String(c.corners ?? '').split(',').map(s => s.trim()).filter(Boolean),
      })),
    }
  }
  if (compatible && yaml.corners.length) {
    const reference = await fastestLayoutLap(con, session)
    if (reference) {
      const derived = deriveComplexes(yaml.corners, reference, totalM)
      if (derived.length) {
        if (exists) {
          try {
            saveTrackYamlComplexes(path, derived.map(c => ({ id: c.id, name: c.name, start_m: c.startM, end_m: c.endM, corners: c.corners.join(',') })))
          } catch { /* read-only tracks directory: derive again next time */ }
        }
        return { complexes: derived, source: 'derived', totalM }
      }
    }
  }
  const segments = compatible ? yaml.segments : []
  return { complexes: complexesFromSegments(segmentBounds(segments, totalM)), source: 'segments', totalM }
}

async function fastestLayoutLap(con: DuckDBConnection, session: SessionMeta): Promise<LapSeries | null> {
  const predicate = await validLapPredicate(con)
  const key = session.mean_line_guid ? 's.mean_line_guid = ?' : 's.track_configuration_id = ?'
  const lap = (await rows(con, `
    SELECT l.session_guid, l.lap_index FROM laps l JOIN sessions s ON s.session_guid = l.session_guid
    WHERE ${key} AND ${predicate} ORDER BY l.duration_ms LIMIT 1
  `, [session.mean_line_guid ?? session.track_configuration_id]))[0]
  return lap ? fetchLapSeries(con, String(lap.session_guid), Number(lap.lap_index)) : null
}

function statFor(key: MetricKey, laps: PacketLap[], complexIndex: number, bestLap: PacketLap | null): MetricStat {
  const meta = METRICS[key]
  const valueOf = (lap: PacketLap) => METRICS[meta.spreadOf ?? key].value!(lap.phases[complexIndex])
  const rep = laps.filter(l => l.representative)
  const pairs = rep.map(l => ({ lap: l, v: valueOf(l) })).filter((p): p is { lap: PacketLap; v: number } => p.v != null && Number.isFinite(p.v))
  const times = rep.map(l => ({ lap: l, t: l.phases[complexIndex].timeMs })).filter((p): p is { lap: PacketLap; t: number } => p.t != null)
  const bestTime = plausibleMin(times.map(p => p.t))
  const execLap = bestTime == null ? null : times.find(p => p.t === bestTime)?.lap ?? null
  if (meta.spreadOf) {
    return { n: pairs.length, median: stdev(pairs.map(p => p.v)), spread: null, best: null, bestLap: null, bestExec: null, onBestLap: null }
  }
  const values = pairs.map(p => p.v)
  const best = !values.length || !meta.better ? null
    : key === 'time' ? bestTime
    : meta.better === 'higher' ? Math.max(...values) : Math.min(...values)
  return {
    n: pairs.length,
    median: median(values),
    spread: stdev(values),
    best,
    bestLap: execLap?.id ?? null,
    bestExec: execLap ? valueOf(execLap) : null,
    onBestLap: bestLap ? valueOf(bestLap) : null,
  }
}

export async function buildCoachPacket(con: DuckDBConnection, opts: PacketOptions): Promise<CoachPacket> {
  const meta = await fetchSessionMeta(con, opts.sessionGuids)
  if (!meta.length) throw new Error('no sessions matched the provided GUIDs.')
  assertComparable(meta)
  const f = formatters(opts.system)
  const anchor = meta[meta.length - 1]
  const { complexes, source, totalM } = await resolveComplexes(con, anchor)

  // Sessions, oldest first, with short IDs S1, S2…
  const notes = await hasTable(con, 'session_notes')
    ? new Map((await rows(con, `SELECT * FROM session_notes WHERE session_guid IN (${meta.map(() => '?').join(',')})`, meta.map(m => m.session_guid)))
      .map(r => [String(r.session_guid), [r.tires && `tires: ${r.tires}`, r.pressures && `pressures: ${r.pressures}`, r.setup && `setup: ${r.setup}`, r.notes && `notes: ${r.notes}`].filter(Boolean).join('; ')]))
    : new Map<string, string>()
  const sessionId = new Map(meta.map((m, i) => [m.session_guid, `S${i + 1}`]))

  const allValid = await fetchValidLaps(con, meta.map(m => m.session_guid))
  const selected = selectLaps(allValid, opts.lapFilter)
  const repKeys = representativeKeys(selected)
  const laps: PacketLap[] = []
  for (const lap of selected) {
    const series = await fetchLapSeries(con, lap.sg, lap.lapIndex)
    laps.push({
      ...lap,
      id: `${sessionId.get(lap.sg)}L${lap.lapIndex + 1}`,
      sessionId: sessionId.get(lap.sg)!,
      label: lapLabel(lap.sessionStart, lap.lapIndex),
      representative: repKeys.has(`${lap.sg}:${lap.lapIndex}`),
      phases: complexPhases(series, complexes),
    })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  laps.sort((a, b) => a.sessionId.localeCompare(b.sessionId, undefined, { numeric: true }) || a.lapIndex - b.lapIndex)
  const bestLap = laps.reduce<PacketLap | null>((a, b) => (!a || b.durationMs < a.durationMs ? b : a), null)

  const sessions: PacketSession[] = meta.map(m => {
    const own = laps.filter(l => l.sg === m.session_guid)
    const rep = own.filter(l => l.representative).map(l => l.durationMs)
    return {
      id: sessionId.get(m.session_guid)!, sg: m.session_guid, label: shortSessionLabel(m.start), start: m.start,
      weather: m.weather_description, tempC: m.temperature_c, humidityPct: m.humidity_pct,
      windMps: m.wind_speed_mps, windDeg: m.wind_direction_deg,
      bestMs: own.length ? Math.min(...own.map(l => l.durationMs)) : null,
      medianMs: median(rep), spreadMs: stdev(rep), laps: own.length, notes: notes.get(m.session_guid) || null,
    }
  })

  const stats: CoachPacket['stats'] = {}
  complexes.forEach((c, i) => {
    stats[c.id] = Object.fromEntries((Object.keys(METRICS) as MetricKey[]).map(k => [k, statFor(k, laps, i, bestLap)])) as Record<MetricKey, MetricStat>
  })
  const bests = complexes.map(c => stats[c.id].time.best)
  const idealMs = bests.length && bests.every(v => v != null) ? bests.reduce((a, b) => a! + b!, 0) : null

  // All-time PB for this car and layout, and Garmin's optimal laps.
  const predicate = await validLapPredicate(con)
  const pbRow = (await rows(con, `
    SELECT l.duration_ms, CAST(s.session_start AS VARCHAR) AS start, l.lap_index FROM laps l JOIN sessions s ON s.session_guid = l.session_guid
    WHERE ${predicate} AND ${anchor.mean_line_guid ? 's.mean_line_guid = ?' : 's.track_configuration_id = ?'}
      AND s.vehicle_guid IS NOT DISTINCT FROM ? AND s.account IS NOT DISTINCT FROM ?
    ORDER BY l.duration_ms LIMIT 1
  `, [anchor.mean_line_guid ?? anchor.track_configuration_id, anchor.vehicle_guid, anchor.account]))[0]
  const allTimePb = pbRow ? { ms: Number(pbRow.duration_ms), label: lapLabel(pbRow.start, Number(pbRow.lap_index)) } : null
  const optimal = await fetchOptimalLapTimes(con, meta.map(m => m.session_guid))
  const garminOptimalMs = optimal.size ? Math.min(...optimal.values()) : null

  // Where the time is: complexes ranked by the representative median gap to
  // the driver's own best, with what the best execution did differently.
  const opportunities: Opportunity[] = complexes.map(c => {
    const s = stats[c.id]
    return { complexId: c.id, medianGapMs: s.time.median != null && s.time.best != null ? s.time.median - s.time.best : 0, spreadMs: s.time.spread, compare: compareExecution(s, f) }
  }).filter(o => o.medianGapMs >= 50).sort((a, b) => b.medianGapMs - a.medianGapMs).slice(0, 5)

  // Pace by lap number across every valid lap of the selected sessions.
  const byNumber = new Map<number, { gaps: number[]; bests: number }>()
  const sessionBest = new Map<string, number>()
  for (const lap of allValid) sessionBest.set(lap.sg, Math.min(sessionBest.get(lap.sg) ?? Infinity, lap.durationMs))
  for (const lap of allValid) {
    const best = sessionBest.get(lap.sg)!
    if (lap.durationMs > best * 1.05) continue
    const entry = byNumber.get(lap.lapIndex + 1) ?? { gaps: [], bests: 0 }
    entry.gaps.push(lap.durationMs - best)
    if (lap.durationMs === best) entry.bests++
    byNumber.set(lap.lapIndex + 1, entry)
  }
  const lapNumberPace = [...byNumber.entries()].sort((a, b) => a[0] - b[0])
    .map(([lapNumber, e]) => ({ lapNumber, n: e.gaps.length, medianGapMs: median(e.gaps) ?? 0, sessionBests: e.bests }))

  const context: CoachingContext = {
    vehicleGuid: anchor.vehicle_guid, account: anchor.account, meanLineGuid: anchor.mean_line_guid,
    configurationId: anchor.track_configuration_id,
    trackLabel: [anchor.track_name, anchor.track_configuration_name].filter(Boolean).join(' · ') || 'Unknown track',
    lapFilter: opts.lapFilter ?? 'all',
    latestSessionStart: anchor.start, units: opts.system,
  }

  const packet: CoachPacket = {
    version: 2, units: opts.system, trackLabel: context.trackLabel, totalM, context,
    vehicleLabel: vehicleLabelOf(anchor), sessions, laps, complexes, complexSource: source, stats, bestLap, idealMs,
    allTimePb, garminOptimalMs, opportunities, lapNumberPace, previousFocus: [], evidence: {}, successMetrics: [],
  }
  packet.previousFocus = await checkPreviousFocus(con, packet)
  packet.evidence = buildEvidence(packet)
  packet.successMetrics = complexes.flatMap(c => SUCCESS_METRICS.filter(k => {
    const s = stats[c.id][k]
    return s.n >= 2 && s.median != null && (METRICS[k].spreadOf || s.best != null)
  }).map(k => `${c.id}.${k}`))
  return packet
}

function compareExecution(s: Record<MetricKey, MetricStat>, f: ReturnType<typeof formatters>): string {
  const parts: string[] = []
  const diff = (key: MetricKey, threshold: number, describe: (d: number) => string) => {
    const stat = s[key]
    if (stat.bestExec == null || stat.median == null) return
    const d = stat.bestExec - stat.median
    if (Math.abs(d) >= threshold) parts.push(describe(d))
  }
  diff('brake_onset', 3, d => `braked ${Math.abs(Math.round(d))} m ${d > 0 ? 'later' : 'earlier'}`)
  diff('brake_peak', 0.04, d => `peak braking ${f.value('g', d, true)}`)
  diff('vmin', 0.2, d => `minimum speed ${f.value('mps', d, true)}`)
  diff('vmin_at', 4, d => `minimum ${Math.abs(Math.round(d))} m ${d > 0 ? 'later' : 'earlier'}`)
  diff('throttle_at', 4, d => `throttle ${Math.abs(Math.round(d))} m ${d > 0 ? 'later' : 'earlier'}`)
  diff('neutral', 4, d => `${Math.abs(Math.round(d))} m ${d > 0 ? 'more' : 'less'} coasting`)
  diff('exit200', 0.2, d => `${f.value('mps', d, true)} 200 m after the minimum`)
  return parts.length ? `Best execution vs median: ${parts.join(', ')}.` : 'Best execution differs from the median by less than the measurement noise in every phase.'
}

// ─── Evidence catalogue ─────────────────────────────────────────────────────

const lapCount = (n: number) => `${n} representative lap${n === 1 ? '' : 's'}`

function buildEvidence(p: CoachPacket): Record<string, string> {
  const f = formatters(p.units)
  const lapById = new Map(p.laps.map(l => [l.id, l]))
  const ev: Record<string, string> = {}
  const rep = p.laps.filter(l => l.representative).map(l => l.durationMs)
  ev['pace.best'] = p.bestLap ? `Fastest valid lap in this selection: ${f.lapTime(p.bestLap.durationMs)} (${p.bestLap.label}).` : 'No valid laps.'
  ev['pace.median'] = `Median representative lap ${f.lapTime(median(rep))}, spread ±${f.value('ms', stdev(rep))} over ${lapCount(rep.length)} (within 5% of their session best and 4% of the fastest lap).`
  if (p.idealMs != null && p.bestLap) ev['pace.ideal'] = `Ideal lap from your best time in each complex: ${f.lapTime(p.idealMs)}, ${f.value('ms', p.bestLap.durationMs - p.idealMs)} under the fastest lap.`
  if (p.allTimePb) ev['pace.pb'] = `All-time PB for this car and layout: ${f.lapTime(p.allTimePb.ms)} (${p.allTimePb.label}).`
  if (p.garminOptimalMs) ev['pace.garmin_optimal'] = `Garmin's optimal lap for these sessions: ${f.lapTime(p.garminOptimalMs)}.`
  if (p.lapNumberPace.length) {
    ev['pace.lap_number'] = 'Median gap to session best by lap number: ' + p.lapNumberPace
      .map(e => `L${e.lapNumber} ${f.value('ms', e.medianGapMs, true)}${e.sessionBests ? ` (${e.sessionBests} session best${e.sessionBests > 1 ? 's' : ''})` : ''}`).join(', ') + '.'
  }
  for (const s of p.sessions) {
    ev[`session.${s.id}`] = `${s.label}: best ${f.lapTime(s.bestMs)}, median ${f.lapTime(s.medianMs)} ±${f.value('ms', s.spreadMs)}, ${s.laps} valid laps, ${s.weather ?? 'weather unknown'} ${f.temp(s.tempC)}${s.notes ? `; ${s.notes}` : ''}.`
  }
  for (const lap of p.laps) {
    ev[`lap.${lap.id}`] = `${lap.label}: ${f.lapTime(lap.durationMs)}${lap.representative ? '' : ' (outside 5% of its session best)'}.`
  }
  for (const c of p.complexes) {
    const s = p.stats[c.id]
    for (const key of Object.keys(METRICS) as MetricKey[]) {
      const m = METRICS[key], st = s[key]
      if (!st.n || st.median == null) continue
      if (m.spreadOf) {
        ev[`${c.id}.${key}`] = `${c.name} — ${m.label}: ±${f.value(m.unit, st.median)} over ${lapCount(st.n)}.`
        continue
      }
      const bestLap = st.bestLap ? lapById.get(st.bestLap) : null
      const parts = [`median ${f.value(m.unit, st.median)}`]
      if (st.best != null) parts.push(`best ${f.value(m.unit, st.best)}`)
      if (bestLap && st.bestExec != null) parts.push(`${f.value(m.unit, st.bestExec)} on your best pass (${bestLap.label})`)
      if (st.spread != null) parts.push(`spread ±${f.value(m.unit, st.spread)}`)
      ev[`${c.id}.${key}`] = `${c.name} — ${m.label}: ${parts.join(', ')}; ${lapCount(st.n)}.`
    }
    const opp = p.opportunities.find(o => o.complexId === c.id)
    if (opp) ev[`${c.id}.compare`] = `${c.name} — median lap ${f.value('ms', opp.medianGapMs)} slower than your best pass. ${opp.compare}`
  }
  for (const { item, check } of p.previousFocus) {
    ev[`focus.${item.id}`] = `Previous focus "${item.cue}" (${item.complexName}, ${item.metricLabel}): baseline ${check.display.baseline}, target ${check.display.target}, now ${check.display.current} over ${check.laps} laps — ${check.verdict.replace('_', ' ')}.`
  }
  return ev
}

// ─── Focus items: build and check ───────────────────────────────────────────

export function focusFromChoice(
  p: CoachPacket,
  choice: { complex: string; metric: string; target: string; phase: string; change: string; why: string; cue: string; reference_lap: string; confidence: string; evidence: string[] },
  id: string,
): FocusItem | null {
  const complex = p.complexes.find(c => c.id === choice.complex) ?? p.complexes.find(c => choice.metric.startsWith(`${c.id}.`))
  if (!complex) return null
  const metricId = p.successMetrics.includes(choice.metric) && choice.metric.startsWith(`${complex.id}.`)
    ? choice.metric
    : p.successMetrics.find(m => m === `${complex.id}.time`) ?? null
  if (!metricId) return null
  const key = metricId.slice(complex.id.length + 1) as MetricKey
  const m = METRICS[key], st = p.stats[complex.id][key]
  if (st.median == null || !m.better) return null
  const f = formatters(p.units)
  const baseline = st.median
  // Spread targets aim to halve the spread; others step toward the best pass.
  let best: number
  if (m.spreadOf) best = baseline / 2
  else {
    const exec = st.bestExec
    const beatsMedian = exec != null && (m.better === 'higher' ? exec > baseline : exec < baseline)
    best = beatsMedian ? exec! : st.best ?? baseline
  }
  const target = choice.target === 'best' ? best : baseline + (best - baseline) / 2
  const refLap = p.laps.find(l => l.id === choice.reference_lap) ?? p.laps.find(l => l.id === p.stats[complex.id].time.bestLap)
  return {
    id,
    complexId: complex.id, complexName: complex.name, complexStartM: complex.startM, complexEndM: complex.endM,
    ref: complex.corners[0] ?? (complex.id.startsWith('C-') ? complex.id.slice(2) : complex.id),
    phase: choice.phase, change: choice.change, why: choice.why, cue: choice.cue,
    metric: metricId, metricLabel: m.label, better: m.better, unit: m.unit,
    baseline, best, target,
    display: { baseline: f.value(m.unit, baseline), best: f.value(m.unit, best), target: f.value(m.unit, target) },
    referenceLap: refLap?.label ?? '',
    confidence: (['low', 'medium', 'high'] as const).find(c => c === choice.confidence) ?? 'medium',
    evidence: choice.evidence.filter(id => id in p.evidence),
  }
}

// Measure a focus item on laps driven after it was set. Uses the complex
// bounds saved with the item, so later edits to the track do not move it.
export function checkFocus(item: FocusItem, laps: Array<{ series: LapSeries; representative: boolean; label: string }>, reportId: string, createdAt: string, system: UnitSystem): FocusCheck {
  const f = formatters(system)
  const key = item.metric.slice(item.complexId.length + 1) as MetricKey
  const m = METRICS[key]
  // A complex named after a corner has phases; a straight has only time.
  const corners = item.ref && item.ref !== item.complexId ? [item.ref] : []
  const def: ComplexDef = { id: item.complexId, name: item.complexName, startM: item.complexStartM, endM: item.complexEndM, corners }
  const values = laps.filter(l => l.representative).map(l => {
    const phase = complexPhases(l.series, [def])[0]
    return METRICS[m?.spreadOf ?? key]?.value?.(phase) ?? null
  }).filter((v): v is number => v != null && Number.isFinite(v))
  const current = !m ? null : m.spreadOf ? stdev(values) : median(values)
  let verdict: FocusCheck['verdict'] = 'not_measured'
  if (current != null && values.length >= 2) {
    const sign = item.better === 'higher' ? 1 : -1
    const progress = (current - item.baseline) * sign
    const needed = Math.abs(item.target - item.baseline)
    // Lap-to-lap noise is often as large as the gap being closed, so "worse"
    // needs a move away of at least the whole gap; "improved" a third of it.
    if ((current - item.target) * sign >= 0) verdict = 'met'
    else if (progress >= needed * 0.3 && progress > 0) verdict = 'improved'
    else if (progress <= -Math.max(needed, 1e-9)) verdict = 'worse'
    else verdict = 'no_change'
  }
  return {
    focusId: item.id, reportId, reportCreatedAt: createdAt, complexName: item.complexName, ref: item.ref,
    metricLabel: item.metricLabel, cue: item.cue, verdict, current, laps: values.length,
    display: { baseline: item.display.baseline, target: item.display.target, current: current == null ? '—' : f.value(item.unit, current) },
    sessions: [...new Set(laps.map(l => l.label.split(' · ')[0]))],
  }
}

export interface StoredFocus { reportId: string; createdAt: string; latestSessionStart: string | null; items: FocusItem[] }

// The most recent report with focus items for this car, layout and driver.
export async function latestFocus(con: DuckDBConnection, context: Pick<CoachingContext, 'vehicleGuid' | 'meanLineGuid' | 'account'>, before?: string | null): Promise<StoredFocus | null> {
  const reports = await rows(con, `
    SELECT id, CAST(created_at AS VARCHAR) AS created_at, parsed_result, review_result
    FROM coaching_sessions WHERE parsed_result IS NOT NULL OR review_result IS NOT NULL
    ORDER BY created_at DESC LIMIT 200
  `)
  for (const r of reports) {
    const result = r.parsed_result ? JSON.parse(String(r.parsed_result)) : r.review_result ? JSON.parse(String(r.review_result)) : null
    const ctx: CoachingContext | undefined = result?.context
    const items: FocusItem[] = result?.focus ?? []
    if (!ctx || !items.length) continue
    if (ctx.vehicleGuid !== context.vehicleGuid || ctx.meanLineGuid !== context.meanLineGuid || ctx.account !== context.account) continue
    if (before && ctx.latestSessionStart && ctx.latestSessionStart >= before) continue
    return { reportId: String(r.id), createdAt: String(r.created_at), latestSessionStart: ctx.latestSessionStart, items }
  }
  return null
}

async function checkPreviousFocus(con: DuckDBConnection, p: CoachPacket): Promise<CoachPacket['previousFocus']> {
  const newest = p.sessions.at(-1)?.start ?? null
  const stored = await latestFocus(con, p.context, newest)
  if (!stored) return []
  // Only sessions driven after the report's own sessions count as attempts.
  const after = p.laps.filter(l => !stored.latestSessionStart || (l.sessionStart ?? '') > stored.latestSessionStart)
  if (!after.length) return []
  const measured: Array<{ series: LapSeries; representative: boolean; label: string }> = []
  for (const lap of after) measured.push({ series: await fetchLapSeries(con, lap.sg, lap.lapIndex), representative: lap.representative, label: lap.label })
  return stored.items.map(item => ({ item, check: checkFocus(item, measured, stored.reportId, stored.createdAt, p.units) }))
}

// ─── Prompt rendering ───────────────────────────────────────────────────────

export function renderPacket(p: CoachPacket): string {
  const f = formatters(p.units)
  const out: string[] = []
  const table = (head: string[], body: string[][]) => {
    out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map(r => `| ${r.join(' | ')} |`), '')
  }
  out.push(`## ${p.trackLabel} · ${p.vehicleLabel}`, '')
  out.push(`Lap filter: ${lapFilterPhrase(p.context.lapFilter)} (valid laps only). Invalid, flagged and driver-excluded laps are removed. Representative laps are within 5% of their session best and within 4% of the fastest lap; statistics use representative laps only. Speeds in ${f.spdU}; distances in metres from the start line.`, '')

  out.push('### Pace', '')
  for (const id of ['pace.best', 'pace.median', 'pace.ideal', 'pace.pb', 'pace.garmin_optimal', 'pace.lap_number']) {
    if (p.evidence[id]) out.push(`- [${id}] ${p.evidence[id]}`)
  }
  out.push('')

  out.push('### Sessions', '')
  table(['ID', 'Start', 'Weather', 'Temp', 'Wind', 'Best', 'Median ± spread', 'Laps', 'Driver notes'], p.sessions.map(s => [
    `session.${s.id}`, s.label, s.weather ?? '—', f.temp(s.tempC), f.wind(s.windMps, s.windDeg),
    f.lapTime(s.bestMs), `${f.lapTime(s.medianMs)} ±${f.value('ms', s.spreadMs)}`, String(s.laps), s.notes ?? '—',
  ]))

  out.push('### Laps', '')
  table(['ID', 'Lap', 'Time', 'Representative'], p.laps.map(l => [`lap.${l.id}`, l.label, f.lapTime(l.durationMs), l.representative ? 'yes' : 'no']))

  out.push(`### Corner complexes (braking zone to braking zone${p.complexSource === 'segments' ? '; Garmin segments stand in because this layout has no named corners' : ''})`, '')
  table(['ID', 'Complex', 'Distance', 'Best', 'Median', 'Median gap', 'Spread', 'On fastest lap', 'Best pass'], p.complexes.map(c => {
    const t = p.stats[c.id].time
    return [c.id, c.name, `${c.startM}–${c.endM} m`, f.value('ms', t.best), f.value('ms', t.median),
      t.median != null && t.best != null ? f.value('ms', t.median - t.best) : '—', `±${f.value('ms', t.spread)}`,
      f.value('ms', t.onBestLap), t.bestLap ? p.laps.find(l => l.id === t.bestLap)?.label ?? '—' : '—']
  }))

  out.push('### Phases by complex (median · best pass)', '')
  out.push('Braking and throttle are inferred from longitudinal g (no pedal sensors). Braking point, release and minimum location are metres from the start line. "Coasting" is the distance between brake release and sustained throttle.', '')
  const phaseKeys: MetricKey[] = ['brake_onset', 'brake_peak', 'brake_release', 'vmin', 'vmin_at', 'throttle_at', 'neutral', 'exit100', 'exit200']
  table(['Complex', ...phaseKeys.map(k => METRICS[k].label)], p.complexes.map(c => [
    c.id, ...phaseKeys.map(k => {
      const st = p.stats[c.id][k]
      if (st.median == null) return '—'
      return `${f.value(METRICS[k].unit, st.median)} · ${f.value(METRICS[k].unit, st.bestExec)}`
    }),
  ]))

  if (p.opportunities.length) {
    out.push('### Largest repeatable opportunities', '')
    for (const o of p.opportunities) out.push(`- [${o.complexId}.compare] ${p.evidence[`${o.complexId}.compare`]}`)
    out.push('')
  }

  if (p.previousFocus.length) {
    out.push('### Last focus and what happened', '')
    for (const { item } of p.previousFocus) out.push(`- [focus.${item.id}] ${p.evidence[`focus.${item.id}`]} Change asked: ${item.change}`)
    out.push('')
  }

  out.push('### Evidence IDs for per-complex metrics', '')
  out.push('Each complex has IDs `<complex>.<metric>` for: ' + (Object.keys(METRICS) as MetricKey[]).map(k => `${k} (${METRICS[k].label.toLowerCase()})`).join(', ') + '. The full text of every ID is below.', '')
  for (const c of p.complexes) {
    for (const key of Object.keys(METRICS) as MetricKey[]) {
      const id = `${c.id}.${key}`
      if (p.evidence[id]) out.push(`- [${id}] ${p.evidence[id]}`)
    }
  }
  out.push('')
  return out.join('\n')
}

// ─── Driver context ─────────────────────────────────────────────────────────

// Remove research essays and source lists from a Garage document: the coach
// needs dated facts about the car, not background reading.
export function stripResearch(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let skipLevel = 0
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      if (skipLevel && level <= skipLevel) skipLevel = 0
      if (!skipLevel && /research|sources|references|further reading/i.test(heading[2])) { skipLevel = level; continue }
    }
    if (!skipLevel) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
