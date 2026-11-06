// The car: an uploaded .glb fitted into the car frame (+y up, +z forward,
// +x the driver's left), or a low-poly placeholder from the car's real
// dimensions. The ghost is the same shape in translucent cyan.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CarModelFit, CarPreset } from '../../shared/replay'
import { rigFrame } from './wheels'
import { fittedTextures, replayProfile } from './budget'
import { parseGltf } from './ktx2'

export async function parseGlb(buffer: ArrayBuffer): Promise<THREE.Group> {
  const loader = new GLTFLoader()
  // On a constrained device the images decode at most this size (budget.ts): a 4096² livery is 85 MB on the GPU.
  // KTX2 textures are capped the same, by their mip levels (ktx2.ts).
  const { textureMax, decodeConcurrency } = replayProfile()
  if (Number.isFinite(textureMax.car)) loader.register(parser => fittedTextures(parser, textureMax.car, decodeConcurrency))
  const gltf = await parseGltf(loader, buffer, textureMax.car)
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

/**
 * Another driver's car is drawn solid, like a real car; a faint glow of its
 * colour over the paint (strength 0: none) tells it from yours. Materials
 * that light themselves (lamps) keep their own glow.
 */
export function tintCar(root: THREE.Object3D, color: THREE.ColorRepresentation, strength: number) {
  const tint = new THREE.Color(color).multiplyScalar(strength)
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = material as THREE.MeshStandardMaterial
      if (!m.isMeshStandardMaterial || m.emissiveMap || m.transparent) continue
      const base = (m.userData.baseEmissive ??= m.emissive.clone()) as THREE.Color
      m.emissive.copy(base).add(tint)
    }
  })
}

/**
 * A name tag over a car (another driver's): a pill in their colour, the
 * same size on screen however far away, drawn over everything so it marks
 * the car through trees and from the seat. Its bottom edge sits at the
 * sprite's position.
 */
