// Another driver's laps on your distance axis.
//
// Catalyst measures lap distance along a mean line, and every device builds
// its own mean line for a course from its own laps. Two drivers' laps on one
// course therefore have different lengths (5,255 m against 5,262 m, say),
// and "2,400 m" is not quite the same spot on track for both. Before their
// laps are measured against your corners, segments and laps, they are moved
// onto your mean line: their mean line is projected onto yours to map their
// metres to yours, and each lap is resampled at your whole metres. Both mean
// lines start at the course's start/finish line, so 0 m agrees.

import fs from 'node:fs'
import path from 'node:path'
import { MEAN_LINES_DIR } from './paths.js'
import { decodeMeanLine } from './decodePerformance.js'
import type { LapSamples } from './lapData.js'

// A mean line's centreline: metres along it with their positions.
export interface MeanLineTrace {
  guid: string
  totalM: number
  dist: number[]
  lat: number[]
  lon: number[]
}

const GUID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// A saved mean line: its centreline, and the course it was recorded on.
export interface MeanLineFile {
  trace: MeanLineTrace
  course: { configurationId: number | null; trackName: string | null; configName: string | null }
}

export function readMeanLineFile(guid: string | null | undefined): MeanLineFile | null {
  if (!guid || !GUID_RE.test(guid)) return null
  const file = path.join(MEAN_LINES_DIR, `${guid}.pb`)
  try {
    if (!fs.existsSync(file)) return null
    const ml = decodeMeanLine(new Uint8Array(fs.readFileSync(file)))
    const trace: MeanLineTrace = { guid, totalM: 0, dist: [], lat: [], lon: [] }
    for (const p of ml.points) {
      if (!finite(p.dist) || !finite(p.lat) || !finite(p.lon)) continue
      const last = trace.dist.at(-1)
      if (last != null && p.dist <= last) continue
      trace.dist.push(p.dist); trace.lat.push(p.lat); trace.lon.push(p.lon)
    }
    trace.totalM = trace.dist.at(-1) ?? 0
    if (!isMeanLineTrace(trace)) return null
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return {
      trace,
      course: {
        configurationId: ml.track_configuration_id ? ml.track_configuration_id : null,
        trackName: text(ml.track_name), configName: text(ml.track_configuration_name),
      },
    }
  } catch (error) {
    console.warn(`[tracks] could not read mean line ${guid}:`, error instanceof Error ? error.message : error)
    return null
  }
}

// About one point every `stepM` metres, keeping both ends (0: unchanged).
export function thinTrace(trace: MeanLineTrace, stepM: number): MeanLineTrace {
  if (!(stepM > 0)) return trace
  const out: MeanLineTrace = { guid: trace.guid, totalM: trace.totalM, dist: [], lat: [], lon: [] }
  trace.dist.forEach((d, i) => {
    const last = out.dist.at(-1)
    if (last != null && d - last < stepM && i < trace.dist.length - 1) return
    out.dist.push(d); out.lat.push(trace.lat[i]); out.lon.push(trace.lon[i])
  })
  return out
}

// A saved mean line, thinned to about one point every `stepM` metres (0: all).
export function readMeanLineTrace(guid: string | null | undefined, stepM = 0): MeanLineTrace | null {
  const file = readMeanLineFile(guid)
  return file ? thinTrace(file.trace, stepM) : null
}

// Structural check for a mean line received from another backend.
export function isMeanLineTrace(value: unknown): value is MeanLineTrace {
  const v = value as MeanLineTrace
  if (!v || typeof v !== 'object' || typeof v.guid !== 'string' || !finite(v.totalM) || v.totalM <= 0) return false
  if (![v.dist, v.lat, v.lon].every(a => Array.isArray(a) && a.length === v.dist.length) || v.dist.length < 3) return false
  return v.dist.every((d, i) => finite(d) && finite(v.lat[i]) && finite(v.lon[i]) && (i === 0 || d > v.dist[i - 1]))
}

// ─── Distance map ───────────────────────────────────────────────────────────

