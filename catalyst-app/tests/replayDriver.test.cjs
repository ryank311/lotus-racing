// The 3D replay's driver comparison: another driver's laps on your course,
// through the server and that driver's backend (read-only), measured along
// your scene's mean line, with the same access rules as Analysis.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory, workspaceDbPath } = require('../dist-main/main/serverStorage.js')
const { TRACK_YAML, OTHER_LINE, lapRows, writeMeanLines } = require('./fixtures/compareFixture.cjs')

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

const VIDEO_ID = '3c1d0f7e-9a2b-4c5d-8e6f-7a8b9c0d1e2f'

function seedDriver(dataDir, username, sessions) {
  const dir = userDirectory(dataDir, username)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username }))
  if (!sessions) return dir
  writeMeanLines(path.join(dir, 'garmin', 'data', 'mean_lines'))
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify(sessions)], { stdio: 'pipe' })
  return dir
}

// Alex's extras: a pit lap (not valid), and a synced PDR video over their
// second lap of alex-1 (its distances on Alex's own mean line).
function seedAlexExtras(dir) {
  const script = `
    const { withDb } = require(${JSON.stringify(path.join(__dirname, '../dist-main/garmin/loadToDb.js'))})
    const { lapRows, OTHER_LINE } = require(${JSON.stringify(path.join(__dirname, 'fixtures/compareFixture.cjs'))})
    withDb(async con => {
      await con.run("UPDATE laps SET lap_type = 'PIT_IN' WHERE session_guid = 'alex-1' AND lap_index = 2")
      await con.run(\`INSERT INTO session_videos (video_id, session_guid, file_name, size_bytes, duration_s, offset_s, auto_offset_s, alignment, laps, channels, record_count, decode_version)
        VALUES ('${VIDEO_ID}', 'alex-1', 'PDR_0002.mp4', 1, 900, 20, 20, 'position', '[1]', '[]', 0, 2)\`)
      const lap = lapRows(1.05, OTHER_LINE)
      await con.run('INSERT INTO pdr_lap_samples (session_guid, lap_index, distance_m, video_id, video_time_s, throttle_pct) VALUES '
        + lap.rows.map(r => \`('alex-1', 1, \${r.d}, '${VIDEO_ID}', \${(r.t / 1000 + 40).toFixed(3)}, 60)\`).join(','))
    }, ${JSON.stringify(workspaceDbPath(dir))}).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
  `
  childProcess.execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' })
  const videos = path.join(dir, 'garmin', 'data', 'videos')
  fs.mkdirSync(videos, { recursive: true })
  fs.writeFileSync(path.join(videos, `${VIDEO_ID}.mp4`), Buffer.alloc(64))
}

