// Local metres for the 3D replay: equirectangular around the track's centre
// (like trackGeometry.ts projectLatLon), in three.js axes: +x east, +y up,
// +z south. The terrain grid and the aerial image are linear in lat/lon over
// their GeoBox, so a point's grid or texture coordinate is linear in lat/lon.

import type { GeoBox } from '../../shared/replay'

const R_EARTH = 6_378_137
const DEG = Math.PI / 180

export interface LocalFrame {
  lat0: number
  lon0: number
  /** Metres per degree. */
  mx: number
  mz: number
  /** Elevation at y = 0 (keeps world numbers small). */
  baseM: number
}

export function makeFrame(area: GeoBox, baseM = 0): LocalFrame {
  const lat0 = (area.south + area.north) / 2, lon0 = (area.west + area.east) / 2
  return { lat0, lon0, mx: Math.cos(lat0 * DEG) * R_EARTH * DEG, mz: R_EARTH * DEG, baseM }
}

export const localX = (f: LocalFrame, lon: number) => (lon - f.lon0) * f.mx
export const localZ = (f: LocalFrame, lat: number) => -(lat - f.lat0) * f.mz
export const lonAt = (f: LocalFrame, x: number) => f.lon0 + x / f.mx
export const latAt = (f: LocalFrame, z: number) => f.lat0 - z / f.mz

/** Texture coordinates of a point in a box (v = 0 at the south edge, as three.js flips images). */
export function boxUv(area: GeoBox, lat: number, lon: number): [number, number] {
  return [(lon - area.west) / (area.east - area.west), (lat - area.south) / (area.north - area.south)]
}

/**
 * A height grid over a box, as vertices: vertex (i, j) of a W × H grid is
 * at lon = west + i·(east − west)/(W − 1), lat = north − j·(north − south)/(H − 1).
 */
export interface Raster { width: number; height: number; area: GeoBox }

/** Fractional column and row of a lat/lon in a vertex grid. */
export function rasterPos(r: Raster, lat: number, lon: number): [number, number] {
  return [
    (lon - r.area.west) / (r.area.east - r.area.west) * (r.width - 1),
    (r.area.north - lat) / (r.area.north - r.area.south) * (r.height - 1),
  ]
}

/** Bilinear height from a terrain grid; NaN outside it or next to a hole. */
export function gridHeight(grid: Float32Array, r: Raster, lat: number, lon: number): number {
  const [fx, fy] = rasterPos(r, lat, lon)
  if (fx < 0 || fy < 0 || fx > r.width - 1 || fy > r.height - 1) return NaN
  const i = Math.min(r.width - 2, Math.floor(fx)), j = Math.min(r.height - 2, Math.floor(fy)), u = fx - i, v = fy - j
  const at = (a: number, b: number) => grid[b * r.width + a]
  return at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v
}

/** Pixel position of a lat/lon in an image covering a box, pixel-is-area (centres at +0.5). */
export function imagePos(area: GeoBox, width: number, height: number, lat: number, lon: number): [number, number] {
  return [(lon - area.west) / (area.east - area.west) * width - 0.5, (area.north - lat) / (area.north - area.south) * height - 0.5]
}

/** "VIR" from "Virginia International Raceway"; short names stay as they are. */
export function shortTrackName(name: string | null | undefined): string {
  if (!name) return 'the track'
  const words = name.split(/\s+/).filter(w => /^[A-Z]/.test(w))
  return name.length > 18 && words.length >= 3 ? words.map(w => w[0]).join('') : name
}
