const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { initSchema, withDb, loadSession, insertCoachingSession, getCoachingSession, releaseSharedInstance } = require('../dist-main/garmin/loadToDb.js')
const { ReviewService } = require('../dist-main/garmin/reviewStore.js')
const { markReviewDirty } = require('../dist-main/garmin/reviewSchema.js')

test('review persistence, invalidation, snapshots, retries and isolated history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-review-store-'))
  const dbPath = path.join(root, 'test.duckdb')
  t.after(() => { releaseSharedInstance(); fs.rmSync(root, { recursive: true, force: true }) })
  const db = fn => withDb(fn, dbPath)
  let geometryRevision = 'geometry-1', fail = false
  const definition = () => {
    if (fail) throw new Error('Fixture definition failure')
    return { revision: geometryRevision, totalM: 100, map: [], regions: [{ id: 'corner:T1', name: 'T1', kind: 'corner', startM: 20, endM: 60 }] }
  }
  const events = []
  const service = new ReviewService({ dbPath, isBusy: () => true, definition, emit: e => events.push(e) })
  await db(initSchema)
  await db(con => con.run("INSERT INTO track_configs VALUES (1, 'Track', 1, 'Full', false, 'clockwise', 5)"))
  async function session(id, day, duration, account = 'driver') {
    await db(async con => {
      await con.run(`INSERT INTO sessions(session_guid, session_start, track_cartography_id, track_configuration_id,
        mean_line_guid, account, vehicle_guid, temperature_c, weather_description, details_loaded, review_source_revision)
        VALUES (?, ?, 1, 1, 'line', ?, 'car', 20, 'Fair', true, ?)`, [id, `2026-09-${String(day).padStart(2, '0')} 10:00:00`, account, id])
      for (let lap = 0; lap < 3; lap++) {
        const ms = duration + lap * 100
        await con.run("INSERT INTO laps(session_guid, lap_index, lap_type, duration_ms, lap_descriptor, sample_count) VALUES (?, ?, 'DRIVEN', ?, 0, 101)", [id, lap, ms])
        for (let d = 0; d <= 100; d++) await con.run('INSERT INTO samples(session_guid, lap_index, distance_m, time_ms, gnss_speed_mps) VALUES (?, ?, ?, ?, ?)', [id, lap, d, d * ms / 100, 10])
      }
    })
  }
  await session('a', 1, 11000); await session('b', 2, 11000); await session('c', 3, 11000); await session('current', 5, 10000)
  await session('other-driver', 4, 5000, 'other')
  await service.initialize(); await service.drain()
  let review = await service.get('current')
  assert.equal(review.state, 'ready'); assert.equal(review.snapshot.baseline.length, 3)
  assert.equal(review.snapshot.pace.delta, -1000)
  assert.equal(review.snapshot.pace.clearChange, 'gain')
  const originalRevision = review.snapshot.revision
  await service.refresh(); await service.drain()
  assert.equal((await service.get('current')).snapshot.revision, originalRevision, 'repeated discovery is idempotent')
  await db(con => insertCoachingSession(con, { id: 'report', created_at: new Date().toISOString(), session_guids: ['current'], profile_name: 'Car', model_used: 'fixture', title: 'Review', prompt: 'saved', raw_response: '{}', parsed_result: null,
    review_context: { sessionGuid: 'current', revision: originalRevision, units: 'imperial' }, review_result: { summary: 'Good progress', strengths: [], regressions: [], priorities: [], limitations: [] } }))
  assert.equal((await service.get('current')).coachingStale, false)
  assert.ok((await db(con => getCoachingSession(con, 'report'))).review_result)
  await session('future', 6, 6000); await service.refresh(); await service.drain()
  assert.equal((await service.get('current')).snapshot.revision, originalRevision, 'future sessions cannot change evidence')
  await session('older-import', 4, 12000); await service.refresh(); await service.drain()
  assert.notEqual((await service.get('current')).snapshot.revision, originalRevision, 'older imports update dependent baselines')
  assert.equal((await service.get('current')).coachingStale, true)
  await service.updateConditions('a', { surface: 'wet', temperatureC: 20 }); await service.drain()
  assert.equal((await service.get('current')).snapshot.baseline.some(s => s.sessionGuid === 'a'), false)
  await service.excludeLap('current', 0, true, 'Yellow flag'); await service.drain()
  review = await service.get('current')
  assert.equal(review.snapshot.current.summary.fastLapCount, 2)
  assert.equal(review.snapshot.current.laps[0].exclusionReason, 'Yellow flag')
  assert.equal(review.snapshot.pace.clearChange, null)
  await service.excludeLap('current', 0, false); await service.drain()
  assert.equal((await service.get('current')).snapshot.current.summary.fastLapCount, 3)
  geometryRevision = 'geometry-2'; await service.refresh(); await service.drain()
  assert.equal((await service.get('current')).snapshot.current.summary.geometryRevision, 'geometry-2')
  await db(con => con.run("UPDATE review_jobs SET state='processing' WHERE session_guid='current'"))
  const restarted = new ReviewService({ dbPath, isBusy: () => true, definition })
  await restarted.initialize(); await restarted.drain()
  assert.equal((await restarted.get('current')).state, 'ready', 'restart resumes interrupted jobs')
  const progress = await restarted.progress({ anchorSessionGuid: 'current' })
  assert.equal(progress.sessions.some(s => s.account === 'other'), false)
  assert.equal(progress.sessions.some(s => s.conditions.surface === 'wet'), false)
  const currentRef = progress.references.find(r => r.sessionGuid === 'current')
  assert.equal(currentRef.baselineMs, (await restarted.get('current')).snapshot.pace.baseline)
  // Reading cached reviews must not consult samples.
  await db(con => con.run('DROP INDEX idx_samples_session_lap'))
  await db(con => con.run('ALTER TABLE samples RENAME TO hidden_samples'))
  assert.equal((await restarted.get('current')).state, 'ready')
  assert.ok((await restarted.progress()).sessions.length)
  await db(con => con.run('ALTER TABLE hidden_samples RENAME TO samples'))
  await db(async con => {
    const saved = (await con.runAndReadAll('SELECT payload FROM review_snapshots WHERE revision=?', [originalRevision])).getRowsJson()
    assert.equal(JSON.parse(saved[0][0]).current.summary.fastLapCount, 3, 'original snapshots are immutable')
    await markReviewDirty(con, 'current')
    await con.run('ALTER TABLE samples RENAME TO hidden_samples')
  })
  await restarted.drain(); assert.equal((await restarted.get('current')).state, 'failed')
  await restarted.refresh()
  assert.equal((await restarted.get('current')).state, 'failed', 'unchanged failures wait for explicit retry')
  await db(con => con.run('ALTER TABLE hidden_samples RENAME TO samples'))
  await restarted.ensure('current', true); await restarted.drain()
  assert.equal((await restarted.get('current')).state, 'ready')
  await db(con => con.run("UPDATE review_jobs SET state='failed', attempt_revision='old-algorithm-or-geometry' WHERE session_guid='current'"))
  await restarted.refresh(); await restarted.drain()
  assert.equal((await restarted.get('current')).state, 'ready', 'changed processing inputs retry failed derived data')
  assert.ok(events.some(e => e.state === 'processing'))
  await assert.rejects(service.excludeLap('current', -1, true), /Invalid/)
  await assert.rejects(service.updateConditions('not-found', { surface: 'dry', temperatureC: 20 }), /not found/)
  const order = []
  let unblock
  const hold = new Promise(resolve => { unblock = resolve })
  const foreground = service.foreground(async () => { order.push('foreground'); await hold; order.push('released') })
  const correction = service.updateConditions('current', { surface: 'mixed', temperatureC: 20 }).then(() => order.push('correction'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['foreground'], 'override writes wait for foreground ingestion/rebuild')
  unblock(); await Promise.all([foreground, correction])
  assert.deepEqual(order, ['foreground', 'released', 'correction'])
})

