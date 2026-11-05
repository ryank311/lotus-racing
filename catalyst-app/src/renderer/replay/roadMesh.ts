// Meshes on the road model: the tarmac, its edge lines, kerbs at each
// corner's apex, the start/finish line, and a lap's racing line.

import * as THREE from 'three'
import type { ReplayCorner } from '../../shared/replay'
import { speedColor } from '../components/chartTheme'
import { LAT, type RoadModel } from './road'
import type { LapPath } from './lapPath'

// Painted things sit just above the tarmac and win the depth test.
const PAINT_LIFT = 0.02
const paintOffset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }

function asphaltTexture(maxAnisotropy: number): THREE.Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = '#6a6b6e'
  g.fillRect(0, 0, size, size)
  // Aggregate: a few thousand light and dark specks.
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 9000; i++) {
    const v = 70 + random() * 70
    g.fillStyle = `rgba(${v},${v},${v + 2},${0.25 + random() * 0.35})`
    g.fillRect(random() * size, random() * size, 1 + random() * 1.5, 1 + random() * 1.5)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = maxAnisotropy
  return texture
}

/** Station indices to draw, closing the loop when the line is closed. */
function stations(road: RoadModel): number[] {
  const list = Array.from({ length: road.n }, (_, i) => i)
  if (road.closed) list.push(0)
  return list
}

export function buildRoadSurface(road: RoadModel, maxAnisotropy: number): THREE.Mesh {
  const order = stations(road)
  const across = LAT - 2 // right edge … left edge
  const pos = new Float32Array(order.length * across * 3)
  const uv = new Float32Array(order.length * across * 2)
  order.forEach((s, row) => {
    // The closing row continues the distance so the texture does not jump.
    const along = row === order.length - 1 && road.closed ? road.totalM : road.dist[s]
    for (let k = 1; k <= across; k++) {
      const o = road.offset(s, k)
      const [x, z] = road.pointAt(s, o)
      const i = row * across + k - 1
      pos[i * 3] = x; pos[i * 3 + 1] = road.heights[s * LAT + k]; pos[i * 3 + 2] = z
      uv[i * 2] = o / 4; uv[i * 2 + 1] = along / 4
    }
  })
  const index: number[] = []
  for (let row = 0; row < order.length - 1; row++) for (let k = 0; k < across - 1; k++) {
    const a = row * across + k, b = a + 1, c = a + across, d = c + 1
    // Offsets run right to left, so this winding faces up.
    index.push(a, b, c, b, d, c)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  const material = new THREE.MeshLambertMaterial({ map: asphaltTexture(maxAnisotropy), side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'road'
  return mesh
}

/** A strip along the road between two lateral offsets (+ left), as a non-indexed triangle list. */
function strip(road: RoadModel, list: number[], inner: (s: number) => number, outer: (s: number) => number, lift: number, color: (s: number, along: number) => THREE.Color | null): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = []
  for (let q = 0; q < list.length - 1; q++) {
    const s0 = list[q], s1 = list[q + 1]
    const c = color(s0, q)
    if (!c) continue
    const corners = [[s0, inner(s0)], [s0, outer(s0)], [s1, inner(s1)], [s1, outer(s1)]].map(([s, o]) => {
      const [x, z] = road.pointAt(s, o)
      return [x, road.heightAcross(s, o) + lift, z]
    })
    // Winding up for either side: the outer offset may be left or right of the inner.
    const leftward = outer(s0) > inner(s0)
    const tris = leftward ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2]
    for (const t of tris) { pos.push(...corners[t]); col.push(c.r, c.g, c.b) }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geometry.computeVertexNormals()
  return geometry
}

export function buildEdgeLines(road: RoadModel): THREE.Mesh {
  const list = stations(road)
  const white = new THREE.Color(0xe9e9e4)
  const left = strip(road, list, s => road.left[s] - 0.3, s => road.left[s] - 0.15, PAINT_LIFT, () => white)
  const right = strip(road, list, s => -road.right[s] + 0.3, s => -road.right[s] + 0.15, PAINT_LIFT, () => white)
  const geometry = mergeGeometries([left, right])
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, ...paintOffset }))
  mesh.name = 'edge-lines'
  return mesh
}

/** Which way a corner turns: from its direction, else the line's own bend. */
function turnsLeft(road: RoadModel, corner: ReplayCorner): boolean {
  if (corner.direction) return corner.direction === 'left'
  const s = road.stationAt(corner.apexM)
  const a = road.wrap(s - 15), b = road.wrap(s + 15)
  // Forward at b against the left normal at a.
  const fx = -road.lz[b], fz = road.lx[b]
  return fx * road.lx[a] + fz * road.lz[a] > 0
}

