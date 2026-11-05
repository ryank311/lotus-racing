// Garmin's mean line is the average driven line, not the middle of the
// tarmac. This finds the real edges in the aerial photo: along each
// station's normal, the run of grey tarmac around the line, smoothed, with
// ±width/2 wherever the photo is unclear (shadows, paved run-off, pit lane).

import type { GeoBox } from '../../shared/replay'
import { imagePos, latAt, lonAt, type LocalFrame } from './geo'
import type { RoadModel } from './road'

export interface EdgeStats {
  /** Share of stations where both edges were found. */
  found: number
  /** Median of (left − right) / 2: how far the tarmac centre sits left of the mean line. */
  medianShiftM: number
  /** 90th percentile of |shift|. */
  p90ShiftM: number
  /** Median tarmac width where found. */
  medianWidthM: number
  applied: boolean
}

const SCAN_M = 16
const STEP_M = 0.25
// A painted line, a patch or a crack is not the edge.
const MAX_GAP_M = 0.75

interface Rgb { r: number; g: number; b: number }

function sampler(pixels: ImageData, area: GeoBox, frame: LocalFrame) {
  const { width, height, data } = pixels
  const out: Rgb = { r: 0, g: 0, b: 0 }
  return (x: number, z: number): Rgb | null => {
    const [px, py] = imagePos(area, width, height, latAt(frame, z), lonAt(frame, x))
    if (px < 0 || py < 0 || px >= width - 1 || py >= height - 1) return null
    const i = Math.floor(px), j = Math.floor(py), u = px - i, v = py - j
    const at = (a: number, b: number, c: number) => data[(b * width + a) * 4 + c]
    const mix = (c: number) => at(i, j, c) * (1 - u) * (1 - v) + at(i + 1, j, c) * u * (1 - v) + at(i, j + 1, c) * (1 - u) * v + at(i + 1, j + 1, c) * u * v
    out.r = mix(0); out.g = mix(1); out.b = mix(2)
    return out
  }
}

const lum = (c: Rgb) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
const chroma = (c: Rgb) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
const greenness = (c: Rgb) => c.g - (c.r + c.b) / 2

/** Finds the edges and, when the photo is clear enough, moves the road's edges onto them. */
export function fitEdgesToImage(road: RoadModel, pixels: ImageData, area: GeoBox, frame: LocalFrame): EdgeStats {
  const sample = sampler(pixels, area, frame)
  const n = road.n, half = road.widthM / 2
  const steps = Math.round(SCAN_M / STEP_M)
  const rawLeft = new Float64Array(n).fill(NaN), rawRight = new Float64Array(n).fill(NaN)
  const lums: number[] = [], chromas: number[] = []
  for (let s = 0; s < n; s++) {
    // The tarmac's own shade and greyness here, from the middle few metres
    // (the line is on it). Dry grass beside it can be nearly as light, but
    // is never as grey.
    lums.length = chromas.length = 0
    for (let o = -2; o <= 2; o += 0.5) {
      const c = sample(road.cx[s] + road.lx[s] * o, road.cz[s] + road.lz[s] * o)
      if (c && chroma(c) < 16 && greenness(c) < 10) { lums.push(lum(c)); chromas.push(chroma(c)) }
    }
    if (lums.length < 5) continue
    lums.sort((a, b) => a - b); chromas.sort((a, b) => a - b)
    const refLum = lums[lums.length >> 1], maxChroma = Math.max(9, chromas[chromas.length >> 1] + 4)
    const tarmac = (o: number) => {
      const c = sample(road.cx[s] + road.lx[s] * o, road.cz[s] + road.lz[s] * o)
      // White paint and lighter patches count as road; shadow is a gap.
      return !!c && chroma(c) <= maxChroma && greenness(c) < 6 && lum(c) > refLum - 24
    }
    const walk = (dir: 1 | -1) => {
      let last = 0, gap = 0
      for (let k = 1; k <= steps; k++) {
        const o = dir * k * STEP_M
        if (tarmac(o)) { last = k * STEP_M; gap = 0 }
        else if ((gap += STEP_M) > MAX_GAP_M) return last
      }
      return NaN // paved all the way out: run-off or pit lane, not an edge
    }
    const left = walk(1), right = walk(-1)
    const width = left + right
    if (left >= 2 && right >= 2 && width > half * 1.3 && width < half * 3) { rawLeft[s] = left; rawRight[s] = right }
  }

  const found = rawLeft.reduce((count, v) => count + (Number.isFinite(v) ? 1 : 0), 0) / Math.max(1, n)
  const shifts: number[] = [], widths: number[] = []
  for (let s = 0; s < n; s++) if (Number.isFinite(rawLeft[s])) { shifts.push((rawLeft[s] - rawRight[s]) / 2); widths.push(rawLeft[s] + rawRight[s]) }
  const sortedShift = [...shifts].sort((a, b) => a - b), absShift = shifts.map(Math.abs).sort((a, b) => a - b)
  widths.sort((a, b) => a - b)
  const stats: EdgeStats = {
    found,
    medianShiftM: sortedShift[sortedShift.length >> 1] ?? 0,
    p90ShiftM: absShift[Math.floor(absShift.length * 0.9)] ?? 0,
    medianWidthM: widths[widths.length >> 1] ?? road.widthM,
    applied: false,
  }
  if (found < 0.25) return stats

  const smoothSide = (raw: Float64Array) => {
    // Running median over ±12 m of what was found, then ±width/2 elsewhere,
    // then a smooth so a fallback stretch joins without a step.
    const med = new Float64Array(n), window: number[] = []
    for (let s = 0; s < n; s++) {
      window.length = 0
      for (let k = -12; k <= 12; k++) {
        const v = raw[road.wrap(s + k)]
        if (Number.isFinite(v)) window.push(v)
      }
      window.sort((a, b) => a - b)
      med[s] = window.length >= 8 ? window[window.length >> 1] : half
    }
    let out = med
    for (let pass = 0; pass < 4; pass++) {
      const next = new Float64Array(n)
      for (let s = 0; s < n; s++) {
        let sum = 0
        for (let k = -4; k <= 4; k++) sum += out[road.wrap(s + k)]
        next[s] = sum / 9
      }
      out = next
    }
    return out
  }
  const left = smoothSide(rawLeft), right = smoothSide(rawRight)
  for (let s = 0; s < n; s++) {
    road.left[s] = Math.min(half * 1.7, Math.max(half * 0.6, left[s]))
    road.right[s] = Math.min(half * 1.7, Math.max(half * 0.6, right[s]))
  }
  stats.applied = true
  return stats
}
