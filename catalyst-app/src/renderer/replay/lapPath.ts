// One lap, ready to play: local positions with a smoothed heading, looked up
// by lap time or by distance along the scene's mean line, and the car
// channels (PDR or Catalyst video) by distance.

import type { ReplayLap } from '../../shared/replay'
import type { CarTrace } from '../../shared/pdr'
import { localX, localZ, type LocalFrame } from './geo'

export interface LapPose {
  x: number
  z: number
  /** Unit heading in the ground plane. */
  fx: number
  fz: number
  /** Metres along the scene's mean line (may run below 0 or past the end). */
  dist: number
  speedMps: number
  /** m/s²: longitudinal (braking negative) and lateral (Garmin: positive = turning right). */
  accelX: number
  accelY: number
}

export type CarChannel = 'throttle' | 'brake' | 'rpm' | 'gear' | 'steering' | 'speed'

/** Last index with xs[i] <= x (0 when x is before the first). */
export function lowerIndex(xs: ArrayLike<number>, x: number): number {
  let lo = 0, hi = xs.length - 1
  if (hi < 0 || x <= xs[0]) return 0
  if (x >= xs[hi]) return hi
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  return lo
}

/** Linear interpolation of ys over increasing xs, clamped at the ends. */
export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const i = lowerIndex(xs, x), j = Math.min(xs.length - 1, i + 1)
  const span = xs[j] - xs[i]
  const f = span > 0 ? Math.min(1, Math.max(0, (x - xs[i]) / span)) : 0
  return ys[i] + (ys[j] - ys[i]) * f
}

// Nulls take the nearest earlier value (else the first value), so a dropout
// holds the reading instead of falling to zero.
function filled(values: Array<number | null>, fallback = 0): Float64Array {
  const out = new Float64Array(values.length)
  const first = values.find(v => v != null && Number.isFinite(v))
  let last = first ?? fallback
  values.forEach((v, i) => { if (v != null && Number.isFinite(v)) last = v; out[i] = last })
  return out
}

/** Distance along a closed line, unwrapped so it climbs through the lap. */
export function unwrapDistance(raw: number[], totalM: number): Float64Array {
  const out = new Float64Array(raw.length)
  let offset = 0
  for (let i = 0; i < raw.length; i++) {
    if (i > 0 && totalM > 0) {
      const step = raw[i] + offset - out[i - 1]
      if (step < -totalM / 2) offset += totalM
      else if (step > totalM / 2) offset -= totalM
    }
    out[i] = raw[i] + offset
  }
  // A lap that starts just short of the line counts its first metres as negative.
  if (out.length && totalM > 0 && out[0] > totalM / 2) for (let i = 0; i < out.length; i++) out[i] -= totalM
  return out
}

export class LapPath {
  readonly n: number
  readonly t: Float64Array
  readonly d: Float64Array
  /** Distance made non-decreasing, for time-at-distance lookups. */
  readonly dMono: Float64Array
  readonly x: Float64Array
  readonly z: Float64Array
  readonly fx: Float64Array
  readonly fz: Float64Array
  readonly speed: Float64Array
  readonly ax: Float64Array
  readonly ay: Float64Array
  readonly durationMs: number
  readonly minSpeed: number
  readonly maxSpeed: number
  readonly car: CarTrace | null
  private carDist: number[] = []

