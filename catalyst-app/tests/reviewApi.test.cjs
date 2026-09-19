const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const { registerApiHandlers } = require('../dist-main/main/ipc.js')
const { ReviewService } = require('../dist-main/garmin/reviewStore.js')
const { aggregateLaps, measureLap, buildComparison } = require('../dist-main/garmin/reviewMetrics.js')
const config = require('../dist-main/garmin/config.js')
const keys = require('../dist-main/main/aiKeyStore.js')
const harness = require('../dist-main/garmin/agentHarness.js')
const garage = require('../dist-main/garmin/garageStore.js')
const db = require('../dist-main/garmin/loadToDb.js')
const paths = require('../dist-main/garmin/paths.js')
const guid = '11111111-1111-1111-1111-111111111111'

function setup(t, modelResponse) {
  const laps = [10000, 10100, 10200].map((durationMs, index) => measureLap({ index, durationMs, type: 'DRIVEN', descriptor: 0,
    samples: Array.from({ length: 101 }, (_, d) => ({ distance: d, time: d * durationMs / 100, speed: 10 })) }, [], 100))
  const summary = { sessionGuid: guid, start: '2026-09-01 10:00:00', vehicleGuid: 'car', account: 'driver', configurationId: 1,
    cartographyId: 1, reverse: false, direction: 'clockwise', meanLineGuid: 'line', geometryRevision: 'g', sourceRevision: 's',
    conditions: { surface: 'dry', surfaceSource: 'estimated', temperatureC: 20 }, ...aggregateLaps(laps, []) }
  const snapshot = { ...buildComparison({ summary, laps, map: [], revision: 'a', version: 1 }, [], { catalog: 1, downloaded: 1, processed: 1, pending: 0, failed: 0 }), revision: 'saved-revision' }
  const saved = [], events = [], calls = []
  let finish
  const terminal = new Promise(resolve => { finish = resolve })
  t.mock.method(ReviewService.prototype, 'initialize', async () => {})
  t.mock.method(ReviewService.prototype, 'get', async () => ({ state: 'ready', snapshot, coaching: saved.at(-1), coachingStale: false }))
  t.mock.method(ReviewService.prototype, 'ensure', async (...args) => { calls.push(['ensure', ...args]) })
  t.mock.method(ReviewService.prototype, 'progress', async (...args) => { calls.push(['progress', ...args]); return {} })
  t.mock.method(ReviewService.prototype, 'kick', () => {})
  const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', file => file === paths.DB_PATH || exists(file))
  t.mock.method(config, 'loadConfig', () => ({ units: 'imperial', ai: { provider: 'openai', model: 'gpt-6-astra' } }))
  t.mock.method(keys, 'migrateAiConfig', async () => {})
  t.mock.method(garage, 'resolveGarageVehicleProfile', async () => ({ profile: 'Car' }))
  t.mock.method(garage, 'listGarageFiles', async () => [])
  t.mock.method(db, 'withDb', async fn => fn === db.existingSessionGuids ? new Set([guid]) : fn({}))
  t.mock.method(db, 'initSchema', async () => {})
  t.mock.method(db, 'insertCoachingSession', async (_con, session) => { saved.push(session) })
  const agent = t.mock.method(harness, 'runAgent', async (prompt, options, onChunk) => {
    assert.match(prompt, /"paceMs":10100/)
    assert.equal(options.tools[0].name, 'submit_session_review')
    assert.equal(options.stream, true)
    onChunk('[status] Generating session advice\n')
    if (modelResponse instanceof Error) throw modelResponse
    return JSON.stringify(modelResponse)
  })
  const handlers = new Map()
  registerApiHandlers((name, handler) => handlers.set(name, handler), () => ({ isDestroyed: () => false, webContents: { send: (channel, event) => {
    events.push({ channel, ...event }); if (event.type === 'done' || event.type === 'error') finish(event)
  } } }), undefined, undefined, { read: async () => ({ openai: 'fixture' }), write: async () => {} })
  return { handlers, saved, events, calls, terminal, agent, snapshot }
}
const result = { summary: 'Establish a repeatable reference', strengths: [], regressions: [], limitations: ['No historical baseline'],
  priorities: [{ ref: 'session', advice: 'Repeat your current pace', cue: 'Repeat first', successMetric: 'Two laps near the measured 10.1 s mean', evidence: ['pace'] }] }

test('review bridge accepts Electron omissions and HTTP null arguments without triggering coaching', async t => {
  const { handlers, calls, agent } = setup(t, result)
  for (const retry of [undefined, null, false, true]) await handlers.get('review:ensure')(null, guid, retry)
  for (const filters of [undefined, null, {}]) await handlers.get('review:progress')(null, filters)
  await handlers.get('review:get')(null, guid)
  assert.deepEqual(calls.slice(0, 4).map(c => c[2]), [false, false, false, true])
  assert.deepEqual(calls.slice(4).map(c => c[1]), [{}, {}, {}])
  assert.equal(agent.mock.callCount(), 0)
  await assert.rejects(handlers.get('review:ensure')(null, guid, 'yes'), /Invalid retry/)
})
test('review coaching persists prompt, provider, revision, evidence and structured response before streaming completion', async t => {
  const { handlers, terminal, saved, events, agent } = setup(t, result)
  await handlers.get('coach:run')(null, { profile: 'Car', scope: 'session-review', sessionGuids: [guid], reviewRevision: 'saved-revision' })
  assert.equal((await terminal).type, 'done')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].review_context.provider, 'openai')
  assert.equal(saved[0].review_context.revision, 'saved-revision')
  assert.equal(saved[0].review_result.priorities[0].evidence[0], 'pace')
  assert.ok(saved[0].prompt.includes(saved[0].review_context.evidence.pace))
  assert.ok(events.some(e => e.type === 'progress' && e.progress.label === 'Generating session advice'))
  await handlers.get('review:get')(null, guid)
  assert.equal(agent.mock.callCount(), 1, 'reopening never regenerates a saved report')
})
test('review coaching rejects stale snapshots and pending history before contacting a provider', async t => {
  const { handlers, snapshot, agent } = setup(t, result)
  const opts = { profile: 'Car', scope: 'session-review', sessionGuids: [guid], reviewRevision: 'old' }
  await assert.rejects(handlers.get('coach:run')(null, opts), /Review changed/)
  snapshot.coverage.pending = 1
  await assert.rejects(handlers.get('coach:run')(null, { ...opts, reviewRevision: 'saved-revision' }), /history is still processing/)
  assert.equal(agent.mock.callCount(), 0)
})
test('review provider failures preserve the prompt and emit a retryable error', async t => {
  const { handlers, terminal, saved } = setup(t, new Error('Provider unavailable'))
  await handlers.get('coach:run')(null, { profile: 'Car', scope: 'session-review', sessionGuids: [guid], reviewRevision: 'saved-revision' })
  assert.equal((await terminal).type, 'error')
  assert.equal(saved[0].review_context.error, 'Provider unavailable')
  assert.match(saved[0].prompt, /"paceMs":10100/)
  assert.equal(saved[0].review_result, null)
})
