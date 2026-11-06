// Track debug overlays: the data that places the car, drawn over the world
// so where it disagrees with the track shows. The lines float a little above
// the ground (hills and buildings still hide them, so a far part of the
// track does not show through).
//
// - Track edges: the 3D model's road edges (track.json `edges`, what laps
//   are aligned to and the coaching marks sit between), its centre, and a
//   cross-section every CROSS_EVERY_M.
// - Garmin line: the mean line from Garmin (lap distances run along it).
// - GPS: each lap's positions as recorded (smoothed, before any shift).
// - Car path: where the car is drawn (the GPS plus the lap's one shift),
//   coloured by how far the car's side is from the model's road edge:
//   green well inside, amber within half a metre, red over the edge,
//   magenta more than a car's width off.
// - Wireframe: the track model's meshes as wireframe.
// - Flags: spots marked from the debug panel, as posts.
//
// probe() measures the same things at a point (the car's), for the panel.

import * as THREE from 'three'
import type { Across, TrackEdges } from './align'
import type { LapPath } from './lapPath'
import type { RoadModel } from './road'

export interface TrackDebugOptions {
  edges: boolean
  garmin: boolean
  gps: boolean
  path: boolean
  wireframe: boolean
}

export const NO_TRACK_DEBUG: TrackDebugOptions = { edges: false, garmin: false, gps: false, path: false, wireframe: false }

/** Where the car is against the data, at one point. Offsets are metres, + left of the direction of travel. */
export interface TrackProbe {
  dist: number
  /** Against the model's road edges; null without them (public-data track) or off them. */
  model: { offsetM: number; halfWidthM: number; widthM: number; carEdgeM: number } | null
  /** From Garmin's mean line. */
  garminOffsetM: number
  /** Garmin's line from the model's road centre at this point; null without model edges. */
  garminFromModelM: number | null
  /** The lap's shift (align to track), metres east and south. */
  shift: { dx: number; dz: number }
}

const LIFT = 0.35
const CROSS_EVERY_M = 20
const COLORS = {
  edge: 0xffd400, centre: 0xb39400, cross: 0xffd400, garmin: 0x22d3ee,
  gps: 0xff5a5a, ghostGps: 0xff9ab0, inside: 0x34d399, near: 0xfbbf24, over: 0xef4444, far: 0xd946ef,
}

const lineMaterial = (color: number | null, opacity: number) => new THREE.LineBasicMaterial({
  color: color ?? 0xffffff, vertexColors: color == null, transparent: true, opacity, depthWrite: false, toneMapped: false,
})

export class TrackDebug {
  readonly group = new THREE.Group()
  private options: TrackDebugOptions = { ...NO_TRACK_DEBUG }
  private key = ''
  private wired: THREE.Material[] = []
  private flags: number[] = []
  private across: Across = { o: 0, half: 0, ax: 0, az: 0 }
  private hint = -1

  constructor() {
    this.group.name = 'track-debug'
    this.group.renderOrder = 30
  }

  get active(): boolean {
    const o = this.options
    return o.edges || o.garmin || o.gps || o.path || o.wireframe
  }

  setOptions(options: TrackDebugOptions) {
    this.options = { ...options }
    this.key = ''
  }

  /** Distances (m along the lap) to mark with posts. */
  setFlags(dists: number[]) {
    this.flags = [...dists]
    this.key = ''
  }

