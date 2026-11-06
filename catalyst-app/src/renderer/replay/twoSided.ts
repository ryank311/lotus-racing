// A car's see-through double-sided parts (glass, lamp lenses, badges; the
// other driver's whole car once it can fade), drawn as three.js draws them
// without what that costs each frame.
//
// three draws a transparent DoubleSide material in two passes, back faces
// then front (WebGLRenderer.renderObject), flipping material.side and
// setting needsUpdate around each: every such material goes through a full
// program lookup twice a frame. Here such a mesh keeps the back faces (its
// material turned BackSide) and gets a child sharing its geometry that
// draws the front faces in a FrontSide copy of the material. The child sits
// exactly on its parent, so the two have the same depth in the transparent
// sort; transparentSort (installed on the renderer) puts the pair where the
// mesh alone would have been, back half first: the same draws, in the same
// order, as three's two passes. Tested in tests/replayTwoSided.test.ts.

import * as THREE from 'three'

/** On the front-face half of a split mesh (userData survives clone()). */
export const FRONT_HALF = 'frontHalf'

const isFrontHalf = (object: THREE.Object3D) => object.userData[FRONT_HALF] === true && !!object.parent

/** Drawn by three in two passes. A shader material is left so: its copy would have uniforms of its own. */
function twoPass(material: THREE.Material): boolean {
  return material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass && !(material as THREE.ShaderMaterial).isShaderMaterial
}

// One material, one draw, nothing that depends on the object drawn: a copy of it draws the same.
function plainMesh(object: THREE.Object3D): object is THREE.Mesh {
  const mesh = object as THREE.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean }
  return !!mesh.isMesh && !mesh.isSkinnedMesh && !mesh.isInstancedMesh && !mesh.isBatchedMesh && !Array.isArray(mesh.material)
    && !Object.keys(mesh.geometry?.morphAttributes ?? {}).length
    && mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender && mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender
}

/**
 * Split the double-sided see-through meshes under `root` (once: a split
 * mesh's material is BackSide after). Returns each material split and its
 * front-face copy, so what changes the material later (a fade) changes both.
 * A material that something else under `root` also uses (several materials
 * on one mesh, a skinned mesh…) is left to three's two passes.
 */
export function splitDoubleSided(root: THREE.Object3D): Map<THREE.Material, THREE.Material> {
  const users = new Map<THREE.Material, THREE.Mesh[]>()
  const leave = new Set<THREE.Material>()
  root.traverse(object => {
    const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (!material || isFrontHalf(object)) return
    const plain = plainMesh(object)
    for (const m of Array.isArray(material) ? material : [material]) {
      if (!twoPass(m)) continue
      if (!plain) { leave.add(m); continue }
      let meshes = users.get(m)
      if (!meshes) users.set(m, meshes = [])
      meshes.push(object as THREE.Mesh)
    }
  })
  const fronts = new Map<THREE.Material, THREE.Material>()
  for (const [material, meshes] of users) {
    if (leave.has(material)) continue
    const front = frontCopy(material)
    material.side = THREE.BackSide
    // Its shadow (where it casts) still from both faces, as a double-sided material's is; the front half casts none.
    if (material.shadowSide === null) material.shadowSide = THREE.DoubleSide
    material.needsUpdate = true
    for (const mesh of meshes) mesh.add(frontHalf(mesh, front))
    fronts.set(material, front)
  }
  return fronts
}

function frontCopy(material: THREE.Material): THREE.Material {
  const front = material.clone()
  front.side = THREE.FrontSide
  // clone() leaves out the shader hooks, and copies userData through JSON (a Color would become a number).
  front.onBeforeCompile = material.onBeforeCompile
  front.customProgramCacheKey = material.customProgramCacheKey
  front.onBeforeRender = material.onBeforeRender
  front.userData = { ...material.userData }
  return front
}

function frontHalf(mesh: THREE.Mesh, material: THREE.Material): THREE.Mesh {
  const half = new THREE.Mesh(mesh.geometry, material)
  half.name = mesh.name
  half.userData[FRONT_HALF] = true
  half.renderOrder = mesh.renderOrder
  half.frustumCulled = mesh.frustumCulled
  half.layers.mask = mesh.layers.mask
  half.receiveShadow = mesh.receiveShadow
  half.castShadow = false
  return half
}

/**
 * Take the front halves out from under `root` (a copy given a material of
 * its own, or before freeing it: they share their parents' geometry).
 * Returns their materials, for the caller to free when they are its own.
 */
export function removeFrontHalves(root: THREE.Object3D): Set<THREE.Material> {
  const halves: THREE.Mesh[] = []
  root.traverse(object => { if (object.userData[FRONT_HALF] === true) halves.push(object as THREE.Mesh) })
  const materials = new Set<THREE.Material>()
  for (const half of halves) {
    half.removeFromParent()
    materials.add(half.material as THREE.Material)
  }
  return materials
}

/** The fields of three's render items the transparent sort reads. */
export interface SortItem {
  id: number
  object: THREE.Object3D
  groupOrder: number
  renderOrder: number
  z: number
}

/**
 * three's transparent sort (WebGLRenderLists reversePainterSortStable:
 * group order, render order, far to near, object id) with a split mesh's
 * front half taking its parent's id and coming straight after it.
 */
export function transparentSort(a: SortItem, b: SortItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder
  if (a.z !== b.z) return b.z - a.z
  const frontA = isFrontHalf(a.object), frontB = isFrontHalf(b.object)
  const idA = frontA ? a.object.parent!.id : a.id, idB = frontB ? b.object.parent!.id : b.id
  if (idA !== idB) return idA - idB
  return (frontA ? 1 : 0) - (frontB ? 1 : 0)
}
