import type { MetricComparison, RegionAggregate, RegionMeasurement, ReviewAggregate, ReviewLap, ReviewMetric, ReviewRegion, ReviewSnapshot, ReviewSummary, Surface } from '../shared/review.js'
import { REVIEW_METRICS } from '../shared/review.js'

export const REVIEW_VERSION = 1
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export function mean(values: Array<number | null>): number | null {
  const xs = values.filter(finite)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}
export function deviation(values: Array<number | null>): number | null {
  const xs = values.filter(finite), avg = mean(xs)
  return xs.length > 1 && avg !== null ? Math.sqrt(xs.reduce((s, x) => s + (x - avg) ** 2, 0) / (xs.length - 1)) : null
}
export const minimum = (xs: Array<number | null>) => xs.some(finite) ? Math.min(...xs.filter(finite)) : null
export function inferSurface(weather: string | null): Surface {
  const text = (weather ?? '').toLowerCase()
  if (/snow|ice|sleet|mist|fog|drizzle|storm/.test(text)) return 'unknown'
  if (/\brain\b|\bshowers\b/.test(text)) return 'wet'
  if (/^(fair|clear|sunny|cloudy|overcast|mostly clear|mostly cloudy|partly cloudy|partly sunny)$/.test(text.trim())) return 'dry'
  return 'unknown'
}

export interface ReviewSample { distance: number; time: number | null; speed: number | null }
export interface LapInput { index: number; durationMs: number; type: string; descriptor: number; samples: ReviewSample[]; excluded?: boolean; exclusionReason?: string | null }
const emptyRegion = (): RegionMeasurement => ({ timeMs: null, vminMps: null, vminDistanceM: null, entryMps: null, exitMps: null, topSpeedMps: null })

export function interpolate(samples: ReviewSample[], distance: number, key: 'time' | 'speed'): number | null {
  if (!samples.length || distance < samples[0].distance || distance > samples.at(-1)!.distance) return null
  let lo = 0, hi = samples.length - 1
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].distance < distance) lo = mid + 1; else hi = mid }
  const b = samples[lo]
  if (b.distance === distance) return finite(b[key]) ? b[key] : null
  const a = samples[lo - 1]
  if (!a || b.distance - a.distance > 25 || !finite(a[key]) || !finite(b[key])) return null
  return a[key]! + (b[key]! - a[key]!) * (distance - a.distance) / (b.distance - a.distance)
}
function speedWindow(samples: ReviewSample[], start: number, end: number): number | null {
  const points = [start, ...samples.filter(s => s.distance > start && s.distance < end).map(s => s.distance), end]
  let area = 0
  for (let i = 1; i < points.length; i++) {
    const a = interpolate(samples, points[i - 1], 'speed'), b = interpolate(samples, points[i], 'speed')
    if (a === null || b === null || a < 0 || b < 0 || points[i] - points[i - 1] > 25) return null
    area += (a + b) / 2 * (points[i] - points[i - 1])
  }
  return end > start ? area / (end - start) : null
}
export function measureLap(input: LapInput, regions: ReviewRegion[], totalM: number): ReviewLap {
  const reasons: string[] = []
  if (input.type !== 'DRIVEN') reasons.push('Not a driven lap')
  if (!finite(input.durationMs) || input.durationMs <= 0) reasons.push('Invalid duration')
  for (const [bit, label] of [[2, 'Divergent'], [4, 'Invalid'], [8, 'Paused'], [16, 'Bad GPS']] as const) {
    if (input.descriptor & bit) reasons.push(`Garmin: ${label}`)
  }
  // Distance is rounded on ingestion. Retain the last duplicate deterministically.
  const points: ReviewSample[] = []
  let malformed = false
  for (const p of input.samples) {
    const previous = points.at(-1)
    if (!finite(p.distance) || !finite(p.time) || p.time < 0 || (previous && (p.distance < previous.distance || p.time < previous.time!))) malformed = true
    if (previous?.distance === p.distance) points[points.length - 1] = p
    else points.push(p)
  }
  if (malformed) reasons.push('Invalid elapsed timestamps')
  const first = points[0], last = points.at(-1)
  if (!finite(totalM) || totalM <= 0 || !first || !last || first.distance > 2 || Math.abs(last.distance - totalM) > 2 || points.length < 3) reasons.push('Incomplete lap coverage')
  if (first && last && (Math.abs(first.time ?? Infinity) > 100 || Math.abs((last.time ?? Infinity) - input.durationMs) > 1000)) reasons.push('Timing does not cover the lap')
  if (points.length > 1 && (points.at(-2)!.time ?? Infinity) >= input.durationMs) reasons.push('Timing extends beyond lap duration')
  if (points.some((p, i) => i > 0 && p.distance - points[i - 1].distance > 25)) reasons.push('Telemetry gap over 25 m')
  if (!points.some(p => finite(p.speed) && p.speed > 0)) reasons.push('Speed data unavailable')
  if (input.excluded) reasons.push(input.exclusionReason ? `Excluded: ${input.exclusionReason}` : 'Manually excluded')
  // Anchor the finish to measured lap duration, within the validated endpoint tolerance.
  if (!malformed && first && last && Math.abs(last.distance - totalM) <= 2) {
    points[points.length - 1] = { ...last, distance: totalM, time: input.durationMs }
    if (first.distance <= 2) points[0] = { ...first, distance: 0, time: 0 }
  }
  const result: ReviewLap = { index: input.index, durationMs: input.durationMs, eligible: !reasons.length, reasons,
    excluded: !!input.excluded, exclusionReason: input.exclusionReason ?? null, selected: false, representative: false,
    topSpeedMps: null, topSpeedDistanceM: null, regions: {} }
  const speedPoints = points.filter(p => finite(p.speed) && p.speed >= 0)
  const peak = speedPoints.length === points.length ? speedPoints.reduce<ReviewSample | null>((a, b) => !a || b.speed! > a.speed! ? b : a, null) : null
  result.topSpeedMps = peak?.speed ?? null; result.topSpeedDistanceM = peak?.distance ?? null
  for (const region of regions) {
    const start = region.startM, end = Math.min(region.endM, totalM)
    const r = emptyRegion(); result.regions[region.id] = r
    if (malformed || !result.eligible || start < 0 || end <= start || region.endM > totalM + 2) continue
    const a = interpolate(points, start, 'time'), b = interpolate(points, end, 'time')
    if (a !== null && b !== null && b > a) r.timeMs = b - a
    // A missing speed sample cannot silently become a measured V-min.
    const rawLocal = points.filter(p => p.distance >= start && p.distance <= end)
    const startSpeed = interpolate(points, start, 'speed'), endSpeed = interpolate(points, end, 'speed')
    const local = [{ distance: start, speed: startSpeed }, ...rawLocal, { distance: end, speed: endSpeed }]
    if (local.every(p => finite(p.speed) && p.speed >= 0)) {
      const min = local.reduce((a, b) => b.speed! < a.speed! ? b : a)
      r.vminMps = min.speed; r.vminDistanceM = min.distance
      r.topSpeedMps = Math.max(...local.map(p => p.speed!))
    }
    r.entryMps = speedWindow(points, start, Math.min(start + 5, end))
    r.exitMps = speedWindow(points, Math.max(start, end - 5), end)
  }
  return result
}

