const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const { registerApiHandlers } = require('../dist-main/main/ipc.js')
const config = require('../dist-main/garmin/config.js')
const keys = require('../dist-main/main/aiKeyStore.js')
const prompts = require('../dist-main/garmin/promptPack.js')
const harness = require('../dist-main/garmin/agentHarness.js')
const db = require('../dist-main/garmin/loadToDb.js')
const paths = require('../dist-main/garmin/paths.js')
const guid = '11111111-1111-1111-1111-111111111111'
const complex = { id: 'C1', name: 'T1 · Horse Shoe', startM: 100, endM: 600, corners: ['T1'] }
const stat = (median, best) => ({ n: 4, median, spread: 1, best, bestLap: 'S1L2', bestExec: best, onBestLap: best })
const fixturePacket = {
  version: 2, units: 'imperial', trackLabel: 'VIR · Full Course', totalM: 5255, complexSource: 'track',
  context: { vehicleGuid: 'v', account: 'a', meanLineGuid: 'm', configurationId: 1, trackLabel: 'VIR · Full Course', lapFilter: 'top10', latestSessionStart: '2026-05-24 16:15:34', units: 'imperial' },
  vehicleLabel: 'Lotus', sessions: [], complexes: [complex], bestLap: { durationMs: 134000, label: 'May 24 16:15 · L2' }, idealMs: 133500,
  laps: [{ id: 'S1L2', label: 'May 24 16:15 · L2' }],
  stats: { C1: { time: stat(15500, 15300), exit200: stat(35, 36), vmin: stat(20, 21) } },
  allTimePb: null, garminOptimalMs: null, opportunities: [], lapNumberPace: [], previousFocus: [],
  evidence: { 'C1.time': 'T1 time: median 15.50 s.', 'C1.exit200': 'T1 exit: median 78 mph.' },
  successMetrics: ['C1.time', 'C1.exit200'],
}

async function run(t, response, provider = 'anthropic') {
  const saved = []
  const events = []
  const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', file => file === paths.DB_PATH || exists(file))
  t.mock.method(config, 'loadConfig', () => ({ ai: { provider, model: provider === 'openai' ? 'gpt-6-astra' : 'claude-fable-5-1' } }))
  t.mock.method(keys, 'migrateAiConfig', async () => {})
  t.mock.method(prompts, 'runCoach', async () => ({
    prompt: 'fixture prompt', system: 'fixture system', profile: 'Lotus', sessionAliases: {},
    tool: { name: 'submit_coaching_report', input_schema: {} }, packet: fixturePacket,
  }))
  t.mock.method(harness, 'runAgent', async (_prompt, _config, onChunk) => {
    assert.equal(_config.stream, true)
    assert.equal(_config.system, 'fixture system')
    assert.equal(_config.reasoningEffort, 'xhigh')
    onChunk('[status] Receiving coaching report\n')
    onChunk('[diag] output_tokens=42\n')
    return response
  })
  t.mock.method(db, 'withDb', async fn => fn === db.existingSessionGuids ? new Set([guid]) : fn({}))
  t.mock.method(db, 'initSchema', async () => {})
  t.mock.method(db, 'insertCoachingSession', async (_con, session) => { saved.push(session) })
  let finish
  const terminal = new Promise(resolve => { finish = resolve })
  const target = { isDestroyed: () => false, webContents: { send: (_channel, event) => {
    events.push(event)
    if (event.type === 'done' || event.type === 'error') finish(event)
  } } }
  const handlers = new Map()
  registerApiHandlers((name, handler) => handlers.set(name, handler), () => target,
    undefined, { read: async () => ({ [provider]: 'fixture' }), write: async () => {} })
  await handlers.get('coach:run')(null, { profile: 'Lotus', scope: 'overview', sessionGuids: [guid], lapFilter: 'top10' })
  await terminal
  return { events, saved }
}

test('unparseable coaching preserves the response and emits only terminal failure', async t => {
  const { events, saved } = await run(t, 'Here is prose without a structured report.')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].model_used, 'error')
  assert.equal(saved[0].parsed_result, null)
  assert.match(saved[0].raw_response, /MODEL RESPONSE:\nHere is prose/)
  assert.match(saved[0].raw_response, /output_tokens=42/)
  assert.deepEqual(events.filter(e => ['done', 'error'].includes(e.type)).map(e => e.type), ['error'])
  assert.match(events.at(-1).payload, /could not be read as a coaching report/)
})

test('valid coaching is saved before completion and reports parsed result counts', async t => {
  const { events, saved } = await run(t, JSON.stringify({ headline: 'Brake once', tips: [], annotations: [] }))
  assert.equal(saved[0].parsed_result.headline, 'Brake once')
  assert.equal(events.find(e => e.type === 'done').payload, saved[0].id)
  assert.ok(events.some(e => e.type === 'log' && /Parsed 0 focus items/.test(e.payload)))
  assert.equal(events.some(e => e.type === 'error'), false)
})

test('packet reports get app-computed targets, gains and evidence text', async t => {
  const report = {
    summary: 'Exit speed out of T1 limits your laps.', previous_focus_review: [],
    focus: [{ complex: 'C1', phase: 'exit', change: 'Pick up throttle earlier.', why: 'You coast after release.', cue: 'Eyes up, feed it in',
      evidence: ['C1.exit200', 'made-up.id'], reference_lap: 'S1L2', metric: 'C1.exit200', target: 'halfway', confidence: 'high' }],
    keep_doing: [], run_plan: [{ run: 'Run 1', focus: '1', instruction: 'Practise T1 exits.', check: 'Exit speed' }], setup: [], data_gaps: [],
  }
  const { saved } = await run(t, JSON.stringify(report))
  const result = saved[0].parsed_result
  assert.equal(result.version, 2)
  assert.equal(result.headline, report.summary)
  assert.equal(result.consistency_loss_ms, 500)
  assert.equal(result.tips[0].estimated_gain_ms, 200)
  assert.deepEqual(result.tips[0].evidence, ['T1 exit: median 78 mph.'])
  assert.equal(result.focus[0].metric, 'C1.exit200')
  assert.equal(result.focus[0].target, 35.5)
  assert.equal(result.focus[0].ref, 'T1')
  assert.equal(result.context.lapFilter, 'top10')
})

test('OpenAI coaching enables streaming and forwards progress before completion', async t => {
  const { events, saved } = await run(t, JSON.stringify({ headline: 'Brake once', tips: [], annotations: [] }), 'openai')
  const progress = events.findIndex(e => e.type === 'progress' && e.progress.label === 'Receiving coaching report')
  assert.ok(progress >= 0 && progress < events.findIndex(e => e.type === 'done'))
  assert.equal(saved[0].model_used, 'gpt-6-astra')
})
