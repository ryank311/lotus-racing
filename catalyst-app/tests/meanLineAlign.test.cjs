const assert = require('node:assert/strict')
const { test } = require('node:test')
const { distanceMap, remapLapSamples, mapToOwnLine } = require('../dist-main/garmin/meanLineAlign.js')
const { sameCourse, sameTrackLayout } = require('../dist-main/shared/trackLayout.js')

// A course in local metres (x east, y north): 200 m north, a hairpin of
// radius 7 m, 200 m back south. The two legs run 14 m apart, closer than a
// line can be from its neighbour, so only direction tells them apart.
const R = 7
function courseAt(s) {
  const turn = Math.PI * R
  if (s <= 200) return { x: 0, y: s }
  if (s <= 200 + turn) { const a = (s - 200) / R; return { x: R - R * Math.cos(a), y: 200 + R * Math.sin(a) } }
  return { x: 2 * R, y: 200 - (s - 200 - turn) }
}
const COURSE_M = 400 + Math.PI * R
const M_PER_DEG = 111_320
const toLatLon = ({ x, y }, eastM = 0) => ({ lat: 37 + y / M_PER_DEG, lon: -79 + (x + eastM) / (M_PER_DEG * Math.cos(37 * Math.PI / 180)) })

// A device's mean line whose metres run `stretch` times the course's.
function line(guid, stretch, stepM, eastM = 0) {
  const total = COURSE_M * stretch
  const out = { guid, totalM: total, dist: [], lat: [], lon: [] }
  for (let t = 0; t <= total + 1e-9; t += stepM) {
    const p = toLatLon(courseAt(Math.min(t, total) / stretch), eastM)
    out.dist.push(t); out.lat.push(p.lat); out.lon.push(p.lon)
  }
  if (out.dist.at(-1) < total) { const p = toLatLon(courseAt(COURSE_M), eastM); out.dist.push(total); out.lat.push(p.lat); out.lon.push(p.lon) }
  return out
}

test('their metres map onto yours by position, hairpin legs included', () => {
  const ours = line('ours', 1, 1)
  const theirs = line('theirs', 1.03, 5)
  const map = distanceMap(theirs, ours)
  assert.deepEqual(map[0], [0, 0])
  assert.deepEqual(map.at(-1), [theirs.totalM, ours.totalM])
  assert.ok(map.length > theirs.dist.length * 0.9, 'nearly every point matched')
  for (let i = 1; i < map.length; i++) assert.ok(map[i][0] > map[i - 1][0] && map[i][1] > map[i - 1][1], 'strictly increasing')
  for (const [t, d] of map) assert.ok(Math.abs(d - t / 1.03) < 0.05, `${t.toFixed(1)} m of theirs is ${(t / 1.03).toFixed(1)} m of yours, not ${d.toFixed(1)}`)
})

test('a line a few metres to the side still maps to the same spots', () => {
  const ours = line('ours', 1, 1)
  const theirs = line('theirs', 1, 5, 3)
  const map = distanceMap(theirs, ours)
  // On the straights the two lines are 3 m apart side by side.
  for (const [t, d] of map.filter(([t]) => t < 190 || t > 230)) assert.ok(Math.abs(d - t) < 0.5, `${t} → ${d}`)
})

test('laps are resampled at your whole metres, keeping gaps and lap time', () => {
  const map = [[0, 0], [505, 500], [1010, 1000]]
  const theirDist = Array.from({ length: 1011 }, (_, t) => t).filter(t => t < 300 || t > 340)
  const samples = {
    dist: theirDist, timeMs: theirDist.map(t => t * 20), speed: theirDist.map(t => t / 10),
    accelX: theirDist.map(() => 0), accelY: theirDist.map(() => null), lat: theirDist.map(() => 37), lon: theirDist.map(() => -79), lateral: theirDist.map(() => 0.5),
  }
  const out = remapLapSamples(samples, map, 1000)
  assert.equal(out.dist[0], 0)
  assert.equal(out.dist.at(-1), 1000)
  assert.ok(out.dist.every((d, i) => Number.isInteger(d) && (i === 0 || d > out.dist[i - 1])))
  assert.equal(out.timeMs.at(-1), 1010 * 20, 'the lap still ends at its own time')
  const at = d => out.dist.indexOf(d)
  assert.ok(Math.abs(out.speed[at(250)] - 250 * 1.01 / 10) < 1e-9)
  assert.equal(at(310), -1, 'a 41 m telemetry gap stays a gap')
  assert.equal(out.accelY[at(100)], null)
  for (const key of ['timeMs', 'speed', 'accelX', 'accelY', 'lat', 'lon', 'lateral']) assert.equal(out[key].length, out.dist.length)
})

test('no remapping on the same mean line; scaling when a line is missing', () => {
  const own = { guid: 'ours', totalM: 1000, trace: null }
  assert.equal(mapToOwnLine('ours', null, 1000, own), null)
  assert.deepEqual(mapToOwnLine('theirs', null, 1012, own), [[0, 0], [1012, 1000]])
  assert.equal(mapToOwnLine('theirs', null, 1012, { guid: 'ours', totalM: 0, trace: null }), null)
})

test('drivers match by course, not by their own mean line', () => {
  const mine = { meanLineGuid: 'line-a', configurationId: 72, trackLabel: 'VIR · Full Course' }
  const theirs = { meanLineGuid: 'line-b', configurationId: 72, trackLabel: 'VIR · Full Course' }
  assert.equal(sameTrackLayout(mine, theirs), false, 'one driver’s layouts stay keyed by mean line')
  assert.equal(sameCourse(mine, theirs), true)
  assert.equal(sameCourse(mine, { ...theirs, configurationId: 99 }), false)
  assert.equal(sameCourse(mine, { ...theirs, meanLineGuid: 'line-a', configurationId: 99 }), false, 'course IDs decide when both are known')
  assert.equal(sameCourse({ trackLabel: 'VIR · Full Course' }, { meanLineGuid: 'x', trackLabel: 'vir · full course' }), true, 'names when an ID is missing')
  assert.equal(sameCourse({ trackLabel: 'VIR · ' }, { trackLabel: 'VIR · ' }), false, 'a facility name alone is not a course')
  assert.equal(sameCourse({ meanLineGuid: 'x' }, { meanLineGuid: 'x' }), true)
})
