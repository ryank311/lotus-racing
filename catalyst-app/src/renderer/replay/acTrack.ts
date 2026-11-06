// A user-supplied 3D track (e.g. a converted Assetto Corsa track) in the
// replay: its .glb files placed on the earth by the model's georef, a fast
// height query over its drivable surfaces, and optionally the public lidar
// terrain and aerial photo as the far field around it.
//
// Placement: the georef maps glTF coordinates into an equirectangular frame
// around its own origin (x east, y metres above sea level, z south); the
// replay's frame (geo.ts) is the same projection around another origin, so
// the two differ by a translation and a ~1e-4 stretch in x, folded into one
// matrix on the track's group.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { TerrainInfo, TrackModel, TrackModelFootprint, TrackModelGeoref, TrackModelLayout } from '../../shared/replay'
import type { LocalFrame } from './geo'
import { patchWorldMaterial, type SurfaceKind } from './surfaces'
import { patchCutoutMaterial } from './foliage'
import { fittedTextures, replayProfile } from './budget'
import { parseGltf } from './ktx2'

const R_EARTH = 6_378_137
const DEG = Math.PI / 180

// ─── Placement ──────────────────────────────────────────────────────────────

/** glTF coordinates → the replay's local metres (y relative to frame.baseM). */
export function georefMatrix(georef: TrackModelGeoref, frame: LocalFrame): THREE.Matrix4 {
  const mxModel = Math.cos(georef.originLat * DEG) * R_EARTH * DEG
  const k = frame.mx / mxModel
  const toFrame = new THREE.Matrix4().set(
    k, 0, 0, (georef.originLon - frame.lon0) * frame.mx,
    0, 1, 0, -frame.baseM,
    0, 0, 1, -(georef.originLat - frame.lat0) * frame.mz,
    0, 0, 0, 1,
  )
  const s = georef.scale
  const model = new THREE.Matrix4().compose(
    new THREE.Vector3(...georef.offsetM),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), georef.rotationDeg * DEG),
    new THREE.Vector3(georef.flips?.x ? -s : s, s, georef.flips?.z ? -s : s),
  )
  return toFrame.multiply(model)
}

// ─── Height query ───────────────────────────────────────────────────────────

export interface SurfaceHit {
  /** Height (local y). */
  h: number
  /** Unit normal of the triangle hit. */
  nx: number; ny: number; nz: number
  /** A drivable surface (road, kerb, pit) rather than ground (grass, earth). */
  drivable: boolean
}

/**
 * Triangles of the drivable and ground meshes in local metres, bucketed in a
 * 2D grid (x–z) so a height query looks at a handful of triangles.
 */
export class AcSurface {
  private readonly tris: Float32Array
  private readonly drivable: Uint8Array
  private readonly start: Int32Array
  private readonly items: Int32Array
  private readonly x0: number
  private readonly z0: number
  private readonly nx: number
  private readonly nz: number
  readonly triangleCount: number
  readonly bounds: THREE.Box3

