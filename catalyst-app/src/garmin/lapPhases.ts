// Pure lap-analysis helpers shared by the Analysis page, the coaching packet
// and the focus tracker. Everything here works on one lap's 1 m resampled
// telemetry and never touches the database.
//
// Catalyst has no pedal channels, so braking and throttle are inferred from
// smoothed longitudinal acceleration. Thresholds are in g.

import type { TrackCorner, TrackSegment } from './trackYaml.js'

export const G0 = 9.80665

// Braking starts below −0.08 g and must reach −0.18 g to count, so a lift or
// aero drag alone is not reported as braking.
const BRAKE_ONSET_G = 0.08
const BRAKE_MIN_PEAK_G = 0.18
// A real braking zone (used to place corner-complex boundaries).
const BRAKE_ZONE_PEAK_G = 0.35
const THROTTLE_G = 0.08
const THROTTLE_HOLD_G = 0.03
const THROTTLE_HOLD_M = 15
// A minimum within this distance of its search window edge is not a local
// minimum: the car is still slowing (or already accelerating) at the edge.
const VMIN_EDGE_M = 3

export interface LapSeries {
  dist: number[]     // metres, ascending, ~1 m spacing
  timeMs: number[]   // elapsed ms from lap start (may contain NaN)
  speed: number[]    // m/s (may contain NaN)
  longG: number[]    // accel_x in g, braking negative (may contain NaN)
  latG: number[]     // accel_y in g (may contain NaN)
}

export interface BrakeEpisode {
  onsetM: number
  peakM: number
  releaseM: number
  peakG: number      // positive magnitude
}

export interface CornerBraking extends BrakeEpisode {
  stages: number     // >1 means brake–coast–re-brake
}

export interface CornerPhase {
  turn: string
  braking: CornerBraking | null
  vminMps: number | null     // null when the minimum sits on a window edge
  vminM: number | null
  throttleM: number | null   // first sustained acceleration after the minimum
  neutralM: number | null    // distance between brake release and throttle pickup
  exit100Mps: number | null  // speed 100 m after the minimum (or apex)
  exit200Mps: number | null
  maxLatG: number | null
}

export interface ComplexDef {
  id: string
  name: string
  startM: number
  endM: number
  corners: string[]
}

export interface SplitBound { id: string; startM: number; endM: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function median(values: number[]): number | null {
  const xs = values.filter(finite).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

// Sample standard deviation; null below two values.
export function stdev(values: number[]): number | null {
  const xs = values.filter(finite)
  if (xs.length < 2) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1))
}

// Five-sample centred moving average that skips missing values.
export function smooth(values: number[]): number[] {
  return values.map((_, i) => {
    let sum = 0, n = 0
    for (let j = Math.max(0, i - 2); j <= Math.min(values.length - 1, i + 2); j++) {
      if (finite(values[j])) { sum += values[j]; n++ }
    }
    return n ? sum / n : NaN
  })
}

