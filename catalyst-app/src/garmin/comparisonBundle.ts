// What one driver's backend sends another for a comparison, and how the
// receiving backend checks and labels it. Shared by Analysis
// (analysisData.ts) and the coach packet (coachPacket.ts); the export itself
// lives in driverComparison.ts.

import { isLapSamples, lapLabel, shortSessionLabel, type LapSamples } from './lapData.js'
import type { LapMeta } from './analysisData.js'
import { sameCourse, type TrackLayoutIdentity } from '../shared/trackLayout.js'
import { MAX_COMPARE_DRIVERS } from '../shared/comparison.js'
import { isMeanLineTrace, mapToOwnLine, ownLine, remapLapSamples, type MeanLineTrace } from './meanLineAlign.js'

export interface ComparisonSession {
  sg: string
  start: string | null
  bestLapMs: number | null
  trackName: string | null
  configName: string | null
  configurationId: number | null
  meanLineGuid: string | null
  vehicle: string
  weather: string | null
  tempC: number | null
}

export interface ComparisonLap {
  sg: string
  lapIndex: number
  durationMs: number
  sessionStart: string | null
  representative: boolean
  samples: LapSamples
}

// What a compared driver's backend returns.
export interface ComparisonExport {
  sessions: ComparisonSession[]
  laps: ComparisonLap[]
  excludedLapCount: number
  // The mean line their lap distances are measured along (thinned), so the
  // receiving backend can move their laps onto its own (meanLineAlign.ts).
  line?: MeanLineTrace | null
}

// The export plus the driver's name, added by the server.
export interface ComparisonBundle extends ComparisonExport {
  driver: string
}

const layoutOf = (s: ComparisonSession): TrackLayoutIdentity => ({
  meanLineGuid: s.meanLineGuid, configurationId: s.configurationId,
  trackLabel: `${s.trackName ?? ''} · ${s.configName ?? ''}`,
})

function isBundle(value: unknown): value is ComparisonBundle {
  const b = value as ComparisonBundle
  return !!b && typeof b === 'object' && typeof b.driver === 'string' && !!b.driver
    && Array.isArray(b.sessions) && Array.isArray(b.laps)
    && b.sessions.every(s => s && typeof s.sg === 'string' && !!s.sg)
    && b.laps.every(l => l && typeof l.sg === 'string' && Number.isInteger(l.lapIndex)
      && typeof l.durationMs === 'number' && l.durationMs > 0 && isLapSamples(l.samples))
    && (b.line == null || isMeanLineTrace(b.line))
}

// Compared sessions must be on your course, and no session may appear twice:
// laps are keyed by session GUID throughout Analysis. Their mean line is
// their own device's, so the course is matched by Garmin's course ID.
export function validateComparisonBundles(bundles: unknown, own: TrackLayoutIdentity, ownGuids: string[]): asserts bundles is ComparisonBundle[] {
  if (!Array.isArray(bundles)) throw new Error('Invalid driver comparison.')
  if (bundles.length > MAX_COMPARE_DRIVERS) throw new Error(`Compare up to ${MAX_COMPARE_DRIVERS} drivers at a time.`)
  const seen = new Set(ownGuids)
  for (const bundle of bundles) {
    if (bundle && typeof bundle === 'object' && !('laps' in bundle)) {
      throw new Error('Comparing drivers needs the Catalyst server. Open Catalyst Coach in a browser and sign in with your driver name.')
    }
    if (!isBundle(bundle)) throw new Error('Comparison telemetry was incomplete. Try again.')
    const sessionIds = new Set(bundle.sessions.map(s => s.sg))
    for (const session of bundle.sessions) {
      if (!sameCourse(own, layoutOf(session))) {
        const theirs = [session.trackName, session.configName].filter(Boolean).join(' · ') || 'an unknown layout'
        throw new Error(`${bundle.driver}'s session from ${shortSessionLabel(session.start)} is on ${theirs}. Compare sessions from ${own.trackLabel || 'your course configuration'}.`)
      }
      if (seen.has(session.sg)) {
        throw new Error(`${bundle.driver}'s session from ${shortSessionLabel(session.start)} is already in this analysis. Remove it from one side.`)
      }
      seen.add(session.sg)
    }
    if (bundle.laps.some(lap => !sessionIds.has(lap.sg))) throw new Error('Comparison telemetry was incomplete. Try again.')
  }
}

// Their laps measured along your mean line, so distances, corners and
// segments mean the same spot on track for both of you. `layoutTotalM` is
// your lap length if your mean line file is missing.
export function alignComparisonBundles(bundles: ComparisonBundle[], ownGuid: string | null, layoutTotalM: number): ComparisonBundle[] {
  if (!bundles.length) return bundles
  const own = ownLine(ownGuid, layoutTotalM)
  return bundles.map(bundle => {
    const theirGuid = bundle.sessions.find(s => s.meanLineGuid)?.meanLineGuid ?? bundle.line?.guid ?? null
    const lapEndM = Math.max(0, ...bundle.laps.map(lap => lap.samples.dist.at(-1) ?? 0))
    const map = mapToOwnLine(theirGuid, bundle.line, lapEndM, own)
    if (!map) return bundle
    return { ...bundle, laps: bundle.laps.map(lap => ({ ...lap, samples: remapLapSamples(lap.samples, map, own.totalM) })) }
  })
}

// Compared laps as Analysis laps: labelled with the driver, indexed by their
// position in the comparison, and each driver's fastest lap marked.
export function comparisonLaps(bundles: ComparisonBundle[]): Array<{ meta: LapMeta; samples: LapSamples }> {
  return bundles.flatMap((bundle, i) => {
    const fastest = bundle.laps.reduce<ComparisonLap | null>((a, b) => (!a || b.durationMs < a.durationMs ? b : a), null)
    return bundle.laps.map((lap, j) => ({
      samples: lap.samples,
      meta: {
        sg: lap.sg, sgShort: lap.sg.slice(0, 8), lapIdx: lap.lapIndex, durationMs: lap.durationMs,
        sampleCount: lap.samples.dist.length, sessionStart: lap.sessionStart ?? '', isBest: false,
        label: `${bundle.driver} · ${lapLabel(lap.sessionStart, lap.lapIndex)}`,
        colorIndex: j, representative: !!lap.representative,
        driverIndex: i + 1, driver: bundle.driver, driverBest: lap === fastest,
      },
    }))
  })
}
