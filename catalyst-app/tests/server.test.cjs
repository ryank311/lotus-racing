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

test('username casing shares one workspace and backend', { timeout: 15000 }, async t => {
  const { login, rpc, server, dataDir } = await setup(t)
  const original = await login('Ryan')
  assert.equal((await rpc(original, 'units:set', 'metric')).status, 200)
  const worker = spawned.at(-1)

  for (const username of ['ryan', 'RYAN', 'rYaN']) {
    const cookie = await login(username)
    assert.deepEqual(await (await rpc(cookie, 'units:get')).json(), { result: 'metric' })
    assert.equal(spawned.at(-1), worker)
  }

  assert.equal((await (await fetch(server.url + '/api/health')).json()).users, 1)
  assert.equal(fs.readdirSync(path.join(dataDir, 'users')).length, 1)
})

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

test('AI keys are shared in DuckDB, write-only, independently updated, and survive server restart', { timeout: 25000 }, async t => {
  const { login, rpc, server, dataDir, root } = await setup(t)
  const alice = await login('Alice')
  const bob = await login('Bob')
  const settings = async cookie => (await (await rpc(cookie, 'ai:getSettings')).json()).result
  assert.equal((await settings(bob)).hasAnthropicApiKey, false)
  const save = async (cookie, patch) => {
    const response = await rpc(cookie, 'ai:saveSettings', patch)
    assert.equal(response.status, 200, await response.text())
  }
  await Promise.all([
    save(alice, { provider: 'anthropic', model: 'claude-fable-5-1', anthropicApiKey: 'anthropic-fixture' }),
    save(bob, { provider: 'openai', model: 'gpt-5.6-terra', openAiApiKey: 'openai-fixture' }),
  ])
  for (const cookie of [alice, bob]) {
    const value = await settings(cookie)
    assert.equal(value.hasAnthropicApiKey, true)
    assert.equal(value.hasOpenAiApiKey, true)
    assert.equal(value.keysShared, true)
    assert.equal(value.anthropicApiKey, undefined)
    assert.equal(value.openAiApiKey, undefined)
    assert.ok(!JSON.stringify(value).includes('fixture'))
  }
  assert.equal((await settings(alice)).model, 'claude-fable-5-1')
  assert.equal((await settings(bob)).model, 'gpt-5.6-terra')
  // A preference-only save cannot overwrite another login's keys.
  await save(bob, { model: 'gpt-6-astra' })
  assert.equal((await settings(alice)).hasAnthropicApiKey, true)
  for (const username of ['Alice', 'Bob']) {
    const cfg = fs.readFileSync(path.join(userDirectory(dataDir, username), 'garmin/config.json'), 'utf8')
    assert.ok(!cfg.includes('fixture'))
    assert.ok(!cfg.includes('api_key'))
  }
  const { databaseAiKeyStore } = require('../dist-main/main/aiKeyStore.js')
  const keyStore = databaseAiKeyStore(path.join(dataDir, 'catalyst-app.duckdb'))
  assert.deepEqual(await keyStore.read(), { anthropic: 'anthropic-fixture', openai: 'openai-fixture' })
  // Worker coaching uses this same private IPC read; no public method exposes it.
  assert.equal((await rpc(bob, 'ai-keys', { operation: 'read' })).status, 500)
  await save(alice, { anthropicApiKey: '' })
  assert.equal((await settings(bob)).hasAnthropicApiKey, false)
  assert.equal((await settings(bob)).hasOpenAiApiKey, true)
  await save(bob, { openAiApiKey: 'replacement-fixture' })
  assert.deepEqual(await keyStore.read(), { anthropic: '', openai: 'replacement-fixture' })
  const bad = await rpc(alice, 'ai:saveSettings', { anthropicApiKey: 'must-rollback', openAiApiKey: 123 })
  assert.equal(bad.status, 500)
  assert.deepEqual(await keyStore.read(), { anthropic: '', openai: 'replacement-fixture' })

  await server.close()
  const restarted = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root })
  t.after(() => restarted.close())
  const response = await fetch(restarted.url + '/api/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie: bob },
    body: JSON.stringify({ channel: 'ai:getSettings', args: [] }),
  })
  const persisted = (await response.json()).result
  assert.equal(persisted.hasOpenAiApiKey, true)
  assert.equal(persisted.hasAnthropicApiKey, false)
  assert.equal(persisted.model, 'gpt-6-astra')
})

test('startup migrates legacy AI keys once, removes JSON secrets, and upgrades old models', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-ai-migration-'))
  const dataDir = path.join(root, 'server')
  const configPath = username => path.join(userDirectory(dataDir, username), 'garmin/config.json')
  for (const [username, ai] of [
    ['Alice', { api_key: 'old-anthropic', openai_api_key: 'old-openai', model: 'claude-opus-4-8' }],
    ['Bob', { anthropic_api_key: 'new-anthropic', model: 'claude-sonnet-4-6' }],
  ]) {
    fs.mkdirSync(path.dirname(configPath(username)), { recursive: true })
    fs.writeFileSync(configPath(username), JSON.stringify({ units: 'metric', ai }))
  }
  fs.mkdirSync(path.dirname(configPath('Corrupt')), { recursive: true })
  fs.writeFileSync(configPath('Corrupt'), '{invalid json')
  fs.utimesSync(configPath('Alice'), new Date(1000), new Date(1000))
  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { databaseAiKeyStore, migrateAiConfig } = require('../dist-main/main/aiKeyStore.js')
  const store = databaseAiKeyStore(path.join(dataDir, 'catalyst-app.duckdb'))
  assert.deepEqual(await store.read(), { anthropic: 'new-anthropic', openai: 'old-openai' })
  for (const username of ['Alice', 'Bob']) {
    const cfg = JSON.parse(fs.readFileSync(configPath(username), 'utf8'))
    assert.equal(cfg.units, 'metric')
    assert.deepEqual(Object.keys(cfg.ai), ['model'])
    const login = await fetch(server.url + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }),
    })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const response = await fetch(server.url + '/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ channel: 'ai:getSettings', args: [] }),
    })
    const settings = (await response.json()).result
    assert.equal(settings.model, username === 'Alice' ? 'claude-opus-5' : 'claude-sonnet-5')
    assert.equal(settings.hasAnthropicApiKey, true)
  }
  await store.write({ anthropic: '' })
  fs.writeFileSync(configPath('Alice'), JSON.stringify({ ai: { api_key: 'do-not-resurrect' } }))
  await migrateAiConfig(configPath('Alice'), store)
  assert.deepEqual(await store.read(), { anthropic: '', openai: 'old-openai' })
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath('Alice'), 'utf8')), { ai: {} })
})
