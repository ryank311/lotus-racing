// The terrain: a mesh from the USGS 3DEP grid with the NAIP photo draped
// over it, pressed down under the road so it never pokes through, with a
// skirt down to a wide ground plane past its edge.

import * as THREE from 'three'
import type { TerrainInfo } from '../../shared/replay'
import { localX, localZ, type LocalFrame } from './geo'
import { SHOULDER_M, type RoadModel, type SurfacePoint } from './road'

// The server's grid is at most 1400 px on its long side; a larger one is thinned.
const MAX_VERTICES = 2_100_000
/** Terrain under the road sits this far below the road surface. */
export const UNDER_ROAD_M = 0.12

export interface TerrainMesh {
  mesh: THREE.Group
  material: THREE.MeshLambertMaterial
  /** Height of the ground plane past the terrain's edge (local y). */
  edgeY: number
  /** Metres between vertices. */
  spacingM: number
}

/** Average colour of an image (for the ground past the terrain's edge and the fog). */
export function averageColor(pixels: ImageData | null): THREE.Color {
  if (!pixels) return new THREE.Color(0x4d5a3a)
  let r = 0, g = 0, b = 0, count = 0
  const { data } = pixels
  for (let i = 0; i < data.length; i += 4 * 97) { r += data[i]; g += data[i + 1]; b += data[i + 2]; count++ }
  return new THREE.Color().setRGB(r / count / 255, g / count / 255, b / count / 255, THREE.SRGBColorSpace)
}

