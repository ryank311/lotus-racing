const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory } = require('../dist-main/main/serverStorage.js')

// Capture real workers so the recovery test can terminate one at the OS level.
const spawned = []
const fork = childProcess.fork
childProcess.fork = (file, args, options) => {
  const env = { ...options.env }
  delete env.CATALYST_BUNDLED_RESOURCES
  const child = fork(file, args, {
    ...options, env,
    execArgv: ['--require', path.join(__dirname, 'fixtures/no-electron.cjs')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr.resume()
  spawned.push(child)
  return child
}
const { startCatalystServer } = require('../dist-main/main/server.js')

async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-server-test-'))
  const dataDir = path.join(root, 'server')
  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root, ...options })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const post = (endpoint, body, cookie) => fetch(server.url + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  const login = async username => {
    const response = await post('/api/login', { username })
    assert.equal(response.status, 200, await response.clone().text())
    return response.headers.get('set-cookie').split(';')[0]
  }
  const rpc = (cookie, channel, ...args) => post('/api/rpc', { channel, args }, cookie)
  return { root, dataDir, server, post, login, rpc }
}

test('malformed URL/Host requests return 400 and the server remains healthy', { timeout: 15000 }, async t => {
  const { server, post } = await setup(t)
  const status = await new Promise((resolve, reject) => {
    const req = http.get(server.url + '/api/health', { headers: { Host: '[' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode))
    })
    req.once('error', reject)
  })
  assert.equal(status, 400)
  assert.equal((await fetch(server.url + '/%ZZ')).status, 400)
  assert.equal((await post('/api/login', null)).status, 400)
  assert.equal((await fetch(server.url + '/api/health')).status, 200)
})

test('sync and async RPC errors are contained; subsequent RPCs and SSE work', { timeout: 15000 }, async t => {
  const { login, rpc, server } = await setup(t)
  const cookie = await login('Alice')
  const bad = await rpc(cookie, 'tracks:get', '../invalid')
  assert.equal(bad.status, 500)
  assert.match((await bad.json()).error, /invalid mean-line id/)
  const asyncBad = await rpc(cookie, 'auth:signIn')
  assert.equal(asyncBad.status, 500)
  assert.match((await asyncBad.json()).error, /email\/password/)
  assert.equal((await rpc(cookie, 'unknown:method')).status, 500)
  assert.deepEqual(await (await rpc(cookie, 'units:get')).json(), { result: 'imperial' })
  const abort = new AbortController()
  t.after(() => abort.abort())
  const stream = await fetch(server.url + '/api/events', { headers: { cookie }, signal: abort.signal })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /server:connected/)
  await reader.cancel()
})

test('a terminated worker is replaced without losing its saved settings', { timeout: 15000 }, async t => {
  const { login, rpc, server } = await setup(t)
  const cookie = await login('Alice')
  assert.equal((await rpc(cookie, 'units:set', 'metric')).status, 200)
  const child = spawned.at(-1)
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  // Requests racing with disconnect may fail, but must never kill the server.
  const racing = await rpc(cookie, 'units:get')
  assert.ok([200, 500].includes(racing.status))
  await closed
  assert.equal((await fetch(server.url + '/api/health')).status, 200)
  assert.deepEqual(await (await rpc(cookie, 'units:get')).json(), { result: 'metric' })
  assert.notEqual(spawned.at(-1).pid, child.pid)
})

test('startup failures return an error, keep the server alive, and allow retry', { timeout: 15000 }, async t => {
  const { dataDir, post, login, rpc, server } = await setup(t)
  const db = path.join(userDirectory(dataDir, 'Broken'), 'garmin/data/catalyst-app.duckdb')
  fs.mkdirSync(path.dirname(db), { recursive: true })
  fs.writeFileSync(db, 'invalid database')
  const response = await post('/api/login', { username: 'Broken' })
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('set-cookie'), null)
  for (let i = 0; i < 50; i++) {
    const health = await (await fetch(server.url + '/api/health')).json()
    if (health.users === 0) break
    await delay(20)
  }
  fs.unlinkSync(db)
  const cookie = await login('Broken')
  assert.equal((await rpc(cookie, 'units:get')).status, 200)
})

test('legacy overrides cannot share databases, profiles, or raw data between drivers', { timeout: 20000 }, async t => {
  const overrides = ['CATALYST_DATA_DIR', 'CATALYST_DB_PATH', 'CATALYST_REPO_ROOT']
  const previous = overrides.map(key => process.env[key])
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-legacy-override-test-'))
  overrides.forEach((key, i) => { process.env[key] = path.join(legacy, String(i)) })
  t.after(() => {
    overrides.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
    fs.rmSync(legacy, { recursive: true, force: true })
  })
  const { login, rpc, dataDir } = await setup(t)
  const alice = await login('Alice')
  const bob = await login('Bob')
  assert.equal((await rpc(alice, 'profiles:writeCarMd', 'Car', 'Car.md', 'Alice only')).status, 200)
  assert.deepEqual(await (await rpc(bob, 'profiles:list')).json(), { result: [] })
  assert.deepEqual(await (await rpc(alice, 'profiles:readCarMd', 'Car')).json(), { result: 'Alice only' })
  const sameAlice = await login('ALICE')
  assert.deepEqual(await (await rpc(sameAlice, 'profiles:readCarMd', 'Car')).json(), { result: 'Alice only' })
  for (const name of ['Alice', 'Bob']) {
    assert.ok(fs.existsSync(path.join(userDirectory(dataDir, name), 'garmin/data/catalyst-app.duckdb')))
    assert.ok(fs.existsSync(path.join(userDirectory(dataDir, name), 'garmin/data/sessions')))
  }
  assert.deepEqual(fs.readdirSync(legacy), [])

  // The path module also enforces isolation if invoked independently of server.ts.
  const instance = path.join(legacy, 'instance')
  const script = `const p = require(${JSON.stringify(path.resolve(__dirname, '../dist-main/garmin/paths.js'))});
    console.log(JSON.stringify([p.DB_PATH, p.DATA_DIR, p.REPO_ROOT]));`
  const result = childProcess.spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', env: { ...process.env, CATALYST_INSTANCE_DIR: instance },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [path.join(instance, 'garmin/data/catalyst-app.duckdb'), path.join(instance, 'garmin/data'), instance])
})
