const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { legacyVideoDir, userDirectory, workspaceDbPath, workspaceVideoDir } = require('../dist-main/main/serverStorage.js')
const { readPdrFile } = require('../dist-main/garmin/pdrFile.js')
const { TRACK_YAML, lapRows, writeMeanLines } = require('./fixtures/compareFixture.cjs')
const { drivingRecords, writePdrVideo } = require('./fixtures/pdrFixture.cjs')

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

const MORNING = { sg: 'vette-am', start: '2026-10-30 10:00:00', laps: [1.0, 1.05] }
const AFTERNOON = { sg: 'vette-pm', start: '2026-10-30 14:00:00', laps: [1.0, 0.95, 1.1] }
const durations = AFTERNOON.laps.map(scale => lapRows(scale).durationMs / 1000)
// The video starts 10 s before the afternoon's second lap and ends 10 s
// after its last, so it covers laps 2 and 3 (indices 1 and 2).
const VIDEO_START_S = 30 + durations[0] - 10
const VIDEO_S = durations[1] + durations[2] + 20

const clockPlus = (clock, s) => new Date(Date.parse(`${clock.replace(' ', 'T')}Z`) + s * 1000).toISOString().slice(0, 19).replace('T', ' ')

test('a PDR video is read without decoding the video itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-pdr-'))
  try {
    const file = path.join(dir, 'PDR_0001.mp4')
    const records = drivingRecords(AFTERNOON.laps, VIDEO_START_S, VIDEO_S)
    writePdrVideo(file, records, { durationS: VIDEO_S, recordedAt: '2026-10-30 14:00:40' })
    const pdr = await readPdrFile(file)
    assert.equal(pdr.records.channel.length, records.length)
    assert.equal(pdr.recordedAt, '2026-10-30 14:00:40')
    assert.equal(pdr.device, 'Cougar PDR 2.0')
    assert.deepEqual([pdr.width, pdr.height], [1920, 1080])
    assert.ok(Math.abs(pdr.durationS - VIDEO_S) < 0.01)
    for (let i = 1; i < pdr.records.timeS.length; i++) assert.ok(pdr.records.timeS[i] >= pdr.records.timeS[i - 1], 'records in time order')
    await assert.rejects(readPdrFile(path.join(__dirname, 'fixtures/compareFixture.cjs')), /not a readable MP4/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('PDR videos upload in chunks, find their session, and feed Analysis', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-pdr-server-'))
  const dataDir = path.join(root, 'server')
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  const dir = userDirectory(dataDir, 'Ryan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username: 'Ryan' }))
  writeMeanLines(path.join(dir, 'garmin', 'data', 'mean_lines'))
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify([MORNING, AFTERNOON])], { stdio: 'pipe' })

  // The PDR's clock runs an hour ahead of the Garmin's local time.
  const video = path.join(root, 'PDR_0913.mp4')
  writePdrVideo(video, drivingRecords(AFTERNOON.laps, VIDEO_START_S, VIDEO_S), { durationS: VIDEO_S, recordedAt: clockPlus(AFTERNOON.start, VIDEO_START_S + 3600) })
  const parked = path.join(root, 'PDR_0909.mp4')
  writePdrVideo(parked, drivingRecords([], 0, 60, { moving: false }), { durationS: 60, recordedAt: '2026-10-30 13:26:06' })

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
  // The browser's upload: start, chunks in order, finish, then poll.
  const upload = async (file, chunk = 65536, sessionGuid = null) => {
    const bytes = fs.readFileSync(file)
    const start = await (await postJson('/api/videos/uploads', { fileName: path.basename(file), size: bytes.length, sessionGuid }, cookie)).json()
    assert.ok(start.uploadId, start.error)
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      const reply = await call(`/api/videos/uploads/${start.uploadId}?offset=${offset}`, { method: 'PUT', body: bytes.subarray(offset, offset + chunk) }, cookie)
      assert.equal(reply.status, 200, (await reply.clone().json()).error)
    }
    const finish = await postJson(`/api/videos/uploads/${start.uploadId}/finish`, {}, cookie)
    assert.equal(finish.status, 202)
    for (let i = 0; i < 200; i++) {
      const status = await (await call(`/api/videos/uploads/${start.uploadId}`, {}, cookie)).json()
      if (status.state !== 'importing') return status
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('import never finished')
  }

  let videoId
  await t.test('the video finds the afternoon session despite its clock', async () => {
    const status = await upload(video)
    assert.equal(status.state, 'done', status.error)
    const { video: stored, matched, message } = status.result
    assert.equal(matched, true, message)
    assert.equal(stored.sessionGuid, AFTERNOON.sg)
    assert.deepEqual(stored.laps, [1, 2])
    assert.equal(stored.alignment, 'position')
    assert.ok(Math.abs(stored.offsetS - VIDEO_START_S) < 0.05, `offset ${stored.offsetS} vs ${VIDEO_START_S}`)
    assert.match(message, /Matched to Test Raceway · Full Course on 2026-10-30 14:00: 2 laps \(L2, L3\)/)
    videoId = stored.id
    assert.ok(fs.existsSync(path.join(workspaceVideoDir(dir), `${videoId}.mp4`)))
    assert.deepEqual(fs.readdirSync(path.join(workspaceVideoDir(dir), '.incoming')), [], 'no part files left')
  })

  await t.test('chunks must arrive in order', async () => {
    const start = await (await postJson('/api/videos/uploads', { fileName: 'PDR_1.mp4', size: 100 }, cookie)).json()
    const early = await call(`/api/videos/uploads/${start.uploadId}?offset=50`, { method: 'PUT', body: Buffer.alloc(50) }, cookie)
    assert.equal(early.status, 409)
    assert.equal((await early.json()).received, 0)
    assert.equal((await call(`/api/videos/uploads/${start.uploadId}`, { method: 'DELETE' }, cookie)).status, 200)
    const other = (await postJson('/api/login', { username: 'Mitch' })).headers.get('set-cookie').split(';')[0]
    assert.equal((await call(`/api/videos/${videoId}.mp4`, {}, other)).status, 404, 'videos are private to their driver')
    assert.equal((await postJson('/api/rpc', { channel: 'videos:import', args: [videoId, 'x.mp4', null] }, cookie)).status, 400, 'internal channel')
  })

  await t.test('the player can seek: range requests', async () => {
    const bytes = fs.readFileSync(video)
    const part = await call(`/api/videos/${videoId}.mp4`, { headers: { Range: 'bytes=100-199' } }, cookie)
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${bytes.length}`)
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200))
    const whole = await call(`/api/videos/${videoId}.mp4`, {}, cookie)
    assert.equal(whole.status, 200)
    assert.equal(Number(whole.headers.get('content-length')), bytes.length)
    await whole.arrayBuffer()
  })

  // Lap `index` of the afternoon: where the video is at a distance.
  const expectedVideoT = (index, distM) => {
    const lap = lapRows(AFTERNOON.laps[index])
    const start = 30 + durations.slice(0, index).reduce((a, b) => a + b, 0)
    return start + lap.rows[distM].t / 1000 - VIDEO_START_S
  }

  await t.test('Analysis gets the car data and the video for covered laps', async () => {
    const analysis = await rpc('analysis:build', [AFTERNOON.sg], 'metric', 'all')
    assert.ok(analysis.car, 'car data present')
    assert.deepEqual(analysis.car.videos.map(v => v.id), [videoId])
    assert.deepEqual(analysis.car.traces.map(t => t.lapIdx).sort(), [1, 2])
    const lap = analysis.car.traces.find(t => t.lapIdx === 1)
    const i = lap.dist.indexOf(500)
    assert.ok(Math.abs(lap.videoT[i] - expectedVideoT(1, 500)) < 0.06, `${lap.videoT[i]} vs ${expectedVideoT(1, 500)}`)
    assert.equal(lap.dist[1] - lap.dist[0], 5)
    assert.ok(lap.brake.some(v => v > 0), 'braking into the hairpin')
    assert.ok(lap.throttle.some(v => v > 50), 'throttle out of it')
    assert.ok(lap.gear.every(g => g == null || [2, 3].includes(g)))
    assert.ok(lap.rpm.every(r => r == null || r > 900))
    // Speed from the car, in the display unit.
    assert.ok(Math.abs(lap.speed[lap.dist.indexOf(200)] - lapRows(AFTERNOON.laps[1]).rows[200].v * 3.6) < 1)
    // The morning session has no video.
    assert.equal((await rpc('analysis:build', [MORNING.sg], 'metric', 'all')).car, null)
    // Another driver comparing against this session gets the PDR video of
    // each lap it covers, placed the same way: video time = startS + lap time.
    const exported = await rpc('compare:export', [AFTERNOON.sg], 'all')
    const withVideo = exported.laps.filter(l => l.video).map(l => l.lapIndex).sort()
    assert.deepEqual(withVideo, [1, 2])
    const second = exported.laps.find(l => l.lapIndex === 1)
    const k = second.samples.dist.indexOf(500)
    assert.ok(Math.abs(second.video.startS + second.samples.timeMs[k] / 1000 - expectedVideoT(1, 500)) < 0.06)
    assert.equal(second.video.id, videoId)
  })

  await t.test('nudging the sync moves the car data with it', async () => {
    const nudged = await rpc('videos:setOffset', videoId, VIDEO_START_S + 0.5)
    assert.equal(nudged.alignment, 'manual')
    const data = await rpc('videos:carData', AFTERNOON.sg)
    assert.deepEqual(data.attached.map(v => v.id), [videoId])
    assert.deepEqual(data.laps.map(l => l.lapIdx), [0, 1, 2])
    const lap = data.traces.find(t => t.lapIdx === 1)
    assert.ok(Math.abs(lap.videoT[lap.dist.indexOf(500)] - (expectedVideoT(1, 500) - 0.5)) < 0.06)
    const reset = await rpc('videos:setOffset', videoId, null)
    assert.equal(reset.alignment, 'position')
    assert.ok(Math.abs(reset.offsetS - VIDEO_START_S) < 0.05)
  })

  await t.test('a video that matches no session is kept, unattached, with the reason', async () => {
    const status = await upload(parked, 20000)
    assert.equal(status.state, 'done', status.error)
    assert.equal(status.result.matched, false)
    assert.match(status.result.message, /not driving/)
    const all = await rpc('videos:listAll')
    assert.deepEqual(all.map(v => [v.fileName, v.sessionGuid]), [['PDR_0913.mp4', AFTERNOON.sg], ['PDR_0909.mp4', null]])
    assert.match(all[1].matchNote, /not driving/)
    const again = await rpc('videos:match', all[1].id, null)
    assert.equal(again.matched, false)
    // A wrong session for the real video says so and leaves it attached.
    const wrong = await rpc('videos:match', videoId, MORNING.sg)
    assert.equal(wrong.matched, false)
    assert.equal(wrong.video.sessionGuid, AFTERNOON.sg)
    const sessions = await rpc('db:listSessions', null)
    assert.equal(sessions.find(s => s.session_guid === AFTERNOON.sg).video_count, 1)
    assert.equal(await rpc('videos:delete', all[1].id), true)
    assert.ok(!fs.existsSync(path.join(workspaceVideoDir(dir), `${all[1].id}.mp4`)), 'file removed')
    assert.deepEqual((await rpc('videos:listAll')).map(v => v.id), [videoId])
  })

  await t.test('a file that is not a PDR video is refused and not kept', async () => {
    const junk = path.join(root, 'holiday.mp4')
    fs.writeFileSync(junk, Buffer.alloc(5000, 7))
    const status = await upload(junk)
    assert.equal(status.state, 'failed')
    assert.match(status.error, /not a readable MP4/)
    assert.deepEqual(fs.readdirSync(workspaceVideoDir(dir)).filter(n => n.endsWith('.mp4')), [`${videoId}.mp4`])
  })
})

test('with a media directory, videos live apart from the data a deploy keeps', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-pdr-media-'))
  const dataDir = path.join(root, 'server')
  const mediaDir = path.join(root, 'media')
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  const dir = userDirectory(dataDir, 'Ryan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username: 'Ryan' }))
  writeMeanLines(path.join(dir, 'garmin', 'data', 'mean_lines'))
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify([MORNING, AFTERNOON])], { stdio: 'pipe' })
  // A video uploaded before the media directory, and an upload cut off by a restart.
  const oldId = '7d0f4a52-3b8e-4c1a-9f6e-2a5b8c9d0e1f'
  const oldBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
  fs.mkdirSync(path.join(legacyVideoDir(dir), '.incoming'), { recursive: true })
  fs.writeFileSync(path.join(legacyVideoDir(dir), `${oldId}.mp4`), oldBytes)
  fs.writeFileSync(path.join(legacyVideoDir(dir), '.incoming', 'cut-off.part'), 'x')
  const parked = path.join(root, 'PDR_0909.mp4')
  writePdrVideo(parked, drivingRecords([], 0, 60, { moving: false }), { durationS: 60, recordedAt: '2026-10-30 13:26:06' })

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, mediaDir, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const call = (endpoint, init = {}, cookie) => fetch(server.url + endpoint, {
    ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(30000),
  })
  const postJson = (endpoint, body, cookie) => call(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, cookie)
  const cookie = (await postJson('/api/login', { username: 'Ryan' })).headers.get('set-cookie').split(';')[0]
  const rpc = async (channel, ...args) => {
    const body = await (await postJson('/api/rpc', { channel, args }, cookie)).json()
    assert.equal(body.error, undefined)
    return body.result
  }
  const videos = workspaceVideoDir(dir, mediaDir)
  assert.equal(videos, path.join(mediaDir, 'users', path.basename(dir), 'videos'))

  // The old video moves over while the server runs, and plays throughout.
  for (let i = 0; i < 100 && fs.existsSync(legacyVideoDir(dir)); i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(!fs.existsSync(legacyVideoDir(dir)), 'nothing left in the data directory')
  assert.deepEqual(fs.readFileSync(path.join(videos, `${oldId}.mp4`)), oldBytes)
  const served = await call(`/api/videos/${oldId}.mp4`, {}, cookie)
  assert.equal(served.status, 200)
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), oldBytes)

  // New uploads go straight to the media directory.
  const bytes = fs.readFileSync(parked)
  const start = await (await postJson('/api/videos/uploads', { fileName: 'PDR_0909.mp4', size: bytes.length }, cookie)).json()
  assert.equal((await call(`/api/videos/uploads/${start.uploadId}?offset=0`, { method: 'PUT', body: bytes }, cookie)).status, 200)
  assert.equal((await postJson(`/api/videos/uploads/${start.uploadId}/finish`, {}, cookie)).status, 202)
  let status
  for (let i = 0; i < 200; i++) {
    status = await (await call(`/api/videos/uploads/${start.uploadId}`, {}, cookie)).json()
    if (status.state !== 'importing') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(status.state, 'done', status.error)
  const id = status.result.video.id
  assert.ok(fs.existsSync(path.join(videos, `${id}.mp4`)))
  assert.ok(!fs.existsSync(path.join(dataDir, 'users', path.basename(dir), 'garmin', 'data', 'videos')), 'the data directory holds no video')
  assert.equal((await call(`/api/videos/${id}.mp4`, { headers: { Range: 'bytes=0-9' } }, cookie)).status, 206)
  assert.equal(await rpc('videos:delete', id), true)
  assert.ok(!fs.existsSync(path.join(videos, `${id}.mp4`)), 'deleted from the media directory')
})

test('videos copy across volumes when they cannot be renamed', async () => {
  const { moveVideosToMedia } = require('../dist-main/main/serverStorage.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-media-move-'))
  const rename = fs.promises.rename
  try {
    const dataDir = path.join(root, 'data')
    const mediaDir = path.join(root, 'media')
    const dir = userDirectory(dataDir, 'Ryan')
    const kept = '11111111-2222-4333-8444-555555555555'
    const deleted = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    fs.mkdirSync(legacyVideoDir(dir), { recursive: true })
    fs.writeFileSync(path.join(legacyVideoDir(dir), `${kept}.mp4`), 'kept video')
    fs.writeFileSync(path.join(legacyVideoDir(dir), `${deleted}.mp4`), 'deleted video')
    fs.writeFileSync(path.join(legacyVideoDir(dir), 'notes.txt'), 'not a video')
    // Separate Docker mounts: a rename out of the data directory fails.
    fs.promises.rename = async (from, to) => {
      if (String(from).startsWith(dataDir)) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      // The driver deletes this one while it is being copied.
      if (String(to).endsWith(`${deleted}.mp4`)) fs.rmSync(path.join(legacyVideoDir(dir), `${deleted}.mp4`))
      return rename(from, to)
    }
    assert.equal(await moveVideosToMedia(dataDir, mediaDir), 1)
    const videos = workspaceVideoDir(dir, mediaDir)
    assert.deepEqual(fs.readdirSync(videos), [`${kept}.mp4`], 'no partial copies, and the deleted video stays deleted')
    assert.equal(fs.readFileSync(path.join(videos, `${kept}.mp4`), 'utf8'), 'kept video')
    assert.deepEqual(fs.readdirSync(legacyVideoDir(dir)), ['notes.txt'], 'only videos move')
  } finally {
    fs.promises.rename = rename
    fs.rmSync(root, { recursive: true, force: true })
  }
})
