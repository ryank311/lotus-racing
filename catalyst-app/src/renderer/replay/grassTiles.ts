// The grass field's layout (grass.ts), kept free of the GPU so it can be
// tested (tests/replayGrass.test.ts): how dense the blades stand with
// distance, how many each tier's tile holds, where the blades sit in a tile,
// and which world tiles around the camera are drawn this frame at which tier.
//
// The ground is cut into square world tiles. Each drawn tile is one instance
// of its tier's blade mesh: the nearest tiers carry the most blades, each
// blade in three segments; further out fewer, plainer blades; the furthest a
// single triangle each. A tier's blades are the first of one list (any first
// n of which are spread evenly), and every blade keeps its rank in that list,
// so the shader thins them by distance the same way at every tier: a tile
// that changes tier keeps the blades it shows and nothing pops.

import * as THREE from 'three'

export type BladeShape = 'fine' | 'plain' | 'single'

export interface GrassTier {
  /** Tiles nearer than this (m, their nearest point) are drawn at this tier. */
  reachM: number
  shape: BladeShape
}

export interface GrassQuality {
  /** Ground map texels and side (m). */
  mapSize: number
  mapSpanM: number
  /** Side of a tile (m). */
  tileM: number
  /** Blades per m² out to nearM; beyond, falling as nearM / distance. */
  densityNear: number
  nearM: number
  /** A blade's width (m) before it widens to stay MIN_PIXELS wide; the density falls as it does. */
  widthM: number
  /** Nearest first; the last one's reach is the field's edge. */
  tiers: GrassTier[]
  /** The field thins out from here (m) to its edge. */
  fadeFromM: number
}

/** By graphics level; none on Low (a constrained device: the blades and their map go first). */
export const GRASS_QUALITY: Record<'high' | 'medium' | 'low', GrassQuality | null> = {
  high: {
    mapSize: 1024, mapSpanM: 180, tileM: 2, densityNear: 1400, nearM: 3, widthM: 0.0105,
    tiers: [
      { reachM: 4.5, shape: 'fine' }, { reachM: 8, shape: 'plain' }, { reachM: 13, shape: 'plain' },
      { reachM: 22, shape: 'single' }, { reachM: 34, shape: 'single' }, { reachM: 50, shape: 'single' },
    ],
    fadeFromM: 36,
  },
  medium: {
    mapSize: 512, mapSpanM: 128, tileM: 2, densityNear: 900, nearM: 3, widthM: 0.0115,
    tiers: [{ reachM: 5, shape: 'plain' }, { reachM: 10, shape: 'plain' }, { reachM: 18, shape: 'single' }, { reachM: 34, shape: 'single' }],
    fadeFromM: 24,
  },
  low: null,
}

export const fieldRadius = (q: GrassQuality) => q.tiers[q.tiers.length - 1].reachM

/** The narrowest a blade is drawn, in pixels: further out they widen and stand fewer. */
export const MIN_PIXELS = 1.5
/**
 * Radians per pixel the tiers are sized for (the chase view's 60° on a
 * 1.75 × stage): on a sharper screen the far tiers hold a little fewer
 * blades than would stand there.
 */
export const REFERENCE_PIXEL_ANGLE = 0.001

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Blades per m² at `distM` from the camera, before the ground thins them
 * (turf, patches, tufts). With `pixelAngle` (radians per pixel) blades
 * narrower than MIN_PIXELS are drawn that wide and fewer. The shader
 * (grass.ts GRASS_BEGIN) is the same formula.
 */
export function grassDensity(q: GrassQuality, distM: number, pixelAngle = 0): number {
  const d = Math.max(distM, 0.1)
  const widen = pixelAngle > 0 ? Math.min(1, q.widthM / (d * pixelAngle * MIN_PIXELS)) : 1
  return q.densityNear * Math.min(1, q.nearM / d) * widen * (1 - smoothstep(q.fadeFromM, fieldRadius(q), d))
}

