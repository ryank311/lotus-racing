const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync } = require('node:zlib')
const { test } = require('node:test')
const { startCatalystServer } = require('../dist-main/main/server.js')

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-assets-'))
  const staticDir = path.join(root, 'renderer')
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>app</html>')
  const script = Buffer.from('export const message = "hello";\n'.repeat(100))
  const style = Buffer.from('body { color: red }\n'.repeat(100))
  for (const [name, body] of [['page-AbCd1234.js', script], ['style-AbCd1234.css', style]]) {
    const file = path.join(staticDir, 'assets', name)
    fs.writeFileSync(file, body)
    fs.writeFileSync(file + '.gz', gzipSync(body))
    fs.writeFileSync(file + '.br', brotliCompressSync(body))
  }
  fs.writeFileSync(path.join(staticDir, 'plain.js'), script)
  const server = await startCatalystServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), staticDir })
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const request = (url, acceptEncoding, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(server.url + url, {
      method, headers: acceptEncoding === undefined ? {} : { 'Accept-Encoding': acceptEncoding },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
  return { request, script, style, staticDir }
}

test('static assets negotiate compression and quality values without changing content', async t => {
  const { request, script } = await fixture(t)
  for (const [header, encoding] of [
    ['gzip, br', 'br'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0.4, gzip;q=0.8, identity;q=0.1', 'gzip'],
    ['br;q=0.5, identity;q=1', undefined],
    ['*;q=1', 'br'],
    ['br;q=0, *;q=1', 'gzip'],
    ['BR; Q=1, gzip;q=0', 'br'],
    [undefined, undefined],
    ['', undefined],
    ['identity', undefined],
    ['br;q=invalid, gzip;q=0', undefined],
  ]) {
    const response = await request('/assets/page-AbCd1234.js', header)
    assert.equal(response.status, 200, header)
    assert.equal(response.headers['content-encoding'], encoding, header)
    assert.equal(response.headers.vary, 'Accept-Encoding')
    assert.equal(+response.headers['content-length'], response.body.length)
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
    const decoded = encoding === 'br' ? brotliDecompressSync(response.body) : encoding === 'gzip' ? gunzipSync(response.body) : response.body
    assert.deepEqual(decoded, script)
  }
})

test('static assets fall back when compressed siblings are unavailable, or return 406', async t => {
  const { request, script, staticDir } = await fixture(t)
  fs.unlinkSync(path.join(staticDir, 'assets/page-AbCd1234.js.br'))
  const gzip = await request('/assets/page-AbCd1234.js', 'br, gzip')
  assert.equal(gzip.headers['content-encoding'], 'gzip')
  const plain = await request('/plain.js', 'br, gzip')
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.deepEqual(plain.body, script)
  for (const header of ['*;q=0', 'br, identity;q=0']) {
    const response = await request('/plain.js', header)
    assert.equal(response.status, 406)
    assert.equal(response.headers.vary, 'Accept-Encoding')
  }
  assert.equal((await request('/plain.js', '*;q=0, identity;q=1')).status, 200)
})

test('HEAD matches GET metadata for compressed and identity assets without sending a body', async t => {
  const { request, style } = await fixture(t)
  for (const header of ['br', 'gzip', 'identity']) {
    const get = await request('/assets/style-AbCd1234.css', header)
    const head = await request('/assets/style-AbCd1234.css', header, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'vary']) {
      assert.equal(head.headers[name], get.headers[name])
    }
    assert.equal(head.headers['content-type'], 'text/css; charset=utf-8')
    if (header === 'identity') assert.deepEqual(get.body, style)
  }
})

test('hashed assets are immutable; HTML and navigation fallbacks revalidate', async t => {
  const { request } = await fixture(t)
  assert.equal((await request('/assets/page-AbCd1234.js')).headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal((await request('/plain.js')).headers['cache-control'], 'public, max-age=3600')
  for (const url of ['/', '/index.html', '/analysis', '/nested/route']) {
    const response = await request(url, 'br, gzip')
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-cache')
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(response.body.toString(), '<html>app</html>')
  }
})

test('missing assets and unknown API endpoints never return the HTML app shell', async t => {
  const { request } = await fixture(t)
  for (const url of ['/assets/old-AbCd1234.js', '/missing.css', '/assets/missing', '/api/unknown', '/assets/%2e%2e%2f%2e%2e%2fsecret']) {
    const response = await request(url)
    assert.equal(response.status, 404, url)
    assert.equal(response.body.toString(), 'Not found')
    assert.equal((await request(url, 'br', 'HEAD')).body.length, 0)
  }
  const health = await request('/api/health', 'br, gzip')
  assert.equal(health.status, 200)
  assert.equal(health.headers['content-encoding'], undefined)
  assert.equal(JSON.parse(health.body).ok, true)
})
