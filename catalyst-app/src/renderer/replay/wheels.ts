// Wheels that roll and steer, and a body on springs. At load time a car
// model's four wheel assemblies are found and hung on pivots at the wheel
// centres, and the rest of the model on a "sprung" node; motion.ts turns and
// leans them each frame. The rig lives inside the model's own root, so
// refitting, the ghost's copy (userData tags survive clone()) and disposal
// all carry it along.
//
//   frame (the model's root, or the placeholder)  userData.carRig = 'frame'
//   ├─ sprung   the body: everything the model had (matrix set by motion.ts)
//   └─ hub ×4   at a wheel centre, unsprung; userData.radius = tyre radius
//      └─ steer   turns about up: calipers and the like
//         └─ spin    rolls about the axle: tyre, rim, disc
//
// Finding the wheels: by name first (tyre/tire/rim/wheel/disc… roll,
// caliper steers only), split by corner where one mesh holds all four;
// else by shape: round, ground-touching tyres at the four corners and the
// parts inside them. Measured in the car frame (metres; +y up, +z forward,
// +x the driver's left).

import * as THREE from 'three'

export const RIG = 'carRig'
export type Corner = 'fl' | 'fr' | 'rl' | 'rr'
const CORNERS: Corner[] = ['fl', 'fr', 'rl', 'rr']

export interface WheelReport {
  ok: boolean
  method: 'names' | 'hint' | 'shape' | null
  reason?: string
  wheels: Array<{ corner: Corner; radiusM: number; centreM: [number, number, number]; parts: string[] }>
}

/** A wheel's place in the rig's frame: its centre and tyre radius, frame units. */
export interface HubSpec { centre: THREE.Vector3; radius: number }

/**
 * Puts a frame's current children on a sprung node and adds four hubs
 * (fl, fr, rl, rr). Returns each hub's spin and steer nodes, for the parts.
 */
export function rigFrame(frame: THREE.Object3D, hubs: HubSpec[]): Array<{ hub: THREE.Group; steer: THREE.Group; spin: THREE.Group }> {
  const sprung = new THREE.Group()
  sprung.name = 'sprung'
  sprung.userData[RIG] = 'sprung'
  sprung.matrixAutoUpdate = false
  for (const child of [...frame.children]) sprung.add(child)
  frame.add(sprung)
  frame.userData[RIG] = 'frame'
  return hubs.map((spec, i) => {
    const hub = new THREE.Group(), steer = new THREE.Group(), spin = new THREE.Group()
    hub.name = `wheel-${CORNERS[i]}`; steer.name = 'steer'; spin.name = 'spin'
    hub.position.copy(spec.centre)
    hub.userData[RIG] = 'hub'; hub.userData.radius = spec.radius; hub.userData.corner = CORNERS[i]
    steer.userData[RIG] = 'steer'; spin.userData[RIG] = 'spin'
    hub.add(steer); steer.add(spin); frame.add(hub)
    return { hub, steer, spin }
  })
}

// ─── Detection ─────────────────────────────────────────────────────────────

type Kind = 'rotating' | 'fixed' | null

interface Part {
  mesh: THREE.Mesh
  toCar: THREE.Matrix4
  kind: Kind
  pos: Float32Array | null
  /** Vertex indices, three per triangle. */
  tri: Uint32Array | null
  /** Per triangle: −1 the body, else wheel·2 (+1 when it steers but does not roll). */
  owner: Int8Array | null
}

interface Bounds { min: THREE.Vector3; max: THREE.Vector3; cx: number; cz: number; L: number; W: number; H: number }
interface Circle { x: number; y: number; z: number; r: number }

const words = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean)
const ROLLING = /^(wheels?|whl|tyres?|tires?|rims?|discs?|disks?|rotors?|spokes?|lugs?|lugnuts?|hubcaps?|valve)$|^(wheel|tyre|tire)/
// A steering wheel, a spare and the wheel arches are not wheels.
const NOT_WHEEL = /^(steering|steer|arch|arches|wells?|liners?|flares?|fenders?|spare|guards?|mudflaps?)$|^wheel(arch|well|house|liner|guard)/
const materials = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean)

