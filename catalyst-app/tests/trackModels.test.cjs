const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { test } = require('node:test')
const childProcess = require('node:child_process')
const { userDirectory } = require('../dist-main/main/serverStorage.js')
const { glbFile } = require('./fixtures/terrainFixture.cjs')

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
const { TrackModelLibrary } = require('../dist-main/garmin/trackModels.js')
const { trackModelFor } = require('../dist-main/shared/replay.js')

const GEOREF = { originLat: 36.56196, originLon: -79.20697, rotationDeg: -1.1, scale: 1.0027, offsetM: [-60.8, -3.5, 161.7], flips: { x: false, z: false } }
// A 1×1 PNG, enough for a footprint file.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010800000000376ef9240000000a49444154789c636000000002000154a24f5d0000000049454e44ae426082', 'hex')

function manifest(extra = {}) {
  return {
    name: 'Test Raceway (sim)', trackName: 'Test Raceway', attribution: 'Track by Someone',
    layouts: { 'Full Course': { files: ['base.glb', 'full.glb'] }, 'Short Course': { files: ['base.glb'] } },
    georef: GEOREF,
    footprint: { file: 'footprint.png', x0: -10, z0: -10, cellM: 4, width: 1, height: 1 },
    ...extra,
  }
}

function writeModel(dir, { json = manifest(), files = { 'base.glb': glbFile({ title: 'base' }), 'full.glb': glbFile({ title: 'full' }), 'footprint.png': PNG } } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes)
  fs.writeFileSync(path.join(dir, 'track.json'), typeof json === 'string' ? json : JSON.stringify(json))
}

test('track models: folders copied in by hand are checked and registered', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-tracks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const logs = []
  const library = new TrackModelLibrary(root, message => logs.push(message))
  assert.deepEqual(await library.list(), [], 'an empty folder')

  writeModel(path.join(root, 'test-raceway'))
  // Broken folders: a layout file that is missing, and a .glb that is not one.
  writeModel(path.join(root, 'missing-file'), { files: { 'base.glb': glbFile() } })
  writeModel(path.join(root, 'not-glb'), { files: { 'base.glb': Buffer.from('not a model'), 'full.glb': glbFile(), 'footprint.png': PNG } })
  writeModel(path.join(root, 'bad-georef'), { json: manifest({ georef: { ...GEOREF, scale: 10 } }) })
  writeModel(path.join(root, 'bad-json'), { json: '{ nope' })
  fs.mkdirSync(path.join(root, 'no-manifest'))

  const models = await library.list()
  assert.deepEqual(models.map(m => m.id), ['test-raceway'])
  const [model] = models
  assert.equal(model.name, 'Test Raceway (sim)')
  assert.equal(model.trackName, 'Test Raceway')
  assert.equal(model.attribution, 'Track by Someone')
  assert.deepEqual(model.layouts, { 'Full Course': { files: ['base.glb', 'full.glb'] }, 'Short Course': { files: ['base.glb'] } })
  assert.deepEqual(model.georef, GEOREF)
  assert.deepEqual(model.footprint, { file: 'footprint.png', x0: -10, z0: -10, cellM: 4, width: 1, height: 1 })
  assert.deepEqual(model.files.map(f => f.name), ['base.glb', 'footprint.png', 'full.glb'])
  assert.equal(model.sizeBytes, model.files.reduce((a, f) => a + f.sizeBytes, 0))
  assert.ok(logs.some(l => /registered test-raceway/.test(l)))
  for (const [id, why] of [['missing-file', /(footprint\.png|full\.glb) is missing/], ['not-glb', /base\.glb is not a glTF 2 binary/], ['bad-georef', /scale/], ['bad-json', /not valid JSON/]]) {
    assert.ok(logs.some(l => l.includes(`${id} was not registered`) && why.test(l)), `${id}: ${logs.join(' / ')}`)
  }
  // A rejected folder is logged once, not on every listing.
  const before = logs.length
  await library.list()
  assert.equal(logs.length, before)

  // Fixing a folder registers it; removing one drops it.
  fs.writeFileSync(path.join(root, 'missing-file', 'full.glb'), glbFile())
  fs.writeFileSync(path.join(root, 'missing-file', 'footprint.png'), PNG)
  fs.rmSync(path.join(root, 'test-raceway'), { recursive: true })
  assert.deepEqual((await library.list()).map(m => m.id), ['missing-file'])

  // Files: only the ones track.json names, by plain name.
  assert.ok(await library.file('missing-file', 'full.glb'))
  fs.writeFileSync(path.join(root, 'missing-file', 'extra.glb'), glbFile())
  assert.equal(await library.file('missing-file', 'extra.glb'), null)
  assert.equal(await library.file('missing-file', '../missing-file/full.glb'), null)
  assert.equal(await library.file('../x', 'full.glb'), null)

  // The layout for a scene's track: names compare without case or punctuation.
  assert.equal(trackModelFor(await library.list(), { trackName: 'test raceway', configName: 'FULL COURSE' })?.layout.files.length, 2)
  assert.equal(trackModelFor(await library.list(), { trackName: 'Test Raceway', configName: 'North Course' }), null)
  assert.equal(trackModelFor(await library.list(), { trackName: 'Elsewhere', configName: 'Full Course' }), null)
})

