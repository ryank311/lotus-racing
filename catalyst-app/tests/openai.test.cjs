const assert = require('node:assert/strict')
const { test } = require('node:test')
const { runAgent } = require('../dist-main/garmin/agentHarness.js')
const { COACHING_TOOL } = require('../dist-main/garmin/coachingTool.js')

const config = {
  provider: 'openai', apiKey: 'fixture', model: 'gpt-6-astra',
  tools: [COACHING_TOOL], toolChoice: { type: 'tool', name: COACHING_TOOL.name },
}
const json = JSON.stringify({ headline: 'Brake smoothly 🏁', tips: [], annotations: [] })
const response = (status = 'completed', extra = {}) => ({
  id: 'resp_fixture', status,
  output: [{ type: 'function_call', id: 'tool_report', name: COACHING_TOOL.name, arguments: json }],
  usage: { input_tokens: 123, output_tokens: 42, output_tokens_details: { reasoning_tokens: 20 } },
  ...extra,
})
const created = { type: 'response.created', sequence_number: 0, response: response('queued', { output: [] }) }
const thinking = { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'reasoning', id: 'reasoning' } }
const tool = { type: 'response.output_item.added', sequence_number: 2, output_index: 1, item: { type: 'function_call', id: 'tool_report', name: COACHING_TOOL.name } }
const delta = (text, sequence_number = 3) => ({ type: 'response.function_call_arguments.delta', sequence_number, item_id: 'tool_report', output_index: 1, delta: text })
const complete = { type: 'response.completed', sequence_number: 6, response: response() }
const flush = () => new Promise(resolve => setImmediate(resolve))
function transport(t) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    let controller
    const body = new ReadableStream({ start(c) { controller = c } })
    let ended = false
    const request = {
      url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined,
      send(...events) {
        const bytes = Buffer.from(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''))
        // Fragment inside UTF-8 and SSE framing, not just between events.
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7))
      },
      end() { ended = true; controller.close() },
    }
    options.signal.addEventListener('abort', () => {
      if (!ended) { ended = true; controller.error(new DOMException('Aborted', 'AbortError')) }
    }, { once: true })
    requests.push(request)
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  return requests
}

test('OpenAI streams truthful phases and report counts before returning complete tool JSON', async t => {
  const requests = transport(t)
  const logs = []
  let settled = false
  const pending = runAgent('Telemetry fixture', config, text => logs.push(text))
  pending.then(() => { settled = true })
  await flush()
  assert.equal(requests[0].body.stream, true)
  assert.equal(requests[0].body.background, true)
  assert.equal(requests[0].body.store, false)
  assert.deepEqual(requests[0].body.tool_choice, { type: 'function', name: COACHING_TOOL.name })
  assert.deepEqual(requests[0].body.tools[0].parameters, COACHING_TOOL.input_schema)
  requests[0].send(created, thinking,
    { type: 'response.reasoning_text.delta', sequence_number: 1.5, delta: 'PRIVATE REASONING' },
    tool, delta('{"headline":'))
  await flush()
  assert.equal(settled, false)
  assert.match(logs.join(''), /Queued at OpenAI/)
  assert.match(logs.join(''), /Model is thinking/)
  assert.match(logs.join(''), /Receiving coaching report/)
  assert.match(logs.join(''), /12 report chars received/)
  assert.doesNotMatch(logs.join(''), /PRIVATE REASONING|headline/)
  requests[0].send(delta(json.slice(12), 4), complete)
  assert.equal(await pending, json)
  assert.match(logs.join(''), /input_tokens=123 output_tokens=42 reasoning_tokens=20/)
  assert.match(logs.at(-1), /Parsing coaching report/)
})

test('a dropped stream resumes the same response and does not count replayed deltas twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = transport(t)
  const logs = []
  const pending = runAgent('prompt', config, text => logs.push(text))
  await flush()
  requests[0].send(created, tool, delta('hello'))
  requests[0].end()
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].options.method, 'GET')
  assert.match(requests[1].url, /responses\/resp_fixture\?stream=true&starting_after=3/)
  assert.match(logs.join(''), /reconnecting to analysis/)
  requests[1].send(delta('hello'), delta('world', 4))
  await flush()
  t.mock.timers.tick(4000)
  assert.match(logs.at(-1), /Receiving coaching report.*10 report chars received/)
  requests[1].send(complete)
  assert.equal(await pending, json)
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 1)
})

for (const [status, extra, expected] of [
  ['failed', { error: { message: 'Provider failed' } }, /Provider failed/],
  ['incomplete', { incomplete_details: { reason: 'max_output_tokens' } }, /incomplete: max_output_tokens/],
  ['completed', { output: [] }, /without a coaching report/],
]) {
  test(`OpenAI rejects ${status} ${extra.output ? 'empty output' : 'reports'}`, async t => {
    const requests = transport(t)
    const pending = assert.rejects(runAgent('prompt', config, () => {}), expected)
    await flush()
    requests[0].send(created, { type: `response.${status}`, sequence_number: 1, response: response(status, extra) })
    await pending
    assert.equal(requests.length, 1)
  })
}

test('OpenAI surfaces provider stream errors and never creates a replacement job', async t => {
  const requests = transport(t)
  const pending = assert.rejects(runAgent('prompt', config, () => {}), /Invalid request/)
  await flush()
  requests[0].send(created, { type: 'error', sequence_number: 1, code: 'invalid_request', message: 'Invalid request' })
  await pending
  assert.equal(requests.length, 1)
})

test('a stream ending without a response ID fails instead of restarting expensive work', async t => {
  const requests = transport(t)
  const pending = assert.rejects(runAgent('prompt', config, () => {}), /before the report was complete/)
  await flush()
  requests[0].end()
  await pending
  assert.equal(requests.length, 1)
})

test('OpenAI heartbeat updates during silent reasoning and stops after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = transport(t)
  const logs = []
  const pending = runAgent('prompt', config, text => logs.push(text))
  await flush()
  requests[0].send(created, thinking)
  await flush()
  t.mock.timers.tick(8000)
  assert.match(logs.at(-1), /Model is thinking · 8s elapsed/)
  requests[0].send(complete)
  await pending
  const count = logs.length
  t.mock.timers.tick(20_000)
  assert.equal(logs.length, count)
})

test('idle OpenAI streams reconnect, and the total deadline aborts pending reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = transport(t)
  const logs = []
  const pending = assert.rejects(runAgent('prompt', config, text => logs.push(text)), /15 minutes/)
  await flush()
  requests[0].send(created, thinking)
  await flush()
  t.mock.timers.tick(300_000)
  await flush()
  assert.equal(requests.length, 2)
  t.mock.timers.tick(600_000)
  await flush()
  await pending
  assert.equal(requests.length, 2)
  const count = logs.length
  t.mock.timers.tick(8000)
  assert.equal(logs.length, count)
})

test('explicit non-streaming callers retain background polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options })
    return Response.json(response(requests.length === 1 ? 'queued' : 'completed'))
  })
  const pending = runAgent('prompt', { ...config, stream: false }, () => {})
  await flush()
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(await pending, json)
  assert.equal(requests.length, 2)
  assert.equal(JSON.parse(requests[0].options.body).stream, undefined)
})