function partLabel(mesh: THREE.Mesh, frame: THREE.Object3D): string {
  const names = [mesh.name]
  for (let o = mesh.parent, k = 0; o && o !== frame && k < 3; o = o.parent, k++) names.push(o.name)
  for (const m of materials(mesh)) names.push(m.name)
  return names.filter(Boolean).join(' ')
}

function kindOf(label: string, pattern: RegExp | null): Kind {
  const w = words(label)
  if (w.some(x => x.startsWith('calip'))) return 'fixed'
  if (pattern) return pattern.test(label) ? 'rotating' : null
  if (w.some(x => NOT_WHEEL.test(x))) return null
  return w.some(x => ROLLING.test(x)) ? 'rotating' : null
}

function positions(part: Part): Float32Array {
  if (part.pos) return part.pos
  const attr = part.mesh.geometry.attributes.position
  const out = new Float32Array(attr.count * 3), v = new THREE.Vector3()
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix4(part.toCar)
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z
  }
  return (part.pos = out)
}

function triangles(part: Part): Uint32Array {
  if (part.tri) return part.tri
  const geometry = part.mesh.geometry, index = geometry.index
  const total = index ? index.count : geometry.attributes.position.count
  const start = Math.max(0, geometry.drawRange.start), end = Math.min(total, start + geometry.drawRange.count)
  const count = Math.max(0, Math.floor((end - start) / 3) * 3)
  const out = new Uint32Array(count)
  for (let k = 0; k < count; k++) out[k] = index ? index.getX(start + k) : start + k
  part.tri = out
  part.owner = new Int8Array(count / 3).fill(-1)
  return out
}

// Index of a corner: fl 0, fr 1, rl 2, rr 3.
const cornerAt = (b: Bounds, x: number, z: number) => (z > b.cz ? 0 : 2) + (x > b.cx ? 0 : 1)

// A part of one wheel: low, at a corner, and not much bigger than a wheel.
function atCorner(box: THREE.Box3, b: Bounds): boolean {
  const cx = (box.min.x + box.max.x) / 2 - b.cx, cz = (box.min.z + box.max.z) / 2 - b.cz
  return box.max.y < b.min.y + 0.8 * b.H && box.min.y < b.min.y + 0.45 * b.H
    && Math.abs(cx) > 0.25 * b.W / 2 && Math.abs(cz) > 0.25 * b.L / 2
    && box.max.x - box.min.x < 0.45 * b.W && box.max.y - box.min.y < 0.7 * b.H && box.max.z - box.min.z < 0.35 * b.L
}

/** Four wheel circles, or why they are not a car's wheels. */
function checkCircles(circles: Array<Circle | undefined>, b: Bounds): string | null {
  if (circles.some(c => !c)) return `wheels found at ${circles.filter(Boolean).length} of 4 corners`
  const [fl, fr, rl, rr] = circles as Circle[]
  for (const c of circles as Circle[]) {
    if (c.r < 0.15 || c.r > 0.6) return `a tyre radius of ${c.r.toFixed(2)} m`
    if (Math.abs(c.y - b.min.y - c.r) > 0.35 * c.r) return `a wheel centre ${(c.y - b.min.y).toFixed(2)} m up for a ${c.r.toFixed(2)} m tyre`
  }
  if (Math.abs(fl.z - fr.z) > 0.05 * b.L || Math.abs(rl.z - rr.z) > 0.05 * b.L) return 'the axles are skewed'
  if (Math.abs(fl.x + fr.x - 2 * b.cx) > 0.1 * b.W || Math.abs(rl.x + rr.x - 2 * b.cx) > 0.1 * b.W) return 'the wheels are off centre'
  const base = (fl.z + fr.z - rl.z - rr.z) / 2
  if (base < 0.4 * b.L || base > 0.85 * b.L) return `a wheelbase of ${base.toFixed(2)} m on a ${b.L.toFixed(2)} m car`
  if (Math.abs(fl.r / fr.r - 1) > 0.1 || Math.abs(rl.r / rr.r - 1) > 0.1) return 'left and right tyres differ'
  return null
}

