// Terrain for the 3D replay, shared by every driver and built once per area:
// USGS 3DEP bare-earth elevation (lidar, ~1 m) and a USDA NAIP aerial photo
// from The National Map, both public domain.
//
// An area is rounded outward to a 0.005° grid; that box is the key and the
// exact area every product covers. Products, in <root>/<key>/:
//   fine.f32     heights at ~1 m, for sampling the track surface
//   grid.f32     the renderer's mesh (at most GRID_MAX_PX on the long side)
//   grid.ctg.gz  the same grid as 16-bit steps, gzipped, for the browser
//   image.jpg    the aerial photo (at most IMAGE_MAX_PX on the long side)
//   terrain.json TerrainInfo plus the fine grid's size
//
// Placement: both height grids are vertex grids. Vertex (i, j) of a W × H
// grid is at lon = west + i·(east − west)/(W − 1), lat = north − j·(north −
// south)/(H − 1): the first and last vertices lie on the area's edges, so a
// mesh stretched edge to edge over the area puts every height where it was
// measured. The photo's pixels are areas: its outer pixel edges are the
// area's edges, the way a texture spans 0…1. Heights come from USGS
// exports requested so their pixel centres land on the fine grid's vertices,
// and are resampled through each file's own GeoTIFF placement in case the
// service moves the box.
//
// A build is single-flight per key and builds run one at a time, so a burst
// of requests never fans out at USGS. Downloaded tiles are kept until the
// build succeeds, so a retry fetches only what is missing. A failure is
// reported until RETRY_AFTER, then the next request tries again.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readFloatTiff } from './geoTiff.js'
import type { GeoBox, TerrainInfo } from '../shared/replay.js'

export const TERRAIN_STEP_DEG = 0.005
const STEPS_PER_DEG = 200
// Larger areas would make the downloads and the fine grid unreasonably big.
export const MAX_TERRAIN_SPAN_DEG = 0.1
const FINE_M = 1
// About 64 MB of fine heights at most; larger areas get a coarser fine grid.
const MAX_FINE_PX = 16_000_000
export const GRID_MAX_PX = 1400
export const IMAGE_MAX_PX = 4096
// USGS answers in ~15 s whatever the size, but larger exports time out at
// its gateway (90 s); tiles stay well under that.
const DEM_TILE_PX = 1500
const FETCH_CONCURRENCY = 2
const REQUEST_TIMEOUT_MS = 120_000
export const MAX_SAMPLE_POINTS = 250_000
const VERSION = 1
const KEY_PREFIX = 't1'
const M_PER_DEG = 111_320

export const DEFAULT_ELEVATION_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer'
export const DEFAULT_IMAGERY_URL = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer'
const ATTRIBUTION_DEM = 'Elevation: USGS 3D Elevation Program (3DEP)'
const ATTRIBUTION_IMAGE = 'Imagery: USDA NAIP via USGS The National Map'

export interface TerrainOptions {
  elevationUrl?: string
  imageryUrl?: string
  /** First retry delay; later ones are 3× and 10× it, and a failed build is retried after 20×. */
  retryMs?: number
  log?: (message: string) => void
}

export type TerrainStatus =
  | { state: 'ready'; terrain: TerrainInfo }
  | { state: 'building' }
  | { state: 'failed'; error: string }

interface Stored { version: number; info: TerrainInfo; fine: { width: number; height: number } }

// ─── Keys ───────────────────────────────────────────────────────────────────

const KEY_RE = /^t1_([pm]\d{1,3}\.\d{3})_([pm]\d{1,3}\.\d{3})_([pm]\d{1,3}\.\d{3})_([pm]\d{1,3}\.\d{3})$/

const fmt = (steps: number) => `${steps < 0 ? 'm' : 'p'}${(Math.abs(steps) / STEPS_PER_DEG).toFixed(3)}`
const unfmt = (s: string) => (s[0] === 'm' ? -1 : 1) * Math.round(Number(s.slice(1)) * STEPS_PER_DEG)

