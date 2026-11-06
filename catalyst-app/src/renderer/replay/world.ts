// Builds the replay's world for a track: the road on lidar heights with the
// terrain and aerial photo around it, or, without terrain, the road on the
// lap's own GNSS altitude over a flat ground.

import * as THREE from 'three'
import type { ReplayLap, ReplayTrack, TerrainInfo, TrackModel, TrackModelLayout } from '../../shared/replay'
import { gridHeight, makeFrame, type LocalFrame } from './geo'
import { RoadModel, SHOULDER_M, LAT } from './road'
import { buildEdgeLines, buildKerbs, buildRoadSurface, buildStartLine } from './roadMesh'
import { averageColor, buildGround, buildTerrain, loadImagery } from './terrain'
import { fitEdgesToImage, type EdgeStats } from './edges'
import { disposeObject } from './car'
import { buildTrees } from './trees'
import { interp, unwrapDistance } from './lapPath'
import type { ReplayWorld } from './engine'
import { buildFarField, loadAcTrack } from './acTrack'
import { patchWorldMaterial, type SurfaceKind } from './surfaces'
import { TrackEdges } from './align'
import { releaseWhenUploaded, replayProfile } from './budget'

export interface TerrainData {
  info: TerrainInfo
  grid: Float32Array
  image: Blob | null
  sample: (latLon: Float64Array) => Promise<Float32Array>
}

export interface BuiltWorld extends ReplayWorld {
  frame: LocalFrame
  edges: EdgeStats | null
  /** Shown over the view: why the world is simpler than it should be. */
  note: string | null
  trees: number
}

const HORIZON = new THREE.Color(0xc4d2de)
// The public world's meshes by name, to the shading they take.
const PUBLIC_KINDS: Record<string, SurfaceKind> = {
  'terrain-tile': 'far', 'terrain-skirt': 'far', ground: 'far', verge: 'ground', road: 'road',
  'edge-lines': 'paint', kerbs: 'kerb', 'start-finish': 'paint', tree: 'foliage',
}

