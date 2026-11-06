// The 3D replay engine: a three.js scene with the world (terrain, road), the
// lap's car and an optional ghost, driver and chase cameras, and a clock in
// lap time. Framework-free; the Replay page wraps it and draws the overlays
// from the state it publishes each frame.

import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { CarModelFit, CarPreset } from '../../shared/replay'
import { LapPath, type LapPose } from './lapPath'
import type { RoadModel } from './road'
import { applyFit, blobShadow, buildPlaceholder, disposeGeometry, disposeObject, fittedModel, ghostCopy, ghostMaterial, nameTag, tintCar } from './car'
import { CarMotion, type GroundAt } from './motion'
import { clampOffset, framingDistance, frameBoth, offsetFor, sideBySideOffset } from './compare'
import { rigModelWheels } from './wheels'
import { REPLAY_DEBUG } from './debug'
import { buildLapLine } from './roadMesh'
import { LensPass } from './lens'
import { Atmosphere, installToneMapping } from './atmosphere'
import { SHADOW_QUALITY, markCarCasters } from './shadows'
import { ensureDetailTextures } from './surfaces'
import { GrassField, GRASS_QUALITY } from './grass'
import type { Look as WeatherLook } from './weather'
import { fitToRoad, type RoadFit, type TrackEdges } from './align'
import { anyReleased, releaseUploaded, releaseWhenUploaded, replayProfile } from './budget'
import { configureKtx2 } from './ktx2'
import { adapt, FrameWindow, type Ladder } from './resolution'
import { removeFrontHalves, splitDoubleSided, transparentSort } from './twoSided'

/** 'both' keeps your car and the compared car in frame (chase when there is none). */
export type ReplayView = 'driver' | 'garmin' | 'chase' | 'both' | 'orbit'

/**
 * Another driver's car, raced in the ghost's place: solid, in its own model,
 * fit and dynamics (its preset), tinted and tagged in its colour.
 */
export interface RivalCar {
  preset: CarPreset
  /** A fitted .glb's root (parsed for this car alone), or null for the placeholder. */
  model: THREE.Object3D | null
  fit: CarModelFit | null
  color: THREE.ColorRepresentation
  /** On its tag, e.g. the driver's name. */
  name: string
}

/** The compared car (the ghost or another driver's), each frame. */
export interface ComparedState {
  /** Its lap time: yours plus the offset (may run below 0 or past its lap: it waits at either end). */
  timeMs: number
  durationMs: number
  offsetMs: number
  /** Where it is, when it is on track. */
  pose: LapPose | null
  /** Its metres along the track ahead of yours (negative: behind), when on track. */
  aheadM: number | null
}

export interface ReplayWorld {
  group: THREE.Group
  road: RoadModel
  /**
   * A 3D track model's surface height (local y) near a reference height,
   * NaN off it: the cars sit on it wheel by wheel (kerbs and all).
   */
  surface?: (x: number, z: number, refY: number) => number
  /** Where the world has things that cast shadows (the far shadow map's extent); default: its group's bounds. */
  shadowBounds?: THREE.Box3
  /** Sky-matched colour for fog and the far ground. */
  horizon: THREE.Color
  /** The road's edges as drawn, for lining the laps' GPS up with it (align.ts); none: laps stay as recorded. */
  trackEdges?: TrackEdges | null
  dispose: () => void
}

/** How the lap and the ghost line up with the road (null without one), and whether the shift is on. */
export interface Alignment {
  on: boolean
  lap: RoadFit | null
  ghost: RoadFit | null
}

export interface FrameState {
  timeMs: number
  durationMs: number
  playing: boolean
  rate: number
  pose: LapPose
  /** Main lap time minus the ghost's at the same distance (+ = behind), ms; the offset does not change it. */
  gapMs: number | null
  /** The compared car, or null without one. */
  compared: ComparedState | null
  view: ReplayView
  fps: number
  /** The camera is dragged away from its default view (show a reset). */
  lookActive: boolean
  /** The graphics level drawn now (Auto picks one). */
  quality: GraphicsLevel
}

const GHOST_COLOR = 0x7dd3fc
const CHASE_BACK = 6.6, CHASE_UP = 2.1
// The car reflects the same sky, woods and ground that light the world (atmosphere.ts).
const CAR_ENV_INTENSITY = 1
const TURN_AROUND = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const X_AXIS = new THREE.Vector3(1, 0, 0)
const DRIVER_LOOK_DOWN_DEG = 4
// How far the Garmin lens bends straight lines: 0 rectilinear, 1 fisheye.
const GARMIN_BARREL = 0.65
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const DEG = Math.PI / 180
/** Graphics levels; Low is a constrained device's (budget.ts): no grass, small shadows, a plain lens. */
export type GraphicsLevel = 'high' | 'medium' | 'low'
// The Garmin lens's drawn size (× the screen) and multisampling, by graphics level.
const LENS_QUALITY: Record<GraphicsLevel, [number, number]> = { high: [1.1, 4], medium: [1, 2], low: [1, 0] }
// A new car body waits this long at most for its shaders before it shows (prewarmBody).
const BODY_WARM_MAX_MS = 500
// The inside cameras ride a steady mount, not the car's every bump: its
// height, pitch and roll come from the ground this far ahead of and behind
// the car, then a light spring (with lead, so it never lags on a climb).
const MOUNT_BASE_M = 6
const MOUNT_SPRING_S = 0.12

// Looking around by dragging: from the seat the head turns (relative to the
// car, so it stays turned through corners); chasing, the camera orbits the
// car and the wheel or a pinch sets its distance. Each view keeps its own.
type LookView = 'chase' | 'driver' | 'garmin' | 'both'
interface Look { yaw: number; pitch: number; dist: number }
const CHASE_DIST = Math.hypot(CHASE_BACK, CHASE_UP), CHASE_PITCH = Math.atan2(CHASE_UP, CHASE_BACK)
const CHASE_MIN_DIST = 3, CHASE_MAX_DIST = 40
const HEAD_YAW = 160 * DEG, HEAD_PITCH = 70 * DEG, ORBIT_PITCH: [number, number] = [5 * DEG, 80 * DEG]
// Both cars: the drag turns about them and tilts within this of the framing's pitch; the wheel scales the distance.
const BOTH_TILT: [number, number] = [-0.25, 0.6], BOTH_SCALE: [number, number] = [0.4, 3]
// A press that moves less than this is a click, not a drag.
const DRAG_SLOP_PX = 5
const lookDefault = (view: LookView): Look => (view === 'chase' ? { yaw: 0, pitch: CHASE_PITCH, dist: CHASE_DIST } : view === 'both' ? { yaw: 0, pitch: 0, dist: 1 } : { yaw: 0, pitch: 0, dist: 0 })
// Another driver's car: its colour over its paint, this strong; this opaque while it overlaps yours.
const RIVAL_TINT = 0.07
const RIVAL_OVERLAP_OPACITY = 0.4

// A car's solid materials, made able to fade (blended, still writing depth,
// so at opacity 1 they draw as before) without a recompile when they do.
// Its shadows are marked first: blended parts would otherwise count as glass.
function seeThrough(root: THREE.Object3D): THREE.Material[] {
  markCarCasters(root)
  const out = new Set<THREE.Material>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m.transparent || out.has(m)) continue
      m.transparent = true
      m.depthWrite = true
      m.needsUpdate = true
      out.add(m)
    }
  })
  return [...out]
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface CarRig {
  root: THREE.Group
  body: THREE.Object3D | null
  shadow: THREE.Mesh
  hint: number
  pose: LapPose
  /** Rolling, steering wheels and the body on its springs; null for a model whose wheels were not found. */
  motion: CarMotion | null
  /** The car it is: its size and dynamics, and a model's fit (null: the placeholder's, from the preset). */
  preset: CarPreset | null
  fit: CarModelFit | null
  /** Its resting height on the ground at a lap time, for its springs. */
  ground: GroundAt
  /** A new body kept hidden while its shaders compile (prewarmBody). */
  warming: THREE.Object3D | null
}

// A car body's see-through double-sided parts drawn as two meshes, back and
// front faces (twoSided.ts): the same draws as three's two passes, without
// its program lookups each frame. Before freeing a body the front halves
// come out (they share their parents' geometry) and their materials go.
function freeBody(root: THREE.Object3D) {
  for (const material of removeFrontHalves(root)) material.dispose()
  disposeObject(root)
}

