// The sun's shadows in three maps, each a directional light's shadow so any
// three.js material takes them:
//
// - car: the sun itself. Its map follows the car and holds only the cars
//   (CAR_LAYER), small and sharp, drawn every frame for next to nothing.
// - region: the world's casters (trees, stands, barriers; WORLD_LAYER) in a
//   few hundred metres ahead of the camera, drawn again only when the camera
//   has moved well inside it. Snapped to whole texels in the light's frame,
//   so its shadows never swim.
// - far: the same casters over the whole track, drawn once per sun.
//
// The region and far lights sit on a layer the view never draws, so no
// material lights with them or pays for them: their maps are drawn by a
// pass of their own (render()) and read only by the world's shaders
// (surfaces.ts, WORLD_SHADOW_UNIFORMS), which multiply the car's shadow by
// the world's, region where it reaches and far beyond. Other materials (the
// car) see the car map only.

import * as THREE from 'three'

/** The world maps, for the world's shaders: depth maps, their matrices, (size, bias, radius, intensity) and normal bias. */
export const WORLD_SHADOW_UNIFORMS = {
  uRegionMap: { value: null as THREE.Texture | null },
  uRegionMatrix: { value: new THREE.Matrix4() },
  uRegionShadow: { value: new THREE.Vector4(1, 0, 1, 0) },
  uRegionNormalBias: { value: 0 },
  uFarMap: { value: null as THREE.Texture | null },
  uFarMatrix: { value: new THREE.Matrix4() },
  uFarShadow: { value: new THREE.Vector4(1, 0, 1, 0) },
  uFarNormalBias: { value: 0 },
}

export interface ShadowQuality {
  /** The car map: texels, and the side of the square it covers (m). */
  carSize: number
  carSpanM: number
  /** The region map: texels and side (m). */
  regionSize: number
  regionSpanM: number
  /** The far map's texels; 0 for none. */
  farSize: number
}

export const SHADOW_QUALITY: Record<'high' | 'medium', ShadowQuality> = {
  high: { carSize: 1024, carSpanM: 24, regionSize: 2048, regionSpanM: 300, farSize: 2048 },
  medium: { carSize: 512, carSpanM: 24, regionSize: 1024, regionSpanM: 240, farSize: 0 },
}

/** Layers the shadow cameras draw (the view draws layer 0, which every object keeps). */
export const WORLD_LAYER = 2
export const CAR_LAYER = 3
/** The world maps' lights: only their own shadow pass sees them. */
const PASS_LAYER = 31
// The tallest world casters (trees of ~35 m): the region's light sits just far
// enough up the sun's ray to catch their tops.
const TALLEST_M = 38
const FAR_BACK_M = 1600
const tmp = new THREE.Vector3(), forward = new THREE.Vector3()
const basis = new THREE.Matrix4(), inverse = new THREE.Matrix4()
const ORIGIN = new THREE.Vector3()

/** The world's shadow casters: drawn by the region and far shadow cameras. */
export function markWorldCasters(root: THREE.Object3D) {
  root.traverse(object => { if ((object as THREE.Mesh).isMesh && object.castShadow) object.layers.enable(WORLD_LAYER) })
}

/**
 * A car's meshes: solid parts cast into the car map and take shadows. Glass
 * does neither (it would cast a solid shadow, and from the seat the
 * windscreen covers the whole view: shadow lookups there cost the most).
 */
export function markCarCasters(root: THREE.Object3D) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const glass = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(m => m.transparent)
    mesh.castShadow = !glass
    mesh.receiveShadow = !glass
    if (!glass) mesh.layers.enable(CAR_LAYER)
  })
}

