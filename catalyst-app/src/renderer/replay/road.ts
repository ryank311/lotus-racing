// The road: stations along the mean line (~1 m apart), each with a left
// normal, the distance to each tarmac edge, and heights across the road.
// The car, the racing lines and the terrain all read heights from here, so
// they sit on the same surface.

import type { ReplayTrack } from '../../shared/replay'
import { localX, localZ, type LocalFrame } from './geo'
import { lowerIndex, smooth } from './lapPath'

/** Grass verge past each edge, kept at road height (kerbs sit on it). */
export const SHOULDER_M = 2.5
/** Heights across each station: verge, right edge, ⅔, ⅓, centre, ⅓, ⅔, left edge, verge. */
export const LAT = 9
const CENTRE = 4

export interface SurfacePoint {
  /** Height (local y). */
  h: number
  /** Lateral offset from the centre line, + left. */
  o: number
  /** Station and fraction to the next one. */
  s: number
  t: number
}

export class RoadModel {
  readonly n: number
  readonly closed: boolean
  readonly dist: Float64Array
  readonly cx: Float64Array
  readonly cz: Float64Array
  /** Unit left normal (up × forward). */
  readonly lx: Float64Array
  readonly lz: Float64Array
  /** Distance from the line to the left and right tarmac edges. */
  readonly left: Float64Array
  readonly right: Float64Array
  /** n × LAT heights (local y), right verge first. */
  heights: Float32Array
  readonly totalM: number
  readonly widthM: number
  private cells = new Map<number, number[]>()
  private static CELL = 16

