// A car's see-through double-sided parts split into back and front halves
// (src/renderer/replay/twoSided.ts): the transparent sort must give the same
// draws, in the same order, as three's two passes over the unsplit mesh.
// The sort itself is three's render list (WebGLRenderLists), fed as
// WebGLRenderer.projectObject feeds it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { WebGLRenderList } from 'three/src/renderers/webgl/WebGLRenderLists.js'
import { FRONT_HALF, removeFrontHalves, splitDoubleSided, transparentSort } from '../src/renderer/replay/twoSided'

interface Item { id: number; object: THREE.Object3D; material: THREE.Material; groupOrder: number; renderOrder: number; z: number }

// The transparent draws for a camera, as WebGLRenderer makes them: projectObject's
// items and depths, the render list's sort, and renderObject's two passes.
function transparentDraws(root: THREE.Object3D, camera: THREE.PerspectiveCamera, sort: ((a: Item, b: Item) => number) | null): string[] {
  root.updateMatrixWorld(true)
  camera.updateMatrixWorld()
  const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const list = new WebGLRenderList()
  list.init()
  const v = new THREE.Vector4()
  const project = (object: THREE.Object3D, groupOrder: number) => {
    if (!object.visible) return
    if (object.layers.test(camera.layers)) {
      if ((object as THREE.Group).isGroup) groupOrder = object.renderOrder
      else if ((object as THREE.Mesh).isMesh) {
        const mesh = object as THREE.Mesh
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
        v.copy(mesh.geometry.boundingSphere!.center as unknown as THREE.Vector4).applyMatrix4(mesh.matrixWorld).applyMatrix4(projScreen)
        if (Array.isArray(mesh.material)) {
          for (const group of mesh.geometry.groups) {
            const m = mesh.material[group.materialIndex!]
            if (m?.visible) list.push(mesh, mesh.geometry, m, groupOrder, v.z, group, camera)
          }
        } else if (mesh.material.visible) list.push(mesh, mesh.geometry, mesh.material, groupOrder, v.z, null, camera)
      }
    }
    for (const child of object.children) project(child, groupOrder)
  }
  project(root, 0)
  list.sort(null, sort)
  const draws: string[] = []
  for (const item of list.transparent as Item[]) {
    const name = item.object.userData[FRONT_HALF] ? item.object.parent!.name : item.object.name
    const m = item.material
    if (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) draws.push(`${name} back`, `${name} front`)
    else draws.push(`${name} ${m.side === THREE.BackSide ? 'back' : m.side === THREE.FrontSide ? 'front' : 'both'}`)
  }
  return draws
}

const glass = (opacity: number) => new THREE.MeshStandardMaterial({ color: 0x111111, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })

// A car-ish body: glass sharing a material, two parts on exactly the same spot
// (so the same depth), a badge drawn later, solid and single-sided parts, a
// multi-material mesh, a group with a render order, all turned about.
function body(): THREE.Group {
  const root = new THREE.Group()
  root.name = 'root'
  root.rotation.set(0.1, 0.7, -0.05)
  const screenGlass = glass(0.22)
  const add = (parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], at: [number, number, number], renderOrder = 0) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    mesh.position.set(...at)
    mesh.renderOrder = renderOrder
    parent.add(mesh)
    return mesh
  }
  add(root, 'windscreen', new THREE.BoxGeometry(1.4, 0.6, 0.02), screenGlass, [0, 1.1, 0.6])
  add(root, 'side window', new THREE.BoxGeometry(0.02, 0.4, 1), screenGlass, [0.8, 1.05, -0.2])
  const lens = new THREE.SphereGeometry(0.12, 8, 6)
  add(root, 'lamp left', lens, glass(0.5), [0.6, 0.7, 2.1])
  add(root, 'lamp left lens', lens, glass(0.3), [0.6, 0.7, 2.1])
  add(root, 'badge', new THREE.PlaneGeometry(0.2, 0.1), glass(1), [0, 0.8, 2.2], 1)
  add(root, 'body', new THREE.BoxGeometry(1.8, 0.8, 4.2), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }), [0, 0.6, 0])
  add(root, 'tail lamp', new THREE.BoxGeometry(0.3, 0.1, 0.05), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.6 }), [0.6, 0.8, -2.1])
  const multi = new THREE.BoxGeometry(0.5, 0.5, 0.5)
  multi.clearGroups(); multi.addGroup(0, 18, 0); multi.addGroup(18, 18, 1)
  const sharedTrim = glass(0.4)
  add(root, 'mirror', multi, [sharedTrim, glass(0.7)], [-0.9, 1, 0.9])
  add(root, 'trim', new THREE.BoxGeometry(0.5, 0.05, 0.05), sharedTrim, [-0.9, 1.2, 0.9])
  const wheel = new THREE.Group()
  wheel.renderOrder = 2
  wheel.position.set(-0.8, 0.3, 1.3)
  wheel.rotation.x = 0.4
  root.add(wheel)
  add(wheel, 'rim badge', new THREE.CircleGeometry(0.05, 12), glass(1), [-0.1, 0, 0])
  add(wheel, 'rim cover', new THREE.CircleGeometry(0.2, 12), glass(0.5), [-0.09, 0, 0])
  return root
}