export async function buildWorld(track: ReplayTrack, terrain: TerrainData | null, lap: ReplayLap, maxAnisotropy: number, onStep?: (label: string) => void): Promise<BuiltWorld> {
  const frame = makeFrame(track.area)
  const road = new RoadModel(track, frame)
  const group = new THREE.Group()
  group.name = 'world'
  let edges: EdgeStats | null = null
  let note: string | null = null
  let trees = 0
  const textures: THREE.Texture[] = []

  if (terrain) {
    const { info, grid } = terrain
    let pixels: ImageData | null = null
    let texture: THREE.Texture | null = null
    if (terrain.image) {
      onStep?.('Draping the aerial photo')
      try {
        const imagery = await loadImagery(terrain.image, maxAnisotropy)
        texture = imagery.texture; pixels = imagery.pixels
        textures.push(texture)
      } catch (error) { console.warn('[replay] aerial photo unusable', error) }
    }
    if (pixels) {
      onStep?.('Finding the tarmac edges')
      edges = fitEdgesToImage(road, pixels, info.area, frame)
      console.info(`[replay] tarmac edges: found ${(edges.found * 100).toFixed(0)}% · centre ${edges.medianShiftM.toFixed(2)} m left of the mean line (p90 ${edges.p90ShiftM.toFixed(2)} m) · width ${edges.medianWidthM.toFixed(1)} m${edges.applied ? '' : ' · not applied'}`)
    }
    onStep?.('Laying the road on the lidar heights')
    const raster = { width: info.grid.width, height: info.grid.height, area: info.area }
    const points = road.samplePoints(frame)
    const fine = await terrain.sample(points)
    const finite = Array.from(fine).filter(Number.isFinite).sort((a, b) => a - b)
    frame.baseM = Math.round(finite.length ? finite[finite.length >> 1] : info.grid.minM)
    road.setHeights(fine, frame.baseM, (s, k) => gridHeight(grid, raster, points[(s * LAT + k) * 2], points[(s * LAT + k) * 2 + 1]) - frame.baseM)
    onStep?.('Shaping the terrain')
    const built = buildTerrain(info, grid, frame, road, texture)
    group.add(built.mesh)
    const groundColor = averageColor(pixels).lerp(HORIZON, 0.15)
    group.add(buildGround(built.edgeY, groundColor))
    if (pixels) {
      const forest = buildTrees(road, pixels, info, grid, frame)
      if (forest) { group.add(forest.mesh); trees = forest.count }
    }
  } else {
    // No terrain: the road follows the lap's GNSS altitude, smoothed.
    const dist = unwrapDistance(lap.dist, track.totalDistM)
    let held = lap.altM.find(a => a != null) ?? 0
    const alt = lap.altM.map(v => (held = v ?? held))
    const sorted = [...alt].sort((a, b) => a - b)
    frame.baseM = sorted.length ? sorted[sorted.length >> 1] : 0
    const heights = Array.from(road.dist, d => interp(dist, alt, d) - frame.baseM)
    road.setFlatHeights(heights)
    const lowest = Math.min(...heights)
    group.add(buildGround(lowest - 1.5, new THREE.Color(0x56653f)))
    group.add(buildVerge(road))
    note = 'Terrain unavailable: the road follows the lap’s GPS altitude over flat ground.'
  }

  group.add(buildRoadSurface(road, maxAnisotropy))
  group.add(buildEdgeLines(road))
  const kerbs = buildKerbs(road, track.corners)
  if (kerbs) group.add(kerbs)
  group.add(buildStartLine(road))

  // The same sun, sky, haze and wet surface as a track model (surfaces.ts),
  // and the sun's shadows from the trees.
  group.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const kind = PUBLIC_KINDS[mesh.name] ?? 'object'
    mesh.receiveShadow = true
    mesh.castShadow = kind === 'foliage'
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (!m.userData.surfaceKind) patchWorldMaterial(m, kind)
  })

  // The far shadows cover the road and the woods near it, not the whole ground plane.
  const shadowBounds = new THREE.Box3()
  for (let s = 0; s < road.n; s += 8) shadowBounds.expandByPoint(new THREE.Vector3(road.cx[s], road.heights[s * LAT + (LAT >> 1)] || 0, road.cz[s]))
  shadowBounds.expandByVector(new THREE.Vector3(250, 40, 250))
  // A constrained device keeps no CPU copy of what is on the GPU (budget.ts).
  if (replayProfile().lean) releaseWhenUploaded(group, true)
  return {
    group, road, frame, edges, note, trees, shadowBounds,
    // The laps line up with the road as drawn: its edges in the photo, else Garmin's line ± half the width.
    trackEdges: TrackEdges.fromRoad(road),
    horizon: HORIZON.clone(),
    dispose: () => {
      disposeObject(group)
      for (const texture of textures) {
        const image = texture.image as ImageBitmap | undefined
        texture.dispose()
        image?.close?.()
      }
    },
  }
}

export interface ModelSource {
  model: TrackModel
  layout: TrackModelLayout
  getFile: (id: string, file: string) => Promise<ArrayBuffer>
}

/**
 * The world on a 3D track model (a converted sim track): the model placed
 * by its georef, the road's heights (the racing lines, the chase camera)
 * and the cars on its surface, and the lidar terrain and aerial photo as
 * the far field around it. The generated road, edges and kerbs stay out:
 * the model has its own.
 */