  constructor(track: ReplayTrack, frame: LocalFrame) {
    const { line } = track
    let n = line.dist.length
    // Drop a closing point that repeats the first.
    const gap = (a: number, b: number) => Math.hypot(localX(frame, line.lon[a]) - localX(frame, line.lon[b]), localZ(frame, line.lat[a]) - localZ(frame, line.lat[b]))
    if (n > 2 && gap(0, n - 1) < 0.3) n--
    this.n = n
    this.closed = n > 10 && gap(0, n - 1) < 15
    this.totalM = track.totalDistM
    this.widthM = track.widthM || 10
    this.dist = Float64Array.from(line.dist.slice(0, n))
    const rx = line.lon.slice(0, n).map(lon => localX(frame, lon)), rz = line.lat.slice(0, n).map(lat => localZ(frame, lat))
    this.cx = this.closed ? smoothLoop(rx, [1, 2, 1]) : smooth(rx, [1, 2, 1])
    this.cz = this.closed ? smoothLoop(rz, [1, 2, 1]) : smooth(rz, [1, 2, 1])
    this.lx = new Float64Array(n); this.lz = new Float64Array(n)
    const fx = new Array<number>(n), fz = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const a = this.wrap(i - 2), b = this.wrap(i + 2)
      const dx = this.cx[b] - this.cx[a], dz = this.cz[b] - this.cz[a], len = Math.hypot(dx, dz) || 1
      fx[i] = dx / len; fz[i] = dz / len
    }
    const sfx = this.closed ? smoothLoop(fx, [1, 2, 3, 2, 1]) : smooth(fx, [1, 2, 3, 2, 1])
    const sfz = this.closed ? smoothLoop(fz, [1, 2, 3, 2, 1]) : smooth(fz, [1, 2, 3, 2, 1])
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(sfx[i], sfz[i]) || 1
      // up × forward = (fz, 0, -fx): the left of the direction of travel.
      this.lx[i] = sfz[i] / len; this.lz[i] = -sfx[i] / len
    }
    this.left = new Float64Array(n).fill(this.widthM / 2)
    this.right = new Float64Array(n).fill(this.widthM / 2)
    this.heights = new Float32Array(n * LAT)
    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.cx[i], this.cz[i])
      const list = this.cells.get(key)
      if (list) list.push(i)
      else this.cells.set(key, [i])
    }
  }

  wrap(i: number): number {
    const n = this.n
    return this.closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i))
  }

  /** Lateral offset of each height sample at a station (+ left). */
  offset(s: number, k: number): number {
    if (k === 0) return -this.right[s] - SHOULDER_M
    if (k === LAT - 1) return this.left[s] + SHOULDER_M
    return k < CENTRE ? -this.right[s] * (CENTRE - k) / 3 : this.left[s] * (k - CENTRE) / 3
  }

  /** World x/z of a station point at a lateral offset. */
  pointAt(s: number, o: number): [number, number] {
    return [this.cx[s] + this.lx[s] * o, this.cz[s] + this.lz[s] * o]
  }

  /** Station nearest a distance along the line. */
  stationAt(dist: number): number {
    const d = this.closed && this.totalM > 0 ? ((dist % this.totalM) + this.totalM) % this.totalM : dist
    return lowerIndex(this.dist, d)
  }

  private cellKey(x: number, z: number): number {
    return Math.floor(x / RoadModel.CELL) * 100003 + Math.floor(z / RoadModel.CELL)
  }

  /** The nearest station within ~2 cells (32 m), or -1. */
  nearest(x: number, z: number): number {
    const cx = Math.floor(x / RoadModel.CELL), cz = Math.floor(z / RoadModel.CELL)
    let best = -1, bestD = Infinity
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const list = this.cells.get((cx + i) * 100003 + cz + j)
      if (!list) continue
      for (const s of list) {
        const d = (this.cx[s] - x) ** 2 + (this.cz[s] - z) ** 2
        if (d < bestD) { bestD = d; best = s }
      }
    }
    return best
  }

  /** The nearest station searching around a hint (a car moving along the line). */
  nearestFrom(x: number, z: number, hint: number, reach = 25): number {
    let best = hint, bestD = Infinity
    for (let k = -reach; k <= reach; k++) {
      const s = this.wrap(hint + k)
      const d = (this.cx[s] - x) ** 2 + (this.cz[s] - z) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    // Far from the hint (a lap off the line, a bad hint): fall back to the grid.
    if (bestD > 30 * 30) {
      const s = this.nearest(x, z)
      if (s >= 0) return s
    }
    return best
  }

  /** Height across a station at a lateral offset (clamped to the verges). */
  heightAcross(s: number, o: number): number {
    const base = s * LAT
    if (o <= this.offset(s, 0)) return this.heights[base]
    for (let k = 1; k < LAT; k++) {
      const ok = this.offset(s, k)
      if (o <= ok) {
        const op = this.offset(s, k - 1)
        const f = ok > op ? (o - op) / (ok - op) : 0
        return this.heights[base + k - 1] + (this.heights[base + k] - this.heights[base + k - 1]) * f
      }
    }
    return this.heights[base + LAT - 1]
  }

  /** The road surface under a point, from its nearest station. */
  surface(x: number, z: number, s: number, out: SurfacePoint = {} as SurfacePoint): SurfacePoint {
    // Project onto the segment ahead of or behind the station, whichever holds it.
    let a = s, b = this.wrap(s + 1)
    const ahead = (x - this.cx[s]) * (this.cx[b] - this.cx[s]) + (z - this.cz[s]) * (this.cz[b] - this.cz[s])
    if (ahead < 0) { b = s; a = this.wrap(s - 1) }
    const sx = this.cx[b] - this.cx[a], sz = this.cz[b] - this.cz[a], len2 = sx * sx + sz * sz
    const t = a === b || len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((x - this.cx[a]) * sx + (z - this.cz[a]) * sz) / len2))
    const px = this.cx[a] + sx * t, pz = this.cz[a] + sz * t
    const lx = this.lx[a] + (this.lx[b] - this.lx[a]) * t, lz = this.lz[a] + (this.lz[b] - this.lz[a]) * t
    const o = (x - px) * lx + (z - pz) * lz
    out.o = o; out.s = a; out.t = t
    out.h = this.heightAcross(a, o) * (1 - t) + this.heightAcross(b, o) * t
    return out
  }

  heightAt(x: number, z: number, hint: number): number {
    return this.surface(x, z, this.nearestFrom(x, z, hint)).h
  }

  /** Station positions across the road, as lat/lon pairs for terrain sampling. */
  samplePoints(frame: LocalFrame): Float64Array {
    const out = new Float64Array(this.n * LAT * 2)
    for (let s = 0; s < this.n; s++) for (let k = 0; k < LAT; k++) {
      const [x, z] = this.pointAt(s, this.offset(s, k))
      const i = (s * LAT + k) * 2
      out[i] = frame.lat0 - z / frame.mz
      out[i + 1] = frame.lon0 + x / frame.mx
    }
    return out
  }

  /**
   * Heights from the fine DEM (metres above sea level): fill holes, take out
   * short spikes (a bridge deck, a hole in the data) with a running median,
   * then smooth along and across the road.
   */
  setHeights(elevation: Float32Array, baseM: number, fallback?: (s: number, k: number) => number) {
    const n = this.n
    const columns: Float64Array[] = []
    for (let k = 0; k < LAT; k++) {
      const col = new Float64Array(n)
      for (let s = 0; s < n; s++) col[s] = elevation[s * LAT + k] - baseM
      fillGaps(col, this.closed, fallback ? s => fallback(s, k) : undefined)
      columns.push(col)
    }
    // The verges follow the edges' heights within ±0.6 m, so the terrain
    // conforms to a level shoulder instead of a ditch or a bank.
    for (let s = 0; s < n; s++) {
      for (const [verge, edge] of [[0, 1], [LAT - 1, LAT - 2]]) {
        const e = columns[edge][s]
        columns[verge][s] = Math.min(e + 0.6, Math.max(e - 0.6, columns[verge][s]))
      }
    }
    const smoothed = columns.map(col => {
      const med = runningMedian(col, 7, this.closed)
      let out = med
      for (let pass = 0; pass < 3; pass++) out = this.closed ? smoothLoop(out, [1, 2, 3, 2, 1]) : smooth(out, [1, 2, 3, 2, 1])
      return out
    })
    const heights = new Float32Array(n * LAT)
    for (let s = 0; s < n; s++) {
      for (let k = 0; k < LAT; k++) {
        // A light smooth across keeps camber but drops single-sample noise.
        const a = smoothed[Math.max(0, k - 1)][s], b = smoothed[k][s], c = smoothed[Math.min(LAT - 1, k + 1)][s]
        heights[s * LAT + k] = (a + 2 * b + c) / 4
      }
    }
    this.heights = heights
  }

  /**
   * Heights from a 3D track model's surface (local y; NaN where it has none):
   * each station's centre first, then across it near that height, so a
   * bridge over or under the road is never picked. Gaps are interpolated;
   * the model's own camber and kerbs stay as they are.
   */
  setHeightsFromSurface(height: (x: number, z: number, refY: number | null) => number) {
    const n = this.n
    const columns = Array.from({ length: LAT }, () => new Float64Array(n))
    let ref: number | null = null
    for (let s = 0; s < n; s++) {
      const centre = height(this.cx[s], this.cz[s], ref)
      const near = Number.isFinite(centre) ? centre : ref
      for (let k = 0; k < LAT; k++) {
        const [x, z] = this.pointAt(s, this.offset(s, k))
        columns[k][s] = k === CENTRE ? centre : height(x, z, near)
      }
      if (Number.isFinite(centre)) ref = centre
    }
    const heights = new Float32Array(n * LAT)
    for (let k = 0; k < LAT; k++) {
      fillGaps(columns[k], this.closed)
      for (let s = 0; s < n; s++) heights[s * LAT + k] = columns[k][s]
    }
    this.heights = heights
  }

  /** Flat road along the line's own heights (no terrain): one height per station. */
  setFlatHeights(perStation: ArrayLike<number>) {
    const smoothed = this.closed ? smoothLoop(perStation, [1, 2, 3, 4, 3, 2, 1]) : smooth(perStation, [1, 2, 3, 4, 3, 2, 1])
    for (let s = 0; s < this.n; s++) for (let k = 0; k < LAT; k++) this.heights[s * LAT + k] = smoothed[s]
  }

  centreHeight(s: number): number {
    return this.heights[s * LAT + CENTRE]
  }
}

