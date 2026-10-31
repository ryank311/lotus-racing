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
const { DB_PATH, TRACKS_DIR, MEAN_LINES_DIR } = require('../dist-main/garmin/paths.js')
const { buildAnalysis } = require('../dist-main/garmin/analysisData.js')
const { exportComparison } = require('../dist-main/garmin/driverComparison.js')
const { buildCoachPacket, renderPacket } = require('../dist-main/garmin/coachPacket.js')
const { coachUserPrompt } = require('../dist-main/garmin/promptPack.js')
const { buildCoachingTool } = require('../dist-main/garmin/coachingTool.js')
const { registerApiHandlers } = require('../dist-main/main/ipc.js')
const { parseCompareParams, compareParams, isCompareParam } = require('../dist-main/shared/comparison.js')
const { TOTAL_M, OTHER_LINE, TRACK_YAML, lapRows, seed, speedAt, writeMeanLines } = require('./fixtures/compareFixture.cjs')

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

  await t.test('comparison feeds the heatmap, G-G and corner charts', async () => {
    const data = await buildAnalysis(['mine-1'], 'metric', 'top10', [bundle])
    const hm = data.comparison.heatmap
    assert.equal(hm.rows.length, 2 + 3 + 1, 'your laps, their laps, then the best of all drivers')
    assert.deepEqual(hm.rowDrivers, [0, 0, 1, 1, 1])
    assert.equal(hm.rows.at(-1), '★ Best of all drivers')
    assert.deepEqual(hm.bestDrivers, [1, 1], 'the faster driver sets both reference splits')
    assert.ok(hm.z.flat().every(v => v == null || v >= 0), 'a quicker driver is never marked implausibly fast')
    assert.equal(hm.z[2].filter(v => v === 0).length, 2, 'their fastest lap is the reference in every split')
    assert.deepEqual(data.heatmap, (await buildAnalysis(['mine-1'], 'metric', 'top10')).heatmap, 'your own heatmap is unchanged')
    assert.equal(data.comparison.gg.length, 1)
    assert.ok(data.comparison.gg[0].lat_g.length > 0)
    const rows = data.comparison.cornerRows
    assert.ok(rows.length >= 3 && rows.every(r => r.driverIndex === 1))
    assert.equal(rows.filter(r => r.driverBest).length, 1)
    assert.ok(data.comparison.cornerBrakingRows.every(r => r.driverIndex === 1))
    assert.ok(data.cornerRows.every(r => r.driverIndex == null), 'your rows match a solo analysis')
  })

  await t.test('the coach packet measures compared drivers on your complexes', async () => {
    const packet = await db(con => buildCoachPacket(con, { sessionGuids: ['mine-1'], system: 'metric', lapFilter: 'top10', comparisons: [bundle] }))
    assert.equal(packet.comparisons.length, 1)
    const [alex] = packet.comparisons
    assert.deepEqual([alex.id, alex.driver, alex.laps, alex.bestMs], ['D1', 'Alex', 3, theirMs])
    assert.match(packet.evidence['driver.D1.pace'], /^Alex \(LOTUS EXIGE; 1 session, 3 laps, same lap filter\): fastest valid lap .* quicker than your fastest/)
    const complexIds = packet.complexes.map(c => c.id)
    assert.ok(complexIds.length > 0)
    for (const id of complexIds) assert.match(packet.evidence[`driver.D1.${id}`], /best pass .* vs your .*Alex .* quicker/)
    assert.deepEqual(packet.context.comparisons, [{ driver: 'Alex', sessionGuids: ['theirs-1'] }])
    const markdown = renderPacket(packet)
    assert.match(markdown, /### Comparison drivers \(reference\)/)
    assert.match(markdown, /\| Complex \| Your best pass \| Alex best pass \| Gap to Alex \|/)
    assert.match(coachUserPrompt(packet, ''), /what can I learn from Alex\?$/)
    const tool = JSON.stringify(buildCoachingTool(packet))
    assert.ok(tool.includes('driver.D1.pace'), 'the model can cite comparison evidence')
    // Focus items stay measured on your laps only.
    assert.ok(packet.laps.every(l => !l.label.startsWith('Alex')))
    const solo = await db(con => buildCoachPacket(con, { sessionGuids: ['mine-1'], system: 'metric', lapFilter: 'top10' }))
    assert.deepEqual(solo.comparisons, [])
    assert.equal(solo.context.comparisons, undefined)
    assert.ok(!Object.keys(solo.evidence).some(id => id.startsWith('driver.')))
    const grand = { ...bundle, sessions: bundle.sessions.map(s => ({ ...s, meanLineGuid: 'grand-line', configurationId: 99 })) }
    await assert.rejects(db(con => buildCoachPacket(con, { sessionGuids: ['mine-1'], system: 'metric', comparisons: [grand] })), /is on/)
  })

  await t.test('desktop IPC resolves comparison requests through the local server', async () => {
    const handlers = new Map()
    const requests = []
    const directory = {
      list: self => (self == null ? [{ username: 'Alex', hasTelemetry: true }] : []),
      sessions: async () => [{ session_guid: 'theirs-1' }],
      resolve: async (self, lapFilter, list) => {
        requests.push({ self, lapFilter, list })
        return Promise.all(list.map(async r => ({ ...(await exportComparison(r.sessionGuids, lapFilter)), driver: r.driver })))
      },
    }
    registerApiHandlers((channel, handler) => handlers.set(channel, handler), () => null, undefined, undefined, () => directory)
    assert.deepEqual(await handlers.get('drivers:list')({}), [{ username: 'Alex', hasTelemetry: true }])
    assert.deepEqual(await handlers.get('drivers:sessions')({}, 'Alex'), [{ session_guid: 'theirs-1' }])
    const data = await handlers.get('analysis:build')({}, ['mine-1'], 'metric', 'top5', [{ driver: 'Alex', sessionGuids: ['theirs-1'] }])
    assert.deepEqual(data.comparison.drivers.map(d => d.name), ['You', 'Alex'])
    assert.deepEqual(requests, [{ self: null, lapFilter: 'top5', list: [{ driver: 'Alex', sessionGuids: ['theirs-1'] }] }])

    // A server worker has no directory: it lists nobody and expects resolved input.
    const worker = new Map()
    registerApiHandlers((channel, handler) => worker.set(channel, handler), () => null)
    assert.deepEqual(await worker.get('drivers:list')({}), [])
    await assert.rejects(worker.get('drivers:sessions')({}, 'Alex'), /needs the Catalyst server/)
    await assert.rejects(worker.get('analysis:build')({}, ['mine-1'], 'metric', 'top10', [{ driver: 'Alex', sessionGuids: ['theirs-1'] }]), /needs the Catalyst server/)
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

  // Every Catalyst device builds its own mean line, so another driver on
  // your course has a different mean-line ID and lap length.
  await t.test('a driver on their own mean line is compared on yours', async () => {
    writeMeanLines(MEAN_LINES_DIR)
    await db(con => seed(con, [{ sg: 'theirs-own-line', start: '2026-10-25 14:00:00', vehicle: 'their-car', meanLine: OTHER_LINE.meanLine, laps: [1.0] }]))
    const exported = await exportComparison(['theirs-own-line'], 'top3')
    assert.equal(exported.sessions[0].meanLineGuid, OTHER_LINE.meanLine)
    assert.equal(exported.line.guid, OTHER_LINE.meanLine)
    assert.equal(exported.line.totalM, OTHER_LINE.totalM)
    assert.ok(exported.line.dist.length > 150 && exported.line.dist.length < 260, 'their mean line travels thinned to about every 5 m')
    assert.equal(exported.laps[0].samples.dist.at(-1), OTHER_LINE.totalM)
    const sam = { ...exported, driver: 'Sam' }

    const data = await buildAnalysis(['mine-1'], 'metric', 'top10', [sam])
    const [trace] = data.speedTraces.filter(tr => tr.driver === 'Sam')
    assert.equal(trace.dist[0], 0)
    assert.equal(trace.dist.at(-1), TOTAL_M, 'their lap ends where yours does')
    // Their speed at each of your metres is the course's speed there. Scaling
    // their 1,010 m to your 1,000 m instead would be ~5 m out before T1.
    trace.dist.forEach((d, i) => assert.ok(Math.abs(trace.speed_mph[i] - speedAt(d, 1.0) * 3.6) < 0.3, `speed at ${d} m`))
    const delta = data.timeDeltaTraces.find(tr => tr.driver === 'Sam')
    assert.ok(Math.abs(delta.delta_s.at(-1) - (lapRows(1.0, OTHER_LINE).durationMs - data.bestLap.durationMs) / 1000) < 0.002, 'lap time is unchanged')
    const t1 = data.comparison.corners.find(c => c.turn === 'T1')
    assert.ok(Math.abs(t1.drivers[1].vminDistM - t1.drivers[0].vminDistM) <= 1, 'the same minimum-speed point')
    assert.ok(Math.abs(t1.drivers[1].brakeOnsetM - t1.drivers[0].brakeOnsetM) <= 2, 'the same braking point')
    const splitGap = data.comparison.segments.reduce((sum, seg) => sum + seg.bestLap[0] - seg.bestLap[1], 0)
    assert.ok(Math.abs(splitGap - (data.bestLap.durationMs - lapRows(1.0, OTHER_LINE).durationMs) / 1000) < 0.005, 'splits cover the whole lap')

    const packet = await db(con => buildCoachPacket(con, { sessionGuids: ['mine-1'], system: 'metric', lapFilter: 'top10', comparisons: [sam] }))
    assert.deepEqual([packet.comparisons[0].driver, packet.comparisons[0].laps], ['Sam', 1])
    assert.ok(packet.complexes.every(c => packet.comparisons[0].stats[c.id].time.best != null), 'every complex is measured on their lap')

    // A different course is still refused, whatever the mean line.
    const otherCourse = { ...sam, sessions: sam.sessions.map(x => ({ ...x, configurationId: 99, configName: 'Grand West' })) }
    await assert.rejects(buildAnalysis(['mine-1'], 'metric', 'top10', [otherCourse]), /is on Test Raceway · Grand West/)
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
