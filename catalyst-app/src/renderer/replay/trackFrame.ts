// Track-relative placement: a lap placed on the 3D track model by where
// Garmin says it was, not by its GPS.
//
// Garmin measures each sample along its mean line (distance) and across the
// road (lateral_position: 0 at the left edge, 1 at the right). The model's
// road has its own centre and edges (track.json `edges`), which need not sit
// exactly where Garmin's line does: the model is a hand-built track, not a
// survey. So the two lines are tied together station by station: each point
// of Garmin's line is projected onto the model's centre line, giving the
// distance along the model that Garmin's distance stands for (smoothed, and
// never running backwards). A sample then goes to that point of the model's
// centre, and across the model's road by the same share of its width that
// Garmin measured across the real one. Everything placed this way (the car,
// the lines, the coaching marks) agrees with the model, and the car keeps
// the line it drove on the real road.

import type { TrackEdges } from './align'
import type { RoadModel } from './road'

/** A point of the model's road: its centre, the unit vector across it (+ left) and along it, and half its width. */
export interface FramePoint { x: number; z: number; ax: number; az: number; fx: number; fz: number; half: number }

/** How far Garmin's line runs from the model's centre (metres), and how much of it could be tied to the model. */
export interface FrameStats {
  medianM: number; p90M: number; maxM: number; coverage: number
  /** Model stations whose width spiked, bridged over. */
  despiked: number
  /** The model's road width averaged along it (spikes bridged), metres. */
  meanWidthM: number
}

/** Garmin points further than this from the model's centre are not tied (another road, a pit lane). */
const MAX_TIE_M = 20
/** Smoothing of the tie between the lines, Garmin stations either way (≈ metres). */
const TIE_SMOOTH = 8
/** Lane positions are smoothed over this many samples either way (≈ metres). */
export const LANE_SMOOTH = 4
/** The model's road width is judged against the median of this many stations either way. */
const WIDTH_WINDOW = 8
/** A station whose half width is this far from that median is a spike (a pit or service road joining, an edge astray). */
const SPIKE_M = 1.2

export class TrackFrame {
  readonly stats: FrameStats
  /** Arc length of the model's centre at each of its stations; L the whole (closing segment included when it closes). */
  private readonly U: Float64Array
  private readonly L: number
  /** Model arc length (unwrapped) at each of Garmin's stations. */
  private readonly uAt: Float64Array
  private hint = -1
  // The model's road as used here: its centre, across vector and half width, with spikes bridged.
  private readonly cx: Float64Array
  private readonly cz: Float64Array
  private readonly ax: Float64Array
  private readonly az: Float64Array
  private readonly half: Float64Array

  constructor(readonly road: RoadModel, readonly edges: TrackEdges) {
    const n = edges.n
    this.cx = Float64Array.from(edges.cx); this.cz = Float64Array.from(edges.cz)
    this.ax = Float64Array.from(edges.ax); this.az = Float64Array.from(edges.az)
    this.half = Float64Array.from(edges.half)
    const despiked = this.despike()
    this.U = new Float64Array(n)
    for (let k = 1; k < n; k++) this.U[k] = this.U[k - 1] + Math.hypot(this.cx[k] - this.cx[k - 1], this.cz[k] - this.cz[k - 1])
    this.L = this.U[n - 1] + (edges.closed ? Math.hypot(this.cx[0] - this.cx[n - 1], this.cz[0] - this.cz[n - 1]) : 0)

    // Garmin's line onto the model's centre.
    const m = road.n
    const raw = new Float64Array(m).fill(NaN), apart: number[] = []
    let hint = -1
    for (let i = 0; i < m; i++) {
      const gx = road.cx[i], gz = road.cz[i]
      const k = edges.nearest(gx, gz, hint)
      if (k < 0) continue
      hint = k
      const p = this.project(gx, gz, k)
      // Travelling the same way (a crossing or a bridge would not).
      if (this.ax[k] * road.lx[i] + this.az[k] * road.lz[i] < 0.5 || p.dist > MAX_TIE_M) continue
      raw[i] = p.u
      apart.push(p.dist)
    }
    // One pass round: unwrap where the model's start goes by.
    let lift = 0, last = NaN
    for (let i = 0; i < m; i++) {
      if (!Number.isFinite(raw[i])) continue
      if (Number.isFinite(last) && edges.closed) {
        const step = raw[i] + lift - last
        if (step < -this.L / 2) lift += this.L
        else if (step > this.L / 2) lift -= this.L
      }
      raw[i] += lift
      last = raw[i]
    }
    this.uAt = fillGaps(raw, road.dist)
    this.uAt = smoothRun(this.uAt, TIE_SMOOTH)
    for (let i = 1; i < m; i++) if (this.uAt[i] < this.uAt[i - 1]) this.uAt[i] = this.uAt[i - 1]

    apart.sort((a, b) => a - b)
    const q = (p: number) => apart.length ? apart[Math.min(apart.length - 1, Math.floor(p * apart.length))] : NaN
    // The road's width averaged by length along it.
    let widthSum = 0, lengthSum = 0
    for (let k = 1; k < n; k++) { const seg = this.U[k] - this.U[k - 1]; widthSum += (this.half[k] + this.half[k - 1]) * seg; lengthSum += seg }
    const meanWidthM = lengthSum > 0 ? widthSum / lengthSum : 2 * this.half[0]
    this.stats = { medianM: q(0.5), p90M: q(0.9), maxM: apart.length ? apart[apart.length - 1] : NaN, coverage: m ? apart.length / m : 0, despiked, meanWidthM }
  }

