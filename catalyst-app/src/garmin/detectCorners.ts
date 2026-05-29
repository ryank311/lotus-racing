// Detect corner apexes on a Catalyst meanline using GPS curvature.
// 1:1 port of garmin/detect_corners.py.

import fs from 'node:fs'
import path from 'node:path'
import { decodeMeanLine, MeanLineSegment, MeanLine } from './decodePerformance.js'
import { TRACKS_DIR } from './paths.js'

export function latlonToMeters(lat0: number, lat: number, lon: number): [number, number] {
  const R = 6371000.0
  const rad = (d: number) => (d * Math.PI) / 180
  const x = rad(lon) * R * Math.cos(rad(lat0))
  const y = rad(lat) * R
  return [x, y]
}

export function smooth(values: number[], window: number): number[] {
  const n = values.length
  const half = Math.floor(window / 2)
  if (n < window) {
    const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, n)
    return new Array(n).fill(avg)
  }
  const out = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let lo: number, hi: number
    if (i <= half) {
      lo = 0
      hi = i + half + 1
    } else if (i >= n - half) {
      lo = i - half
      hi = n
    } else {
      lo = i - half
      hi = i + half + 1
    }
    let s = 0
    for (let k = lo; k < hi; k++) s += values[k]
    out[i] = s / (hi - lo)
  }
  return out
}

export function discreteCurvature(xs: number[], ys: number[]): number[] {
  const n = xs.length
  const out = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const ax = xs[i] - xs[i - 1]
    const ay = ys[i] - ys[i - 1]
    const bx = xs[i + 1] - xs[i]
    const by = ys[i + 1] - ys[i]
    const cross = ax * by - ay * bx
    const lenA = Math.hypot(ax, ay)
    const lenB = Math.hypot(bx, by)
    const lenC = Math.hypot(xs[i + 1] - xs[i - 1], ys[i + 1] - ys[i - 1])
    const denom = lenA * lenB * lenC
    if (denom < 1e-9) continue
    out[i] = (2.0 * Math.abs(cross)) / denom
  }
  return out
}

export function findCornerApexes(
  curvature: number[],
  minCurvature = 0.005,
  minSeparationPts = 50,
): number[] {
  const n = curvature.length
  const apexes: number[] = []
  let i = 0
  while (i < n) {
    if (curvature[i] < minCurvature) {
      i++
      continue
    }
    let j = i
    while (j + 1 < n && curvature[j + 1] >= curvature[j]) j++
    const peakIdx = j
    while (
      j + 1 < n &&
      curvature[j + 1] < curvature[j] &&
      curvature[j + 1] >= minCurvature * 0.3
    )
      j++
    if (apexes.length === 0 || peakIdx - apexes[apexes.length - 1] >= minSeparationPts) {
      apexes.push(peakIdx)
    }
    i = j + 1
  }
  return apexes
}

export function cornerZone(curvature: number[], apex: number): [number, number] {
  const peak = curvature[apex]
  const thresh = peak * 0.5
  let lo = apex
  while (lo > 0 && curvature[lo - 1] >= thresh) lo--
  let hi = apex
  const n = curvature.length
  while (hi + 1 < n && curvature[hi + 1] >= thresh) hi++
  return [lo, hi]
}

interface CanonicalTurn {
  turn: string
  name: string
  direction?: string
  character?: string
}

const VIR_FULL_TURNS: CanonicalTurn[] = [
  { turn: 'T1', name: 'Horse Shoe', direction: 'right',
    character: 'long slow right off the front straight; heavy braking from high speed' },
  { turn: 'T2-T3', name: 'Connectors', direction: 'right',
    character: 'fast transition corners after 2014 repave' },
  { turn: 'T4', name: 'NASCAR Bend', direction: 'left',
    character: 'slow tight left, sets up the Snake' },
  { turn: 'T5a-T5b', name: 'Snake Entry', direction: 'L→R',
    character: 'cambered medium-speed, near flat-throttle exit' },
  { turn: 'T6a-T6b', name: 'Snake Exit', direction: 'L→R',
    character: 'full throttle ideal, avoid inside curb' },
  { turn: 'T7', name: 'Climbing Esses', direction: 'right',
    character: 'uphill, blind crest, late apex — most exciting feature of VIR' },
  { turn: 'T8a-T8b', name: 'Climbing Esses 2', direction: 'R→L',
    character: 'crests, blind uphill' },
  { turn: 'T9', name: 'Esses Exit', direction: 'left',
    character: 'more open, partial→full throttle' },
  { turn: 'T10', name: 'South Bend', direction: 'left',
    character: 'fast downhill blind-crested left' },
  { turn: 'T11', name: 'Oak Tree Entry', direction: 'left', character: 'approach to Oak Tree' },
  { turn: 'T12', name: 'Oak Tree', direction: 'right',
    character: 'MOST IMPORTANT corner for lap time — feeds 4000ft back straight' },
  { turn: 'T13', name: 'RC Entry', direction: 'left',
    character: 'short uphill jog, very brief braking zone after long back straight' },
  { turn: 'T14', name: 'Roller Coaster', direction: 'right',
    character: "cresting hill, trailbrake — VIR's mirror of Laguna Corkscrew" },
  { turn: 'T15', name: 'RC Exit', direction: 'left', character: 'downhill, full or partial throttle' },
  { turn: 'T16-T17', name: 'Hog Pen', direction: 'L→R',
    character: 'late apex; getting to full throttle early is critical for front straight speed' },
]