test('track models: a layout may carry its road edges, checked', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-tracks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const logs = []
  const library = new TrackModelLibrary(root, message => logs.push(message))
  const edges = Array.from({ length: 12 }, (_, i) => [i * 3, -5.5, i * 3, 5.5])
  writeModel(path.join(root, 'with-edges'), { json: manifest({ layouts: { 'Full Course': { files: ['base.glb', 'full.glb'], edges } } }) })
  writeModel(path.join(root, 'bad-edges'), { json: manifest({ layouts: { 'Full Course': { files: ['base.glb'], edges: [[0, 1, 2]] } } }) })
  const [model] = await library.list()
  assert.equal(model.id, 'with-edges')
  assert.deepEqual(model.layouts['Full Course'], { files: ['base.glb', 'full.glb'], edges })
  assert.ok(logs.some(l => l.includes('bad-edges was not registered') && /edges must be/.test(l)), logs.join(' / '))
})

test('track models: served to signed-in drivers, gzipped, with long cache headers', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-tracks-'))
  const dataDir = path.join(root, 'server'), media = path.join(root, 'media')
  const dir = userDirectory(dataDir, 'Ryan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username: 'Ryan' }))
  // A model whose .glb compresses well, copied into the media volume's shared folder.
  const big = glbFile({ title: 'x'.repeat(200_000) })
  writeModel(path.join(media, 'shared', 'track-models', 'test-raceway'), { files: { 'base.glb': big, 'full.glb': glbFile(), 'footprint.png': PNG } })

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, mediaDir: media, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const call = (endpoint, init = {}, cookie) => fetch(server.url + endpoint, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(30000) })
  // Raw bytes (fetch would undo the gzip).
  const raw = (endpoint, headers) => new Promise((resolve, reject) => {
    http.get(server.url + endpoint, { headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
  assert.equal((await call('/api/track-models')).status, 401, 'signed in only')
  assert.equal((await call('/api/track-models/test-raceway/base.glb')).status, 401)
  const login = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Ryan' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]

  const listing = await call('/api/track-models', {}, cookie)
  assert.equal(listing.status, 200)
  const { models } = await listing.json()
  assert.deepEqual(models.map(m => m.id), ['test-raceway'])
  const version = models[0].versions['base.glb']
  assert.match(version, /^[0-9a-f]{12}$/)
  assert.deepEqual(Object.keys(models[0].versions).sort(), ['base.glb', 'footprint.png', 'full.glb'])

  // Gzipped when the client accepts it (compressed on first use), plain otherwise.
  const gz = await raw(`/api/track-models/test-raceway/base.glb?v=${version}`, { cookie, 'accept-encoding': 'gzip, deflate' })
  assert.equal(gz.status, 200)
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(gz.headers['content-type'], 'model/gltf-binary')
  assert.equal(gz.headers['cache-control'], 'private, max-age=31536000, immutable')
  assert.ok(gz.body.length < big.length / 10)
  assert.deepEqual(zlib.gunzipSync(gz.body), big)
  assert.ok(fs.readdirSync(path.join(media, 'shared', 'track-models', '.cache', 'test-raceway')).some(n => n.startsWith('base.glb.')))
  const plain = await raw('/api/track-models/test-raceway/base.glb', { cookie, 'accept-encoding': 'identity' })
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.equal(plain.headers['cache-control'], 'private, no-cache', 'without the current version the browser revalidates')
  assert.deepEqual(plain.body, big)
  // Revalidation, and the footprint image (never gzipped).
  assert.equal((await raw('/api/track-models/test-raceway/base.glb', { cookie, 'if-none-match': plain.headers.etag })).status, 304)
  const png = await raw('/api/track-models/test-raceway/footprint.png', { cookie, 'accept-encoding': 'gzip' })
  assert.equal(png.headers['content-type'], 'image/png')
  assert.equal(png.headers['content-encoding'], undefined)
  assert.deepEqual(png.body, PNG)
  // Only the files track.json names.
  fs.writeFileSync(path.join(media, 'shared', 'track-models', 'test-raceway', 'other.glb'), glbFile())
  for (const endpoint of ['/api/track-models/test-raceway/other.glb', '/api/track-models/test-raceway/track.json', '/api/track-models/test-raceway/..%2F..%2Fserver%2Fusers', '/api/track-models/nope/base.glb', '/api/track-models/test-raceway/missing.glb']) {
    assert.equal((await call(endpoint, {}, cookie)).status, 404, endpoint)
  }
  assert.equal((await call('/api/track-models/test-raceway/base.glb', { method: 'DELETE' }, cookie)).status, 405)
})