// By name: the named parts' triangles by corner; each corner's circle from
// its largest rolling part (the tyre, or the rim when tyres are unnamed).
// Unnamed parts inside a wheel join it too (discs and calipers merged into
// other meshes).
function byNames(parts: Part[], b: Bounds): { circles: Circle[] } | string {
  const named = parts.filter(p => p.kind)
  if (!named.length) return 'no parts named as wheels'
  const biggest: Array<THREE.Box3 | undefined> = []
  const v = new THREE.Vector3()
  const split = new Map<Part, { boxes: THREE.Box3[]; corner: Int8Array }>()
  for (const part of named) {
    const pos = positions(part), tri = triangles(part), owner = part.owner!
    const boxes = [0, 1, 2, 3].map(() => new THREE.Box3())
    const corner = new Int8Array(tri.length / 3)
    for (let t = 0; t < tri.length / 3; t++) {
      let x = 0, z = 0
      for (let c = 0; c < 3; c++) { const k = tri[t * 3 + c] * 3; x += pos[k]; z += pos[k + 2] }
      const q = corner[t] = cornerAt(b, x / 3, z / 3)
      for (let c = 0; c < 3; c++) { const k = tri[t * 3 + c] * 3; boxes[q].expandByPoint(v.set(pos[k], pos[k + 1], pos[k + 2])) }
    }
    const usable = boxes.map(box => !box.isEmpty() && atCorner(box, b))
    for (let t = 0; t < corner.length; t++) owner[t] = usable[corner[t]] ? corner[t] * 2 + (part.kind === 'fixed' ? 1 : 0) : -1
    split.set(part, { boxes, corner })
    if (part.kind !== 'rotating') continue
    boxes.forEach((box, q) => {
      if (!usable[q]) return
      const size = box.max.y - box.min.y, now = biggest[q]
      if (!now || size > now.max.y - now.min.y) biggest[q] = box
    })
  }
  const circles = biggest.map(box => box && {
    x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2,
    r: Math.max(box.max.y - box.min.y, box.max.z - box.min.z) / 2,
  })
  const round = biggest.every(box => !box || Math.abs(Math.log((box.max.y - box.min.y) / Math.max(1e-6, box.max.z - box.min.z))) < 0.25)
  const problem = round ? checkCircles(circles, b) : 'the named wheel parts are not round'
  if (problem) return problem
  // A named part outside its corner's wheel (trim in a wheel-named material) stays on the body.
  for (const [part, { boxes, corner }] of split) {
    const outside = boxes.map((box, q) => !box.isEmpty() && !insideWheel(box, circles[q]!, biggest[q]!, b))
    for (let t = 0; t < corner.length; t++) if (outside[corner[t]]) part.owner![t] = -1
  }
  gather(piecesOf(parts.filter(p => !p.kind), b), b, circles as Circle[], biggest as THREE.Box3[])
  return { circles: circles as Circle[] }
}

/** Connected pieces of a mesh (vertices welded at 2 mm): a piece id per triangle. */
function pieceIds(pos: Float32Array, tri: Uint32Array): Int32Array {
  const keys = new Map<string, number>(), weld = new Int32Array(pos.length / 3)
  for (let v = 0; v < weld.length; v++) {
    const key = `${Math.round(pos[v * 3] * 500)},${Math.round(pos[v * 3 + 1] * 500)},${Math.round(pos[v * 3 + 2] * 500)}`
    let id = keys.get(key)
    if (id == null) keys.set(key, id = keys.size)
    weld[v] = id
  }
  const parent = new Int32Array(keys.size)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (i: number) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  for (let t = 0; t < tri.length; t += 3) {
    const a = find(weld[tri[t]]), b = find(weld[tri[t + 1]]), c = find(weld[tri[t + 2]])
    parent[b] = a; parent[find(c)] = a
  }
  const out = new Int32Array(tri.length / 3)
  for (let t = 0; t < out.length; t++) out[t] = find(weld[tri[t * 3]])
  return out
}

interface Piece { part: Part; box: THREE.Box3; tris: number[] }

