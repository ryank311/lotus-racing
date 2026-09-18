const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const https = require('node:https')
const { runAgent } = require('../dist-main/garmin/agentHarness.js')
const { COACHING_TOOL } = require('../dist-main/garmin/coachingTool.js')

test('Fable allows thinking and preserves the tool JSON despite surrounding text', async t => {
  const requests = []
  t.mock.method(https, 'request', (options, callback) => {
    const request = new EventEmitter()
    request.write = body => requests.push({ options, body: JSON.parse(body) })
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = 200
      callback(response)
      const events = [
        { type: 'content_block_start', content_block: { type: 'thinking' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning' } },
        { type: 'content_block_stop' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here is your report.' } },
        { type: 'content_block_start', content_block: { type: 'tool_use' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"headline":"Brake later"}' } },
        { type: 'content_block_stop' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Report complete.' } },
      ]
      response.emit('data', Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')))
      response.emit('end')
    })
    return request
  })
  for (const model of ['claude-fable-5-1', 'claude-opus-5']) {
    const result = await runAgent('Call submit_coaching_report.', {
      provider: 'anthropic', apiKey: 'fixture', model, stream: true,
      tools: [COACHING_TOOL], toolChoice: { type: 'tool', name: COACHING_TOOL.name },
    }, () => {})
    assert.deepEqual(JSON.parse(result), { headline: 'Brake later' })
  }
  assert.deepEqual(requests[0].body.tool_choice, { type: 'auto', disable_parallel_tool_use: true })
  assert.equal(requests[0].body.thinking, undefined)
  assert.deepEqual(requests[1].body.tool_choice, { type: 'tool', name: COACHING_TOOL.name })
  assert.equal(requests[0].options.headers['x-api-key'], 'fixture')
})