  // Where the model's edges stray (a pit or service road joining, a run-off
  // drawn as road), its width jumps for a few stations and its centre with
  // it: those stations take the centre, direction and width of the road
  // either side. Returns how many were bridged.
  private despike(): number {
    const n = this.edges.n, closed = this.edges.closed, half = this.half
    const at = (k: number) => (closed ? ((k % n) + n) % n : Math.min(n - 1, Math.max(0, k)))
    const bad = new Uint8Array(n), window: number[] = []
    for (let k = 0; k < n; k++) {
      window.length = 0
      for (let j = -WIDTH_WINDOW; j <= WIDTH_WINDOW; j++) window.push(half[at(k + j)])
      window.sort((a, b) => a - b)
      if (Math.abs(half[k] - window[WIDTH_WINDOW]) > SPIKE_M) bad[k] = 1
    }
    let count = 0
    for (let k = 0; k < n; k++) {
      if (!bad[k] || (k > 0 && bad[k - 1])) continue
      // A run of bad stations from k; the good ones either side.
      let end = k
      while (end + 1 < n + (closed ? n : 0) && bad[at(end + 1)] && end - k < n) end++
      const a = at(k - 1), b = at(end + 1)
      if (bad[a] || bad[b]) continue
      const span = end - k + 2
      for (let j = k; j <= end; j++) {
        const t = (j - k + 1) / span, i = at(j)
        this.cx[i] = this.cx[a] + (this.cx[b] - this.cx[a]) * t
        this.cz[i] = this.cz[a] + (this.cz[b] - this.cz[a]) * t
        const ax = this.ax[a] + (this.ax[b] - this.ax[a]) * t, az = this.az[a] + (this.az[b] - this.az[a]) * t, len = Math.hypot(ax, az) || 1
        this.ax[i] = ax / len; this.az[i] = az / len
        this.half[i] = half[a] + (half[b] - half[a]) * t
        count++
      }
    }
    return count
  }

  /** Usable: most of Garmin's line was tied to the model. */
  get usable(): boolean { return this.stats.coverage > 0.8 }

  /** The model's road at a distance along Garmin's line (metres, any lap: wrapped round a closed track). */
  at(dist: number, out: FramePoint = {} as FramePoint): FramePoint {
    const road = this.road
    let d = dist
    if (road.closed && road.totalM > 0) d = ((d % road.totalM) + road.totalM) % road.totalM
    const i = road.stationAt(d), j = Math.min(road.n - 1, i + 1)
    const span = road.dist[j] - road.dist[i]
    const f = span > 0 ? Math.min(1, Math.max(0, (d - road.dist[i]) / span)) : 0
    return this.onModel(this.uAt[i] + (this.uAt[j] - this.uAt[i]) * f, out)
  }

  /**
   * The point `share` of the way across the model's road (0 at the left
   * edge, 1 at the right) at a distance along Garmin's line; [x, z]. Garmin's
   * share is where the device is, inside the car: the car's sides can be
   * over an edge while it is not. `widthM`: a width to measure the share
   * across instead of the model's road there (a constant, as Garmin may
   * reckon it), still from the model's centre.
   */
  place(dist: number, share: number, out: [number, number] = [0, 0], widthM?: number): [number, number] {
    const p = this.at(dist, SCRATCH)
    const o = (0.5 - share) * (widthM ?? 2 * p.half)
    out[0] = p.x + p.ax * o; out[1] = p.z + p.az * o
    return out
  }

