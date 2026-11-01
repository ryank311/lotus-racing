// PDR telemetry as named signals, matched in time to a Garmin session and
// resampled onto its laps.
//
// The PDR and the Catalyst are separate devices with separate clocks, so the
// video is placed on the session by its data: first the car's speed against
// the Garmin speed (one-second steps over the whole overlap, which tells one
// lap from the next because lap times differ), then the PDR's own GPS track
// against the Garmin positions to a fraction of a second.

import { PDR_CHANNELS } from '../shared/pdr.js'
import type { RawSeries } from './pdrFile.js'

export interface PdrSignal { t: Float64Array; v: Float64Array; hold: boolean }
export type PdrSignals = Map<string, PdrSignal>

/** Known channels in their units; repeated timestamps keep the last value. */
export function pdrSignals(series: Map<number, RawSeries>): PdrSignals {
  const out: PdrSignals = new Map()
  for (const [id, raw] of series) {
    const info = PDR_CHANNELS[id]
    if (!info || !raw.t.length) continue
    const t: number[] = [], v: number[] = []
    for (let i = 0; i < raw.t.length; i++) {
      const value = info.scale(raw.v[i])
      if (t.length && t[t.length - 1] === raw.t[i]) v[v.length - 1] = value
      else { t.push(raw.t[i]); v.push(value) }
    }
    out.set(info.key, { t: Float64Array.from(t), v: Float64Array.from(v), hold: !!info.hold })
  }
  // A position of exactly 0,0 is no fix.
  const lat = out.get('lat'), lon = out.get('lon')
  if (lat && lon && lat.v.every(x => x === 0)) { out.delete('lat'); out.delete('lon') }
  return out
}

/**
 * Reads a signal at increasing (or arbitrary) times; null across gaps. The
 * PDR logs some channels only when they change, with a 2 s heartbeat, so a
 * gap is longer than that.
 */
export class Sampler {
  private i = 0
  constructor(private signal: PdrSignal | undefined, private maxGapS = 2.5) {}
  at(time: number): number | null {
    const s = this.signal
    if (!s || !s.t.length || !Number.isFinite(time)) return null
    const { t, v } = s
    if (time < t[0] || time > t[t.length - 1]) return null
    if (this.i >= t.length || t[this.i] > time) this.i = 0
    // Gallop forward, then binary search the bracket.
    let lo = this.i, step = 1
    while (lo + step < t.length && t[lo + step] <= time) { lo += step; step *= 2 }
    let hi = Math.min(t.length - 1, lo + step)
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid }
    this.i = lo
    if (t[lo] === time || lo === t.length - 1) return v[lo]
    const t0 = t[lo], t1 = t[lo + 1]
    if (s.hold) return time - t0 <= this.maxGapS ? v[lo] : null
    if (t1 - t0 > this.maxGapS) return null
    return v[lo] + (v[lo + 1] - v[lo]) * (time - t0) / (t1 - t0)
  }
}

/** One Garmin lap: when it started in the session and its 1 m samples. */
export interface GarminLap {
  lapIndex: number
  startMs: number           // from the session start
  durationMs: number
  distM: number[]
  timeMs: Array<number | null>  // from the lap start
  speed: Array<number | null>   // m/s
  lat: Array<number | null>
  lon: Array<number | null>
}

export interface VideoAlignment {
  // Session time (s) = video time (s) + offsetS.
  offsetS: number
  method: 'position' | 'speed'
  // Mean distance between the two GPS tracks (m), or 1 − speed correlation.
  error: number
  overlapS: number
  // Laps with at least half their samples inside the video.
  laps: number[]
}

const KMH = 1 / 3.6
const M_PER_DEG = 111_320

interface TimedPoint { t: number; speed: number | null; lat: number | null; lon: number | null }