/** Blades in one tile of each tier: as many as stand at the tier's nearest distance. */
export function tierCapacities(q: GrassQuality, pixelAngle = REFERENCE_PIXEL_ANGLE): number[] {
  const area = q.tileM * q.tileM
  return q.tiers.map((_, i) => Math.ceil(area * (i === 0 ? q.densityNear : grassDensity(q, q.tiers[i - 1].reachM, pixelAngle))))
}

/**
 * Blade roots in a tile (u, v in 0–1), in the order they thin out: any
 * first n are spread evenly over the tile with no rows or lattice (blue
 * noise: Mitchell's best candidate, each the farthest of a few random tries
 * from those before it), and it wraps at the tile's edges.
 */
export function bladeLayout(count: number, seed = 7, tries = 8): Float32Array {
  const key = `${count}:${seed}:${tries}`
  const cached = layouts.get(key)
  if (cached) return cached
  let s = seed
  const random = () => (s = (s * 16807) % 2147483647) / 2147483647
  const out = new Float32Array(count * 2)
  // Buckets of about two points each (a linked list through `next`), for the nearest-point search.
  const side = Math.max(1, Math.floor(Math.sqrt(count / 2)))
  const head = new Int32Array(side * side).fill(-1), next = new Int32Array(count).fill(-1)
  for (let n = 0; n < count; n++) {
    let bestD = -1, bestX = 0, bestY = 0
    for (let t = 0; t < tries; t++) {
      const x = random(), y = random()
      // Squared distance to the nearest point so far (wrapping): the first
      // few against all, then rings of buckets outwards until none nearer
      // could remain.
      let d = Infinity
      if (n < 64) {
        for (let k = 0; k < n; k++) {
          let dx = out[k * 2] - x, dy = out[k * 2 + 1] - y
          dx -= Math.round(dx); dy -= Math.round(dy)
          d = Math.min(d, dx * dx + dy * dy)
        }
      } else {
        const bx = Math.floor(x * side), by = Math.floor(y * side)
        for (let ring = 0; ring <= side / 2; ring++) {
          if (ring > 1 && (ring - 1) * (ring - 1) > d * side * side) break
          for (let j = -ring; j <= ring; j++) {
            const edge = j === -ring || j === ring
            for (let i = -ring; i <= ring; i += edge || ring === 0 ? 1 : 2 * ring) {
              let k = head[(((by + j) % side) + side) % side * side + (((bx + i) % side) + side) % side]
              while (k >= 0) {
                let dx = out[k * 2] - x, dy = out[k * 2 + 1] - y
                dx -= Math.round(dx); dy -= Math.round(dy)
                d = Math.min(d, dx * dx + dy * dy)
                k = next[k]
              }
            }
          }
        }
      }
      if (d > bestD) { bestD = d; bestX = x; bestY = y }
    }
    out[n * 2] = bestX
    out[n * 2 + 1] = bestY
    const b = Math.min(side - 1, Math.floor(bestY * side)) * side + Math.min(side - 1, Math.floor(bestX * side))
    next[n] = head[b]
    head[b] = n
  }
  layouts.set(key, out)
  return out
}
const layouts = new Map<string, Float32Array>()

/** Which tier a tile is drawn at, by its nearest distance (m) to the camera; -1 beyond the field. */
export function tierAt(q: GrassQuality, distM: number): number {
  for (let i = 0; i < q.tiers.length; i++) if (distM < q.tiers[i].reachM) return i
  return -1
}

/**
 * What the ground map holds for each tile around it (grass.ts reads it back
 * after drawing the map): rgba per tile = how grassy its grassiest point is
 * (0–1), the lowest and highest grassy ground in it (m, world), unused.
 * Tile (i0 + a, j0 + b) at row b, column a.
 */
export interface TileMask {
  i0: number
  j0: number
  size: number
  data: Float32Array
}

/** A tile with no point this grassy grows no blades (the shader's turf threshold). */
export const MASK_GRASSY = 0.45
/** Blades stand at most this tall (m). */
const BLADE_TOP_M = 0.3
/** Without a mask: the ground within this of the car's height near the camera, and this much more per metre away. */
const SLACK_M = 2, SLOPE = 0.3

