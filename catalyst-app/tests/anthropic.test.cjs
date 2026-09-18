const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const https = require('node:https')
const { runAgent } = require('../dist-main/garmin/agentHarness.js')
const { COACHING_TOOL } = require('../dist-main/garmin/coachingTool.js')

const config = {
  provider: 'anthropic', apiKey: 'fixture', model: 'claude-fable-5-1', stream: true,
  tools: [COACHING_TOOL], toolChoice: { type: 'tool', name: COACHING_TOOL.name },
}
const event = value => Buffer.from(`event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`)
const start = { type: 'message_start', message: { id: 'msg_fixture', usage: { input_tokens: 123 } } }
const stop = { type: 'message_stop' }
const usage = reason => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 42 } })
const toolStart = (index = 1, name = COACHING_TOOL.name) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', name, input: {} } })
const toolDelta = (json, index = 1) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } })
const blockStop = index => ({ type: 'content_block_stop', index })
const report = json => [start, toolStart(), toolDelta(json), blockStop(1), usage('tool_use'), stop]

function mockTransport(t) {
  const requests = []
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter()
    req.destroy = () => { req.destroyed = true }
    req.end = body => { req.body = JSON.parse(body); req.emit('finish') }
    req.respond = (status = 200, contentType = 'text/event-stream') => {
      const res = new EventEmitter()
      res.statusCode = status
      res.headers = { 'content-type': contentType, 'request-id': 'request-fixture' }
      res.destroy = () => { res.destroyed = true; res.emit('close') }
      res.send = (...events) => res.emit('data', Buffer.concat(events.map(event)))
      callback(res)
      return res
    }
    req.options = options
    requests.push(req)
    return req
  })
  return requests
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

test('Fable streams real progress before completion and preserves indexed tool JSON', async t => {
  const requests = mockTransport(t)
  for (const model of ['claude-fable-5-1', 'claude-opus-5']) {
    const logs = []
    let completed = false
    const pending = runAgent('Call submit_coaching_report.', { ...config, model }, text => logs.push(text))
    pending.then(() => { completed = true })
    const req = requests.at(-1)
    const res = req.respond()
    res.send(start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE REASONING' } },
      blockStop(0),
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is your report.' } },
      blockStop(1), toolStart(2), toolDelta('{"headline":"Brake ', 2),
    )
    assert.match(logs.join(''), /HTTP 200.*request_id=request-fixture/)
    assert.match(logs.join(''), /Model is thinking/)
    assert.match(logs.join(''), /Receiving coaching report/)
    assert.match(logs.join(''), /input_tokens=123/)
    assert.doesNotMatch(logs.join(''), /PRIVATE REASONING/)
    await flush()
    assert.equal(completed, false, 'must not return partial JSON')
    res.send(toolDelta('later"}', 2), blockStop(2),
      { type: 'content_block_start', index: 3, content_block: { type: 'text', text: 'Report complete.' } },
      blockStop(3), usage('tool_use'), stop)
    assert.deepEqual(JSON.parse(await pending), { headline: 'Brake later' })
    assert.equal(res.destroyed, true, 'message_stop finishes without waiting for HTTP end')
    assert.match(logs.join(''), /output_tokens=42 stop_reason=tool_use/)
  }
  assert.deepEqual(requests[0].body.tool_choice, { type: 'auto', disable_parallel_tool_use: true })
  assert.equal(requests[0].body.thinking, undefined)
  assert.deepEqual(requests[1].body.tool_choice, { type: 'tool', name: COACHING_TOOL.name })
  assert.equal(requests[0].options.headers['x-api-key'], 'fixture')
})

test('SSE survives split UTF-8, CRLF, partial lines, pings, and future events', async t => {
  const requests = mockTransport(t)
  const logs = []
  const pending = runAgent('prompt', config, text => logs.push(text))
  const res = requests[0].respond()
  const json = JSON.stringify({ headline: 'Freinage — 🏁' })
  const bytes = Buffer.concat([
    Buffer.from(': keepalive\r\n\r\n'),
    event({ type: 'ping' }), event({ type: 'future_event' }),
    ...report(json).map(event),
  ])
  for (const byte of bytes) res.emit('data', Buffer.from([byte]))
  assert.equal(await pending, json)
  assert.doesNotMatch(logs.join(''), /�/)
})

test('live diagnostics distinguish a healthy ping from report generation and stop after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = mockTransport(t)
  const logs = []
  const pending = runAgent('prompt', config, text => logs.push(text))
  const res = requests[0].respond()
  res.send(start, { type: 'ping' })
  t.mock.timers.tick(4000)
  assert.match(logs.at(-1), /last_event=ping idle=4s report_chars=0/)
  res.send(toolStart(), toolDelta('{"headline":"Brake later"}'))
  t.mock.timers.tick(4000)
  assert.match(logs.join(''), /26 report chars/)
  res.send(blockStop(1), usage('tool_use'), stop)
  await pending
  const count = logs.length
  t.mock.timers.tick(20 * 60_000)
  assert.equal(logs.length, count, 'all timers must be cleared')
})