function garminPoints(laps: GarminLap[], strideM: number): TimedPoint[] {
  const out: TimedPoint[] = []
  for (const lap of laps) {
    for (let i = 0; i < lap.distM.length; i++) {
      const ms = lap.timeMs[i]
      if (ms == null || lap.distM[i] % strideM !== 0) continue
      out.push({ t: (lap.startMs + ms) / 1000, speed: lap.speed[i], lat: lap.lat[i], lon: lap.lon[i] })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// Mean speed per whole second; NaN where there is none.
function perSecond(points: Array<{ t: number; v: number }>, start: number, length: number): Float64Array {
  const sum = new Float64Array(length), count = new Float64Array(length)
  for (const p of points) {
    const k = Math.floor(p.t) - start
    if (k >= 0 && k < length) { sum[k] += p.v; count[k]++ }
  }
  return sum.map((s, k) => (count[k] ? s / count[k] : NaN))
}

/** Best whole-second offset by speed agreement over the overlap. */
function coarseOffset(points: TimedPoint[], speed: Sampler, durationS: number, priorS: number | null): { offset: number; score: number; overlap: number } | null {
  const moving = points.filter((p): p is TimedPoint & { speed: number } => p.speed != null)
  if (!moving.length) return null
  const gStart = Math.floor(moving[0].t), gLength = Math.ceil(moving[moving.length - 1].t) - gStart + 1
  const g = perSecond(moving.map(p => ({ t: p.t, v: p.speed })), gStart, gLength)
  const vLength = Math.max(1, Math.floor(durationS))
  const p = new Float64Array(vLength)
  for (let j = 0; j < vLength; j++) { const v = speed.at(j + 0.5); p[j] = v == null ? NaN : v * KMH }
  let best: { offset: number; score: number; overlap: number } | null = null
  for (let o = gStart - vLength + 1; o < gStart + gLength; o++) {
    let score = 0, overlap = 0
    const j0 = Math.max(0, gStart - o), j1 = Math.min(vLength, gStart + gLength - o)
    for (let j = j0; j < j1; j++) {
      const gv = g[j + o - gStart], pv = p[j]
      if (Number.isNaN(gv) || Number.isNaN(pv)) continue
      overlap++
      score += Math.max(0, 1 - Math.abs(gv - pv) / (1 + 0.08 * gv))
    }
    if (overlap < 20 || score < overlap * 0.6) continue
    // When laps look alike, the PDR's clock (local time, often whole hours
    // off) breaks the tie.
    let adjusted = score
    if (priorS != null) {
      const d = ((Math.abs(o - priorS) % 3600) + 3600) % 3600
      adjusted -= 0.02 * Math.min(d, 3600 - d)
    }
    if (!best || adjusted > best.score) best = { offset: o, score: adjusted, overlap }
  }
  return best
}

function positionError(points: TimedPoint[], lat: Sampler, lon: Sampler, offset: number): { error: number; n: number } {
  let sum = 0, n = 0
  for (const p of points) {
    if (p.lat == null || p.lon == null) continue
    const a = lat.at(p.t - offset), b = lon.at(p.t - offset)
    if (a == null || b == null) continue
    const dy = (a - p.lat) * M_PER_DEG, dx = (b - p.lon) * M_PER_DEG * Math.cos(p.lat * Math.PI / 180)
    sum += Math.min(30, Math.hypot(dx, dy)); n++
  }
  return { error: n ? sum / n : Infinity, n }
}

function speedCorrelation(points: TimedPoint[], speed: Sampler, offset: number): { error: number; n: number } {
  const xs: number[] = [], ys: number[] = []
  for (const p of points) {
    if (p.speed == null) continue
    const v = speed.at(p.t - offset)
    if (v == null) continue
    xs.push(p.speed); ys.push(v * KMH)
  }
  const n = xs.length
  if (n < 10) return { error: Infinity, n }
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2 }
  return { error: sxx && syy ? 1 - sxy / Math.sqrt(sxx * syy) : Infinity, n }
}

// Minimise `cost` on a grid around `center`, then a parabola through the best three.
function refine(center: number, halfWidth: number, step: number, cost: (o: number) => number): { offset: number; cost: number } {
  let bestI = 0, bestCost = Infinity
  const n = Math.round(halfWidth / step)
  const costs: number[] = []
  for (let i = -n; i <= n; i++) {
    const c = cost(center + i * step)
    costs.push(c)
    if (c < bestCost) { bestCost = c; bestI = i }
  }
  let offset = center + bestI * step
  const k = bestI + n
  if (k > 0 && k < costs.length - 1 && Number.isFinite(costs[k - 1]) && Number.isFinite(costs[k + 1])) {
    const denom = costs[k - 1] - 2 * costs[k] + costs[k + 1]
    if (denom > 0) offset += step * 0.5 * (costs[k - 1] - costs[k + 1]) / denom
  }
  return { offset, cost: bestCost }
}

/**
 * Where the video sits in the session, or null when the car data does not
 * match any of the session's laps. `priorS` is the clock difference
 * (video start − session start), when known.
 */
export function alignVideo(signals: PdrSignals, durationS: number, laps: GarminLap[], priorS: number | null = null): VideoAlignment | null {
  const speed = signals.get('speed')
  if (!speed || !laps.length) return null
  const points = garminPoints(laps, 5)
  const coarse = coarseOffset(points, new Sampler(speed), durationS, priorS)
  if (!coarse) return null

  const lat = signals.get('lat'), lon = signals.get('lon')
  let method: VideoAlignment['method'] = 'speed'
  let fine: { offset: number; cost: number }
  const hasGps = lat && lon && positionError(points, new Sampler(lat), new Sampler(lon), coarse.offset).n >= 50
  if (hasGps) {
    method = 'position'
    const la = new Sampler(lat), lo = new Sampler(lon)
    fine = refine(coarse.offset, 2, 0.02, o => positionError(points, la, lo, o).error)
    if (fine.cost > 15) return null
  } else {
    const sp = new Sampler(speed)
    fine = refine(coarse.offset, 2, 0.02, o => speedCorrelation(points, sp, o).error)
    if (fine.cost > 0.1) return null
  }

  const offset = fine.offset
  const covered = laps.filter(lap => {
    const times = lap.timeMs.filter((t): t is number => t != null)
    const inside = times.filter(t => { const v = (lap.startMs + t) / 1000 - offset; return v >= 0 && v <= durationS }).length
    return times.length > 0 && inside / times.length >= 0.5
  }).map(lap => lap.lapIndex)
  const overlapS = Math.max(0, Math.min(durationS + offset, points[points.length - 1].t) - Math.max(offset, points[0].t))
  if (overlapS < 20) return null
  return { offsetS: Math.round(offset * 1000) / 1000, method, error: Math.round(fine.cost * 1000) / 1000, overlapS, laps: covered }
}

/** Car data at one Garmin sample (one metre) of a lap. */
export interface CarSample {
  distM: number
  videoT: number
  speedKmh: number | null
  rpm: number | null
  throttle: number | null
  brake: number | null
  gear: number | null
  steering: number | null
  latG: number | null
  longG: number | null
  wheels: [number | null, number | null, number | null, number | null]
  slip: number | null
}

// Typical rear/front wheel-speed ratio when nothing is slipping (straight,
// steady, quick): tyre sizes and calibration put it a little off 1.
export function slipBaseline(signals: PdrSignals): number {
  const fl = signals.get('wheelFL'), speed = signals.get('speed')
  if (!fl || !speed) return 1
  const samplers = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'longG', 'steering'].map(k => new Sampler(signals.get(k)))
  const ratios: number[] = []
  for (let i = 0; i < fl.t.length; i += 5) {
    const [a, b, c, d, g, s] = samplers.map(x => x.at(fl.t[i]))
    if (a == null || b == null || c == null || d == null || a + b < 120) continue
    if ((g != null && Math.abs(g) > 0.05) || (s != null && Math.abs(s) > 10)) continue
    ratios.push((c + d) / (a + b))
  }
  if (ratios.length < 20) return 1
  ratios.sort((x, y) => x - y)
  return ratios[Math.floor(ratios.length / 2)]
}

export function lapCarSamples(signals: PdrSignals, durationS: number, offsetS: number, lap: GarminLap, baseline = 1): CarSample[] {
  const get = (key: string) => new Sampler(signals.get(key))
  const s = {
    speed: get('speed'), rpm: get('rpm'), throttle: get('throttle'), brake: get('brake'), gear: get('gear'),
    steering: get('steering'), latG: get('latG'), longG: get('longG'),
    wheels: ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'].map(get),
  }
  // A video without the car's speed (a Garmin Catalyst recording) shows
  // the Garmin GPS speed instead.
  const gpsSpeed = !signals.has('speed')
  const out: CarSample[] = []
  for (let i = 0; i < lap.distM.length; i++) {
    const ms = lap.timeMs[i]
    if (ms == null) continue
    const t = (lap.startMs + ms) / 1000 - offsetS
    if (t < 0 || t > durationS) continue
    const wheels = s.wheels.map(w => w.at(t)) as CarSample['wheels']
    const [fl, fr, rl, rr] = wheels
    const front = fl != null && fr != null ? (fl + fr) / 2 : null
    const slip = front != null && rl != null && rr != null && front > 15 ? ((rl + rr) / 2 / front / baseline - 1) * 100 : null
    const gps = lap.speed[i]
    out.push({
      distM: lap.distM[i], videoT: t,
      speedKmh: gpsSpeed ? (gps == null ? null : gps * 3.6) : s.speed.at(t), rpm: s.rpm.at(t), throttle: s.throttle.at(t), brake: s.brake.at(t),
      gear: s.gear.at(t), steering: s.steering.at(t), latG: s.latG.at(t), longG: s.longG.at(t),
      wheels, slip,
    })
  }
  return out
}