test('repeat ingestion preserves review revision and telemetry changes enqueue exactly one replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-review-ingest-'))
  t.after(() => { releaseSharedInstance(); fs.rmSync(root, { recursive: true, force: true }) })
  const dbPath = path.join(root, 'review.duckdb'), sessionDir = path.join(root, 'session')
  fs.mkdirSync(sessionDir)
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify({ sessionGuid: 'session', sessionStart: '2026-09-01' }))
  fs.writeFileSync(path.join(sessionDir, 'performance.pb'), Buffer.from([8, 1]))
  t.mock.method(require('../dist-main/garmin/decodePerformance.js'), 'decodePerformance', () => ({ driven_laps: [] }))
  await withDb(async con => {
    await initSchema(con); await loadSession(con, sessionDir)
    const read = async () => (await con.runAndReadAll("SELECT s.review_source_revision, j.state, j.generation FROM sessions s JOIN review_jobs j USING(session_guid) WHERE s.session_guid='session'")).getRowsJson()[0]
    const first = await read()
    await con.run("UPDATE review_jobs SET state='ready'")
    await loadSession(con, sessionDir)
    assert.deepEqual(await read(), [first[0], 'ready', first[2]])
    fs.writeFileSync(path.join(sessionDir, 'performance.pb'), Buffer.from([8, 2]))
    await loadSession(con, sessionDir)
    const updated = await read()
    assert.notEqual(updated[0], first[0]); assert.equal(updated[1], 'pending'); assert.equal(updated[2], first[2] + 1)
  }, dbPath)
})

