// The 3D replay engine: a three.js scene with the world (terrain, road), the
// lap's car and an optional ghost, driver and chase cameras, and a clock in
// lap time. Framework-free; the Replay page wraps it and draws the overlays
// from the state it publishes each frame.

import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { CarModelFit, CarPreset } from '../../shared/replay'
import { LapPath, type LapPose } from './lapPath'
import type { RoadModel } from './road'
import { applyFit, blobShadow, buildPlaceholder, disposeGeometry, disposeObject, fittedModel, ghostCopy, ghostMaterial } from './car'
import { buildLapLine } from './roadMesh'
import { LensPass } from './lens'

export type ReplayView = 'driver' | 'garmin' | 'chase' | 'orbit'

export interface ReplayWorld {
  group: THREE.Group
  road: RoadModel
  /**
   * A 3D track model's surface height (local y) near a reference height,
   * NaN off it: the cars sit on it wheel by wheel (kerbs and all).
   */
  surface?: (x: number, z: number, refY: number) => number
  /** Sky-matched colour for fog and the far ground. */
  horizon: THREE.Color
  dispose: () => void
}

export interface FrameState {
  timeMs: number
  durationMs: number
  playing: boolean
  rate: number
  pose: LapPose
  /** Main lap time minus the ghost's at the same distance (+ = behind), ms. */
  gapMs: number | null
  view: ReplayView
  fps: number
  /** The camera is dragged away from its default view (show a reset). */
  lookActive: boolean
}

const GHOST_COLOR = 0x7dd3fc
const CHASE_BACK = 6.6, CHASE_UP = 2.1
// Car reflections, and the lights: a warm-white sun and a neutral sky fill
// (the world's materials are calibrated against these; see world.ts).
const CAR_ENV_INTENSITY = 0.8
const TURN_AROUND = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const X_AXIS = new THREE.Vector3(1, 0, 0)
const DRIVER_LOOK_DOWN_DEG = 4
// How far the Garmin lens bends straight lines: 0 rectilinear, 1 fisheye.
const GARMIN_BARREL = 0.65
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const DEG = Math.PI / 180
// The inside cameras ride a steady mount, not the car's every bump: its
// height, pitch and roll come from the ground this far ahead of and behind
// the car, then a light spring (with lead, so it never lags on a climb).
const MOUNT_BASE_M = 6
const MOUNT_SPRING_S = 0.12

// Looking around by dragging: from the seat the head turns (relative to the
// car, so it stays turned through corners); chasing, the camera orbits the
// car and the wheel or a pinch sets its distance. Each view keeps its own.
type LookView = 'chase' | 'driver' | 'garmin'
interface Look { yaw: number; pitch: number; dist: number }
const CHASE_DIST = Math.hypot(CHASE_BACK, CHASE_UP), CHASE_PITCH = Math.atan2(CHASE_UP, CHASE_BACK)
const CHASE_MIN_DIST = 3, CHASE_MAX_DIST = 40
const HEAD_YAW = 160 * DEG, HEAD_PITCH = 70 * DEG, ORBIT_PITCH: [number, number] = [5 * DEG, 80 * DEG]
// A press that moves less than this is a click, not a drag.
const DRAG_SLOP_PX = 5
const lookDefault = (view: LookView): Look => (view === 'chase' ? { yaw: 0, pitch: CHASE_PITCH, dist: CHASE_DIST } : { yaw: 0, pitch: 0, dist: 0 })
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface CarRig {
  root: THREE.Group
  body: THREE.Object3D | null
  shadow: THREE.Mesh
  hint: number
  pose: LapPose
}

function supportsReversedDepth(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ok = !!gl?.getExtension('EXT_clip_control')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return ok
  } catch { return false }
}