// Finds a fitted model's wheels and rigs them (wheels.ts); without them they stay still and the body level.
function rigWheels(fitted: THREE.Group, fit: CarModelFit, which: string) {
  const wheels = rigModelWheels(fitted, { pattern: fit.wheelPartsPattern })
  if (!wheels.ok) console.warn(`[replay] the ${which}'s model's wheels were not found (${wheels.reason}); they stay still and the body level.`)
  else if (REPLAY_DEBUG) console.info(`[replay] ${which} wheels by ${wheels.method}: ${wheels.wheels.map(w => `${w.corner} r ${w.radiusM.toFixed(3)} m at [${w.centreM.join(', ')}] ← ${w.parts.join(', ')}`).join(' · ')}`)
}

/**
 * The canvas and its WebGL 2 context, made here so the reversed depth
 * buffer's extension is checked on the context the renderer uses (not on a
 * throwaway one). The attributes are those WebGLRenderer asks for itself:
 * alpha on (its own `alpha` option, off, only sets the clear alpha, which
 * the constructor sets to match), and our antialias and power preference.
 */
function createContext(): { canvas: HTMLCanvasElement; context: WebGL2RenderingContext | null; reversedDepth: boolean } {
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  let context: WebGL2RenderingContext | null = null
  try {
    context = canvas.getContext('webgl2', {
      alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
    })
  } catch { context = null }
  let reversedDepth = false
  try { reversedDepth = !!context?.getExtension('EXT_clip_control') } catch { /* without it */ }
  return { canvas, context, reversedDepth }
}