test('streamed overload errors are surfaced immediately and retried with clean state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = mockTransport(t)
  const logs = []
  const pending = runAgent('prompt', config, text => logs.push(text))
  requests[0].respond().send(start, toolStart(), toolDelta('{"wrong":'),
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
  await flush()
  assert.match(logs.join(''), /overloaded_error.*Overloaded/)
  assert.equal(requests[0].destroyed, true)
  t.mock.timers.tick(1200)
  await flush()
  requests[1].respond().send(...report('{"headline":"Recovered"}'))
  assert.equal(await pending, '{"headline":"Recovered"}')
})

for (const ending of ['end', 'aborted', 'close', 'error']) {
  test(`premature ${ending} rejects partial output after bounded retries`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const requests = mockTransport(t)
    const pending = runAgent('prompt', config, () => {})
    const rejected = assert.rejects(pending, /after 3 attempts/)
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = requests[attempt].respond()
      res.send(start, toolStart(), toolDelta('{"headline":"Partial"}'), blockStop(1))
      res.emit(ending, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      await flush()
      if (attempt < 2) { t.mock.timers.tick(attempt === 0 ? 1200 : 3000); await flush() }
    }
    await rejected
  })
}

for (const [name, events, pattern] of [
  ['token limit', [start, toolStart(), toolDelta('{"headline":"Incomplete"}'), blockStop(1), usage('max_tokens'), stop], /output token limit/],
  ['malformed tool JSON', report('{bad json}'), /invalid JSON for the coaching tool/],
  ['empty response', [start, usage('end_turn'), stop], /without a coaching report/],
  ['unfinished tool block', [start, toolStart(), toolDelta('{}'), stop], /unfinished content block/],
  ['provider refusal', [start, usage('refusal'), stop], /stop_reason=refusal/],
  ['non-transient stream error', [{ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request' } }], /invalid_request_error/],
]) {
  test(`rejects ${name} instead of returning successful coaching`, async t => {
    const requests = mockTransport(t)
    const pending = runAgent('prompt', config, () => {})
    const rejected = assert.rejects(pending, pattern)
    requests[0].respond().send(...events)
    await rejected
    assert.equal(requests.length, 1)
  })
}

test('HTTP errors and unexpected content types are actionable', async t => {
  const requests = mockTransport(t)
  let pending = runAgent('prompt', config, () => {})
  let rejected = assert.rejects(pending, /Anthropic API 400:.*bad model/)
  const res = requests[0].respond(400, 'application/json')
  res.emit('data', Buffer.from('{"error":"bad model"}'))
  res.emit('end')
  await rejected
  pending = runAgent('prompt', config, () => {})
  rejected = assert.rejects(pending, /application\/json instead of an event stream/)
  requests[1].respond(200, 'application/json')
  await rejected
})

test('malformed SSE data is reported rather than silently discarded', async t => {
  const requests = mockTransport(t)
  const pending = runAgent('prompt', config, () => {})
  const rejected = assert.rejects(pending, /malformed streaming event/)
  requests[0].respond().emit('data', Buffer.from('data: {bad json}\n\n'))
  await rejected
})

test('non-streaming mode still handles split Unicode and named tool results', async t => {
  const requests = mockTransport(t)
  const pending = runAgent('prompt', { ...config, stream: false }, () => {})
  const res = requests[0].respond(200, 'application/json')
  const bytes = Buffer.from(JSON.stringify({ stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'other_tool', input: { wrong: true } },
    { type: 'tool_use', name: COACHING_TOOL.name, input: { headline: 'Brake — 🏁' } },
  ] }))
  for (const byte of bytes) res.emit('data', Buffer.from([byte]))
  res.emit('end')
  assert.deepEqual(JSON.parse(await pending), { headline: 'Brake — 🏁' })
})

test('silence before headers times out and cleans up each attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = mockTransport(t)
  const logs = []
  const pending = runAgent('prompt', config, text => logs.push(text))
  const rejected = assert.rejects(pending, /15-minute total limit/)
  for (let attempt = 0; attempt < 2; attempt++) {
    t.mock.timers.tick(300_000)
    await flush()
    assert.equal(requests[attempt].destroyed, true)
    assert.match(logs.join(''), /no data for 5 minutes while request sent; waiting for response headers/)
    t.mock.timers.tick(attempt === 0 ? 1200 : 3000)
    await flush()
  }
  t.mock.timers.tick(300_000)
  await rejected
  assert.equal(requests.length, 3)
  const count = logs.length
  t.mock.timers.tick(60_000)
  assert.equal(logs.length, count)
})

test('pings keep idle timer alive but cannot extend the total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const requests = mockTransport(t)
  const pending = runAgent('prompt', config, () => {})
  const rejected = assert.rejects(pending, /15-minute total limit/)
  const res = requests[0].respond()
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(4 * 60_000); res.send({ type: 'ping' }) }
  t.mock.timers.tick(3 * 60_000)
  await rejected
  assert.equal(requests.length, 1)
  assert.equal(res.destroyed, true)
})
