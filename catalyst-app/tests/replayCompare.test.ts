// The replay's second car (compare.ts): its own clock (yours plus an offset
// scrubbed apart), Side by side and Sync, the live gap at the same spot, the
// Both cars camera's framing, and the ghost URL param for another driver.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReplayLap } from '../src/shared/replay'
import { driverGhostParam, isReplayGhostParam, parseDriverGhostParam } from '../src/shared/replay'
import { LapPath } from '../src/renderer/replay/lapPath'
import { latAt, lonAt, makeFrame } from '../src/renderer/replay/geo'
import {
  BOTH_FAR_M, BOTH_NEAR_M, BOTH_PITCH, CAR_RADIUS_M, clampOffset, comparedTime, formatOffset, frameBoth, framingDistance,
  offsetFor, scrubFraction, sideBySideOffset,
} from '../src/renderer/replay/compare'
import { normalizeRoute } from '../src/renderer/routes'

const AREA = { south: 37, west: -79.01, north: 37.03, east: -79 }
const frame = makeFrame(AREA)

// A straight 1 km north at a steady speed, one sample a metre.
function straightLap(speedMps: number, lengthM = 1000): LapPath {
  const dist: number[] = [], timeMs: number[] = [], lat: number[] = [], lon: number[] = []
  for (let d = 0; d <= lengthM; d++) { dist.push(d); timeMs.push(d / speedMps * 1000); lat.push(latAt(frame, -d)); lon.push(lonAt(frame, 0)) }
  const lap: ReplayLap = {
    sessionGuid: 's', lap: 0, label: 'L1', durationMs: timeMs.at(-1)!, dist, timeMs, lat, lon,
    altM: dist.map(() => null), speedMps: dist.map(() => speedMps), accelX: dist.map(() => 0), accelY: dist.map(() => 0), headingDeg: dist.map(() => null), car: null,
  }
  return new LapPath(lap, frame, 0)
}

test('the compared car runs on its own clock: yours plus the offset', () => {
  assert.equal(comparedTime(10_000, -1240), 8760)
  assert.equal(comparedTime(10_000, 0), 10_000, 'Sync: the normal timeline')
  // Dragging its handle sets only the offset, within its own lap.
  assert.equal(offsetFor(8000, 10_000, 25_000), -2000)
  assert.equal(offsetFor(-500, 10_000, 25_000), -10_000, 'not before its start')
  assert.equal(offsetFor(30_000, 10_000, 25_000), 15_000, 'not past its finish')
  // Moving your handle keeps the offset: the compared time follows yours.
  const offset = offsetFor(8000, 10_000, 25_000)
  assert.equal(comparedTime(15_000, offset), 13_000)
  assert.equal(clampOffset(90_000, 20_000, 25_000), 25_000)
  assert.equal(clampOffset(-90_000, 20_000, 25_000), -25_000)
  assert.equal(clampOffset(Number.NaN, 20_000, 25_000), 0)
  assert.equal(scrubFraction(5000, 20_000), 0.25)
  assert.equal(scrubFraction(30_000, 20_000), 1)
  assert.equal(scrubFraction(-1, 20_000), 0)
})

test('the offset reads as the compared car behind or ahead of its own clock', () => {
  assert.equal(formatOffset(-1240), '−1.24 s')
  assert.equal(formatOffset(800), '+0.80 s')
  assert.equal(formatOffset(3), '±0.00 s')
  assert.equal(formatOffset(-12_345), '−12.35 s')
})

test('Side by side puts the compared car level with yours; the gap at a spot ignores the offset', () => {
  const mine = straightLap(40), theirs = straightLap(50)
  // At 10 s you are at 400 m; they passed 400 m at 8 s.
  const offset = sideBySideOffset(mine, theirs, 10_000)!
  assert.ok(Math.abs(offset + 2000) < 1, `offset ${offset}`)
  assert.ok(Math.abs(theirs.distAt(comparedTime(10_000, offset)) - mine.distAt(10_000)) < 0.01, 'level on track')
  // The cars' centres line up: their data collector 0.1 m further forward than yours.
  assert.ok(Math.abs(sideBySideOffset(mine, theirs, 10_000, 0.1)! - (8002 - 10_000)) < 0.5)
  // The live gap is the time between the laps at the same spot, whatever the offset.
  const gap = 10_000 - theirs.timeAtDist(mine.distAt(10_000))!
  assert.ok(Math.abs(gap - 2000) < 1)
  // A spot their lap never reaches: no offset.
  assert.equal(sideBySideOffset(straightLap(40), straightLap(50, 300), 10_000), null)
})