const cameras = (): THREE.PerspectiveCamera[] => {
  const out: THREE.PerspectiveCamera[] = []
  for (const [x, y, z] of [[0, 2, -7], [5, 1.5, 3], [-3, 4, 6], [0.3, 1.2, 0.1], [-6, 0.5, -1], [2, 8, 0.5]] as const) {
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000)
    camera.position.set(x, y, z)
    camera.lookAt(0, 0.8, 0)
    out.push(camera)
  }
  return out
}

test('split meshes draw the same faces in the same order as three’s two passes', () => {
  const before = body(), after = body()
  splitDoubleSided(after)
  for (const camera of cameras()) {
    const expected = transparentDraws(before, camera, null)
    assert.deepEqual(transparentDraws(after, camera, transparentSort), expected)
    // The unsplit scene sorts as three's own sort does.
    assert.deepEqual(transparentDraws(before, camera, transparentSort), expected)
  }
})

test('without the pairing sort, two parts at the same depth would interleave', () => {
  const before = body(), after = body()
  splitDoubleSided(after)
  const camera = cameras()[0]
  const plain = transparentDraws(after, camera, null)
  assert.notDeepEqual(plain, transparentDraws(before, camera, null))
  const lamps = plain.filter(d => d.startsWith('lamp left'))
  assert.deepEqual(lamps, ['lamp left back', 'lamp left lens back', 'lamp left front', 'lamp left lens front'])
})

test('the front half copies the material whole and sits exactly on its mesh', () => {
  const root = body()
  const env = new THREE.Texture()
  const windscreen = root.getObjectByName('windscreen') as THREE.Mesh
  const material = windscreen.material as THREE.MeshStandardMaterial
  material.envMap = env
  material.envMapIntensity = 0.8
  material.emissive.set(0x050505)
  material.userData.baseEmissive = new THREE.Color(0x010203)
  windscreen.receiveShadow = true
  windscreen.layers.enable(3)
  const fronts = splitDoubleSided(root)
  const front = fronts.get(material) as THREE.MeshStandardMaterial
  assert.ok(front)
  assert.equal(material.side, THREE.BackSide)
  assert.equal(material.shadowSide, THREE.DoubleSide)
  assert.equal(front.side, THREE.FrontSide)
  assert.equal(front.opacity, 0.22)
  assert.equal(front.transparent, true)
  assert.equal(front.depthWrite, false)
  assert.equal(front.envMap, env)
  assert.equal(front.envMapIntensity, 0.8)
  assert.equal(front.emissive.getHex(), 0x050505)
  assert.ok((front.userData.baseEmissive as THREE.Color).isColor)
  // Both windscreen and side window share the material, and so the copy.
  const halves: THREE.Mesh[] = []
  root.traverse(o => { if (o.userData[FRONT_HALF]) halves.push(o as THREE.Mesh) })
  const screenHalf = windscreen.children.find(c => c.userData[FRONT_HALF]) as THREE.Mesh
  assert.equal(screenHalf.geometry, windscreen.geometry)
  assert.equal(screenHalf.material, front)
  assert.equal((root.getObjectByName('side window')!.children[0] as THREE.Mesh).material, front)
  assert.equal(screenHalf.castShadow, false)
  assert.equal(screenHalf.receiveShadow, true)
  assert.equal(screenHalf.layers.mask, windscreen.layers.mask)
  root.updateMatrixWorld(true)
  assert.deepEqual(screenHalf.matrixWorld.elements, windscreen.matrixWorld.elements)
  // Split: windscreen, side window, two lamps, badge, rim badge and cover. Kept: the solid body, the
  // single-sided tail lamp, the multi-material mirror and the trim sharing its material.
  assert.equal(halves.length, 7)
  assert.equal(root.getObjectByName('trim')!.children.length, 0)
  assert.equal(((root.getObjectByName('trim') as THREE.Mesh).material as THREE.Material).side, THREE.DoubleSide)
  assert.equal(((root.getObjectByName('body') as THREE.Mesh).material as THREE.Material).side, THREE.DoubleSide)
  // Once only.
  assert.equal(splitDoubleSided(root).size, 0)
  let count = 0
  root.traverse(o => { if (o.userData[FRONT_HALF]) count++ })
  assert.equal(count, 7)
})

test('a copy (the ghost) drops the halves; freeing takes them out first', () => {
  const root = body()
  const fronts = splitDoubleSided(root)
  const copy = root.clone(true)
  removeFrontHalves(copy)
  let left = 0
  copy.traverse(o => { if (o.userData[FRONT_HALF]) left++ })
  assert.equal(left, 0)
  // The original keeps its halves; taking them out returns their materials (the copies) to free.
  const materials = removeFrontHalves(root)
  assert.deepEqual(new Set(fronts.values()), materials)
})
