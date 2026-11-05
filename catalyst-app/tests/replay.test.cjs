const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory, workspaceDbPath } = require('../dist-main/main/serverStorage.js')
const { TRACK_YAML, OTHER_LINE, lapRows, writeMeanLines } = require('./fixtures/compareFixture.cjs')
const { heightAt, startFakeUsgs, glbFile } = require('./fixtures/terrainFixture.cjs')

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
const { decodeGrid, TerrainService } = require('../dist-main/garmin/terrain.js')
const { readFloatTiff } = require('../dist-main/garmin/geoTiff.js')
const { CAR_PRESETS, MAX_CAR_MODEL_BYTES } = require('../dist-main/shared/replay.js')

// Retries and the wait after a failed build, in milliseconds (×1, ×3, ×10; ×20).
process.env.CATALYST_TERRAIN_RETRY_MS = '20'

const SCENE = { sg: 'replay-a', start: '2026-10-30 10:00:00', laps: [1.0, 1.1, 0.95] }
const OTHER = { sg: 'replay-b', start: '2026-10-31 09:00:00', laps: [0.9, 1.2] }
// Another device's mean line for the same course: its metres differ.
const DEVICE = { sg: 'replay-c', start: '2026-11-01 09:00:00', meanLine: OTHER_LINE.meanLine, laps: [0.92] }
// Another course of the same facility.
const ELSEWHERE = { sg: 'replay-d', start: '2026-11-02 09:00:00', configId: 42, config: 'Short Course', laps: [0.5] }
const VIDEO_ID = '8f0c2a51-3b7e-4c1d-9a2e-5d6f7a8b9c0d'

// Garmin's optimal lap for the scene, and a synced video covering its second
// lap (as an import leaves them), straight into the workspace database.
function seedExtras(dbPath) {
  const script = `
    const { withDb } = require(${JSON.stringify(path.join(__dirname, '../dist-main/garmin/loadToDb.js'))})
    const { lapRows } = require(${JSON.stringify(path.join(__dirname, 'fixtures/compareFixture.cjs'))})
    withDb(async con => {
      const optimal = lapRows(0.9)
      await con.run('INSERT INTO optimal_laps VALUES (?, ?, ?)', ['${SCENE.sg}', optimal.durationMs, optimal.rows.length])
      await con.run('INSERT INTO optimal_lap_samples (session_guid, distance_m, time_ms, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2, lateral_position) VALUES '
        + optimal.rows.map(r => \`('${SCENE.sg}', \${r.d}, \${r.t}, \${r.lat}, \${r.lon}, \${r.v}, \${r.ax}, \${r.ay}, 0.5)\`).join(','))
      await con.run(\`INSERT INTO session_videos (video_id, session_guid, file_name, size_bytes, duration_s, offset_s, auto_offset_s, alignment, laps, channels, record_count, decode_version)
        VALUES ('${VIDEO_ID}', '${SCENE.sg}', 'PDR_0001.mp4', 1, 600, 20, 20, 'position', '[1]', '[]', 0, 2)\`)
      const lap = lapRows(1.1)
      await con.run('INSERT INTO pdr_lap_samples (session_guid, lap_index, distance_m, video_id, video_time_s, throttle_pct) VALUES '
        + lap.rows.map(r => \`('${SCENE.sg}', 1, \${r.d}, '${VIDEO_ID}', \${(r.t / 1000 + 10).toFixed(3)}, 50)\`).join(','))
    }, ${JSON.stringify(dbPath)}).then(() => process.exit(0), error => { console.error(error); process.exit(1) })
  `
  childProcess.execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' })
}