export class ReplayEngine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 12000)
  /** Sky, sun, shadows, haze, environment and exposure for the session's weather. */
  readonly atmosphere: Atmosphere
  private shadowedBodies = new WeakSet<THREE.Object3D>()
  private quality: GraphicsLevel = replayProfile().autoGraphics
  private graphics: 'auto' | GraphicsLevel = 'auto'
  private world: ReplayWorld | null = null
  private lap: LapPath | null = null
  private ghost: LapPath | null = null
  private car: CarRig
  private ghostCar: CarRig
  private racingLine: THREE.Mesh | null = null
  private ghostLine: THREE.Mesh | null = null
  private showRacingLine = true
  private showGhostLine = true
  private alignToTrack = true
  // Each lap's fit to a world's road, computed once (a lap belongs to one world's frame).
  private roadFits = new WeakMap<LapPath, { edges: TrackEdges; fit: RoadFit }>()
  private alignListeners = new Set<(alignment: Alignment) => void>()
  private preset: CarPreset | null = null
  private fit: CarModelFit | null = null
  private model: THREE.Object3D | null = null
  private paint: THREE.ColorRepresentation = 0xff5e3a
  private ghostShape: THREE.Material = ghostMaterial(GHOST_COLOR)
  // The ghost's body: a translucent copy of your car (sharing a model's
  // geometry, or a placeholder of its own geometry), or another driver's
  // car, solid, owning everything it is made of.
  private ghostOwns: 'none' | 'geometry' | 'all' = 'none'
  private rival: { color: THREE.Color; name: string; model: THREE.Object3D | null } | null = null
  private rivalTag: THREE.Sprite | null = null
  private rivalMarked = true
  // The other car's solid materials (dithered alpha, so its opacity changes
  // without a recompile) and how see-through it is now: it fades while it
  // overlaps yours, so two lines through the same spot both stay visible.
  private rivalMaterials: THREE.Material[] = []
  private rivalFade = 1
  // The compared car's lap time is yours plus this (compare.ts).
  private ghostOffsetMs = 0
  // The "Both cars" camera: its framing's offset from your car, distance and pitch, eased.
  private both = { ready: false, offset: new THREE.Vector3(), dist: 0, pitch: 0 }
  private orbit: OrbitControls | null = null
  private lens: LensPass | null = null
  private resizeObserver: ResizeObserver
  private listeners = new Set<(state: FrameState) => void>()
  private frameHandle = 0
  private lastFrame = 0
  private fpsWindow: number[] = []
  private timeMs = 0
  private playing = false
  private rate = 1
  private view: ReplayView = 'chase'
  private renderFrames = 2
  private chasePos = new THREE.Vector3()
  private chaseLook = new THREE.Vector3()
  private chaseDir = new THREE.Vector3(0, 0, -1)
  private chaseHeight = 0
  private chaseReady = false
  private mount = { ready: false, y: 0, target: 0, vel: 0, quat: new THREE.Quaternion() }
  // The highest resolution that held the frame rate in this world.
  private ceiling = 2
  // No more steps down in this world (a step that did not help), and the step being judged (resolution.ts).
  private capped = false
  private trial: Ladder['trial'] = null
  private lost = false
  private disposed = false
  private looks: Record<LookView, { target: Look; now: Look }> = {
    chase: { target: lookDefault('chase'), now: lookDefault('chase') },
    driver: { target: lookDefault('driver'), now: lookDefault('driver') },
    garmin: { target: lookDefault('garmin'), now: lookDefault('garmin') },
    both: { target: lookDefault('both'), now: lookDefault('both') },
  }
  private pointers = new Map<number, { x: number; y: number }>()
  private drag: { id: number; x0: number; y0: number; moved: boolean } | null = null
  private pinch: { spread: number; dist: number } | null = null
  private lastTap = { t: 0, x: 0, y: 0 }
  // Resolution adapts to hold the frame rate on slower GPUs.
  private pixelRatio = Math.min(replayProfile().maxPixelRatio, window.devicePixelRatio || 1)
  private frameWindow = new FrameWindow()
  private raiseAfter = 0
  onContextLost?: (lost: boolean) => void
  /**
   * After a lost context: what lost its CPU copy once on the GPU (a
   * constrained device, budget.ts) cannot be uploaded again, so the engine
   * stays stopped and the page builds a new one.
   */
  needsRebuild = false
  onEnded?: () => void

  constructor(private container: HTMLElement) {
    const { canvas: element, context, reversedDepth: reversedDepthBuffer } = createContext()
    this.renderer = new THREE.WebGLRenderer({ canvas: element, ...(context ? { context: context as unknown as WebGLRenderingContext } : {}), antialias: true, powerPreference: 'high-performance', reversedDepthBuffer, logarithmicDepthBuffer: !reversedDepthBuffer })
    configureKtx2(this.renderer)
    this.renderer.setPixelRatio(this.pixelRatio)
    // Cleared opaque, as with a context of three's own (its alpha option off; createContext). Its
    // transparent sort, keeping a split mesh's halves together (twoSided.ts).
    this.renderer.setClearAlpha(1)
    this.renderer.setTransparentSort(transparentSort)
    installToneMapping()
    this.renderer.toneMapping = THREE.CustomToneMapping
    this.renderer.toneMappingExposure = 0.7
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    const canvas = this.renderer.domElement
    canvas.className = 'replay-canvas'
    container.appendChild(canvas)
    canvas.addEventListener('webglcontextlost', this.contextLost)
    canvas.addEventListener('webglcontextrestored', this.contextRestored)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('lostpointercapture', this.onPointerUp)
    canvas.addEventListener('dblclick', this.onDoubleClick)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)

    ensureDetailTextures(this.renderer.capabilities.getMaxAnisotropy())
    this.atmosphere = new Atmosphere(this.renderer, this.scene)

    const rig = (): CarRig => {
      const root = new THREE.Group()
      const shadow = blobShadow(4, 1.8)
      root.add(shadow)
      root.visible = false
      this.scene.add(root)
      const rig: CarRig = { root, body: null, shadow, hint: 0, pose: {} as LapPose, motion: null, preset: null, fit: null, ground: (lap, timeMs) => this.restingHeight(rig, lap, timeMs), warming: null }
      return rig
    }
    this.car = rig()
    this.ghostCar = rig()
    this.ghostCar.shadow.visible = false

    this.resizeObserver = new ResizeObserver(() => { this.measureAfresh(); this.resize() })
    this.resizeObserver.observe(container)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.resize()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  // A tab or app switch is not a slow frame: the frame rate is measured afresh.
  private onVisibility = () => { this.frameWindow.reset() }

  // Another stage size or view costs differently: no window spans the change,
  // and a step down being judged is kept (the frame rates either side do not compare).
  private measureAfresh() {
    this.frameWindow.reset()
    this.trial = null
  }

  /** The session's weather and light (weather.ts lookFor). */
  setLook(look: WeatherLook) {
    this.atmosphere.apply(look)
    this.wind = [look.windToDeg, look.windMps]
    this.grass?.setWind(...this.wind)
    this.invalidate()
  }

  /** Grass blades on a track model's turf (grass.ts); none on public data. */
  private grass: GrassField | null = null
  private wind: [number, number] = [70, 2]

  /**
   * Grass, shadows and detail: 'high', 'medium' for slower graphics, 'low'
   * for a small memory budget, or 'auto' (high, stepping down when the
   * frame rate drops at a modest resolution, see adaptResolution; low on a
   * constrained device).
   */
  setGraphics(choice: 'auto' | GraphicsLevel) {
    this.graphics = choice
    this.setQuality(choice === 'auto' ? replayProfile().autoGraphics : choice)
    if (choice === 'auto') { this.ceiling = 2; this.capped = false }
    this.measureAfresh()
    // Below 1 × resolution only on Auto (resolution.ts).
    if (choice !== 'auto' && this.pixelRatio < 1) { this.pixelRatio = 1; this.resize() }
  }

  private setQuality(quality: GraphicsLevel) {
    this.quality = quality
    this.atmosphere.setQuality(SHADOW_QUALITY[quality])
    this.syncGrass()
    this.lens?.setQuality(...LENS_QUALITY[quality])
    this.invalidate()
    this.publish()
  }

  // The Garmin lens draws the scene into a target of its own (lens.ts), made when first wanted.
  private ensureLens(): LensPass {
    if (!this.lens) {
      this.lens = new LensPass()
      this.lens.setQuality(...LENS_QUALITY[this.quality])
    }
    return this.lens
  }

  /**
   * Compile the scene's shaders without drawing, in parallel where the
   * browser can (compileAsync, KHR_parallel_shader_compile), for the screen
   * or for the Garmin lens: its linear target keys a second program for
   * every material (lens.ts), which its first frame would otherwise compile
   * while the page waits.
   */
  private compileScene(target: 'screen' | 'lens'): Promise<unknown> {
    if (this.disposed || this.lost) return Promise.resolve()
    try {
      return target === 'lens' ? this.ensureLens().compile(this.renderer, this.scene) : this.renderer.compileAsync(this.scene, this.camera)
    } catch (error) { return Promise.reject(error) }
  }

  // When the page is idle (no sooner than after the frame being drawn).
  private whenIdle(task: () => void) {
    const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback
    if (idle) idle(task, { timeout: 2000 })
    else setTimeout(task, 200)
  }

  /**
   * A new car body after the scene was prepared: hidden (placeCars) while its
   * shaders compile in parallel, so no frame waits on them; shown when they
   * are ready, after BODY_WARM_MAX_MS at the latest. Where the browser cannot
   * compile in parallel there is nothing to wait for: it shows at once.
   */
  private prewarmBody(rig: CarRig) {
    const body = rig.body
    rig.warming = null
    if (!body || this.disposed || this.lost) return
    let pending: Promise<unknown>
    try {
      // For the view it is first drawn in.
      pending = this.view === 'garmin' ? this.ensureLens().compile(this.renderer, this.scene, body) : this.renderer.compileAsync(body, this.camera, this.scene)
    } catch { return }
    if (!this.renderer.extensions.has('KHR_parallel_shader_compile')) return
    rig.warming = body
    const show = () => {
      if (rig.warming !== body) return
      rig.warming = null
      this.invalidate()
    }
    pending.then(show, show)
    setTimeout(show, BODY_WARM_MAX_MS)
  }

  // Grass on a track model's turf at a level that has it (none on Low).
  private syncGrass() {
    const quality = GRASS_QUALITY[this.quality]
    if (!this.world?.surface || !quality) {
      this.grass?.dispose()
      this.grass = null
      return
    }
    if (this.grass) { this.grass.setQuality(quality); return }
    this.grass = new GrassField(this.renderer, this.world.group, quality)
    this.grass.setWind(...this.wind)
    this.scene.add(this.grass.group)
  }

  // The environment map is the sky over the ground and woods round the
  // track (atmosphere.ts), so the car reflects what it drives under.
  private refreshReflections() {
    for (const rig of [this.car, this.ghostCar]) if (rig?.body) this.reflectEnvironment(rig.body)
  }

  private reflectEnvironment(root: THREE.Object3D) {
    const env = this.atmosphere.environment
    root.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const m = material as THREE.MeshStandardMaterial
        if (m.isMeshStandardMaterial && m.envMap !== env) { m.envMap = env; m.envMapIntensity = CAR_ENV_INTENSITY; m.needsUpdate = true }
      }
    })
  }

  private contextLost = (event: Event) => {
    event.preventDefault()
    this.lost = true
    cancelAnimationFrame(this.frameHandle)
    this.onContextLost?.(true)
  }

  private contextRestored = () => {
    // three (its handler runs first) set its clear alpha again from the context's attributes (createContext).
    this.renderer.setClearAlpha(1)
    // Textures or geometry without their CPU copy cannot be uploaded again (budget.ts).
    if (anyReleased()) {
      this.needsRebuild = true
      this.onContextLost?.(false)
      return
    }
    this.lost = false
    this.atmosphere.invalidate()
    this.grass?.invalidate()
    this.onContextLost?.(false)
    this.invalidate()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight)
    this.pixelRatio = Math.min(this.pixelRatio, Math.min(replayProfile().maxPixelRatio, window.devicePixelRatio || 1))
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.fov = this.fieldOfView()
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  /** Render the next few frames (after a change while paused). */
  invalidate(frames = 2) {
    this.renderFrames = Math.max(this.renderFrames, frames)
  }

  /**
   * Get the scene onto the GPU before it is shown: place the cars and the
   * camera, compile every material and draw a couple of frames (which
   * uploads the textures), so the view fades in finished, without stalls.
   */
  async prepare(): Promise<void> {
    if (this.disposed || this.lost) return
    this.placeCars()
    this.placeCamera(0)
    // The sky's environment and the shadows first: the materials compile with them.
    this.prepareLight(performance.now())
    // For the view it opens on: the Garmin lens's programs, or the screen's.
    const first = this.view === 'garmin' ? 'lens' : 'screen'
    const bodies = [this.car.body, this.ghostCar.body]
    try { await this.compileScene(first) } catch { /* drawing compiles what is left */ }
    // The bodies in the scene were compiled with it: they show in the frames that upload their textures.
    for (const rig of [this.car, this.ghostCar]) if (rig.warming && bodies.includes(rig.warming)) rig.warming = null
    this.invalidate(3)
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    // Once shown, the other set when idle, so a switch to or from the Garmin view does not stall.
    this.whenIdle(() => { void this.compileScene(first === 'lens' ? 'screen' : 'lens').catch(() => {}) })
  }

  subscribe(listener: (state: FrameState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state())
    return () => this.listeners.delete(listener)
  }

  // ── Content ──────────────────────────────────────────────────────────────

  setWorld(world: ReplayWorld | null) {
    if (this.world) { this.scene.remove(this.world.group); this.world.dispose() }
    this.world = world
    if (world) this.scene.add(world.group)
    // The world's materials haze themselves (surfaces.ts); the far shadows cover its extent.
    this.scene.fog = null
    this.atmosphere.setWorld(world?.group ?? null, world ? world.shadowBounds ?? new THREE.Box3().setFromObject(world.group) : null)
    this.grass?.dispose()
    this.grass = null
    this.syncGrass()
    this.applyAlignment()
    this.rebuildLines()
    this.chaseReady = this.mount.ready = false
    // A new world: the resolution ladder starts afresh (resolution.ts).
    this.ceiling = 2
    this.capped = false
    this.measureAfresh()
    this.invalidate()
  }

  setLap(lap: LapPath | null) {
    // Another lap of yours starts the compared car on its own clock again.
    if (lap !== this.lap) this.ghostOffsetMs = 0
    this.lap = lap
    this.mount.ready = false
    this.timeMs = Math.min(this.timeMs, lap?.durationMs ?? 0)
    this.car.hint = 0
    this.applyAlignment()
    this.rebuildLines()
    this.chaseReady = false
    this.invalidate()
  }

  setGhost(ghost: LapPath | null) {
    if (ghost !== this.ghost) this.ghostOffsetMs = 0
    this.ghost = ghost
    this.ghostCar.hint = 0
    this.applyAlignment()
    this.rebuildLines()
    this.invalidate()
  }

  /**
   * Line the laps' GPS up with the road (on, the default) or show it as
   * recorded. Each lap (and the ghost) is shifted as a whole by its own fit
   * (align.ts fitToRoad); the car, its line and the ghost's all read the
   * shifted positions. Costs a fit per lap, once, and a rebuild of the lines.
   */
  setAlign(on: boolean) {
    if (on === this.alignToTrack) return
    this.alignToTrack = on
    this.applyAlignment()
    this.rebuildLines()
    this.chaseReady = this.mount.ready = false
    this.invalidate()
  }

  alignment(): Alignment {
    return { on: this.alignToTrack, lap: this.roadFit(this.lap), ghost: this.roadFit(this.ghost) }
  }

  /**
   * Called whenever the lap's or the ghost's shift changes (a new lap, ghost
   * or world, the toggle), after the positions have moved: overlays built
   * from lat/lon with LapPath.toLocal rebuild here. Returns an unsubscribe.
   */
  onAlignment(listener: (alignment: Alignment) => void): () => void {
    this.alignListeners.add(listener)
    return () => this.alignListeners.delete(listener)
  }

  private roadFit(lap: LapPath | null): RoadFit | null {
    const edges = this.world?.trackEdges
    if (!lap || !edges) return null
    const known = this.roadFits.get(lap)
    if (known?.edges === edges) return known.fit
    const fit = fitToRoad(lap.gpsX, lap.gpsZ, edges)
    this.roadFits.set(lap, { edges, fit })
    return fit
  }

  private applyAlignment() {
    let changed = false
    for (const lap of [this.lap, this.ghost]) {
      if (!lap) continue
      const fit = this.alignToTrack ? this.roadFit(lap) : null
      if (lap.setOffset(fit?.applied ? fit.dx : 0, fit?.applied ? fit.dz : 0)) changed = true
    }
    if (changed && this.alignListeners.size) {
      const alignment = this.alignment()
      for (const listener of this.alignListeners) listener(alignment)
    }
  }

  setLines(racing: boolean, ghost: boolean) {
    this.showRacingLine = racing; this.showGhostLine = ghost
    if (this.racingLine) this.racingLine.visible = racing
    if (this.ghostLine) this.ghostLine.visible = ghost
    this.invalidate()
  }

  private rebuildLines() {
    for (const line of [this.racingLine, this.ghostLine]) if (line) { this.scene.remove(line); disposeObject(line) }
    this.racingLine = this.ghostLine = null
    const road = this.world?.road
    if (!road) return
    if (this.lap) {
      this.racingLine = buildLapLine(this.lap, road, null, [this.lap.minSpeed, this.lap.maxSpeed], 0.26, this.world?.surface)
      this.racingLine.visible = this.showRacingLine
      this.scene.add(this.racingLine)
    }
    if (this.ghost) {
      // Another driver's line in their colour, a touch wider; a ghost's in cyan.
      this.ghostLine = buildLapLine(this.ghost, road, this.rival ? this.rival.color.clone() : new THREE.Color(GHOST_COLOR), [0, 1], this.rival ? 0.2 : 0.16, this.world?.surface)
      // A see-through ribbon on the ground, double-sided: one pass draws the
      // same as three's two (back faces, then front), without a program lookup each.
      ;(this.ghostLine.material as THREE.Material).forceSinglePass = true
      this.ghostLine.visible = this.showGhostLine
      this.scene.add(this.ghostLine)
    }
  }

  /**
   * The car's look: a fitted .glb (model + fit) or the placeholder from the
   * preset. The ghost takes the same shape.
   */
  setCar(preset: CarPreset, model: THREE.Object3D | null, fit: CarModelFit | null, paint: THREE.ColorRepresentation = 0xff5e3a) {
    this.clearCars(model)
    this.preset = preset
    this.model = model
    this.fit = fit
    this.paint = paint
    this.car.preset = preset
    this.car.fit = model ? fit : null
    if (model && fit) {
      const fitted = fittedModel(model, fit)
      // Before the ghost's copy, which takes the rig along.
      if (!fit.staticWheels) rigWheels(fitted, fit, 'car')
      // After the rig (which moves and cuts meshes), before the ghost's copy (which drops the halves).
      splitDoubleSided(fitted)
      this.car.body = fitted
    } else {
      this.car.body = buildPlaceholder(preset, paint, null)
    }
    this.car.root.add(this.car.body)
    // A ghost of yours takes the same shape; another driver's car keeps its own.
    if (!this.rival) this.buildGhostBody()
    this.findMotion()
    this.reflectEnvironment(this.car.body)
    this.car.shadow.scale.set(preset.widthM / 1.8, 1, preset.lengthM / 4)
    this.applyView()
    this.prewarmBody(this.car)
    this.invalidate()
  }

  // A ghost of yours shares the ghost material (and a model's geometry), so
  // only what each body owns is freed.
  private clearCars(nextModel: THREE.Object3D | null = null) {
    if (!this.rival) this.clearGhostBody()
    if (this.car.body) this.car.root.remove(this.car.body)
    if (this.model) { if (this.model !== nextModel) freeBody(this.model) }
    else if (this.car.body) freeBody(this.car.body)
    this.car.body = null
    this.car.motion = null
    this.car.warming = null
  }

  private clearGhostBody() {
    const body = this.ghostCar.body
    if (body) {
      this.ghostCar.root.remove(body)
      if (this.ghostOwns === 'all') freeBody(body)
      else if (this.ghostOwns === 'geometry') disposeGeometry(body)
    }
    this.ghostCar.warming = null
    if (this.rivalTag) {
      this.rivalTag.removeFromParent()
      this.rivalTag.material.map?.dispose()
      this.rivalTag.material.dispose()
      this.rivalTag = null
    }
    this.ghostCar.body = null
    this.ghostCar.motion = null
    this.ghostOwns = 'none'
    this.rivalMaterials = []
  }

  // The ghost's body: another driver's car (this.rival), or a translucent
  // copy of yours (nothing until your car is in).
  private buildGhostBody() {
    const rig = this.ghostCar, rival = this.rival
    if (rival) {
      const preset = rig.preset!
      let body: THREE.Object3D
      if (rival.model && rig.fit) {
        body = fittedModel(rival.model, rig.fit)
        if (!rig.fit.staticWheels) rigWheels(body as THREE.Group, rig.fit, 'other car')
      } else body = buildPlaceholder(preset, rival.color, null)
      tintCar(body, rival.color, this.rivalMarked ? RIVAL_TINT : 0)
      this.reflectEnvironment(body)
      const solid = seeThrough(body)
      // Its double-sided parts are see-through now too: split, both halves fading together.
      const fronts = splitDoubleSided(body)
      this.rivalMaterials = solid.flatMap(m => (fronts.has(m) ? [m, fronts.get(m)!] : [m]))
      this.shadowedBodies.add(body)
      this.rivalFade = 1
      rig.body = body
      this.ghostOwns = 'all'
      this.rivalTag = nameTag(rival.name, rival.color)
      this.rivalTag.position.y = preset.heightM + 0.45
      this.rivalTag.visible = this.rivalMarked
      rig.root.add(this.rivalTag)
    } else {
      rig.preset = this.preset
      rig.fit = this.car.fit
      if (!this.car.body || !this.preset) return
      rig.body = this.model ? ghostCopy(this.car.body, this.ghostShape) : buildPlaceholder(this.preset, this.paint, this.ghostShape)
      // One translucent single-sided material over the whole copy: the split's front halves would draw twice.
      if (this.model) removeFrontHalves(rig.body)
      this.ghostOwns = this.model ? 'none' : 'geometry'
    }
    rig.root.add(rig.body)
    const preset = rig.preset!
    rig.shadow.scale.set(preset.widthM / 1.8, 1, preset.lengthM / 4)
    rig.shadow.visible = !!rival
    this.prewarmBody(rig)
  }

  /**
   * Another driver's car in the ghost's place (their lap is the ghost lap,
   * setGhost): solid, its own model, fit and dynamics, its line in its
   * colour; null puts your translucent ghost back. The model is the
   * engine's from here on (freed when replaced).
   */
  setRival(rival: RivalCar | null) {
    if (!rival && !this.rival) return
    this.clearGhostBody()
    this.rival = rival ? { color: new THREE.Color(rival.color), name: rival.name, model: rival.model } : null
    if (rival) { this.ghostCar.preset = rival.preset; this.ghostCar.fit = rival.model ? rival.fit : null }
    this.buildGhostBody()
    this.findMotion()
    this.rebuildLines()
    this.both.ready = false
    this.invalidate()
  }

  /** Refit the other driver's model in place (a fit saved in the Garage meanwhile). */
  setRivalFit(fit: CarModelFit) {
    const rig = this.ghostCar
    if (!this.rival?.model || !rig.body) return
    rig.fit = fit
    rig.motion?.rest()
    applyFit(rig.body as THREE.Group, fit)
    rig.motion?.refresh()
    this.findMotion()
    this.invalidate()
  }

  /** The other driver's tag and tint (on by default). */
  setRivalMarked(on: boolean) {
    this.rivalMarked = on
    if (this.rivalTag) this.rivalTag.visible = on
    if (this.rival && this.ghostCar.body) tintCar(this.ghostCar.body, this.rival.color, on ? RIVAL_TINT : 0)
    this.invalidate()
  }

  /** Refit the uploaded model in place (the fit editor). */
  setFit(fit: CarModelFit) {
    this.fit = fit
    if (!this.model || !this.car.body) return
    this.car.fit = fit
    // Fitted at rest (wheels straight, body level), then re-measured.
    this.car.motion?.rest()
    applyFit(this.car.body as THREE.Group, fit)
    this.car.motion?.refresh()
    if (!this.rival) { this.clearGhostBody(); this.buildGhostBody() }
    this.findMotion()
    this.invalidate()
  }

  private carMotion = true

  /** Wheels that roll and steer and a body that leans with the g-forces (on by default). */
  setCarMotion(on: boolean) {
    this.carMotion = on
    this.findMotion()
    this.invalidate()
  }

  private findMotion() {
    for (const rig of [this.car, this.ghostCar]) {
      if (rig === this.ghostCar || !rig.motion) rig.motion = CarMotion.find(rig.body)
      if (rig.motion) rig.motion.enabled = this.carMotion && !rig.fit?.staticWheels
    }
  }

  /** The Garmin camera: mount point, lens and tilt (the fit's, else the preset's). */
  private dashcam(): { at: THREE.Vector3; fovDeg: number; pitchDeg: number } {
    const preset = this.preset?.fit
    const at = this.fit?.dashcamM ?? preset?.dashcamM ?? [0, (this.preset?.heightM ?? 1.2) * 0.92, 0.1]
    return {
      at: new THREE.Vector3(at[0], at[1], at[2]),
      fovDeg: this.fit?.dashcamFovDeg ?? preset?.dashcamFovDeg ?? 120,
      pitchDeg: this.fit?.dashcamPitchDeg ?? preset?.dashcamPitchDeg ?? 5,
    }
  }

  private eye(): THREE.Vector3 {
    const eye = this.fit?.eyeM ?? this.preset?.fit.eyeM ?? [0.33, 1.0, 0]
    return new THREE.Vector3(eye[0], eye[1], eye[2])
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  get duration(): number { return this.lap?.durationMs ?? 0 }
  get time(): number { return this.timeMs }

  play() {
    if (!this.lap) return
    if (this.timeMs >= this.duration) this.timeMs = 0
    this.playing = true
    this.lastFrame = performance.now()
    this.publish()
  }

  pause() { this.playing = false; this.invalidate(); this.publish() }
  toggle() { if (this.playing) this.pause(); else this.play() }
  isPlaying() { return this.playing }

  seek(timeMs: number) {
    const before = this.lap?.distAt(this.timeMs) ?? 0
    this.timeMs = Math.min(this.duration, Math.max(0, timeMs))
    // A jump moves the chase camera with the car instead of flying it there.
    if (Math.abs((this.lap?.distAt(this.timeMs) ?? 0) - before) > 25) this.chaseReady = this.mount.ready = false
    // Publish the new position now, not the last frame's.
    if (this.lap) this.lap.pose(this.timeMs, this.car.pose)
    this.poseGhost()
    this.invalidate()
    this.publish()
  }

  setRate(rate: number) { this.rate = rate; this.publish() }

  // ── The compared car's own clock (compare.ts) ───────────────────────────

  /** The compared car's lap time minus yours, ms. */
  get ghostOffset(): number { return this.ghostOffsetMs }

  /** Move only the compared car along its lap: its time becomes yours plus `offsetMs`. Playing keeps the offset. */
  setGhostOffset(offsetMs: number) {
    if (!this.ghost) return
    this.ghostOffsetMs = clampOffset(offsetMs, this.duration, this.ghost.durationMs)
    this.poseGhost()
    this.invalidate()
    this.publish()
  }

  /** Put the compared car at a time of its own lap, yours staying where it is. */
  seekGhost(ghostMs: number) {
    if (this.ghost) this.setGhostOffset(offsetFor(ghostMs, this.timeMs, this.ghost.durationMs))
  }

  /** Sync: both laps on their own clocks again (no offset). */
  syncGhost() { this.setGhostOffset(0) }

  /**
   * Side by side: the compared car level with yours on the track now (the
   * cars' centres at the same distance). False where its lap does not
   * reach that spot.
   */
  ghostSideBySide(): boolean {
    if (!this.lap || !this.ghost) return false
    // Each car's GPS sits this far ahead of its centre.
    const ahead = (rig: CarRig) => (rig.fit?.gpsM ?? rig.preset?.fit.gpsM)?.[2] ?? 0
    const offset = sideBySideOffset(this.lap, this.ghost, this.timeMs, ahead(this.ghostCar) - ahead(this.car))
    if (offset == null) return false
    this.setGhostOffset(offset)
    return true
  }

  private ghostTime(): number { return this.timeMs + this.ghostOffsetMs }

  // The compared car's pose for the published state between frames.
  private poseGhost() {
    const t = this.ghostTime()
    if (this.ghost && t <= this.ghost.durationMs) this.ghost.pose(Math.max(0, t), this.ghostCar.pose)
  }

  setView(view: ReplayView) {
    // The lens's programs (prepare compiles them when idle; started here if not yet), without waiting on them.
    if (view === 'garmin' && this.view !== 'garmin') void this.compileScene('lens').catch(() => {})
    if (view !== this.view) this.measureAfresh()
    this.view = view
    this.chaseReady = this.mount.ready = this.both.ready = false
    this.applyView()
    this.invalidate()
    this.publish()
  }

  private applyView() {
    this.camera.fov = this.fieldOfView()
    this.camera.near = this.view === 'driver' || this.view === 'garmin' ? 0.03 : 0.1
    this.camera.updateProjectionMatrix()
    if (this.view === 'orbit' && !this.orbit) void this.startOrbit()
    if (this.view !== 'orbit' && this.orbit) { this.orbit.dispose(); this.orbit = null }
  }

  // Vertical field of view: 70° from the driver's seat and 60° chasing on a
  // wide stage, opened up on a tall one (a phone) so the sides stay in view.
  private fieldOfView(): number {
    const [wide, least, most] = this.view === 'driver' ? [100, 70, 100] : [90, 60, 85]
    const vertical = 2 * Math.atan(Math.tan(wide * Math.PI / 360) / Math.max(0.1, this.camera.aspect)) * 180 / Math.PI
    return Math.min(most, Math.max(least, vertical))
  }

  // The debug orbit camera loads on demand.
  private async startOrbit() {
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js')
    if (this.view !== 'orbit' || this.disposed) return
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.target.copy(this.car.root.position)
    this.orbit.addEventListener('change', () => this.invalidate())
  }

  private state(): FrameState {
    const pose = this.car.pose
    let gapMs: number | null = null
    if (this.lap && this.ghost && pose.dist != null) {
      const ghostTime = this.ghost.timeAtDist(pose.dist)
      if (ghostTime != null) gapMs = this.timeMs - ghostTime
    }
    const fps = this.fpsWindow.length > 1 ? 1000 * (this.fpsWindow.length - 1) / (this.fpsWindow[this.fpsWindow.length - 1] - this.fpsWindow[0]) : 0
    let compared: ComparedState | null = null
    if (this.lap && this.ghost) {
      const timeMs = this.ghostTime(), onTrack = timeMs <= this.ghost.durationMs && this.ghostCar.pose.dist != null
      compared = {
        timeMs, durationMs: this.ghost.durationMs, offsetMs: this.ghostOffsetMs,
        pose: onTrack ? this.ghostCar.pose : null,
        aheadM: onTrack && pose.dist != null ? this.ghostCar.pose.dist - pose.dist : null,
      }
    }
    return { timeMs: this.timeMs, durationMs: this.duration, playing: this.playing, rate: this.rate, pose, gapMs, compared, view: this.view, fps, lookActive: this.lookActive, quality: this.quality }
  }

  private publish() {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  private frame = (now: number) => {
    if (this.disposed || this.lost) return
    this.frameHandle = requestAnimationFrame(this.frame)
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastFrame || now)) / 1000))
    this.lastFrame = now
    if (this.playing && this.lap) {
      this.timeMs += dt * 1000 * this.rate
      if (this.timeMs >= this.duration) {
        this.timeMs = this.duration
        this.playing = false
        // One more frame, so listeners see the lap end even when nothing else moves.
        this.invalidate(1)
        this.onEnded?.()
      }
    }
    const moving = this.playing || this.renderFrames > 0 || this.view === 'orbit'
    if (!moving) return
    this.renderFrames = Math.max(0, this.renderFrames - 1)
    this.fpsWindow.push(now)
    while (this.fpsWindow.length > 30) this.fpsWindow.shift()
    this.placeCars()
    if (this.easeLook(dt)) this.invalidate(1)
    this.placeCamera(dt)
    this.prepareLight(now)
    if (this.view === 'garmin') {
      const lens = this.ensureLens()
      lens.configure(this.camera, this.camera.aspect, { horizontalFovDeg: this.dashcam().fovDeg, barrel: GARMIN_BARREL })
      lens.render(this.renderer, this.scene)
    } else this.renderer.render(this.scene, this.camera)
    // A constrained device drops the CPU copies of what is now on the GPU (budget.ts).
    releaseUploaded(this.renderer)
    this.adaptResolution(now)
    this.publish()
  }

  // Before each render: the sky and the sun's shadows follow the camera, the
  // environment map is rebuilt after a change of weather (and the car's
  // reflections with it), and a new car body casts and takes shadows.
  private prepareLight(now: number) {
    const env = this.atmosphere.environment
    this.atmosphere.update(this.camera, now / 1000, this.car.root.visible ? this.car.root.position : null)
    this.atmosphere.prepare()
    this.atmosphere.renderShadows()
    this.grass?.update(this.camera)
    if (this.atmosphere.environment !== env) this.refreshReflections()
    // Another driver's car is solid: it casts and takes shadows like yours.
    for (const body of [this.car.body, this.rival ? this.ghostCar.body : null]) {
      if (body && !this.shadowedBodies.has(body)) {
        this.shadowedBodies.add(body)
        markCarCasters(body)
        // Its textures' CPU copies go once uploaded (not its geometry: refits measure it).
        if (replayProfile().lean) releaseWhenUploaded(body)
      }
    }
  }

  // Every change of resolution is a visible jump (fine detail such as leaves
  // most of all), so it must not hunt: a level that could not hold the frame
  // rate is not tried again in this world, a step that did not help is
  // undone, and changes wait for 3 s of frames (resolution.ts). Only while
  // playing and in view: paused, hidden or just back, nothing is measured.
  private adaptResolution(now: number) {
    if (!this.playing || document.hidden) { this.frameWindow.reset(); return }
    const fps = this.frameWindow.add(now)
    if (fps === null) return
    const limit = Math.min(replayProfile().maxPixelRatio, window.devicePixelRatio || 1)
    const next = adapt(
      { ratio: this.pixelRatio, quality: this.quality, ceiling: this.ceiling, capped: this.capped, trial: this.trial, raiseAfter: this.raiseAfter },
      fps, { auto: this.graphics === 'auto', limit, now },
    )
    this.ceiling = next.ceiling
    this.capped = next.capped
    this.trial = next.trial
    this.raiseAfter = next.raiseAfter
    if (next.quality === this.quality && next.ratio === this.pixelRatio) return
    if (next.quality !== this.quality) this.setQuality(next.quality)
    if (next.ratio !== this.pixelRatio) { this.pixelRatio = next.ratio; this.resize() }
    // The frames of the change itself are not the new level's.
    this.frameWindow.reset()
  }

  private placeCars() {
    if (!this.lap || !this.world) { this.car.root.visible = this.ghostCar.root.visible = false; return }
    this.placeRig(this.car, this.lap, this.timeMs)
    this.car.root.visible = true
    // On its own clock (yours plus the offset): before its start it waits
    // on the line; after its finish it leaves the track.
    const ghostMs = this.ghostTime()
    if (this.ghost && this.ghostCar.body && ghostMs <= this.ghost.durationMs) {
      this.placeRig(this.ghostCar, this.ghost, Math.max(0, ghostMs))
      this.ghostCar.root.visible = true
    } else this.ghostCar.root.visible = false
    if (this.rival) this.fadeRival()
    // The driver's own body is in the way of the view from inside, but the
    // dashboard of a real model is the point: only the placeholder hides.
    // A new body waits for its shaders (prewarmBody).
    if (this.car.body) this.car.body.visible = !(this.view === 'driver' && !this.model) && this.car.warming !== this.car.body
    if (this.ghostCar.body) this.ghostCar.body.visible = this.ghostCar.warming !== this.ghostCar.body
    this.car.shadow.visible = this.view !== 'driver' && this.view !== 'garmin'
  }

  // Another driver's car overlapping yours (side by side on the same line)
  // turns see-through, easing, and solid again once clear.
  private fadeRival() {
    const a = this.car, b = this.ghostCar
    let target = 1
    if (b.root.visible && a.root.visible && a.preset && b.preset) {
      const dx = b.root.position.x - a.root.position.x, dz = b.root.position.z - a.root.position.z
      const fx = a.pose.fx ?? 0, fz = a.pose.fz ?? 1
      const along = Math.abs(dx * fx + dz * fz), across = Math.abs(dx * fz - dz * fx)
      if (along < (a.preset.lengthM + b.preset.lengthM) / 2 && across < (a.preset.widthM + b.preset.widthM) / 2) target = RIVAL_OVERLAP_OPACITY
    }
    if (Math.abs(target - this.rivalFade) < 0.005) return
    const dt = Math.min(0.1, this.playing ? 1 / 60 : 1 / 30)
    this.rivalFade += (target - this.rivalFade) * (1 - Math.exp(-dt * 12))
    if (Math.abs(target - this.rivalFade) < 0.01) this.rivalFade = target
    for (const m of this.rivalMaterials) m.opacity = this.rivalFade
    this.invalidate(1)
  }

  private tmpForward = new THREE.Vector3()
  private tmpLeft = new THREE.Vector3()
  private tmpUp = new THREE.Vector3()
  private tmpMatrix = new THREE.Matrix4()
  private tmpQuat = new THREE.Quaternion()

  /** Pose a car on the road: height from the surface, pitch and roll from its slope. */
  private placeRig(rig: CarRig, lap: LapPath, timeMs: number) {
    const road = this.world!.road
    const pose = this.toCarCentre(lap.pose(timeMs, rig.pose), rig)
    const preset = rig.preset
    const halfBase = (preset?.wheelbaseM ?? 2.4) / 2, halfTrack = ((preset?.widthM ?? 1.8) - 0.25) / 2
    const s = rig.hint = road.nearestFrom(pose.x, pose.z, road.stationAt(pose.dist), 12)
    const y = this.restOn(pose, s, halfBase, halfTrack, rig.root.quaternion)
    rig.root.position.set(pose.x, y, pose.z)
    // Wheels and body; the inside cameras ride the steady mount, not the body.
    if (rig.motion && preset?.dynamics) rig.motion.update(lap, timeMs, pose, preset.dynamics, rig.ground)
  }

  private restPose = {} as LapPose
  private restQuat = new THREE.Quaternion()

  /** A car's height on the ground at a lap time, as placeRig rests it (for its springs). */
  private restingHeight(rig: CarRig, lap: LapPath, timeMs: number): number {
    const road = this.world!.road
    const pose = this.toCarCentre(lap.pose(timeMs, this.restPose), rig)
    const halfBase = (rig.preset?.wheelbaseM ?? 2.4) / 2, halfTrack = ((rig.preset?.widthM ?? 1.8) - 0.25) / 2
    return this.restOn(pose, road.nearestFrom(pose.x, pose.z, road.stationAt(pose.dist), 12), halfBase, halfTrack, this.restQuat)
  }

  /**
   * A lap pose is where the data collector's GPS went; move it to the car's
   * centre, so that point of the car rides on the line (a unit on the
   * passenger's dash draws the car off-centre from it, as it was). The
   * racing and ghost lines stay on the GPS track.
   */
  private toCarCentre(pose: LapPose, rig: CarRig): LapPose {
    const gps = rig.fit?.gpsM ?? rig.preset?.fit.gpsM
    if (gps) {
      const left = gps[0], forward = gps[2]
      // The car's left is (fz, −fx) in x/z.
      pose.x -= pose.fx * forward + pose.fz * left
      pose.z -= pose.fz * forward - pose.fx * left
    }
    return pose
  }

  /** The ground under a point near station `s`: the track model's, else the road's. */
  private groundAt(x: number, z: number, s: number): number {
    const onRoad = this.world!.road.surface(x, z, s).h
    const model = this.world!.surface
    if (!model) return onRoad
    const onModel = model(x, z, onRoad)
    return Number.isFinite(onModel) ? onModel : onRoad
  }

  /**
   * Rest a body of the given half length and half width on the ground at a
   * pose: its orientation into `out`, its height returned (the mean of the
   * four points it stands on).
   */
  private restOn(pose: LapPose, s: number, halfBase: number, halfTrack: number, out: THREE.Quaternion): number {
    const lx = pose.fz, lz = -pose.fx
    const h = (dx: number, dz: number) => this.groundAt(pose.x + dx, pose.z + dz, s)
    const front = h(pose.fx * halfBase, pose.fz * halfBase), back = h(-pose.fx * halfBase, -pose.fz * halfBase)
    const left = h(lx * halfTrack, lz * halfTrack), right = h(-lx * halfTrack, -lz * halfTrack)
    const forward = this.tmpForward.set(pose.fx * 2 * halfBase, front - back, pose.fz * 2 * halfBase).normalize()
    const side = this.tmpLeft.set(lx * 2 * halfTrack, left - right, lz * 2 * halfTrack).normalize()
    // Car frame: left × up = forward, so up = forward × left.
    const up = this.tmpUp.crossVectors(forward, side).normalize()
    side.crossVectors(up, forward).normalize()
    out.setFromRotationMatrix(this.tmpMatrix.makeBasis(side, up, forward))
    return (front + back + left + right) / 4
  }

  private mountTarget = new THREE.Quaternion()
  private mountPos = new THREE.Vector3()

  /**
   * Put the camera at a point on the car (car frame), riding the steady
   * mount: the car's position along the road, but the height and tilt of the
   * ground over a long base, eased by a spring that leads by the climb rate.
   */
  private placeOnMount(local: THREE.Vector3, dt: number) {
    const car = this.car, pose = car.pose, m = this.mount
    const halfTrack = ((this.preset?.widthM ?? 1.8) - 0.25) / 2
    const target = this.restOn(pose, car.hint, MOUNT_BASE_M, halfTrack, this.mountTarget)
    if (!m.ready || dt <= 0) {
      if (!m.ready) { m.y = m.target = target; m.vel = 0; m.quat.copy(this.mountTarget); m.ready = true }
    } else {
      const k = 1 - Math.exp(-dt / MOUNT_SPRING_S)
      m.vel += ((target - m.target) / dt - m.vel) * k
      m.target = target
      m.y += (target + m.vel * MOUNT_SPRING_S - m.y) * k
      m.quat.slerp(this.mountTarget, k)
    }
    this.camera.position.copy(local).applyQuaternion(m.quat).add(this.mountPos.set(car.root.position.x, m.y, car.root.position.z))
    this.camera.quaternion.copy(m.quat).multiply(TURN_AROUND)
    // Keep easing after a pause until the mount settles.
    if (Math.abs(m.y - target) > 1e-3 || m.quat.angleTo(this.mountTarget) > 1e-4) this.invalidate(1)
  }

  private placeCamera(dt: number) {
    const root = this.car.root
    if (!this.lap || !this.world) return
    if (this.view === 'garmin') {
      // On the windscreen, looking along the car and tilted down a little.
      const cam = this.dashcam()
      this.placeOnMount(cam.at, dt)
      this.turnHead(this.looks.garmin.now, -cam.pitchDeg * Math.PI / 180)
      return
    }
    if (this.view === 'driver') {
      // Cameras look down -z; the car faces +z. Eyes rest a little below
      // level, on the road ahead.
      this.placeOnMount(this.eye(), dt)
      this.turnHead(this.looks.driver.now, -DRIVER_LOOK_DOWN_DEG * Math.PI / 180)
      return
    }
    if (this.view === 'orbit') {
      if (this.orbit) {
        const shift = root.position.clone().sub(this.orbit.target)
        this.orbit.target.add(shift)
        this.camera.position.add(shift)
        this.orbit.update()
      }
      return
    }
    if (this.view === 'both') { this.placeBoth(dt); return }
    // Chase: behind and above the car. Its position is followed exactly (a
    // lagging position falls metres behind at speed); the heading and height
    // ease, so the view swings through corners instead of snapping.
    const pose = this.car.pose
    const p = root.position
    if (!this.chaseReady) {
      this.chaseDir.set(pose.fx, 0, pose.fz)
      this.chaseHeight = p.y
      this.chaseReady = true
    } else {
      this.chaseDir.lerp(this.tmpForward.set(pose.fx, 0, pose.fz), 1 - Math.exp(-dt * 3.5)).normalize()
      this.chaseHeight += (p.y - this.chaseHeight) * (1 - Math.exp(-dt * 6))
    }
    const d = this.chaseDir
    // Orbit: the eased heading turned by the dragged yaw (0 = straight behind).
    const look = this.looks.chase.now
    const cos = Math.cos(look.yaw), sin = Math.sin(look.yaw)
    const ox = d.x * cos + d.z * sin, oz = -d.x * sin + d.z * cos
    const back = look.dist * Math.cos(look.pitch), up = look.dist * Math.sin(look.pitch)
    this.chasePos.set(p.x - ox * back, this.chaseHeight + up, p.z - oz * back)
    // Behind the car it looks a little ahead of it; from the side, at it.
    const ahead = 4 * Math.max(0, cos)
    this.chaseLook.set(p.x + pose.fx * ahead, p.y + 0.7, p.z + pose.fz * ahead)
    // Keep the camera above the ground it passes over.
    const road = this.world.road
    let ground = road.surface(this.chasePos.x, this.chasePos.z, road.nearestFrom(this.chasePos.x, this.chasePos.z, this.car.hint, 20)).h
    const onModel = this.world.surface?.(this.chasePos.x, this.chasePos.z, ground) ?? NaN
    if (Number.isFinite(onModel)) ground = onModel
    this.chasePos.y = Math.max(this.chasePos.y, ground + 1.2)
    this.camera.position.copy(this.chasePos)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.chaseLook)
    // Keep easing after a pause until the camera settles.
    if (Math.abs(d.x * pose.fz - d.z * pose.fx) > 1e-3 || Math.abs(p.y - this.chaseHeight) > 1e-3) this.invalidate(1)
  }

  private bothTarget = new THREE.Vector3()

  /**
   * Both cars: behind them along your car's eased heading, looking at a
   * point between them, back far enough that a sphere round both stays in
   * view, higher the further apart they are (compare.ts frameBoth). The
   * cars are followed exactly; the framing's offset from your car, its
   * distance and pitch ease, so a scrub or a change of lead glides. Past
   * ~150 m apart (or with no compared car on track) it follows yours.
   */
  private placeBoth(dt: number) {
    const pose = this.car.pose, a = this.car.root.position, s = this.both
    const b = this.ghost && this.ghostCar.root.visible ? this.ghostCar.root.position : null
    const frame = frameBoth([a.x, a.y, a.z], b ? [b.x, b.y, b.z] : null)
    const look = this.looks.both.now
    // A tenth to spare round the sphere: the HUD and the transport cover the view's edges.
    const dist = Math.max(CHASE_DIST, 1.1 * framingDistance(frame.radiusM, this.camera.fov, this.camera.aspect)) * look.dist
    const pitch = clamp(frame.pitch + look.pitch, ORBIT_PITCH[0], ORBIT_PITCH[1])
    const offset = this.bothTarget.set(frame.target[0] - a.x, frame.target[1] - a.y, frame.target[2] - a.z)
    if (!this.chaseReady || !s.ready) {
      this.chaseDir.set(pose.fx, 0, pose.fz)
      this.chaseReady = true
      s.offset.copy(offset); s.dist = dist; s.pitch = pitch; s.ready = true
    } else if (dt > 0) {
      this.chaseDir.lerp(this.tmpForward.set(pose.fx, 0, pose.fz), 1 - Math.exp(-dt * 3.5)).normalize()
      s.offset.lerp(offset, 1 - Math.exp(-dt * 4))
      const k = 1 - Math.exp(-dt * 2.5)
      s.dist += (dist - s.dist) * k
      s.pitch += (pitch - s.pitch) * k
    }
    const d = this.chaseDir, cos = Math.cos(look.yaw), sin = Math.sin(look.yaw)
    const ox = d.x * cos + d.z * sin, oz = -d.x * sin + d.z * cos
    const tx = a.x + s.offset.x, ty = a.y + s.offset.y, tz = a.z + s.offset.z
    const back = s.dist * Math.cos(s.pitch), up = s.dist * Math.sin(s.pitch)
    this.chasePos.set(tx - ox * back, ty + up, tz - oz * back)
    // Aimed a little short of the middle (toward the camera), so the pair sits
    // about 8% of the view higher, clear of the transport at the bottom.
    const lead = 0.08 * this.camera.fov * DEG * s.dist / Math.max(0.2, Math.sin(s.pitch))
    this.chaseLook.set(tx - ox * lead, ty + 0.6, tz - oz * lead)
    const road = this.world!.road
    let ground = road.surface(this.chasePos.x, this.chasePos.z, road.nearestFrom(this.chasePos.x, this.chasePos.z, this.car.hint, 20)).h
    const onModel = this.world!.surface?.(this.chasePos.x, this.chasePos.z, ground) ?? NaN
    if (Number.isFinite(onModel)) ground = onModel
    this.chasePos.y = Math.max(this.chasePos.y, ground + 1.5)
    this.camera.position.copy(this.chasePos)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.chaseLook)
    // Keep easing after a pause until the framing settles.
    if (s.offset.distanceToSquared(offset) > 1e-4 || Math.abs(dist - s.dist) > 1e-2 || Math.abs(pitch - s.pitch) > 1e-4
      || Math.abs(d.x * pose.fz - d.z * pose.fx) > 1e-3) this.invalidate(1)
  }

  // ── Looking around ───────────────────────────────────────────────────────

  private lookView(): LookView | null { return this.view === 'orbit' ? null : this.view }

  /** The current view's camera is away from its default. */
  get lookActive(): boolean {
    const view = this.lookView()
    if (!view) return false
    const t = this.looks[view].target, d = lookDefault(view)
    return Math.abs(t.yaw - d.yaw) > 0.01 || Math.abs(t.pitch - d.pitch) > 0.01 || Math.abs(t.dist - d.dist) > 0.05
  }

  /** Back to the current view's default camera (eased). */
  resetLook() {
    const view = this.lookView()
    if (!view) return
    Object.assign(this.looks[view].target, lookDefault(view))
    this.lookChanged()
  }

  private lookChanged() { this.invalidate(2); this.publish() }

  // Light damping towards the dragged target; true while still moving.
  private easeLook(dt: number): boolean {
    const view = this.lookView()
    if (!view) return false
    const { target, now } = this.looks[view]
    const k = 1 - Math.exp(-Math.max(dt, 1 / 120) * 14)
    let moving = false
    for (const key of ['yaw', 'pitch', 'dist'] as const) {
      const gap = target[key] - now[key]
      if (Math.abs(gap) < (key === 'dist' ? 1e-3 : 1e-4)) now[key] = target[key]
      else { now[key] += gap * k; moving = true }
    }
    return moving
  }

  // The head's turn (about the car's up, then its own x) before the camera's tilt.
  private turnHead(look: Look, tilt: number) {
    this.camera.quaternion
      .multiply(this.tmpQuat.setFromAxisAngle(Y_AXIS, look.yaw))
      .multiply(this.tmpQuat.setFromAxisAngle(X_AXIS, look.pitch + tilt))
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  // Pointer events on the canvas only (the HUD, scrub bar and picture in
  // picture are other elements above it), captured so a drag can leave it.
  private onPointerDown = (event: PointerEvent) => {
    if (!this.lookView() || (event.pointerType === 'mouse' && event.button !== 0)) return
    const canvas = this.renderer.domElement
    try { canvas.setPointerCapture(event.pointerId) } catch { /* already gone */ }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.pointers.size === 1) this.drag = { id: event.pointerId, x0: event.clientX, y0: event.clientY, moved: false }
    else if (this.pointers.size === 2) {
      // Two fingers: a pinch sets the chase distance; neither finger turns.
      this.pinch = { spread: this.spread(), dist: this.looks[this.view === 'both' ? 'both' : 'chase'].target.dist }
      this.drag = null
    }
    // No text selection or focus change from a press on the view.
    if (event.pointerType === 'mouse') event.preventDefault()
  }

  private onPointerMove = (event: PointerEvent) => {
    const last = this.pointers.get(event.pointerId)
    if (!last) return
    const dx = event.clientX - last.x, dy = event.clientY - last.y
    last.x = event.clientX; last.y = event.clientY
    const view = this.lookView()
    if (!view) return
    if (this.pinch && this.pointers.size >= 2) {
      const spread = this.spread()
      if (view === 'chase' && spread > 10 && this.pinch.spread > 10) {
        this.looks.chase.target.dist = clamp(this.pinch.dist * this.pinch.spread / spread, CHASE_MIN_DIST, CHASE_MAX_DIST)
        this.lookChanged()
      } else if (view === 'both' && spread > 10 && this.pinch.spread > 10) {
        this.looks.both.target.dist = clamp(this.pinch.dist * this.pinch.spread / spread, ...BOTH_SCALE)
        this.lookChanged()
      }
      return
    }
    const drag = this.drag
    if (!drag || drag.id !== event.pointerId) return
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) < DRAG_SLOP_PX) return
      drag.moved = true
      this.renderer.domElement.classList.add('dragging')
    }
    // The world follows the pointer: a drag across the view turns ~180°.
    const k = Math.PI / Math.max(320, this.container.clientWidth)
    const target = this.looks[view].target
    if (view === 'chase') {
      target.yaw -= dx * k
      target.pitch = clamp(target.pitch + dy * k, ORBIT_PITCH[0], ORBIT_PITCH[1])
    } else if (view === 'both') {
      target.yaw -= dx * k
      target.pitch = clamp(target.pitch + dy * k, ...BOTH_TILT)
    } else {
      target.yaw = clamp(target.yaw + dx * k, -HEAD_YAW, HEAD_YAW)
      target.pitch = clamp(target.pitch + dy * k, -HEAD_PITCH, HEAD_PITCH)
    }
    this.lookChanged()
  }

  private onPointerUp = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return
    const canvas = this.renderer.domElement
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId) } catch { /* gone */ }
    if (this.pointers.size < 2) this.pinch = null
    const drag = this.drag
    if (drag?.id === event.pointerId) {
      this.drag = null
      canvas.classList.remove('dragging')
      // A double tap resets (a mouse has dblclick).
      if (!drag.moved && event.type === 'pointerup' && event.pointerType !== 'mouse') {
        const now = performance.now()
        if (now - this.lastTap.t < 350 && Math.hypot(event.clientX - this.lastTap.x, event.clientY - this.lastTap.y) < 40) { this.lastTap.t = 0; this.resetLook() }
        else this.lastTap = { t: now, x: event.clientX, y: event.clientY }
      }
    }
    // The finger left after a pinch carries on turning, without a jump.
    if (!this.drag && this.pointers.size === 1) {
      const [[id, at]] = [...this.pointers]
      this.drag = { id, x0: at.x, y0: at.y, moved: true }
    }
  }

  private onDoubleClick = (event: MouseEvent) => { event.preventDefault(); this.resetLook() }

  // The wheel zooms the chase camera; elsewhere it scrolls the page as usual.
  private onWheel = (event: WheelEvent) => {
    if (this.view !== 'chase' && this.view !== 'both') return
    event.preventDefault()
    const target = this.looks[this.view].target
    const step = event.deltaMode === 1 ? 0.06 : event.deltaMode === 2 ? 1 : 0.0015
    const [lo, hi] = this.view === 'both' ? BOTH_SCALE : [CHASE_MIN_DIST, CHASE_MAX_DIST]
    target.dist = clamp(target.dist * Math.exp(event.deltaY * step), lo, hi)
    this.lookChanged()
  }

  // A long press on a touch screen would open the context menu mid-drag.
  private onContextMenu = (event: Event) => { if (this.drag?.moved || this.pointers.size) event.preventDefault() }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.resizeObserver.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.orbit?.dispose()
    this.lens?.dispose()
    this.listeners.clear()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('webglcontextlost', this.contextLost)
    canvas.removeEventListener('webglcontextrestored', this.contextRestored)
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('lostpointercapture', this.onPointerUp)
    canvas.removeEventListener('dblclick', this.onDoubleClick)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.setWorld(null)
    for (const line of [this.racingLine, this.ghostLine]) if (line) disposeObject(line)
    this.clearCars()
    this.clearGhostBody()
    disposeObject(this.car.shadow); disposeObject(this.ghostCar.shadow)
    this.ghostShape.dispose()
    this.atmosphere.dispose()
    this.grass?.dispose()
    this.renderer.dispose()
    canvas.remove()
  }
}