export async function buildModelWorld(track: ReplayTrack, terrain: TerrainData | null, source: ModelSource, maxAnisotropy: number, onStep?: (label: string) => void): Promise<BuiltWorld> {
  const frame = makeFrame(track.area)
  const road = new RoadModel(track, frame)
  const group = new THREE.Group()
  group.name = 'world'
  const textures: THREE.Texture[] = []
  const model = await loadAcTrack({ ...source, frame, maxAnisotropy, onStep })
  try {
    onStep?.('Laying the lap on the track model')
    // The base height: the model's surface along the line, so world numbers stay small.
    const centre: number[] = []
    let ref: number | null = null
    for (let s = 0; s < road.n; s += 4) {
      const h = model.surface.heightAt(road.cx[s], road.cz[s], ref)
      if (Number.isFinite(h)) { centre.push(h); ref = h }
    }
    if (centre.length < road.n / 8) throw new Error('the track model does not cover this layout’s line')
    centre.sort((a, b) => a - b)
    frame.baseM = Math.round(centre[centre.length >> 1])
    model.place(frame)
    road.setHeightsFromSurface((x, z, refY) => model.surface.heightAt(x, z, refY))
    group.add(model.group)

    let groundColor = new THREE.Color(0x56653f)
    let groundY = Math.min(...Array.from(road.heights).filter(Number.isFinite)) - 8
    if (terrain) {
      onStep?.('Shaping the terrain around the track')
      let texture: THREE.Texture | null = null, pixels: ImageData | null = null
      if (terrain.image) {
        try {
          // Only its colour is needed here: a constrained device reads a small copy.
          const imagery = await loadImagery(terrain.image, maxAnisotropy, replayProfile().lean ? 'preview' : 'full')
          texture = imagery.texture; pixels = imagery.pixels
          textures.push(texture)
        } catch (error) { console.warn('[replay] aerial photo unusable', error) }
      }
      group.add(buildFarField(terrain.info, terrain.grid, frame, model, texture))
      groundColor = averageColor(pixels)
      groundY = Math.min(groundY, terrain.info.grid.minM - frame.baseM - 2)
    }
    // Turf-dark (as the model's own ground): it shows through slivers between
    // the model's meshes, where a light colour reads as hairlines.
    const ground = buildGround(groundY, groundColor.multiplyScalar(0.62))
    patchWorldMaterial(ground.material as THREE.Material, 'ground')
    group.add(ground)
    console.info(`[replay] track model ${source.model.id}: ${(model.triangles / 1e6).toFixed(2)} M triangles, ${model.surface.triangleCount.toLocaleString()} on the surface index`)
    // A constrained device keeps no CPU copy of what is on the GPU (budget.ts); the
    // surface index above has its own.
    if (replayProfile().lean) releaseWhenUploaded(group, true)
  } catch (error) {
    model.dispose()
    for (const texture of textures) texture.dispose()
    throw error
  }

  return {
    group, road, frame, edges: null, note: null, trees: 0,
    // The laps line up with the model's own road edges (its track.json), else Garmin's line ± half the width.
    trackEdges: source.layout.edges?.length ? TrackEdges.fromModel(source.layout.edges, model.matrix) : TrackEdges.fromRoad(road),
    // The model's ground and roads, and the trees and stands on them.
    shadowBounds: model.surface.bounds.clone().expandByVector(new THREE.Vector3(10, 30, 10)),
    horizon: HORIZON.clone(),
    surface: (x, z, refY) => model.surface.heightAt(x, z, refY),
    dispose: () => {
      group.remove(model.group)
      model.dispose()
      disposeObject(group)
      for (const texture of textures) {
        const image = texture.image as ImageBitmap | undefined
        texture.dispose()
        image?.close?.()
      }
    },
  }
}

/** Without terrain: grass either side of the road, sloping down to the ground. */
function buildVerge(road: RoadModel): THREE.Mesh {
  const rows = road.closed ? road.n + 1 : road.n
  const offsets = (s: number) => [-road.right[s] - 40, -road.right[s] - SHOULDER_M, road.left[s] + SHOULDER_M, road.left[s] + 40]
  const pos = new Float32Array(rows * 4 * 3)
  for (let row = 0; row < rows; row++) {
    const s = row % road.n
    offsets(s).forEach((o, k) => {
      const [x, z] = road.pointAt(s, o)
      const y = road.heightAcross(s, o) - (k === 0 || k === 3 ? 1.2 : 0.12)
      pos.set([x, y, z], (row * 4 + k) * 3)
    })
  }
  const index: number[] = []
  for (let row = 0; row < rows - 1; row++) for (const k of [0, 1, 2]) {
    const a = row * 4 + k, b = a + 1, c = a + 4, d = c + 1
    index.push(a, b, c, b, d, c)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0x5b6b3f, side: THREE.DoubleSide }))
  mesh.name = 'verge'
  return mesh
}