export function buildKerbs(road: RoadModel, corners: ReplayCorner[]): THREE.Mesh | null {
  const red = new THREE.Color(0xc8231e), white = new THREE.Color(0xf2f2ee)
  const parts: THREE.BufferGeometry[] = []
  for (const corner of corners) {
    const half = Math.min(40, Math.max(12, (corner.endM - corner.startM) * 0.35))
    const from = road.stationAt(corner.apexM - half), count = Math.round(2 * half)
    const list = Array.from({ length: count + 1 }, (_, k) => road.wrap(from + k))
    const left = turnsLeft(road, corner)
    const side = left ? 1 : -1
    const edge = (s: number) => (left ? road.left[s] : road.right[s])
    // Tapered ends over the first and last 3 m.
    const width = (q: number) => 1.1 * Math.min(1, (q + 1) / 3, (count - q + 1) / 3)
    const at = new Map(list.map((s, q) => [s, q]))
    parts.push(strip(road, list, s => side * (edge(s) - 0.15), s => side * (edge(s) - 0.15 + width(at.get(s) ?? 0)), 0.045,
      (_, q) => (Math.floor(q / 1.5) % 2 ? white : red)))
  }
  if (!parts.length) return null
  const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true, ...paintOffset }))
  mesh.name = 'kerbs'
  return mesh
}

export function buildStartLine(road: RoadModel): THREE.Mesh {
  const s0 = road.stationAt(0)
  const pos: number[] = [], col: number[] = []
  const black = new THREE.Color(0x111111), white = new THREE.Color(0xf4f4f4)
  const square = 0.5
  const from = -road.right[s0], to = road.left[s0]
  const columns = Math.max(1, Math.round((to - from) / square))
  for (let row = 0; row < 3; row++) for (let c = 0; c < columns; c++) {
    const color = (row + c) % 2 ? white : black
    const o0 = from + (to - from) * c / columns, o1 = from + (to - from) * (c + 1) / columns
    const a0 = row * square - 0.75, a1 = a0 + square
    const fx = -road.lz[s0], fz = road.lx[s0]
    const point = (o: number, a: number) => {
      const [x, z] = road.pointAt(s0, o)
      return [x + fx * a, road.heightAcross(s0, o) + PAINT_LIFT, z + fz * a]
    }
    const quad = [point(o0, a0), point(o1, a0), point(o0, a1), point(o1, a1)]
    for (const t of [0, 1, 2, 1, 3, 2]) { pos.push(...quad[t]); col.push(color.r, color.g, color.b) }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, ...paintOffset }))
  mesh.name = 'start-finish'
  return mesh
}

/** A lap's line on the road: coloured by speed, or in one colour (a ghost). */
/** `surface`: a 3D track model's height near a reference (NaN off it), for kerbs the road's samples across miss. */
export function buildLapLine(lap: LapPath, road: RoadModel, color: THREE.Color | null, speedRange: [number, number], widthM = 0.32, surface?: (x: number, z: number, refY: number) => number): THREE.Mesh {
  const n = lap.n
  const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 3)
  let hint = road.stationAt(lap.d[0])
  const [lo, hi] = speedRange
  for (let i = 0; i < n; i++) {
    const x = lap.x[i], z = lap.z[i]
    hint = road.nearestFrom(x, z, road.stationAt(lap.d[i]), 12)
    const onRoad = road.surface(x, z, hint).h
    const onModel = surface ? surface(x, z, onRoad) : NaN
    const y = (Number.isFinite(onModel) ? onModel : onRoad) + PAINT_LIFT * 2
    // Left of the direction of travel: (fz, -fx).
    const ox = lap.fz[i] * widthM / 2, oz = -lap.fx[i] * widthM / 2
    pos.set([x + ox, y, z + oz, x - ox, y, z - oz], i * 6)
    const c = color ?? new THREE.Color(speedColor((lap.speed[i] - lo) / Math.max(0.1, hi - lo)))
    col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6)
  }
  const index: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3
    index.push(a, c, b, b, c, d)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geometry.setIndex(index)
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !!color, opacity: color ? 0.75 : 1, depthWrite: false, toneMapped: false, ...paintOffset })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = 2
  mesh.name = color ? 'ghost-line' : 'racing-line'
  return mesh
}

export function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const join = (name: string) => {
    const arrays = parts.map(g => g.getAttribute(name)?.array as Float32Array | undefined)
    if (arrays.some(a => !a)) return null
    const out = new Float32Array(arrays.reduce((sum, a) => sum + a!.length, 0))
    let at = 0
    for (const a of arrays) { out.set(a!, at); at += a!.length }
    return out
  }
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'color', 'normal']) {
    const array = join(name)
    if (array) out.setAttribute(name, new THREE.BufferAttribute(array, 3))
  }
  for (const g of parts) g.dispose()
  return out
}
