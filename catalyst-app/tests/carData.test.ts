import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cornerInputs, distanceAt, videoSpan, videoTimeAt } from '../src/renderer/components/carData'
import type { CarTrace } from '../src/shared/pdr'

// A 1 km lap on a 5 m grid at 20 m/s, video starting 100 s into the file.
// Braking 300 → 380 m (peak 90 bar at 340 m), coasting to 400 m, throttle
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