test('replay: racing another driver’s lap on your course', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-replay-driver-'))
  const dataDir = path.join(root, 'server')
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  seedDriver(dataDir, 'Ryan', [{ sg: 'ryan-1', start: '2026-10-30 10:00:00', laps: [1.0, 0.98] }])
  // Alex drives a Corvette, and their Catalyst built its own mean line of the course.
  const alex = seedDriver(dataDir, 'Alex', [
    { sg: 'alex-1', start: '2026-10-29 14:00:00', meanLine: OTHER_LINE.meanLine, make: 'CHEVROLET', model: 'CORVETTE', vehicle: 'vette', laps: [1.0, 1.05, 0.9] },
    { sg: 'alex-grand', start: '2026-10-20 09:00:00', meanLine: 'grand-line', configId: 99, config: 'Grand West', laps: [1.0] },
    { sg: 'alex-raw', start: '2026-10-21 09:00:00', detailsLoaded: false, laps: [1.0] },
  ])
  seedAlexExtras(alex)
  seedDriver(dataDir, 'New Driver', null)

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const request = (endpoint, body, cookie) => fetch(server.url + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  const cookie = (await request('/api/login', { username: 'Ryan' })).headers.get('set-cookie').split(';')[0]
  const laps = (driver, sessionGuid, c = cookie) => request('/api/driver-laps', { driver, sessionGuid }, c)
  const driverLap = (ref, scene = 'ryan-1') => request('/api/rpc', { channel: 'replay:driverLap', args: [scene, ref] }, cookie)
  const reason = async response => {
    assert.notEqual(response.status, 200)
    return (await response.json()).error
  }
  const workspaces = () => fs.readdirSync(path.join(dataDir, 'users')).length

  await t.test('their valid laps of one session, without signing in as them', async () => {
    assert.equal((await laps('Alex', 'alex-1', null)).status, 401)
    const response = await laps('alex', 'alex-1')
    assert.equal(response.status, 200, await response.clone().text())
    const { result } = await response.json()
    // The pit lap is not offered; the faster lap is their best; the video covers L2.
    assert.deepEqual(result.map(l => l.lap), [0, 1])
    assert.deepEqual(result.map(l => l.isBest), [false, true])
    assert.deepEqual(result.map(l => l.hasVideo), [false, true])
    assert.deepEqual(result.map(l => l.durationMs), [1.0, 1.05].map(scale => lapRows(scale, OTHER_LINE).durationMs))
    assert.equal(result[1].label, 'Oct 29 14:00 · L2')
  })

  await t.test('only other drivers with telemetry, and never a new workspace', async () => {
    const before = workspaces()
    const unknown = await laps('Nobody', 'x')
    assert.equal(unknown.status, 404)
    assert.match((await unknown.json()).error, /No driver named "Nobody"/)
    assert.equal((await laps('ryan', 'ryan-1')).status, 400, 'not your own laps')
    assert.match(await reason(await laps('New Driver', 'x')), /has not synced any telemetry/)
    assert.match(await reason(await laps('Alex', '../ryan-1')), /Invalid session ID/)
    assert.match(await reason(await laps('Alex', 'alex-raw')), /has not been downloaded/)
    assert.match(await reason(await laps('Alex', 'missing')), /no longer available/)
    assert.equal(workspaces(), before)
  })

  await t.test('their lap on your scene’s mean line, with their car and video', async () => {
    const response = await driverLap({ driver: 'ALEX', sessionGuid: 'alex-1', lap: 1, units: 'metric' })
    assert.equal(response.status, 200, await response.clone().text())
    const { result: lap } = await response.json()
    assert.equal(lap.driver, 'Alex', 'the account’s own spelling')
    assert.deepEqual(lap.vehicle, { guid: 'vette', make: 'CHEVROLET', model: 'CORVETTE', year: null, key: 'CHEVROLET CORVETTE' })
    assert.equal(lap.sessionGuid, 'alex-1')
    assert.equal(lap.lap, 1)
    assert.equal(lap.label, 'Oct 29 14:00 · L2')
    assert.equal(lap.durationMs, lapRows(1.05, OTHER_LINE).durationMs)
    // Every sample kept, its metres moved from Alex's line (1010 m) onto Ryan's (1000 m).
    assert.equal(lap.dist.length, OTHER_LINE.totalM + 1)
    assert.ok(Math.abs(lap.dist.at(-1) - 1000) < 0.5, `ends at ${lap.dist.at(-1)}`)
    for (const m of [255, 510, 800]) assert.ok(Math.abs(lap.dist[m] - OTHER_LINE.toCourse(m)) < 1.5, `their ${m} m → ${lap.dist[m]}`)
    assert.ok(lap.timeMs.every((ms, i) => i === 0 || ms >= lap.timeMs[i - 1]))
    // The PDR channels and the video by reference, streamed from their workspace.
    assert.equal(lap.car.videoId, VIDEO_ID)
    assert.equal(lap.car.driver, 'Alex')
    assert.equal(lap.car.label, 'Alex · Oct 29 14:00 · L2')
    assert.ok(lap.car.throttle.every(v => v === 60))
    assert.ok(Math.abs(lap.car.dist.at(-1) - lap.dist.at(-1)) < 6, 'the car trace moved too')
    const video = await fetch(`${server.url}/api/drivers/Alex/videos/${VIDEO_ID}.mp4`, { headers: { cookie } })
    assert.equal(video.status, 200)
    // A lap without video.
    assert.equal((await (await driverLap({ driver: 'Alex', sessionGuid: 'alex-1', lap: 0 })).json()).result.car, null)
  })

  await t.test('another course, an invalid lap or a missing session are refused with a reason', async () => {
    assert.match(await reason(await driverLap({ driver: 'Alex', sessionGuid: 'alex-grand', lap: 0 })), /Alex's session from Oct 20 09:00 is on Test Raceway · Grand West/)
    assert.match(await reason(await driverLap({ driver: 'Alex', sessionGuid: 'alex-1', lap: 2 })), /^Alex: L3 is not a valid lap/)
    assert.match(await reason(await driverLap({ driver: 'Alex', sessionGuid: 'alex-1', lap: 7 })), /^Alex: L8 is not a valid lap/)
    assert.match(await reason(await driverLap({ driver: 'Alex', sessionGuid: 'alex-raw', lap: 0 })), /has not been downloaded/)
    assert.match(await reason(await driverLap({ driver: 'Alex', sessionGuid: 'alex-1', lap: 1 }, 'not-mine')), /not in your workspace/)
  })

  await t.test('the same access rules as Analysis: other drivers only, and only from their backend', async () => {
    const before = workspaces()
    assert.match(await reason(await driverLap({ driver: 'Nobody', sessionGuid: 'x', lap: 0 })), /No driver named "Nobody"/)
    assert.match(await reason(await driverLap({ driver: 'ryan', sessionGuid: 'ryan-1', lap: 0 })), /Choose another driver/)
    assert.match(await reason(await driverLap({ driver: 'New Driver', sessionGuid: 'x', lap: 0 })), /has not synced any telemetry/)
    assert.match(await reason(await driverLap({ driver: 'Alex', sessionGuid: 'alex-1', lap: -1 })), /Invalid lap/)
    // A renderer cannot hand its backend a lap of its own making: the server
    // always replaces the request with the driver's own export.
    const forged = { driver: 'Alex', session: { sg: 'alex-1' }, vehicle: {}, lap: { sessionGuid: 'alex-1', lap: 0, dist: [0], timeMs: [0] }, line: null }
    assert.match(await reason(await driverLap(forged)), /Invalid lap/)
    assert.match(await reason(await driverLap('Alex')), /No driver named/)
    assert.equal(workspaces(), before)
  })

  await t.test('the desktop app reaches the same laps through the running server', async () => {
    assert.deepEqual((await server.drivers.replayLaps('Alex', 'alex-1', null)).map(l => l.lap), [0, 1])
    const bundle = await server.drivers.replayLap(null, { driver: 'alex', sessionGuid: 'alex-1', lap: 0 })
    assert.equal(bundle.driver, 'Alex')
    assert.equal(bundle.session.meanLineGuid, OTHER_LINE.meanLine)
    assert.equal(bundle.lap.dist.at(-1), OTHER_LINE.totalM, 'on their own mean line until your backend maps it')
    assert.equal(bundle.line.guid, OTHER_LINE.meanLine)
    await assert.rejects(server.drivers.replayLap('Alex', { driver: 'alex', sessionGuid: 'alex-1', lap: 0 }), /Choose another driver/)
  })
})
