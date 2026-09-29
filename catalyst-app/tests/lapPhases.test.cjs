const assert = require('node:assert/strict')
const { test } = require('node:test')
const phases = require('../dist-main/garmin/lapPhases.js')
const packet = require('../dist-main/garmin/coachPacket.js')

// A synthetic 1 m lap: `profile(d)` returns [speed m/s, long g]; time is
// integrated from speed so splits and deltas are exact.
function lap(total, profile) {
  const s = { dist: [], timeMs: [], speed: [], longG: [], latG: [] }
  let t = 0
  for (let d = 0; d <= total; d++) {
    const [v, g] = profile(d)
    if (d > 0) t += 1000 / v
    s.dist.push(d); s.timeMs.push(t); s.speed.push(v); s.longG.push(g); s.latG.push(0.5)
  }
  return s
}
// Straight at 50 m/s, a 1.0 g stop from 200–350 m into a 20 m/s corner at
// 400 m, accelerate to 700 m; a second, lighter stop into a 30 m/s corner at 900 m.
const profile = d => {
  if (d < 200) return [50, 0.1]
  if (d < 350) return [50 - (d - 200) / 150 * 30, -1.0]
  if (d < 400) return [20 - (d - 350) / 50 * 2, -0.12]
  if (d < 700) return [18 + (d - 400) / 300 * 32, 0.4]
  if (d < 800) return [50 - (d - 700) / 100 * 20, -0.6]
  if (d < 900) return [30 - (d - 800) / 100 * 2, -0.05]
  return [28 + (d - 900) / 100 * 5, 0.3]
}
const corners = [
  { turn: 'T1', name: 'Hairpin', apex_idx: 400, dist_idx_start: 360, dist_idx_end: 440 },
  { turn: 'T2', name: 'Kink', apex_idx: 520, dist_idx_start: 500, dist_idx_end: 540 },
  { turn: 'T3', name: 'Sweeper', apex_idx: 900, dist_idx_start: 860, dist_idx_end: 940 },
]

test('braking peaks report the real deceleration, not the trail-brake tail', () => {
  const episodes = phases.detectBrakeEpisodes(lap(1200, profile))
  assert.equal(episodes.length, 2)
  assert.ok(Math.abs(episodes[0].peakG - 1.0) < 0.02, `peak ${episodes[0].peakG}`)
  assert.ok(episodes[0].onsetM >= 196 && episodes[0].onsetM <= 202)
  assert.ok(Math.abs(episodes[1].peakG - 0.6) < 0.02)
})

test('each braking zone feeds exactly one corner, chosen by where braking ends', () => {
  const s = lap(1200, profile)
  const assigned = phases.assignBrakingToCorners(phases.detectBrakeEpisodes(s), corners)
  assert.deepEqual([...assigned.keys()], ['T1', 'T3'])
  const result = phases.cornerPhases(s, corners, 1200)
  assert.equal(result.find(p => p.turn === 'T2').braking, null)
  assert.ok(Math.abs(result.find(p => p.turn === 'T1').braking.peakG - 1.0) < 0.02)
})

test('a minimum on the search-window edge is not reported as a corner V-min', () => {
  const result = phases.cornerPhases(lap(1200, profile), corners, 1200)
  const t1 = result.find(p => p.turn === 'T1')
  assert.equal(t1.vminM, 400)
  assert.ok(t1.exit100Mps > t1.vminMps)
  // T2 sits on a steady acceleration: its lowest speed is the window start.
  assert.equal(result.find(p => p.turn === 'T2').vminMps, null)
})

test('complexes run from braking zone to braking zone and their times sum to the lap', () => {
  const s = lap(1200, profile)
  const complexes = phases.deriveComplexes(corners, s, 1200)
  assert.deepEqual(complexes.map(c => c.corners), [[], ['T1', 'T2'], ['T3']])
  assert.equal(complexes[1].startM, 170, "20 m before the braking onset, rounded down to 10 m")
  const sum = complexes.reduce((a, c) => a + phases.spanTimeMs(s, c.startM, c.endM), 0)
  assert.ok(Math.abs(sum - s.timeMs.at(-1)) < 1e-6)
  const cp = phases.complexPhases(s, complexes)
  assert.equal(cp[0].vminMps, null, 'a straight has only a time')
  assert.ok(Math.abs(cp[1].braking.peakG - 1.0) < 0.02)
})