async function serverFor(t, { mediaDir = false, models = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-replay-'))
  const dataDir = path.join(root, 'server')
  const media = mediaDir ? path.join(root, 'media') : null
  fs.mkdirSync(path.join(root, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracks', 'test-raceway.yaml'), TRACK_YAML)
  const dir = userDirectory(dataDir, 'Ryan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username: 'Ryan' }))
  writeMeanLines(path.join(dir, 'garmin', 'data', 'mean_lines'))
  childProcess.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/compareFixture.cjs'), workspaceDbPath(dir), JSON.stringify([SCENE, OTHER, DEVICE, ELSEWHERE])], { stdio: 'pipe' })
  seedExtras(workspaceDbPath(dir))
  // Car models copied into the shared folder by hand before the server starts.
  const modelsDir = path.join(media ?? dataDir, 'shared', 'car-models')
  for (const [name, bytes] of models) { fs.mkdirSync(modelsDir, { recursive: true }); fs.writeFileSync(path.join(modelsDir, name), bytes) }

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, mediaDir: media ?? undefined, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const call = (endpoint, init = {}, cookie) => fetch(server.url + endpoint, {
    ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(30000),
  })
  const sendJson = (method, endpoint, body, cookie) => call(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, cookie)
  const cookie = (await sendJson('POST', '/api/login', { username: 'Ryan' })).headers.get('set-cookie').split(';')[0]
  const rpc = async (channel, ...args) => {
    const response = await sendJson('POST', '/api/rpc', { channel, args }, cookie)
    const body = await response.json()
    if (response.status !== 200) throw new Error(body.error)
    return body.result
  }
  return { root, dataDir, media, modelsDir, server, call, sendJson, cookie, rpc }
}

test('replay: a session’s scene and laps, with ghosts from other mean lines', { timeout: 120000 }, async t => {
  const { rpc } = await serverFor(t)

  const scene = await rpc('replay:scene', SCENE.sg)
  assert.equal(scene.sessionGuid, SCENE.sg)
  assert.deepEqual(scene.vehicle, { guid: 'car', make: 'LOTUS', model: 'EXIGE', year: null, key: 'LOTUS EXIGE' })
  assert.ok(['metric', 'imperial'].includes(scene.units))

  const { track } = scene
  assert.equal(track.meanLineGuid, 'test-line')
  assert.equal(track.trackName, 'Test Raceway')
  assert.equal(track.configName, 'Full Course')
  assert.equal(track.totalDistM, 1000)
  assert.equal(track.line.dist.length, 1001, 'the mean line at 1 m')
  assert.deepEqual([track.line.lat[500], track.line.lon[500]], [37.005, -79])
  assert.deepEqual(track.corners, [{ turn: 'T1', name: 'Hairpin', apexM: 500, startM: 470, endM: 530, direction: 'left' }])
  assert.deepEqual(track.sectorsM, [0, 500])
  // The facility's other mean line (2.7 m east) is inside the area, with ~400 m to spare.
  const margin = 400 / 111320
  assert.ok(Math.abs(track.area.south - (37 - margin)) < 1e-5 && Math.abs(track.area.north - (37.01 + margin)) < 1e-5)
  assert.ok(track.area.east > -79 + OTHER_LINE.lonOffset + 0.004 && track.area.west < -79 - 0.004)

  const durations = SCENE.laps.map(scale => lapRows(scale).durationMs)
  assert.deepEqual(scene.laps.map(l => l.lap), [0, 1, 2, 'optimal'])
  assert.deepEqual(scene.laps.slice(0, 3).map(l => l.durationMs), durations)
  assert.deepEqual(scene.laps.map(l => l.isBest), [false, true, false, false], 'a larger scale is a faster lap')
  assert.deepEqual(scene.laps.map(l => l.hasVideo), [false, true, false, false])
  assert.deepEqual(scene.laps.map(l => l.label), ['Oct 30 10:00 · L1', 'Oct 30 10:00 · L2', 'Oct 30 10:00 · L3', 'Oct 30 10:00 · Optimal'])
  assert.equal(scene.laps[3].durationMs, lapRows(0.9).durationMs)

  // Other sessions on this course, on either mean line, fastest first; not the other course.
  const ghosts = scene.ghostCandidates
  assert.deepEqual(ghosts.map(g => `${g.sessionGuid}:${g.lap}`), ['replay-b:1', 'replay-c:0', 'replay-b:0'])
  assert.deepEqual(ghosts.map(g => g.isBest), [true, true, false])
  assert.ok(ghosts.every((g, i) => i === 0 || g.durationMs >= ghosts[i - 1].durationMs))
  assert.equal(ghosts[0].label, 'Oct 31 09:00 · L2')

  // One of the scene's laps, in time order, with its video's car data.
  const lap = await rpc('replay:lap', SCENE.sg, { sessionGuid: SCENE.sg, lap: 1 })
  const rows = lapRows(1.1).rows
  assert.equal(lap.label, 'Oct 30 10:00 · L2')
  assert.equal(lap.durationMs, durations[1])
  assert.equal(lap.dist.length, rows.length)
  for (const key of ['timeMs', 'lat', 'lon', 'altM', 'speedMps', 'accelX', 'accelY', 'headingDeg']) assert.equal(lap[key].length, rows.length, key)
  assert.ok(lap.timeMs.every((t, i) => i === 0 || t >= lap.timeMs[i - 1]), 'time order')
  assert.equal(lap.timeMs[0], 0)
  assert.ok(Math.abs(lap.speedMps[200] - rows[200].v) < 1e-3)
  assert.equal(lap.altM[0], null, 'no altitude in this telemetry')
  assert.ok(lap.car, 'car data from the synced video')
  assert.equal(lap.car.videoId, VIDEO_ID)
  assert.equal(lap.car.dist[1] - lap.car.dist[0], 5)
  assert.ok(Math.abs(lap.car.videoT[lap.car.dist.indexOf(500)] - (rows[500].t / 1000 + 10)) < 1e-3)
  assert.equal((await rpc('replay:lap', SCENE.sg, { sessionGuid: SCENE.sg, lap: 0 })).car, null, 'no video on this lap')

  // Garmin's optimal lap: no altitude or heading in its samples.
  const optimal = await rpc('replay:lap', SCENE.sg, { sessionGuid: SCENE.sg, lap: 'optimal' })
  assert.equal(optimal.label, 'Oct 30 10:00 · Optimal')
  assert.equal(optimal.dist.length, 1001)
  assert.ok(optimal.altM.every(v => v === null) && optimal.headingDeg.every(v => v === null))
  assert.equal(optimal.car, null)

  // A lap measured along the other device's mean line lands on the scene's.
  const ghost = await rpc('replay:lap', SCENE.sg, { sessionGuid: DEVICE.sg, lap: 0 })
  assert.equal(ghost.dist.length, OTHER_LINE.totalM + 1, 'every sample kept')
  assert.ok(Math.abs(ghost.dist.at(-1) - 1000) < 0.5, `ends at ${ghost.dist.at(-1)}`)
  for (const t of [255, 510, 800]) {
    assert.ok(Math.abs(ghost.dist[t] - OTHER_LINE.toCourse(t)) < 1.5, `their ${t} m → ${ghost.dist[t]} vs ${OTHER_LINE.toCourse(t)}`)
  }
  // Seen from their own session, the same lap keeps its own metres.
  const own = await rpc('replay:lap', DEVICE.sg, { sessionGuid: DEVICE.sg, lap: 0 })
  assert.equal(own.dist[510], 510)

  await assert.rejects(rpc('replay:lap', SCENE.sg, { sessionGuid: ELSEWHERE.sg, lap: 0 }), /another track layout/)
  await assert.rejects(rpc('replay:lap', SCENE.sg, { sessionGuid: SCENE.sg, lap: 7 }), /no telemetry/)
  await assert.rejects(rpc('replay:lap', SCENE.sg, { sessionGuid: '../x', lap: 0 }), /Invalid lap/)
  await assert.rejects(rpc('replay:scene', 'missing'), /not in your workspace/)
})

test('terrain: built once per area from USGS, polled, sampled and cached', { timeout: 120000 }, async t => {
  // Small export limits force tiling; the first elevation request fails and is retried.
  const usgs = await startFakeUsgs({ failFirst: 1, failElevation: box => box.south > 37.5 })
  t.after(() => usgs.close())
  process.env.CATALYST_USGS_ELEVATION_URL = usgs.elevationUrl
  process.env.CATALYST_USGS_IMAGERY_URL = usgs.imageryUrl
  t.after(() => { delete process.env.CATALYST_USGS_ELEVATION_URL; delete process.env.CATALYST_USGS_IMAGERY_URL })
  const { call, sendJson, cookie, media } = await serverFor(t, { mediaDir: true })

  const area = { south: 37.0012, west: -79.0043, north: 37.0041, east: -79.0007 }
  assert.equal((await sendJson('POST', '/api/terrain', { area })).status, 401, 'signed in only')
  assert.equal((await sendJson('POST', '/api/terrain', { area: { south: 1 } }, cookie)).status, 400)
  assert.equal((await sendJson('POST', '/api/terrain', { area: { south: 37, west: -79.5, north: 37.2, east: -79 } }, cookie)).status, 400, 'too large')

  // 202 while it builds, then the terrain.
  const first = await sendJson('POST', '/api/terrain', { area }, cookie)
  assert.equal(first.status, 202)
  let terrain
  for (let i = 0; i < 200 && !terrain; i++) {
    const reply = await sendJson('POST', '/api/terrain', { area }, cookie)
    if (reply.status === 200) terrain = (await reply.json()).terrain
    else { assert.equal(reply.status, 202, (await reply.json()).error); await new Promise(r => setTimeout(r, 50)) }
  }
  assert.ok(terrain, 'the terrain was built')
  assert.equal(terrain.key, 't1_p37.000_m79.005_p37.005_m79.000')
  assert.deepEqual(terrain.area, { south: 37, west: -79.005, north: 37.005, east: -79 })
  assert.equal(terrain.grid.height, 1400, 'the long side')
  assert.ok(terrain.grid.width > 1100 && terrain.grid.width < 1400, `${terrain.grid.width} (narrower east–west)`)
  assert.deepEqual(terrain.imagery, { width: 400, height: 400 })
  assert.match(terrain.attribution, /3DEP.*NAIP/)
  const exports = usgs.requests.filter(r => r.includes('/elevation/ImageServer/exportImage'))
  assert.equal(exports.length, 5, '2 × 2 tiles of at most 300 px, one tried twice')
  assert.ok(fs.existsSync(path.join(media, 'shared', 'terrain', terrain.key, 'terrain.json')), 'kept with the media')
  assert.deepEqual(fs.readdirSync(path.join(media, 'shared', 'terrain')).filter(n => n.startsWith('.') && n !== '.partial'), [], 'no temporary folders left')

  // The mesh: vertex (i, j) at the area's edges and between, as documented.
  const gridReply = await call(`/api/terrain/${terrain.key}/grid`, {}, cookie)
  assert.equal(gridReply.status, 200)
  assert.match(gridReply.headers.get('cache-control'), /immutable/)
  const grid = decodeGrid(new Uint8Array(await gridReply.arrayBuffer()))
  assert.deepEqual([grid.width, grid.height], [terrain.grid.width, terrain.grid.height])
  const { south, west, north, east } = terrain.area
  const step = (terrain.grid.maxM - terrain.grid.minM) / 65534
  for (const [i, j] of [[0, 0], [grid.width - 1, 0], [0, grid.height - 1], [grid.width - 1, grid.height - 1], [517, 803]]) {
    const expected = heightAt(north - j * (north - south) / (grid.height - 1), west + i * (east - west) / (grid.width - 1))
    assert.ok(Math.abs(grid.data[j * grid.width + i] - expected) <= step + 1e-3, `vertex ${i},${j}: ${grid.data[j * grid.width + i]} vs ${expected}`)
  }
  assert.ok(Math.abs(terrain.grid.minM - heightAt(south, west)) < 0.01 && Math.abs(terrain.grid.maxM - heightAt(north, east)) < 0.01)
  // A client without gzip gets the same bytes.
  const plain = await new Promise((resolve, reject) => http.get(`${new URL(gridReply.url).origin}/api/terrain/${terrain.key}/grid`, { headers: { cookie } }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
  }).on('error', reject))
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.deepEqual(decodeGrid(plain.body).data, grid.data)

  const image = await call(`/api/terrain/${terrain.key}/image.jpg`, {}, cookie)
  assert.equal(image.headers.get('content-type'), 'image/jpeg')
  const jpeg = Buffer.from(await image.arrayBuffer())
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8])

  // Heights from the fine grid at any point; NaN outside.
  const points = new Float64Array([37.0025, -79.0025, 37.00013, -79.00491, 37.004999, -79.000001, 37.1, -79.0025, 36.9, -79])
  const sampled = await call(`/api/terrain/${terrain.key}/sample`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(points.buffer) }, cookie)
  assert.equal(sampled.status, 200)
  const heights = new Float32Array(await sampled.arrayBuffer())
  assert.equal(heights.length, 5)
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(heights[k] - heightAt(points[2 * k], points[2 * k + 1])) < 0.01, `${heights[k]} vs ${heightAt(points[2 * k], points[2 * k + 1])}`)
  assert.ok(Number.isNaN(heights[3]) && Number.isNaN(heights[4]))
  const tooMany = await call(`/api/terrain/${terrain.key}/sample`, { method: 'POST', body: Buffer.alloc(16 * 250001) }, cookie)
  assert.equal(tooMany.status, 413)
  assert.equal((await call('/api/terrain/t1_p10.000_m10.000_p10.005_m9.995/grid', {}, cookie)).status, 404)

  // Built once: asking again (and from a new process) downloads nothing.
  const before = usgs.requests.length
  const again = await sendJson('POST', '/api/terrain', { area: { ...area, north: 37.0049 } }, cookie)
  assert.equal(again.status, 200, 'the same rounded area')
  assert.equal((await again.json()).terrain.key, terrain.key)
  const fresh = new TerrainService(path.join(media, 'shared', 'terrain'), { log: () => {} })
  assert.equal(fresh.status(area).state, 'ready')
  assert.equal(usgs.requests.length, before)

  // A failure is reported, not retried at once, then retried on a later request.
  const failing = { south: 37.6, west: -79.004, north: 37.604, east: -79.001 }
  assert.equal((await sendJson('POST', '/api/terrain', { area: failing }, cookie)).status, 202)
  let failed
  for (let i = 0; i < 200 && !failed; i++) {
    const reply = await sendJson('POST', '/api/terrain', { area: failing }, cookie)
    if (reply.status === 502) failed = (await reply.json()).error
    else await new Promise(r => setTimeout(r, 20))
  }
  assert.match(failed, /USGS answered 500.*tried 4 times/)
  const count = usgs.requests.length
  assert.equal((await sendJson('POST', '/api/terrain', { area: failing }, cookie)).status, 502, 'still failed')
  assert.equal(usgs.requests.length, count, 'USGS is not asked again straight away')
  await new Promise(r => setTimeout(r, 450))
  assert.equal((await sendJson('POST', '/api/terrain', { area: failing }, cookie)).status, 202, 'retried later')
})