test('Both cars: framed together while close, following yours when far apart', () => {
  const together = frameBoth([0, 0, 0], [0, 0, 0])
  assert.deepEqual([together.weight, together.radiusM, together.pitch, together.separationM], [1, CAR_RADIUS_M, BOTH_PITCH[0], 0])

  const apart = frameBoth([0, 10, 0], [30, 12, -40])
  assert.equal(apart.separationM, 50)
  assert.equal(apart.weight, 1)
  assert.deepEqual(apart.target, [15, 11, -20], 'between them')
  assert.equal(apart.radiusM, CAR_RADIUS_M + 25, 'a sphere round both')
  assert.ok(apart.pitch > together.pitch && apart.pitch < BOTH_PITCH[1], 'higher as they part')

  // The framing fades to yours between NEAR and FAR, and past FAR it is yours alone.
  const fading = frameBoth([0, 0, 0], [0, 0, (BOTH_NEAR_M + BOTH_FAR_M) / 2])
  assert.ok(fading.weight > 0 && fading.weight < 1)
  assert.ok(fading.target[2] > 0 && fading.target[2] < (BOTH_NEAR_M + BOTH_FAR_M) / 4)
  const far = frameBoth([5, 0, 5], [5, 0, 5 + BOTH_FAR_M + 1])
  assert.deepEqual([far.weight, far.target, far.radiusM], [0, [5, 0, 5], CAR_RADIUS_M])
  assert.deepEqual(frameBoth([1, 2, 3], null).target, [1, 2, 3], 'no compared car: yours')

  // Far enough back that the sphere fits the narrower field of view.
  assert.ok(Math.abs(framingDistance(10, 60, 16 / 9) - 20) < 1e-9, 'wide: the vertical 60° decides')
  const tall = framingDistance(10, 60, 0.5)
  assert.ok(Math.abs(tall - 10 / Math.sin(Math.atan(Math.tan(Math.PI / 6) * 0.5))) < 1e-9, 'a phone: the horizontal decides')
  assert.ok(tall > 20)
})

test('the ghost param names another driver’s lap', () => {
  const ref = { driver: 'Mitch Smith', sessionGuid: 'e43adaf4-b2a6', lap: 3 }
  assert.equal(driverGhostParam(ref), 'driver:Mitch Smith:e43adaf4-b2a6:3')
  assert.deepEqual(parseDriverGhostParam(driverGhostParam(ref)), ref)
  for (const bad of ['driver::abc:1', 'driver:Mitch:abc', 'driver:Mitch:a/b:1', 'driver:Mi:tch:abc:1', 'driver:Mitch:abc:optimal', 'driver:Mitch:abc:12345', 'abc:1']) {
    assert.equal(parseDriverGhostParam(bad), null, bad)
  }
  for (const ok of ['none', 'abc-1:2', 'abc-1:optimal', 'driver:Mitch:abc-1:0']) assert.ok(isReplayGhostParam(ok), ok)
  for (const bad of ['', 'abc', 'a/b:1', 'driver:Mitch:abc', 'driver:Mitch:abc:x']) assert.ok(!isReplayGhostParam(bad), bad)

  // The route keeps a valid one (and the Both cars camera) and refuses the rest.
  const kept = normalizeRoute('/replay/abc', `?${new URLSearchParams({ ghost: driverGhostParam(ref), view: 'both' })}`)
  assert.equal(kept.error, undefined)
  assert.deepEqual(Object.fromEntries(new URLSearchParams(kept.url.split('?')[1])), { ghost: 'driver:Mitch Smith:e43adaf4-b2a6:3', view: 'both' })
  assert.equal(normalizeRoute('/replay/abc', '?ghost=driver:Mitch:abc:x').error, 'Invalid ghost lap.')
})
