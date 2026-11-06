// "Align to track" (src/renderer/replay/align.ts): a lap whose GPS carries a
// constant offset is shifted back onto the road; a real excursion stays; the
// shift is bounded; LapPath moves as a whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import type { ReplayLap } from '../src/shared/replay'
import { TrackEdges, fitToRoad, MAX_SHIFT_M } from '../src/renderer/replay/align'
import { LapPath } from '../src/renderer/replay/lapPath'
import { makeFrame, latAt, lonAt } from '../src/renderer/replay/geo'

// A stadium: two 400 m straights joined by 60 m-radius turns, run
// anticlockwise seen from above (left turns), 11 m of tarmac.
const R = 60, STRAIGHT = 400, HALF = 5.5
const LENGTH = 2 * STRAIGHT + 2 * Math.PI * R
function centre(s: number): { x: number; z: number; lx: number; lz: number; inside: number } {
  s = ((s % LENGTH) + LENGTH) % LENGTH
  // Straight north (−z) along x = 0, the left turn round (−R, −STRAIGHT), straight south along x = −2R, the turn back.
  if (s < STRAIGHT) return { x: 0, z: -s, lx: -1, lz: 0, inside: 1 }
  s -= STRAIGHT
  if (s < Math.PI * R) { const a = s / R; return { x: -R + R * Math.cos(a), z: -STRAIGHT - R * Math.sin(a), lx: -Math.cos(a), lz: Math.sin(a), inside: 1 } }
  s -= Math.PI * R
  if (s < STRAIGHT) return { x: -2 * R, z: -STRAIGHT + s, lx: 1, lz: 0, inside: 1 }
  s -= STRAIGHT
  const a = s / R
  return { x: -R - R * Math.cos(a), z: R * Math.sin(a), lx: Math.cos(a), lz: -Math.sin(a), inside: 1 }
}

function edges(): TrackEdges {
  const left: number[] = [], right: number[] = []
  for (let s = 0; s < LENGTH; s += 3) {
    const c = centre(s)
    left.push(c.x + c.lx * HALF, c.z + c.lz * HALF); right.push(c.x - c.lx * HALF, c.z - c.lz * HALF)
  }
  return new TrackEdges(left, right)
}

// A racing line a metre apart: out wide (right) on the straights, to the
// inside (left) kerb at each apex, with the GPS a car's half width in from
// the edges; plus a constant GNSS offset.
function lap(offset: [number, number], excursion = false): { x: number[]; z: number[] } {
  const x: number[] = [], z: number[] = []
  for (let s = 0; s < LENGTH; s += 1) {
    const c = centre(s)
    // Across: −4.5 (right, wide) on the straights, +4.5 (left, apex) mid-turn, smoothly between.
    const turn = s >= STRAIGHT && s < STRAIGHT + Math.PI * R ? (s - STRAIGHT) / (Math.PI * R) : s >= 2 * STRAIGHT + Math.PI * R ? (s - 2 * STRAIGHT - Math.PI * R) / (Math.PI * R) : -1
    let o = turn < 0 ? -4.5 : -4.5 + 9 * Math.sin(Math.PI * turn)
    // A real trip onto the grass: 40 m, 8 m past the right edge.
    if (excursion && s > 150 && s < 190) o = -HALF - 8
    x.push(c.x + c.lx * o + offset[0]); z.push(c.z + c.lz * o + offset[1])
  }
  return { x, z }
}

test('align: a constant GNSS offset is taken back out', () => {
  const road = edges()
  for (const bias of [[2.5, -1.5], [-3, 3], [0.5, 4]] as Array<[number, number]>) {
    const { x, z } = lap(bias)
    const fit = fitToRoad(x, z, road)
    assert.ok(fit.applied)
    assert.ok(fit.before.metres > 20, `off the road as recorded (${fit.before.metres.toFixed(0)} m)`)
    assert.ok(fit.after.metres < 5 && fit.after.maxM < 0.2, `on the road after (${fit.after.metres.toFixed(1)} m, ${fit.after.maxM.toFixed(2)} m)`)
    assert.ok(Math.hypot(fit.dx + bias[0], fit.dz + bias[1]) < 0.6, `shift (${fit.dx.toFixed(2)}, ${fit.dz.toFixed(2)}) undoes (${bias})`)
  }
})

