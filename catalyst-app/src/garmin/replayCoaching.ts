// Coaching for the 3D replay (replay:coaching): every coaching note that
// applies to one session, placed by distance along its mean line (the replay
// scene's metres), with each lap's brake, minimum-speed and throttle points
// per corner and suggested lines in lat/lon.
//
// Sources, most authoritative first: the AI coach's Session Review report for
// this session and the latest Analysis report that included it; the coach's
// previous focus, measured on this session's laps; Session Review's clear
// changes against matched sessions; and the session's own laps (the best pass
// through each corner against the median, as the coaching packet reports it).
// Read-only: nothing is computed that Session Review or the coach would not.

import type { DuckDBConnection } from '@duckdb/node-api'
import type { ReviewCoachResult, SessionReviewResponse } from '../shared/review.js'
import type { CoachAnnotation, CoachingResult, CoachLineWaypoint, FocusItem, FocusStatus, FocusVerdict } from '../shared/types.js'
import { speedFromMph, speedUnitLabel, type UnitSystem } from '../shared/units.js'
import {
  COACH_SOURCE_ORDER,
  type ReplayCoaching, type ReplayCoachingSourceInfo, type ReplayCoachLine, type ReplayCoachMarks,
  type ReplayCoachNote, type ReplayCoachPoint, type ReplayCoachTarget,
} from '../shared/replayCoaching.js'
import { fetchSessionMeta, formatters } from './coachPacket.js'
import { focusForSession } from './focusService.js'
import { fetchLapSamples, fetchValidLaps, representativeKeys, seriesFromSamples, shortSessionLabel, type LapSamples } from './lapData.js'
import { cornerPhases, median, plausibleMin, segmentBounds, spanTimeMs, type LapSeries, type SplitBound } from './lapPhases.js'
import { buildTrackGeometry } from './trackGeometry.js'
import { layoutForSession } from './trackStore.js'
import type { TrackCorner } from './trackYaml.js'

// A corner's window: from up to this far before it (its braking) to this far
// past it (its exit), never past the neighbouring apexes.
const WINDOW_BEFORE_M = 220
const WINDOW_AFTER_M = 80
// "Time to find" points: corners where the best pass beats the median by this
// much (over at least MIN_LAPS representative laps), the largest few.
const NOTE_GAP_MS = 100
const NOTE_MAX = 4
const MIN_LAPS = 3
// Suggested lines are sent at this spacing; sector changes blend over BLEND_M.
const LINE_STEP_M = 2
const BLEND_M = 30
const R_EARTH = 6_378_137
const DEG = Math.PI / 180

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const round = (v: number, places: number) => { const f = 10 ** places; return Math.round(v * f) / f }
const roundOrNull = (v: number | null | undefined, places = 1) => (finite(v) ? round(v, places) : null)

async function rows(con: DuckDBConnection, sql: string, params: unknown[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params as any[])).getRowObjectsJson() as any[]
}

const parse = <T>(value: unknown): T | null => {
  if (value == null) return null
  if (typeof value === 'object') return value as T
  try { return JSON.parse(String(value)) as T } catch { return null }
}

interface LapData { index: number; label: string; representative: boolean; samples: LapSamples; series: LapSeries; durationMs: number }

interface Draft {
  id: string
  ref: string
  title: string
  atM: number | null
  startM: number | null
  endM: number | null
  windowM: [number, number] | null
  notes: ReplayCoachNote[]
  targets: ReplayCoachTarget[]
  corner: TrackCorner | null
}

const VERDICT_WORDS: Record<FocusVerdict, string> = { met: 'Focus met', improved: 'Focus improving', no_change: 'Focus: no change yet', worse: 'Focus slipped', not_measured: 'Focus not measured' }
const VERDICT_TONE: Record<FocusVerdict, ReplayCoachNote['tone']> = { met: 'gain', improved: 'gain', no_change: 'coach', worse: 'loss', not_measured: 'coach' }

