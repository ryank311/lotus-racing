const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory, workspaceDbPath } = require('../dist-main/main/serverStorage.js')
const { TRACK_YAML } = require('./fixtures/compareFixture.cjs')

// Workers run without Electron, like tests/server.test.cjs.
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
  return child
}
const { startCatalystServer } = require('../dist-main/main/server.js')

// Seed a driver's workspace in its own process so no DuckDB lock is left behind.
function seedDriver(dataDir, username, sessions) {
  const dir = userDirectory(dataDir, username)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username }))
  if (!sessions) return
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify(sessions)], { stdio: 'pipe' })
}

test('drivers on one server can compare sessions read-only', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-compare-server-'))
  const dataDir = path.join(root, 'server')
  // Workers seed their track layouts from <templateRoot>/tracks.
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  seedDriver(dataDir, 'Ryan', [{ sg: 'ryan-1', start: '2026-10-30 10:00:00', laps: [1.0, 0.98] }])
  seedDriver(dataDir, 'Alex', [
    { sg: 'alex-1', start: '2026-10-29 14:00:00', laps: [1.05, 1.0] },
    { sg: 'alex-grand', start: '2026-10-20 09:00:00', meanLine: 'grand-line', configId: 99, config: 'Grand West', laps: [1.0] },
  ])
  seedDriver(dataDir, 'New Driver', null)

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const request = (endpoint, body, cookie) => fetch(server.url + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  })
  const login = async username => (await request('/api/login', { username })).headers.get('set-cookie').split(';')[0]
  const cookie = await login('Ryan')
  const build = comparisons => request('/api/rpc', { channel: 'analysis:build', args: [['ryan-1'], 'imperial', 'top10', comparisons] }, cookie)

  await t.test('the driver list excludes you and flags drivers without telemetry', async () => {
    assert.equal((await request('/api/drivers')).status, 401)
    const { drivers } = await (await request('/api/drivers', undefined, cookie)).json()
    assert.deepEqual(drivers, [{ username: 'Alex', hasTelemetry: true }, { username: 'New Driver', hasTelemetry: false }])
  })

  await t.test('another driver’s sessions can be listed, but unknown names never create a workspace', async () => {
    const { result } = await (await request('/api/driver-sessions', { driver: 'alex' }, cookie)).json()
    assert.deepEqual(result.map(r => r.session_guid).sort(), ['alex-1', 'alex-grand'])
    assert.deepEqual((await (await request('/api/driver-sessions', { driver: 'New Driver' }, cookie)).json()).result, [])
    const before = fs.readdirSync(path.join(dataDir, 'users')).length
    assert.equal((await request('/api/driver-sessions', { driver: 'Nobody' }, cookie)).status, 404)
    assert.equal((await request('/api/driver-sessions', { driver: 'Ryan' }, cookie)).status, 404)
    assert.equal(fs.readdirSync(path.join(dataDir, 'users')).length, before)
  })

  await t.test('analysis:build overlays the compared driver’s laps', async () => {
    const response = await build([{ driver: 'ALEX', sessionGuids: ['alex-1'] }])
    assert.equal(response.status, 200, await response.clone().text())
    const { result } = await response.json()
    assert.deepEqual(result.comparison.drivers.map(d => d.name), ['You', 'Alex'])
    assert.equal(result.speedTraces.filter(tr => tr.driver === 'Alex').length, 2)
    assert.equal(result.laps.length, 2)
    assert.equal((await (await build([])).json()).result.comparison, null)
  })

  await t.test('invalid comparisons are rejected with a clear reason', async () => {
    const reason = async comparisons => {
      const response = await build(comparisons)
      assert.equal(response.status, 500)
      return (await response.json()).error
    }
    assert.match(await reason([{ driver: 'Ryan', sessionGuids: ['ryan-1'] }]), /another driver/)
    assert.match(await reason([{ driver: 'Nobody', sessionGuids: ['x'] }]), /No driver named "Nobody"/)
    assert.match(await reason([{ driver: 'Alex', sessionGuids: ['alex-1'] }, { driver: 'alex', sessionGuids: ['alex-1'] }]), /twice/)
    assert.match(await reason([{ driver: 'Alex', sessionGuids: ['alex-grand'] }]), /Alex's session .* is on Test Raceway · Grand West/)
    assert.match(await reason([{ driver: 'Alex', sessionGuids: ['missing'] }]), /^Alex: Some of the compared sessions/)
    assert.match(await reason([{ driver: 'New Driver', sessionGuids: ['x'] }]), /^New Driver has not synced any telemetry yet/)
    // A renderer cannot hand its backend telemetry of its own making.
    assert.match(await reason([{ driver: 'Alex', sessions: [], laps: [] }]), /Choose 1–20 sessions/)
    assert.match(await reason('Alex'), /Invalid driver comparison/)
  })
})