export class SunShadows {
  /** The sun: lights the world, its shadow map holds the cars. */
  readonly near = new THREE.DirectionalLight(0xffffff, 1)
  /** The world's shadows around the camera (no light of its own). */
  readonly region = new THREE.DirectionalLight(0xffffff, 0)
  /** The world's shadows over the whole track (no light of its own). */
  readonly far = new THREE.DirectionalLight(0xffffff, 0)
  private dir = new THREE.Vector3(0, 1, 0)
  private quality: ShadowQuality = SHADOW_QUALITY.high
  private bounds: THREE.Box3 | null = null
  private softness = 1
  private strength = 1
  private regionBack = 200
  private regionCentre: THREE.Vector3 | null = null
  // The world maps' pass: a camera that sees only their lights, into a 1 × 1 target.
  private passCamera = new THREE.PerspectiveCamera()
  private passTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })

  constructor(parent: THREE.Object3D) {
    for (const light of [this.near, this.region, this.far]) {
      light.castShadow = true
      light.shadow.camera.near = 1
    }
    parent.add(this.near, this.near.target)
    // The world maps' lights: on a layer only their own pass's camera draws.
    for (const light of [this.region, this.far]) {
      light.layers.set(PASS_LAYER)
      parent.add(light, light.target)
    }
    this.passCamera.layers.set(PASS_LAYER)
    this.near.name = 'sun'
    this.region.name = 'sun-region-shadow'
    this.far.name = 'sun-far-shadow'
    this.near.shadow.camera.layers.set(CAR_LAYER)
    this.region.shadow.camera.layers.set(WORLD_LAYER)
    this.far.shadow.camera.layers.set(WORLD_LAYER)
    this.region.shadow.autoUpdate = false
    this.far.shadow.autoUpdate = false
    this.setQuality(this.quality)
  }

  setQuality(quality: ShadowQuality) {
    this.quality = quality
    const resize = (shadow: THREE.LightShadow, size: number) => {
      size = Math.max(1, size)
      if (shadow.mapSize.x === size) return
      shadow.mapSize.set(size, size)
      shadow.map?.dispose(); shadow.map = null
    }
    resize(this.near.shadow, quality.carSize)
    resize(this.region.shadow, quality.regionSize)
    resize(this.far.shadow, quality.farSize)
    const square = (camera: THREE.OrthographicCamera, span: number) => {
      Object.assign(camera, { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2 })
      camera.updateProjectionMatrix()
    }
    square(this.near.shadow.camera, quality.carSpanM)
    square(this.region.shadow.camera, quality.regionSpanM)
    this.regionCentre = null
    this.configure()
    this.fitFar()
  }

  /** Sun direction (towards the sun), and how strong (0 none – 1 sunshine) and soft (0–1) its shadows are. */
  setSun(direction: THREE.Vector3, strength: number, softness: number) {
    this.dir.copy(direction).normalize()
    this.strength = Math.min(1, strength)
    this.softness = softness
    // Up the ray only as far as the tallest caster's top can be: a low sun reaches further.
    this.regionBack = Math.min(800, TALLEST_M / Math.max(0.05, this.dir.y) + 20)
    const region = this.region.shadow.camera
    region.near = 1
    region.far = this.regionBack + 160
    region.updateProjectionMatrix()
    const car = this.near.shadow.camera
    car.near = 1
    car.far = 60
    car.updateProjectionMatrix()
    this.regionCentre = null
    this.configure()
    this.fitFar()
  }

  private configure() {
    const q = this.quality
    // Without a sun worth the name the maps stop drawing (there is nothing to see).
    const on = this.strength > 0.02
    this.near.shadow.autoUpdate = on
    this.near.shadow.intensity = this.strength
    this.region.shadow.intensity = on ? this.strength : 0
    this.far.shadow.intensity = on && q.farSize ? this.strength * 0.9 : 0
    const set = (shadow: THREE.LightShadow, span: number, size: number, radius: number) => {
      shadow.radius = radius
      shadow.normalBias = span / Math.max(1, size) * 1.5
      shadow.bias = -0.00005
    }
    set(this.near.shadow, q.carSpanM, q.carSize, 1.5 + 5 * this.softness)
    set(this.region.shadow, q.regionSpanM, q.regionSize, 1.5 + 4 * this.softness)
    set(this.far.shadow, 1, 1, 1.5 + 2 * this.softness)
  }

  /** The world's extent, for the far map (null: none). */
  setBounds(bounds: THREE.Box3 | null) {
    this.bounds = bounds?.clone() ?? null
    this.regionCentre = null
    // The far map's strength comes back with a world (fitFar zeroes it without one).
    this.configure()
    this.fitFar()
  }

  /** Square the far map's camera around the world, seen from the sun. */
  private fitFar() {
    const far = this.far.shadow
    if (!this.bounds || this.bounds.isEmpty() || !this.quality.farSize) { far.intensity = 0; return }
    const centre = this.bounds.getCenter(new THREE.Vector3())
    this.far.position.copy(centre).addScaledVector(this.dir, FAR_BACK_M)
    this.far.target.position.copy(centre)
    this.far.updateMatrixWorld(); this.far.target.updateMatrixWorld()
    basis.lookAt(this.dir, ORIGIN, THREE.Object3D.DEFAULT_UP)
    inverse.copy(basis).transpose()
    const box = new THREE.Box3()
    const { min, max } = this.bounds
    for (let i = 0; i < 8; i++) box.expandByPoint(tmp.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(inverse))
    const half = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2 + 5
    const cam = far.camera
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 1, far: FAR_BACK_M * 2 })
    cam.updateProjectionMatrix()
    far.normalBias = (2 * half / this.quality.farSize) * 1.5
    far.needsUpdate = true
  }

  /** Draw the world's maps again (the world or the sun changed). */
  refresh() {
    this.regionCentre = null
    this.far.shadow.needsUpdate = !!this.quality.farSize
  }

  /** A point snapped to whole texels of a map in the light's frame (rotation only). */
  private snap(point: THREE.Vector3, texel: number) {
    basis.lookAt(this.dir, ORIGIN, THREE.Object3D.DEFAULT_UP)
    inverse.copy(basis).transpose()
    point.applyMatrix4(inverse)
    point.x = Math.round(point.x / texel) * texel
    point.y = Math.round(point.y / texel) * texel
    return point.applyMatrix4(basis)
  }

  /**
   * Per frame: the car map on the car; the region map ahead of the camera,
   * moved (and drawn again) only once the camera has left its middle.
   */
  follow(camera: THREE.Camera, car: THREE.Vector3 | null) {
    const q = this.quality
    const focus = this.snap(tmp.copy(car ?? camera.position), q.carSpanM / q.carSize)
    this.near.target.position.copy(focus)
    this.near.position.copy(focus).addScaledVector(this.dir, 30)
    this.near.updateMatrixWorld(); this.near.target.updateMatrixWorld()
    // The region: centred ahead of the camera (where the view looks).
    camera.getWorldDirection(forward)
    forward.y = 0
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1)
    forward.normalize()
    const ahead = tmp.copy(camera.position).addScaledVector(forward, q.regionSpanM * 0.22)
    const recentre = !this.regionCentre || Math.hypot(ahead.x - this.regionCentre.x, ahead.z - this.regionCentre.z) > q.regionSpanM * 0.2
    if (!recentre || this.region.shadow.intensity === 0) return
    const centre = this.snap(ahead.clone(), q.regionSpanM / q.regionSize)
    this.regionCentre = centre
    this.region.target.position.copy(centre)
    this.region.position.copy(centre).addScaledVector(this.dir, this.regionBack)
    this.region.updateMatrixWorld(); this.region.target.updateMatrixWorld()
    this.region.shadow.needsUpdate = true
  }

  /** Before the frame: draw the world maps that are due, and hand them to the world's shaders. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    if (this.region.shadow.needsUpdate || this.far.shadow.needsUpdate) {
      // A render of nothing but these lights: three draws their due shadow maps first.
      const target = renderer.getRenderTarget()
      renderer.setRenderTarget(this.passTarget)
      renderer.render(scene, this.passCamera)
      renderer.setRenderTarget(target)
    }
    const u = WORLD_SHADOW_UNIFORMS
    const hand = (light: THREE.DirectionalLight, map: { value: THREE.Texture | null }, matrix: { value: THREE.Matrix4 }, params: { value: THREE.Vector4 }, normalBias: { value: number }) => {
      const shadow = light.shadow
      const depth = shadow.map?.depthTexture ?? null
      map.value = depth
      matrix.value.copy(shadow.matrix)
      params.value.set(shadow.mapSize.x, shadow.bias, shadow.radius, depth ? shadow.intensity : 0)
      normalBias.value = shadow.normalBias
    }
    hand(this.region, u.uRegionMap, u.uRegionMatrix, u.uRegionShadow, u.uRegionNormalBias)
    hand(this.far, u.uFarMap, u.uFarMatrix, u.uFarShadow, u.uFarNormalBias)
  }

  dispose() {
    for (const light of [this.near, this.region, this.far]) {
      light.shadow.dispose()
      light.removeFromParent(); light.target.removeFromParent()
    }
    WORLD_SHADOW_UNIFORMS.uRegionMap.value = WORLD_SHADOW_UNIFORMS.uFarMap.value = null
    this.passTarget.dispose()
  }
}
