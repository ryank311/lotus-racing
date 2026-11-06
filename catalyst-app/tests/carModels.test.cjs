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
const { freshSidecar, precompressedSidecar } = require('../dist-main/main/staticAssets.js')

const IMMUTABLE = 'private, max-age=31536000, immutable'

/** Writes <file>.br and <file>.gz as scripts/compress-models.mjs does (same mtime as the file, or `at`). */
function writeSidecars(file, at = fs.statSync(file).mtime) {
  const bytes = fs.readFileSync(file)
  fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(bytes))
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(bytes))
  for (const sidecar of [`${file}.br`, `${file}.gz`]) fs.utimesSync(sidecar, at, at)
}

test('model sidecars: chosen by Accept-Encoding, only while current', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-sidecars-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'model.glb')
  fs.writeFileSync(file, glbFile({ title: 'y'.repeat(50_000) }))
  assert.equal(precompressedSidecar(file, 'gzip, deflate, br'), null, 'none written')
  writeSidecars(file)
  const pick = accept => precompressedSidecar(file, accept)?.encoding ?? null
  assert.equal(pick('gzip, deflate, br'), 'br', 'brotli first')
  assert.equal(pick('br;q=0.5, gzip'), 'gzip', 'unless the client prefers gzip')
  assert.equal(pick('gzip'), 'gzip')
  assert.equal(pick('br'), 'br')
  assert.equal(pick('identity'), null)
  assert.equal(pick('gzip;q=0, br;q=0'), null)
  assert.equal(pick(undefined), null)
  assert.equal(pick('*'), 'br')
  assert.equal(precompressedSidecar(file, 'br').size, fs.statSync(`${file}.br`).size)

  // Older than the file: stale.
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(file, later, later)
  assert.equal(pick('gzip, br'), null)
  writeSidecars(file)
  assert.equal(pick('gzip, br'), 'br')
  // A different file put back with an old mtime: the .gz no longer records its length, so neither is served.
  const old = new Date(Date.now() - 86_400_000)
  fs.writeFileSync(file, glbFile({ title: 'the original' }))
  fs.utimesSync(file, old, old)
  assert.equal(freshSidecar(file, 'gzip'), null)
  assert.equal(pick('gzip, br'), null)
  // Without a .gz, a current .br stands alone.
  fs.rmSync(`${file}.gz`)
  fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(fs.readFileSync(file)))
  assert.equal(pick('gzip, br'), 'br')
  assert.equal(pick('gzip'), null)
})