  constructor(readonly lap: ReplayLap, frame: LocalFrame, totalM: number) {
    const n = this.n = lap.timeMs.length
    this.t = Float64Array.from(lap.timeMs)
    this.d = unwrapDistance(lap.dist, totalM)
    this.dMono = new Float64Array(n)
    for (let i = 0, max = -Infinity; i < n; i++) this.dMono[i] = max = Math.max(max, this.d[i])
    this.durationMs = lap.durationMs || (n ? this.t[n - 1] - this.t[0] : 0)
    // GNSS jitter: a light binomial smooth of the positions.
    const rawX = lap.lon.map(lon => localX(frame, lon)), rawZ = lap.lat.map(lat => localZ(frame, lat))
    this.x = smooth(rawX, [1, 4, 6, 4, 1]); this.z = smooth(rawZ, [1, 4, 6, 4, 1])
    // Heading from the path over about 3 m each way, then smoothed again.
    const s = new Float64Array(n)
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1])
    const hx = new Array<number>(n), hz = new Array<number>(n)
    for (let i = 0, a = 0, b = 0; i < n; i++) {
      while (a < i && s[i] - s[a + 1] >= 3) a++
      b = Math.max(b, i)
      while (b < n - 1 && s[b] - s[i] < 3) b++
      const dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a]
      const len = Math.hypot(dx, dz)
      hx[i] = len > 1e-6 ? dx / len : (i ? hx[i - 1] : 0)
      hz[i] = len > 1e-6 ? dz / len : (i ? hz[i - 1] : -1)
    }
    const kernel = [1, 2, 3, 4, 3, 2, 1]
    this.fx = smooth(hx, kernel); this.fz = smooth(hz, kernel)
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(this.fx[i], this.fz[i]) || 1
      this.fx[i] /= len; this.fz[i] /= len
    }
    this.speed = filled(lap.speedMps)
    this.ax = filled(lap.accelX)
    this.ay = filled(lap.accelY)
    let lo = Infinity, hi = 0
    for (const v of this.speed) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    this.minSpeed = Number.isFinite(lo) ? lo : 0
    this.maxSpeed = hi
    this.car = lap.car
    if (lap.car) this.carDist = lap.car.dist
  }

  /** Sample index and fraction at a lap time (ms from the lap start). */
  at(timeMs: number): [number, number] {
    const t = this.t[0] + timeMs
    const i = lowerIndex(this.t, t), j = Math.min(this.n - 1, i + 1)
    const span = this.t[j] - this.t[i]
    return [i, span > 0 ? Math.min(1, Math.max(0, (t - this.t[i]) / span)) : 0]
  }

  pose(timeMs: number, out: LapPose = {} as LapPose): LapPose {
    const [i, f] = this.at(timeMs), j = Math.min(this.n - 1, i + 1)
    const mix = (a: Float64Array) => a[i] + (a[j] - a[i]) * f
    out.x = mix(this.x); out.z = mix(this.z)
    const fx = mix(this.fx), fz = mix(this.fz), len = Math.hypot(fx, fz) || 1
    out.fx = fx / len; out.fz = fz / len
    out.dist = mix(this.d)
    out.speedMps = mix(this.speed)
    out.accelX = mix(this.ax); out.accelY = mix(this.ay)
    return out
  }

  distAt(timeMs: number): number {
    const [i, f] = this.at(timeMs), j = Math.min(this.n - 1, i + 1)
    return this.d[i] + (this.d[j] - this.d[i]) * f
  }

  /** Lap time (ms) when this lap reached a distance; null before its first or past its last sample. */
  timeAtDist(dist: number): number | null {
    if (!this.n || dist < this.dMono[0] - 1 || dist > this.dMono[this.n - 1] + 1) return null
    return interp(this.dMono, this.t, dist) - this.t[0]
  }

  /** A car channel at a distance, interpolated (gear holds); null where the video has none. */
  channel(key: CarChannel, dist: number): number | null {
    const car = this.car
    if (!car || !this.carDist.length) return null
    const values = car[key] as Array<number | null> | undefined
    if (!values) return null
    const xs = this.carDist
    if (dist < xs[0] - 5 || dist > xs[xs.length - 1] + 5) return null
    const i = lowerIndex(xs, dist), j = Math.min(xs.length - 1, i + 1)
    const a = values[i], b = values[j]
    if (a == null || b == null) return a ?? b ?? null
    if (key === 'gear') return dist - xs[i] < xs[j] - dist ? a : b
    const span = xs[j] - xs[i]
    return span > 0 ? a + (b - a) * Math.min(1, Math.max(0, (dist - xs[i]) / span)) : a
  }

  /** Video time (s) at a distance, from the trace's sync; null where the video does not cover it. */
  videoTime(dist: number): number | null {
    const car = this.car
    if (!car || !this.carDist.length) return null
    const xs = this.carDist, ys = car.videoT
    if (dist < xs[0] - 5 || dist > xs[xs.length - 1] + 5) return null
    const i = lowerIndex(xs, dist), j = Math.min(xs.length - 1, i + 1)
    const a = ys[i], b = ys[j]
    if (a == null || b == null) return null
    const span = xs[j] - xs[i]
    return span > 0 ? a + (b - a) * (dist - xs[i]) / span : a
  }

  hasChannel(key: CarChannel): boolean {
    const values = this.car?.[key] as Array<number | null> | undefined
    return !!values?.some(v => v != null)
  }

  get hasVideo(): boolean {
    return !!this.car?.videoT.some(v => v != null)
  }
}

/** Normalised kernel smoothing; the ends use the part of the kernel that fits. */
export function smooth(values: ArrayLike<number>, kernel: number[]): Float64Array {
  const n = values.length, h = kernel.length >> 1
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0, weight = 0
    for (let k = -h; k <= h; k++) {
      const j = i + k
      if (j < 0 || j >= n) continue
      const v = values[j]
      if (!Number.isFinite(v)) continue
      sum += v * kernel[k + h]; weight += kernel[k + h]
    }
    out[i] = weight ? sum / weight : values[i]
  }
  return out
}
