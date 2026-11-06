// The replay's memory budget (src/renderer/replay/budget.ts): which devices
// get the constrained profile, image sizes read from file headers, and the
// size a texture is capped to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSize, imageSize, isWebKitMobile } from '../src/renderer/replay/budget'

test('iPhone and iPad browsers are WebKit: detected, an iPad asking for desktop sites too', () => {
  const ipadDesktop = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }
  const ipadMobile = { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPad', maxTouchPoints: 5 }
  const iphoneBrave = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 }
  const mac = { userAgent: ipadDesktop.userAgent, platform: 'MacIntel', maxTouchPoints: 0 }
  const android = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 }
  const windows = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 10 }
  assert.equal(isWebKitMobile(ipadDesktop), true)
  assert.equal(isWebKitMobile(ipadMobile), true)
  assert.equal(isWebKitMobile(iphoneBrave), true)
  assert.equal(isWebKitMobile(mac), false)
  assert.equal(isWebKitMobile(android), false)
  assert.equal(isWebKitMobile(windows), false)
})

test('image sizes from JPEG, PNG and WebP headers', () => {
  // PNG: signature, IHDR length and type, width, height.
  const png = new Uint8Array(32)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(png.buffer).setUint32(16, 4096)
  new DataView(png.buffer).setUint32(20, 2048)
  assert.deepEqual(imageSize(png), [4096, 2048])
  // JPEG: SOI, an APP0 segment, then SOF0 (precision, height, width).
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x9b, 0x0b, 0x6b, 0x03, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(imageSize(jpeg), [2923, 1435])
  // A progressive JPEG (SOF2) after a DHT segment.
  const progressive = new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x03, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x10, 0x00, 0x0d, 0xc2, 0x03, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(imageSize(progressive), [3522, 4096])
  // WebP: lossless (VP8L) and extended (VP8X).
  const riff = (chunk: string, body: number[]) => new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from(chunk), ...body, ...new Array(16).fill(0)])
  const w = 1024, h = 512, bits = (w - 1) | ((h - 1) << 14)
  assert.deepEqual(imageSize(riff('VP8L', [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff])), [1024, 512])
  assert.deepEqual(imageSize(riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x07, 0x00, 0xff, 0x03, 0x00])), [2048, 1024])
  assert.equal(imageSize(new Uint8Array([1, 2, 3, 4])), null)
})

test('textures are capped on their long side, keeping their shape', () => {
  assert.deepEqual(fitSize(4096, 4096, 2048), [2048, 2048])
  assert.deepEqual(fitSize(512, 2048, 1024), [256, 1024])
  assert.deepEqual(fitSize(3330, 3996, 2048), [1707, 2048])
  assert.deepEqual(fitSize(1024, 1024, 1024), [1024, 1024])
  assert.deepEqual(fitSize(300, 200, Infinity), [300, 200])
})