test('progress temperature matching is opt-in and references follow the selected history', async t => {
  const service = new ReviewService({ isBusy: () => true })
  const summary = (id, start, temperatureC, paceMs, extra = {}) => ({
    sessionGuid: id, start, account: 'driver', vehicleGuid: 'car', configurationId: 1, cartographyId: 1,
    reverse: false, direction: 'clockwise', fastLapCount: 3, paceMs, bestLapMs: paceMs - 100,
    conditions: { surface: 'dry', temperatureC }, ...extra,
  })
  const available = [
    summary('cold', '2026-01-01', 5, 10000),
    summary('unknown-temp', '2026-01-02', null, 11000),
    summary('edge', '2026-01-03', 25, 12000),
    summary('outside', '2026-01-04', 25.01, 13000),
    summary('other-car', '2026-01-04', 20, 5000, { vehicleGuid: 'other' }),
    summary('current', '2026-01-05', 20, 14000),
    summary('future', '2026-01-06', 20, 6000),
  ]
  t.mock.method(service, 'db', async fn => fn({ runAndReadAll: async () => ({ getRowObjectsJson: () => [] }) }))
  t.mock.method(service, 'summaries', async () => [...available])
  t.mock.method(service, 'coverage', async () => ({}))
  const all = await service.progress({ anchorSessionGuid: 'current' })
  assert.equal(all.filters.temperatureC, undefined)
  assert.deepEqual(all.sessions.map(s => s.sessionGuid), ['cold', 'unknown-temp', 'edge', 'outside', 'current', 'future'])
  assert.deepEqual(all.references.find(r => r.sessionGuid === 'current'), { sessionGuid: 'current', baselineMs: 11500, priorBestMs: 9900 })
  const matched = await service.progress({ anchorSessionGuid: 'current', temperatureC: 20 })
  assert.deepEqual(matched.sessions.map(s => s.sessionGuid), ['edge', 'current', 'future'])
  assert.deepEqual(matched.references.find(r => r.sessionGuid === 'current'), { sessionGuid: 'current', baselineMs: 12000, priorBestMs: 11900 })
  assert.equal((await service.progress({ anchorSessionGuid: 'unknown-temp' })).sessions.length, 6)
  assert.equal((await service.progress({ anchorSessionGuid: 'current' })).sessions.length, 6, 'clearing the filter restores all temperatures')
})
