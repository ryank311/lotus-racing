const assert = require('node:assert/strict')
const { test } = require('node:test')
const { measureLap, aggregateLaps, buildComparison, inferSurface, mismatch, REVIEW_VERSION } = require('../dist-main/garmin/reviewMetrics.js')
const { buildReviewCoachPrompt, parseReviewCoaching, reviewCoachingTool } = require('../dist-main/garmin/reviewCoach.js')
const { validateConditions, validateProgressFilters } = require('../dist-main/garmin/reviewStore.js')

const regions = [
  { id: 'corner:T1', name: 'T1', kind: 'corner', startM: 20.5, endM: 60.5 },
  { id: 'segment:S1', name: 'S1', kind: 'segment', startM: 0, endM: 60 },
  { id: 'segment:S2', name: 'S2', kind: 'segment', startM: 40, endM: 100 },
]
const input = (duration = 10000, extra = {}) => ({ index: 0, durationMs: duration, type: 'DRIVEN', descriptor: 0,
  samples: Array.from({ length: 101 }, (_, d) => ({ distance: d, time: d * duration / 100, speed: 10 + Math.abs(d - 40) / 10 })), ...extra })
const make = (id, pace, extra = {}, count = 3) => {
  const laps = Array.from({ length: count }, (_, i) => measureLap(input(pace + i * 10, { index: i }), regions, 100))
  return { version: REVIEW_VERSION, revision: id, map: [], laps, summary: {
    sessionGuid: id, start: `2026-09-${id.padStart(2, '0')} 10:00:00`, track: 'Track', layout: 'Full', vehicle: 'Car',
    account: 'driver', vehicleGuid: 'car', configurationId: 1, cartographyId: 1, reverse: false, direction: 'clockwise',
    meanLineGuid: 'line', geometryRevision: 'geometry', sourceRevision: id, conditions: { surface: 'dry', temperatureC: 20,
      surfaceSource: 'estimated', temperatureSource: 'recorded', originalTemperatureC: 20, weather: 'Fair', correctedAt: null },
    qualityNotes: [], ...aggregateLaps(laps, regions), ...extra,
  } }
}
const coverage = { catalog: 5, downloaded: 5, processed: 5, pending: 0, failed: 0 }

