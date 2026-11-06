// The Garage's 3D model viewer: one car, fitted exactly as the replay fits it
// (replay/car.ts: turned, scaled to its length, centred on the ground and
// nudged), on a plain floor in neutral studio light with a studio
// environment for reflections. The driver's eye and the Garmin camera are
// marked, and the view can look through either one (the Garmin camera
// through the replay's lens) to check the fit.
//
// Drag orbits (mouse or one finger), the wheel or a pinch zooms, a
// double-click resets; looking through the eye or the camera, a drag turns
// the head. Frames are drawn only when something changes.
//
// Car frame: origin on the ground under the middle of the car, +y up, +z
// forward, +x the driver's LEFT (CarModelFit).

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { CarModelFit, CarPreset } from '../../shared/replay'
import { applyFit, blobShadow, buildPlaceholder, disposeObject, fittedModel, fittedSize } from '../replay/car'
import { LensPass } from '../replay/lens'
import { fullFit } from './carFit'

export type StudioView = 'orbit' | 'eye' | 'garmin'

// As the replay draws them (engine.ts): the driver's eyes rest 4° below
// level, and the Garmin lens bends straight lines this much (0–1).
const DRIVER_LOOK_DOWN_DEG = 4
const GARMIN_BARREL = 0.65
const PLACEHOLDER_PAINT = 0xff5e3a
const EYE_COLOR = 0x7dd3fc
const GARMIN_COLOR = 0xf5a623
const GPS_COLOR = 0x5dd17f
const DEG = Math.PI / 180
const TURN_AROUND = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0)
// The floor fades into this towards the horizon; the sky above it is lighter,
// so the horizon reads clearly when looking through the Garmin camera.
const FLOOR_FAR = new THREE.Color(0x17181c)
const SKY_HORIZON = new THREE.Color(0x4a4d57)
const SKY_TOP = new THREE.Color(0x101114)
const ORBIT_FOV = 32
// A default view from the front, on the driver's (left) side, a little above.
const ORBIT_AZIMUTH = 38 * DEG, ORBIT_POLAR = 72 * DEG

/** Where the eye, the Garmin camera and the data collector sit, and the lens: the fit's, else the vehicle preset's (as engine.ts). */
function cameraPoints(fit: CarModelFit | null, preset: CarPreset) {
  const full = fullFit(fit, preset)
  return { eye: full.eyeM, dashcam: full.dashcamM, fovDeg: full.dashcamFovDeg, pitchDeg: full.dashcamPitchDeg, gps: full.gpsM }
}