  /** Where Garmin's frame puts a local point (a GPS position): its distance along Garmin's line and share across the road. */
  garminOf(x: number, z: number, hintDist = NaN): { dist: number; share: number } {
    const road = this.road
    const start = Number.isFinite(hintDist) ? road.stationAt(hintDist) : this.hint >= 0 ? this.hint : 0
    const s = road.nearestFrom(x, z, start, 40)
    this.hint = s
    const sp = road.surface(x, z, s)
    const j = road.wrap(sp.s + 1)
    let dist = road.dist[sp.s] + (road.dist[j] - road.dist[sp.s]) * sp.t
    if (j < sp.s) dist = road.dist[sp.s] + sp.t * Math.max(0, road.totalM - road.dist[sp.s])
    const left = road.left[s], right = road.right[s]
    return { dist, share: (left - sp.o) / Math.max(1, left + right) }
  }

  /** A local point (a GPS position) moved onto the model the way the laps are; [x, z]. */
  mapLocal(x: number, z: number, out: [number, number] = [0, 0], widthM?: number): [number, number] {
    const g = this.garminOf(x, z)
    return this.place(g.dist, g.share, out, widthM)
  }

  // The nearest point of the model's centre to (x, z), around station k: its arc length and distance.
  private project(x: number, z: number, k: number): { u: number; dist: number } {
    const e = this.edges, n = e.n, cx = this.cx, cz = this.cz
    let best = { u: this.U[k], dist: Math.hypot(x - cx[k], z - cz[k]) }
    for (const a of [k - 1, k]) {
      if (a < 0 && !e.closed) continue
      const i = (a + n) % n, j = (i + 1) % n
      if (j === 0 && !e.closed) continue
      const sx = cx[j] - cx[i], sz = cz[j] - cz[i], len2 = sx * sx + sz * sz
      if (len2 < 1e-9) continue
      const t = Math.min(1, Math.max(0, ((x - cx[i]) * sx + (z - cz[i]) * sz) / len2))
      const dist = Math.hypot(x - cx[i] - sx * t, z - cz[i] - sz * t)
      if (dist < best.dist) best = { u: this.U[i] + Math.sqrt(len2) * t, dist }
    }
    return best
  }

  // The model's road at arc length u (any lap).
  private onModel(u: number, out: FramePoint): FramePoint {
    const e = this.edges, n = e.n, U = this.U
    let v = u
    if (e.closed && this.L > 0) v = ((v % this.L) + this.L) % this.L
    else v = Math.min(U[n - 1], Math.max(0, v))
    // The segment holding v: binary search.
    let lo = 0, hi = n - 1
    if (v >= U[n - 1]) lo = n - 1
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (U[mid] <= v) lo = mid; else hi = mid }
    const i = lo, j = e.closed ? (i + 1) % n : Math.min(n - 1, i + 1)
    const segment = j === 0 ? this.L - U[i] : U[j] - U[i]
    const t = segment > 1e-9 ? Math.min(1, Math.max(0, (v - U[i]) / segment)) : 0
    out.x = this.cx[i] + (this.cx[j] - this.cx[i]) * t
    out.z = this.cz[i] + (this.cz[j] - this.cz[i]) * t
    let ax = this.ax[i] + (this.ax[j] - this.ax[i]) * t, az = this.az[i] + (this.az[j] - this.az[i]) * t
    const len = Math.hypot(ax, az) || 1
    ax /= len; az /= len
    out.ax = ax; out.az = az
    // Along: the left normal turned back (across = up × forward).
    out.fx = -az; out.fz = ax
    out.half = this.half[i] + (this.half[j] - this.half[i]) * t
    return out
  }
}

const SCRATCH = {} as FramePoint

// Gaps (no tie) filled along Garmin's distance from the ties either side; the ends run on at one metre per metre.
function fillGaps(raw: Float64Array, dist: Float64Array): Float64Array {
  const n = raw.length, out = Float64Array.from(raw)
  const known: number[] = []
  for (let i = 0; i < n; i++) if (Number.isFinite(raw[i])) known.push(i)
  if (!known.length) { for (let i = 0; i < n; i++) out[i] = dist[i]; return out }
  for (let i = 0; i < known[0]; i++) out[i] = raw[known[0]] - (dist[known[0]] - dist[i])
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k], b = known[k + 1]
    for (let i = a + 1; i < b; i++) out[i] = raw[a] + (raw[b] - raw[a]) * (dist[i] - dist[a]) / Math.max(1e-9, dist[b] - dist[a])
  }
  const last = known[known.length - 1]
  for (let i = last + 1; i < n; i++) out[i] = raw[last] + (dist[i] - dist[last])
  return out
}

// A running mean over `h` either way (shorter at the ends).
function smoothRun(values: Float64Array, h: number): Float64Array {
  const n = values.length, out = new Float64Array(n)
  let sum = 0, count = 0, a = 0, b = -1
  for (let i = 0; i < n; i++) {
    while (b < Math.min(n - 1, i + h)) { b++; sum += values[b]; count++ }
    while (a < i - h) { sum -= values[a]; count--; a++ }
    out[i] = sum / count
  }
  return out
}
