const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Keep all telemetry, generated track definitions and reports in a fixture workspace.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-track-scope-'))
process.env.CATALYST_INSTANCE_DIR = root
const { initSchema, withDb, releaseSharedInstance, insertCoachingSession } = require('../dist-main/garmin/loadToDb.js')
const { DB_PATH, TRACKS_DIR } = require('../dist-main/garmin/paths.js')
const { buildAnalysis } = require('../dist-main/garmin/analysisData.js')
const { buildCoachPacket, latestFocus, assertComparable } = require('../dist-main/garmin/coachPacket.js')
const { focusForSession } = require('../dist-main/garmin/focusService.js')

test('VIR comparisons and coaching keep Full Course and Grand West separate', async t => {
  t.after(() => { releaseSharedInstance(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.mkdirSync(TRACKS_DIR, { recursive: true })
  const db = fn => withDb(fn, DB_PATH)
  await db(initSchema)
  for (const [id, config, line, ms] of [['full', 'Full Course', 'full-line', 10000], ['grand', 'Grand West Course', 'grand-line', 13000]]) {
    fs.writeFileSync(path.join(TRACKS_DIR, `${id}.yaml`), `track_name: Virginia International Raceway\ntrack_configuration_name: ${config}\nmean_line_guid: ${line}\ntotal_dist_m: 100\ncomplexes:\n  - id: C1\n    name: ${config} turn\n    start_m: 0\n    end_m: 100\n    corners: T1\nsegments:\n  - id: 1\n    start_dist_m: 0\n    end_dist_m: 100\ncorners:\n`)
    await db(async con => {
      await con.run(`INSERT INTO sessions (session_guid, session_start, track_name, track_configuration_name,
        track_configuration_id, mean_line_guid, vehicle_guid, account, details_loaded)
        VALUES (?, '2026-10-30 14:00:00', 'Virginia International Raceway', ?, ?, ?, 'car', 'driver', true)`,
        [id, config, id === 'full' ? 72 : 99, line])
      await con.run("INSERT INTO laps (session_guid, lap_index, lap_type, duration_ms, lap_descriptor) VALUES (?, 0, 'DRIVEN', ?, 0)", [id, ms])
      for (let distance = 0; distance <= 100; distance += 10) await con.run(
        'INSERT INTO samples (session_guid, lap_index, distance_m, time_ms, gnss_speed_mps) VALUES (?, 0, ?, ?, 10)', [id, distance, distance * ms / 100])
    })
  }

  await t.test('Analysis rejects a mixed-course request before calculating fastest laps or map data', async () => {
    await assert.rejects(buildAnalysis(['full', 'grand']), /one track layout.*Full Course.*Grand West Course/)
    await assert.rejects(buildAnalysis([]), /[Nn]o sessions/)
    await assert.rejects(buildAnalysis(['full', 'missing']), /unavailable/)
  })
  await t.test('single-course analysis and coach packets retain the selected course and PB', async () => {
    for (const [id, config, ms] of [['full', 'Full Course', 10000], ['grand', 'Grand West Course', 13000]]) {
      const analysis = await buildAnalysis([id])
      assert.equal(analysis.config, config)
      assert.equal(analysis.bestLap.durationMs, ms)
      assert.deepEqual(analysis.sessions.map(s => s.sg), [id])
      const packet = await db(con => buildCoachPacket(con, { sessionGuids: [id], system: 'imperial' }))
      assert.equal(packet.trackLabel, `Virginia International Raceway · ${config}`)
      assert.equal(packet.allTimePb.ms, ms)
      assert.equal(packet.complexes[0].name, `${config} turn`)
    }
    await assert.rejects(db(con => buildCoachPacket(con, { sessionGuids: ['full', 'grand'], system: 'imperial' })), /one track layout/)
    await assert.rejects(db(con => buildCoachPacket(con, { sessionGuids: ['full', 'missing'], system: 'imperial' })), /unavailable/)
  })
  await t.test('missing mean lines cannot reuse focus from another configuration', async () => {
    const context = { vehicleGuid: 'car', account: 'driver', meanLineGuid: null, configurationId: 72,
      trackLabel: 'Virginia International Raceway · Full Course', latestSessionStart: '2026-10-29 10:00:00', units: 'imperial', lapFilter: 'top10' }
    await db(con => insertCoachingSession(con, { id: 'full-report', created_at: '2026-10-29T18:00:00Z', session_guids: ['full'],
      profile_name: 'Car', model_used: 'fixture', title: 'Full Course focus', prompt: '', raw_response: '',
      parsed_result: { context, focus: [{ id: 'full-focus' }] } }))
    assert.equal((await db(con => latestFocus(con, context))).reportId, 'full-report')
    assert.equal(await db(con => latestFocus(con, { ...context, configurationId: 99, trackLabel: 'Virginia International Raceway · Grand West Course' })), null)
    await db(con => con.run("UPDATE sessions SET mean_line_guid = NULL WHERE session_guid = 'grand'"))
    assert.equal(await db(con => focusForSession(con, 'grand', 'imperial')), null)
  })
  await t.test('a conflicting configuration cannot set the PB even with a reused map ID', async () => {
    await db(async con => {
      await con.run("UPDATE sessions SET mean_line_guid = 'full-line' WHERE session_guid = 'grand'")
      await con.run("UPDATE laps SET duration_ms = 5000 WHERE session_guid = 'grand'")
    })
    const packet = await db(con => buildCoachPacket(con, { sessionGuids: ['full'], system: 'imperial' }))
    assert.equal(packet.allTimePb.ms, 10000)
  })
})

test('comparison validation needs a known layout and honors configuration conflicts', () => {
  const full = { session_guid: 'full', mean_line_guid: null, track_configuration_id: null,
    track_name: 'Virginia International Raceway', track_configuration_name: 'Full Course', vehicle_guid: 'car' }
  assert.doesNotThrow(() => assertComparable([full, { ...full, session_guid: 'another-full' }]))
  assert.throws(() => assertComparable([full, { ...full, track_name: 'Another circuit' }]), /one track layout/)
  assert.throws(() => assertComparable([{ ...full, track_name: null, track_configuration_name: null },
    { ...full, track_name: null, track_configuration_name: null }]), /layout/)
  assert.throws(() => assertComparable([{ ...full, mean_line_guid: 'shared', track_configuration_id: 72 },
    { ...full, mean_line_guid: 'shared', track_configuration_id: 99 }]), /one track layout/)
})
