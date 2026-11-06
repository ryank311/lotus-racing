// Placing laps on a track model by Garmin's distance and lane position (trackFrame.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReplayTrack } from '../src/shared/replay'
import { TrackEdges } from '../src/renderer/replay/align'
import { RoadModel } from '../src/renderer/replay/road'
import { TrackFrame } from '../src/renderer/replay/trackFrame'
import { makeFrame, latAt, lonAt } from '../src/renderer/replay/geo'

const area = { south: 36.5, north: 36.51, west: -79.21, east: -79.2 }
const frame = makeFrame(area)

// A loop of radius R (local metres, counter-clockwise seen from above = driving
// with the centre on the left), as Garmin's line: ~1 m stations.
function garminLoop(R: number): RoadModel {
  const n = Math.round(2 * Math.PI * R)
  const dist: number[] = [], lat: number[] = [], lon: number[] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI
    // x east, z south: going round with the centre to the left.
    const x = R * Math.cos(a), z = -R * Math.sin(a)
    dist.push((i / n) * 2 * Math.PI * R); lat.push(latAt(frame, z)); lon.push(lonAt(frame, x))
  }
  const track = { line: { dist, lat, lon }, totalDistM: 2 * Math.PI * R, widthM: 10 } as unknown as ReplayTrack
  return new RoadModel(track, frame)
}

// The model's road: centre on a loop of radius Rc, half width h, left edge toward the centre.
function modelLoop(Rc: number, h: number, stations = 400): TrackEdges {
  const left: number[] = [], right: number[] = []
  for (let i = 0; i < stations; i++) {
    const a = (i / stations) * 2 * Math.PI
    const cx = Math.cos(a), cz = -Math.sin(a)
    left.push((Rc - h) * cx, (Rc - h) * cz); right.push((Rc + h) * cx, (Rc + h) * cz)
  }
  return new TrackEdges(left, right)
}

test('Garmin\'s line is tied to the model\'s centre, however far apart they run', () => {
  const road = garminLoop(200), edges = modelLoop(202, 5)
  const f = new TrackFrame(road, edges)
  assert.ok(f.usable)
  assert.ok(Math.abs(f.stats.medianM - 2) < 0.1, `median ${f.stats.medianM}`)
  // Mid-road at any distance lands on the model's centre (radius 202).
  for (const d of [0, 100, 600, 1200]) {
    const [x, z] = f.place(d, 0.5)
    assert.ok(Math.abs(Math.hypot(x, z) - 202) < 0.05, `at ${d} m: ${Math.hypot(x, z)}`)
  }
})

test('across the road by the share Garmin read (the device, inside the car)', () => {
  const road = garminLoop(200), edges = modelLoop(202, 5)
  const f = new TrackFrame(road, edges)
  const r = (d: number, share: number) => { const [x, z] = f.place(d, share); return Math.hypot(x, z) }
  // 0 is the left edge (toward the centre of this loop), 1 the right.
  assert.ok(Math.abs(r(300, 0) - 197) < 0.05)
  assert.ok(Math.abs(r(300, 1) - 207) < 0.05)
  assert.ok(Math.abs(r(300, 0.25) - 199.5) < 0.05)
})

test('distances along Garmin\'s line map in order round the model, wrapping at the line', () => {
  const road = garminLoop(200), edges = modelLoop(202, 5)
  const f = new TrackFrame(road, edges)
  let last = -Infinity
  for (let d = 0; d < road.totalM; d += 25) {
    const [x, z] = f.place(d, 0.5)
    // Angle round the loop grows with distance (the same way round as Garmin's line).
    let a = Math.atan2(-z, x)
    if (a < 0) a += 2 * Math.PI
    if (d > 0 && d < road.totalM - 30) assert.ok(a > last - 1e-6, `${d} m`)
    last = a
    assert.ok(Math.abs(a - d / 200) < 0.02, `${d} m: ${a} vs ${d / 200}`)
  }
  // A second lap's distances land where the first lap's do.
  const [x1, z1] = f.place(150, 0.5), [x2, z2] = f.place(150 + road.totalM, 0.5)
  assert.ok(Math.hypot(x1 - x2, z1 - z2) < 0.01)
})

test('a model that does not follow Garmin\'s line is not used', () => {
  const road = garminLoop(200), edges = modelLoop(260, 5)
  assert.equal(new TrackFrame(road, edges).usable, false)
})

test('where the model\'s edge strays (a road joining), the road either side carries on', () => {
  const road = garminLoop(200)
  // The right edge swings 8 m out over three stations (a service road).
  const stations = 400, left: number[] = [], right: number[] = []
  for (let i = 0; i < stations; i++) {
    const a = (i / stations) * 2 * Math.PI, cx = Math.cos(a), cz = -Math.sin(a)
    const out = i >= 100 && i <= 102 ? 8 : 0
    left.push(197 * cx, 197 * cz); right.push((207 + out) * cx, (207 + out) * cz)
  }
  const f = new TrackFrame(road, new TrackEdges(left, right))
  assert.equal(f.stats.despiked, 3)
  // Through it, mid-road stays on the centre and the right edge where it was.
  for (let d = 300; d <= 340; d += 2) {
    const [x, z] = f.place(d, 0.5), [rx, rz] = f.place(d, 1)
    assert.ok(Math.abs(Math.hypot(x, z) - 202) < 0.1, `${d} m: centre ${Math.hypot(x, z)}`)
    assert.ok(Math.abs(Math.hypot(rx, rz) - 207) < 0.1, `${d} m: right ${Math.hypot(rx, rz)}`)
  }
})
