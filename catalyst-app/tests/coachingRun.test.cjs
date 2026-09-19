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

async function run(t, response, provider = 'anthropic') {
  const saved = []
  const events = []
  const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', file => file === paths.DB_PATH || exists(file))
  t.mock.method(config, 'loadConfig', () => ({ ai: { provider, model: provider === 'openai' ? 'gpt-6-astra' : 'claude-fable-5-1' } }))
  t.mock.method(keys, 'migrateAiConfig', async () => {})
  t.mock.method(prompts, 'runCoach', async () => ({ prompt: 'fixture prompt', profile: 'Lotus', sessionAliases: {} }))
  t.mock.method(harness, 'runAgent', async (_prompt, _config, onChunk) => {
    assert.equal(_config.stream, true)
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
    undefined, undefined, { read: async () => ({ [provider]: 'fixture' }), write: async () => {} })
  await handlers.get('coach:run')(null, { profile: 'Lotus', scope: 'overview', sessionGuids: [guid], lapLimit: 10 })
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
  assert.ok(events.some(e => e.type === 'log' && /Parsed 0 tips and 0 annotations/.test(e.payload)))
  assert.equal(events.some(e => e.type === 'error'), false)
})

test('OpenAI coaching enables streaming and forwards progress before completion', async t => {
  const { events, saved } = await run(t, JSON.stringify({ headline: 'Brake once', tips: [], annotations: [] }), 'openai')
  const progress = events.findIndex(e => e.type === 'progress' && e.progress.label === 'Receiving coaching report')
  assert.ok(progress >= 0 && progress < events.findIndex(e => e.type === 'done'))
  assert.equal(saved[0].model_used, 'gpt-6-astra')
})
