// Driver comparison: another driver's laps overlaid on your Analysis.
//
// Each driver's backend owns its DuckDB exclusively, so one backend cannot
// read another's database. Instead the server asks the compared driver's
// backend for `exportComparison` (a read-only, self-contained copy of the
// selected laps' telemetry) and passes the result to your backend's
// buildAnalysis, which validates it and merges it with your own laps.

import fs from 'node:fs'
import { openDb } from './loadToDb.js'
import { DB_PATH } from './paths.js'
import { fetchLapSamples, fetchValidLaps, representativeKeys } from './lapData.js'
import { assertComparable, fetchSessionMeta, vehicleLabelOf } from './coachPacket.js'
import { cornerPhases, plausibleMin, spanTimeMs, valueAt, type LapSeries, type SplitBound } from './lapPhases.js'
import type { TrackCorner } from './trackStore.js'
import type { AnalysisData, ComparisonData, CornerComparisonCell, CornerComparisonRow, DriverSummary, HeatmapData, LapMeta, SegmentComparisonRow } from './analysisData.js'
import { selectLaps, type LapFilter } from '../shared/coachingScope.js'
import { MAX_COMPARE_SESSIONS } from '../shared/comparison.js'
import type { ComparisonBundle, ComparisonExport, ComparisonLap } from './comparisonBundle.js'

// Types and merging live in comparisonBundle.ts (shared with the coach packet).
export { comparisonLaps, validateComparisonBundles } from './comparisonBundle.js'
export type { ComparisonBundle, ComparisonExport, ComparisonLap, ComparisonSession } from './comparisonBundle.js'

// ---------------------------------------------------------------------------
// Export (runs in the compared driver's backend)

// The selected sessions' valid laps, narrowed by the same lap filter you use,
// with the telemetry Analysis draws. Never downloads anything: sessions whose
// telemetry is not in this workspace are reported instead.
export async function exportComparison(sessionGuids: unknown, lapFilter?: LapFilter): Promise<ComparisonExport> {
  if (!Array.isArray(sessionGuids) || !sessionGuids.length || sessionGuids.some(g => typeof g !== 'string' || !g)) {
    throw new Error('Choose at least one session to compare.')
  }
  const guids = [...new Set(sessionGuids as string[])]
  if (guids.length > MAX_COMPARE_SESSIONS) throw new Error(`Compare up to ${MAX_COMPARE_SESSIONS} sessions per driver.`)
  if (!fs.existsSync(DB_PATH)) throw new Error('That driver has not synced any telemetry yet.')
  const db = await openDb(DB_PATH)
  const con = db.con
  try {
    const meta = await fetchSessionMeta(con, guids)
    if (meta.length !== guids.length) throw new Error('Some of the compared sessions are no longer available. Choose them again.')
    assertComparable(meta, 'Driver comparison')
    const placeholders = guids.map(() => '?').join(',')
    const missing = Number((await con.runAndReadAll(
      `SELECT COUNT(*) FROM sessions WHERE session_guid IN (${placeholders}) AND NOT COALESCE(details_loaded, false)`, guids,
    )).getRowsJson()[0]?.[0] ?? 0)
    if (missing > 0) {
      throw new Error(`Telemetry for ${missing} of the compared sessions has not been downloaded. That driver can download it from their Sessions page.`)
    }
    const driven = Number((await con.runAndReadAll(
      `SELECT COUNT(*) FROM laps WHERE session_guid IN (${placeholders}) AND lap_type = 'DRIVEN'`, guids,
    )).getRowsJson()[0]?.[0] ?? 0)
    const valid = await fetchValidLaps(con, guids)
    const repKeys = representativeKeys(valid)
    const laps: ComparisonLap[] = []
    // Sequential: overlapping statements on one connection crash DuckDB.
    for (const lap of selectLaps(valid, lapFilter)) {
      laps.push({
        sg: lap.sg, lapIndex: lap.lapIndex, durationMs: lap.durationMs, sessionStart: lap.sessionStart,
        representative: repKeys.has(`${lap.sg}:${lap.lapIndex}`),
        samples: await fetchLapSamples(con, lap.sg, lap.lapIndex),
      })
    }
    return {
      sessions: [...meta].reverse().map(m => ({
        sg: m.session_guid, start: m.start, bestLapMs: m.best_lap_ms,
        trackName: m.track_name, configName: m.track_configuration_name,
        configurationId: m.track_configuration_id, meanLineGuid: m.mean_line_guid,
        vehicle: vehicleLabelOf(m), weather: m.weather_description, tempC: m.temperature_c,
      })),
      laps,
      excludedLapCount: Math.max(0, driven - valid.length),
    }
  } finally {
    await db.close()
  }
}

