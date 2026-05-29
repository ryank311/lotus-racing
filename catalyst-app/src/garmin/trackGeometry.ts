// Build a renderable track geometry from a Garmin Catalyst mean_line.pb.
//
// The mean line is ~5256 GPS points at 1 m spacing along the centerline,
// plus per-point heading and a single global track width (~10.64 m for VIR).
// We project lat/lon to a track-local meter grid (equirectangular at the
// centroid latitude — sub-cm accurate for a 3-mile track) and extrude
// ±width/2 perpendicular to heading to get the left/right edge polylines.

import fs from 'node:fs'
import path from 'node:path'
import { MEAN_LINES_DIR } from './paths.js'
import { decodeMeanLine } from './decodePerformance.js'

const R_EARTH = 6_378_137  // WGS84 equatorial radius in metres
const DEG = Math.PI / 180

export interface Projection {
  lat0: number
  lon0: number
  cosLat0: number
}

export interface TrackGeometry {
  meanLineGuid: string
  trackName: string
  configName: string
  totalDistM: number
  widthM: number
  projection: Projection
  // Track-local metres, y = north, x = east. We'll flip in the renderer.
  centerline: { x: number; y: number; dist: number; heading: number; lat: number; lon: number }[]
  leftEdge: { x: number; y: number }[]
  rightEdge: { x: number; y: number }[]
  bbox: { minX: number; maxX: number; minY: number; maxY: number }
  // Sector boundaries from the proto's ReferenceSegments (with flag=1, the
  // "primary" sectors). distM marks the position along the centerline.
  sectorMarks: { distM: number; type: 'start' | 'end' }[]
}

export function projectLatLon(lat: number, lon: number, p: Projection): { x: number; y: number } {
  return {
    x: (lon - p.lon0) * p.cosLat0 * R_EARTH * DEG,
    y: (lat - p.lat0) * R_EARTH * DEG,
  }
}

export function projectMany(
  pts: Array<{ lat: number; lon: number }>,
  p: Projection,
): Array<{ x: number; y: number }> {
  return pts.map(pt => projectLatLon(pt.lat, pt.lon, p))
}

// Derive a heading (radians, 0 = +x = east, increasing CCW) from a sequence
// of projected points. Used when we want a tangent direction independent of
// the proto's heading_deg (which is compass: 0 = north, increasing CW).
function tangentRadians(pts: Array<{ x: number; y: number }>, i: number): number {
  const n = pts.length
  const a = pts[(i - 1 + n) % n]
  const b = pts[(i + 1) % n]
  return Math.atan2(b.y - a.y, b.x - a.x)
}

export function buildTrackGeometry(meanLineGuid: string): TrackGeometry | null {
  const pbPath = path.join(MEAN_LINES_DIR, `${meanLineGuid}.pb`)
  if (!fs.existsSync(pbPath)) return null

  const ml = decodeMeanLine(new Uint8Array(fs.readFileSync(pbPath)))
  if (!ml.points.length) return null

  // Project around the centroid of all centerline points — keeps distortion
  // symmetric and well under a centimetre at VIR's scale.
  let latSum = 0, lonSum = 0
  for (const pt of ml.points) { latSum += pt.lat; lonSum += pt.lon }
  const lat0 = latSum / ml.points.length
  const lon0 = lonSum / ml.points.length
  const projection: Projection = { lat0, lon0, cosLat0: Math.cos(lat0 * DEG) }

  // Per-point projected position. Width is field 6 (constant per track in
  // every sample we've seen — 10.64 m for VIR). Take it from the first point.
  const widthM = ml.points[0].f6 ?? 10.64
  const half = widthM / 2

  const projected = ml.points.map(p => projectLatLon(p.lat, p.lon, projection))

  const centerline = ml.points.map((p, i) => ({
    x: projected[i].x,
    y: projected[i].y,
    dist: p.dist,
    // Use the proto's heading_deg (compass-style) if present, else fall back
    // to derived tangent — but normalise everything to "radians CCW from +x".
    heading: p.f3 != null ? (90 - p.f3) * DEG : tangentRadians(projected, i),
    lat: p.lat,
    lon: p.lon,
  }))

  // Extrude ±half perpendicular to the tangent. Tangent CCW-from-+x = θ,
  // left-normal = θ + π/2, right-normal = θ − π/2.
  const leftEdge: { x: number; y: number }[] = []
  const rightEdge: { x: number; y: number }[] = []
  for (let i = 0; i < centerline.length; i++) {
    // The proto heading is for the direction of travel; the perpendicular
    // depends on whether "left" of the driver is +90° or −90°. We default
    // to driver-left = +90° (CCW from heading), which puts left-edge on the
    // inside of left-handers — matching standard motorsport convention.
    const th = tangentRadians(projected, i)
    const nx = -Math.sin(th)
    const ny = Math.cos(th)
    leftEdge.push({ x: projected[i].x + half * nx, y: projected[i].y + half * ny })
    rightEdge.push({ x: projected[i].x - half * nx, y: projected[i].y - half * ny })
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of leftEdge.concat(rightEdge)) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  // Sector boundaries — flag=1 segments are the "primary" timed sectors.
  // Emit both start and end markers; the renderer can draw them as ticks.
  const sectorMarks: TrackGeometry['sectorMarks'] = []
  for (const seg of ml.segments) {
    if (seg.flag !== 1) continue
    sectorMarks.push({ distM: seg.start_dist_m, type: 'start' })
    sectorMarks.push({ distM: seg.end_dist_m, type: 'end' })
  }

  return {
    meanLineGuid,
    trackName: ml.track_name ?? '',
    configName: ml.track_configuration_name ?? '',
    totalDistM: ml.points[ml.points.length - 1]?.dist ?? 0,
    widthM,
    projection,
    centerline,
    leftEdge,
    rightEdge,
    bbox: { minX, maxX, minY, maxY },
    sectorMarks,
  }
}