function boxOfSteps(s: number, w: number, n: number, e: number): GeoBox {
  return { south: s / STEPS_PER_DEG, west: w / STEPS_PER_DEG, north: n / STEPS_PER_DEG, east: e / STEPS_PER_DEG }
}

/** Checks a GeoBox from a request. */
export function validGeoBox(value: unknown): GeoBox {
  const b = value as GeoBox
  const ok = !!b && typeof b === 'object' && [b.south, b.west, b.north, b.east].every(v => typeof v === 'number' && Number.isFinite(v))
    && b.south >= -90 && b.north <= 90 && b.west >= -180 && b.east <= 180 && b.south < b.north && b.west < b.east
  if (!ok) throw new Error('Invalid terrain area')
  return { south: b.south, west: b.west, north: b.north, east: b.east }
}

/** The area rounded outward to the 0.005° grid, and its key ("t1_p36.545_m79.220_p36.575_m79.195": S, W, N, E). */
export function terrainKey(area: GeoBox): { key: string; area: GeoBox } {
  const box = validGeoBox(area)
  // A hair of tolerance so an edge already on the grid stays put.
  const s = Math.floor(box.south * STEPS_PER_DEG + 1e-6), w = Math.floor(box.west * STEPS_PER_DEG + 1e-6)
  const n = Math.ceil(box.north * STEPS_PER_DEG - 1e-6), e = Math.ceil(box.east * STEPS_PER_DEG - 1e-6)
  if ((n - s) / STEPS_PER_DEG > MAX_TERRAIN_SPAN_DEG + 1e-9 || (e - w) / STEPS_PER_DEG > MAX_TERRAIN_SPAN_DEG + 1e-9) {
    throw new Error(`That area is too large for terrain (at most ${MAX_TERRAIN_SPAN_DEG}° on a side).`)
  }
  return { key: `${KEY_PREFIX}_${fmt(s)}_${fmt(w)}_${fmt(n)}_${fmt(e)}`, area: boxOfSteps(s, w, n, e) }
}

/** The area a key stands for, or null when it is not a terrain key. */
export function areaOfKey(key: unknown): GeoBox | null {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null
  if (!m) return null
  const [s, w, n, e] = m.slice(1).map(unfmt)
  return s < n && w < e ? boxOfSteps(s, w, n, e) : null
}

// ─── Grids ──────────────────────────────────────────────────────────────────

/** Bilinear height at fractional vertex (fx, fy) of a W × H grid; NaN outside. */
function bilinear(data: Float32Array, width: number, height: number, fx: number, fy: number): number {
  const eps = 1e-6
  if (!(fx >= -eps && fy >= -eps && fx <= width - 1 + eps && fy <= height - 1 + eps)) return NaN
  fx = Math.min(width - 1, Math.max(0, fx)); fy = Math.min(height - 1, Math.max(0, fy))
  const x0 = Math.min(width - 2, Math.floor(fx)), y0 = Math.min(height - 2, Math.floor(fy))
  if (width < 2 || height < 2) return data[0]
  const tx = fx - x0, ty = fy - y0
  const i = y0 * width + x0
  const a = data[i], b = data[i + 1], c = data[i + width], d = data[i + width + 1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

// Holes (no data) take the mean of their known neighbours, layer by layer
// from the edges of each hole inwards.
function fillHoles(data: Float32Array, width: number, height: number): void {
  let missing: number[] = []
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) missing.push(i)
  if (!missing.length) return
  if (missing.length === data.length) throw new Error('USGS has no elevation data for this area.')
  while (missing.length) {
    const next: number[] = [], fills: Array<[number, number]> = []
    for (const i of missing) {
      const x = i % width, y = (i - x) / width
      let sum = 0, n = 0
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j >= 0 && Number.isFinite(data[j])) { sum += data[j]; n++ }
      }
      if (n) fills.push([i, sum / n])
      else next.push(i)
    }
    for (const [i, v] of fills) data[i] = v
    missing = next
  }
}