/**
 * The tiles to draw: each frame, those around the camera within the field
 * that the view can see and that have turf, by tier, nearest first (so near
 * blades hide what is behind them before it is shaded). Tile indices (x, z),
 * so tile (i, j) covers [i, i + 1) × [j, j + 1) tiles of tileM.
 */
export class GrassTiles {
  /** Per tier: tile indices (x, z) to draw, and how many. */
  readonly tiles: Float32Array[]
  readonly counts: number[]
  private offsets: Int16Array
  private frustum = new THREE.Frustum()
  private matrix = new THREE.Matrix4()
  private box = new THREE.Box3()
  private last = new THREE.Matrix4()
  private lastY = NaN
  private lastMask: TileMask | null = null

  constructor(private q: GrassQuality) {
    const s = q.tileM, reach = fieldRadius(q)
    const n = Math.ceil(reach / s) + 1
    const list: Array<[number, number, number]> = []
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      // Nearest distance from anywhere in the camera's own tile.
      const dx = Math.max(0, Math.abs(i) - 1) * s, dz = Math.max(0, Math.abs(j) - 1) * s
      const d = Math.hypot(dx, dz)
      if (d < reach) list.push([i, j, d])
    }
    list.sort((a, b) => a[2] - b[2])
    this.offsets = new Int16Array(list.flatMap(([i, j]) => [i, j]))
    this.tiles = q.tiers.map(() => new Float32Array(list.length * 2))
    this.counts = q.tiers.map(() => 0)
  }

  get maxTiles() { return this.offsets.length / 2 }

  /**
   * Choose the tiles for this view. `groundY`: the ground's height near the
   * camera (the car's), for tiles the mask does not cover. False when
   * nothing changed since the last call: the lists stand.
   */
  select(camera: THREE.Camera, groundY: number, mask: TileMask | null = null): boolean {
    camera.updateMatrixWorld()
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    if (this.matrix.equals(this.last) && groundY === this.lastY && mask === this.lastMask) return false
    this.last.copy(this.matrix)
    this.lastY = groundY
    this.lastMask = mask
    this.frustum.setFromProjectionMatrix(this.matrix, THREE.WebGLCoordinateSystem, camera.reversedDepth)
    const q = this.q, s = q.tileM, reach = fieldRadius(q)
    const p = camera.position
    const ci = Math.floor(p.x / s), cj = Math.floor(p.z / s)
    const counts = this.counts
    counts.fill(0)
    const box = this.box
    const offsets = this.offsets
    for (let k = 0; k < offsets.length; k += 2) {
      const i = ci + offsets[k], j = cj + offsets[k + 1]
      const x0 = i * s, z0 = j * s
      const dx = Math.max(x0 - p.x, 0, p.x - x0 - s), dz = Math.max(z0 - p.z, 0, p.z - z0 - s)
      const flat = Math.sqrt(dx * dx + dz * dz)
      if (flat >= reach) continue
      // Its ground's height: from the mask (and none without turf), else near the car's.
      let lo: number, hi: number
      const a = mask ? i - mask.i0 : -1, b = mask ? j - mask.j0 : -1
      if (mask && a >= 0 && b >= 0 && a < mask.size && b < mask.size) {
        const m = (b * mask.size + a) * 4
        if (mask.data[m] < MASK_GRASSY) continue
        lo = mask.data[m + 1] - 0.05
        hi = mask.data[m + 2] + BLADE_TOP_M
      } else {
        const slack = SLACK_M + SLOPE * flat
        lo = groundY - slack
        hi = groundY + slack
      }
      const dy = Math.max(0, lo - p.y, p.y - hi)
      const d = Math.sqrt(flat * flat + dy * dy)
      if (d >= reach) continue
      box.min.set(x0, lo, z0)
      box.max.set(x0 + s, hi, z0 + s)
      if (!this.frustum.intersectsBox(box)) continue
      const tier = tierAt(q, d)
      const list = this.tiles[tier], n = counts[tier]++
      list[n * 2] = i
      list[n * 2 + 1] = j
    }
    return true
  }
}