  /**
   * Rebuilds the lines when anything they show changed: cheap to call every
   * frame. `carHalfWidthM`: half the car's width, for the path's colours.
   */
  sync(world: { group: THREE.Object3D; road: RoadModel; trackEdges?: TrackEdges | null; surface?: (x: number, z: number, refY: number) => number } | null,
    lap: LapPath | null, ghost: LapPath | null, carHalfWidthM: number): boolean {
    const o = this.options
    const key = [world ? world.group.uuid : '-', lap ? `${lap.lap.sessionGuid}:${lap.lap.lap}:${lap.offsetX}:${lap.offsetZ}:${lap.placed}` : '-',
      ghost ? `${ghost.lap.sessionGuid}:${ghost.lap.lap}:${ghost.offsetX}:${ghost.offsetZ}:${ghost.placed}` : '-',
      carHalfWidthM, JSON.stringify(o), this.flags.join(',')].join('|')
    if (key === this.key) return false
    this.key = key
    this.clear()
    this.setWireframe(world?.group ?? null, o.wireframe)
    if (!world) return true
    const ground = groundOf(world)
    const edges = world.trackEdges ?? null
    if (o.edges && edges) this.addEdges(edges, ground)
    if (o.garmin) this.addPolyline(world.road.cx, world.road.cz, world.road.closed, ground, lineMaterial(COLORS.garmin, 0.95), 'garmin-line')
    if (o.gps) {
      if (lap) this.addPolyline(lap.gpsX, lap.gpsZ, false, ground, lineMaterial(COLORS.gps, 0.9), 'gps')
      if (ghost) this.addPolyline(ghost.gpsX, ghost.gpsZ, false, ground, lineMaterial(COLORS.ghostGps, 0.7), 'ghost-gps')
    }
    if (o.path) {
      if (lap) this.addPath(lap, edges, ground, carHalfWidthM, 1)
      if (ghost) this.addPath(ghost, edges, ground, carHalfWidthM, 0.55)
    }
    if (lap && this.flags.length && (o.edges || o.garmin || o.gps || o.path)) this.addFlags(lap, ground)
    return true
  }

  /** The car against the data at (x, z), `dist` metres along the lap. */
  probe(world: { road: RoadModel; trackEdges?: TrackEdges | null }, lap: LapPath, x: number, z: number, dist: number, carHalfWidthM: number): TrackProbe {
    const road = world.road, edges = world.trackEdges ?? null
    const rs = road.nearestFrom(x, z, road.stationAt(dist), 30)
    const garminOffsetM = road.surface(x, z, rs).o
    let model: TrackProbe['model'] = null, garminFromModelM: number | null = null
    if (edges) {
      const s = edges.nearest(x, z, this.hint)
      if (s >= 0) {
        this.hint = s
        const a = this.across
        edges.across(x, z, s, a)
        model = { offsetM: a.o, halfWidthM: a.half, widthM: 2 * a.half, carEdgeM: Math.abs(a.o) + carHalfWidthM - a.half }
        // Garmin's line at this station, across the model's road.
        edges.across(road.cx[rs], road.cz[rs], s, a)
        garminFromModelM = a.o
      }
    }
    return { dist, model, garminOffsetM, garminFromModelM, shift: { dx: lap.offsetX, dz: lap.offsetZ } }
  }

  dispose() {
    this.clear()
    this.restoreWireframe()
  }

