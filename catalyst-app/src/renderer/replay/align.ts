// Lines a lap's GPS up with the road it is drawn on. The Catalyst's GNSS is
// uncorrected: its position carries an offset of a metre or more that holds
// through a lap and drifts slowly over a session (at VIR, across 394 laps of
// 60 sessions, a median 2.2 m and up to 5.8 m; laps of one session agree to
// about 0.5 m). Drawn as recorded, a lap runs off the road where the driver
// used its edge. So each lap is shifted, as a whole, by the smallest
// translation that keeps the car on the road: past an edge (less a margin
// for the car's body) costs, inside costs nothing, and a small pull toward no
// shift settles the rest. Real excursions stay: the cost grows only linearly
// past a metre and ignores points far off (the pit lane, a trip into the
// run-off), the shift is bounded, and once it settles, points still well
// off the road are let go and it settles again without them.

import * as THREE from 'three'
import type { RoadModel } from './road'

/** The penalty starts this far inside an edge: the GPS rides about half a car's width in from its side. */
const MARGIN_M = 0.8
/** Past an edge, the cost is quadratic to here, then linear (an excursion pulls no harder). */
const HUBER_M = 1
/** Points further than this past an edge are not the road's business (pit lane, run-off, a spin). */
const FAR_M = 15
/** Once the lap is on the road, points still this far past an edge are an excursion: they no longer pull. */
const EXCURSION_M = 3
/** The largest shift: just above the GNSS offsets seen (5.8 m), well short of a wrong road. */
export const MAX_SHIFT_M = 6
/** The pull toward no shift, per point (≈1.6 per square metre for a 5 km lap at 1 m). */
const PRIOR_PER_POINT = 3e-4
/** A lap must lie along the road for at least this share of its points to be aligned. */
const MIN_COVERAGE = 0.6

/**
 * The road's two edges, station by station along the direction of travel,
 * in the replay's local metres: the centre between them, the unit vector
 * across (toward the left edge) and the half width.
 */
export class TrackEdges {
  readonly n: number
  readonly closed: boolean
  readonly cx: Float64Array
  readonly cz: Float64Array
  readonly ax: Float64Array
  readonly az: Float64Array
  readonly half: Float64Array
  /** Stations searched either side of a hint (about 25 m). */
  private readonly reach: number
  private readonly cells = new Map<number, number[]>()
  private static CELL = 16