function indexAtOrAfter(dist: number[], d: number): number {
  let lo = 0, hi = dist.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (dist[mid] < d) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Linear interpolation of a channel at a distance; null outside the lap or
// across a gap wider than 25 m.
export function valueAt(series: LapSeries, values: number[], d: number): number | null {
  const { dist } = series
  if (!dist.length || d < dist[0] || d > dist[dist.length - 1]) return null
  const hi = indexAtOrAfter(dist, d)
  if (dist[hi] === d) return finite(values[hi]) ? values[hi] : null
  const lo = hi - 1
  if (lo < 0 || dist[hi] - dist[lo] > 25 || !finite(values[lo]) || !finite(values[hi])) return null
  return values[lo] + (values[hi] - values[lo]) * (d - dist[lo]) / (dist[hi] - dist[lo])
}

export function spanTimeMs(series: LapSeries, startM: number, endM: number): number | null {
  const a = valueAt(series, series.timeMs, startM)
  const b = valueAt(series, series.timeMs, endM)
  return a !== null && b !== null && b > a ? b - a : null
}

// The Catalyst's accelerometer axes follow however the unit is mounted. A
// unit rotated on its mount leaks lateral g into the longitudinal channel
// (seen at up to 36% on real sessions), which stretches "braking" through a
// corner. GPS speed gives the true along-track acceleration, so each lap is
// calibrated against it: fit accel_x − dv/dt = leak·lat_g + offset and
// remove that. A well-mounted lap fits leak ≈ 0 and is left almost unchanged.
export interface LongGCalibration { leak: number; offsetG: number; applied: boolean }
export function calibrateLongG(series: LapSeries): LongGCalibration {
  const { dist, timeMs, speed, longG, latG } = series
  const xs: number[] = [], ys: number[] = []
  for (let i = 5; i < dist.length - 5; i++) {
    const dt = (timeMs[i + 5] - timeMs[i - 5]) / 1000
    if (!(dt > 0) || dist[i + 5] - dist[i - 5] > 15) continue
    const gps = (speed[i + 5] - speed[i - 5]) / dt / G0
    const diff = longG[i] - gps
    if (finite(diff) && finite(latG[i]) && Math.abs(diff) < 1) { xs.push(latG[i]); ys.push(diff) }
  }
  if (xs.length < 500) return { leak: 0, offsetG: 0, applied: false }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length
  let sxy = 0, sxx = 0
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2 }
  const leak = sxx > 0 ? sxy / sxx : 0
  const offsetG = my - leak * mx
  // A fit this extreme is not a mounting angle; leave the lap as recorded.
  if (!finite(leak) || Math.abs(leak) > 0.7 || Math.abs(offsetG) > 0.3) return { leak: 0, offsetG: 0, applied: false }
  for (let i = 0; i < longG.length; i++) {
    if (finite(longG[i])) longG[i] -= leak * (finite(latG[i]) ? latG[i] : 0) + offsetG
  }
  return { leak, offsetG, applied: true }
}

// Contiguous decelerations below −0.08 g that reach at least −0.18 g. An
// episode ends after three consecutive samples above the onset threshold.
export function detectBrakeEpisodes(series: LapSeries): BrakeEpisode[] {
  const g = smooth(series.longG)
  const { dist } = series
  const out: BrakeEpisode[] = []
  let i = 0
  while (i < g.length) {
    if (!(g[i] <= -BRAKE_ONSET_G)) { i++; continue }
    const onset = i
    let peak = i, last = i, clear = 0
    let j = i + 1
    for (; j < g.length; j++) {
      if (g[j] <= -BRAKE_ONSET_G) {
        clear = 0
        last = j
        if (g[j] < g[peak]) peak = j
      } else if (++clear >= 3) break
    }
    if (-g[peak] >= BRAKE_MIN_PEAK_G) {
      out.push({ onsetM: dist[onset], peakM: dist[peak], releaseM: dist[last], peakG: -g[peak] })
    }
    i = Math.max(j, last + 1)
  }
  return out
}

function sortedCorners(corners: TrackCorner[]): TrackCorner[] {
  return corners
    .filter(c => finite(c.apex_idx) && finite(c.dist_idx_start) && finite(c.dist_idx_end))
    .sort((a, b) => a.apex_idx - b.apex_idx)
}

// Each braking episode feeds the first corner whose apex is no more than 60 m
// before the brake release: braking ends at or shortly after turn-in, so the
// release point is far more repeatable lap to lap than the peak. Several
// episodes feeding one corner (brake–coast–re-brake) merge into stages.
export function assignBrakingToCorners(episodes: BrakeEpisode[], corners: TrackCorner[]): Map<string, CornerBraking> {
  const ordered = sortedCorners(corners)
  const out = new Map<string, CornerBraking>()
  for (const episode of episodes) {
    const corner = ordered.find(c => c.apex_idx >= episode.releaseM - 60)
    if (!corner) continue
    // Braking that starts more than 600 m before the corner zone belongs to
    // nothing on this layout (for example a pit-lane lift).
    if (episode.onsetM < corner.dist_idx_start - 600) continue
    const current = out.get(corner.turn)
    if (!current) out.set(corner.turn, { ...episode, stages: 1 })
    else {
      out.set(corner.turn, {
        onsetM: Math.min(current.onsetM, episode.onsetM),
        releaseM: Math.max(current.releaseM, episode.releaseM),
        peakM: episode.peakG > current.peakG ? episode.peakM : current.peakM,
        peakG: Math.max(current.peakG, episode.peakG),
        stages: current.stages + 1,
      })
    }
  }
  return out
}