function getCanonicalTurns(trackName?: string, configName?: string): CanonicalTurn[] {
  if (trackName === 'Virginia International Raceway' && configName === 'Full Course') {
    return VIR_FULL_TURNS
  }
  return []
}

export interface CornerInfo {
  turn: string
  name: string
  direction: string
  character: string
  apex_idx: number
  dist_idx_start: number
  dist_idx_end: number
  apex_lat: number
  apex_lon: number
  apex_radius_m: number
}

export function detectCornersFromMeanline(ml: MeanLine, opts: { minCurvature?: number; smoothWindow?: number } = {}): {
  corners: CornerInfo[]
  segments: MeanLineSegment[]
  totalDistM: number
  pointCount: number
} {
  const minCurvature = opts.minCurvature ?? 0.005
  const smoothWindow = opts.smoothWindow ?? 25
  const pts = ml.points
  if (pts.length < 10) throw new Error(`meanline has only ${pts.length} points`)

  const lat0 = pts[0].lat
  const xs = pts.map(p => latlonToMeters(lat0, p.lat, p.lon)[0])
  const ys = pts.map(p => latlonToMeters(lat0, p.lat, p.lon)[1])

  let kappa = discreteCurvature(xs, ys)
  kappa = smooth(kappa, smoothWindow)

  const apexes = findCornerApexes(kappa, minCurvature)
  const canonical = getCanonicalTurns(ml.track_name, ml.track_configuration_name)

  const corners: CornerInfo[] = apexes.map((apex, i) => {
    const [lo, hi] = cornerZone(kappa, apex)
    const radius = kappa[apex] > 1e-9 ? 1.0 / kappa[apex] : 9999.0
    const can = canonical[i]
    return {
      turn: can?.turn ?? `C${i + 1}`,
      name: can?.name ?? `Corner ${i + 1}`,
      direction: can?.direction ?? '',
      character: can?.character ?? '',
      apex_idx: apex,
      dist_idx_start: lo,
      dist_idx_end: hi,
      apex_lat: pts[apex].lat,
      apex_lon: pts[apex].lon,
      apex_radius_m: radius,
    }
  })

  return {
    corners,
    segments: ml.segments,
    totalDistM: pts[pts.length - 1].dist,
    pointCount: pts.length,
  }
}

export function dumpTrackYaml(
  trackName: string,
  configName: string,
  meanlineGuid: string,
  totalDistM: number,
  pointCount: number,
  corners: CornerInfo[],
  segments: MeanLineSegment[] = [],
): string {
  const lines: string[] = []
  lines.push('# Auto-generated by detectCorners.ts')
  lines.push('# Segments are Garmin\'s official reference segments from the meanline.')
  lines.push('# Corner list is derived from GPS curvature + canonical name lookup.')
  lines.push(`track_name: ${trackName}`)
  lines.push(`track_configuration_name: ${configName}`)
  lines.push(`mean_line_guid: ${meanlineGuid}`)
  lines.push(`total_dist_m: ${totalDistM.toFixed(2)}`)
  lines.push(`point_count: ${pointCount}`)
  lines.push('')
  if (segments.length) {
    lines.push('# Garmin reference segments (from meanline.pb field 7).')
    lines.push('segments:')
    for (const s of segments) {
      const length = s.end_dist_m - s.start_dist_m
      lines.push(`  - id: ${s.id}`)
      lines.push(`    start_dist_m: ${s.start_dist_m}`)
      lines.push(`    end_dist_m: ${s.end_dist_m}`)
      lines.push(`    length_m: ${length}`)
      lines.push(`    flag: ${s.flag}`)
    }
    lines.push('')
  }
  lines.push('# Named corners in driving order.')
  lines.push('corners:')
  for (const c of corners) {
    lines.push(`  - turn: ${c.turn}`)
    lines.push(`    name: "${c.name}"`)
    if (c.direction) lines.push(`    direction: ${c.direction}`)
    if (c.character) lines.push(`    character: "${c.character}"`)
    lines.push(`    apex_idx: ${c.apex_idx}`)
    lines.push(`    dist_idx_start: ${c.dist_idx_start}`)
    lines.push(`    dist_idx_end: ${c.dist_idx_end}`)
    lines.push(`    apex_lat: ${c.apex_lat.toFixed(7)}`)
    lines.push(`    apex_lon: ${c.apex_lon.toFixed(7)}`)
    lines.push(`    apex_radius_m: ${c.apex_radius_m.toFixed(1)}`)
  }
  return lines.join('\n') + '\n'
}

export function detectCornersFromFile(meanlinePbPath: string, outPath?: string): string {
  const raw = fs.readFileSync(meanlinePbPath)
  const ml = decodeMeanLine(new Uint8Array(raw))
  const result = detectCornersFromMeanline(ml)
  const yaml = dumpTrackYaml(
    ml.track_name ?? '',
    ml.track_configuration_name ?? '',
    ml.mean_line_guid ?? '',
    result.totalDistM,
    result.pointCount,
    result.corners,
    result.segments,
  )
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, yaml)
  } else {
    fs.mkdirSync(TRACKS_DIR, { recursive: true })
    const slug = (ml.track_configuration_name || 'track').toLowerCase().replace(/ /g, '-')
    const out = path.join(TRACKS_DIR, `vir-${slug}.yaml`)
    fs.writeFileSync(out, yaml)
  }
  return yaml
}