/** Within a wheel: inside the tyre's circle, from just outside its face to a little inboard of it. */
function insideWheel(box: THREE.Box3, c: Circle, tyre: THREE.Box3, b: Bounds): boolean {
  const reach = c.r * 1.04
  return box.min.y >= c.y - reach && box.max.y <= c.y + reach && box.min.z >= c.z - reach && box.max.z <= c.z + reach
    && (c.x > b.cx ? box.min.x >= tyre.min.x - 0.2 && box.max.x <= tyre.max.x + 0.03 : box.max.x <= tyre.max.x + 0.2 && box.min.x >= tyre.min.x - 0.03)
}

/** The connected pieces of the parts in the lower half of the car. */
function piecesOf(parts: Part[], b: Bounds): Piece[] {
  const all: Piece[] = []
  const low = new THREE.Box3(), v = new THREE.Vector3()
  for (const part of parts) {
    low.copy(part.mesh.geometry.boundingBox!).applyMatrix4(part.toCar)
    if (low.min.y > b.min.y + 0.5 * b.H) continue
    const pos = positions(part), tri = triangles(part), ids = pieceIds(pos, tri)
    const byId = new Map<number, Piece>()
    for (let t = 0; t < ids.length; t++) {
      let piece = byId.get(ids[t])
      if (!piece) byId.set(ids[t], piece = { part, box: new THREE.Box3(), tris: [] })
      piece.tris.push(t)
      for (let c = 0; c < 3; c++) { const k = tri[t * 3 + c] * 3; piece.box.expandByPoint(v.set(pos[k], pos[k + 1], pos[k + 2])) }
    }
    all.push(...byId.values())
  }
  return all
}

// Every piece inside a wheel joins it: within the tyre's circle, from just
// outside its face to a little inboard (discs, hubs, calipers). What rolls:
// parts named so, the outer half (rim faces, spokes, nuts) and whatever is
// round and on the axle (tyre, disc, hub). The rest only steers (calipers,
// uprights), as do parts named as calipers.
function gather(pieces: Piece[], b: Bounds, circles: Circle[], tyres: THREE.Box3[]) {
  for (const piece of pieces) {
    const box = piece.box
    const q = cornerAt(b, (box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2), c = circles[q]
    if (!insideWheel(box, c, tyres[q], b)) continue
    const x = (box.min.x + box.max.x) / 2, outer = c.x > b.cx ? x > c.x : x < c.x
    const centred = Math.hypot((box.min.y + box.max.y) / 2 - c.y, (box.min.z + box.max.z) / 2 - c.z) < 0.25 * c.r
    const round = Math.abs(Math.log((box.max.y - box.min.y + 1e-3) / (box.max.z - box.min.z + 1e-3))) < 0.36
    const kind = piece.part.kind
    const rolls = kind === 'rotating' || (kind !== 'fixed' && (outer || (centred && round)))
    for (const t of piece.tris) piece.part.owner![t] = q * 2 + (rolls ? 0 : 1)
  }
}

// By shape: each corner's tyre is the biggest round, ground-touching,
// disc-shaped piece there, and the pieces inside it join it.
function byShape(parts: Part[], b: Bounds): { circles: Circle[] } | string {
  const all = piecesOf(parts, b)
  const tyres: Array<{ piece: Piece; circle: Circle } | undefined> = []
  for (const piece of all) {
    const box = piece.box, d = box.max.y - box.min.y, dz = box.max.z - box.min.z, dx = box.max.x - box.min.x
    if (d < 0.3 || d > 1.1 || dz / d < 0.85 || dz / d > 1.18 || dx < 0.08 * d || dx > 0.7 * d) continue
    if (box.min.y - b.min.y > 0.12 * d || !atCorner(box, b)) continue
    const circle = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2, r: d / 2 }
    // Round, not boxy: every vertex within the circle (a square's corners are 41% out).
    const pos = piece.part.pos!, tri = piece.part.tri!
    let out = 0
    for (const t of piece.tris) for (let c = 0; c < 3; c++) {
      const k = tri[t * 3 + c] * 3
      out = Math.max(out, Math.hypot(pos[k + 1] - circle.y, pos[k + 2] - circle.z))
    }
    if (out > circle.r * 1.06) continue
    const q = cornerAt(b, circle.x, circle.z), now = tyres[q]
    if (!now || circle.r > now.circle.r) tyres[q] = { piece, circle }
  }
  const circles = [0, 1, 2, 3].map(q => tyres[q]?.circle)
  const problem = checkCircles(circles, b)
  if (problem) return problem
  gather(all, b, circles as Circle[], tyres.map(t => t!.piece.box))
  return { circles: circles as Circle[] }
}