  /** `left` and `right`: x, z pairs, one per station. */
  constructor(left: ArrayLike<number>, right: ArrayLike<number>) {
    let n = Math.min(left.length, right.length) >> 1
    const gap = (a: number, b: number) => Math.hypot(left[2 * a] + right[2 * a] - left[2 * b] - right[2 * b], left[2 * a + 1] + right[2 * a + 1] - left[2 * b + 1] - right[2 * b + 1]) / 2
    // A closing station that repeats the first.
    if (n > 2 && gap(0, n - 1) < 0.3) n--
    this.n = n
    this.cx = new Float64Array(n); this.cz = new Float64Array(n)
    this.ax = new Float64Array(n); this.az = new Float64Array(n); this.half = new Float64Array(n)
    let length = 0
    for (let i = 0; i < n; i++) {
      const lx = left[2 * i], lz = left[2 * i + 1], rx = right[2 * i], rz = right[2 * i + 1]
      const w = Math.hypot(lx - rx, lz - rz) || 1e-6
      this.cx[i] = (lx + rx) / 2; this.cz[i] = (lz + rz) / 2
      this.ax[i] = (lx - rx) / w; this.az[i] = (lz - rz) / w; this.half[i] = w / 2
      if (i) length += Math.hypot(this.cx[i] - this.cx[i - 1], this.cz[i] - this.cz[i - 1])
    }
    this.closed = n > 10 && gap(0, n - 1) < 3 * Math.max(1, length / Math.max(1, n - 1))
    this.reach = Math.max(4, Math.ceil(25 / Math.max(0.5, length / Math.max(1, n - 1))))
    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.cx[i], this.cz[i])
      const list = this.cells.get(key)
      if (list) list.push(i)
      else this.cells.set(key, [i])
    }
  }

  /** The generated road's edges (public data): the mean line and its tarmac edges. */
  static fromRoad(road: RoadModel): TrackEdges {
    const left = new Float64Array(road.n * 2), right = new Float64Array(road.n * 2)
    for (let s = 0; s < road.n; s++) {
      const [lx, lz] = road.pointAt(s, road.left[s]), [rx, rz] = road.pointAt(s, -road.right[s])
      left[2 * s] = lx; left[2 * s + 1] = lz; right[2 * s] = rx; right[2 * s + 1] = rz
    }
    return new TrackEdges(left, right)
  }

  /** A track model's edges (TrackModelLayout.edges, glTF metres) placed by its georef matrix. */
  static fromModel(edges: ReadonlyArray<readonly [number, number, number, number]>, matrix: THREE.Matrix4): TrackEdges {
    const left = new Float64Array(edges.length * 2), right = new Float64Array(edges.length * 2)
    const v = new THREE.Vector3()
    edges.forEach(([lx, lz, rx, rz], i) => {
      v.set(lx, 0, lz).applyMatrix4(matrix); left[2 * i] = v.x; left[2 * i + 1] = v.z
      v.set(rx, 0, rz).applyMatrix4(matrix); right[2 * i] = v.x; right[2 * i + 1] = v.z
    })
    return new TrackEdges(left, right)
  }

  private wrap(i: number): number {
    return this.closed ? ((i % this.n) + this.n) % this.n : Math.min(this.n - 1, Math.max(0, i))
  }

  private cellKey(x: number, z: number): number {
    return Math.floor(x / TrackEdges.CELL) * 100003 + Math.floor(z / TrackEdges.CELL)
  }

  /** The station nearest (x, z): around a hint (a lap moving along), else from the grid (−1 when none is within ~32 m). */
  nearest(x: number, z: number, hint = -1): number {
    let best = -1, bestD = Infinity
    if (hint >= 0) for (let k = -this.reach; k <= this.reach; k++) {
      const s = this.wrap(hint + k), d = (this.cx[s] - x) ** 2 + (this.cz[s] - z) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    if (best >= 0 && bestD <= 30 * 30) return best
    const cx = Math.floor(x / TrackEdges.CELL), cz = Math.floor(z / TrackEdges.CELL)
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      for (const s of this.cells.get((cx + i) * 100003 + cz + j) ?? []) {
        const d = (this.cx[s] - x) ** 2 + (this.cz[s] - z) ** 2
        if (d < bestD) { bestD = d; best = s }
      }
    }
    return best
  }

  /**
   * Where (x, z) sits across the road near station `s`: the offset from the
   * centre along the across vector (+ left), the half width and the across
   * vector there, into `out`.
   */
  across(x: number, z: number, s: number, out: Across): void {
    let a = s, b = this.wrap(s + 1)
    if ((x - this.cx[a]) * (this.cx[b] - this.cx[a]) + (z - this.cz[a]) * (this.cz[b] - this.cz[a]) < 0) { b = a; a = this.wrap(a - 1) }
    const sx = this.cx[b] - this.cx[a], sz = this.cz[b] - this.cz[a], len2 = sx * sx + sz * sz
    const t = a === b || len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((x - this.cx[a]) * sx + (z - this.cz[a]) * sz) / len2))
    let ax = this.ax[a] + (this.ax[b] - this.ax[a]) * t, az = this.az[a] + (this.az[b] - this.az[a]) * t
    const len = Math.hypot(ax, az) || 1
    ax /= len; az /= len
    out.o = (x - this.cx[a] - sx * t) * ax + (z - this.cz[a] - sz * t) * az
    out.half = this.half[a] + (this.half[b] - this.half[a]) * t
    out.ax = ax; out.az = az
  }
}

export interface Across { o: number; half: number; ax: number; az: number }

/** How much of a lap's line runs past the road's edges. */
export interface OffRoad {
  /** Metres of the lap with the line past an edge. */
  metres: number
  /** The furthest past an edge, metres (0 when it never leaves). */
  maxM: number
}