export function cornerPhases(series: LapSeries, corners: TrackCorner[], totalM: number): CornerPhase[] {
  const ordered = sortedCorners(corners)
  const braking = assignBrakingToCorners(detectBrakeEpisodes(series), ordered)
  const g = smooth(series.longG)
  const { dist, speed } = series
  const lapEnd = dist.length ? dist[dist.length - 1] : totalM
  const phases = ordered.map((corner, index) => {
    const previousApex = index > 0 ? ordered[index - 1].apex_idx : 0
    const nextApex = index + 1 < ordered.length ? ordered[index + 1].apex_idx : lapEnd
    const brake = braking.get(corner.turn) ?? null
    // Search from the braking onset (or just before the zone) to just past the
    // zone, never beyond the neighbouring apexes.
    const lo = Math.max(previousApex, brake ? brake.onsetM : corner.dist_idx_start - 40)
    const hi = Math.min(nextApex, corner.dist_idx_end + 40)
    let minIdx = -1
    for (let i = indexAtOrAfter(dist, lo); i < dist.length && dist[i] <= hi; i++) {
      if (finite(speed[i]) && (minIdx < 0 || speed[i] < speed[minIdx])) minIdx = i
    }
    const onEdge = minIdx < 0 || dist[minIdx] - lo <= VMIN_EDGE_M || hi - dist[minIdx] <= VMIN_EDGE_M
    const vminM = onEdge ? null : dist[minIdx]
    const vminMps = onEdge ? null : speed[minIdx]
    // Throttle pickup: first +0.08 g after the minimum that stays above
    // +0.03 g for 15 m, before the next corner's apex.
    let throttleM: number | null = null
    const from = vminM ?? corner.apex_idx
    for (let i = indexAtOrAfter(dist, from); i < dist.length && dist[i] <= nextApex; i++) {
      if (!(g[i] >= THROTTLE_G)) continue
      let held = true
      for (let j = i; j < dist.length && dist[j] <= dist[i] + THROTTLE_HOLD_M; j++) {
        if (!(g[j] >= THROTTLE_HOLD_G)) { held = false; break }
      }
      if (held) { throttleM = dist[i]; break }
    }
    const neutralM = brake && throttleM !== null && throttleM > brake.releaseM ? throttleM - brake.releaseM : null
    const anchor = vminM ?? corner.apex_idx
    let maxLatG: number | null = null
    for (let i = indexAtOrAfter(dist, corner.dist_idx_start); i < dist.length && dist[i] <= corner.dist_idx_end; i++) {
      const v = Math.abs(series.latG[i])
      if (finite(v) && (maxLatG === null || v > maxLatG)) maxLatG = v
    }
    return {
      turn: corner.turn,
      braking: brake,
      vminMps, vminM, throttleM, neutralM,
      exit100Mps: valueAt(series, speed, anchor + 100),
      exit200Mps: valueAt(series, speed, anchor + 200),
      maxLatG,
    }
  })
  // Neighbouring corners can find the same minimum. It belongs to the corner
  // whose apex is nearest; the others have no distinct minimum of their own.
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]
    if (p.vminM === null) continue
    const sharing = phases.filter(q => q.vminM === p.vminM)
    if (sharing.length < 2) continue
    const owner = sharing.reduce((best, q) => {
      const apex = (turn: string) => ordered.find(c => c.turn === turn)!.apex_idx
      return Math.abs(apex(q.turn) - p.vminM!) < Math.abs(apex(best.turn) - p.vminM!) ? q : best
    })
    for (const q of sharing) if (q !== owner) Object.assign(q, { vminMps: null, vminM: null, throttleM: null, neutralM: null })
  }
  return phases
}

