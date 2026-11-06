// One lap, ready to play: local positions with a smoothed heading, looked up
// by lap time or by distance along the scene's mean line, and the car
// channels (PDR or Catalyst video) by distance.

import type { ReplayLap } from '../../shared/replay'
import type { CarTrace } from '../../shared/pdr'
import { localX, localZ, type LocalFrame } from './geo'
import { LANE_SMOOTH } from './trackFrame'

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
  /** The path's curvature, 1/m: positive turning left (1 / the radius). */
  curvature: number
}

export type CarChannel = 'throttle' | 'brake' | 'rpm' | 'gear' | 'steering' | 'speed'
const CAR_CHANNELS: readonly CarChannel[] = ['throttle', 'brake', 'rpm', 'gear', 'steering', 'speed']

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
  /** Positions, local metres: the GPS's (lightly smoothed) plus the offset. */
  readonly x: Float64Array
  readonly z: Float64Array
  /** The GPS's own positions, before any offset. */
  readonly gpsX: Float64Array
  readonly gpsZ: Float64Array
  /** The shift applied to the GPS positions (setOffset), metres: aligning the lap with the road (align.ts). */
  offsetX = 0
  offsetZ = 0
  /** Garmin's position across the road, smoothed: 0 the left edge … 1 the right; NaN where it has none (null: no channel). */
  readonly lateral: Float64Array | null
  /** Placed on a track model by Garmin's distance and lane position (place()), not by its GPS. */
  placed = false
  // While placed: how a GPS position from this session moves onto the model (toLocal).
  private mapper: ((x: number, z: number, out: [number, number]) => [number, number]) | null = null
  readonly fx: Float64Array
  readonly fz: Float64Array
  readonly speed: Float64Array
  readonly ax: Float64Array
  readonly ay: Float64Array
  /** Curvature (1/m, + = turning left), smoothed over ~10 m. */
  readonly curv: Float64Array
  readonly durationMs: number
  readonly minSpeed: number
  readonly maxSpeed: number
  readonly car: CarTrace | null
  /**
   * +1 when the steering channel reads positive turning left, −1 when it
   * reads positive turning right (as PDR and Catalyst traces do), 0 when it
   * is missing or does not follow the path's turns.
   */
  readonly steeringSign: number
  /** Whether the video's sync covers any of the lap (fixed: read every frame by the HUD). */
  readonly hasVideo: boolean
  private carDist: number[] = []
  // The channels with any reading, found once (the HUD asks every frame).
  private channels = new Set<CarChannel>()
  // The last lookup (index and fraction), so a frame's lookups allocate nothing.
  private li = 0
  private lf = 0

  constructor(readonly lap: ReplayLap, readonly frame: LocalFrame, totalM: number) {
    const n = this.n = lap.timeMs.length
    this.t = Float64Array.from(lap.timeMs)
    this.d = unwrapDistance(lap.dist, totalM)
    this.dMono = new Float64Array(n)
    for (let i = 0, max = -Infinity; i < n; i++) this.dMono[i] = max = Math.max(max, this.d[i])
    this.durationMs = lap.durationMs || (n ? this.t[n - 1] - this.t[0] : 0)
    // GNSS jitter: a light binomial smooth of the positions.
    const rawX = lap.lon.map(lon => localX(frame, lon)), rawZ = lap.lat.map(lat => localZ(frame, lat))
    this.gpsX = smooth(rawX, [1, 4, 6, 4, 1]); this.gpsZ = smooth(rawZ, [1, 4, 6, 4, 1])
    this.x = Float64Array.from(this.gpsX); this.z = Float64Array.from(this.gpsZ)
    this.fx = new Float64Array(n); this.fz = new Float64Array(n); this.curv = new Float64Array(n)
    this.derive()
    this.speed = filled(lap.speedMps)
    this.ax = filled(lap.accelX)
    this.ay = filled(lap.accelY)
    // Garmin's lane position, lightly smoothed (it reads the lane from the camera).
    this.lateral = lap.lateral?.some(v => v != null) ? smooth(lap.lateral.map(v => v ?? NaN), binomial(LANE_SMOOTH)) : null
    let lo = Infinity, hi = 0
    for (const v of this.speed) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    this.minSpeed = Number.isFinite(lo) ? lo : 0
    this.maxSpeed = hi
    this.car = lap.car
    if (lap.car) this.carDist = lap.car.dist
    for (const key of CAR_CHANNELS) if ((lap.car?.[key] as Array<number | null> | undefined)?.some(v => v != null)) this.channels.add(key)
    this.hasVideo = !!lap.car?.videoT.some(v => v != null)
    this.steeringSign = this.measureSteeringSign()
  }

  // The steering channel's sign convention, from how it follows the path's
  // curvature through the lap (a trace whose steering does not is not used).
  private measureSteeringSign(): number {
    if (!this.hasChannel('steering')) return 0
    let sk = 0, ss = 0, kk = 0
    for (let i = 0; i < this.n; i++) {
      const steering = this.channel('steering', this.d[i])
      if (steering == null) continue
      sk += steering * this.curv[i]; ss += steering * steering; kk += this.curv[i] * this.curv[i]
    }
    const correlation = ss > 0 && kk > 0 ? sk / Math.sqrt(ss * kk) : 0
    return Math.abs(correlation) < 0.5 ? 0 : Math.sign(correlation)
  }

  // Heading over about 3 m each way, then smoothed again; curvature: the
  // heading's turn toward the left (fz, −fx) over about 5 m each way, per
  // metre, then smoothed. From the positions as they are now.
  private derive() {
    const n = this.n
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
    this.fx.set(smooth(hx, kernel)); this.fz.set(smooth(hz, kernel))
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(this.fx[i], this.fz[i]) || 1
      this.fx[i] /= len; this.fz[i] /= len
    }
    // Curvature: the heading's turn toward the left (fz, −fx) over about
    // 5 m each way, per metre, then smoothed.
    const k = new Float64Array(n)
    for (let i = 0, a = 0, b = 0; i < n; i++) {
      while (a < i && s[i] - s[a + 1] >= 5) a++
      b = Math.max(b, i)
      while (b < n - 1 && s[b] - s[i] < 5) b++
      const ds = s[b] - s[a]
      k[i] = ds > 1 ? ((this.fx[b] - this.fx[a]) * this.fz[i] - (this.fz[b] - this.fz[a]) * this.fx[i]) / ds : i ? k[i - 1] : 0
    }
    this.curv.set(smooth(k, [1, 2, 3, 4, 5, 4, 3, 2, 1]))
  }

  /**
   * Places the lap at these positions (a track model's, from Garmin's
   * distance and lane position: trackFrame.ts), with `mapper` moving any other
   * GPS position from its session the same way; null goes back to the GPS
   * plus the offset. Heading and curvature follow. True if it changed.
   */
  place(xs: Float64Array | null, zs: Float64Array | null, mapper: ((x: number, z: number, out: [number, number]) => [number, number]) | null = null): boolean {
    if (xs && zs) {
      this.x.set(xs); this.z.set(zs)
      this.placed = true; this.mapper = mapper
    } else {
      if (!this.placed) return false
      this.placed = false; this.mapper = null
      for (let i = 0; i < this.n; i++) { this.x[i] = this.gpsX[i] + this.offsetX; this.z[i] = this.gpsZ[i] + this.offsetZ }
    }
    this.derive()
    return true
  }

  /**
   * Shifts the whole lap by (dx, dz) metres from the GPS's positions (0, 0:
   * as recorded). A translation: heading and curvature stay. The car, its
   * line and anything else reading `x`/`z` move together. True if it changed.
   */
  setOffset(dx: number, dz: number): boolean {
    if (dx === this.offsetX && dz === this.offsetZ) return false
    this.offsetX = dx; this.offsetZ = dz
    if (this.placed) return true
    for (let i = 0; i < this.n; i++) { this.x[i] = this.gpsX[i] + dx; this.z[i] = this.gpsZ[i] + dz }
    return true
  }

  /**
   * A GPS position from this lap's session (a lat/lon: a suggested line, a
   * marker) in the replay's local metres with the lap's correction applied
   * ("Align to track": the same shift as the lap's own positions), into
   * `out` as [x, z]. Overlays drawn with the lap use this so they move with
   * it; rebuild them when the shift changes (ReplayEngine.onAlignment).
   */
  toLocal(lat: number, lon: number, out: [number, number] = [0, 0]): [number, number] {
    if (this.mapper) return this.mapper(localX(this.frame, lon), localZ(this.frame, lat), out)
    out[0] = localX(this.frame, lon) + this.offsetX
    out[1] = localZ(this.frame, lat) + this.offsetZ
    return out
  }

  /** Sample index and fraction at a lap time (ms from the lap start). */
  at(timeMs: number): [number, number] {
    this.locate(timeMs)
    return [this.li, this.lf]
  }

  private locate(timeMs: number) {
    const t = this.t[0] + timeMs
    const i = lowerIndex(this.t, t), j = Math.min(this.n - 1, i + 1)
    const span = this.t[j] - this.t[i]
    this.li = i
    this.lf = span > 0 ? Math.min(1, Math.max(0, (t - this.t[i]) / span)) : 0
  }

  private mix(a: Float64Array): number {
    const i = this.li, j = Math.min(this.n - 1, i + 1)
    return a[i] + (a[j] - a[i]) * this.lf
  }

  pose(timeMs: number, out: LapPose = {} as LapPose): LapPose {
    this.locate(timeMs)
    out.x = this.mix(this.x); out.z = this.mix(this.z)
    const fx = this.mix(this.fx), fz = this.mix(this.fz), len = Math.hypot(fx, fz) || 1
    out.fx = fx / len; out.fz = fz / len
    out.dist = this.mix(this.d)
    out.speedMps = this.mix(this.speed)
    out.accelX = this.mix(this.ax); out.accelY = this.mix(this.ay)
    out.curvature = this.mix(this.curv)
    return out
  }

  /** The accelerations at a lap time (m/s², as in LapPose), into `out`. */
  accelAt(timeMs: number, out: { accelX: number; accelY: number }) {
    this.locate(timeMs)
    out.accelX = this.mix(this.ax); out.accelY = this.mix(this.ay)
  }

  distAt(timeMs: number): number {
    this.locate(timeMs)
    return this.mix(this.d)
  }

  /** Steering-wheel angle at a distance, degrees, positive turning left; null without a usable steering channel. */
  steeringAt(dist: number): number | null {
    if (!this.steeringSign) return null
    const value = this.channel('steering', dist)
    return value == null ? null : value * this.steeringSign
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
    return this.channels.has(key)
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

/** A binomial kernel reaching `h` either way. */
function binomial(h: number): number[] {
  let row = [1]
  for (let i = 0; i < 2 * h; i++) row = [...row, 0].map((v, k) => v + (k ? row[k - 1] : 0))
  return row
}
