const { test } = require('node:test')
const assert = require('node:assert/strict')
const { GarminSsoServer } = require('../dist-main/main/garminSsoServer.js')
const { buildGarminLoginUrl, garminTicketFromUrl } = require('../dist-main/shared/garminSso.js')

function harness(complete) {
  const sso = new GarminSsoServer(complete)
  const call = async (path, { username = 'Alice', method = 'GET', headers = {} } = {}) => {
    let status, body, responseHeaders
    const res = {
      writeHead(code, fields) { status = code; responseHeaders = fields },
      end(value) { body = value },
    }
    await sso.handle({ method, headers }, res, new URL(path, 'http://localhost:3210'), username)
    return { status, body, headers: responseHeaders, json: () => JSON.parse(body) }
  }
  const start = async () => (await call('/api/auth/garmin/start', {
    method: 'POST', headers: { 'x-catalyst-origin': 'http://localhost:3210' },
  })).json()
  return { call, start, sso }
}

test('hosted login and ticket parsing preserve exact callback and reject other origins/paths', () => {
  const callback = 'http://localhost:3210/api/auth/garmin/callback/random'
  const url = new URL(buildGarminLoginUrl(callback, 'CATALYST'))
  assert.equal(url.origin, 'https://sso.garmin.com')
  assert.equal(url.searchParams.get('service'), callback)
  assert.equal(url.searchParams.get('gauthHost'), 'https://sso.garmin.com/sso')
  assert.equal(url.searchParams.get('locale'), 'en_US')
  assert.equal(garminTicketFromUrl(callback + '?ticket=ST-abc%2B123', callback), 'ST-abc+123')
  assert.equal(garminTicketFromUrl(callback.replace('localhost', 'evil.test') + '?ticket=ST-abc', callback), null)
  assert.equal(garminTicketFromUrl(callback + '/other?ticket=ST-abc', callback), null)
  assert.equal(garminTicketFromUrl(callback + '?ticket=invalid', callback), null)
})

test('callback is bound to initiating driver, consumed once and returns no token in HTML', async () => {
  const calls = []
  const { start, call } = harness(async (...args) => {
    calls.push(args); return { token: '', expiresAt: 1234 }
  })
  const attempt = await start()
  const callback = new URL(attempt.url).searchParams.get('service')
  const path = new URL(callback).pathname
  assert.equal((await call(path + '?ticket=ST-test', { username: 'Bob' })).status, 400)
  assert.equal((await call(path + '?ticket=ST-test', { username: null })).status, 401)
  assert.equal((await call(path)).status, 400)
  const response = await call(path + '?ticket=ST-test')
  assert.equal(response.status, 200)
  assert.match(response.body, /Garmin connected/)
  assert.doesNotMatch(response.body, /ST-test|1234/)
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer')
  assert.deepEqual(calls, [['Alice', 'ST-test', callback]])
  assert.equal((await call(path + '?ticket=ST-test')).status, 400)
  assert.deepEqual((await call('/api/auth/garmin/status/' + attempt.id)).json(), {
    status: 'complete', result: { token: '', expiresAt: 1234 },
  })
})

test('cancel, replacement and expiry invalidate pending callbacks', async () => {
  const { start, call, sso } = harness(async () => assert.fail('must not exchange'))
  const first = await start()
  const second = await start()
  assert.equal((await call('/api/auth/garmin/status/' + first.id)).status, 400)
  await call('/api/auth/garmin/cancel/' + second.id, { method: 'POST' })
  assert.equal((await call('/api/auth/garmin/status/' + second.id)).status, 400)
  const third = await start()
  sso.attempts.get(third.id).expiresAt = 0
  assert.equal((await call('/api/auth/garmin/status/' + third.id)).status, 400)
})

test('exchange is single-flight, cannot be cancelled mid-commit, and hides upstream secrets on failure', async () => {
  let rejectExchange
  const { start, call } = harness(() => new Promise((_, reject) => { rejectExchange = reject }))
  const attempt = await start()
  const callback = new URL(new URL(attempt.url).searchParams.get('service')).pathname
  const pending = call(callback + '?ticket=ST-secret')
  assert.deepEqual((await call('/api/auth/garmin/cancel/' + attempt.id, { method: 'POST' })).json(), { cancelled: false })
  assert.equal((await call(callback + '?ticket=ST-replay')).status, 400)
  rejectExchange(new Error('upstream echoed ST-secret and access_token'))
  assert.equal((await pending).status, 502)
  const state = (await call('/api/auth/garmin/status/' + attempt.id)).json()
  assert.equal(state.status, 'error')
  assert.doesNotMatch(state.error, /ST-secret|access_token/)
})

test('callback origins support HTTPS/Vite proxies and reject unrelated hosts', async () => {
  const { call } = harness(async () => assert.fail('must not exchange'))
  const start = headers => call('/api/auth/garmin/start', { method: 'POST', headers })
  assert.equal((await start({ 'x-catalyst-origin': 'https://evil.test' })).status, 400)
  assert.equal((await start({ 'x-catalyst-origin': 'file:///etc' })).status, 400)
  const response = await start({ origin: 'https://coach.example.test', 'x-catalyst-origin': 'https://coach.example.test' })
  assert.equal(response.status, 200)
  assert.ok(new URL(response.json().url).searchParams.get('service').startsWith('https://coach.example.test/'))
})