  constructor(tris: Float32Array, drivable: Uint8Array, readonly cell = 4) {
    this.tris = tris; this.drivable = drivable
    const n = drivable.length
    this.triangleCount = n
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < n * 9; i += 3) {
      minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i])
      minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1])
      minZ = Math.min(minZ, tris[i + 2]); maxZ = Math.max(maxZ, tris[i + 2])
    }
    if (!n) { minX = minZ = minY = 0; maxX = maxZ = maxY = 0 }
    this.bounds = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ))
    this.x0 = Math.floor(minX / cell) * cell; this.z0 = Math.floor(minZ / cell) * cell
    this.nx = Math.max(1, Math.ceil((maxX - this.x0) / cell) + 1); this.nz = Math.max(1, Math.ceil((maxZ - this.z0) / cell) + 1)
    // Two passes: count per cell, then fill (CSR).
    const counts = new Int32Array(this.nx * this.nz + 1)
    const span = (t: number, visit: (c: number) => void) => {
      const o = t * 9
      const i0 = Math.floor((Math.min(tris[o], tris[o + 3], tris[o + 6]) - this.x0) / cell), i1 = Math.floor((Math.max(tris[o], tris[o + 3], tris[o + 6]) - this.x0) / cell)
      const j0 = Math.floor((Math.min(tris[o + 2], tris[o + 5], tris[o + 8]) - this.z0) / cell), j1 = Math.floor((Math.max(tris[o + 2], tris[o + 5], tris[o + 8]) - this.z0) / cell)
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 10_000) return // a degenerate sliver spanning the map
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) visit(j * this.nx + i)
    }
    for (let t = 0; t < n; t++) span(t, c => { counts[c + 1]++ })
    for (let c = 0; c < this.nx * this.nz; c++) counts[c + 1] += counts[c]
    this.start = counts
    this.items = new Int32Array(counts[this.nx * this.nz])
    const fill = counts.slice(0, this.nx * this.nz)
    for (let t = 0; t < n; t++) span(t, c => { this.items[fill[c]++] = t })
  }

  /** Every surface under (x, z), calling `visit(h, triangle)`. */
  private eachHit(x: number, z: number, visit: (h: number, t: number) => void) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return
    const c = j * this.nx + i, tris = this.tris
    for (let k = this.start[c]; k < this.start[c + 1]; k++) {
      const t = this.items[k], o = t * 9
      const ax = tris[o], az = tris[o + 2], bx = tris[o + 3], bz = tris[o + 5], cx = tris[o + 6], cz = tris[o + 8]
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(d) < 1e-12) continue
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
      const l3 = 1 - l1 - l2
      if (l1 < -1e-5 || l2 < -1e-5 || l3 < -1e-5) continue
      visit(l1 * tris[o + 1] + l2 * tris[o + 4] + l3 * tris[o + 7], t)
    }
  }

  /**
   * The surface a car at about `refY` sits on: the highest surface from 2.5 m
   * below to 1.5 m above it (a kerb over the grass under it, the lower road
   * under a bridge), else the one nearest `refY`; without `refY`, the highest
   * drivable surface, else the highest ground. False when nothing is there.
   */
  sample(x: number, z: number, refY: number | null, out: SurfaceHit): boolean {
    let best = -1, bestH = 0, bestScore = -Infinity
    this.eachHit(x, z, (h, t) => {
      let score: number
      if (refY == null) score = h + (this.drivable[t] ? 1e4 : 0)
      else if (h >= refY - 2.5 && h <= refY + 1.5) score = 1e4 + h
      else score = -Math.abs(h - refY)
      if (score > bestScore) { bestScore = score; best = t; bestH = h }
    })
    if (best < 0) return false
    const o = best * 9, tris = this.tris
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2]
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
    const len = Math.hypot(nx, ny, nz) || 1
    out.h = bestH; out.nx = nx / len; out.ny = ny / len; out.nz = nz / len; out.drivable = !!this.drivable[best]
    return true
  }

  /** Height at (x, z) near `refY`, or NaN. */
  heightAt(x: number, z: number, refY: number | null = null): number {
    return this.sample(x, z, refY, SCRATCH_HIT) ? SCRATCH_HIT.h : NaN
  }

  /** From the drivable/ground meshes under `root` (world matrices must be current). */
  static fromObject(root: THREE.Object3D, drivablePattern: RegExp | null = null, cell = 4): AcSurface {
    const chunks: Float32Array[] = [], flags: Uint8Array[] = []
    const v = new THREE.Vector3()
    root.updateMatrixWorld(true)
    root.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const drivable = mesh.userData?.drivable === true || !!drivablePattern?.test(mesh.name)
      const ground = mesh.userData?.ground === true
      if (!drivable && !ground) return
      const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
      if (!position) return
      const index = mesh.geometry.getIndex()
      const count = index ? index.count : position.count
      const out = new Float32Array((count / 3 | 0) * 9)
      for (let i = 0; i < out.length / 3; i++) {
        v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld)
        out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z
      }
      chunks.push(out)
      flags.push(new Uint8Array(out.length / 9).fill(drivable ? 1 : 0))
    })
    const total = chunks.reduce((a, c) => a + c.length, 0)
    const tris = new Float32Array(total), drivable = new Uint8Array(total / 9)
    let o = 0, f = 0
    for (let i = 0; i < chunks.length; i++) { tris.set(chunks[i], o); drivable.set(flags[i], f); o += chunks[i].length; f += flags[i].length }
    return new AcSurface(tris, drivable, cell)
  }
}
const SCRATCH_HIT: SurfaceHit = { h: 0, nx: 0, ny: 1, nz: 0, drivable: false }

// ─── Loading ────────────────────────────────────────────────────────────────