export function aggregateLaps(laps: ReviewLap[], regions: ReviewRegion[]): Pick<ReviewSummary, 'fastLapCount' | 'eligibleLapCount' | 'representativeCount' | 'paceMs' | 'bestLapMs' | 'consistencyMs' | 'topSpeedMps' | 'peakSpeedMps' | 'peakSpeedLap' | 'peakSpeedDistanceM' | 'regions'> {
  const valid = laps.filter(l => l.eligible).sort((a, b) => a.durationMs - b.durationMs || a.index - b.index)
  const fast = valid.slice(0, 3), best = valid[0]?.durationMs ?? null
  const representative = valid.filter(l => best !== null && l.durationMs <= best * 1.05)
  for (const lap of laps) { lap.selected = fast.includes(lap); lap.representative = representative.includes(lap) }
  const peak = valid.reduce<ReviewLap | null>((a, b) => b.topSpeedMps !== null && (a?.topSpeedMps == null || b.topSpeedMps > a.topSpeedMps) ? b : a, null)
  const aggregated: RegionAggregate[] = regions.map(region => {
    const values = fast.map(l => l.regions[region.id]).filter((r): r is RegionMeasurement => !!r && r.timeMs !== null)
    const measurement = emptyRegion()
    for (const key of Object.keys(measurement) as Array<keyof RegionMeasurement>) measurement[key] = mean(values.map(v => v[key]))
    return { ...region, ...measurement, count: values.length, consistencyMs: deviation(representative.map(l => l.regions[region.id]?.timeMs ?? null)),
      bestTimeMs: minimum(valid.map(l => l.regions[region.id]?.timeMs ?? null)) }
  })
  return { fastLapCount: fast.length, eligibleLapCount: valid.length, representativeCount: representative.length,
    paceMs: mean(fast.map(l => l.durationMs)), bestLapMs: best, consistencyMs: deviation(representative.map(l => l.durationMs)),
    topSpeedMps: mean(fast.map(l => l.topSpeedMps)), peakSpeedMps: peak?.topSpeedMps ?? null,
    peakSpeedLap: peak?.index ?? null, peakSpeedDistanceM: peak?.topSpeedDistanceM ?? null, regions: aggregated }
}