export interface RoadFit {
  /** The shift that puts the lap on the road, local metres (x east, z south). */
  dx: number
  dz: number
  /** Off the road as recorded, and shifted. */
  before: OffRoad
  after: OffRoad
  /** Share of the lap's points along the road (within FAR_M of it). */
  coverage: number
  /** Whether the shift is used: the lap follows the road enough to judge. */
  applied: boolean
}

const SCRATCH: Across = { o: 0, half: 0, ax: 0, az: 0 }

/** Distance past the nearer edge (negative inside), at a shift. */
function pastEdge(edges: TrackEdges, x: number, z: number, hint: number): [number, number] {
  const s = edges.nearest(x, z, hint)
  if (s < 0) return [Infinity, -1]
  edges.across(x, z, s, SCRATCH)
  return [Math.abs(SCRATCH.o) - SCRATCH.half, s]
}

function offRoad(x: ArrayLike<number>, z: ArrayLike<number>, edges: TrackEdges, dx: number, dz: number): OffRoad {
  let metres = 0, maxM = 0, hint = -1
  for (let i = 0; i < x.length; i++) {
    const [past, s] = pastEdge(edges, x[i] + dx, z[i] + dz, hint)
    if (s >= 0) hint = s
    if (!(past > 0) || past > FAR_M) continue
    maxM = Math.max(maxM, past)
    const j = i ? i - 1 : Math.min(x.length - 1, 1)
    metres += Math.hypot(x[i] - x[j], z[i] - z[j])
  }
  return { metres, maxM }
}

/**
 * The shift that best fits a lap's line (local x/z, about a metre apart) on
 * the road: Gauss–Newton on the squared distance past the edges (less the
 * margin), Huber beyond HUBER_M, with a light pull toward no shift and the
 * result bounded by MAX_SHIFT_M; then again leaving out points still more
 * than EXCURSION_M off (real excursions).
 */
export function fitToRoad(x: ArrayLike<number>, z: ArrayLike<number>, edges: TrackEdges): RoadFit {
  const n = Math.min(x.length, z.length)
  const prior = PRIOR_PER_POINT * n
  const hints = new Int32Array(n).fill(-1)
  let dx = 0, dz = 0, near = 0
  // Huber first (it pulls a lap metres off back in); then without the excursions.
  let settled = false
  for (let iter = 0; iter < 60; iter++) {
    let a = prior, b = 0, c = prior, p = -prior * dx, q = -prior * dz
    near = 0
    for (let i = 0, hint = -1; i < n; i++) {
      const px = x[i] + dx, pz = z[i] + dz
      const s = edges.nearest(px, pz, hints[i] >= 0 ? hints[i] : hint)
      if (s < 0) continue
      hints[i] = hint = s
      edges.across(px, pz, s, SCRATCH)
      const { o, half, ax, az } = SCRATCH
      const past = Math.abs(o) - half
      if (past > FAR_M) continue
      near++
      const r = past + MARGIN_M
      if (r <= 0) continue
      // d(past)/d(shift) = ±across, outward.
      const gx = o > 0 ? ax : -ax, gz = o > 0 ? az : -az
      if (settled && r > EXCURSION_M) continue
      const w = r <= HUBER_M ? 1 : HUBER_M / r
      a += w * gx * gx; b += w * gx * gz; c += w * gz * gz; p -= w * gx * r; q -= w * gz * r
    }
    const det = a * c - b * b
    if (!(det > 1e-12)) break
    const sx = (c * p - b * q) / det, sz = (a * q - b * p) / det
    dx += sx; dz += sz
    const len = Math.hypot(dx, dz)
    if (len > MAX_SHIFT_M) { dx *= MAX_SHIFT_M / len; dz *= MAX_SHIFT_M / len }
    if (Math.hypot(sx, sz) < 1e-3) {
      if (settled) break
      settled = true
    }
  }
  const coverage = n ? near / n : 0
  return {
    dx, dz,
    before: offRoad(x, z, edges, 0, 0),
    after: offRoad(x, z, edges, dx, dz),
    coverage,
    applied: coverage >= MIN_COVERAGE,
  }
}
