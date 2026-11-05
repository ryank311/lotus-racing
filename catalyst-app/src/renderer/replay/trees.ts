// Simple instanced trees where the aerial photo shows forest, kept well off
// the road. Mostly for the driver's view: VIR is lined with woods. Tiles of
// instances so the ones behind the camera are culled.

import * as THREE from 'three'
import type { TerrainInfo } from '../../shared/replay'
import { gridHeight, imagePos, latAt, lonAt, type LocalFrame } from './geo'
import type { RoadModel } from './road'

const MAX_TREES = 45_000
const TILE_M = 400
/** No trees this close to the tarmac edge. */
const CLEAR_M = 15

function treeGeometry(): { broadleaf: THREE.BufferGeometry; conifer: THREE.BufferGeometry } {
  const trunkColor = new THREE.Color(0x4a3a2a), leafColor = new THREE.Color(0xffffff)
  const paint = (g: THREE.BufferGeometry, color: THREE.Color) => {
    const count = g.getAttribute('position').count
    const col = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) col.set([color.r, color.g, color.b], i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g.index ? g.toNonIndexed() : g
  }
  const join = (parts: THREE.BufferGeometry[]) => {
    const out = new THREE.BufferGeometry()
    for (const name of ['position', 'normal', 'color']) {
      const arrays = parts.map(p => p.getAttribute(name).array as Float32Array)
      const merged = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
      let at = 0
      for (const a of arrays) { merged.set(a, at); at += a.length }
      out.setAttribute(name, new THREE.BufferAttribute(merged, 3))
    }
    parts.forEach(p => p.dispose())
    return out
  }
  // Unit height: the trunk to 0.3, the crown above.
  const trunk = () => new THREE.CylinderGeometry(0.03, 0.045, 0.35, 5).translate(0, 0.175, 0)
  const crown = new THREE.IcosahedronGeometry(0.5, 0).scale(0.55, 0.75, 0.55).translate(0, 0.62, 0)
  const cone = new THREE.ConeGeometry(0.28, 0.82, 7).translate(0, 0.59, 0)
  return {
    broadleaf: join([paint(trunk(), trunkColor), paint(crown, leafColor)]),
    conifer: join([paint(trunk(), trunkColor), paint(cone, leafColor)]),
  }
}

export function buildTrees(road: RoadModel, pixels: ImageData, info: TerrainInfo, grid: Float32Array, frame: LocalFrame): { mesh: THREE.Group; count: number } | null {
  const { width, height, data } = pixels
  const raster = { width: info.grid.width, height: info.grid.height, area: info.area }
  // Forest: dark, green-leaning pixels, averaged over a 3 × 3 patch.
  const forest = (lat: number, lon: number) => {
    const [px, py] = imagePos(info.area, width, height, lat, lon)
    const i = Math.round(px), j = Math.round(py)
    if (i < 1 || j < 1 || i >= width - 1 || j >= height - 1) return false
    let r = 0, g = 0, b = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = ((j + dy) * width + i + dx) * 4
      r += data[k]; g += data[k + 1]; b += data[k + 2]
    }
    r /= 9; g /= 9; b /= 9
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    return lum > 12 && lum < 92 && g >= r - 2 && g - (r + b) / 2 > 3
  }
  const west = info.area.west, east = info.area.east, south = info.area.south, north = info.area.north
  const x0 = (west - frame.lon0) * frame.mx, x1 = (east - frame.lon0) * frame.mx
  const z0 = -(north - frame.lat0) * frame.mz, z1 = -(south - frame.lat0) * frame.mz
  // Spacing so the forest fills without passing the cap.
  let seed = 12345
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const candidates: Array<[number, number, number]> = []
  const probe = 9
  for (let z = z0 + probe / 2; z < z1; z += probe) for (let x = x0 + probe / 2; x < x1; x += probe) {
    if (forest(latAt(frame, z), lonAt(frame, x))) candidates.push([x, z, 0])
  }
  if (!candidates.length) return null
  const perCell = Math.max(1, Math.min(3, Math.floor(MAX_TREES / candidates.length)))
  const tiles = new Map<string, { broadleaf: THREE.Matrix4[]; conifer: THREE.Matrix4[]; colors: THREE.Color[]; coniferColors: THREE.Color[] }>()
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3()
  let count = 0
  for (const [cx, cz] of candidates) {
    for (let k = 0; k < perCell && count < MAX_TREES; k++) {
      const x = cx + (random() - 0.5) * probe, z = cz + (random() - 0.5) * probe
      const lat = latAt(frame, z), lon = lonAt(frame, x)
      if (k > 0 && !forest(lat, lon)) continue
      const s = road.nearest(x, z)
      if (s >= 0) {
        const surface = road.surface(x, z, s)
        const edge = surface.o >= 0 ? road.left[surface.s] : road.right[surface.s]
        if (Math.abs(surface.o) < edge + CLEAR_M) continue
      }
      const ground = gridHeight(grid, raster, lat, lon)
      if (!Number.isFinite(ground)) continue
      const tall = 13 + random() * 12
      position.set(x, ground - frame.baseM - 0.3, z)
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2)
      scale.set(tall * (0.8 + random() * 0.4), tall, tall * (0.8 + random() * 0.4))
      matrix.compose(position, quaternion, scale)
      const key = `${Math.floor(x / TILE_M)},${Math.floor(z / TILE_M)}`
      let tile = tiles.get(key)
      if (!tile) tiles.set(key, tile = { broadleaf: [], conifer: [], colors: [], coniferColors: [] })
      const conifer = random() < 0.3
      const color = new THREE.Color().setHSL(0.22 + random() * 0.08, 0.3 + random() * 0.2, conifer ? 0.2 + random() * 0.06 : 0.26 + random() * 0.1, THREE.SRGBColorSpace)
      if (conifer) { tile.conifer.push(matrix.clone()); tile.coniferColors.push(color) }
      else { tile.broadleaf.push(matrix.clone()); tile.colors.push(color) }
      count++
    }
  }
  if (!count) return null
  const { broadleaf, conifer } = treeGeometry()
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })
  const group = new THREE.Group()
  group.name = 'trees'
  for (const tile of tiles.values()) {
    for (const [geometry, matrices, colors] of [[broadleaf, tile.broadleaf, tile.colors], [conifer, tile.conifer, tile.coniferColors]] as const) {
      if (!matrices.length) continue
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length)
      mesh.name = 'tree'
      matrices.forEach((m, i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, colors[i]) })
      mesh.computeBoundingSphere()
      group.add(mesh)
    }
  }
  return { mesh: group, count }
}