// A point of their line is looked for on yours within this distance of where
// proportional scaling puts it, at most this far off to the side, travelling
// the same way (legs of a hairpin lie side by side in opposite directions).
const SEARCH_M = 75
const MAX_OFFSET_M = 20
const MIN_HEADING_COS = 0.5
// A point whose offset from proportional scaling disagrees with its
// neighbours' by more than this is a stray match and is dropped.
const OUTLIER_M = 6
const OUTLIER_SPAN = 4

// Pairs of [their metres, your metres], strictly increasing in both and
// running from [0, 0] to the two lines' ends.
export type DistanceMap = Array<[number, number]>

const R_EARTH = 6_378_137
const DEG = Math.PI / 180

function firstAtOrAfter(values: number[], target: number): number {
  let lo = 0, hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function distanceMap(theirs: MeanLineTrace, ours: MeanLineTrace): DistanceMap {
  const lat0 = ours.lat[0], lon0 = ours.lon[0], cos0 = Math.cos(lat0 * DEG)
  const xy = (lat: number, lon: number) => ({ x: (lon - lon0) * cos0 * R_EARTH * DEG, y: (lat - lat0) * R_EARTH * DEG })
  const own = ours.dist.map((_, j) => xy(ours.lat[j], ours.lon[j]))
  const pts = theirs.dist.map((_, i) => xy(theirs.lat[i], theirs.lon[i]))
  const scale = ours.totalM / theirs.totalM

  const matches: Array<{ t: number; d: number; offset: number }> = []
  for (let i = 1; i < pts.length - 1; i++) {
    const t = theirs.dist[i]
    if (t <= 0 || t >= theirs.totalM) continue
    const p = pts[i]
    const hx = pts[i + 1].x - pts[i - 1].x, hy = pts[i + 1].y - pts[i - 1].y
    const hl = Math.hypot(hx, hy)
    if (!hl) continue
    const expected = t * scale
    const from = Math.max(0, firstAtOrAfter(ours.dist, expected - SEARCH_M) - 1)
    const to = Math.min(own.length - 1, firstAtOrAfter(ours.dist, expected + SEARCH_M))
    let best = MAX_OFFSET_M ** 2, d = NaN
    for (let j = from; j < to; j++) {
      const a = own[j], b = own[j + 1]
      const sx = b.x - a.x, sy = b.y - a.y, len2 = sx * sx + sy * sy
      if (!len2 || (sx * hx + sy * hy) / (Math.sqrt(len2) * hl) < MIN_HEADING_COS) continue
      const u = Math.min(1, Math.max(0, ((p.x - a.x) * sx + (p.y - a.y) * sy) / len2))
      const ex = a.x + u * sx - p.x, ey = a.y + u * sy - p.y
      const d2 = ex * ex + ey * ey
      if (d2 <= best) { best = d2; d = ours.dist[j] + u * (ours.dist[j + 1] - ours.dist[j]) }
    }
    if (Number.isFinite(d)) matches.push({ t, d, offset: d - expected })
  }

  // The lines differ smoothly, so a match whose offset jumps away from its
  // neighbours' landed on the wrong part of the track.
  const map: DistanceMap = [[0, 0]]
  matches.forEach((m, i) => {
    const near = matches.slice(Math.max(0, i - OUTLIER_SPAN), i + OUTLIER_SPAN + 1).map(n => n.offset)
    if (Math.abs(m.offset - median(near)) > OUTLIER_M) return
    const [lastT, lastD] = map[map.length - 1]
    if (m.t > lastT && m.d > lastD && m.d < ours.totalM) map.push([m.t, m.d])
  })
  map.push([theirs.totalM, ours.totalM])
  return map
}

// One position through the map (their metres → yours). Past either end it
// carries on one to one: a corner zone that runs across the start/finish
// line keeps its overhang.
export function mapPosition(map: DistanceMap, x: number): number {
  const first = map[0], last = map[map.length - 1]
  if (x <= first[0]) return first[1] + (x - first[0])
  if (x >= last[0]) return last[1] + (x - last[0])
  let lo = 0, hi = map.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (map[mid][0] <= x) lo = mid
    else hi = mid
  }
  const [t0, d0] = map[lo], [t1, d1] = map[hi]
  return d0 + (d1 - d0) * (x - t0) / (t1 - t0)
}

