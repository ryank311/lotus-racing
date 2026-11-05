// The replay's car dynamics: wheel detection (by name and by shape), the
// rolling and steering wheels, and the body on its springs, with the sign
// conventions checked on a synthetic left-hand turn (three.js runs headless).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CAR_PRESETS, type ReplayLap } from '../src/shared/replay'
import { LapPath } from '../src/renderer/replay/lapPath'
import { makeFrame, latAt, lonAt } from '../src/renderer/replay/geo'
import { buildPlaceholder, fittedModel } from '../src/renderer/replay/car'
import { rigModelWheels } from '../src/renderer/replay/wheels'
import { CarMotion } from '../src/renderer/replay/motion'

const DEG = Math.PI / 180
const EXIGE = CAR_PRESETS['LOTUS EXIGE']

// 400 m straight north, then a 60 m-radius left turn (west) at 20 m/s,
// braking at 1 g over the first 100 m; samples 1 m apart. Garmin's lateral
// is positive turning right, and PDR steering positive to the right.
function leftTurnLap(): ReplayLap {
  const frame = makeFrame({ south: 37, west: -79.01, north: 37.01, east: -79 })
  const R = 60, v = 20
  const lat: number[] = [], lon: number[] = [], dist: number[] = [], timeMs: number[] = [], accelX: number[] = [], accelY: number[] = [], steering: number[] = []
  for (let d = 0; d <= 700; d++) {
    let x: number, z: number
    if (d <= 400) { x = 0; z = -d } else { const a = (d - 400) / R; x = -R + R * Math.cos(a); z = -400 - R * Math.sin(a) }
    lat.push(latAt(frame, z)); lon.push(lonAt(frame, x))
    dist.push(d); timeMs.push(d / v * 1000)
    accelX.push(d < 100 ? -9.81 : 0)
    accelY.push(d > 405 ? -v * v / R : 0)
    steering.push(d > 405 ? -14 * Math.atan(2.3 / R) / DEG : 0)
  }
  const n = dist.length
  return {
    sessionGuid: 's', lap: 0, label: 'L1', durationMs: timeMs[n - 1], dist, timeMs, lat, lon,
    altM: dist.map(() => 0), speedMps: dist.map(() => v), accelX, accelY, headingDeg: dist.map(() => null),
    car: {
      sg: 's', lapIdx: 0, videoId: 'v', dist, videoT: dist.map(() => null), throttle: dist.map(() => 0), brake: dist.map(() => 0),
      rpm: dist.map(() => 0), gear: dist.map(() => 3), steering, slip: dist.map(() => 0), speed: dist.map(() => 72),
    },
  }
}

const flat = () => 0

test('a lap: curvature positive turning left, and the steering channel’s sign measured', () => {
  const path = new LapPath(leftTurnLap(), makeFrame({ south: 37, west: -79.01, north: 37.01, east: -79 }), 0)
  const pose = path.pose(path.timeAtDist(550)!)
  assert.ok(Math.abs(pose.curvature - 1 / 60) < 0.002, `curvature ${pose.curvature}`)
  assert.ok(Math.abs(path.pose(path.timeAtDist(200)!).curvature) < 1e-4, 'straight')
  assert.equal(path.steeringSign, -1, 'positive to the right')
  assert.ok(path.steeringAt(550)! > 0, 'read as positive left')
})

test('the placeholder: wheels roll by distance, fronts steer into the turn, the body leans out and dives', () => {
  const lap = new LapPath(leftTurnLap(), makeFrame({ south: 37, west: -79.01, north: 37.01, east: -79 }), 0)
  const car = buildPlaceholder(EXIGE, 0xff0000, null)
  const motion = CarMotion.find(car)!
  assert.ok(motion, 'rigged')
  const wheels = (motion as unknown as { wheels: Array<{ front: boolean; left: boolean; radiusM: number; spin: THREE.Object3D; steer: THREE.Object3D }> }).wheels
  const state = motion as unknown as { roll: number; pitch: number }

  // In the turn: a mean front angle of 14·atan(2.3/60)/14 from the channel, the inner (left) wheel more.
  let t = lap.timeAtDist(560)!
  motion.update(lap, t, lap.pose(t), EXIGE.dynamics, flat)
  const steerOf = (w: { steer: THREE.Object3D }) => 2 * Math.asin(w.steer.quaternion.y)
  const fl = wheels.find(w => w.front && w.left)!, fr = wheels.find(w => w.front && !w.left)!, rl = wheels.find(w => !w.front && w.left)!
  assert.ok(steerOf(fl) > steerOf(fr) && steerOf(fr) > 0, `left ${steerOf(fl) / DEG}°, right ${steerOf(fr) / DEG}°`)
  assert.ok(Math.abs((steerOf(fl) + steerOf(fr)) / 2 - Math.atan(2.3 / 60)) < 0.3 * DEG)
  assert.equal(steerOf(rl), 0, 'rears do not steer')
  // Leaning out of a left turn: the left side up (positive about +z), ~1°/g.
  const g = 400 / 60 / 9.80665
  assert.ok(Math.abs(state.roll - EXIGE.dynamics.rollDegPerG * g * DEG) < 0.05 * DEG, `roll ${state.roll / DEG}°`)

  // Rolling: the spin about the car's +x is distance / radius.
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (lap.pose(t).dist / rl.radiusM) % (2 * Math.PI))
  assert.ok(rl.spin.quaternion.angleTo(spin) < 1e-6)

  // Braking at 1 g: nose down (positive about +x) by the dive gradient.
  t = lap.timeAtDist(80)!
  motion.update(lap, t, lap.pose(t), EXIGE.dynamics, flat)
  assert.ok(Math.abs(state.pitch - EXIGE.dynamics.diveDegPerG * DEG) < 0.05 * DEG, `pitch ${state.pitch / DEG}°`)
  assert.ok(Math.abs(state.roll) < 0.01 * DEG)

  // Paused: the same time again changes nothing; played up to a time = seeked there.
  const before = state.pitch
  motion.update(lap, t, lap.pose(t), EXIGE.dynamics, flat)
  assert.equal(state.pitch, before)
  const T = lap.timeAtDist(420)!
  for (let s = T - 3000; s <= T; s += 1000 / 60) motion.update(lap, s, lap.pose(s), EXIGE.dynamics, flat)
  motion.update(lap, T, lap.pose(T), EXIGE.dynamics, flat)
  const played = state.roll
  motion.rest()
  motion.update(lap, T, lap.pose(T), EXIGE.dynamics, flat)
  assert.ok(Math.abs(played - state.roll) < 1e-4 * DEG, `played ${played / DEG}°, seeked ${state.roll / DEG}°`)
})