export function buildTerrain(info: TerrainInfo, grid: Float32Array, frame: LocalFrame, road: RoadModel, texture: THREE.Texture | null): TerrainMesh {
  const { width: W, height: H } = info.grid
  const step = Math.max(1, Math.ceil(Math.sqrt(W * H / MAX_VERTICES)))
  const cols = Math.floor((W - 1) / step) + 1, rows = Math.floor((H - 1) / step) + 1
  const { south, west, north, east } = info.area
  // A vertex grid: the first and last vertices lie on the box's edges.
  const lonAt = (i: number) => west + i / (W - 1) * (east - west)
  const latAt = (j: number) => north - j / (H - 1) * (north - south)
  const spacingM = step * Math.min((east - west) / (W - 1) * frame.mx, (north - south) / (H - 1) * frame.mz)

  // Heights, holes filled from the nearest good neighbour along the row.
  const heights = new Float32Array(cols * rows)
  let fallback = 0, good = 0
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = grid[r * step * W + c * step]
    heights[r * cols + c] = v
    if (Number.isFinite(v)) { fallback += v; good++ }
  }
  fallback = good ? fallback / good : info.grid.minM
  for (let r = 0; r < rows; r++) {
    let last = NaN
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (Number.isFinite(heights[i])) last = heights[i]
      else heights[i] = Number.isFinite(last) ? last : fallback
    }
  }

  // Under and beside the road the terrain takes the road's height (less a
  // little), easing back to the lidar over a few metres.
  const corridorPad = Math.max(SHOULDER_M, 1.5 * spacingM + 0.5)
  const blendM = Math.max(6, 3 * spacingM)
  // Only vertices near the road need the (slower) nearest-station lookup.
  const near = new Uint8Array(cols * rows)
  const reach = Math.max(...road.left, ...road.right) + corridorPad + blendM + spacingM
  const colOf = (x: number) => (x / frame.mx + frame.lon0 - west) / (east - west) * (W - 1) / step
  const rowOf = (z: number) => (north - (frame.lat0 - z / frame.mz)) / (north - south) * (H - 1) / step
  const cellsX = reach / spacingM, cellsZ = reach / spacingM
  for (let s = 0; s < road.n; s++) {
    const c0 = colOf(road.cx[s]), r0 = rowOf(road.cz[s])
    for (let r = Math.max(0, Math.floor(r0 - cellsZ)); r <= Math.min(rows - 1, Math.ceil(r0 + cellsZ)); r++) {
      for (let c = Math.max(0, Math.floor(c0 - cellsX)); c <= Math.min(cols - 1, Math.ceil(c0 + cellsX)); c++) near[r * cols + c] = 1
    }
  }
  const pos = new Float32Array((cols * rows + 2 * (cols + rows)) * 3)
  const uv = new Float32Array(pos.length / 3 * 2)
  const surface: SurfacePoint = { h: 0, o: 0, s: 0, t: 0 }
  for (let r = 0; r < rows; r++) {
    const lat = latAt(r * step), z = localZ(frame, lat)
    for (let c = 0; c < cols; c++) {
      const lon = lonAt(c * step), x = localX(frame, lon)
      const i = r * cols + c
      let y = heights[i] - frame.baseM
      const s = near[i] ? road.nearest(x, z) : -1
      if (s >= 0) {
        road.surface(x, z, s, surface)
        const edge = surface.o >= 0 ? road.left[surface.s] : road.right[surface.s]
        // Metres past the tarmac edge (negative on the road).
        const beyond = Math.abs(surface.o) - edge
        const under = surface.h - UNDER_ROAD_M
        if (beyond <= corridorPad) y = under
        else if (beyond < corridorPad + blendM) {
          const e = (beyond - corridorPad) / blendM
          y = under + (y - under) * e * e * (3 - 2 * e)
        }
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z
      uv[i * 2] = (lon - west) / (east - west)
      uv[i * 2 + 1] = (north - lat) / (north - south)
    }
  }

  // Skirt: the border repeated down at the ground plane's height.
  const border: number[] = []
  for (let c = 0; c < cols; c++) border.push(c)
  for (let r = 1; r < rows; r++) border.push(r * cols + cols - 1)
  for (let c = cols - 2; c >= 0; c--) border.push((rows - 1) * cols + c)
  for (let r = rows - 2; r > 0; r--) border.push(r * cols)
  const edgeHeights = border.map(i => pos[i * 3 + 1]).sort((a, b) => a - b)
  const edgeY = edgeHeights[Math.floor(edgeHeights.length * 0.1)] - 4
  let next = cols * rows
  const skirtStart = next
  for (const i of border) {
    pos[next * 3] = pos[i * 3]; pos[next * 3 + 1] = edgeY - 20; pos[next * 3 + 2] = pos[i * 3 + 2]
    uv[next * 2] = uv[i * 2]; uv[next * 2 + 1] = uv[i * 2 + 1]
    next++
  }

  // One vertex buffer, drawn as tiles so those out of view are culled.
  const position = new THREE.BufferAttribute(pos.subarray(0, next * 3), 3)
  const uvs = new THREE.BufferAttribute(uv.subarray(0, next * 2), 2)
  const normals = new THREE.BufferAttribute(new Float32Array(next * 3), 3)
  const whole = new THREE.BufferGeometry()
  whole.setAttribute('position', position)
  const allIndex: number[] = []
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1
    allIndex.push(a, d, b, b, d, e)
  }
  whole.setIndex(allIndex)
  whole.computeVertexNormals()
  normals.copy(whole.getAttribute('normal') as THREE.BufferAttribute)
  whole.dispose()

  const material = new THREE.MeshLambertMaterial({ map: texture, color: texture ? new THREE.Color(1.3, 1.3, 1.3) : 0x56653f, side: THREE.DoubleSide })
  const group = new THREE.Group()
  group.name = 'terrain'
  const tile = (index: number[], name: string) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', position)
    geometry.setAttribute('normal', normals)
    geometry.setAttribute('uv', uvs)
    geometry.setIndex(index)
    // Bounds from this tile's own vertices (the buffer holds them all).
    const box = new THREE.Box3(), v = new THREE.Vector3()
    for (const i of index) box.expandByPoint(v.fromBufferAttribute(position, i))
    geometry.boundingBox = box
    geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    group.add(mesh)
  }
  const TILE = 96
  for (let r0 = 0; r0 < rows - 1; r0 += TILE) for (let c0 = 0; c0 < cols - 1; c0 += TILE) {
    const index: number[] = []
    for (let r = r0; r < Math.min(rows - 1, r0 + TILE); r++) for (let c = c0; c < Math.min(cols - 1, c0 + TILE); c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1
      index.push(a, d, b, b, d, e)
    }
    tile(index, 'terrain-tile')
  }
  const skirt: number[] = []
  for (let k = 0; k < border.length; k++) {
    const a = border[k], b = border[(k + 1) % border.length]
    const a2 = skirtStart + k, b2 = skirtStart + (k + 1) % border.length
    skirt.push(a, b, a2, b, b2, a2)
  }
  tile(skirt, 'terrain-skirt')
  return { mesh: group, material, edgeY, spacingM }
}

/** The wide ground past the terrain's edge (and the whole ground without terrain). */
export function buildGround(y: number, color: THREE.Color): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(60_000, 60_000)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color }))
  mesh.position.y = y
  mesh.name = 'ground'
  return mesh
}

/** The aerial photo as a texture, and its pixels for edge and tree finding. */
export async function loadImagery(blob: Blob, maxAnisotropy: number): Promise<{ texture: THREE.Texture; pixels: ImageData | null }> {
  const bitmap = await createImageBitmap(blob)
  const texture = new THREE.Texture(bitmap)
  // ImageBitmaps upload unflipped: v runs from the north edge (see uv above).
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = maxAnisotropy
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.needsUpdate = true
  let pixels: ImageData | null = null
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0)
    pixels = context.getImageData(0, 0, bitmap.width, bitmap.height)
  } catch { /* edge finding and trees are optional */ }
  return { texture, pixels }
}