export function nameTag(text: string, color: THREE.ColorRepresentation): THREE.Sprite {
  const ratio = 2, fontPx = 26 * ratio, padX = 16 * ratio, dot = 9 * ratio, pointer = 9 * ratio
  const canvas = document.createElement('canvas')
  const g = canvas.getContext('2d')!
  const font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`
  g.font = font
  const label = text.length > 24 ? `${text.slice(0, 23)}…` : text
  const width = Math.ceil(padX * 2 + dot + 10 * ratio + g.measureText(label).width), pill = Math.round(fontPx * 1.55)
  canvas.width = width + 4; canvas.height = pill + pointer + 4
  const css = `#${new THREE.Color(color).getHexString()}`
  g.font = font
  g.fillStyle = 'rgba(10, 10, 12, 0.82)'
  g.strokeStyle = css
  g.lineWidth = 2 * ratio
  g.beginPath()
  g.roundRect(2, 2, width, pill, pill / 2)
  g.moveTo(2 + width / 2 - pointer, 2 + pill)
  g.lineTo(2 + width / 2, 2 + pill + pointer)
  g.lineTo(2 + width / 2 + pointer, 2 + pill)
  g.fill(); g.stroke()
  g.fillStyle = css
  g.beginPath(); g.arc(2 + padX + dot / 2, 2 + pill / 2, dot / 2, 0, Math.PI * 2); g.fill()
  g.fillStyle = '#f2f2f4'
  g.textBaseline = 'middle'
  g.fillText(label, 2 + padX + dot + 10 * ratio, 2 + pill / 2 + ratio)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false, fog: false })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  // About 4% of the view's height.
  const h = 0.042
  sprite.scale.set(h * canvas.width / canvas.height, h, 1)
  sprite.renderOrder = 10
  sprite.name = 'name-tag'
  return sprite
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
  const radius = 0.27 * H, track = W - 0.24, tyreWidth = 0.23
  const axles = [WB / 2 + 0.06, -WB / 2 + 0.06]
  // The body's outline with an arch over each axle: a circle a little
  // bigger than the tyre, kept under the bonnet and the deck.
  const top: Array<[number, number]> = [[0.49, 0.27], [0.44, 0.4], [0.17, 0.52], [-0.3, 0.58], [-0.49, 0.56]]
  const bottomAt = (z: number) => (0.2 + (0.15 - 0.2) * (z / L + 0.49) / 0.95) * H
  const topAt = (z: number) => {
    for (let i = 1; i < top.length; i++) {
      const [z0, y0] = top[i - 1], [z1, y1] = top[i]
      if (z / L <= z0 && z / L >= z1) return (y0 + (y1 - y0) * (z / L - z0) / (z1 - z0)) * H
    }
    return 0.4 * H
  }
  // (The extrusion's bevel grows the outline, so the arch is cut that much wider.)
  const archRadius = radius + 0.04 + bevel
  const arch = (z: number): Array<[number, number]> => {
    const from = Math.asin(Math.max(-1, Math.min(1, (bottomAt(z) - radius) / archRadius)))
    return Array.from({ length: 15 }, (_, i) => {
      const a = Math.PI - from - (Math.PI - 2 * from) * i / 14, at = z + archRadius * Math.cos(a)
      return [at / L, Math.min(radius + archRadius * Math.sin(a), topAt(at) - 0.07) / H] as [number, number]
    })
  }
  profile([[-0.49, 0.2], ...arch(axles[1]), ...arch(axles[0]), [0.46, 0.15], ...top], W, body)
  profile([[0.17, 0.5], [-0.3, 0.56], [-0.26, 0.98], [-0.04, 0.98]], W * 0.76, glass)
  for (const z of axles) {
    // Dark wheel wells between the arches, so they do not show through.
    const before = z - archRadius, after = z + archRadius
    const low = bottomAt(z), high = Math.min(radius + archRadius, topAt(before), topAt(z), topAt(after)) - 0.06
    const well = new THREE.Mesh(new THREE.BoxGeometry(track - tyreWidth - 0.06, high - low, 2 * archRadius), dark)
    well.position.set(0, (low + high) / 2, z)
    group.add(well)
    // A wing over a tyre that stands taller than the bonnet.
    const base = Math.min(topAt(before), topAt(z), topAt(after)) - 0.06, peak = 2 * radius + 0.04
    if (peak < base + 0.08) continue
    const hump = Array.from({ length: 11 }, (_, i) => [(z - 0.85 * archRadius * Math.cos(Math.PI * i / 10)) / L, (base + (peak - base) * Math.sin(Math.PI * i / 10)) / H] as [number, number])
    for (const side of [-1, 1]) profile(hump, tyreWidth + 0.08, body).position.x = side * track / 2
  }
  // A rear wing on posts.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.03, 0.26), dark)
  wing.position.set(0, 0.8 * H, -0.45 * L)
  group.add(wing)
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2 * H, 0.08), dark)
    post.position.set(side * W * 0.25, 0.7 * H, -0.45 * L)
    group.add(post)
  }
  // Wheels on the rig (wheels.ts), the body on its springs: a tyre and a
  // five-hole rim on the outer face, so the roll shows.
  const tyre = new THREE.CylinderGeometry(radius, radius, tyreWidth, 24)
  tyre.rotateZ(Math.PI / 2)
  const rimShape = new THREE.Shape().absarc(0, 0, radius * 0.66, 0, Math.PI * 2, false)
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5
    rimShape.holes.push(new THREE.Path().absarc(Math.cos(a) * radius * 0.38, Math.sin(a) * radius * 0.38, radius * 0.15, 0, Math.PI * 2, true))
  }
  const rimDepth = 0.015
  const rimDisc = new THREE.ExtrudeGeometry(rimShape, { depth: rimDepth, bevelEnabled: false, curveSegments: 12 })
  // Its face in the car's y–z plane, its thickness along +x.
  rimDisc.rotateY(Math.PI / 2)
  const corners = [[0, 1], [0, -1], [1, 1], [1, -1]] as const
  const wheels = rigFrame(group, corners.map(([axle, side]) => ({ centre: new THREE.Vector3(side * track / 2, radius, axles[axle]), radius })))
  wheels.forEach(({ spin }, i) => {
    const side = corners[i][1]
    const face = new THREE.Mesh(rimDisc, rim)
    face.position.x = side > 0 ? tyreWidth / 2 + 0.002 : -tyreWidth / 2 - 0.002 - rimDepth
    spin.add(new THREE.Mesh(tyre, dark), face)
  })
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