/** 'CTG1', width, height (u32), min, max (f32), then one u16 step per vertex (65535 = no data). */
export function encodeGrid(data: Float32Array, width: number, height: number): Buffer {
  let min = Infinity, max = -Infinity
  for (const v of data) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v }
  if (!Number.isFinite(min)) { min = 0; max = 0 }
  const out = Buffer.alloc(20 + data.length * 2)
  out.write('CTG1', 0, 'latin1')
  out.writeUInt32LE(width, 4); out.writeUInt32LE(height, 8)
  out.writeFloatLE(min, 12); out.writeFloatLE(max, 16)
  const fmin = out.readFloatLE(12), scale = (out.readFloatLE(16) - fmin) / 65534
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    out.writeUInt16LE(!Number.isFinite(v) ? 65535 : scale > 0 ? Math.min(65534, Math.max(0, Math.round((v - fmin) / scale))) : 0, 20 + i * 2)
  }
  return out
}

/** The inverse of encodeGrid (the renderer has its own copy in api.ts). */
export function decodeGrid(bytes: Uint8Array): { width: number; height: number; data: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'CTG1') throw new Error('Not a terrain grid')
  const width = view.getUint32(4, true), height = view.getUint32(8, true)
  const min = view.getFloat32(12, true), scale = (view.getFloat32(16, true) - min) / 65534
  const data = new Float32Array(width * height)
  for (let i = 0; i < data.length; i++) {
    const q = view.getUint16(20 + i * 2, true)
    data[i] = q === 65535 ? NaN : min + q * scale
  }
  return { width, height, data }
}

