// The replay's memory budget (src/renderer/replay/budget.ts): which devices
// get the constrained profile, image sizes read from file headers, the size
// a texture is capped to, a KTX2 texture capped by its mip levels, and the
// CPU copies dropped once on the GPU.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { anyReleased, capCompressedTexture, fitSize, imageSize, isWebKitMobile, mipLevelsToSkip, releaseUploaded, releaseWhenUploaded } from '../src/renderer/replay/budget'

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

/** A full mip chain from width × height down to 1 × 1, each level with its data (1 byte a pixel, as ASTC 4×4). */
function chain(width: number, height: number): Array<{ data: Uint8Array; width: number; height: number }> {
  const levels = []
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    levels.push({ data: new Uint8Array(Math.max(16, w * h)), width: w, height: h })
    if (w === 1 && h === 1) return levels
  }
}

test('a KTX2 texture is capped by leaving out its top mip levels', () => {
  const sizes = (w: number, h: number) => chain(w, h).map(({ width, height }) => ({ width, height }))
  assert.equal(mipLevelsToSkip(sizes(4096, 4096), 1024), 2)
  assert.equal(mipLevelsToSkip(sizes(4096, 2048), 1024), 2)
  assert.equal(mipLevelsToSkip(sizes(512, 2048), 1024), 1)
  assert.equal(mipLevelsToSkip(sizes(4096, 4096), 2048), 1)
  // Already within the cap, no smaller levels, or no cap: as authored.
  assert.equal(mipLevelsToSkip(sizes(1024, 1024), 1024), 0)
  assert.equal(mipLevelsToSkip([{ width: 4096, height: 4096 }], 1024), 0)
  assert.equal(mipLevelsToSkip(sizes(4096, 4096), Infinity), 0)
  // S3TC and BPTC need the largest level in whole 4×4 blocks.
  assert.equal(mipLevelsToSkip(sizes(2000, 1000), 1024, true), 1)
  assert.equal(mipLevelsToSkip(sizes(1500, 700), 1024, false), 1)
  assert.equal(mipLevelsToSkip(sizes(1500, 700), 1024, true), 0)
})

test('capCompressedTexture drops the top levels before the first upload', () => {
  const levels = chain(4096, 2048)
  const texture = new THREE.CompressedTexture(levels, 4096, 2048, THREE.RGBA_ASTC_4x4_Format)
  const version = texture.version
  assert.equal(capCompressedTexture(texture, 1024), texture)
  assert.equal(texture.mipmaps.length, levels.length - 2)
  assert.equal(texture.mipmaps[0], levels[2])
  assert.deepEqual([texture.image.width, texture.image.height], [1024, 512])
  assert.ok(texture.version > version)
  // Within the cap, or with none: untouched.
  const small = new THREE.CompressedTexture(chain(1024, 1024), 1024, 1024, THREE.RGBA_ASTC_4x4_Format)
  const smallLevels = small.mipmaps
  capCompressedTexture(small, 2048)
  capCompressedTexture(small, Infinity)
  assert.equal(small.mipmaps, smallLevels)
  // A BC7 texture whose smaller levels are not whole blocks keeps its size.
  const odd = new THREE.CompressedTexture(chain(1500, 700), 1500, 700, THREE.RGBA_BPTC_Format)
  capCompressedTexture(odd, 1024)
  assert.equal(odd.image.width, 1500)
  // An ordinary texture is left to the image decoder's cap.
  const plain = new THREE.Texture({ width: 4096, height: 4096 })
  capCompressedTexture(plain, 1024)
  assert.equal(plain.image.width, 4096)
})

test('a compressed texture’s mip levels are dropped once every user is on the GPU', () => {
  const texture = new THREE.CompressedTexture(chain(256, 256), 256, 256, THREE.RGBA_ASTC_4x4_Format)
  texture.needsUpdate = true
  // Another sampler of the same image (GLTFLoader clones it): the same source and levels.
  const copy = texture.clone()
  assert.equal(copy.source, texture.source)
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: texture, emissiveMap: copy }))
  releaseWhenUploaded(mesh)
  const uploaded = new Map<THREE.Texture, number>()
  const renderer = { properties: { get: (t: THREE.Texture) => ({ __version: uploaded.get(t) }) } } as unknown as THREE.WebGLRenderer
  uploaded.set(texture, texture.version)
  releaseUploaded(renderer)
  assert.equal(texture.mipmaps.length, 9)
  assert.equal(anyReleased(), false)
  uploaded.set(copy, copy.version)
  releaseUploaded(renderer)
  assert.equal(texture.mipmaps.length, 0)
  assert.equal(copy.mipmaps.length, 0)
  // No image left either: a later upload is skipped (needs a rebuild), not tried without levels.
  assert.equal(texture.image, null)
  assert.deepEqual(texture.userData.gpuSize, [256, 256])
  assert.equal(anyReleased(), true)
})