// ---------------------------------------------------------------------------
// Summary

type SpeedConv = (mps: number | null | undefined) => number | null
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const key = (lap: Pick<LapMeta, 'sg' | 'lapIdx'>) => `${lap.sg}:${lap.lapIdx}`

interface DriverInput {
  name: string
  self: boolean
  vehicle: string
  sessions: DriverSummary['sessions']
  laps: LapMeta[]
  excludedLapCount: number
}

interface DriverStats {
  summary: DriverSummary
  laps: LapMeta[]
  splits: Map<string, Array<number | null>>
  segmentBest: Array<number | null>
  bestLapSplits: Array<number | null>
  corners: Map<string, CornerComparisonCell>
}

function driverStats(index: number, input: DriverInput, series: Map<string, LapSeries>, bounds: SplitBound[], corners: TrackCorner[], totalM: number, conv: SpeedConv): DriverStats {
  const { laps } = input
  const splitsOf = (lap: LapMeta) => {
    const trace = series.get(key(lap))
    return bounds.map(b => {
      const ms = trace ? spanTimeMs(trace, b.startM, b.endM) : null
      return ms == null ? null : ms / 1000
    })
  }
  const splits = new Map(laps.map(lap => [key(lap), splitsOf(lap)]))
  const rep = laps.filter(lap => lap.representative)
  // Same rule as your theoretical best: each split's plausible best.
  const segmentBest = bounds.map((_, i) => plausibleMin(
    laps.map(lap => splits.get(key(lap))![i]),
    rep.map(lap => splits.get(key(lap))![i]),
  ))
  const best = laps.reduce<LapMeta | null>((a, b) => (!a || b.durationMs < a.durationMs ? b : a), null)
  const bestTrace = best ? series.get(key(best)) : undefined
  const topMps = bestTrace ? Math.max(...bestTrace.speed.filter(finite)) : NaN

  const cornerCells = new Map<string, CornerComparisonCell>()
  if (bestTrace && corners.length) {
    for (const phase of cornerPhases(bestTrace, corners, totalM)) {
      const corner = corners.find(c => c.turn === phase.turn)!
      const entryMps = valueAt(bestTrace, bestTrace.speed, phase.braking?.onsetM ?? corner.dist_idx_start)
      cornerCells.set(phase.turn, {
        entry: conv(entryMps), apex: conv(phase.vminMps), exit: conv(phase.exit100Mps),
        vminDistM: phase.vminM, brakeOnsetM: phase.braking?.onsetM ?? null, peakBrakeG: phase.braking?.peakG ?? null,
      })
    }
  }

  return {
    summary: {
      index, name: input.name, self: input.self, vehicle: input.vehicle, sessions: input.sessions,
      lapCount: laps.length, excludedLapCount: input.excludedLapCount,
      bestLap: best ? { sg: best.sg, lapIdx: best.lapIdx, label: best.label, durationMs: best.durationMs } : null,
      theoreticalBestMs: segmentBest.length && segmentBest.every(finite)
        ? Math.round(segmentBest.reduce<number>((a, b) => a + b!, 0) * 1000) : null,
      avgLapMs: rep.length ? Math.round(rep.reduce((a, l) => a + l.durationMs, 0) / rep.length) : null,
      avgLapCount: rep.length,
      topSpeed: Number.isFinite(topMps) ? conv(topMps) : null,
    },
    laps,
    splits,
    segmentBest,
    bestLapSplits: best ? splits.get(key(best))! : bounds.map(() => null),
    corners: cornerCells,
  }
}

