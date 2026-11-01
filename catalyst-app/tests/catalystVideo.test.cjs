const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory, workspaceDbPath, workspaceVideoDir } = require('../dist-main/main/serverStorage.js')
const { parseCatalystPath, catalystVideoName } = require('../dist-main/shared/catalystVideo.js')
const { TRACK_YAML, LAYOUT, lapRows, writeMeanLines } = require('./fixtures/compareFixture.cjs')
const { writePlainVideo } = require('./fixtures/pdrFixture.cjs')

// Workers run without Electron, like tests/pdrVideo.test.cjs.
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

const CARD = 'Transcend SD card/Android/data/com.garmin.racingcoach/files/RaceData'
const at = (car, folder, file = 'video_1.mp4', track = LAYOUT.track) => `${CARD}/KING/${track}/${car}/${folder}/${file}`
const LOTUS = 'LOTUS EXIGE 2008'

// Synced sessions start a few minutes after the device folder's clock.
const MORNING = { sg: 'lotus-am', start: '2026-10-30 08:32:37', laps: [1.0, 1.05] }
const MIDDAY = { sg: 'lotus-mid', start: '2026-10-30 10:00:45', laps: [1.0] }
const VETTE = { sg: 'vette-pm', start: '2026-10-30 13:30:49', make: 'CHEVROLET', model: 'CORVETTE', laps: [1.0] }
const lapMs = MORNING.laps.map(scale => lapRows(scale).durationMs)
// The recording starts at the session start and runs 20 s past its last lap.
const VIDEO_S = 30 + (lapMs[0] + lapMs[1]) / 1000 + 20

test('Catalyst video paths are read from any mount or card', () => {
  const p = parseCatalystPath(`/Users/me/Library/CloudStorage/MacDroid-Catalyst/8M-^G/Android/data/com.garmin.racingcoach/files/RaceData/KING/Virginia International Raceway/${LOTUS}/20261030/082952/video_1.mp4`)
  assert.deepEqual(p, {
    key: `KING/Virginia International Raceway/${LOTUS}/20261030/082952/video_1.mp4`,
    folder: `KING/Virginia International Raceway/${LOTUS}/20261030/082952`,
    driver: 'KING', track: 'Virginia International Raceway', car: LOTUS,
    recordedAt: '2026-10-30 08:29:52', fileName: 'video_1.mp4', kind: 'session', part: 1,
  })
  assert.equal(catalystVideoName(p), 'Catalyst 2026-10-30 08:29 · session video')
  assert.equal(parseCatalystPath('RaceData\\KING\\VIR\\CAR\\20261030\\082952\\optimal_lap_video.mp4').kind, 'optimal')
  assert.equal(parseCatalystPath('KING/VIR/CAR/20261030/082952/video_2.mp4').part, 2)
  for (const bad of ['KING/VIR/CAR/20261330/082952/video_1.mp4', 'KING/VIR/CAR/20261030/256000/video_1.mp4',
    'KING/VIR/CAR/20261030/082952/video_0.mp4', 'KING/VIR/CAR/20261030/082952/clip.mp4', 'VIR/CAR/20261030/082952/video_1.mp4',
    'DCIM/Camera/20261030/082952/x/video_1.mov', 'KING/../CAR/20261030/082952/video_1.mp4']) {
    assert.equal(parseCatalystPath(bad), null, bad)
  }
})