export interface AcTrack {
  group: THREE.Group
  surface: AcSurface
  model: TrackModel
  /** glTF → local metres. */
  matrix: THREE.Matrix4
  /** Ground coverage, for the far field; null without a footprint. */
  footprint: Footprint | null
  triangles: number
  /** Re-place after the frame's base height changes. */
  place: (frame: LocalFrame) => void
  dispose: () => void
}

export interface AcTrackOptions {
  model: TrackModel
  layout: TrackModelLayout
  frame: LocalFrame
  getFile: (id: string, file: string) => Promise<ArrayBuffer>
  maxAnisotropy?: number
  onStep?: (label: string) => void
}

/** Loads a layout's files, converts their materials to the world's look and places them. */
export async function loadAcTrack(options: AcTrackOptions): Promise<AcTrack> {
  const { model, layout, frame, getFile, maxAnisotropy = 8, onStep } = options
  const group = new THREE.Group()
  group.name = `track-model:${model.id}`
  group.matrixAutoUpdate = false
  const loader = new GLTFLoader()
  // On a constrained device the images decode at most this size, a few at a time (budget.ts);
  // KTX2 textures are capped the same, by their mip levels (ktx2.ts).
  const { textureMax, decodeConcurrency } = replayProfile()
  if (Number.isFinite(textureMax.track)) loader.register(parser => fittedTextures(parser, textureMax.track, decodeConcurrency))
  const textures = new Set<THREE.Texture>()
  // One world material per glTF material (they are shared between meshes).
  const converted = new Map<THREE.Material, THREE.Material>()
  let triangles = 0
  // Fetch every file at once; parse in order.
  const buffers = layout.files.map(file => getFile(model.id, file))
  const fpBuffer = model.footprint ? getFile(model.id, model.footprint.file).catch(() => null) : Promise.resolve(null)
  try {
    for (const [i, file] of layout.files.entries()) {
      onStep?.(`Loading the track model (${i + 1}/${layout.files.length})`)
      const gltf = await parseGltf(loader, await buffers[i], textureMax.track)
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => worldMaterial(m, maxAnisotropy, textures, converted)) : worldMaterial(mesh.material, maxAnisotropy, textures, converted)
        const index = mesh.geometry.getIndex()
        triangles += (index ? index.count : mesh.geometry.getAttribute('position').count) / 3
        const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material
        // Blended overlays (racing groove, skid marks) draw after the opaque world.
        if (material.transparent) mesh.renderOrder = 1
        // Everything takes the sun's shadow; solid things above the ground cast it.
        const kind = material.userData.surfaceKind as SurfaceKind
        mesh.receiveShadow = true
        mesh.castShadow = (kind === 'object' || kind === 'foliage') && !material.transparent && !mesh.userData?.drivable && !mesh.userData?.ground
      })
      gltf.scene.name = file
      group.add(gltf.scene)
    }
  } catch (error) {
    disposeTree(group, textures)
    throw error
  }
  const matrix = georefMatrix(model.georef, frame)
  group.matrix.copy(matrix)
  group.updateMatrixWorld(true)
  onStep?.('Indexing the track surface')
  const pattern = model.drivablePattern ? safeRegExp(model.drivablePattern) : null
  let surface = AcSurface.fromObject(group, pattern)
  let footprint: Footprint | null = null
  const fp = await fpBuffer
  if (fp && model.footprint) {
    try { footprint = await Footprint.fromPng(fp, model.footprint) } catch (error) { console.warn('[replay] track footprint unusable', error) }
  }
  const track: AcTrack = {
    group, surface, model, matrix, footprint, triangles,
    place(next: LocalFrame) {
      const m = georefMatrix(model.georef, next)
      track.matrix.copy(m)
      group.matrix.copy(m)
      group.updateMatrixWorld(true)
      surface = track.surface = AcSurface.fromObject(group, pattern)
    },
    dispose: () => disposeTree(group, textures),
  }
  return track
}

function safeRegExp(source: string): RegExp | null {
  try { return new RegExp(source, 'i') } catch { return null }
}

// What each of the track's materials is, by its Assetto Corsa name and shader.
// Tarmac (ASPHALT-GREEN is the green-painted run-off: tarmac under paint).
const ROAD_RE = /^(ROAD|ASPHALT|SKIDPAN|PADDOCK MAIN)/i
const KERB_RE = /^(KERB|FIA Kurb|23 - Default)/i
// Lines, decals and plain concrete keep their own texture.
const PAINT_RE = /^(WHITE-LINE|PIT MARKINGS|GROOVE|SKIDMARK|PADDOCK DECALS|CONCRETE BEIGE|CONCRETE-LIGHT)/i
// Turf: the aerial photo (TERRAIN) and the verge strip along every road edge
// (EDGING1). EARTH (bare dirt) and walls are 'object': their own colour.
const GROUND_RE = /^(TERRAIN|EDGING1)$/i