/** A JPEG's pixel size from its frame header, or null. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    if (marker === 0xff) { at++; continue }
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] }
    }
    at += 2 + length
  }
  return null
}

// ─── Downloads ──────────────────────────────────────────────────────────────

class PermanentError extends Error {}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const coord = (v: number) => Number(v.toFixed(9)).toString()
const bboxParam = (b: GeoBox) => [b.west, b.south, b.east, b.north].map(coord).join(',')

async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.promises.writeFile(tmp, data)
  await fs.promises.rename(tmp, file)
}

// ─── Service ────────────────────────────────────────────────────────────────

export class TerrainService {
  private readonly elevationUrl: string
  private readonly imageryUrl: string
  private readonly retryMs: number
  private readonly log: (message: string) => void
  private readonly stored = new Map<string, Stored>()
  private readonly builds = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, { error: string; at: number }>()
  private readonly limits = new Map<string, { width: number; height: number }>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly stop = new AbortController()
  // The fine grids sampled most recently.
  private readonly fineCache = new Map<string, Promise<Float32Array>>()

  constructor(readonly root: string, options: TerrainOptions = {}) {
    this.elevationUrl = (options.elevationUrl ?? process.env.CATALYST_USGS_ELEVATION_URL ?? DEFAULT_ELEVATION_URL).replace(/\/+$/, '')
    this.imageryUrl = (options.imageryUrl ?? process.env.CATALYST_USGS_IMAGERY_URL ?? DEFAULT_IMAGERY_URL).replace(/\/+$/, '')
    const envRetry = Number(process.env.CATALYST_TERRAIN_RETRY_MS)
    this.retryMs = options.retryMs ?? (Number.isFinite(envRetry) && envRetry >= 0 ? envRetry : 3000)
    this.log = options.log ?? (message => console.log(message))
  }

  /** Stops downloading (the server is shutting down) and waits for the build in progress. */
  async close(): Promise<void> {
    this.stop.abort()
    await this.queue
  }

  /** Ready, building (started now if needed), or failed recently. */
  status(value: unknown): TerrainStatus {
    const { key, area } = terrainKey(validGeoBox(value))
    const stored = this.read(key)
    if (stored) return { state: 'ready', terrain: stored.info }
    if (this.builds.has(key)) return { state: 'building' }
    const failure = this.failures.get(key)
    if (failure && Date.now() - failure.at < this.retryMs * 20) return { state: 'failed', error: failure.error }
    this.failures.delete(key)
    const build = this.queue.then(() => this.build(key, area))
    this.queue = build.catch(() => {})
    this.builds.set(key, build)
    build.then(
      () => { this.builds.delete(key) },
      error => {
        this.builds.delete(key)
        const message = error instanceof Error ? error.message : String(error)
        this.failures.set(key, { error: message, at: Date.now() })
        this.log(`[terrain] ${key} failed: ${message}`)
      },
    )
    return { state: 'building' }
  }

  /** Waits for the area's terrain (building it if needed). */
  async ready(area: unknown): Promise<TerrainInfo> {
    for (;;) {
      const status = this.status(area)
      if (status.state === 'ready') return status.terrain
      if (status.state === 'failed') throw new Error(status.error)
      await this.builds.get(terrainKey(validGeoBox(area)).key)?.catch(() => {})
    }
  }

  /** The built terrain for a key, or null. */
  info(key: string): TerrainInfo | null {
    return this.read(key)?.info ?? null
  }

  /** The mesh heights, metres (row-major, north row first). */
  async grid(key: string): Promise<Float32Array> {
    const stored = this.read(key)
    if (!stored) throw new Error('That terrain has not been built.')
    return floats(await fs.promises.readFile(path.join(this.root, key, 'grid.f32')))
  }

  /** The mesh heights as encodeGrid bytes, gzipped. */
  gridFile(key: string): string | null {
    return this.read(key) ? path.join(this.root, key, 'grid.ctg.gz') : null
  }

  imageFile(key: string): string | null {
    return this.read(key)?.info.imagery ? path.join(this.root, key, 'image.jpg') : null
  }

  /** Heights from the fine grid at [lat, lon, lat, lon…]; NaN outside the area. */
  async sample(key: string, latLon: Float64Array): Promise<Float32Array> {
    const stored = this.read(key)
    if (!stored) throw new Error('That terrain has not been built.')
    if (latLon.length % 2) throw new Error('Terrain samples come as latitude and longitude pairs.')
    let pending = this.fineCache.get(key)
    if (!pending) {
      pending = fs.promises.readFile(path.join(this.root, key, 'fine.f32')).then(floats)
      pending.catch(() => this.fineCache.delete(key))
      this.fineCache.set(key, pending)
      // Keep the two most recent (each is tens of MB).
      while (this.fineCache.size > 2) this.fineCache.delete(this.fineCache.keys().next().value!)
    }
    const fine = await pending
    const { width, height } = stored.fine
    const { south, west, north, east } = stored.info.area
    const out = new Float32Array(latLon.length / 2)
    for (let k = 0; k < out.length; k++) {
      const lat = latLon[2 * k], lon = latLon[2 * k + 1]
      out[k] = bilinear(fine, width, height, (lon - west) / (east - west) * (width - 1), (north - lat) / (north - south) * (height - 1))
    }
    return out
  }

  private read(key: string): Stored | null {
    if (!areaOfKey(key)) return null
    const cached = this.stored.get(key)
    if (cached) return cached
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(this.root, key, 'terrain.json'), 'utf8')) as Stored
      if (stored.version !== VERSION) return null
      this.stored.set(key, stored)
      return stored
    } catch { return null }
  }

  // ─── Building ─────────────────────────────────────────────────────────────

  private async build(key: string, area: GeoBox): Promise<void> {
    if (this.read(key)) return
    if (this.stop.signal.aborted) throw new Error('The server is shutting down.')
    const started = Date.now()
    this.log(`[terrain] building ${key}`)
    const partial = path.join(this.root, '.partial', key)
    await fs.promises.mkdir(partial, { recursive: true })

    // Fine vertex grid: p degrees apart, ~1 m north–south, a whole number of
    // steps per 0.005° cell so both edges are vertices.
    const cellsX = Math.round((area.east - area.west) * STEPS_PER_DEG), cellsY = Math.round((area.north - area.south) * STEPS_PER_DEG)
    let k = Math.ceil(TERRAIN_STEP_DEG * M_PER_DEG / FINE_M)
    while (k > 1 && (cellsX * k + 1) * (cellsY * k + 1) > MAX_FINE_PX) k--
    const p = TERRAIN_STEP_DEG / k
    const fw = cellsX * k + 1, fh = cellsY * k + 1
    const fine = new Float32Array(fw * fh).fill(NaN)

    const limit = await this.serviceLimit(this.elevationUrl)
    const tile = Math.max(64, Math.min(DEM_TILE_PX, limit.width, limit.height))
    const across = Math.ceil(fw / tile), down = Math.ceil(fh / tile)
    const tw = Math.ceil(fw / across), th = Math.ceil(fh / down)
    const tiles: Array<{ i0: number; i1: number; j0: number; j1: number }> = []
    for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
      tiles.push({ i0: tx * tw, i1: Math.min(fw, (tx + 1) * tw), j0: ty * th, j1: Math.min(fh, (ty + 1) * th) })
    }
    let next = 0, bytes = 0
    let failure: unknown = null
    const worker = async () => {
      // After a failure no new tile is started: the build is retried later.
      while (failure == null && next < tiles.length) {
        const t = tiles[next++]
        // Pixel centres on the vertices: the box reaches half a pixel past them.
        const box: GeoBox = {
          west: area.west + (t.i0 - 0.5) * p, east: area.west + (t.i1 - 0.5) * p,
          north: area.north - (t.j0 - 0.5) * p, south: area.north - (t.j1 - 0.5) * p,
        }
        const file = path.join(partial, `dem-${k}-${t.i0}-${t.j0}-${t.i1 - t.i0}x${t.j1 - t.j0}.tif`)
        try {
          let data: Buffer
          if (fs.existsSync(file)) data = await fs.promises.readFile(file)
          else {
            const url = `${this.elevationUrl}/exportImage?bbox=${bboxParam(box)}&bboxSR=4326&imageSR=4326&size=${t.i1 - t.i0},${t.j1 - t.j0}`
              + '&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image'
            data = await this.download(url, 'Elevation', body => body.length > 8 && ((body[0] === 0x49 && body[1] === 0x49) || (body[0] === 0x4d && body[1] === 0x4d)))
            await writeAtomic(file, data)
          }
          bytes += data.length
          placeTile(fine, fw, area, p, t, box, data)
        } catch (error) {
          failure ??= error
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, tiles.length) }, worker))
    if (failure != null) throw failure
    fillHoles(fine, fw, fh)

    // The mesh: about square cells in metres, at most GRID_MAX_PX a side.
    const midLat = (area.north + area.south) / 2
    const spanX = (area.east - area.west) * M_PER_DEG * Math.cos(midLat * Math.PI / 180)
    const spanY = (area.north - area.south) * M_PER_DEG
    const spacing = Math.max(spanX, spanY) / (GRID_MAX_PX - 1)
    const gw = Math.min(GRID_MAX_PX, Math.max(2, Math.round(spanX / spacing) + 1))
    const gh = Math.min(GRID_MAX_PX, Math.max(2, Math.round(spanY / spacing) + 1))
    const grid = new Float32Array(gw * gh)
    let minM = Infinity, maxM = -Infinity
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const v = bilinear(fine, fw, fh, i / (gw - 1) * (fw - 1), j / (gh - 1) * (fh - 1))
      grid[j * gw + i] = v
      if (v < minM) minM = v
      if (v > maxM) maxM = v
    }

    const imagery = await this.fetchImagery(area, partial)
    const info: TerrainInfo = {
      key, area,
      grid: { width: gw, height: gh, minM: Math.round(minM * 100) / 100, maxM: Math.round(maxM * 100) / 100 },
      imagery: imagery ? { width: imagery.width, height: imagery.height } : null,
      attribution: imagery ? `${ATTRIBUTION_DEM}. ${ATTRIBUTION_IMAGE}. Public domain.` : `${ATTRIBUTION_DEM}. Public domain.`,
    }
    const stored: Stored = { version: VERSION, info, fine: { width: fw, height: fh } }

    // Everything lands in a temporary folder, renamed into place in one step.
    const tmp = path.join(this.root, `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    await fs.promises.mkdir(tmp, { recursive: true })
    try {
      await fs.promises.writeFile(path.join(tmp, 'fine.f32'), Buffer.from(fine.buffer, fine.byteOffset, fine.byteLength))
      await fs.promises.writeFile(path.join(tmp, 'grid.f32'), Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength))
      await fs.promises.writeFile(path.join(tmp, 'grid.ctg.gz'), gzipSync(encodeGrid(grid, gw, gh)))
      if (imagery) await fs.promises.writeFile(path.join(tmp, 'image.jpg'), imagery.bytes)
      await fs.promises.writeFile(path.join(tmp, 'terrain.json'), JSON.stringify(stored, null, 2))
      const target = path.join(this.root, key)
      await fs.promises.rm(target, { recursive: true, force: true })
      await fs.promises.rename(tmp, target)
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true })
    }
    await fs.promises.rm(partial, { recursive: true, force: true })
    this.stored.set(key, stored)
    this.log(`[terrain] built ${key} in ${((Date.now() - started) / 1000).toFixed(1)} s: heights ${fw}×${fh} (${tiles.length} tiles, ${(bytes / 1e6).toFixed(1)} MB), mesh ${gw}×${gh}, ${imagery ? `photo ${imagery.width}×${imagery.height} (${(imagery.bytes.length / 1e6).toFixed(1)} MB)` : 'no photo'}`)
  }

  // The photo in one request (stitching JPEGs would need a decoder): as
  // large as the service allows, up to IMAGE_MAX_PX, in exactly the area's
  // proportions so the service keeps the box as asked. Null when the service
  // has no photo here; a failure it may recover from fails the build.
  private async fetchImagery(area: GeoBox, partial: string): Promise<{ width: number; height: number; bytes: Buffer } | null> {
    const cellsX = Math.round((area.east - area.west) * STEPS_PER_DEG), cellsY = Math.round((area.north - area.south) * STEPS_PER_DEG)
    const limit = await this.serviceLimit(this.imageryUrl)
    const per = Math.max(1, Math.floor(Math.min(IMAGE_MAX_PX, limit.width, limit.height) / Math.max(cellsX, cellsY)))
    const width = cellsX * per, height = cellsY * per
    const file = path.join(partial, `image-${width}x${height}.jpg`)
    if (fs.existsSync(file)) return { width, height, bytes: await fs.promises.readFile(file) }
    const url = `${this.imageryUrl}/exportImage?bbox=${bboxParam(area)}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=jpg&f=image`
    let bytes: Buffer
    try {
      bytes = await this.download(url, 'Aerial imagery', body => body[0] === 0xff && body[1] === 0xd8)
    } catch (error) {
      if (error instanceof PermanentError) { this.log(`[terrain] no aerial imagery: ${error.message}`); return null }
      throw error
    }
    const size = jpegSize(bytes)
    if (!size || size.width !== width || size.height !== height) {
      this.log(`[terrain] aerial imagery came back ${size ? `${size.width}×${size.height}` : 'unreadable'}, not ${width}×${height}; leaving it out`)
      return null
    }
    await writeAtomic(file, bytes)
    return { width, height, bytes }
  }

  // maxImageWidth / maxImageHeight from the service; USGS's info pages are
  // often slow, so a failure falls back to 4000 (both services' value).
  private async serviceLimit(base: string): Promise<{ width: number; height: number }> {
    const known = this.limits.get(base)
    if (known) return known
    try {
      const response = await fetch(`${base}?f=pjson`, { signal: AbortSignal.any([AbortSignal.timeout(20_000), this.stop.signal]) })
      const body = await response.json() as { maxImageWidth?: number; maxImageHeight?: number }
      if (response.ok && Number(body.maxImageWidth) > 0 && Number(body.maxImageHeight) > 0) {
        const limit = { width: Number(body.maxImageWidth), height: Number(body.maxImageHeight) }
        this.limits.set(base, limit)
        return limit
      }
    } catch { /* the default below */ }
    return { width: 4000, height: 4000 }
  }

  // GET with retries for what USGS may recover from (5xx, 429, timeouts,
  // an error page instead of the image). Other answers are final.
  private async download(url: string, what: string, isImage: (body: Buffer) => boolean): Promise<Buffer> {
    const delays = [1, 3, 10].map(n => n * this.retryMs)
    let last = ''
    for (let attempt = 0; ; attempt++) {
      if (this.stop.signal.aborted) throw new Error('The server is shutting down.')
      try {
        const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.stop.signal]) })
        const body = Buffer.from(await response.arrayBuffer())
        if (response.ok && isImage(body)) return body
        if (response.ok) last = `${what}: USGS sent ${response.headers.get('content-type') ?? 'something'} instead of an image (${body.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')})`
        else if (response.status >= 500 || response.status === 429) last = `${what}: USGS answered ${response.status}`
        else throw new PermanentError(`${what}: USGS answered ${response.status}`)
      } catch (error) {
        if (error instanceof PermanentError) throw error
        last = `${what}: ${error instanceof Error ? (error.name === 'TimeoutError' ? 'USGS did not answer in time' : error.message) : String(error)}`
      }
      if (attempt >= delays.length || this.stop.signal.aborted) break
      await sleep(delays[attempt])
    }
    // Only error pages, never a server failure: the service has nothing here.
    if (last.includes('instead of an image')) throw new PermanentError(last)
    throw new Error(`${last} (tried ${delays.length + 1} times; try again later)`)
  }
}