test('car models: versioned URLs, ETags and precompressed sidecars', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-cars-'))
  const dataDir = path.join(root, 'server'), media = path.join(root, 'media')
  const dir = userDirectory(dataDir, 'Ryan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ username: 'Ryan' }))
  const modelsDir = path.join(media, 'shared', 'car-models')
  fs.mkdirSync(modelsDir, { recursive: true })
  const file = path.join(modelsDir, 'exige.glb')
  const glb = glbFile({ title: '2006 Lotus Exige S', author: 'Someone', license: 'CC-BY-4.0', note: 'x'.repeat(200_000) })
  fs.writeFileSync(file, glb)

  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir, mediaDir: media, templateRoot: root })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const raw = (endpoint, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(server.url + endpoint, { method, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
  const login = await fetch(server.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Ryan' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const listing = async () => JSON.parse((await raw('/api/car-models', { cookie })).body).models
  assert.equal((await raw('/api/car-models/exige.glb')).status, 401, 'signed in only')

  // The listing carries each file's version (and its size now).
  let [model] = await listing()
  assert.equal(model.id, 'exige')
  assert.match(model.version, /^[0-9a-f]{12}$/)
  assert.equal(model.sizeBytes, glb.length)
  const url = `/api/car-models/exige.glb?v=${model.version}`

  // No sidecars: the file as it is (never compressed by the server), with ranges.
  const plain = await raw(url, { cookie, 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(plain.status, 200)
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.equal(plain.headers['content-type'], 'model/gltf-binary')
  assert.equal(plain.headers['cache-control'], IMMUTABLE)
  assert.equal(plain.headers.etag, `"${model.version}"`)
  assert.equal(plain.headers.vary, 'Accept-Encoding')
  assert.equal(plain.headers['accept-ranges'], 'bytes')
  assert.deepEqual(plain.body, glb)
  assert.equal((await raw('/api/car-models/exige.glb', { cookie })).headers['cache-control'], 'private, no-cache', 'unversioned: revalidated')
  assert.equal((await raw('/api/car-models/exige.glb?v=old', { cookie })).headers['cache-control'], 'private, no-cache')
  assert.ok(!fs.existsSync(`${file}.gz`) && !fs.existsSync(path.join(modelsDir, '.cache')), 'nothing compressed at runtime')
  const range = await raw(url, { cookie, range: 'bytes=0-9' })
  assert.equal(range.status, 206)
  assert.deepEqual(range.body, glb.subarray(0, 10))

  // Revalidation: the version's ETag, strong, weak or in a list.
  for (const tag of [`"${model.version}"`, `W/"${model.version}"`, `"nope", "${model.version}"`, '*']) {
    const reply = await raw('/api/car-models/exige.glb', { cookie, 'if-none-match': tag })
    assert.equal(reply.status, 304, tag)
    assert.equal(reply.body.length, 0)
  }
  assert.equal((await raw('/api/car-models/exige.glb', { cookie, 'if-none-match': '"nope"' })).status, 200)

  // Precompressed copies beside it: brotli first, then gzip, else the file.
  writeSidecars(file)
  const br = await raw(url, { cookie, 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(br.headers['content-encoding'], 'br')
  assert.equal(br.headers['content-type'], 'model/gltf-binary')
  assert.equal(br.headers['cache-control'], IMMUTABLE)
  assert.equal(br.headers.vary, 'Accept-Encoding')
  assert.equal(Number(br.headers['content-length']), fs.statSync(`${file}.br`).size)
  assert.ok(br.body.length < glb.length / 10)
  assert.deepEqual(zlib.brotliDecompressSync(br.body), glb)
  const gz = await raw(url, { cookie, 'accept-encoding': 'gzip, deflate' })
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.deepEqual(gz.body, fs.readFileSync(`${file}.gz`))
  assert.deepEqual(zlib.gunzipSync(gz.body), glb)
  assert.equal((await raw(url, { cookie, 'accept-encoding': 'identity' })).headers['content-encoding'], undefined)
  const head = await raw(url, { cookie, 'accept-encoding': 'br' }, 'HEAD')
  assert.equal(head.headers['content-encoding'], 'br')
  assert.equal(Number(head.headers['content-length']), fs.statSync(`${file}.br`).size)
  assert.equal(head.body.length, 0)
  // A range is of the file itself, sidecars or not.
  const ranged = await raw(url, { cookie, range: 'bytes=10-19', 'accept-encoding': 'br' })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers['content-encoding'], undefined)
  assert.deepEqual(ranged.body, glb.subarray(10, 20))
  // fetch() decodes it like a browser.
  const fetched = await fetch(server.url + url, { headers: { cookie } })
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), glb)

  // Replaced: a new version, and the old sidecars are stale (the file goes as it is).
  const newer = glbFile({ title: '2006 Lotus Exige S', note: 'z'.repeat(100_000) })
  fs.writeFileSync(file, newer)
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(file, later, later)
  ;[model] = await listing()
  assert.notEqual(`/api/car-models/exige.glb?v=${model.version}`, url)
  assert.equal(model.sizeBytes, newer.length)
  const stale = await raw(`/api/car-models/exige.glb?v=${model.version}`, { cookie, 'accept-encoding': 'gzip, br' })
  assert.equal(stale.headers['content-encoding'], undefined)
  assert.equal(stale.headers['cache-control'], IMMUTABLE)
  assert.deepEqual(stale.body, newer)
  assert.equal((await raw(url, { cookie })).headers['cache-control'], 'private, no-cache', 'the old version is no longer immutable')
  // Compressed again: served again.
  writeSidecars(file)
  const fresh = await raw(`/api/car-models/exige.glb?v=${model.version}`, { cookie, 'accept-encoding': 'gzip, br' })
  assert.equal(fresh.headers['content-encoding'], 'br')
  assert.deepEqual(zlib.brotliDecompressSync(fresh.body), newer)

  // The sidecars are not models of their own.
  assert.deepEqual((await listing()).map(m => m.id), ['exige'])
  assert.equal((await raw('/api/car-models/missing.glb', { cookie })).status, 404)
})