export function identityKey(s: ReviewSummary): string | null {
  if (!s.account || !s.vehicleGuid || s.configurationId === null || s.cartographyId === null || s.reverse === null) return null
  return JSON.stringify([s.account, s.vehicleGuid, s.cartographyId, s.configurationId, s.reverse, s.direction])
}
export function mismatch(current: ReviewSummary, other: ReviewSummary): string | null {
  const key = identityKey(current)
  if (!key || !identityKey(other)) return 'Missing driver, vehicle, or layout identity'
  if (key !== identityKey(other)) return 'Different driver, car, track, layout, or direction'
  if (!current.start || !other.start || other.start >= current.start) return 'Not an earlier session'
  if (current.conditions.surface === 'unknown' || other.conditions.surface === 'unknown') return 'Unknown surface'
  if (current.conditions.surface !== other.conditions.surface) return 'Different surface'
  const a = current.conditions.temperatureC, b = other.conditions.temperatureC
  if (!finite(a) || !finite(b)) return 'Temperature unavailable'
  if (Math.abs(a - b) > 5 + 1e-8) return 'Outside ±5°C temperature window'
  if (!other.fastLapCount) return 'No eligible laps'
  return null
}
function compare(current: number | null, baselineValues: Array<number | null>, previous: number | null, pb: number | null,
  evidence?: { current: number[]; historicalCounts: number[]; floor: number }): MetricComparison {
  const baseline = mean(baselineValues), delta = current !== null && baseline !== null ? current - baseline : null
  let clearChange: MetricComparison['clearChange'] = null
  if (delta !== null && evidence && evidence.current.length === 3 && evidence.historicalCounts.filter(n => n === 3).length >= 3
    && Math.abs(delta) > Math.max(evidence.floor, deviation(baselineValues) ?? Infinity)
    && evidence.current.filter(v => Math.sign(v - baseline!) === Math.sign(delta)).length >= 2) clearChange = delta < 0 ? 'gain' : 'regression'
  return { current, baseline, delta, previous, personalBest: pb, baselineCount: baselineValues.filter(finite).length, clearChange }
}
export function buildComparison(current: ReviewAggregate, summaries: ReviewSummary[], coverage: ReviewSnapshot['coverage']): Omit<ReviewSnapshot, 'revision'> {
  const s = current.summary
  const earlier = summaries.filter(o => o.sessionGuid !== s.sessionGuid && o.start && s.start && o.start < s.start)
  const history = earlier.filter(o => !mismatch(s, o)).sort((a, b) => b.start!.localeCompare(a.start!) || a.sessionGuid.localeCompare(b.sessionGuid))
  const baseline = history.slice(0, 5), previous = history[0]
  const fast = current.laps.filter(l => l.selected)
  const regions = s.regions.map(region => {
    const compatible = history.filter(o => o.meanLineGuid && o.meanLineGuid === s.meanLineGuid && o.geometryRevision === s.geometryRevision)
    const historyRegions = compatible.map(o => ({ session: o, region: o.regions.find(r => r.id === region.id) })).filter(x => x.region && x.region.count > 0)
    const recent = historyRegions.slice(0, 5)
    const metrics = {} as Record<ReviewMetric, MetricComparison>
    for (const metric of REVIEW_METRICS) {
      metrics[metric] = compare(region[metric], recent.map(o => o.region![metric]), historyRegions[0]?.region?.[metric] ?? null,
        metric === 'timeMs' ? minimum(historyRegions.map(o => o.region!.bestTimeMs)) : null,
        metric === 'timeMs' ? { current: fast.map(l => l.regions[region.id]?.timeMs).filter(finite), historicalCounts: recent.map(o => o.region!.count), floor: 100 } : undefined)
    }
    return { region, metrics, baselineSessions: recent.map(o => o.session.sessionGuid) }
  })
  return { version: REVIEW_VERSION, current, baseline, history: [...history].reverse(), regions, coverage,
    pace: compare(s.paceMs, baseline.map(o => o.paceMs), previous?.paceMs ?? null, minimum(history.map(o => o.paceMs)),
      { current: fast.map(l => l.durationMs), historicalCounts: baseline.map(o => o.fastLapCount), floor: 300 }),
    bestLap: compare(s.bestLapMs, baseline.map(o => o.bestLapMs), previous?.bestLapMs ?? null, minimum(history.map(o => o.bestLapMs))),
    topSpeed: compare(s.topSpeedMps, baseline.map(o => o.topSpeedMps), previous?.topSpeedMps ?? null, null),
    consistency: compare(s.consistencyMs, baseline.map(o => o.consistencyMs), previous?.consistencyMs ?? null, null),
    excludedSessions: earlier.flatMap(o => {
      const reason = mismatch(s, o) ?? (!baseline.some(b => b.sessionGuid === o.sessionGuid) ? 'Older than the five most recent comparable sessions (retained in history and PB)' : null)
      return reason ? [{ sessionGuid: o.sessionGuid, start: o.start, reason }] : []
    }),
  }
}