test('terrain: the TIFF reader takes strips and tiles and refuses what it cannot read', () => {
  const { floatTiff } = require('./fixtures/terrainFixture.cjs')
  const values = Float32Array.from({ length: 300 * 200 }, (_, i) => i / 7)
  for (const tile of [0, 128]) {
    const raster = readFloatTiff(floatTiff(300, 200, values, { x0: -79, y0: 37, sx: 1e-5, sy: 1e-5 }, tile))
    assert.deepEqual([raster.width, raster.height], [300, 200])
    assert.deepEqual(raster.data, values)
    assert.deepEqual(raster.georef, { x0: -79, y0: 37, sx: 1e-5, sy: 1e-5, pixelIsArea: true })
  }
  const compressed = floatTiff(4, 4, new Float32Array(16), { x0: 0, y0: 0, sx: 1, sy: 1 })
  // Compression (259) → 5 (LZW).
  for (let at = 10; at < 200; at += 12) if (compressed.readUInt16LE(at) === 259) compressed.writeUInt16LE(5, at + 8)
  assert.throws(() => readFloatTiff(compressed), /compression 5/)
  assert.throws(() => readFloatTiff(Buffer.from('<html>504 Gateway Time-out</html>')), /not a TIFF/)
})

test('car models: a shared library of .glb files', { timeout: 120000 }, async t => {
  const exige = glbFile({
    author: 'Ddiaz Design (https://sketchfab.com/ddiaz-design)',
    license: 'CC-BY-NC-SA-4.0 (http://creativecommons.org/licenses/by-nc-sa/4.0/)',
    source: 'https://sketchfab.com/3d-models/2006-lotus-exige-s-13d071ac1288486b990be3ef818d8181',
    title: '2006 Lotus Exige S',
  })
  const corvette = glbFile({ title: '2020 Chevrolet Corvette C8 Stingray 3LT Z51', author: 'Someone', license: 'CC-BY-4.0' })
  const { call, sendJson, cookie, modelsDir } = await serverFor(t, {
    models: [['2020_chevrolet_corvette_c8.glb', corvette], ['broken.glb', Buffer.from('not a model')]],
  })
  const list = async () => {
    const reply = await call('/api/car-models', {}, cookie)
    assert.equal(reply.status, 200)
    return (await reply.json()).models
  }
  assert.equal((await call('/api/car-models')).status, 401, 'signed in only')

  // Copied into the folder by hand: registered from its own credits.
  let models = await list()
  assert.equal(models.length, 1, 'the broken file is not registered')
  const dropped = models[0]
  assert.equal(dropped.id, '2020_chevrolet_corvette_c8')
  assert.equal(dropped.name, '2020 Chevrolet Corvette C8 Stingray 3LT Z51')
  assert.equal(dropped.attribution, '“2020 Chevrolet Corvette C8 Stingray 3LT Z51” by Someone (CC-BY-4.0)')
  assert.deepEqual(dropped.matches, ['CHEVROLET CORVETTE'])
  assert.deepEqual(dropped.fit, CAR_PRESETS['CHEVROLET CORVETTE'].fit)
  assert.equal(dropped.sizeBytes, corvette.length)
  assert.ok(fs.existsSync(path.join(modelsDir, '2020_chevrolet_corvette_c8.glb')), 'left where it was')
  assert.deepEqual(Buffer.from(await (await call(`/api/car-models/${dropped.id}.glb`, {}, cookie)).arrayBuffer()), corvette)

  // Uploaded in chunks like a video; the credits fill in what was left empty.
  const upload = async (bytes, meta, fileName = 'exige.glb') => {
    const start = await sendJson('POST', '/api/car-models/uploads', { fileName, size: bytes.length, ...meta }, cookie)
    const { uploadId, chunkSize, error } = await start.json()
    if (start.status !== 200) return { status: start.status, error }
    assert.equal(chunkSize, 32 * 1024 ** 2)
    const half = Math.ceil(bytes.length / 2)
    for (const offset of [0, half]) {
      const reply = await call(`/api/car-models/uploads/${uploadId}?offset=${offset}`, { method: 'PUT', body: bytes.subarray(offset, offset + half) }, cookie)
      assert.equal(reply.status, 200)
    }
    const finish = await sendJson('POST', `/api/car-models/uploads/${uploadId}/finish`, {}, cookie)
    return { status: finish.status, ...(await finish.json()) }
  }
  const uploaded = await upload(exige, { name: '', attribution: null, matches: ['lotus exige'] })
  assert.equal(uploaded.status, 200, uploaded.error)
  const model = uploaded.model
  assert.match(model.id, /^[0-9a-f-]{36}$/)
  assert.equal(model.name, '2006 Lotus Exige S')
  assert.equal(model.fileName, 'exige.glb')
  assert.equal(model.attribution, '“2006 Lotus Exige S” by Ddiaz Design (CC-BY-NC-SA-4.0) · https://sketchfab.com/3d-models/2006-lotus-exige-s-13d071ac1288486b990be3ef818d8181')
  assert.deepEqual(model.matches, ['LOTUS EXIGE'])
  assert.deepEqual(model.fit, CAR_PRESETS['LOTUS EXIGE'].fit, 'the vehicle’s preset')
  const served = await call(`/api/car-models/${model.id}.glb`, {}, cookie)
  assert.equal(served.headers.get('content-type'), 'model/gltf-binary')
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), exige)
  const named = await upload(exige, { name: 'My Exige', attribution: 'Mine', matches: [] })
  assert.deepEqual([named.model.name, named.model.attribution, named.model.matches], ['My Exige', 'Mine', []])
  assert.equal((await list()).length, 3)

  // Shared: another driver sees and may edit the same library.
  const mitch = (await sendJson('POST', '/api/login', { username: 'Mitch' })).headers.get('set-cookie').split(';')[0]
  assert.equal((await (await call('/api/car-models', {}, mitch)).json()).models.length, 3)

  // Patch name, credit, vehicles and fit; bad values are refused.
  const fit = { yawDeg: 180, lengthM: 3.9, offsetM: [0, 0.02, 0.1], eyeM: [0.3, 1.0, -0.1] }
  const patched = await sendJson('PATCH', `/api/car-models/${model.id}`, { name: 'Exige S', attribution: null, matches: ['LOTUS EXIGE', 'LOTUS ELISE'], fit }, mitch)
  assert.equal(patched.status, 200)
  assert.deepEqual((await patched.json()).model, { ...model, name: 'Exige S', attribution: null, matches: ['LOTUS EXIGE', 'LOTUS ELISE'], fit })
  assert.equal((await sendJson('PATCH', `/api/car-models/${model.id}`, { fit: { ...fit, lengthM: -1 } }, cookie)).status, 400)
  assert.equal((await sendJson('PATCH', '/api/car-models/missing', { name: 'x' }, cookie)).status, 404)
  const stored = JSON.parse(fs.readFileSync(path.join(modelsDir, 'models.json'), 'utf8'))
  assert.deepEqual(stored.models.find(m => m.id === model.id).fit, fit, 'saved')

  // The Garmin camera's mount, lens and tilt are optional parts of the fit.
  const dashcam = { ...fit, dashcamM: [0, 1.05, 0.12], dashcamFovDeg: 118, dashcamPitchDeg: 4.5 }
  const withCamera = await sendJson('PATCH', `/api/car-models/${model.id}`, { fit: dashcam }, cookie)
  assert.equal(withCamera.status, 200)
  assert.deepEqual((await withCamera.json()).model.fit, dashcam)
  const restored = JSON.parse(fs.readFileSync(path.join(modelsDir, 'models.json'), 'utf8'))
  assert.deepEqual(restored.models.find(m => m.id === model.id).fit, dashcam, 'camera saved')
  for (const bad of [{ dashcamM: [0, 1] }, { dashcamFovDeg: 400 }, { dashcamFovDeg: 10 }, { dashcamPitchDeg: 'down' }]) {
    assert.equal((await sendJson('PATCH', `/api/car-models/${model.id}`, { fit: { ...fit, ...bad } }, cookie)).status, 400, JSON.stringify(bad))
  }

  // Only glTF 2 binaries, and nothing too large.
  const bad = await upload(Buffer.from('definitely not a glb file'), { name: 'x' })
  assert.equal(bad.status, 400)
  assert.match(bad.error, /not a glTF 2 binary/)
  assert.deepEqual(fs.readdirSync(path.join(modelsDir, '.incoming')), [], 'nothing kept')
  assert.equal((await upload(exige, { name: 'x' }, 'exige.obj')).status, 400)
  assert.equal((await upload({ length: MAX_CAR_MODEL_BYTES + 1 }, { name: 'x' })).status, 400)

  // Copied in while the server runs: registered on the next listing.
  fs.writeFileSync(path.join(modelsDir, 'Exige Track.glb'), glbFile(null))
  const late = (await list()).find(m => m.fileName === 'Exige Track.glb')
  assert.equal(late.id, 'Exige-Track')
  assert.equal(late.name, 'Exige Track')
  assert.equal(late.attribution, null)
  assert.deepEqual(late.matches, ['LOTUS EXIGE'], 'guessed from the name')

  // Delete: gone from the list and the folder.
  assert.equal((await call(`/api/car-models/${model.id}`, { method: 'DELETE' }, cookie)).status, 200)
  assert.equal((await call(`/api/car-models/${model.id}.glb`, {}, cookie)).status, 404)
  assert.ok(!fs.existsSync(path.join(modelsDir, `${model.id}.glb`)))
  assert.equal((await call(`/api/car-models/${dropped.id}`, { method: 'DELETE' }, cookie)).status, 200)
  assert.deepEqual((await list()).map(m => m.name).sort(), ['Exige Track', 'My Exige'])
})