// ─── Splitting meshes ──────────────────────────────────────────────────────

function copyAttribute(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, order: Int32Array): THREE.BufferAttribute {
  const size = attr.itemSize
  const interleaved = (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
  const source = (interleaved ? (attr as THREE.InterleavedBufferAttribute).data.array : (attr as THREE.BufferAttribute).array) as Float32Array
  const stride = interleaved ? (attr as THREE.InterleavedBufferAttribute).data.stride : size
  const offset = interleaved ? (attr as THREE.InterleavedBufferAttribute).offset : 0
  // The source's own array type (and its normalisation) is kept.
  const out = new (source.constructor as Float32ArrayConstructor)(order.length * size)
  for (let k = 0; k < order.length; k++) for (let c = 0; c < size; c++) out[k * size + c] = source[order[k] * stride + offset + c]
  const copy = new THREE.BufferAttribute(out, size, attr.normalized)
  copy.name = attr.name
  return copy
}

/** A geometry of some of a geometry's triangles (ascending ids), with only the vertices they use. */
function subGeometry(source: THREE.BufferGeometry, tri: Uint32Array, list: number[]): THREE.BufferGeometry {
  const remap = new Int32Array(source.attributes.position.count).fill(-1)
  const index = new Uint32Array(list.length * 3)
  let used = 0
  list.forEach((t, k) => {
    for (let c = 0; c < 3; c++) {
      const v = tri[t * 3 + c]
      if (remap[v] < 0) remap[v] = used++
      index[k * 3 + c] = remap[v]
    }
  })
  const order = new Int32Array(used)
  remap.forEach((to, from) => { if (to >= 0) order[to] = from })
  const out = new THREE.BufferGeometry()
  out.name = source.name
  for (const [name, attr] of Object.entries(source.attributes)) out.setAttribute(name, copyAttribute(attr, order))
  out.setIndex(new THREE.BufferAttribute(used > 65535 ? index : Uint16Array.from(index), 1))
  // Material groups: a group's triangles stay together (the list is ascending).
  const offset = source.drawRange.start
  for (const group of source.groups) {
    let first = -1, count = 0
    list.forEach((t, k) => {
      const at = offset + t * 3
      if (at >= group.start && at < group.start + group.count) { if (first < 0) first = k; count++ }
    })
    if (count) out.addGroup(first * 3, count * 3, group.materialIndex)
  }
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

// ─── Rigging a model ───────────────────────────────────────────────────────

/**
 * Finds a fitted model's wheels (fittedModel's group: fitted → yaw → the
 * model's root) and rigs them. On failure the model is left as it was. A
 * model rigged before reports its wheels again.
 */
export function rigModelWheels(fitted: THREE.Object3D, hints: { pattern?: string } = {}): WheelReport {
  const frame = fitted.children[0]?.children[0]
  const fail = (reason: string): WheelReport => ({ ok: false, method: null, reason, wheels: [] })
  if (!frame) return fail('no model')
  fitted.updateWorldMatrix(true, true)
  const carFromWorld = fitted.parent ? fitted.parent.matrixWorld.clone().invert() : new THREE.Matrix4()
  const carFromFrame = carFromWorld.clone().multiply(frame.matrixWorld)
  if (frame.userData[RIG] === 'frame') return report(frame, carFromFrame, frame.userData.wheelsFoundBy ?? null, new Map())

  let pattern: RegExp | null = null
  if (hints.pattern) try { pattern = new RegExp(hints.pattern, 'i') } catch { /* an invalid hint is ignored */ }
  const parts: Part[] = []
  const bounds = new THREE.Box3()
  frame.traverse(object => {
    const mesh = object as THREE.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean }
    const geometry = mesh.geometry
    if (!mesh.isMesh || !geometry?.attributes.position) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const toCar = carFromWorld.clone().multiply(mesh.matrixWorld)
    bounds.union(geometry.boundingBox!.clone().applyMatrix4(toCar))
    // Skinned and instanced meshes draw from bones and instances, and morphs move vertices: they stay on the body.
    if (mesh.isSkinnedMesh || mesh.isInstancedMesh || Object.keys(geometry.morphAttributes).length) return
    const label = partLabel(mesh, frame)
    parts.push({ mesh, toCar, kind: kindOf(label, pattern), pos: null, tri: null, owner: null })
  })
  if (bounds.isEmpty()) return fail('no meshes')
  const b: Bounds = {
    min: bounds.min, max: bounds.max, cx: (bounds.min.x + bounds.max.x) / 2, cz: (bounds.min.z + bounds.max.z) / 2,
    L: bounds.max.z - bounds.min.z, W: bounds.max.x - bounds.min.x, H: bounds.max.y - bounds.min.y,
  }

  let method: WheelReport['method'] = pattern ? 'hint' : 'names'
  let found = byNames(parts, b)
  if (typeof found === 'string') {
    const byName = found
    for (const part of parts) part.owner?.fill(-1)
    method = 'shape'
    found = byShape(parts, b)
    if (typeof found === 'string') return fail(`by name: ${byName}; by shape: ${found}`)
  }

  // Rig: hubs at the circles' centres, then each wheel's triangles moved
  // onto them (whole meshes where they can be, split pieces where not).
  const frameFromCar = carFromFrame.clone().invert(), unit = 1 / carFromFrame.getMaxScaleOnAxis()
  const nodes = rigFrame(frame, found.circles.map(c => ({ centre: new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(frameFromCar), radius: c.r * unit })))
  frame.updateMatrixWorld(true)
  const names = new Map<number, Set<string>>()
  const target = (owner: number) => {
    const set = names.get(owner >> 1) ?? new Set<string>()
    names.set(owner >> 1, set)
    return { node: owner & 1 ? nodes[owner >> 1].steer : nodes[owner >> 1].spin, set }
  }
  for (const part of parts) {
    if (!part.owner || !part.owner.some(o => o >= 0)) continue
    const mesh = part.mesh, lists = new Map<number, number[]>()
    part.owner.forEach((o, t) => { let list = lists.get(o); if (!list) lists.set(o, list = []); list.push(t) })
    // The most telling of its names, for the report.
    const label = [mesh.name, mesh.parent?.name, ...materials(mesh).map(m => m.name)].find(n => n && words(n).some(w => ROLLING.test(w) || w.startsWith('calip'))) || mesh.name || mesh.parent?.name || 'mesh'
    if (lists.size === 1 && !lists.has(-1)) {
      const { node, set } = target(part.owner[0])
      node.attach(mesh)
      set.add(label)
      continue
    }
    for (const [owner, list] of lists) {
      if (owner < 0) continue
      const piece = mesh.clone(false)
      piece.geometry = subGeometry(mesh.geometry, part.tri!, list)
      piece.name = `${label} (${CORNERS[owner >> 1]})`
      mesh.parent!.add(piece)
      const { node, set } = target(owner)
      node.attach(piece)
      set.add(`${label} (split)`)
    }
    const rest = lists.get(-1)
    mesh.geometry = rest ? subGeometry(mesh.geometry, part.tri!, rest) : new THREE.BufferGeometry()
    if (!rest && !mesh.children.length) mesh.removeFromParent()
  }
  frame.userData.wheelsFoundBy = method
  return report(frame, carFromFrame, method, names)
}

function report(frame: THREE.Object3D, carFromFrame: THREE.Matrix4, method: WheelReport['method'], names: Map<number, Set<string>>): WheelReport {
  const scale = carFromFrame.getMaxScaleOnAxis()
  const hubs = frame.children.filter(c => c.userData[RIG] === 'hub')
  return {
    ok: hubs.length === 4, method,
    wheels: hubs.map((hub, i) => {
      const at = hub.position.clone().applyMatrix4(carFromFrame)
      return { corner: hub.userData.corner as Corner, radiusM: hub.userData.radius * scale, centreM: [at.x, at.y, at.z].map(v => Math.round(v * 1000) / 1000) as [number, number, number], parts: [...(names.get(i) ?? [])] }
    }),
  }
}
