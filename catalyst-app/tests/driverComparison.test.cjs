const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// One fixture workspace holds both "drivers": exportComparison reads the
// other driver's sessions exactly as their own backend would.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-compare-'))
process.env.CATALYST_INSTANCE_DIR = root
const { initSchema, withDb, releaseSharedInstance } = require('../dist-main/garmin/loadToDb.js')
const { DB_PATH, TRACKS_DIR } = require('../dist-main/garmin/paths.js')
const { buildAnalysis } = require('../dist-main/garmin/analysisData.js')
const { exportComparison } = require('../dist-main/garmin/driverComparison.js')
const { parseCompareParams, compareParams, isCompareParam } = require('../dist-main/shared/comparison.js')
const { TRACK_YAML, lapRows, seed } = require('./fixtures/compareFixture.cjs')

const db = fn => withDb(fn, DB_PATH)

test('another driver’s laps overlay your analysis on the same layout', async t => {
  t.after(() => { releaseSharedInstance(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.mkdirSync(TRACKS_DIR, { recursive: true })
  fs.writeFileSync(path.join(TRACKS_DIR, 'test-raceway.yaml'), TRACK_YAML)
  await db(initSchema)
  await db(con => seed(con, [
    { sg: 'mine-1', start: '2026-10-30 10:00:00', laps: [1.0, 0.98] },
    { sg: 'theirs-1', start: '2026-10-29 14:00:00', vehicle: 'their-car', laps: [1.05, 1.02, 1.0] },
    { sg: 'theirs-other-car', start: '2026-10-28 14:00:00', vehicle: 'third-car', laps: [1.0] },
    { sg: 'theirs-grand', start: '2026-10-27 14:00:00', meanLine: 'grand-line', configId: 99, config: 'Grand West', laps: [1.0] },
    { sg: 'theirs-overview', start: '2026-10-26 14:00:00', detailsLoaded: false, laps: [1.0] },
  ]))
  const mineMs = lapRows(1.0).durationMs, theirMs = lapRows(1.05).durationMs

  let bundle
  await t.test('export carries the selected laps, their samples and session layout', async () => {
    const exported = await exportComparison(['theirs-1'], 'top3')
    assert.equal(exported.laps.length, 3)
    assert.equal(exported.laps[0].samples.dist.length, 1001)
    assert.deepEqual(Object.keys(exported.laps[0].samples).sort(), ['accelX', 'accelY', 'dist', 'lat', 'lateral', 'lon', 'speed', 'timeMs'])
    assert.equal(exported.sessions[0].meanLineGuid, 'test-line')
    assert.equal(exported.sessions[0].vehicle, 'LOTUS EXIGE')
    assert.equal((await exportComparison(['theirs-1'], 'session-best')).laps.length, 1, 'the lap filter applies to their laps too')
    bundle = { ...exported, driver: 'Alex' }
  })

  await t.test('export refuses sessions it cannot compare', async () => {
    await assert.rejects(exportComparison(['theirs-overview']), /not been downloaded/)
    await assert.rejects(exportComparison(['theirs-1', 'theirs-grand']), /one track layout/)
    await assert.rejects(exportComparison(['theirs-1', 'theirs-other-car']), /one vehicle/)
    await assert.rejects(exportComparison(['missing']), /no longer available/)
    await assert.rejects(exportComparison([]), /at least one session/)
  })

  await t.test('analysis merges compared laps into the charts and the comparison card', async () => {
    const solo = await buildAnalysis(['mine-1'], 'metric', 'top10')
    const data = await buildAnalysis(['mine-1'], 'metric', 'top10', [bundle])
    assert.equal(solo.comparison, null)

    // Your own laps and stats are unchanged by the comparison.
    assert.equal(data.laps.length, 2)
    assert.equal(data.bestLap.durationMs, solo.bestLap.durationMs)
    assert.equal(data.theoreticalBestMs, solo.theoreticalBestMs)
    assert.deepEqual(data.heatmap, solo.heatmap)
    assert.deepEqual(data.cornerRows, solo.cornerRows)
    assert.ok(data.laps.every(l => l.driverIndex === 0 && !l.driver))

    // Their laps are overlaid, labelled and coloured as driver 1.
    const theirs = data.speedTraces.filter(tr => tr.driverIndex === 1)
    assert.equal(theirs.length, 3)
    assert.ok(theirs.every(tr => tr.label.startsWith('Alex · ') && tr.driver === 'Alex'))
    assert.equal(theirs.filter(tr => tr.driverBest).length, 1)
    assert.equal(theirs.find(tr => tr.driverBest).durationMs, theirMs)
    assert.equal(data.longgTraces.filter(tr => tr.driverIndex === 1).length, 3)

    // Time deltas are against your fastest lap: their faster lap ends ahead.
    const delta = data.timeDeltaTraces.find(tr => tr.driverBest)
    assert.ok(Math.abs(delta.delta_s.at(-1) - (theirMs - data.bestLap.durationMs) / 1000) < 1e-9)
    assert.ok(delta.delta_s.at(-1) < 0)

    const [you, alex] = data.comparison.drivers
    assert.deepEqual([you.name, you.self, alex.name, alex.self], ['You', true, 'Alex', false])
    assert.equal(you.bestLap.durationMs, data.bestLap.durationMs)
    assert.equal(alex.bestLap.durationMs, theirMs)
    assert.equal(alex.lapCount, 3)
    assert.ok(alex.topSpeed > you.topSpeed)

    // Split differences on the fastest laps add up to the lap-time gap.
    assert.deepEqual(data.comparison.segments.map(s => s.id), ['S1', 'S2'])
    const splitGap = data.comparison.segments.reduce((sum, s) => sum + s.bestLap[0] - s.bestLap[1], 0)
    assert.ok(Math.abs(splitGap - (you.bestLap.durationMs - theirMs) / 1000) < 0.002)

    const [t1] = data.comparison.corners
    assert.equal(t1.turn, 'T1')
    assert.ok(t1.drivers[1].apex > t1.drivers[0].apex, 'the faster driver carries more minimum speed')
    assert.ok(t1.drivers[0].brakeOnsetM != null && t1.drivers[0].brakeOnsetM < 500)
    void mineMs
  })

  await t.test('in-memory traces match the per-lap database queries they replace', async () => {
    const data = await buildAnalysis(['mine-1'], 'metric', 'top10')
    for (const trace of data.speedTraces) {
      const rows = await db(async con => (await con.runAndReadAll(
        'SELECT distance_m, gnss_speed_mps FROM samples WHERE session_guid = ? AND lap_index = ? AND distance_m % 25 = 0 AND gnss_speed_mps IS NOT NULL ORDER BY distance_m',
        [trace.sg, trace.lapIdx])).getRowsJson())
      assert.deepEqual(trace.dist, rows.map(r => Number(r[0])))
      assert.deepEqual(trace.speed_mph.map(v => Math.round(v * 1e6)), rows.map(r => Math.round(Number(r[1]) * 3.6 * 1e6)))
    }
    assert.equal(data.trackMap.dist.length, 101)
    assert.equal(data.lateralTraces[0].pos[0], 0.5)
  })

  await t.test('compared sessions must be on your layout and not already selected', async () => {
    const grand = { ...bundle, sessions: bundle.sessions.map(s => ({ ...s, meanLineGuid: 'grand-line', configurationId: 99, configName: 'Grand West' })) }
    await assert.rejects(buildAnalysis(['mine-1'], 'metric', 'top10', [grand]), /Alex's session .* is on Test Raceway · Grand West/)
    const duplicate = { ...bundle, sessions: [...bundle.sessions, { ...bundle.sessions[0], sg: 'mine-1' }] }
    await assert.rejects(buildAnalysis(['mine-1'], 'metric', 'top10', [duplicate]), /already in this analysis/)
    const broken = { ...bundle, laps: [{ ...bundle.laps[0], samples: { dist: [0, 1] } }] }
    await assert.rejects(buildAnalysis(['mine-1'], 'metric', 'top10', [broken]), /incomplete/)
    // Desktop IPC passes the renderer's request through unresolved.
    await assert.rejects(buildAnalysis(['mine-1'], 'metric', 'top10', [{ driver: 'Alex', sessionGuids: ['theirs-1'] }]), /needs the Catalyst server/)
    await assert.rejects(buildAnalysis(['mine-1'], 'metric', 'top10', [bundle, bundle, bundle, bundle, bundle]), /up to 4 drivers/)
  })
})

test('compare URL values round-trip and reject malformed entries', () => {
  const requests = [{ driver: 'Desktop 2', sessionGuids: ['a-1', 'b-2'] }, { driver: 'alex', sessionGuids: ['c-3'] }]
  assert.deepEqual(parseCompareParams(compareParams(requests)), requests)
  assert.deepEqual(parseCompareParams(['Alex:x', 'ALEX:y', 'Alex:x']), [{ driver: 'Alex', sessionGuids: ['x', 'y'] }])
  for (const bad of ['no-colon', ':guid', 'Alex:', 'Alex:a b', 'Alex:a/b', ' Alex:x', 'Alex:a:b', `${'x'.repeat(41)}:g`]) {
    assert.equal(isCompareParam(bad), false, bad)
  }
})
