// A stand-in for the USGS elevation and imagery services: exportImage
// answers with a float32 GeoTIFF of a known surface (heights are linear in
// lat/lon, so bilinear resampling reproduces them exactly) and a small JPEG
// header of the asked size. Also writes tiny .glb files for car-model tests.

const http = require('node:http')

// The ground: rises north and east (metres).
const heightAt = (lat, lon) => 100 + 2000 * (lat - 37) + 1000 * (lon + 79)

// An uncompressed little-endian float32 GeoTIFF (WGS84, pixel is area), in
// strips or in `tile` × `tile` tiles like USGS's own exports.
function floatTiff(width, height, values, place, tile = 0) {
  const blocks = []
  if (tile) {
    for (let ty = 0; ty < Math.ceil(height / tile); ty++) for (let tx = 0; tx < Math.ceil(width / tile); tx++) {
      const block = Buffer.alloc(tile * tile * 4)
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
        const row = ty * tile + y, col = tx * tile + x
        if (row < height && col < width) block.writeFloatLE(values[row * width + col], (y * tile + x) * 4)
      }
      blocks.push(block)
    }
  } else {
    const block = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) block.writeFloatLE(values[i], i * 4)
    blocks.push(block)
  }
  const entries = [
    [256, 4, [width]], [257, 4, [height]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]], [277, 3, [1]], [339, 3, [3]],
    ...(tile
      ? [[322, 3, [tile]], [323, 3, [tile]], [324, 4, blocks.map(() => 0)], [325, 4, blocks.map(b => b.length)]]
      : [[273, 4, [0]], [278, 4, [height]], [279, 4, [blocks[0].length]]]),
    [33550, 12, [place.sx, place.sy, 0]], [33922, 12, [0, 0, 0, place.x0, place.y0, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
  ].sort((a, b) => a[0] - b[0])
  const size = { 3: 2, 4: 4, 12: 8 }
  const ifdAt = 8, ifdSize = 2 + entries.length * 12 + 4
  let at = ifdAt + ifdSize
  const extras = entries.map(([, type, vals]) => {
    const bytes = size[type] * vals.length
    if (bytes <= 4) return -1
    const here = at
    at += bytes
    return here
  })
  const blockAt = []
  for (const block of blocks) { blockAt.push(at); at += block.length }
  const out = Buffer.alloc(at)
  out.write('II', 0, 'latin1'); out.writeUInt16LE(42, 2); out.writeUInt32LE(ifdAt, 4)
  out.writeUInt16LE(entries.length, ifdAt)
  const put = (type, offset, vals) => vals.forEach((v, i) => {
    if (type === 3) out.writeUInt16LE(v, offset + i * 2)
    else if (type === 4) out.writeUInt32LE(v, offset + i * 4)
    else out.writeDoubleLE(v, offset + i * 8)
  })
  entries.forEach(([tag, type, vals], i) => {
    const entry = ifdAt + 2 + i * 12
    const values = tag === 273 || tag === 324 ? blockAt : vals
    out.writeUInt16LE(tag, entry); out.writeUInt16LE(type, entry + 2); out.writeUInt32LE(values.length, entry + 4)
    if (extras[i] < 0) put(type, entry + 8, values)
    else { out.writeUInt32LE(extras[i], entry + 8); put(type, extras[i], values) }
  })
  blocks.forEach((block, i) => block.copy(out, blockAt[i]))
  return out
}

// SOI, a JFIF header, a baseline frame header of the asked size, EOI: enough
// for anything that reads a JPEG's size.
function jpegOfSize(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

// The fake services. `failElevation(box)` makes an export fail with 500.
function startFakeUsgs({ elevationLimit = 300, imageryLimit = 400, tile = 128, failElevation = () => false, failFirst = 0 } = {}) {
  const requests = []
  let failures = failFirst
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push(url.pathname + url.search)
    const service = url.pathname.startsWith('/elevation/') ? 'elevation' : url.pathname.startsWith('/imagery/') ? 'imagery' : null
    if (!service) { res.writeHead(404); res.end(); return }
    if (url.pathname.endsWith('/ImageServer') && url.searchParams.get('f') === 'pjson') {
      const limit = service === 'elevation' ? elevationLimit : imageryLimit
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ maxImageWidth: limit, maxImageHeight: limit }))
      return
    }
    if (!url.pathname.endsWith('/exportImage')) { res.writeHead(404); res.end(); return }
    const [west, south, east, north] = url.searchParams.get('bbox').split(',').map(Number)
    const [width, height] = url.searchParams.get('size').split(',').map(Number)
    if (service === 'imagery') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      res.end(jpegOfSize(width, height))
      return
    }
    if (failures > 0 || failElevation({ west, south, east, north })) {
      failures--
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end('<html>Error</html>')
      return
    }
    const sx = (east - west) / width, sy = (north - south) / height
    const values = new Float32Array(width * height)
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      values[j * width + i] = heightAt(north - (j + 0.5) * sy, west + (i + 0.5) * sx)
    }
    res.writeHead(200, { 'Content-Type': 'image/tiff' })
    res.end(floatTiff(width, height, values, { x0: west, y0: north, sx, sy }, (requests.length % 2) ? tile : 0))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`
    resolve({
      requests, server,
      elevationUrl: `${base}/elevation/ImageServer`,
      imageryUrl: `${base}/imagery/ImageServer`,
      close: () => new Promise(done => server.close(done)),
    })
  }))
}

// A glTF 2 binary: the JSON chunk (with Sketchfab-style asset.extras when
// given) and a small BIN chunk.
function glbFile(extras) {
  const pad = (buf, fill) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)])
  const json = pad(Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'catalyst test', ...(extras ? { extras } : {}) },
    scenes: [{ nodes: [] }], scene: 0,
  })), 0x20)
  const bin = pad(Buffer.from([1, 2, 3, 4, 5, 6]), 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]) }
  const body = Buffer.concat([chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)])
  header.writeUInt32LE(12 + body.length, 8)
  return Buffer.concat([header, body])
}

module.exports = { heightAt, floatTiff, jpegOfSize, startFakeUsgs, glbFile }