// The same map the other way (your metres → theirs). Exact: both ways are
// the same piecewise-linear line, so a round trip returns the start.
export function invertMap(map: DistanceMap): DistanceMap {
  return map.map(([t, d]) => [d, t])
}

// Their metres at one of yours. Beyond the ends the map continues at one to
// one, which only matters for the last metre or two of a lap.
function theirMetres(map: DistanceMap, d: number, from: number): { x: number; k: number } {
  let k = from
  while (k < map.length - 2 && map[k + 1][1] < d) k++
  const [t0, d0] = map[k], [t1, d1] = map[k + 1]
  if (d <= d0 && k === 0) return { x: t0 + (d - d0), k }
  if (d >= d1) return { x: t1 + (d - d1), k }
  return { x: t0 + (t1 - t0) * (d - d0) / (d1 - d0), k }
}

// ─── Resampling ─────────────────────────────────────────────────────────────

const CHANNELS = ['timeMs', 'speed', 'accelX', 'accelY', 'lat', 'lon', 'lateral'] as const
// Gaps wider than this stay gaps (matches valueAt in lapPhases).
const MAX_GAP_M = 25
// Lap ends land within a couple of metres of the mean line's ends.
const END_SLACK_M = 2

function lerp(a: number | null, b: number | null, w: number): number | null {
  if (w <= 0) return a
  if (w >= 1) return b
  return a == null || b == null ? null : a + (b - a) * w
}

// One lap's samples at your whole metres, 0 to your mean line's length.
export function remapLapSamples(samples: LapSamples, map: DistanceMap, ownTotalM: number): LapSamples {
  const out: LapSamples = { dist: [], timeMs: [], speed: [], accelX: [], accelY: [], lat: [], lon: [], lateral: [] }
  const { dist } = samples
  const n = dist.length
  if (!n) return out
  const first = dist[0], last = dist[n - 1]
  let k = 0, hi = 0
  for (let d = 0; d <= Math.round(ownTotalM); d++) {
    const at = theirMetres(map, d, k)
    k = at.k
    let x = at.x
    if (x < first) { if (first - x > END_SLACK_M) continue; x = first }
    if (x > last) { if (x - last > END_SLACK_M) continue; x = last }
    while (hi < n - 1 && dist[hi] < x) hi++
    let lo = hi
    if (dist[hi] > x) {
      lo = hi - 1
      if (lo < 0 || dist[hi] - dist[lo] > MAX_GAP_M) continue
    }
    const w = lo === hi ? 0 : (x - dist[lo]) / (dist[hi] - dist[lo])
    out.dist.push(d)
    for (const key of CHANNELS) out[key].push(lerp(samples[key][lo], samples[key][hi], w))
  }
  return out
}

// Your laps' layout: the mean line they were measured on and its length.
export interface OwnLine {
  guid: string | null
  totalM: number
  trace: MeanLineTrace | null
}

export function ownLine(guid: string | null | undefined, layoutTotalM: number): OwnLine {
  const trace = readMeanLineTrace(guid)
  return { guid: guid ?? null, totalM: trace?.totalM ?? layoutTotalM, trace }
}

// The map from a compared driver's metres to yours: by projection when both
// mean lines are known, else by scaling their lap length to yours. Null when
// no change is needed (same mean line) or possible (your length unknown).
export function mapToOwnLine(theirGuid: string | null, theirLine: MeanLineTrace | null | undefined, theirLapEndM: number, own: OwnLine): DistanceMap | null {
  if (theirGuid && own.guid && theirGuid === own.guid) return null
  if (!(own.totalM > 0)) return null
  if (theirLine && own.trace) return distanceMap(theirLine, own.trace)
  const theirTotal = theirLine?.totalM ?? theirLapEndM
  return theirTotal > 0 ? [[0, 0], [theirTotal, own.totalM]] : null
}