/** Kernel smoothing around a closed loop. */
export function smoothLoop(values: ArrayLike<number>, kernel: number[]): Float64Array {
  const n = values.length, h = kernel.length >> 1
  const total = kernel.reduce((a, b) => a + b, 0)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = -h; k <= h; k++) sum += values[((i + k) % n + n) % n] * kernel[k + h]
    out[i] = sum / total
  }
  return out
}

function runningMedian(values: Float64Array, half: number, closed: boolean): Float64Array {
  const n = values.length, out = new Float64Array(n), window: number[] = []
  for (let i = 0; i < n; i++) {
    window.length = 0
    for (let k = -half; k <= half; k++) {
      const j = closed ? ((i + k) % n + n) % n : i + k
      if (j >= 0 && j < n) window.push(values[j])
    }
    window.sort((a, b) => a - b)
    out[i] = window[window.length >> 1]
  }
  return out
}

// NaN runs: interpolate between the good values either side (around the loop
// when closed), else take the fallback.
function fillGaps(col: Float64Array, closed: boolean, fallback?: (s: number) => number) {
  const n = col.length
  const good: number[] = []
  for (let i = 0; i < n; i++) if (Number.isFinite(col[i])) good.push(i)
  if (!good.length) {
    for (let i = 0; i < n; i++) col[i] = fallback?.(i) ?? 0
    return
  }
  if (good.length === n) return
  for (let g = 0; g < good.length; g++) {
    const a = good[g], b = good[(g + 1) % good.length]
    const span = b > a ? b - a : closed ? b + n - a : 0
    if (span <= 1) continue
    if (!closed && b <= a) break
    for (let k = 1; k < span; k++) col[(a + k) % n] = col[a] + (col[b] - col[a]) * k / span
  }
  if (!closed) {
    for (let i = 0; i < good[0]; i++) col[i] = col[good[0]]
    for (let i = good[good.length - 1] + 1; i < n; i++) col[i] = col[good[good.length - 1]]
  }
}
