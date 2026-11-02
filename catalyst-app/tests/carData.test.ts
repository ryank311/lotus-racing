import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cornerInputs, distanceAt, videoSpan, videoTimeAt } from '../src/renderer/components/carData'
import type { CarTrace } from '../src/shared/pdr'

// A 1 km lap on a 5 m grid at 20 m/s, video starting 100 s into the file.
// Braking 300 → 380 m (peak 90 % pedal at 340 m), coasting to 400 m, throttle
// from 400 m; apex at 420 m.
function lap(): CarTrace {
  const dist = Array.from({ length: 201 }, (_, i) => i * 5)
  return {
    sg: 's', lapIdx: 0, videoId: 'v', dist,
    videoT: dist.map(d => 100 + d / 20),
    throttle: dist.map(d => (d < 300 ? 100 : d < 400 ? 0 : 60)),
    brake: dist.map(d => (d >= 300 && d < 380 ? 90 - Math.abs(d - 340) : 0)),
    rpm: dist.map(() => 5000),
    gear: dist.map(d => (d >= 330 && d <= 480 ? 2 : 4)),
    steering: dist.map(d => (d >= 380 && d <= 460 ? -85 : 3)),
    slip: dist.map(() => 0),
    speed: dist.map(() => 72),
  }
}

test('a lap moves between distance and video time both ways', () => {
  const trace = lap()
  assert.deepEqual(videoSpan(trace), [100, 150])
  assert.equal(videoTimeAt(trace, 500), 125)
  assert.equal(videoTimeAt(trace, 502.5), 125.125)
  assert.equal(distanceAt(trace, 125.125), 502.5)
  assert.equal(distanceAt(trace, 99), null, 'before the lap')
  assert.equal(videoTimeAt(trace, 1200), null, 'past the lap')
  // Gaps in the video do not invent a time.
  const gappy = { ...trace, videoT: trace.videoT.map((t, i) => (i > 50 && i < 60 ? null : t)) }
  assert.equal(videoTimeAt(gappy, 275), 113.75, 'interpolated across a gap in the samples')
})

test('driver inputs through a corner', () => {
  const [corner] = cornerInputs(lap(), [{ turn: 'T1', name: 'Hairpin', apexM: 420 }])
  assert.equal(corner.brakeOnM, 120, 'braking starts 120 m before the apex')
  assert.equal(corner.peakBrake, 90)
  assert.equal(corner.coastS, 1, '20 m of neither pedal at 20 m/s')
  assert.equal(corner.throttleOnM, -20, 'throttle back on 20 m before the apex')
  assert.equal(corner.minGear, 2)
  assert.equal(corner.maxSteering, 85)
})

test('a flat-out corner has no braking or coasting', () => {
  const trace = { ...lap(), brake: lap().brake.map(() => 0), throttle: lap().throttle.map(() => 100) }
  const [corner] = cornerInputs(trace, [{ turn: 'T9', name: 'Kink', apexM: 600 }])
  assert.equal(corner.brakeOnM, null)
  assert.equal(corner.peakBrake, null)
  assert.equal(corner.coastS, null)
  assert.equal(corner.throttleOnM, -150, 'already on the throttle where the window starts')
})

// Laps in one video: `pace(d)` is the speed (m/s) at each metre, so a lap can
// be faster in one half of the track and slower in the other.
function timedLap(lapIdx: number, startS: number, pace: (d: number) => number): CarTrace {
  const dist = Array.from({ length: 201 }, (_, i) => i * 5)
  const videoT: number[] = []
  let t = startS
  for (const [i, d] of dist.entries()) { if (i) t += 5 / pace(d - 2.5); videoT.push(t) }
  const none = dist.map(() => null)
  return { sg: 's', lapIdx, videoId: 'v', dist, videoT, throttle: none, brake: none, rpm: none, gear: none, steering: none, slip: none, speed: dist.map(() => 30) }
}

test('the optimal lap takes each split from the lap that was fastest through it', async () => {
  const { stitchOptimalLap, stitchedTimeAt, stitchedElapsed, pieceAt } = await import('../src/renderer/components/carData')
  // L1 is quick in the first half, L2 in the second; L3 is slow everywhere.
  const l1 = timedLap(0, 100, d => (d < 500 ? 25 : 20))
  const l2 = timedLap(1, 150, d => (d < 500 ? 20 : 25))
  const l3 = timedLap(2, 200, () => 18)
  const splits = [{ id: 'S1', startM: 0, endM: 500 }, { id: 'S2', startM: 500, endM: 1000 }]
  const lap = stitchOptimalLap([l3, l1, l2], splits)!
  assert.deepEqual(lap.pieces.map(p => [p.id, p.trace.lapIdx]), [['S1', 0], ['S2', 1]])
  assert.deepEqual(lap.laps, [0, 1])
  assert.ok(Math.abs(lap.timeS - 40) < 0.01, `500/25 + 500/25 = 40 s, got ${lap.timeS}`)
  // The chart trace runs the whole lap once, taking each split's samples.
  assert.equal(lap.trace.dist[0], 0)
  assert.equal(lap.trace.dist[lap.trace.dist.length - 1], 1000)
  assert.equal(new Set(lap.trace.dist).size, lap.trace.dist.length, 'no metre twice')
  assert.equal(lap.trace.videoT[lap.trace.dist.indexOf(495)], l1.videoT[l1.dist.indexOf(495)])
  assert.equal(lap.trace.videoT[lap.trace.dist.indexOf(500)], l2.videoT[l2.dist.indexOf(500)])
  // Seeking by distance lands in the right lap; elapsed time runs on across the cut.
  assert.equal(pieceAt(lap.pieces, 499), 0)
  assert.equal(pieceAt(lap.pieces, 500), 1)
  assert.equal(stitchedTimeAt(lap.pieces, 250), videoTimeAt(l1, 250))
  assert.equal(stitchedTimeAt(lap.pieces, 750), videoTimeAt(l2, 750))
  assert.ok(Math.abs(stitchedElapsed(lap.pieces, 1, videoTimeAt(l2, 750)!)! - 30) < 0.01)
})

test('no optimal lap without two laps in one video, or with a split no lap covers', async () => {
  const { stitchOptimalLap } = await import('../src/renderer/components/carData')
  const splits = [{ id: 'S1', startM: 0, endM: 500 }, { id: 'S2', startM: 500, endM: 1000 }]
  assert.equal(stitchOptimalLap([timedLap(0, 100, () => 20)], splits), null)
  assert.equal(stitchOptimalLap([timedLap(0, 100, () => 20), { ...timedLap(1, 200, () => 20), videoId: 'other' }], splits), null)
  assert.equal(stitchOptimalLap([timedLap(0, 100, () => 20), timedLap(1, 200, () => 20)], []), null)
  const short = timedLap(1, 200, () => 20)
  short.videoT = short.videoT.map((t, i) => (short.dist[i] > 400 ? null : t))
  assert.equal(stitchOptimalLap([{ ...timedLap(0, 100, () => 20), videoT: short.videoT }, short], splits), null)
})