// Tile the lap with Garmin's segments. Garmin segments overlap by ~30 m, so
// each split runs from its own start to the next segment's start; the splits
// then sum to the lap time.
export function segmentBounds(segments: TrackSegment[], totalM: number): SplitBound[] {
  const ordered = segments.filter(s => finite(s.start_dist_m)).sort((a, b) => a.start_dist_m - b.start_dist_m)
  return ordered.map((s, i) => ({
    id: `S${s.id}`,
    startM: s.start_dist_m,
    endM: i + 1 < ordered.length ? ordered[i + 1].start_dist_m : (finite(totalM) && totalM > 0 ? totalM : s.end_dist_m),
  }))
}

function cornerSpanLabel(turns: string[]): string {
  if (!turns.length) return ''
  return turns.length === 1 ? turns[0] : `${turns[0]}–${turns[turns.length - 1]}`
}

// Corner complexes run from one real braking zone to the next, measured on a
// reference lap (the fastest valid lap of the layout). Corners without their
// own braking zone join the complex whose braking precedes them.
export function deriveComplexes(corners: TrackCorner[], reference: LapSeries, totalM: number): ComplexDef[] {
  const ordered = sortedCorners(corners)
  if (!ordered.length || !reference.dist.length) return []
  const braking = assignBrakingToCorners(detectBrakeEpisodes(reference), ordered)
  const starts: Array<{ startM: number; turn: string }> = []
  for (const corner of ordered) {
    const b = braking.get(corner.turn)
    if (!b || b.peakG < BRAKE_ZONE_PEAK_G) continue
    const startM = Math.max(0, Math.floor((b.onsetM - 20) / 10) * 10)
    if (starts.length && startM - starts[starts.length - 1].startM < 60) continue
    starts.push({ startM, turn: corner.turn })
  }
  if (!starts.length) return []
  const end = finite(totalM) && totalM > 0 ? Math.round(totalM) : Math.round(reference.dist[reference.dist.length - 1])
  let bounds = starts[0].startM > 0 ? [{ startM: 0, turn: '' }, ...starts] : starts
  const apexesIn = (from: number, to: number) => ordered.filter(c => c.apex_idx >= from && c.apex_idx < to)
  // A boundary whose stretch holds no apex (a second braking stage before the
  // same corner) merges into the stretch before it.
  bounds = bounds.filter((b, i) => i === 0 || apexesIn(b.startM, i + 1 < bounds.length ? bounds[i + 1].startM : end).length > 0)
  return bounds.map((b, i) => {
    const endM = i + 1 < bounds.length ? bounds[i + 1].startM : end
    const inside = apexesIn(b.startM, endM)
    const first = inside[0], last = inside[inside.length - 1]
    const label = inside.length ? cornerSpanLabel(inside.map(c => c.turn)) : 'Start straight'
    const firstName = first?.name && first.name !== first.turn ? first.name : ''
    const lastName = last && last !== first && last.name && last.name !== last.turn && last.name !== first?.name ? last.name : ''
    const name = [label, [firstName, lastName].filter(Boolean).join(' to ')].filter(Boolean).join(' · ')
    return { id: `C${i + 1}`, name, startM: b.startM, endM, corners: inside.map(c => c.turn) }
  })
}

// When a layout has no named corners, Garmin segments stand in for complexes.
export function complexesFromSegments(bounds: SplitBound[]): ComplexDef[] {
  return bounds.map(b => ({ id: `C-${b.id}`, name: b.id, startM: b.startM, endM: b.endM, corners: [] }))
}

// A split this much faster than the median of its peers is treated as a
// track-limits or timing artefact, not a personal best.
export const IMPLAUSIBLE_FRACTION = 0.95