export function surfaceKindOf(material: THREE.Material): SurfaceKind {
  const name = material.name, shader = String(material.userData?.acShader ?? '')
  if (shader === 'ksTree') return 'foliage'
  if (/^WATER$/i.test(name)) return 'water'
  if (GROUND_RE.test(name)) return 'ground'
  if (KERB_RE.test(name)) return 'kerb'
  if (PAINT_RE.test(name)) return 'paint'
  if (ROAD_RE.test(name)) return 'road'
  return 'object'
}

const GROUND_ALBEDO_SCALE = 0.62
const GREEN_PAINT = new THREE.Color(0.55, 0.62, 0.5)
// Roughness by kind (dry): open-graded tarmac, painted kerbs and lines, turf.
const ROUGHNESS: Record<SurfaceKind, number> = { road: 0.86, kerb: 0.62, paint: 0.7, ground: 0.95, foliage: 0.9, object: 0.8, water: 0.06, far: 1 }

// The world's look: physically based and tone-mapped like the car, lit by
// the sun and the sky's environment (atmosphere.ts) and shaded by
// surfaces.ts (detail, wet, haze, far shadows). Foliage is Lambert (no
// highlights, less work for the many layered leaves) and alpha-tested with
// alpha to coverage; decals are offset towards the camera so they never
// fight the road under them.
function worldMaterial(material: THREE.Material, maxAnisotropy: number, textures: Set<THREE.Texture>, converted: Map<THREE.Material, THREE.Material>): THREE.Material {
  const done = converted.get(material)
  if (done) return done
  const m = material as THREE.MeshStandardMaterial
  const userData = { ...m.userData }
  const kind = surfaceKindOf(m)
  const common = {
    name: m.name, color: m.color?.clone() ?? new THREE.Color(1, 1, 1), map: m.map ?? null, normalMap: m.normalMap ?? null,
    side: m.side, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, depthWrite: m.depthWrite,
  }
  const out: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial = kind === 'foliage'
    ? new THREE.MeshLambertMaterial(common)
    : new THREE.MeshStandardMaterial({ ...common, roughness: ROUGHNESS[kind], metalness: 0 })
  if (m.normalScale && out.normalMap) out.normalScale.copy(m.normalScale)
  // The ground's photo texture is about twice as bright as turf (albedo ~0.15).
  if (kind === 'ground') out.color.multiplyScalar(GROUND_ALBEDO_SCALE)
  // The green-painted run-off tarmac: weathered, duller paint that sits with the grass.
  if (/^ASPHALT-GREEN/i.test(m.name)) out.color.multiply(GREEN_PAINT)
  out.userData = userData
  // Leaves and fences: sides, edges and the foliage's light (foliage.ts).
  if (out.alphaTest > 0) patchCutoutMaterial(out, kind)
  // Painted run-off keeps the tarmac's aggregate, softened by the paint.
  else patchWorldMaterial(out, kind, undefined, '', { detail: /^ASPHALT-GREEN/i.test(m.name) ? 0.5 : 1 })
  if (m.userData?.decal) {
    out.polygonOffset = true
    out.polygonOffsetFactor = -2
    out.polygonOffsetUnits = -4
    out.depthWrite = false
  }
  for (const texture of [out.map, out.normalMap]) {
    if (!texture) continue
    texture.anisotropy = maxAnisotropy
    textures.add(texture)
  }
  m.dispose()
  converted.set(material, out)
  return out
}

function disposeTree(root: THREE.Object3D, textures: Set<THREE.Texture>) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose()
  })
  for (const texture of textures) {
    const image = texture.image as ImageBitmap | undefined
    texture.dispose()
    image?.close?.()
  }
  textures.clear()
}

// ─── Footprint ──────────────────────────────────────────────────────────────

/** Where the model has ground, in glTF x/z (see TrackModelFootprint). */
export class Footprint {
  constructor(readonly info: TrackModelFootprint, readonly mask: Uint8Array) {}