// A model in the shape of an uploaded one: a body, all four tyres in one
// mesh (as some models merge them), a rim per wheel and a caliper; nose −z.
function model(names: boolean): THREE.Group {
  const root = new THREE.Group()
  const named = (o: THREE.Object3D, name: string) => { o.name = names ? name : 'Object'; return o }
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.4), new THREE.MeshStandardMaterial())
  body.position.y = 0.6
  root.add(named(body, 'Body'))
  const r = 0.33, corners = [[0.8, -1.35], [-0.8, -1.35], [0.8, 1.4], [-0.8, 1.4]]
  const tyres = corners.map(([x, z]) => {
    const tyre = new THREE.TorusGeometry(r - 0.08, 0.08, 12, 32)
    tyre.rotateY(Math.PI / 2)
    tyre.translate(x, r, z)
    return tyre
  })
  // One merged geometry for the four tyres.
  const merged = new THREE.BufferGeometry()
  const positions: number[] = [], indices: number[] = []
  for (const g of tyres) {
    const base = positions.length / 3
    positions.push(...(g.attributes.position.array as Float32Array))
    for (const i of g.index!.array as ArrayLike<number>) indices.push(base + i)
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  merged.setIndex(indices)
  root.add(named(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ name: names ? 'Tyre_Rubber' : 'material' })), 'Tyres'))
  for (const [x, z] of corners) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.1, r - 0.1, 0.05, 16).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial())
    rim.position.set(x, r, z)
    root.add(named(rim, 'Rim'))
  }
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.08), new THREE.MeshStandardMaterial())
  caliper.position.set(0.72, r + 0.15, -1.35)
  root.add(named(caliper, 'Brake_Caliper'))
  return root
}

for (const names of [true, false]) {
  test(`an uploaded model: four wheels found by ${names ? 'name' : 'shape'}, split from a merged mesh and rigged`, () => {
    const fitted = fittedModel(model(names), { yawDeg: 180, lengthM: 4.4, offsetM: [0, 0, 0], eyeM: [0.3, 1, 0] })
    const report = rigModelWheels(fitted)
    assert.ok(report.ok, report.reason)
    assert.equal(report.method, names ? 'names' : 'shape')
    for (const w of report.wheels) assert.ok(Math.abs(w.radiusM - 0.33) < 0.01, `${w.corner} r ${w.radiusM}`)
    // Yaw 180: the model's −z wheels are the front ones, its +x on the car's right.
    const fl = report.wheels.find(w => w.corner === 'fl')!
    assert.ok(fl.centreM[2] > 1 && fl.centreM[0] > 0.7, `fl at ${fl.centreM}`)
    const motion = CarMotion.find(fitted)!
    assert.ok(motion)
    // The caliper steers with its wheel but does not roll.
    let caliper: THREE.Object3D | null = null
    fitted.traverse(o => { if (o.name === 'Brake_Caliper') caliper = o })
    if (names) assert.equal((caliper as THREE.Object3D | null)?.parent?.userData.carRig, 'steer')
    // A second call reports the rig already there.
    assert.ok(rigModelWheels(fitted).ok)
  })
}

test('a model without wheels stays static', () => {
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 4.4), new THREE.MeshStandardMaterial()))
  const fitted = fittedModel(root, { yawDeg: 0, lengthM: 4.4, offsetM: [0, 0, 0], eyeM: [0.3, 1, 0] })
  const report = rigModelWheels(fitted)
  assert.equal(report.ok, false)
  assert.equal(CarMotion.find(fitted), null)
})