// Reads a little-endian float32 file (any alignment).
function floats(buffer: Buffer): Float32Array {
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return new Float32Array(copy.buffer, 0, buffer.byteLength >> 2)
}

// Copies one exported tile onto the fine grid's vertices it covers, through
// the tile's own placement (a USGS export may not match the box asked for).
function placeTile(
  fine: Float32Array, fw: number, area: GeoBox, p: number,
  t: { i0: number; i1: number; j0: number; j1: number }, asked: GeoBox, bytes: Buffer,
): void {
  const raster = readFloatTiff(bytes)
  const geo = raster.georef ?? {
    x0: asked.west, y0: asked.north, pixelIsArea: true,
    sx: (asked.east - asked.west) / raster.width, sy: (asked.north - asked.south) / raster.height,
  }
  const shift = geo.pixelIsArea ? 0.5 : 0
  // USGS marks missing ground with huge negative values or a no-data value.
  const data = raster.data
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (!Number.isFinite(v) || v < -1000 || v > 10000 || (raster.noData != null && v === raster.noData)) data[i] = NaN
  }
  for (let j = t.j0; j < t.j1; j++) {
    const fy = (geo.y0 - (area.north - j * p)) / geo.sy - shift
    for (let i = t.i0; i < t.i1; i++) {
      const fx = (area.west + i * p - geo.x0) / geo.sx - shift
      let v = bilinear(data, raster.width, raster.height, fx, fy)
      // Next to a hole, the nearest pixel.
      if (Number.isNaN(v)) {
        const x = Math.round(fx), y = Math.round(fy)
        if (x >= 0 && y >= 0 && x < raster.width && y < raster.height) v = data[y * raster.width + x]
      }
      fine[j * fw + i] = v
    }
  }
}

/** Unzips a stored grid for a client that does not accept gzip. */
export function gunzipGrid(file: string): Buffer {
  return gunzipSync(fs.readFileSync(file))
}
