// The car: an uploaded .glb fitted into the car frame (+y up, +z forward,
// +x the driver's left), or a low-poly placeholder from the car's real
// dimensions. The ghost is the same shape in translucent cyan.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CarModelFit, CarPreset } from '../../shared/replay'

export async function parseGlb(buffer: ArrayBuffer): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().parseAsync(buffer, '')
  const root = gltf.scene
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = material as THREE.MeshPhysicalMaterial
      const glass = m.transmission > 0 || (m.transparent && /glass|window|windscreen|windshield/i.test(`${m.name} ${mesh.name}`))
      if (!glass) continue
      // Glass by transmission costs a second render of the whole scene each
      // frame; plain transparency looks the same at this size. Light, fairly
      // opaque glass fogs the driver's view, so it is tinted and thinned.
      m.transmission = 0
      m.transparent = true
      m.opacity = Math.min(m.opacity, 0.22)
      m.depthWrite = false
      if (m.color && m.color.r + m.color.g + m.color.b > 1.5) m.color.setScalar(0.12)
    }
  })
  return root
}

/**
 * Wraps a model so its nose points +z, its wheels sit on y = 0, it is
 * centred on x/z and its length is fit.lengthM. Refit by calling again.
 */
export function applyFit(fitted: THREE.Group, fit: CarModelFit) {
  const yawGroup = fitted.children[0] as THREE.Group
  fitted.position.set(0, 0, 0)
  fitted.scale.setScalar(1)
  fitted.rotation.set(0, 0, 0)
  yawGroup.rotation.set(0, fit.yawDeg * Math.PI / 180, 0)
  fitted.updateMatrixWorld(true)
  // The bounds relative to the fitted group (it may already sit in a scene).
  const inverse = fitted.matrixWorld.clone().invert()
  const box = new THREE.Box3()
  yawGroup.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    mesh.geometry.computeBoundingBox()
    const local = mesh.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld))
    box.union(local)
  })
  if (box.isEmpty()) return
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3())
  const s = fit.lengthM / Math.max(1e-6, size.z)
  fitted.scale.setScalar(s)
  fitted.position.set(-centre.x * s + fit.offsetM[0], -box.min.y * s + fit.offsetM[1], -centre.z * s + fit.offsetM[2])
}

export function fittedModel(model: THREE.Object3D, fit: CarModelFit): THREE.Group {
  const fitted = new THREE.Group(), yawGroup = new THREE.Group()
  fitted.name = 'fitted-model'
  yawGroup.add(model)
  fitted.add(yawGroup)
  applyFit(fitted, fit)
  return fitted
}

/** Model length, width and height after fitting (metres). */
export function fittedSize(fitted: THREE.Object3D): THREE.Vector3 {
  const parent = fitted.parent
  fitted.removeFromParent()
  fitted.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(fitted).getSize(new THREE.Vector3())
  parent?.add(fitted)
  return size
}

export function ghostMaterial(color: THREE.ColorRepresentation): THREE.Material {
  return new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.38, emissive: new THREE.Color(color).multiplyScalar(0.35) })
}

/** A copy sharing geometry, in one translucent material. */
export function ghostCopy(model: THREE.Object3D, material: THREE.Material): THREE.Object3D {
  const copy = model.clone(true)
  copy.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) { mesh.material = material; mesh.renderOrder = 3 }
  })
  return copy
}

/** A low-poly mid-engined coupé from the car's real dimensions. */
export function buildPlaceholder(preset: CarPreset, paint: THREE.ColorRepresentation, ghost: THREE.Material | null): THREE.Group {
  const { lengthM: L, widthM: W, heightM: H, wheelbaseM: WB } = preset
  const group = new THREE.Group()
  group.name = 'placeholder-car'
  const body = ghost ?? new THREE.MeshStandardMaterial({ color: paint, roughness: 0.35, metalness: 0.2 })
  const glass = ghost ?? new THREE.MeshStandardMaterial({ color: 0x0d1217, roughness: 0.1, metalness: 0.4 })
  const dark = ghost ?? new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.8 })
  const rim = ghost ?? new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.8 })
  const bevel = 0.05

  // Side profiles in (forward, up), extruded across the car.
  const profile = (points: Array<[number, number]>, width: number, material: THREE.Material) => {
    const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z * L, y * H)))
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 })
    geometry.translate(0, 0, -(width - 2 * bevel) / 2)
    // Shape x → car +z, extrusion → car x.
    geometry.rotateY(-Math.PI / 2)
    const mesh = new THREE.Mesh(geometry, material)
    group.add(mesh)
    return mesh
  }
  profile([[-0.49, 0.2], [0.46, 0.15], [0.49, 0.27], [0.44, 0.4], [0.17, 0.52], [-0.3, 0.58], [-0.49, 0.56]], W, body)
  profile([[0.17, 0.5], [-0.3, 0.56], [-0.26, 0.98], [-0.04, 0.98]], W * 0.76, glass)
  // A rear wing on posts.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.03, 0.26), dark)
  wing.position.set(0, 0.8 * H, -0.45 * L)
  group.add(wing)
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2 * H, 0.08), dark)
    post.position.set(side * W * 0.25, 0.7 * H, -0.45 * L)
    group.add(post)
  }
  // Wheels.
  const radius = 0.27 * H, track = W - 0.24
  const tyre = new THREE.CylinderGeometry(radius, radius, 0.23, 20)
  tyre.rotateZ(Math.PI / 2)
  const hub = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.235, 12)
  hub.rotateZ(Math.PI / 2)
  for (const axle of [WB / 2 + 0.06, -WB / 2 + 0.06]) for (const side of [-1, 1]) {
    const wheel = new THREE.Mesh(tyre, dark)
    wheel.position.set(side * track / 2, radius, axle)
    const disc = new THREE.Mesh(hub, rim)
    disc.position.copy(wheel.position)
    group.add(wheel, disc)
  }
  group.traverse(o => { if ((o as THREE.Mesh).isMesh && ghost) (o as THREE.Mesh).renderOrder = 3 })
  return group
}

/** A soft dark patch under the car, in place of real shadows. */
export function blobShadow(lengthM: number, widthM: number): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const g = canvas.getContext('2d')!
  const gradient = g.createRadialGradient(32, 32, 4, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(0,0,0,0.75)')
  gradient.addColorStop(0.6, 'rgba(0,0,0,0.45)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = gradient
  g.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  const geometry = new THREE.PlaneGeometry(widthM * 1.35, lengthM * 1.2)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }))
  mesh.position.y = 0.03
  mesh.renderOrder = 1
  mesh.name = 'shadow'
  return mesh
}

export function disposeGeometry(root: THREE.Object3D) {
  root.traverse(object => (object as THREE.Mesh).geometry?.dispose())
}

/** Frees every geometry, material and texture under an object. */
export function disposeObject(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m)
  })
  for (const material of materials) {
    for (const value of Object.values(material)) if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose()
    material.dispose()
  }
}