export class ReplayEngine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 12000)
  private sky = new Sky()
  private sun = new THREE.DirectionalLight(0xfff4e2, 2.3)
  private hemi = new THREE.HemisphereLight(0xf5f6f8, 0x8a8068, 1.25)
  private envTarget: THREE.WebGLRenderTarget | null = null
  private world: ReplayWorld | null = null
  private lap: LapPath | null = null
  private ghost: LapPath | null = null
  private car: CarRig
  private ghostCar: CarRig
  private racingLine: THREE.Mesh | null = null
  private ghostLine: THREE.Mesh | null = null
  private showRacingLine = true
  private showGhostLine = true
  private preset: CarPreset | null = null
  private fit: CarModelFit | null = null
  private model: THREE.Object3D | null = null
  private ghostShape: THREE.Material = ghostMaterial(GHOST_COLOR)
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
  private lost = false
  private disposed = false
  private looks: Record<LookView, { target: Look; now: Look }> = {
    chase: { target: lookDefault('chase'), now: lookDefault('chase') },
    driver: { target: lookDefault('driver'), now: lookDefault('driver') },
    garmin: { target: lookDefault('garmin'), now: lookDefault('garmin') },
  }
  private pointers = new Map<number, { x: number; y: number }>()
  private drag: { id: number; x0: number; y0: number; moved: boolean } | null = null
  private pinch: { spread: number; dist: number } | null = null
  private lastTap = { t: 0, x: 0, y: 0 }
  // Resolution adapts to hold the frame rate on slower GPUs.
  private pixelRatio = Math.min(2, window.devicePixelRatio || 1)
  private perfStart = 0
  private perfFrames = 0
  private raiseAfter = 0
  onContextLost?: (lost: boolean) => void
  onEnded?: () => void

  constructor(private container: HTMLElement) {
    const reversedDepthBuffer = supportsReversedDepth()
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer, logarithmicDepthBuffer: !reversedDepthBuffer })
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.62
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
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

    this.sky.scale.setScalar(10000)
    const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(215))
    const u = this.sky.material.uniforms
    u.sunPosition.value.copy(sun)
    u.turbidity.value = 3.5
    u.rayleigh.value = 1.4
    u.mieCoefficient.value = 0.004
    u.mieDirectionalG.value = 0.8
    if (u.cloudCoverage) u.cloudCoverage.value = 0.3
    this.scene.add(this.sky)
    this.sun.position.copy(sun).multiplyScalar(1000)
    this.scene.add(this.sun, this.sun.target, this.hemi)
    this.buildEnvironment()

    const rig = (): CarRig => {
      const root = new THREE.Group()
      const shadow = blobShadow(4, 1.8)
      root.add(shadow)
      root.visible = false
      this.scene.add(root)
      return { root, body: null, shadow, hint: 0, pose: {} as LapPose }
    }
    this.car = rig()
    this.ghostCar = rig()
    this.ghostCar.shadow.visible = false

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  // Reflections for the car's paint and glass: a neutral studio (three's
  // RoomEnvironment), so silver stays silver and black stays black. The
  // sky's own colours would tint the paint blue and, with the hemisphere
  // light, light it twice.
  private buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.envTarget?.dispose()
    this.envTarget = pmrem.fromScene(room, 0.04)
    room.dispose()
    pmrem.dispose()
    for (const rig of [this.car, this.ghostCar]) if (rig?.body) this.reflectEnvironment(rig.body)
  }

  // Only the car's PBR materials take the environment: in three.js a
  // scene-wide one would also multiply into the Lambert terrain.
  private reflectEnvironment(root: THREE.Object3D) {
    const env = this.envTarget?.texture ?? null
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
    this.lost = false
    this.buildEnvironment()
    this.onContextLost?.(false)
    this.invalidate()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight)
    this.pixelRatio = Math.min(this.pixelRatio, Math.min(2, window.devicePixelRatio || 1))
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

  subscribe(listener: (state: FrameState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state())
    return () => this.listeners.delete(listener)
  }

  // ── Content ──────────────────────────────────────────────────────────────

  setWorld(world: ReplayWorld | null) {
    if (this.world) { this.scene.remove(this.world.group); this.world.dispose() }
    this.world = world
    if (world) {
      this.scene.add(world.group)
      this.scene.fog = new THREE.Fog(world.horizon, 350, 4200)
    } else this.scene.fog = null
    this.rebuildLines()
    this.chaseReady = this.mount.ready = false
    this.ceiling = 2
    this.invalidate()
  }

  setLap(lap: LapPath | null) {
    this.lap = lap
    this.mount.ready = false
    this.timeMs = Math.min(this.timeMs, lap?.durationMs ?? 0)
    this.car.hint = 0
    this.rebuildLines()
    this.chaseReady = false
    this.invalidate()
  }

  setGhost(ghost: LapPath | null) {
    this.ghost = ghost
    this.ghostCar.hint = 0
    this.rebuildLines()
    this.invalidate()
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
      this.ghostLine = buildLapLine(this.ghost, road, new THREE.Color(GHOST_COLOR), [0, 1], 0.16, this.world?.surface)
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
    if (model && fit) {
      const fitted = fittedModel(model, fit)
      this.car.body = fitted
      this.ghostCar.body = ghostCopy(fitted, this.ghostShape)
    } else {
      this.car.body = buildPlaceholder(preset, paint, null)
      this.ghostCar.body = buildPlaceholder(preset, paint, this.ghostShape)
    }
    this.car.root.add(this.car.body)
    this.ghostCar.root.add(this.ghostCar.body)
    this.reflectEnvironment(this.car.body)
    for (const rig of [this.car, this.ghostCar]) rig.shadow.scale.set(preset.widthM / 1.8, 1, preset.lengthM / 4)
    this.applyView()
    this.invalidate()
  }

  // The ghost shares the shared ghost material (and a model's geometry), so
  // only what each body owns is freed.
  private clearCars(nextModel: THREE.Object3D | null = null) {
    for (const rig of [this.car, this.ghostCar]) if (rig.body) rig.root.remove(rig.body)
    if (this.model) { if (this.model !== nextModel) disposeObject(this.model) }
    else {
      if (this.car.body) disposeObject(this.car.body)
      if (this.ghostCar.body) disposeGeometry(this.ghostCar.body)
    }
    this.car.body = this.ghostCar.body = null
  }

  /** Refit the uploaded model in place (the fit editor). */
  setFit(fit: CarModelFit) {
    this.fit = fit
    if (!this.model || !this.car.body) return
    applyFit(this.car.body as THREE.Group, fit)
    this.ghostCar.root.remove(this.ghostCar.body!)
    this.ghostCar.body = ghostCopy(this.car.body, this.ghostShape)
    this.ghostCar.root.add(this.ghostCar.body)
    this.invalidate()
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
    this.invalidate()
    this.publish()
  }

  setRate(rate: number) { this.rate = rate; this.publish() }

  setView(view: ReplayView) {
    this.view = view
    this.chaseReady = this.mount.ready = false
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
    return { timeMs: this.timeMs, durationMs: this.duration, playing: this.playing, rate: this.rate, pose, gapMs, view: this.view, fps, lookActive: this.lookActive }
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
    this.sky.position.copy(this.camera.position)
    if (this.view === 'garmin') {
      this.lens ??= new LensPass()
      this.lens.configure(this.camera, this.camera.aspect, { horizontalFovDeg: this.dashcam().fovDeg, barrel: GARMIN_BARREL })
      this.lens.render(this.renderer, this.scene)
    } else this.renderer.render(this.scene, this.camera)
    this.adaptResolution(now)
    this.publish()
  }

  // Every change of resolution is a visible jump (fine detail such as leaves
  // most of all), so it must not hunt: a level that could not hold the frame
  // rate is not tried again in this world, and changes wait for 3 s of frames.
  private adaptResolution(now: number) {
    if (!this.playing) { this.perfStart = 0; return }
    if (!this.perfStart) { this.perfStart = now; this.perfFrames = 0; return }
    this.perfFrames++
    if (now - this.perfStart < 3000) return
    const fps = this.perfFrames * 1000 / (now - this.perfStart)
    this.perfStart = 0
    const max = Math.min(this.ceiling, 2, window.devicePixelRatio || 1)
    let next = this.pixelRatio
    if (fps < 45 && this.pixelRatio > 1) {
      next = Math.max(1, this.pixelRatio - 0.25)
      this.ceiling = next
    } else if (fps > 58 && this.pixelRatio < max && now > this.raiseAfter) {
      next = Math.min(max, this.pixelRatio + 0.25)
      this.raiseAfter = now + 10_000
    }
    if (next !== this.pixelRatio) { this.pixelRatio = next; this.resize() }
  }

  private placeCars() {
    if (!this.lap || !this.world) { this.car.root.visible = this.ghostCar.root.visible = false; return }
    this.placeRig(this.car, this.lap, this.timeMs)
    this.car.root.visible = true
    if (this.ghost && this.timeMs <= this.ghost.durationMs) {
      this.placeRig(this.ghostCar, this.ghost, this.timeMs)
      this.ghostCar.root.visible = true
    } else this.ghostCar.root.visible = false
    // The driver's own body is in the way of the view from inside, but the
    // dashboard of a real model is the point: only the placeholder hides.
    if (this.car.body) this.car.body.visible = !(this.view === 'driver' && !this.model)
    this.car.shadow.visible = this.view !== 'driver' && this.view !== 'garmin'
  }

  private tmpForward = new THREE.Vector3()
  private tmpLeft = new THREE.Vector3()
  private tmpUp = new THREE.Vector3()
  private tmpMatrix = new THREE.Matrix4()
  private tmpQuat = new THREE.Quaternion()

  /** Pose a car on the road: height from the surface, pitch and roll from its slope. */
  private placeRig(rig: CarRig, lap: LapPath, timeMs: number) {
    const road = this.world!.road
    const pose = lap.pose(timeMs, rig.pose)
    const preset = this.preset
    const halfBase = (preset?.wheelbaseM ?? 2.4) / 2, halfTrack = ((preset?.widthM ?? 1.8) - 0.25) / 2
    const s = rig.hint = road.nearestFrom(pose.x, pose.z, road.stationAt(pose.dist), 12)
    const y = this.restOn(pose, s, halfBase, halfTrack, rig.root.quaternion)
    rig.root.position.set(pose.x, y, pose.z)
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
      this.pinch = { spread: this.spread(), dist: this.looks.chase.target.dist }
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
    if (this.view !== 'chase') return
    event.preventDefault()
    const target = this.looks.chase.target
    const step = event.deltaMode === 1 ? 0.06 : event.deltaMode === 2 ? 1 : 0.0015
    target.dist = clamp(target.dist * Math.exp(event.deltaY * step), CHASE_MIN_DIST, CHASE_MAX_DIST)
    this.lookChanged()
  }

  // A long press on a touch screen would open the context menu mid-drag.
  private onContextMenu = (event: Event) => { if (this.drag?.moved || this.pointers.size) event.preventDefault() }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.resizeObserver.disconnect()
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
    disposeObject(this.car.shadow); disposeObject(this.ghostCar.shadow)
    this.ghostShape.dispose()
    this.sky.geometry.dispose(); this.sky.material.dispose()
    this.envTarget?.dispose()
    this.renderer.dispose()
    canvas.remove()
  }
}