const lapTime = (ms: number) => {
  const s = ms / 1000, m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`
}

// Every driver's laps × splits against the best plausible split by anyone.
// "Implausibly fast" is judged within each driver's own laps (their own
// plausible best), so a quicker driver's splits are never mistaken for cuts.
function comparisonHeatmap(stats: DriverStats[], bounds: SplitBound[]): HeatmapData | null {
  if (!bounds.length || !stats.some(d => d.laps.length)) return null
  const reference = bounds.map((_, i) => {
    let best: { value: number; driver: number } | null = null
    stats.forEach((d, driver) => {
      const v = d.segmentBest[i]
      if (v != null && (!best || v < best.value)) best = { value: v, driver }
    })
    return best as { value: number; driver: number } | null
  })
  const z: Array<Array<number | null>> = [], text: string[][] = [], rows: string[] = [], rowDrivers: number[] = []
  stats.forEach((d, driver) => {
    for (const lap of d.laps) {
      const splits = d.splits.get(key(lap)) ?? bounds.map(() => null)
      z.push(splits.map((v, i) => {
        const ref = reference[i], own = d.segmentBest[i]
        if (v == null || ref == null) return null
        if (own != null && v < own) return -1   // ignored: implausibly fast for this driver
        return Math.round((v - ref.value) * 1000) / 1000
      }))
      text.push(splits.map((v, i) => {
        const ref = reference[i], own = d.segmentBest[i]
        if (v == null || ref == null) return '—'
        if (own != null && v < own) return `${v.toFixed(2)} (ignored: implausibly fast)`
        return `${v.toFixed(2)} (+${(v - ref.value).toFixed(2)} to the best by anyone)`
      }))
      rows.push(`${lap.label}  ${lapTime(lap.durationMs)}`)
      rowDrivers.push(driver)
    }
  })
  z.push(reference.map(r => (r == null ? null : 0)))
  text.push(reference.map(r => (r == null ? '—' : `${r.value.toFixed(2)} best · ${stats[r.driver].summary.name}`)))
  rows.push('★ Best of all drivers')
  const flat = z.flat().filter((v): v is number => v != null && v >= 0)
  return {
    z, text, cols: bounds.map(b => b.id), rows, rowDrivers,
    bestDrivers: reference.map(r => r?.driver ?? null),
    zmax: flat.length ? Math.max(...flat, 0.1) : 5,
  }
}

export interface ComparisonInput {
  self: { vehicle: string; sessions: AnalysisData['sessions']; laps: LapMeta[]; excludedLapCount: number }
  others: ComparisonBundle[]
  otherLaps: LapMeta[]
  series: Map<string, LapSeries>
  bounds: SplitBound[]
  corners: TrackCorner[]
  totalDistM: number
  conv: SpeedConv
}

// You versus each compared driver: headline times, each split, and each
// corner on everyone's fastest lap.
export function buildComparison(input: ComparisonInput): ComparisonData {
  const drivers: DriverInput[] = [
    {
      name: 'You', self: true, vehicle: input.self.vehicle, laps: input.self.laps, excludedLapCount: input.self.excludedLapCount,
      sessions: input.self.sessions.map(s => ({ sg: s.sg, start: s.start, bestLapMs: s.bestLapMs, weather: s.weather, tempC: s.tempC })),
    },
    ...input.others.map((bundle, i) => ({
      name: bundle.driver, self: false,
      vehicle: [...new Set(bundle.sessions.map(s => s.vehicle))].join(', ') || 'Unknown vehicle',
      laps: input.otherLaps.filter(lap => lap.driverIndex === i + 1),
      excludedLapCount: Number(bundle.excludedLapCount) || 0,
      sessions: bundle.sessions.map(s => ({ sg: s.sg, start: s.start, bestLapMs: s.bestLapMs, weather: s.weather, tempC: s.tempC })),
    })),
  ]
  const stats = drivers.map((d, i) => driverStats(i, d, input.series, input.bounds, input.corners, input.totalDistM, input.conv))

  const segments: SegmentComparisonRow[] = input.bounds.map((b, i) => ({
    id: b.id, startM: b.startM, endM: b.endM,
    best: stats.map(s => s.segmentBest[i]),
    bestLap: stats.map(s => s.bestLapSplits[i]),
  }))

  const corners: CornerComparisonRow[] = [...input.corners]
    .sort((a, b) => a.apex_idx - b.apex_idx)
    .map(c => ({ turn: c.turn, name: c.name ?? '', apexM: c.apex_idx, drivers: stats.map(s => s.corners.get(c.turn) ?? null) }))
    .filter(row => row.drivers.some(cell => cell?.apex != null))

  return {
    drivers: stats.map(s => s.summary), segments, corners,
    heatmap: comparisonHeatmap(stats, input.bounds),
    // Filled by buildAnalysis, which owns the G-G and corner-table builders.
    gg: [], cornerRows: [], cornerBrakingRows: [],
  }
}