  static async fromPng(buffer: ArrayBuffer, info: TrackModelFootprint): Promise<Footprint> {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }))
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      const mask = new Uint8Array(bitmap.width * bitmap.height)
      for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4] >= 128 ? 1 : 0
      return new Footprint({ ...info, width: bitmap.width, height: bitmap.height }, mask)
    } finally { bitmap.close() }
  }

  /**
   * Distance in cells (0…reach) from a glTF point to the edge of the covered
   * area, inside it; −1 outside. A coarse chessboard distance, enough to tuck
   * the far field under the model's ground with a margin.
   */
  depth(x: number, z: number, reach = 3): number {
    const { x0, z0, cellM, width, height } = this.info
    const i = Math.floor((x - x0) / cellM), j = Math.floor((z - z0) / cellM)
    const at = (a: number, b: number) => (a >= 0 && b >= 0 && a < width && b < height ? this.mask[b * width + a] : 0)
    if (!at(i, j)) return -1
    for (let r = 1; r <= reach; r++) {
      for (let k = -r; k <= r; k++) {
        if (!at(i + k, j - r) || !at(i + k, j + r) || !at(i - r, j + k) || !at(i + r, j + k)) return r - 1
      }
    }
    return reach
  }
}

// ─── Far field: the public terrain around the model ────────────────────────

/** Far-field terrain sinks this far under the model's ground near its edge, so the model's own edge shows. */
const EDGE_TUCK_M = 0.6

/**
 * The lidar terrain with the aerial photo (a texture as terrain.ts
 * loadImagery makes it) around the model: left out well inside the model's
 * ground (a hand-built model's terrain can sit metres off the lidar, and
 * the far field must never poke through it), sunk a little under its edge,
 * and at full height beyond.
 */
export function buildFarField(info: TerrainInfo, grid: Float32Array, frame: LocalFrame, track: AcTrack, texture: THREE.Texture | null, maxVertices = 600_000): THREE.Mesh {
  const { width: W, height: H } = info.grid
  const step = Math.max(1, Math.ceil(Math.sqrt(W * H / maxVertices)))
  const cols = Math.floor((W - 1) / step) + 1, rows = Math.floor((H - 1) / step) + 1
  const { south, west, north, east } = info.area
  const inverse = track.matrix.clone().invert()
  const p = new THREE.Vector3()
  const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2)
  // Vertices well inside the model's ground: triangles made only of these are left out.
  const inside = new Uint8Array(cols * rows)
  let fallback = info.grid.minM
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const lon = west + (c * step) / (W - 1) * (east - west), lat = north - (r * step) / (H - 1) * (north - south)
    let h = grid[r * step * W + c * step]
    if (!Number.isFinite(h)) h = fallback
    else fallback = h
    const x = (lon - frame.lon0) * frame.mx, z = -(lat - frame.lat0) * frame.mz
    let y = h - frame.baseM
    if (track.footprint) {
      p.set(x, y, z).applyMatrix4(inverse)
      const depth = track.footprint.depth(p.x, p.z)
      if (depth >= 2) inside[r * cols + c] = 1
      if (depth >= 0) y -= EDGE_TUCK_M
    }
    const i = r * cols + c
    pos.set([x, y, z], i * 3)
    // As terrain.ts loadImagery uploads the photo: unflipped, v from the north edge.
    uv.set([(lon - west) / (east - west), (north - lat) / (north - south)], i * 2)
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6)
  let k = 0
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1
    if (!(inside[a] && inside[d] && inside[b])) { index[k++] = a; index[k++] = d; index[k++] = b }
    if (!(inside[b] && inside[d] && inside[e])) { index[k++] = b; index[k++] = d; index[k++] = e }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(new THREE.BufferAttribute(index.slice(0, k), 1))
  geometry.computeVertexNormals()
  const material = new THREE.MeshLambertMaterial({ color: texture ? 0xffffff : 0x56653f, map: texture })
  patchWorldMaterial(material, 'far')
  // Behind the model's ground wherever they meet.
  material.polygonOffset = true
  material.polygonOffsetFactor = 2
  material.polygonOffsetUnits = 4
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'far-field'
  mesh.receiveShadow = true
  return mesh
}

/** The toggle's label: what the name says in brackets ("VIR (Assetto Corsa)" → "Assetto Corsa"), else the name. Credits stay in track.json, not on screen. */
export function trackModelLabel(model: TrackModel): string {
  return /\(([^()]{2,40})\)\s*$/.exec(model.name)?.[1].trim() ?? model.name
}