/** A short line from advice: its first sentence, cut to a label's length. */
function shortLine(text: string, max = 64): string {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? ''
  const clean = first.replace(/[.!]$/, '')
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).replace(/\s+\S*$/, '')}…`
}

export async function replayCoaching(
  con: DuckDBConnection,
  sessionGuid: string,
  units: UnitSystem,
  { review = null }: { review?: SessionReviewResponse | null } = {},
): Promise<ReplayCoaching> {
  const [meta] = await fetchSessionMeta(con, [sessionGuid])
  if (!meta) throw new Error('That session is not in your workspace.')
  const f = formatters(units)
  const layout = await layoutForSession(con, meta)
  const corners = (layout?.corners ?? [])
    .filter(c => finite(c.apex_idx) && finite(c.dist_idx_start) && finite(c.dist_idx_end))
    .sort((a, b) => a.apex_idx - b.apex_idx)

  // ── The session's valid laps ──────────────────────────────────────────
  const valid = (await fetchValidLaps(con, [sessionGuid])).sort((a, b) => a.lapIndex - b.lapIndex)
  const representative = representativeKeys(valid)
  const laps: LapData[] = []
  for (const lap of valid) {
    const samples = await fetchLapSamples(con, sessionGuid, lap.lapIndex)
    if (samples.dist.length < 10) continue
    laps.push({
      index: lap.lapIndex, label: `L${lap.lapIndex + 1}`, representative: representative.has(`${sessionGuid}:${lap.lapIndex}`),
      samples, series: seriesFromSamples(samples), durationMs: lap.durationMs,
    })
  }
  const lapEndM = Math.max(0, ...laps.map(l => l.series.dist.at(-1) ?? 0))
  const totalM = finite(layout?.totalDistM) && layout!.totalDistM! > 0 ? layout!.totalDistM! : lapEndM

  // ── Each corner's marks on every lap ──────────────────────────────────
  const windows = new Map<string, [number, number]>()
  corners.forEach((c, i) => {
    const prev = i > 0 ? corners[i - 1].apex_idx : 0
    const next = i + 1 < corners.length ? corners[i + 1].apex_idx : totalM || Infinity
    windows.set(c.turn, [Math.max(0, prev, c.dist_idx_start - WINDOW_BEFORE_M), Math.min(next, c.dist_idx_end + WINDOW_AFTER_M)])
  })
  const marks = new Map<string, Map<number, ReplayCoachMarks>>(corners.map(c => [c.turn, new Map()]))
  for (const lap of laps) {
    if (!corners.length) break
    for (const phase of cornerPhases(lap.series, corners, totalM)) {
      const [w0, w1] = windows.get(phase.turn)!
      marks.get(phase.turn)!.set(lap.index, {
        brakeM: roundOrNull(phase.braking?.onsetM), vminM: roundOrNull(phase.vminM), vminMps: roundOrNull(phase.vminMps, 2),
        throttleM: roundOrNull(phase.throttleM), timeMs: roundOrNull(spanTimeMs(lap.series, w0, w1), 0),
      })
    }
  }
  const repIndexes = new Set(laps.filter(l => l.representative).map(l => l.index))
  const referenceFor = (turn: string) => {
    const byLap = marks.get(turn)
    if (!byLap) return { reference: null, medianTimeMs: null, repCount: 0 }
    const times = [...byLap.entries()].filter(([i, m]) => repIndexes.has(i) && finite(m.timeMs)) as Array<[number, ReplayCoachMarks & { timeMs: number }]>
    const best = plausibleMin(times.map(([, m]) => m.timeMs))
    const hit = best == null ? undefined : times.find(([, m]) => m.timeMs === best)
    return {
      reference: hit ? { ...hit[1], lap: hit[0], label: `L${hit[0] + 1}` } : null,
      medianTimeMs: roundOrNull(median(times.map(([, m]) => m.timeMs)), 0),
      repCount: times.length,
    }
  }

  // ── Points, by corner (or segment, or the session) ────────────────────
  const bounds: SplitBound[] = segmentBounds(layout?.segments ?? [], totalM)
  const drafts = new Map<string, Draft>()
  const cornerFor = (ref: string) => {
    const turn = ref.replace(/^corner:/, '')
    return corners.find(c => c.turn === turn) ?? corners.find(c => c.turn.toLowerCase() === turn.toLowerCase()) ?? null
  }
  const draftFor = (rawRef: string | null | undefined): Draft => {
    const ref = (rawRef ?? '').trim()
    const corner = ref && ref !== 'session' ? cornerFor(ref) : null
    if (corner) {
      const id = `corner:${corner.turn}`
      let d = drafts.get(id)
      if (!d) {
        const named = corner.name && corner.name !== corner.turn ? ` · ${corner.name}` : ''
        d = { id, ref: corner.turn, title: `${corner.turn}${named}`, atM: corner.apex_idx, startM: corner.dist_idx_start, endM: corner.dist_idx_end, windowM: windows.get(corner.turn) ?? null, notes: [], targets: [], corner }
        drafts.set(id, d)
      }
      return d
    }
    const segment = ref ? bounds.find(b => b.id === ref.replace(/^segment:/, '')) : undefined
    if (segment) {
      const id = `segment:${segment.id}`
      let d = drafts.get(id)
      if (!d) {
        d = { id, ref: segment.id, title: `Sector ${segment.id}`, atM: Math.min(segment.endM, segment.startM + 40), startM: segment.startM, endM: segment.endM, windowM: [segment.startM, segment.endM], notes: [], targets: [], corner: null }
        drafts.set(id, d)
      }
      return d
    }
    let d = drafts.get('session')
    if (!d) { d = { id: 'session', ref: '', title: 'Whole session', atM: null, startM: null, endM: null, windowM: null, notes: [], targets: [], corner: null }; drafts.set('session', d) }
    return d
  }
  const addNote = (ref: string | null | undefined, note: ReplayCoachNote) => {
    const d = draftFor(ref)
    // The same advice twice (a priority and its focus item) is said once.
    if (!d.notes.some(n => n.source === note.source && n.headline === note.headline)) d.notes.push(note)
    return d
  }
  const addTarget = (ref: string | null | undefined, target: ReplayCoachTarget) => {
    if (!finite(target.atM)) return
    const d = draftFor(ref)
    if (d.id !== 'session' && !d.targets.some(t => t.kind === target.kind && Math.abs(t.atM - target.atM) < 2)) d.targets.push({ ...target, atM: round(target.atM, 1) })
  }
  const sources: ReplayCoachingSourceInfo[] = []

  const focusNote = (item: FocusItem) => {
    addNote(item.ref, {
      source: 'coach', tone: 'coach', headline: shortLine(item.cue || item.change),
      text: [item.change, `Target: ${item.metricLabel.toLowerCase()} ${item.display.target} (median ${item.display.baseline}).`].filter(Boolean).join(' '),
    })
    // A throttle-point target is a place on the track.
    if (item.metric.endsWith('.throttle_at')) addTarget(item.ref, { kind: 'throttle', atM: item.target, label: 'Coach: throttle' })
  }

  // 1. The AI coach on this session in Session Review (whatever state the review is in now).
  const reviewReport = await reviewCoachReport(con, sessionGuid)
  if (reviewReport) {
    for (const p of reviewReport.result.priorities ?? []) {
      addNote(p.ref, { source: 'coach', tone: 'coach', headline: shortLine(p.cue || p.advice), text: [p.advice, p.successMetric && `Success: ${p.successMetric}`].filter(Boolean).join(' ') })
    }
    for (const item of reviewReport.result.focus ?? []) focusNote(item)
    // Written for an older snapshot of this session's review (as Session Review flags it).
    const stale = !!review?.snapshot && !!reviewReport.revision && reviewReport.revision !== review.snapshot.revision
    sources.push({ source: 'coach', label: `AI coach · Session Review, ${shortSessionLabel(reviewReport.createdAt)}`, reportId: reviewReport.id, createdAt: reviewReport.createdAt, stale })
  }

  // 2. The latest Analysis coaching report that included this session.
  const analysis = await analysisReport(con, sessionGuid)
  let coachLineWaypoints: CoachLineWaypoint[] = []
  if (analysis) {
    const result = analysis.result
    for (const tip of result.tips ?? []) {
      const ref = tip.ref ?? tip.annotations?.find(a => a.ref)?.ref ?? null
      addNote(ref, { source: 'coach', tone: 'coach', headline: shortLine(tip.cue || tip.body), text: [tip.body, tip.success_metric && `Success: ${tip.success_metric}`].filter(Boolean).join(' ') })
    }
    for (const a of result.annotations ?? []) annotationTargets(a, units, addTarget, addNote)
    for (const item of result.focus ?? []) focusNote(item)
    coachLineWaypoints = (result.coach_line ?? []).filter(w => finite(w?.dist_m) && finite(w?.delta))
    sources.push({ source: 'coach', label: `AI coach · ${analysis.title}`, reportId: analysis.id, createdAt: analysis.createdAt })
  }

  // 3. The focus that applied going into this session, measured on its laps.
  let focus: FocusStatus | null = null
  try { focus = await focusForSession(con, sessionGuid, units) } catch (error) {
    console.warn('[replay] focus unavailable:', error instanceof Error ? error.message : error)
  }
  if (focus?.checks.length) {
    for (const check of focus.checks) {
      const item = focus.items.find(i => i.id === check.focusId)
      addNote(check.ref || item?.ref, {
        source: 'focus', tone: VERDICT_TONE[check.verdict], verdict: check.verdict,
        headline: check.current == null ? VERDICT_WORDS[check.verdict] : `${VERDICT_WORDS[check.verdict]} · ${check.display.current} (target ${check.display.target})`,
        text: `Last focus “${check.cue}” (${check.metricLabel.toLowerCase()}): ${check.display.baseline} → target ${check.display.target}; this session ${check.display.current} over ${check.laps} laps.`,
      })
    }
    sources.push({ source: 'focus', label: `Focus from “${focus.reportTitle}”, ${shortSessionLabel(focus.createdAt)}`, reportId: focus.reportId, createdAt: focus.createdAt })
  }

  // 4. Session Review: clear changes against matched sessions.
  const snapshot = review?.state === 'ready' ? review.snapshot : null
  if (snapshot) {
    let count = 0
    const kind = corners.length ? 'corner' : 'segment'
    for (const r of snapshot.regions) {
      const change = r.metrics.timeMs.clearChange, delta = r.metrics.timeMs.delta
      if (r.region.kind !== kind || !change || !finite(delta)) continue
      const v = r.region, m = r.metrics
      const speed = (a: number | null, b: number | null) => `${f.value('mps', a)} vs ${f.value('mps', b)}`
      addNote(r.region.id, {
        source: 'review', tone: change === 'regression' ? 'loss' : 'gain',
        headline: `${f.value('ms', delta, true)} vs recent sessions`,
        text: `Clear ${change} against ${r.baselineSessions.length} matched sessions: ${f.value('ms', v.timeMs)} vs ${f.value('ms', m.timeMs.baseline)}. Minimum speed ${speed(v.vminMps, m.vminMps.baseline)}; exit ${speed(v.exitMps, m.exitMps.baseline)}.`,
      })
      count++
    }
    if (count) sources.push({ source: 'review', label: `Session Review · clear changes against ${snapshot.baseline.length} matched sessions` })
  }

  // 5. The session's laps: the best pass through a corner against the median.
  const gaps = corners.map(c => ({ c, ...referenceFor(c.turn) }))
    .filter(g => g.reference && g.medianTimeMs != null && g.repCount >= MIN_LAPS)
    .map(g => ({ ...g, gapMs: g.medianTimeMs! - g.reference!.timeMs! }))
  const noted = new Set(gaps.filter(g => g.gapMs >= NOTE_GAP_MS).sort((a, b) => b.gapMs - a.gapMs).slice(0, NOTE_MAX).map(g => g.c.turn))
  let lapNotes = 0
  for (const g of gaps) {
    const id = `corner:${g.c.turn}`
    if (!noted.has(g.c.turn) && !(drafts.has(id) && g.gapMs >= 50)) continue
    const how = describeBest(g.c.turn, marks, repIndexes, g.reference!, f)
    addNote(g.c.turn, {
      source: 'laps', tone: 'note', headline: `${f.value('ms', g.gapMs)} to find${how.length ? ` · ${how[0].short}` : ''}`,
      text: `Your best pass here (${g.reference!.label}) was ${f.value('ms', g.gapMs)} quicker than your median over ${g.repCount} laps${how.length ? `: it ${how.map(h => h.long).join(', ')}` : ''}.`,
    })
    lapNotes++
  }
  if (lapNotes) sources.push({ source: 'laps', label: `Your laps · best pass against the median over ${repIndexes.size} representative laps` })

  // ── Assemble ──────────────────────────────────────────────────────────
  const points: ReplayCoachPoint[] = [...drafts.values()].filter(d => d.notes.length).map((d): ReplayCoachPoint => {
    const notes = [...d.notes].sort((a, b) => COACH_SOURCE_ORDER.indexOf(a.source) - COACH_SOURCE_ORDER.indexOf(b.source))
    const turn = d.corner?.turn
    const { reference, medianTimeMs } = turn ? referenceFor(turn) : { reference: null, medianTimeMs: null }
    // The stretch to highlight starts where the best pass braked.
    const startM = d.startM == null ? null : round(Math.max(d.windowM?.[0] ?? -Infinity, Math.min(d.startM, (reference?.brakeM ?? Infinity) - 10)), 1)
    return {
      id: d.id, ref: d.ref, title: d.title, tone: notes[0].tone, headline: notes[0].headline, notes,
      atM: d.atM == null ? null : round(d.atM, 1), startM, endM: d.endM == null ? null : round(d.endM, 1),
      windowM: d.windowM ? [round(d.windowM[0], 1), round(d.windowM[1], 1)] : null,
      reference, medianTimeMs,
      laps: turn ? Object.fromEntries([...(marks.get(turn) ?? new Map()).entries()].map(([i, m]) => [String(i), m])) : {},
      targets: d.targets.sort((a, b) => a.atM - b.atM),
    }
  }).sort((a, b) => (a.startM ?? Infinity) - (b.startM ?? Infinity))

  const lines: ReplayCoachLine[] = []
  const coachLine = coachLineFrom(coachLineWaypoints, laps, meta.mean_line_guid)
  if (coachLine) lines.push(coachLine)
  const bestSectors = bestSectorLine(laps, bounds, totalM)
  if (bestSectors) lines.push(bestSectors)

  return { sessionGuid, units, sources, points, lines }
}

/** What the best pass did differently from the median: brake, minimum speed, throttle. */
function describeBest(turn: string, marks: Map<string, Map<number, ReplayCoachMarks>>, rep: Set<number>, best: ReplayCoachMarks, f: ReturnType<typeof formatters>): Array<{ short: string; long: string }> {
  const own = [...(marks.get(turn)?.entries() ?? [])].filter(([i]) => rep.has(i)).map(([, m]) => m)
  const mid = (key: keyof ReplayCoachMarks) => median(own.map(m => m[key]).filter(finite))
  const parts: Array<{ short: string; long: string }> = []
  const brake = mid('brakeM'), vmin = mid('vminMps'), throttle = mid('throttleM')
  if (best.brakeM != null && brake != null && Math.abs(best.brakeM - brake) >= 3) {
    const m = `${Math.round(Math.abs(best.brakeM - brake))} m ${best.brakeM > brake ? 'later' : 'earlier'}`
    parts.push({ short: `brake ${m}`, long: `braked ${m}` })
  }
  if (best.vminMps != null && vmin != null && Math.abs(best.vminMps - vmin) >= 0.2) {
    const v = f.value('mps', best.vminMps - vmin, true)
    parts.push({ short: `${v} minimum`, long: `carried ${v} minimum speed` })
  }
  if (best.throttleM != null && throttle != null && Math.abs(best.throttleM - throttle) >= 4) {
    const m = `${Math.round(Math.abs(best.throttleM - throttle))} m ${best.throttleM < throttle ? 'sooner' : 'later'}`
    parts.push({ short: `throttle ${m}`, long: `picked up the throttle ${m}` })
  }
  return parts
}

/** Apex and minimum-speed targets from an Analysis report's corner annotations. */
function annotationTargets(a: CoachAnnotation, units: UnitSystem,
  addTarget: (ref: string, t: ReplayCoachTarget) => void, addNote: (ref: string, n: ReplayCoachNote) => unknown) {
  if (!a?.ref) return
  if (finite(a.recommended_apex_dist_m)) addTarget(a.ref, { kind: 'apex', atM: a.recommended_apex_dist_m, label: 'Coach: apex' })
  const targetMph = a.target_vmin_mph ?? a.target_apex_mph ?? (finite(a.target_apex_mps) ? a.target_apex_mps * 2.23694 : null)
  if (a.type === 'corner_tip' && finite(targetMph)) {
    const unit = speedUnitLabel(units)
    addNote(a.ref, { source: 'coach', tone: 'coach', headline: `Target minimum ${Math.round(speedFromMph(targetMph, units))} ${unit}`, text: a.body })
  }
}

async function reviewCoachReport(con: DuckDBConnection, sessionGuid: string): Promise<{ id: string; createdAt: string; revision: string | null; result: ReviewCoachResult } | null> {
  const [r] = await rows(con, `
    SELECT id, CAST(created_at AS VARCHAR) AS created_at, review_context, review_result FROM coaching_sessions
    WHERE review_result IS NOT NULL AND json_extract_string(review_context, '$.sessionGuid') = ?
    ORDER BY created_at DESC LIMIT 1
  `, [sessionGuid]).catch(() => [])
  const result = r ? parse<ReviewCoachResult>(r.review_result) : null
  if (!r || !result) return null
  const context = parse<{ revision?: string }>(r.review_context)
  return { id: String(r.id), createdAt: String(r.created_at), revision: typeof context?.revision === 'string' ? context.revision : null, result }
}

async function analysisReport(con: DuckDBConnection, sessionGuid: string): Promise<{ id: string; title: string; createdAt: string; result: CoachingResult } | null> {
  const found = await rows(con, `
    SELECT id, title, CAST(created_at AS VARCHAR) AS created_at, session_guids, parsed_result FROM coaching_sessions
    WHERE parsed_result IS NOT NULL AND review_context IS NULL AND CAST(session_guids AS VARCHAR) LIKE ?
    ORDER BY created_at DESC LIMIT 20
  `, [`%${sessionGuid}%`]).catch(() => [])
  for (const r of found) {
    const guids = parse<unknown[]>(r.session_guids)
    const result = parse<CoachingResult>(r.parsed_result)
    if (Array.isArray(guids) && guids.includes(sessionGuid) && result) return { id: String(r.id), title: String(r.title || 'Coaching report'), createdAt: String(r.created_at), result }
  }
  return null
}

// ─── Lines ──────────────────────────────────────────────────────────────────

/** Lat/lon on a lap at a distance (samples ascend in distance), or null off its ends or across a gap. */
function latLonAt(s: LapSamples, d: number): [number, number] | null {
  const xs = s.dist
  if (!xs.length || d < xs[0] || d > xs[xs.length - 1]) return null
  let lo = 0, hi = xs.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= d) lo = mid; else hi = mid }
  const a = [s.lat[lo], s.lon[lo]], b = [s.lat[hi], s.lon[hi]]
  if (!a.every(finite) || !b.every(finite)) return a.every(finite) ? [a[0]!, a[1]!] : b.every(finite) ? [b[0]!, b[1]!] : null
  if (xs[hi] - xs[lo] > 25) return null
  const t = xs[hi] > xs[lo] ? Math.min(1, Math.max(0, (d - xs[lo]) / (xs[hi] - xs[lo]))) : 0
  return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t]
}

/**
 * The best-sector line: in each of Garmin's sectors, the line of the lap that
 * drove it quickest (the Analysis map's "optimal line"), blended over the last
 * metres before a sector whose best lap differs.
 */
function bestSectorLine(laps: LapData[], bounds: SplitBound[], totalM: number): ReplayCoachLine | null {
  if (laps.length < 2 || bounds.length < 2) return null
  const rep = laps.filter(l => l.representative)
  const winners = bounds.map(b => {
    const times = laps.map(l => spanTimeMs(l.series, b.startM, b.endM))
    const best = plausibleMin(times, rep.map(l => spanTimeMs(l.series, b.startM, b.endM)))
    return best == null ? null : laps[times.indexOf(best)]
  })
  if (winners.some(w => !w)) return null
  const line: ReplayCoachLine = { id: 'best-sectors', label: 'Best-sector line', detail: '', dist: [], lat: [], lon: [] }
  const end = Math.min(totalM || Infinity, bounds.at(-1)!.endM)
  for (let d = Math.max(0, bounds[0].startM); d <= end; d += LINE_STEP_M) {
    let i = bounds.findIndex(b => d >= b.startM && d < b.endM)
    if (i < 0) i = bounds.length - 1
    let p = latLonAt(winners[i]!.samples, d)
    const next = winners[i + 1]
    if (p && next && next !== winners[i] && bounds[i].endM - d < BLEND_M) {
      const q = latLonAt(next.samples, d)
      const t = 1 - (bounds[i].endM - d) / BLEND_M
      if (q) p = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    }
    if (!p) continue
    line.dist.push(round(d, 1)); line.lat.push(round(p[0], 8)); line.lon.push(round(p[1], 8))
  }
  if (line.dist.length < 10) return null
  const byLap = new Map<string, string[]>()
  winners.forEach((w, i) => byLap.set(w!.label, [...(byLap.get(w!.label) ?? []), bounds[i].id]))
  line.detail = `Your quickest lap through each of Garmin’s ${bounds.length} sectors: ${[...byLap.entries()].map(([lap, ids]) => `${lap} (${ids.join(', ')})`).join(' · ')}.`
  return line
}

/**
 * An Analysis report's suggested line (coach_line waypoints: a shift across
 * the road from the session's best lap, in road widths, + toward the right
 * edge), from the first waypoint to the last.
 */
function coachLineFrom(waypoints: CoachLineWaypoint[], laps: LapData[], meanLineGuid: string | null): ReplayCoachLine | null {
  if (waypoints.length < 2 || !laps.length) return null
  const best = laps.reduce((a, b) => (b.durationMs < a.durationMs ? b : a))
  const widthM = (meanLineGuid ? buildTrackGeometry(meanLineGuid)?.widthM : null) ?? 10.64
  const sorted = [...waypoints].sort((a, b) => a.dist_m - b.dist_m)
  const deltaAt = (d: number) => {
    const i = sorted.findIndex(w => w.dist_m >= d)
    if (i <= 0) return i === 0 ? sorted[0].delta : sorted.at(-1)!.delta
    const a = sorted[i - 1], b = sorted[i]
    return a.delta + (b.delta - a.delta) * (d - a.dist_m) / Math.max(1e-6, b.dist_m - a.dist_m)
  }
  const line: ReplayCoachLine = { id: 'coach', label: 'Coach’s line', detail: `The AI coach’s line, as a shift across the road from your best lap (${best.label}).`, dist: [], lat: [], lon: [] }
  for (let d = sorted[0].dist_m; d <= sorted.at(-1)!.dist_m; d += LINE_STEP_M) {
    const p = latLonAt(best.samples, d), a = latLonAt(best.samples, d - 3), b = latLonAt(best.samples, d + 3)
    if (!p || !a || !b) continue
    // Heading in local metres (east, north); the right of travel is (north, −east).
    const cos = Math.cos(p[0] * DEG)
    const east = (b[1] - a[1]) * cos, north = b[0] - a[0], len = Math.hypot(east, north)
    if (!(len > 0)) continue
    const shift = deltaAt(d) * widthM
    const rightE = north / len, rightN = -east / len
    line.dist.push(round(d, 1))
    line.lat.push(round(p[0] + rightN * shift / (R_EARTH * DEG), 8))
    line.lon.push(round(p[1] + rightE * shift / (R_EARTH * DEG * cos), 8))
  }
  return line.dist.length >= 2 ? line : null
}