// Minimum of plausible values: with three or more reference values, anything
// below 95% of their median is ignored. Pass representative laps as the
// reference so out-laps and cold laps do not inflate the median.
export function plausibleMin(values: Array<number | null>, reference: Array<number | null> = values): number | null {
  const xs = values.filter(finite)
  if (!xs.length) return null
  const ref = reference.filter(finite)
  if (ref.length < 3) return Math.min(...xs)
  const m = median(ref)!
  const kept = xs.filter(v => v >= m * IMPLAUSIBLE_FRACTION)
  return kept.length ? Math.min(...kept) : Math.min(...xs)
}

export interface ComplexPhase {
  id: string
  timeMs: number | null
  braking: CornerBraking | null
  vminMps: number | null
  vminM: number | null
  throttleM: number | null
  neutralM: number | null
  exit100Mps: number | null
  exit200Mps: number | null
}

// Phase metrics for one corner complex. Complexes run from one braking zone
// to the next, so each has at most one main braking event and one minimum.
export function complexPhases(series: LapSeries, complexes: ComplexDef[]): ComplexPhase[] {
  const episodes = detectBrakeEpisodes(series)
  const g = smooth(series.longG)
  const { dist, speed } = series
  return complexes.map(c => {
    // A derived complex without corners is a straight: only its time counts.
    if (!c.corners.length && !c.id.startsWith('C-')) {
      return { id: c.id, timeMs: spanTimeMs(series, c.startM, c.endM), braking: null, vminMps: null, vminM: null, throttleM: null, neutralM: null, exit100Mps: null, exit200Mps: null }
    }
    // Minimum speed anywhere inside the complex; one on the boundary means
    // the complex has no corner minimum (a flat-out stretch).
    let minIdx = -1
    for (let i = indexAtOrAfter(dist, c.startM); i < dist.length && dist[i] <= c.endM; i++) {
      if (finite(speed[i]) && (minIdx < 0 || speed[i] < speed[minIdx])) minIdx = i
    }
    const onEdge = minIdx < 0 || dist[minIdx] - c.startM <= VMIN_EDGE_M || c.endM - dist[minIdx] <= VMIN_EDGE_M
    const vminM = onEdge ? null : dist[minIdx]
    // Braking that begins up to 80 m before the boundary (a driver braking
    // earlier than the reference lap), ends inside this complex, and releases
    // before the minimum. Braking that runs on past the end feeds the next one.
    const feeding = episodes.filter(e => e.onsetM >= c.startM - 80 && e.releaseM < c.endM && (vminM === null || e.releaseM <= vminM + 50))
    const braking: CornerBraking | null = feeding.length ? {
      onsetM: feeding[0].onsetM,
      releaseM: feeding[feeding.length - 1].releaseM,
      peakG: Math.max(...feeding.map(e => e.peakG)),
      peakM: feeding.reduce((a, b) => (b.peakG > a.peakG ? b : a)).peakM,
      stages: feeding.length,
    } : null
    let throttleM: number | null = null
    if (vminM !== null) {
      for (let i = indexAtOrAfter(dist, vminM); i < dist.length && dist[i] <= c.endM; i++) {
        if (!(g[i] >= THROTTLE_G)) continue
        let held = true
        for (let j = i; j < dist.length && dist[j] <= dist[i] + THROTTLE_HOLD_M; j++) {
          if (!(g[j] >= THROTTLE_HOLD_G)) { held = false; break }
        }
        if (held) { throttleM = dist[i]; break }
      }
    }
    return {
      id: c.id,
      timeMs: spanTimeMs(series, c.startM, c.endM),
      braking,
      vminMps: vminM === null ? null : speed[minIdx],
      vminM,
      throttleM,
      neutralM: braking && throttleM !== null && throttleM > braking.releaseM ? throttleM - braking.releaseM : null,
      exit100Mps: vminM === null ? null : valueAt(series, speed, vminM + 100),
      exit200Mps: vminM === null ? null : valueAt(series, speed, vminM + 200),
    }
  })
}