  private clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      const line = child as THREE.Line
      line.geometry?.dispose()
      ;(line.material as THREE.Material | undefined)?.dispose()
    }
  }

  private addLine(positions: number[], material: THREE.LineBasicMaterial, name: string, segments = false, colors?: number[]) {
    if (positions.length < 6) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const line = segments ? new THREE.LineSegments(geometry, material) : new THREE.Line(geometry, material)
    line.name = name
    line.renderOrder = 30
    line.frustumCulled = false
    this.group.add(line)
  }

  private addPolyline(xs: ArrayLike<number>, zs: ArrayLike<number>, closed: boolean, ground: Ground, material: THREE.LineBasicMaterial, name: string) {
    const positions: number[] = []
    for (let i = 0; i < xs.length; i++) positions.push(xs[i], ground(xs[i], zs[i]) + LIFT, zs[i])
    if (closed && xs.length > 2) positions.push(positions[0], positions[1], positions[2])
    this.addLine(positions, material, name)
  }

  private addEdges(edges: TrackEdges, ground: Ground) {
    const left: number[] = [], right: number[] = [], centre: number[] = [], cross: number[] = []
    let along = Infinity
    for (let i = 0; i < edges.n; i++) {
      const cx = edges.cx[i], cz = edges.cz[i], h = edges.half[i]
      const lx = cx + edges.ax[i] * h, lz = cz + edges.az[i] * h, rx = cx - edges.ax[i] * h, rz = cz - edges.az[i] * h
      const ly = ground(lx, lz) + LIFT, ry = ground(rx, rz) + LIFT
      left.push(lx, ly, lz); right.push(rx, ry, rz); centre.push(cx, ground(cx, cz) + LIFT, cz)
      if (i) along += Math.hypot(cx - edges.cx[i - 1], cz - edges.cz[i - 1])
      if (along >= CROSS_EVERY_M) { along = 0; cross.push(lx, ly, lz, rx, ry, rz) }
    }
    if (edges.closed) for (const list of [left, right, centre]) list.push(list[0], list[1], list[2])
    this.addLine(left, lineMaterial(COLORS.edge, 0.95), 'model-edge-left')
    this.addLine(right, lineMaterial(COLORS.edge, 0.95), 'model-edge-right')
    this.addLine(centre, lineMaterial(COLORS.centre, 0.6), 'model-centre')
    this.addLine(cross, lineMaterial(COLORS.cross, 0.45), 'model-cross', true)
  }

  private addPath(lap: LapPath, edges: TrackEdges | null, ground: Ground, carHalf: number, opacity: number) {
    const positions: number[] = [], colors: number[] = []
    const c = new THREE.Color(), a = this.across
    let hint = -1
    for (let i = 0; i < lap.n; i++) {
      const x = lap.x[i], z = lap.z[i]
      positions.push(x, ground(x, z) + LIFT + 0.05, z)
      let hex = COLORS.inside
      if (edges) {
        const s = edges.nearest(x, z, hint)
        if (s >= 0) {
          hint = s
          edges.across(x, z, s, a)
          const over = Math.abs(a.o) + carHalf - a.half
          hex = over > 2 * carHalf ? COLORS.far : over > 0 ? COLORS.over : over > -0.5 ? COLORS.near : COLORS.inside
        }
      }
      c.setHex(hex)
      colors.push(c.r, c.g, c.b)
    }
    this.addLine(positions, lineMaterial(null, opacity), 'car-path', false, colors)
  }

  private addFlags(lap: LapPath, ground: Ground) {
    const posts: number[] = []
    for (const dist of this.flags) {
      const t = lap.timeAtDist(dist)
      if (t == null) continue
      const pose = lap.pose(t)
      const y = ground(pose.x, pose.z)
      posts.push(pose.x, y, pose.z, pose.x, y + 8, pose.z)
    }
    this.addLine(posts, lineMaterial(0xffffff, 0.9), 'flags', true)
  }

  // The track model's own meshes (not the debug lines, grass or the far field) as wireframe.
  private setWireframe(root: THREE.Object3D | null, on: boolean) {
    this.restoreWireframe()
    if (!on || !root) return
    const model = root.getObjectByName('track-model') ?? root.children.find(c => c.name.startsWith('track-model')) ?? null
    const materials = new Set<THREE.Material>()
    ;(model ?? root).traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || /grass|far-field|ground/i.test(mesh.name)) return
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if ('wireframe' in m) materials.add(m)
    })
    for (const m of materials) (m as THREE.MeshBasicMaterial).wireframe = true
    this.wired = [...materials]
  }

  private restoreWireframe() {
    for (const m of this.wired) (m as THREE.MeshBasicMaterial).wireframe = false
    this.wired = []
  }
}

type Ground = (x: number, z: number) => number

// The height the car would sit at: the model's surface, else the road's.
function groundOf(world: { road: RoadModel; surface?: (x: number, z: number, refY: number) => number }): Ground {
  const road = world.road
  let hint = 0
  return (x, z) => {
    hint = road.nearestFrom(x, z, hint, 40)
    const onRoad = road.surface(x, z, hint).h
    const onModel = world.surface ? world.surface(x, z, onRoad) : NaN
    return Number.isFinite(onModel) ? onModel : onRoad
  }
}