test('align: a lap already on the road barely moves', () => {
  const fit = fitToRoad(...Object.values(lap([0, 0])) as [number[], number[]], edges())
  assert.equal(fit.before.metres, 0)
  assert.ok(Math.hypot(fit.dx, fit.dz) < 0.6, `shift ${Math.hypot(fit.dx, fit.dz).toFixed(2)} m`)
})

test('align: a real excursion stays, and does not drag the lap', () => {
  const road = edges()
  const clean = fitToRoad(...Object.values(lap([2, 2])) as [number[], number[]], road)
  const off = fitToRoad(...Object.values(lap([2, 2], true)) as [number[], number[]], road)
  assert.ok(Math.hypot(off.dx - clean.dx, off.dz - clean.dz) < 0.3, `excursion pulls ${Math.hypot(off.dx - clean.dx, off.dz - clean.dz).toFixed(2)} m`)
  assert.ok(off.after.maxM > 7, `still ${off.after.maxM.toFixed(1)} m off the road`)
  assert.ok(off.after.metres > 30)
})

test('align: the shift is bounded; a lap elsewhere is left alone', () => {
  const road = edges()
  const far = fitToRoad(...Object.values(lap([0, 9])) as [number[], number[]], road)
  assert.ok(Math.hypot(far.dx, far.dz) <= MAX_SHIFT_M + 1e-9)
  const elsewhere = lap([5000, 0])
  const none = fitToRoad(elsewhere.x, elsewhere.z, road)
  assert.equal(none.applied, false)
  assert.equal(none.coverage, 0)
})

test('align: a model\'s edges are placed by its matrix', () => {
  // The same road in "glTF" coordinates: rotated 30° and moved; placed back by the matrix.
  const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 6).setPosition(120, 0, -80)
  const inverse = matrix.clone().invert(), v = new THREE.Vector3()
  const model: Array<[number, number, number, number]> = []
  for (let s = 0; s < LENGTH; s += 3) {
    const c = centre(s)
    v.set(c.x + c.lx * HALF, 0, c.z + c.lz * HALF).applyMatrix4(inverse); const [lx, lz] = [v.x, v.z]
    v.set(c.x - c.lx * HALF, 0, c.z - c.lz * HALF).applyMatrix4(inverse)
    model.push([lx, lz, v.x, v.z])
  }
  const placed = TrackEdges.fromModel(model, matrix)
  const { x, z } = lap([2.5, -1.5])
  const a = fitToRoad(x, z, placed), b = fitToRoad(x, z, edges())
  assert.ok(Math.hypot(a.dx - b.dx, a.dz - b.dz) < 0.05)
})

test('align: LapPath shifts as a whole, and places other lat/lon the same way', () => {
  const frame = makeFrame({ south: 37, west: -79.01, north: 37.01, east: -79 })
  const { x, z } = lap([0, 0])
  const n = 600
  const replayLap: ReplayLap = {
    sessionGuid: 's', lap: 0, durationMs: n * 50, label: 'L1',
    dist: Array.from({ length: n }, (_, i) => i), timeMs: Array.from({ length: n }, (_, i) => i * 50),
    lat: z.slice(0, n).map(v => latAt(frame, v)), lon: x.slice(0, n).map(v => lonAt(frame, v)),
    altM: Array(n).fill(null), speedMps: Array(n).fill(20), accelX: Array(n).fill(null), accelY: Array(n).fill(null), headingDeg: Array(n).fill(null), car: null,
  }
  const path = new LapPath(replayLap, frame, 0)
  const before = path.pose(10_000), fx = before.fx, px = before.x, pz = before.z
  assert.equal(path.setOffset(1.5, -2), true)
  assert.equal(path.setOffset(1.5, -2), false)
  const after = path.pose(10_000)
  assert.ok(Math.abs(after.x - px - 1.5) < 1e-9 && Math.abs(after.z - pz + 2) < 1e-9)
  assert.ok(Math.abs(after.fx - fx) < 1e-12, 'heading unchanged')
  assert.deepEqual([path.gpsX[200], path.gpsZ[200]], [path.x[200] - 1.5, path.z[200] + 2])
  // A raw lat/lon lands where the lap's own (unsmoothed) point would, shifted alike.
  const [lx, lz] = path.toLocal(replayLap.lat[300], replayLap.lon[300])
  assert.ok(Math.abs(lx - (x[300] + 1.5)) < 1e-6 && Math.abs(lz - (z[300] - 2)) < 1e-6)
  path.setOffset(0, 0)
  assert.ok(Math.abs(path.x[200] - path.gpsX[200]) < 1e-12)
})
