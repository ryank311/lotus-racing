const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory, workspaceDbPath } = require('../dist-main/main/serverStorage.js')
const { TRACK_YAML, writeMeanLines } = require('./fixtures/compareFixture.cjs')

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

// A driver's workspace in its own process (no DuckDB lock left behind), with
// both test mean lines on disk and the layouts it kept before the library.
function seedDriver(dataDir, username, sessions, legacy) {
  const dir = userDirectory(dataDir, username)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username }))
  writeMeanLines(path.join(dir, 'garmin', 'data', 'mean_lines'))
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify(sessions), JSON.stringify(legacy)], { stdio: 'pipe' })
}

// Ryan drew the course on his mean line (test-line). Mitch's device recorded
// its own, 10 m longer line for the same course (other-line, course 41); his
// workspace only has a stray one-corner layout. Nothing is shared yet.
test('every driver sees and edits one layout per course, on their own mean line', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-shared-tracks-'))
  const dataDir = path.join(root, 'server')
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  seedDriver(dataDir, 'Ryan', [{ sg: 'ryan-1', start: '2026-10-30 10:00:00', laps: [1.0] }], [{
    meanLine: 'test-line',
    corners: [{ turn: 'T1', name: 'Hairpin', apex: 500 }, { turn: 'T2', name: 'Kink', apex: 800 }],
    complexes: [{ startM: 400, endM: 600, name: 'Hairpin complex' }],
  }])
  seedDriver(dataDir, 'Mitch', [
    { sg: 'mitch-1', start: '2026-10-29 10:00:00', meanLine: 'other-line', laps: [1.0] },
    { sg: 'mitch-grand', start: '2026-10-20 10:00:00', meanLine: 'grand-line', configId: 99, config: 'Grand West', laps: [1.0] },
  ], [{ meanLine: 'other-line', corners: [{ turn: 'M1', name: 'Mitch only', apex: 300 }] }])

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const request = (endpoint, body, cookie) => fetch(server.url + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  })
  const login = async username => (await request('/api/login', { username })).headers.get('set-cookie').split(';')[0]
  const rpc = async (cookie, channel, ...args) => {
    const response = await request('/api/rpc', { channel, args }, cookie)
    const body = await response.json()
    assert.equal(response.status, 200, body.error)
    return body.result
  }
  const mitch = await login('Mitch')
  const ryan = await login('Ryan')
  const shape = corners => corners.map(c => [c.turn, c.name, c.apex_idx, c.dist_idx_start, c.dist_idx_end])

  await t.test('Ryan’s corners reach Mitch’s mean line at the same spots on track', async () => {
    const list = await rpc(mitch, 'tracks:listAll')
    const line = list.find(r => r.meanLineGuid === 'other-line')
    assert.deepEqual([line.saved, line.cornerCount], [true, 2], 'the layout with the most data won the course')
    const layout = await rpc(mitch, 'tracks:get', 'other-line')
    // Ryan's 500 m is Mitch's 510 m: his extra 10 m all come before T1.
    assert.deepEqual(shape(layout.corners), [['T1', 'Hairpin', 510, 479, 540], ['T2', 'Kink', 810, 780, 840]])
    const { complexes } = await rpc(mitch, 'tracks:complexes', 'other-line')
    assert.deepEqual(complexes.filter(c => c.custom).map(c => [c.name, c.startM, c.endM]), [['Hairpin complex', 408, 610]])
    // A course nobody has drawn stays empty.
    const grand = list.find(r => r.meanLineGuid === 'grand-line')
    assert.deepEqual([grand.saved, grand.cornerCount], [false, 0])
  })

  await t.test('Mitch’s analysis uses the shared corners', async () => {
    const analysis = await rpc(mitch, 'analysis:build', ['mitch-1'], 'metric', 'top10')
    assert.deepEqual(analysis.corners.map(c => [c.turn, c.apex_idx]), [['T1', 510], ['T2', 810]])
  })

  // Ryan's session review, once its regions match `pattern`.
  const reviewRegions = async pattern => {
    for (let i = 0; i < 100; i++) {
      await rpc(ryan, 'review:ensure', 'ryan-1')
      const review = await rpc(ryan, 'review:get', 'ryan-1')
      const names = JSON.stringify(review.snapshot?.regions ?? [])
      if (review.state === 'ready' && pattern.test(names)) return names
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`Ryan's review never matched ${pattern}`)
  }

  await t.test('Ryan’s session review is built on the shared corners', async () => {
    assert.match(await reviewRegions(/T2 · Kink/), /T1 · Hairpin/)
  })

  await t.test('Mitch’s edit reaches Ryan; corners he left alone do not move', async () => {
    const { corners } = await rpc(mitch, 'tracks:get', 'other-line')
    const edited = corners.map(c => c.turn === 'T2' ? { ...c, name: 'Uphill', apex_idx: 820, dist_idx_start: 790, dist_idx_end: 850 } : c)
    await rpc(mitch, 'tracks:saveCorners', { meanLineGuid: 'other-line', corners: edited })
    const layout = await rpc(ryan, 'tracks:get', 'test-line')
    assert.deepEqual(shape(layout.corners), [['T1', 'Hairpin', 500, 470, 530], ['T2', 'Uphill', 810, 780, 840]])
    assert.deepEqual(shape((await rpc(mitch, 'tracks:get', 'other-line')).corners)[1], ['T2', 'Uphill', 820, 790, 850])
    // Ryan's running backend recomputes his review without a restart.
    assert.doesNotMatch(await reviewRegions(/T2 · Uphill/), /Kink/)
  })

  await t.test('Ryan’s complex edits reach Mitch', async () => {
    const { complexes } = await rpc(ryan, 'tracks:complexes', 'test-line')
    const renamed = complexes.map(c => (c.custom ? { ...c, name: 'Hairpin and exit' } : c))
    await rpc(ryan, 'tracks:saveComplexes', 'test-line', renamed)
    const theirs = await rpc(mitch, 'tracks:complexes', 'other-line')
    assert.deepEqual(theirs.complexes.filter(c => c.custom).map(c => [c.name, c.startM, c.endM]), [['Hairpin and exit', 408, 610]])
  })
})