test('Catalyst videos match their sessions, upload, and play beside the laps', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-video-'))
  const dataDir = path.join(root, 'server')
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  const dir = userDirectory(dataDir, 'Ryan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username: 'Ryan' }))
  writeMeanLines(path.join(dir, 'garmin', 'data', 'mean_lines'))
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify([MORNING, MIDDAY, VETTE])], { stdio: 'pipe' })

  const video = path.join(root, 'video_1.mp4')
  writePlainVideo(video, { durationS: VIDEO_S })
  const optimal = path.join(root, 'optimal_lap_video.mp4')
  writePlainVideo(optimal, { durationS: lapMs[0] / 1000 })
  const size = file => fs.statSync(file).size

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const call = (endpoint, init = {}, cookie) => fetch(server.url + endpoint, {
    ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(30000),
  })
  const postJson = (endpoint, body, cookie) => call(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, cookie)
  const cookie = (await postJson('/api/login', { username: 'Ryan' })).headers.get('set-cookie').split(';')[0]
  const rpc = async (channel, ...args) => {
    const response = await postJson('/api/rpc', { channel, args }, cookie)
    const body = await response.json()
    assert.equal(response.status, 200, body.error)
    return body.result
  }
  // The browser's upload, as the Import page sends it.
  const upload = async (file, catalystPath, sessionGuid = null) => {
    const bytes = fs.readFileSync(file)
    const start = await (await postJson('/api/videos/uploads', { fileName: path.basename(file), size: bytes.length, sessionGuid, catalystPath }, cookie)).json()
    assert.ok(start.uploadId, start.error)
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      const reply = await call(`/api/videos/uploads/${start.uploadId}?offset=${offset}`, { method: 'PUT', body: bytes.subarray(offset, offset + 4096) }, cookie)
      assert.equal(reply.status, 200)
    }
    assert.equal((await postJson(`/api/videos/uploads/${start.uploadId}/finish`, {}, cookie)).status, 202)
    for (let i = 0; i < 200; i++) {
      const status = await (await call(`/api/videos/uploads/${start.uploadId}`, {}, cookie)).json()
      if (status.state !== 'importing') return status
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('import never finished')
  }
  const storedFiles = () => fs.readdirSync(workspaceVideoDir(dir)).filter(name => name.endsWith('.mp4'))

  const entries = [
    { path: at(LOTUS, '20261030/082928'), size: size(video) },
    { path: at(LOTUS, '20261030/082928', 'optimal_lap_video.mp4'), size: size(optimal) },
    { path: at(LOTUS, '20261030/095756'), size: 2e9 },
    { path: at('CHEVROLET CORVETTE 2021', '20261030/132700'), size: 2e9 },
    // Started near the Corvette's session, but in the Lotus.
    { path: at(LOTUS, '20261030/132800'), size: 2e9 },
    { path: at(LOTUS, '20261029/090000'), size: 2e9 },
    { path: at(LOTUS, '20261030/101500', 'video_1.mp4', 'Other Raceway'), size: 2e9 },
    { path: `${CARD}/../DCIM/Camera/clip.mp4`, size: 10 },
  ]
  const folderOf = (plan, folder) => plan.folders.find(f => f.folder.endsWith(folder))

  await t.test('each recording is matched to the synced session it belongs to', async () => {
    const plan = await rpc('videos:catalystPlan', entries)
    assert.equal(plan.folders.length, 6, 'non-Catalyst files are left out')
    assert.deepEqual(plan.folders.map(f => f.recordedAt), [
      '2026-10-30 13:28:00', '2026-10-30 13:27:00', '2026-10-30 10:15:00', '2026-10-30 09:57:56', '2026-10-30 08:29:28', '2026-10-29 09:00:00',
    ], 'newest first')
    const am = folderOf(plan, `${LOTUS}/20261030/082928`)
    assert.equal(am.session.guid, 'lotus-am')
    assert.equal(am.session.gapS, 189)
    assert.equal(am.session.car, 'LOTUS EXIGE')
    assert.deepEqual(am.files.map(f => [f.fileName, f.kind, f.importedId]), [['video_1.mp4', 'session', null], ['optimal_lap_video.mp4', 'optimal', null]])
    assert.equal(folderOf(plan, '095756').session.guid, 'lotus-mid')
    assert.equal(folderOf(plan, 'CORVETTE 2021/20261030/132700').session.guid, 'vette-pm', 'the car decides between same-time sessions')
    const wrongCar = folderOf(plan, `${LOTUS}/20261030/132800`)
    assert.equal(wrongCar.session, null)
    assert.match(wrongCar.note, /13:30 is Test Raceway in CHEVROLET CORVETTE, not Test Raceway in LOTUS EXIGE 2008/)
    assert.equal(folderOf(plan, '101500').session, null, 'another track never matches')
    assert.match(folderOf(plan, '20261029/090000').note, /No synced session starts near 2026-10-29 09:00/)
  })

  let videoId
  await t.test('the session video attaches at the session start and covers its laps', async () => {
    const status = await upload(video, at(LOTUS, '20261030/082928'))
    assert.equal(status.state, 'done', status.error)
    const { video: stored, matched, message } = status.result
    assert.equal(matched, true, message)
    videoId = stored.id
    assert.equal(stored.sessionGuid, 'lotus-am')
    assert.equal(stored.source, 'catalyst')
    assert.equal(stored.sourcePath, `KING/${LAYOUT.track}/${LOTUS}/20261030/082928/video_1.mp4`)
    assert.equal(stored.fileName, 'Catalyst 2026-10-30 08:29 · session video')
    assert.equal(stored.offsetS, 0)
    assert.equal(stored.alignment, 'clock')
    assert.deepEqual(stored.laps, [0, 1])
    assert.ok(Math.abs(stored.durationS - VIDEO_S) < 0.01)
    assert.deepEqual([stored.width, stored.height], [1920, 1080])
    assert.match(message, /Matched to Test Raceway · Full Course on 2026-10-30 08:32: 2 laps \(L1, L2\)/)
  })

  await t.test('the same file is not stored twice', async () => {
    const status = await upload(video, `Other card/RaceData/KING/${LAYOUT.track}/${LOTUS}/20261030/082928/video_1.mp4`)
    assert.equal(status.state, 'done', status.error)
    assert.equal(status.result.video.id, videoId)
    assert.match(status.result.message, /^Already imported/)
    assert.equal(storedFiles().length, 1)
    assert.equal((await rpc('videos:listAll')).length, 1)
  })

  await t.test('the optimal-lap video joins the same session, without a place on its timeline', async () => {
    const status = await upload(optimal, at(LOTUS, '20261030/082928', 'optimal_lap_video.mp4'), 'lotus-am')
    assert.equal(status.state, 'done', status.error)
    const stored = status.result.video
    assert.equal(stored.source, 'catalyst-optimal')
    assert.equal(stored.sessionGuid, 'lotus-am')
    assert.equal(stored.offsetS, null)
    assert.match(status.result.message, /optimal-lap video/)
    const plan = await rpc('videos:catalystPlan', entries)
    assert.ok(folderOf(plan, `${LOTUS}/20261030/082928`).files.every(f => f.importedId && f.importedSession === 'lotus-am'), 'the plan shows both as imported')
  })

  await t.test('Session Review plays every lap at its session time, with Garmin speed', async () => {
    const data = await rpc('videos:carData', 'lotus-am')
    assert.deepEqual(data.attached.map(v => v.source).sort(), ['catalyst', 'catalyst-optimal'])
    assert.deepEqual(data.traces.map(tr => tr.lapIdx), [0, 1])
    const [first, second] = data.traces
    assert.equal(first.videoId, videoId)
    // Lap 1 starts 30 s into the session, so 30 s into the video.
    assert.ok(Math.abs(first.videoT[0] - 30) < 0.01, `first lap starts at ${first.videoT[0]}`)
    assert.ok(Math.abs(second.videoT[0] - (30 + lapMs[0] / 1000)) < 0.05)
    assert.ok(first.speed.every(v => v != null && v > 0), 'speed from Garmin GPS')
    for (const channel of ['throttle', 'brake', 'gear', 'rpm', 'steering', 'slip']) assert.ok(first[channel].every(v => v == null), `${channel} is empty`)
    const analysis = await rpc('analysis:build', ['lotus-am'])
    assert.equal(analysis.car.traces.length, 2, 'Analysis gets the player too')
  })

  await t.test('the sync can be nudged and reset like a PDR video', async () => {
    const moved = await rpc('videos:setOffset', videoId, 1.5)
    assert.equal(moved.alignment, 'manual')
    const data = await rpc('videos:carData', 'lotus-am')
    assert.ok(Math.abs(data.traces[0].videoT[0] - 28.5) < 0.01)
    const reset = await rpc('videos:setOffset', videoId, null)
    assert.equal(reset.offsetS, 0)
    assert.equal(reset.alignment, 'clock')
  })

  await t.test('a video can be attached to another session, and matched back', async () => {
    const moved = await rpc('videos:match', videoId, 'lotus-mid')
    assert.equal(moved.video.sessionGuid, 'lotus-mid')
    assert.deepEqual(moved.video.laps, [0])
    assert.equal((await rpc('videos:carData', 'lotus-am')).traces.length, 0)
    const back = await rpc('videos:match', videoId, null)
    assert.equal(back.video.sessionGuid, 'lotus-am')
    assert.deepEqual(back.video.laps, [0, 1])
  })

  await t.test('a recording with no synced session is kept, unattached, with the reason', async () => {
    const status = await upload(optimal, at(LOTUS, '20261029/090000'))
    assert.equal(status.state, 'done', status.error)
    assert.equal(status.result.matched, false)
    assert.equal(status.result.video.sessionGuid, null)
    assert.match(status.result.video.matchNote, /No synced session starts near 2026-10-29 09:00/)
    assert.equal(await rpc('videos:delete', status.result.video.id), true)
  })

  await t.test('files that are not Catalyst session videos are refused and not kept', async () => {
    const before = storedFiles().length
    const junk = path.join(root, 'junk', 'video_1.mp4')
    fs.mkdirSync(path.dirname(junk))
    fs.writeFileSync(junk, 'not a video at all')
    const notMp4 = await upload(junk, at(LOTUS, '20261030/095756'))
    assert.equal(notMp4.state, 'failed')
    assert.match(notMp4.error, /not a readable MP4/)
    const outside = await upload(video, `${CARD}/KING/video_1.mp4`)
    assert.equal(outside.state, 'failed')
    assert.match(outside.error, /not in a Catalyst RaceData session folder/)
    assert.equal(storedFiles().length, before)
  })
})