test('elapsed-time interpolation preserves overlapping segment windows and V-min location', () => {
  const lap = measureLap(input(), regions, 100)
  assert.equal(lap.eligible, true)
  assert.equal(lap.regions['corner:T1'].timeMs, 4000)
  assert.equal(lap.regions['corner:T1'].vminMps, 10)
  assert.equal(lap.regions['corner:T1'].vminDistanceM, 40)
  assert.equal(lap.regions['segment:S1'].timeMs + lap.regions['segment:S2'].timeMs, 12000)
  assert.ok(Math.abs(lap.regions['corner:T1'].entryMps - 11.7) < 1e-9)
  assert.ok(Math.abs(lap.regions['corner:T1'].exitMps - 11.8) < 1e-9)
  const boundary = measureLap(input(), [{ ...regions[0], startM: 20.5, endM: 21.5 }], 100).regions['corner:T1']
  assert.equal(boundary.vminDistanceM, 21.5)
  assert.ok(Math.abs(boundary.vminMps - 11.85) < 1e-9, 'minimum includes interpolated boundary speeds')
})
test('flags, missing coverage, timing reversals, gaps and manual exclusions reject laps', () => {
  for (const descriptor of [2, 4, 8, 16, 6]) assert.equal(measureLap(input(10000, { descriptor }), regions, 100).eligible, false)
  assert.equal(measureLap(input(10000, { descriptor: 1 }), regions, 100).eligible, true)
  assert.equal(measureLap(input(10000, { excluded: true, exclusionReason: 'Traffic' }), regions, 100).eligible, false)
  assert.equal(measureLap(input(10000, { samples: input().samples.slice(0, 80) }), regions, 100).eligible, false)
  const bad = input(); bad.samples[50].time = 100
  assert.equal(measureLap(bad, regions, 100).eligible, false)
  const gap = input(); gap.samples.splice(30, 30)
  assert.equal(measureLap(gap, regions, 100).eligible, false)
  const missing = input(); missing.samples[40].speed = null
  assert.equal(measureLap(missing, regions, 100).regions['corner:T1'].vminMps, null)
  assert.equal(measureLap(missing, regions, 100).topSpeedMps, null, 'a missing speed prevents a measured lap maximum')
})
test('fastest three and representative consistency use different explicit populations', () => {
  const laps = [10000, 10010, 10020, 10400, 13000].map((d, index) => measureLap(input(d, { index }), regions, 100))
  const a = aggregateLaps(laps, regions)
  assert.equal(a.paceMs, 10010); assert.equal(a.representativeCount, 4)
  assert.equal(a.fastLapCount, 3); assert.equal(a.bestLapMs, 10000)
  assert.deepEqual(laps.filter(l => l.selected).map(l => l.index), [0, 1, 2])
  laps[4].topSpeedMps = 50
  assert.equal(aggregateLaps(laps, regions).peakSpeedLap, 4, 'highest observed speed includes all eligible laps')
  assert.notEqual(aggregateLaps(laps, regions).topSpeedMps, 50, 'mean maximum still uses fast laps')
  assert.equal(aggregateLaps([laps[0]], regions).consistencyMs, null)
})
test('matching isolates identity, direction and conditions at inclusive temperature boundaries', () => {
  const a = make('8', 10000).summary, b = make('1', 10000).summary
  assert.equal(mismatch(a, b), null)
  for (const [key, value] of Object.entries({ vehicleGuid: 'other', account: 'other', configurationId: 2, cartographyId: 2, reverse: true, direction: 'counterclockwise' })) assert.ok(mismatch(a, { ...b, [key]: value }))
  assert.ok(mismatch(a, { ...b, vehicleGuid: null }))
  assert.equal(mismatch(a, { ...b, conditions: { ...b.conditions, temperatureC: 25 } }), null)
  assert.ok(mismatch(a, { ...b, conditions: { ...b.conditions, temperatureC: 25.01 } }))
  for (const surface of ['wet', 'unknown']) assert.ok(mismatch(a, { ...b, conditions: { ...b.conditions, surface } }))
  assert.ok(mismatch(a, { ...b, start: a.start }))
  assert.equal(inferSurface('Mist'), 'unknown'); assert.equal(inferSurface('Light Rain'), 'wet'); assert.equal(inferSurface('Mostly Cloudy'), 'dry')
})
test('baseline uses five previous equally weighted sessions, never future sessions', () => {
  const past = [1, 2, 3, 4, 5, 6].map(n => make(String(n), 10000 + n * 100, {}, n === 6 ? 1 : 3))
  const current = make('8', 9500), future = make('9', 8000)
  const result = buildComparison(current, [...past, future, current].map(s => s.summary), coverage)
  assert.deepEqual(result.baseline.map(s => s.sessionGuid), ['6', '5', '4', '3', '2'])
  assert.equal(result.pace.baseline, (10600 + 10510 + 10410 + 10310 + 10210) / 5)
  assert.equal(result.bestLap.personalBest, 10100)
  assert.equal(result.pace.previous, 10600)
  assert.equal(result.pace.clearChange, 'gain')
  assert.equal(result.regions[0].metrics.timeMs.personalBest, 4040)
})
test('geometry mismatch preserves pace comparisons and excludes regional comparisons', () => {
  const current = make('8', 9000), past = make('1', 10000, { geometryRevision: 'old' })
  const result = buildComparison(current, [past.summary], coverage)
  assert.equal(result.pace.baseline, 10010)
  assert.equal(result.regions[0].metrics.timeMs.baseline, null)
})
test('clear changes require repeatability, sufficient populations and variability threshold', () => {
  const current = make('8', 9000), three = [1, 2, 3].map(n => make(String(n), 10000).summary)
  assert.equal(buildComparison(current, three, coverage).pace.clearChange, 'gain')
  assert.equal(buildComparison(current, three.slice(0, 2), coverage).pace.clearChange, null)
  assert.equal(buildComparison(make('8', 9000, {}, 2), three, coverage).pace.clearChange, null)
  assert.equal(buildComparison(make('8', 9900), three, coverage).pace.clearChange, null)
  const noisy = [make('1', 5000), make('2', 10000), make('3', 15000)].map(s => s.summary)
  assert.equal(buildComparison(current, noisy, coverage).pace.clearChange, null)
})
test('coach packet uses the exact comparison and rejects unsupported evidence', () => {
  const snapshot = { ...buildComparison(make('8', 9000), [1, 2, 3].map(n => make(String(n), 10000).summary), coverage), revision: 'snapshot' }
  const pack = buildReviewCoachPrompt(snapshot, 'Driver notes', 'imperial')
  assert.match(pack.prompt, /mph/); assert.match(pack.prompt, /"delta":-1000/)
  assert.match(pack.evidence.pace, /-1.000 s/)
  const good = { summary: 'T1 improved', strengths: [], regressions: [], limitations: [], priorities: [{ ref: 'corner:T1', advice: 'Repeat the exit', evidence: ['corner:T1'], cue: 'Build speed', successMetric: 'Repeat on two laps' }] }
  assert.equal(parseReviewCoaching(JSON.stringify(good), snapshot, pack.evidence).priorities.length, 1)
  assert.throws(() => parseReviewCoaching(JSON.stringify({ ...good, priorities: [{ ...good.priorities[0], evidence: ['invented'] }] }), snapshot, pack.evidence))
  assert.throws(() => parseReviewCoaching(JSON.stringify({ ...good, priorities: Array(4).fill(good.priorities[0]) }), snapshot, pack.evidence))
  assert.ok(reviewCoachingTool(snapshot, pack.evidence).input_schema.properties.priorities.maxItems === 3)
  assert.match(buildReviewCoachPrompt(snapshot, '', 'metric').prompt, /km\/h/)
})
test('override/filter validation rejects nonfinite data and invalid identifiers', () => {
  assert.throws(() => validateConditions({ surface: 'sand', temperatureC: 20 }))
  assert.throws(() => validateConditions({ surface: 'dry', temperatureC: NaN }))
  assert.throws(() => validateProgressFilters({ temperatureC: Infinity }))
  assert.throws(() => validateProgressFilters({ reverse: 'false' }))
  assert.doesNotThrow(() => validateConditions({ surface: null, temperatureC: null }))
})