export class CarStudio {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.1, 3000)
  private controls: OrbitControls
  private env: THREE.WebGLRenderTarget
  private lens: LensPass | null = null
  private body: THREE.Object3D | null = null
  private bodyId: string | null = null
  private isModel = false
  private shadow = blobShadow(4, 1.8)
  private preset: CarPreset | null = null
  private fit: CarModelFit | null = null
  private markers = new THREE.Group()
  private eyeMarker = new THREE.Group()
  private garminMarker = new THREE.Group()
  // The data collector, with a drop line to the ground: where the lap's line runs under the car.
  private gpsMarker = new THREE.Group()
  private gpsDrop: THREE.Line
  private garminFrustum: THREE.LineSegments
  private labels: { eye: HTMLElement; garmin: HTMLElement; gps: HTMLElement }
  private view: StudioView = 'orbit'
  private look = { yaw: 0, pitch: 0 }
  private orbitPose: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null
  private drag: { id: number; x: number; y: number } | null = null
  private framed = false
  private dirty = true
  private frameHandle = 0
  private resizeObserver: ResizeObserver
  private disposed = false
  /** The fitted model's length, width and height (metres), after each fit. */
  onSize?: (size: { lengthM: number; widthM: number; heightM: number } | null) => void

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const canvas = this.renderer.domElement
    canvas.className = 'car-viewer-canvas'
    container.appendChild(canvas)

    // Studio: reflections from three's RoomEnvironment (neutral, like the
    // replay's car), a soft key light and sky fill, an endless floor.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.env = pmrem.fromScene(room, 0.04)
    room.dispose()
    pmrem.dispose()
    this.scene.environment = this.env.texture
    this.scene.environmentIntensity = 0.9
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(4, 9, 6)
    this.scene.add(key, new THREE.HemisphereLight(0xdfe6f0, 0x2a2b30, 0.5))
    this.scene.fog = new THREE.Fog(FLOOR_FAR, 30, 420)
    this.scene.add(this.sky(), this.floor())
    this.shadow.renderOrder = 1
    this.scene.add(this.shadow)

    // Markers draw over the car, so the eye inside the cabin shows.
    this.eyeMarker.add(this.dot(EYE_COLOR, 0.045), this.sightLine(EYE_COLOR, 0.6))
    this.garminFrustum = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMaterial(GARMIN_COLOR, 0.85))
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.055, 0.035), this.markerMaterial(GARMIN_COLOR))
    body.renderOrder = 20
    this.garminMarker.add(body, this.garminFrustum)
    this.gpsDrop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), this.lineMaterial(GPS_COLOR, 0.8))
    this.gpsDrop.renderOrder = 20
    this.gpsMarker.add(this.dot(GPS_COLOR, 0.04), this.gpsDrop)
    this.markers.add(this.eyeMarker, this.garminMarker, this.gpsMarker)
    this.scene.add(this.markers)
    const label = (text: string, kind: string) => {
      const el = document.createElement('span')
      el.className = `car-viewer-label ${kind}`
      el.textContent = text
      el.setAttribute('aria-hidden', 'true')
      container.appendChild(el)
      return el
    }
    this.labels = { eye: label('Eye', 'eye'), garmin: label('Garmin', 'garmin'), gps: label('GPS', 'gps') }

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.minDistance = 1.5
    this.controls.maxDistance = 22
    this.controls.maxPolarAngle = 88 * DEG
    this.controls.addEventListener('change', this.invalidate)

    canvas.addEventListener('dblclick', this.onDoubleClick)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('contextmenu', this.onContextMenu)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.frameHandle = requestAnimationFrame(this.frame)
  }

  // ── The car ─────────────────────────────────────────────────────────────

  /**
   * Shows a model (its parsed .glb, fitted by `fit`) or, without one, the
   * replay's placeholder at the preset's real size. `id` names the model,
   * so a fit meant for another model is not applied to this one.
   */
  setCar(model: THREE.Object3D | null, fit: CarModelFit | null, preset: CarPreset, id: string | null = null) {
    if (this.body) {
      this.scene.remove(this.body)
      disposeObject(this.body)
    }
    this.preset = preset
    this.isModel = !!(model && fit)
    this.fit = this.isModel ? fit : null
    this.bodyId = this.isModel ? id : null
    this.body = model && fit ? fittedModel(model, fit) : buildPlaceholder(preset, PLACEHOLDER_PAINT, null)
    this.scene.add(this.body)
    this.shadow.scale.set(preset.widthM / 1.8, 1, preset.lengthM / 4)
    if (!this.framed) { this.resetView(); this.framed = true }
    this.afterFit()
  }

  /** Refits the shown model in place (the fit editor's live preview). */
  setFit(fit: CarModelFit | null, id: string | null) {
    if (!this.isModel || !fit || id !== this.bodyId || !this.body) return
    this.fit = fit
    applyFit(this.body as THREE.Group, fit)
    this.afterFit()
  }

  setView(view: StudioView) {
    if (view === this.view) return
    // The orbit camera's place is kept while looking through the eye or camera.
    if (this.view === 'orbit') this.orbitPose = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone() }
    else if (view === 'orbit' && this.orbitPose) {
      this.camera.position.copy(this.orbitPose.position)
      this.camera.quaternion.copy(this.orbitPose.quaternion)
    }
    this.view = view
    this.look = { yaw: 0, pitch: 0 }
    this.controls.enabled = view === 'orbit'
    this.placeCamera()
  }

  setMarkers(visible: boolean) {
    this.markers.visible = visible
    this.invalidate()
  }

  /** Back to the default view: the whole car from the front left, or straight ahead through the eye or camera. */
  resetView() {
    if (this.view !== 'orbit') { this.look = { yaw: 0, pitch: 0 }; this.placeCamera(); return }
    const preset = this.preset
    const [L, W, H] = preset ? [preset.lengthM, preset.widthM, preset.heightM] : [4, 1.8, 1.2]
    const target = new THREE.Vector3(0, H * 0.42, 0)
    // Far enough that the car's length fits across a narrow view too.
    const vertical = ORBIT_FOV * DEG / 2, horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect)
    const radius = Math.hypot(L, W, H) / 2
    const distance = radius * 0.78 / Math.sin(Math.min(vertical, horizontal))
    this.controls.target.copy(target)
    this.camera.position.copy(target).add(new THREE.Vector3().setFromSphericalCoords(distance, ORBIT_POLAR, ORBIT_AZIMUTH))
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(target)
    this.controls.update()
    this.placeCamera()
  }

  private afterFit() {
    const preset = this.preset
    if (!preset) return
    const points = cameraPoints(this.fit, preset)
    this.eyeMarker.position.fromArray(points.eye)
    this.eyeMarker.rotation.set(DRIVER_LOOK_DOWN_DEG * DEG, 0, 0)
    this.garminMarker.position.fromArray(points.dashcam)
    this.garminMarker.rotation.set(points.pitchDeg * DEG, 0, 0)
    this.gpsMarker.position.fromArray(points.gps)
    this.gpsDrop.scale.y = Math.max(0.01, points.gps[1])
    this.setFrustum(points.fovDeg)
    if (this.body) {
      const size = fittedSize(this.body)
      this.onSize?.({ lengthM: size.z, widthM: size.x, heightM: size.y })
    }
    this.placeCamera()
  }

  // ── Cameras ─────────────────────────────────────────────────────────────

  private placeCamera() {
    const preset = this.preset
    if (this.view === 'orbit' || !preset) {
      this.camera.near = 0.1
      this.camera.fov = ORBIT_FOV
    } else {
      // Cameras look down −z, the car faces +z; the head turns relative to the car.
      const points = cameraPoints(this.fit, preset)
      const tilt = this.view === 'eye' ? -DRIVER_LOOK_DOWN_DEG * DEG : -points.pitchDeg * DEG
      this.camera.position.fromArray(this.view === 'eye' ? points.eye : points.dashcam)
      this.camera.quaternion.copy(TURN_AROUND)
        .multiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, this.look.yaw))
        .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, this.look.pitch + tilt))
      this.camera.near = 0.03
      // The replay's driver view: 100° across, 70–100° tall.
      this.camera.fov = Math.min(100, Math.max(70, 2 * Math.atan(Math.tan(50 * DEG) / Math.max(0.1, this.camera.aspect)) / DEG))
    }
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.placeCamera()
    this.render()
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  private invalidate = () => { this.dirty = true }

  private frame = () => {
    if (this.disposed) return
    this.frameHandle = requestAnimationFrame(this.frame)
    // Damping keeps the orbit moving for a moment after a drag.
    if (this.view === 'orbit') this.controls.update()
    if (!this.dirty) return
    this.dirty = false
    this.render()
  }

  private render() {
    if (this.disposed) return
    const looking = this.view !== 'orbit'
    // Looking through one, the other shows as a dot (the Garmin camera's frustum would clutter the view).
    this.eyeMarker.visible = this.view !== 'eye'
    this.garminMarker.visible = this.view !== 'garmin'
    this.garminFrustum.visible = !looking
    if (this.view === 'garmin' && this.preset) {
      this.lens ??= new LensPass()
      this.lens.configure(this.camera, this.camera.aspect, { horizontalFovDeg: cameraPoints(this.fit, this.preset).fovDeg, barrel: GARMIN_BARREL })
      this.lens.render(this.renderer, this.scene)
    } else this.renderer.render(this.scene, this.camera)
    this.placeLabel(this.labels.eye, this.eyeMarker, !looking)
    this.placeLabel(this.labels.garmin, this.garminMarker, !looking)
    this.placeLabel(this.labels.gps, this.gpsMarker, !looking)
  }

  private placeLabel(el: HTMLElement, marker: THREE.Object3D, show: boolean) {
    const at = marker.getWorldPosition(new THREE.Vector3()).project(this.camera)
    const visible = show && this.markers.visible && at.z < 1 && Math.abs(at.x) < 1 && Math.abs(at.y) < 1
    el.hidden = !visible
    if (!visible) return
    const x = (at.x + 1) / 2 * this.container.clientWidth, y = (1 - at.y) / 2 * this.container.clientHeight
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
  }

  // ── Looking around through the eye or the camera ────────────────────────

  private onPointerDown = (event: PointerEvent) => {
    if (this.view === 'orbit' || (event.pointerType === 'mouse' && event.button !== 0)) return
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent) => {
    const drag = this.drag
    if (!drag || drag.id !== event.pointerId) return
    // The world follows the pointer.
    const perPixel = this.camera.fov * DEG / Math.max(1, this.container.clientHeight)
    this.look.yaw = THREE.MathUtils.clamp(this.look.yaw + (event.clientX - drag.x) * perPixel, -160 * DEG, 160 * DEG)
    this.look.pitch = THREE.MathUtils.clamp(this.look.pitch + (event.clientY - drag.y) * perPixel, -70 * DEG, 70 * DEG)
    drag.x = event.clientX
    drag.y = event.clientY
    this.placeCamera()
  }

  private onPointerUp = (event: PointerEvent) => {
    if (this.drag?.id === event.pointerId) this.drag = null
  }

  private onDoubleClick = (event: MouseEvent) => {
    event.preventDefault()
    this.resetView()
  }

  private onContextMenu = (event: Event) => event.preventDefault()

  // ── Scenery and markers ─────────────────────────────────────────────────

  // A dome: lighter at the horizon, dark overhead; below the horizon the
  // colour the floor fades into.
  private sky(): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { horizon: { value: SKY_HORIZON }, top: { value: SKY_TOP }, ground: { value: FLOOR_FAR } },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 horizon; uniform vec3 top; uniform vec3 ground;
        varying vec3 vDir;
        void main() {
          float y = normalize(vDir).y;
          vec3 color = y < 0.0 ? ground : mix(horizon, top, smoothstep(0.0, 0.45, y));
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }`,
    })
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), material)
    dome.renderOrder = -1
    dome.frustumCulled = false
    dome.onBeforeRender = (_r, _s, camera) => dome.position.copy(camera.position)
    return dome
  }

  private floor(): THREE.Group {
    const group = new THREE.Group()
    const geometry = new THREE.CircleGeometry(1200, 96)
    geometry.rotateX(-Math.PI / 2)
    const floor = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x2a2c32, roughness: 0.9, metalness: 0 }))
    const grid = new THREE.GridHelper(20, 20, 0x5c5f6b, 0x41434c)
    grid.position.y = 0.002
    for (const m of Array.isArray(grid.material) ? grid.material : [grid.material]) { m.transparent = true; m.opacity = 0.45; m.depthWrite = false }
    group.add(floor, grid)
    return group
  }

  private markerMaterial(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false, fog: false })
  }

  private lineMaterial(color: number, opacity: number): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity, toneMapped: false, fog: false })
  }

  private dot(color: number, radius: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), this.markerMaterial(color))
    mesh.renderOrder = 20
    return mesh
  }

  // Where the eye looks: straight ahead (+z), 4° down (the group's tilt).
  private sightLine(color: number, length: number): THREE.Line {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, length)]), this.lineMaterial(color, 0.8))
    line.renderOrder = 20
    return line
  }

  // The Garmin lens's view: a 16:9 frustum along +z, as wide as its lens
  // (drawn rectilinear; the real lens bends it).
  private setFrustum(fovDeg: number) {
    const depth = 0.25
    const halfW = Math.tan(Math.min(80, fovDeg / 2) * DEG) * depth, halfH = halfW * 9 / 16
    const c = [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([x, y]) => new THREE.Vector3(x, y, depth))
    const o = new THREE.Vector3()
    const points = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]]
    this.garminFrustum.geometry.dispose()
    this.garminFrustum.geometry = new THREE.BufferGeometry().setFromPoints(points)
    this.garminFrustum.renderOrder = 20
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.resizeObserver.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('dblclick', this.onDoubleClick)
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.controls.dispose()
    disposeObject(this.scene)
    this.env.dispose()
    this.lens?.dispose()
    this.renderer.dispose()
    canvas.remove()
    this.labels.eye.remove()
    this.labels.garmin.remove()
    this.labels.gps.remove()
  }
}