test('overlapping Garmin segments are tiled so splits sum to the lap time', () => {
  const s = lap(1200, profile)
  const bounds = phases.segmentBounds([{ id: 1, start_dist_m: 0, end_dist_m: 630 }, { id: 2, start_dist_m: 600, end_dist_m: 1200 }], 1200)
  assert.deepEqual(bounds.map(b => [b.startM, b.endM]), [[0, 600], [600, 1200]])
  const sum = bounds.reduce((a, b) => a + phases.spanTimeMs(s, b.startM, b.endM), 0)
  assert.ok(Math.abs(sum - s.timeMs.at(-1)) < 1e-6)
})

test('an implausibly fast split (a track cut) cannot set the best', () => {
  assert.equal(phases.plausibleMin([8.2, 8.3, 8.25, 7.51]), 8.2)
  assert.equal(phases.plausibleMin([8.2, 7.51]), 7.51, 'too few laps to judge')
})

test('focus checks compare later laps with the saved baseline and target', () => {
  const item = {
    id: 'f1', complexId: 'C2', complexName: 'T1–T2', complexStartM: 180, complexEndM: 780, ref: 'T1', phase: 'exit',
    change: '', why: '', cue: 'Throttle early', metric: 'C2.exit100', metricLabel: 'Speed 100 m after the minimum',
    better: 'higher', unit: 'mps', baseline: 25, best: 29, target: 27, display: { baseline: '', best: '', target: '' },
    referenceLap: '', confidence: 'high', evidence: [],
  }
  const laps = n => Array.from({ length: n }, () => ({ series: lap(1200, profile), representative: true, label: 'May 24 16:15 · L1' }))
  const check = packet.checkFocus(item, laps(3), 'r', '2026-05-24', 'imperial')
  assert.equal(check.laps, 3)
  assert.equal(check.verdict, 'met')
  assert.equal(packet.checkFocus({ ...item, baseline: 40, target: 42 }, laps(3), 'r', '', 'imperial').verdict, 'worse')
  assert.equal(packet.checkFocus(item, laps(1), 'r', '', 'imperial').verdict, 'not_measured')
})

test('session starts keep the local wall-clock time Garmin reports', () => {
  const { localSessionStart } = require('../dist-main/garmin/loadToDb.js')
  assert.equal(localSessionStart('2026-05-24T16:15:34-04:00'), '2026-05-24 16:15:34')
  assert.equal(localSessionStart('2026-05-24T16:15:34.250+0200'), '2026-05-24 16:15:34.250')
  assert.equal(localSessionStart('2026-05-24 16:15:34'), '2026-05-24 16:15:34')
  assert.equal(localSessionStart(null), null)
})

test('a unit rotated on its mount is calibrated so cornering load is not read as braking', () => {
  // Accelerate at +0.2 g out of a 1.1 g right-hander, with 35% of lateral g
  // leaking into the longitudinal channel (as on a real session).
  const s = { dist: [], timeMs: [], speed: [], longG: [], latG: [] }
  let t = 0, v = 20
  for (let d = 0; d <= 2000; d++) {
    const inCorner = d % 400 < 150
    const lat = inCorner ? 1.1 : 0.05
    const along = inCorner ? 0.2 : (d % 400 < 300 ? 0.3 : -0.9)
    if (d > 0) { t += 1000 / v; v = Math.max(15, Math.min(50, Math.sqrt(v * v + 2 * along * 9.80665))) }
    const realAlong = d > 0 ? along : 0
    s.dist.push(d); s.timeMs.push(t); s.speed.push(v); s.latG.push(lat)
    s.longG.push((v === 15 || v === 50 ? 0 : realAlong) - 0.35 * lat)
  }
  const cal = phases.calibrateLongG(s)
  assert.ok(cal.applied)
  assert.ok(Math.abs(cal.leak + 0.35) < 0.05, `leak ${cal.leak}`)
  const cornerSample = s.longG[50]
  assert.ok(cornerSample > 0, `corner exit reads as acceleration after calibration (${cornerSample})`)
})
