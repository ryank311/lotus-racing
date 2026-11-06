#!/usr/bin/env node
// Offline compression for the 3D replay's model files (car and track .glb).
//
// The server sends these files as they are on disk and never compresses
// anything itself, so they are prepared here, once, on a desktop:
//
// - Textures become KTX2 (KHR_texture_basisu): UASTC LDR 4×4 (near
//   lossless; never ETC1S), zstd supercompressed, full mip chains. The
//   browser transcodes UASTC to ASTC 4×4 (Apple GPUs, the iPad) or BC7
//   (desktop): 1 byte per texel on the GPU against the 4 of the RGBA8 a
//   PNG/JPEG/WebP decodes to, and no image decoding on the main thread.
//   Colour space per slot: base colour, emissive (and the other colour
//   slots) sRGB; normal maps in normal-map mode (linear, renormalised
//   mips); metallic-roughness, occlusion, clearcoat, specular strength and
//   the like linear. Level 0 is resized up to a multiple of 4 when it is
//   not one (WebGL rejects a BC7/S3TC mip chain otherwise); NPOT is fine.
//   A texture used both as colour and as data, in a slot this script does
//   not know, matched by --keep, or that the replay reads on the CPU stays
//   as it is (the list is printed).
// - Texture coordinate sets no material uses (TEXCOORD_1…7 on the car
//   models) are dropped, with the accessors nothing refers to any more.
//   Nothing else changes: node, mesh and material names, extras, samplers,
//   skins and extensions come through as they were (checked after writing).
// - <name>.glb is written with precompressed copies beside it,
//   <name>.glb.br (brotli 11) and <name>.glb.gz (gzip 9), which the server
//   sends to browsers that accept them.
//
// Usage:
//   npm run compress-models -- <model.glb | folder>... <output folder> [options]
//
//   --keep <regex>       leave textures whose name or URI matches uncompressed (repeatable)
//   --sidecars-only      only write .glb.br/.glb.gz (copying the .glb when the output
//                        folder is another one); textures are not touched
//   --uastc-level <0-4>  UASTC encoder effort (default 2; 3–4 are slower, barely better)
//   --rdo <lambda>       UASTC rate-distortion optimisation (default off: near lossless;
//                        0.5–2 trades a little quality for a smaller download)
//   --zstd-level <n>     re-supercompress the KTX2 levels at this zstd level
//                        (default 19; 0 keeps the encoder's level 6)
//   --no-prune           keep unused texture coordinate sets
//   --no-verify          skip decoding the textures back to check them (PSNR)
//   --jobs <n>           encoder threads (default: CPUs − 1)
//   --verbose            list every texture
//
// The basis encoder (WASM) takes at most ~12.6 Mpixels per image, so larger
// textures (a 4096² livery, a 3522×4096 aerial photo) are encoded in strips
// of whole 4×4 block rows for level 0 (UASTC blocks are independent) and the
// rest of the chain from a half-size copy, then joined into one KTX2.
//
// Models are third-party work: never commit a .glb or anything this writes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { parseArgs, promisify } from 'node:util'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const WORKER_ROLE = 'compress-models:basis-encoder'
// Basis Universal's WASM build refuses more source texels than this per image.
const MAX_SOURCE_TEXELS = 12 * 1024 * 1024
const KTX2_TRANSFER_LINEAR = 1
const KTX2_TRANSFER_SRGB = 2
const KTX2_MODEL_UASTC = 166
const KTX2_SUPERCOMPRESSION_ZSTD = 2
const TRANSCODE_RGBA32 = 13

// (The entry point is at the end of the file, after every declaration.)

// ─── Encoder thread ─────────────────────────────────────────────────────────

async function runEncoderWorker() {
  const { NodeBasisEncoder } = await import('ktx2-encoder')
  const basis = await new NodeBasisEncoder().init()
  parentPort.on('message', ({ id, rgba, width, height, opts }) => {
    try {
      const bytes = encodeUastc(basis, rgba, width, height, opts)
      parentPort.postMessage({ id, bytes }, [bytes.buffer])
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** One RGBA8 image → a UASTC .ktx2, set up for its slot (kind: srgb | linear | normal). */
function encodeUastc(basis, rgba, width, height, { kind, mips, zstd, level, rdo }) {
  const encoder = new basis.BasisEncoder()
  try {
    // The normal-map preset first: the explicit settings below win over it.
    if (kind === 'normal') encoder.setNormalMapPreset()
    encoder.setDebug(false)
    encoder.setStatusOutput?.(false)
    encoder.setCreateKTX2File(true)
    encoder.setTexType(0) // 2D
    encoder.setUASTC(true)
    encoder.setPackUASTCFlags(level)
    encoder.setMipGen(mips)
    const srgb = kind === 'srgb'
    encoder.setPerceptual(srgb)
    encoder.setMipSRGB(srgb)
    encoder.setKTX2AndBasisSRGBTransferFunc(srgb)
    if (kind === 'normal') encoder.setMipRenormalize(true)
    encoder.setKTX2UASTCSupercompression(zstd)
    encoder.setRDOUASTC(rdo > 0)
    if (rdo > 0) encoder.setRDOUASTCQualityScalar(rdo)
    if (encoder.setSliceSourceImage(0, rgba, width, height, 0 /* raw RGBA */) === false) throw new Error(`the encoder refused a ${width}×${height} image`)
    // UASTC is 1 byte per texel; a full mip chain adds a third.
    let capacity = width * height * 2 + 256 * 1024
    for (let attempt = 0; attempt < 3; attempt++, capacity *= 2) {
      const out = new Uint8Array(capacity)
      const length = encoder.encode(out)
      if (length > 0) return out.slice(0, length)
    }
    throw new Error(`encoding a ${width}×${height} image failed`)
  } finally {
    encoder.delete()
  }
}

class EncoderPool {
  constructor(size) {
    this.size = size
    this.workers = []
    this.idle = []
    this.queue = []
    this.running = new Map()
    this.nextId = 1
  }

  encode(rgba, width, height, opts) {
    return new Promise((resolve, reject) => {
      this.queue.push({ rgba, width, height, opts, resolve, reject })
      this.pump()
    })
  }

  pump() {
    while (this.queue.length) {
      const worker = this.idle.pop() ?? (this.workers.length < this.size ? this.spawn() : null)
      if (!worker) return
      const job = this.queue.shift()
      const id = this.nextId++
      this.running.set(id, { job, worker })
      worker.postMessage({ id, rgba: job.rgba, width: job.width, height: job.height, opts: job.opts })
    }
  }

  spawn() {
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: WORKER_ROLE } })
    worker.on('message', ({ id, bytes, error }) => {
      const entry = this.running.get(id)
      if (!entry) return
      this.running.delete(id)
      if (error) entry.job.reject(new Error(error))
      else entry.job.resolve(bytes)
      this.idle.push(worker)
      this.pump()
    })
    worker.on('error', error => {
      // A crashed thread fails its job; the pool carries on with a new one.
      for (const [id, entry] of this.running) if (entry.worker === worker) { this.running.delete(id); entry.job.reject(error) }
      this.workers = this.workers.filter(w => w !== worker)
      this.idle = this.idle.filter(w => w !== worker)
      this.pump()
    })
    this.workers.push(worker)
    return worker
  }

  close() {
    return Promise.all(this.workers.map(worker => worker.terminate()))
  }
}

// ─── Command line ───────────────────────────────────────────────────────────

async function main() {
  // Room for every model's brotli and gzip at once (libuv reads this when its pool starts).
  process.env.UV_THREADPOOL_SIZE ??= String(Math.min(16, Math.max(4, os.cpus().length)))
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      keep: { type: 'string', multiple: true, default: [] },
      'sidecars-only': { type: 'boolean', default: false },
      'uastc-level': { type: 'string', default: '2' },
      rdo: { type: 'string', default: '0' },
      'zstd-level': { type: 'string', default: '19' },
      'no-prune': { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      jobs: { type: 'string', default: String(Math.max(1, os.cpus().length - 1)) },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || positionals.length < 2) {
    console.log('Usage: npm run compress-models -- <model.glb | folder>... <output folder> [--keep <regex>] [--sidecars-only]\n'
      + '         [--uastc-level 0-4] [--rdo <lambda>] [--zstd-level <n>] [--no-prune] [--no-verify] [--jobs <n>] [--verbose]')
    process.exitCode = values.help ? 0 : 1
    return
  }
  const outDir = path.resolve(positionals.pop())
  const inputs = expandInputs(positionals)
  if (!inputs.length) throw new Error('No .glb files found in the inputs')
  const settings = {
    keep: values.keep.map(source => new RegExp(source, 'i')),
    level: integerOption('--uastc-level', values['uastc-level'], 0, 4),
    rdo: numberOption('--rdo', values.rdo, 0, 10),
    zstdLevel: integerOption('--zstd-level', values['zstd-level'], 0, 22),
    prune: !values['no-prune'],
    verify: !values['no-verify'],
    jobs: integerOption('--jobs', values.jobs, 1, 256),
    verbose: values.verbose,
  }
  fs.mkdirSync(outDir, { recursive: true })
  const started = performance.now()
  if (values['sidecars-only']) {
    const rows = []
    for (const input of inputs) rows.push(await sidecarsOnly(input, outDir))
    printTable(rows, { textures: false })
    console.log(`\nDone in ${seconds(performance.now() - started)}.`)
    return
  }
  for (const input of inputs) {
    if (path.resolve(outDir, path.basename(input)) === input) throw new Error(`${input}: the output folder is the input's own; choose another (or use --sidecars-only)`)
  }
  await compressModels(inputs, outDir, settings)
  console.log(`\nDone in ${seconds(performance.now() - started)}.`)
}

function expandInputs(paths) {
  const out = []
  for (const given of paths) {
    const resolved = path.resolve(given)
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(resolved).sort()) if (/\.glb$/i.test(name) && !name.startsWith('.')) out.push(path.join(resolved, name))
    } else if (/\.glb$/i.test(resolved)) out.push(resolved)
    else throw new Error(`${given} is not a .glb file or a folder`)
  }
  return [...new Set(out)]
}

function integerOption(name, value, min, max) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return n
}

function numberOption(name, value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}`)
  return n
}

// ─── Sidecars ───────────────────────────────────────────────────────────────

const brotliAsync = promisify(zlib.brotliCompress)
const gzipAsync = promisify(zlib.gzip)

// Brotli's standard window (24 bits, 16 MB) is the largest browsers decode;
// the "large window" extension is not part of Content-Encoding: br.
const brotli = bytes => brotliAsync(bytes, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_MAX_WINDOW_BITS,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
  },
})
const gzip = bytes => gzipAsync(bytes, { level: 9 })

async function compressedSizes(bytes) {
  const [br, gz] = await Promise.all([brotli(bytes), gzip(bytes)])
  return { br, gz }
}

function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, file)
}

/**
 * Writes `<file>`, then `<file>.br` and `<file>.gz`, all with one mtime: the
 * server serves a sidecar only while it is at least as new as the .glb.
 */
async function writeWithSidecars(file, bytes, sidecars) {
  const { br, gz } = sidecars ?? await compressedSizes(bytes)
  if (bytes) writeAtomic(file, bytes)
  writeAtomic(`${file}.br`, br)
  writeAtomic(`${file}.gz`, gz)
  // Beside an existing .glb (--sidecars-only in place) its own time, so its version stays.
  const stamp = bytes ? new Date() : fs.statSync(file).mtime
  for (const target of bytes ? [file, `${file}.br`, `${file}.gz`] : [`${file}.br`, `${file}.gz`]) fs.utimesSync(target, stamp, stamp)
  return { br: br.length, gz: gz.length }
}

async function sidecarsOnly(input, outDir) {
  const started = performance.now()
  const bytes = fs.readFileSync(input)
  const target = path.join(outDir, path.basename(input))
  const sizes = await compressedSizes(bytes)
  if (target !== input) await writeWithSidecars(target, bytes, sizes)
  else await writeWithSidecars(target, null, sizes)
  const row = { name: path.basename(input), before: { bytes: bytes.length, gz: sizes.gz.length, br: sizes.br.length }, ms: performance.now() - started }
  row.after = row.before
  return row
}

// ─── Texture plan ───────────────────────────────────────────────────────────

// Which colour space each slot holds (glTF 2.0 core and the KHR_materials_* extensions).
const SRGB_SLOTS = new Set([
  'baseColorTexture', 'emissiveTexture', 'specularColorTexture', 'sheenColorTexture',
  'diffuseTransmissionColorTexture', 'diffuseTexture', 'specularGlossinessTexture',
])
const NORMAL_SLOTS = new Set(['normalTexture', 'clearcoatNormalTexture'])
const LINEAR_SLOTS = new Set([
  'metallicRoughnessTexture', 'occlusionTexture', 'clearcoatTexture', 'clearcoatRoughnessTexture',
  'specularTexture', 'transmissionTexture', 'thicknessTexture', 'sheenRoughnessTexture',
  'iridescenceTexture', 'iridescenceThicknessTexture', 'anisotropyTexture', 'diffuseTransmissionTexture',
])

// Textures the replay reads back on the CPU (pixels in JavaScript) must stay
// decodable images. None of the model files' textures are today: the replay
// reads footprint.png (its own file, acTrack.ts), the aerial photo
// (terrain.ts) and canvases it draws itself; grass.ts samples the ground's
// map on the GPU. Add a name here (or pass --keep) if that changes.
const CPU_READ_TEXTURES = []

/** What a texture holds, from the slots that use it: srgb, linear or normal; else why it stays as it is. */
function classify(texture, root, settings) {
  const label = textureLabel(texture)
  if (settings.keep.some(re => re.test(texture.getName()) || re.test(texture.getURI()))) return { keep: '--keep' }
  if (CPU_READ_TEXTURES.some(re => re.test(texture.getName()))) return { keep: 'read on the CPU by the replay' }
  if (texture.getMimeType() === 'image/ktx2') return { keep: 'already KTX2' }
  const edges = texture.getGraph().listParentEdges(texture).filter(edge => edge.getParent() !== root)
  if (!edges.length) return { keep: 'not used by any material' }
  const kinds = new Set()
  const unknown = []
  for (const edge of edges) {
    const slot = edge.getName()
    if (NORMAL_SLOTS.has(slot)) kinds.add('normal')
    else if (SRGB_SLOTS.has(slot) || edge.getAttributes()?.isColor) kinds.add('srgb')
    else if (LINEAR_SLOTS.has(slot)) kinds.add('linear')
    else unknown.push(slot)
  }
  if (unknown.length) return { keep: `unknown slot ${unknown.join(', ')}` }
  if (kinds.size > 1) return { keep: `used as ${[...kinds].join(' and ')} (${label})` }
  return { kind: [...kinds][0] }
}

const textureLabel = texture => texture.getName() || texture.getURI() || '(unnamed)'

function slotsOf(texture, root) {
  return [...new Set(texture.getGraph().listParentEdges(texture).filter(e => e.getParent() !== root).map(e => e.getName()))]
}

function materialsOf(texture) {
  const names = new Set()
  const visit = (property, depth) => {
    for (const parent of property.listParents()) {
      if (parent.propertyType === 'Material') names.add(parent.getName() || '(unnamed)')
      else if (depth < 3 && parent.propertyType !== 'Root') visit(parent, depth + 1)
    }
  }
  visit(texture, 0)
  return [...names]
}

// ─── Pixels ─────────────────────────────────────────────────────────────────

let sharpModule = null
async function sharp() {
  sharpModule ??= (await import('sharp')).default
  return sharpModule
}

/** Any image sharp decodes → RGBA8 (grey, grey + alpha and RGB expanded). */
async function decodeRgba(bytes) {
  const sharpFn = await sharp()
  const image = sharpFn(bytes, { failOn: 'none', limitInputPixels: false })
  const meta = await image.metadata()
  const { data, info } = await image.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const n = width * height
  const rgba = new Uint8Array(n * 4)
  if (channels === 4) rgba.set(data)
  else {
    for (let i = 0, s = 0; i < n; i++, s += channels) {
      const o = i * 4
      if (channels >= 3) { rgba[o] = data[s]; rgba[o + 1] = data[s + 1]; rgba[o + 2] = data[s + 2] } else { rgba[o] = rgba[o + 1] = rgba[o + 2] = data[s] }
      rgba[o + 3] = channels === 2 ? data[s + 1] : 255
    }
  }
  return { rgba, width, height, icc: !!meta.icc, format: meta.format }
}

/** RGBA8 resized without premultiplying (colour under transparent texels stays as authored). */
async function resizeRgba(rgba, width, height, toWidth, toHeight) {
  const sharpFn = await sharp()
  const n = width * height
  const rgb = Buffer.alloc(n * 3), alpha = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; alpha[i] = rgba[i * 4 + 3]
  }
  // sharp writes a one-channel raw input back out as three (grey as sRGB):
  // the alpha is asked for as one channel, and each result is checked, or
  // reading it as one channel scrambles the alpha across the image.
  const resize = async (raw, channels) => {
    let image = sharpFn(raw, { raw: { width, height, channels } }).resize(toWidth, toHeight, { fit: 'fill', kernel: 'lanczos3' })
    if (channels === 1) image = image.extractChannel(0)
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
    if (info.channels !== channels || info.width !== toWidth || info.height !== toHeight) {
      throw new Error(`resizing gave ${info.width}×${info.height}×${info.channels}, expected ${toWidth}×${toHeight}×${channels}`)
    }
    return data
  }
  const [rgb2, alpha2] = await Promise.all([resize(rgb, 3), resize(alpha, 1)])
  const out = new Uint8Array(toWidth * toHeight * 4)
  for (let i = 0; i < toWidth * toHeight; i++) {
    out[i * 4] = rgb2[i * 3]; out[i * 4 + 1] = rgb2[i * 3 + 1]; out[i * 4 + 2] = rgb2[i * 3 + 2]; out[i * 4 + 3] = alpha2[i]
  }
  return out
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
const LINEAR_STEPS = 65535
const LINEAR_TO_SRGB = Uint8Array.from({ length: LINEAR_STEPS + 1 }, (_, i) => {
  const l = i / LINEAR_STEPS
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
})

/** The next mip level (half size, 2×2 box): in linear light for sRGB, renormalised for normal maps. */
function halve(rgba, width, height, kind) {
  const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1)
  const out = new Uint8Array(w * h * 4)
  const at = (x, y) => (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = [at(2 * x, 2 * y), at(2 * x + 1, 2 * y), at(2 * x, 2 * y + 1), at(2 * x + 1, 2 * y + 1)]
      const o = (y * w + x) * 4
      if (kind === 'srgb') {
        for (let c = 0; c < 3; c++) {
          const l = (SRGB_TO_LINEAR[rgba[p[0] + c]] + SRGB_TO_LINEAR[rgba[p[1] + c]] + SRGB_TO_LINEAR[rgba[p[2] + c]] + SRGB_TO_LINEAR[rgba[p[3] + c]]) / 4
          out[o + c] = LINEAR_TO_SRGB[Math.round(l * LINEAR_STEPS)]
        }
      } else if (kind === 'normal') {
        let nx = 0, ny = 0, nz = 0
        for (const q of p) { nx += rgba[q] / 127.5 - 1; ny += rgba[q + 1] / 127.5 - 1; nz += rgba[q + 2] / 127.5 - 1 }
        const len = Math.hypot(nx, ny, nz) || 1
        out[o] = Math.round((nx / len + 1) * 127.5); out[o + 1] = Math.round((ny / len + 1) * 127.5); out[o + 2] = Math.round((nz / len + 1) * 127.5)
      } else {
        for (let c = 0; c < 3; c++) out[o + c] = Math.round((rgba[p[0] + c] + rgba[p[1] + c] + rgba[p[2] + c] + rgba[p[3] + c]) / 4)
      }
      out[o + 3] = Math.round((rgba[p[0] + 3] + rgba[p[1] + 3] + rgba[p[2] + 3] + rgba[p[3] + 3]) / 4)
    }
  }
  return out
}

// ─── KTX2 ───────────────────────────────────────────────────────────────────

let ktxParse = null
async function ktx() {
  ktxParse ??= await import('ktx-parse')
  return ktxParse
}

const zstdCompress = (bytes, level) => new Uint8Array(zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }))
const zstdDecompress = bytes => new Uint8Array(zlib.zstdDecompressSync(bytes))

/**
 * A texture as KTX2: one encode when the encoder takes the whole image;
 * otherwise level 0 (and any level still too large) in strips of whole
 * block rows, joined, and the rest of the chain from the half-size copy.
 */
async function encodeTexture(pool, rgba, width, height, kind, settings) {
  const opts = { kind, level: settings.level, rdo: settings.rdo }
  if (width * height <= MAX_SOURCE_TEXELS) {
    const bytes = await pool.encode(rgba, width, height, { ...opts, mips: true, zstd: true })
    return settings.zstdLevel ? recompress(bytes, settings.zstdLevel) : bytes
  }
  const heads = []
  let image = rgba, w = width, h = height
  while (w * h > MAX_SOURCE_TEXELS) {
    const maxRows = Math.floor(MAX_SOURCE_TEXELS / w / 4) * 4
    if (maxRows < 4) throw new Error(`${width}×${height} is too wide to encode in strips`)
    const strips = Math.ceil(h / maxRows)
    const rows = Math.ceil(h / strips / 4) * 4
    const level = image, levelWidth = w
    const parts = []
    for (let y = 0; y < h; y += rows) {
      const y1 = Math.min(h, y + rows)
      parts.push(pool.encode(level.slice(y * levelWidth * 4, y1 * levelWidth * 4), levelWidth, y1 - y, { ...opts, mips: false, zstd: false }))
    }
    heads.push(Promise.all(parts).then(async encoded => {
      const { read } = await ktx()
      // Strips span the full width, so their block rows simply follow one another.
      const blocks = encoded.map(bytes => read(bytes).levels[0].levelData)
      const joined = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0))
      let at = 0
      for (const b of blocks) { joined.set(b, at); at += b.length }
      return joined
    }))
    image = halve(image, w, h, kind)
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1)
  }
  const [levels, tailBytes] = await Promise.all([Promise.all(heads), pool.encode(image, w, h, { ...opts, mips: true, zstd: true })])
  const { read, write } = await ktx()
  const tail = read(tailBytes)
  const zstdLevel = settings.zstdLevel || 6
  const expected = levels.map((_, i) => Math.ceil(Math.max(1, width >> i) / 4) * Math.ceil(Math.max(1, height >> i) / 4) * 16)
  levels.forEach((data, i) => { if (data.length !== expected[i]) throw new Error(`level ${i}: ${data.length} bytes of blocks, expected ${expected[i]}`) })
  tail.levels = [
    ...levels.map(data => ({ levelData: zstdCompress(data, zstdLevel), uncompressedByteLength: data.length })),
    ...tail.levels.map(level => (settings.zstdLevel ? recompressLevel(level, settings.zstdLevel) : level)),
  ]
  tail.pixelWidth = width
  tail.pixelHeight = height
  tail.levelCount = tail.levels.length
  if (tail.supercompressionScheme !== KTX2_SUPERCOMPRESSION_ZSTD) throw new Error('expected a zstd-supercompressed tail')
  return write(tail, { keepWriter: true })
}

function recompressLevel(level, zstdLevel) {
  const raw = zstdDecompress(level.levelData)
  const levelData = zstdCompress(raw, zstdLevel)
  return levelData.length < level.levelData.length ? { levelData, uncompressedByteLength: raw.length } : level
}

async function recompress(bytes, zstdLevel) {
  const { read, write } = await ktx()
  const container = read(bytes)
  if (container.supercompressionScheme !== KTX2_SUPERCOMPRESSION_ZSTD) return bytes
  container.levels = container.levels.map(level => recompressLevel(level, zstdLevel))
  return write(container, { keepWriter: true })
}

/** Bytes on the GPU: RGBA8 with its mips, or a 4×4-block format at 16 bytes per block (ASTC 4×4, BC7). */
function gpuBytes(width, height, compressed) {
  let total = 0
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    total += compressed ? Math.ceil(w / 4) * Math.ceil(h / 4) * 16 : w * h * 4
    if (w === 1 && h === 1) break
  }
  return total
}

// three.js's Basis transcoder (the one the browser uses) loaded in Node, to decode the result back.
let transcoder = null
async function basisTranscoder() {
  if (transcoder) return transcoder
  const require = createRequire(import.meta.url)
  const file = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js')
  const factory = vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\nreturn BASIS;\n})`, { filename: file })
  const BASIS = factory(require, {}, {}, file, path.dirname(file))
  const module = await BASIS({ wasmBinary: fs.readFileSync(file.replace(/\.js$/, '.wasm')) })
  module.initializeBasis()
  transcoder = module
  return module
}

/** Decodes the KTX2 back (all levels checked for size; level 0, and 1 when given, compared): PSNR in dB. */
async function verifyKtx2(bytes, source, width, height, kind, levelOne) {
  const { read } = await ktx()
  const container = read(bytes)
  const dfd = container.dataFormatDescriptor[0]
  const problems = []
  if (dfd.colorModel !== KTX2_MODEL_UASTC) problems.push(`colour model ${dfd.colorModel}, not UASTC`)
  const transfer = kind === 'srgb' ? KTX2_TRANSFER_SRGB : KTX2_TRANSFER_LINEAR
  if (dfd.transferFunction !== transfer) problems.push(`transfer function ${dfd.transferFunction}, expected ${transfer}`)
  const fullChain = Math.floor(Math.log2(Math.max(width, height))) + 1
  if (container.levelCount !== fullChain) problems.push(`${container.levelCount} levels, expected ${fullChain}`)
  if (width % 4 || height % 4) problems.push(`${width}×${height} is not a multiple of 4`)
  const basis = await basisTranscoder()
  const file = new basis.KTX2File(bytes)
  const psnr = []
  try {
    if (!file.isValid() || !file.isUASTC() || !file.startTranscoding()) throw new Error('the transcoder rejected it')
    for (let level = 0; level < file.getLevels(); level++) {
      const info = file.getImageLevelInfo(level, 0, 0)
      const w = Math.max(1, width >> level), h = Math.max(1, height >> level)
      if (info.origWidth !== w || info.origHeight !== h) problems.push(`level ${level} is ${info.origWidth}×${info.origHeight}, expected ${w}×${h}`)
      const reference = level === 0 ? source : level === 1 ? levelOne : null
      if (!reference) continue
      const out = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, TRANSCODE_RGBA32))
      if (!file.transcodeImage(out, level, 0, 0, TRANSCODE_RGBA32, 0, -1, -1)) throw new Error(`level ${level} did not transcode`)
      psnr.push(psnrOf(reference, out, w * h))
    }
  } finally {
    file.close()
    file.delete()
  }
  return { psnr, problems }
}

function psnrOf(a, b, texels) {
  let sum = 0, count = 0
  let alpha = false
  for (let i = 3; i < texels * 4; i += 4) if (a[i] !== 255) { alpha = true; break }
  for (let i = 0; i < texels * 4; i++) {
    if (!alpha && (i & 3) === 3) continue
    const d = a[i] - b[i]
    sum += d * d
    count++
  }
  const mse = sum / count
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse)
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/**
 * Drops TEXCOORD_n above the highest set a primitive's material samples
 * (TEXCOORD_0 always stays), on the primitive and its morph targets.
 */
function pruneTexCoords(document, listTextureInfoByMaterial) {
  let removed = 0
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial()
      let highest = 0
      if (material) {
        for (const info of listTextureInfoByMaterial(material)) {
          highest = Math.max(highest, info.getTexCoord())
          const transform = info.getExtension('KHR_texture_transform')
          if (transform?.getTexCoord() != null) highest = Math.max(highest, transform.getTexCoord())
        }
      }
      for (const target of [prim, ...prim.listTargets()]) {
        for (const semantic of target.listSemantics()) {
          const m = /^TEXCOORD_(\d+)$/.exec(semantic)
          if (m && Number(m[1]) > highest) { target.setAttribute(semantic, null); removed++ }
        }
      }
    }
  }
  return removed
}

// ─── Models ─────────────────────────────────────────────────────────────────

/** Names, counts and extras that must come through unchanged. */
function signature(document, json) {
  const root = document.getRoot()
  const named = list => list.map(p => [p.getName(), p.getExtras()])
  const parts = {
    asset: { ...json.asset, generator: undefined },
    nodes: named(root.listNodes()),
    meshes: named(root.listMeshes()),
    primitives: root.listMeshes().map(m => m.listPrimitives().map(p => [p.getMaterial()?.getName() ?? null, p.getMode(), p.getAttribute('POSITION')?.getCount()])),
    materials: named(root.listMaterials()).concat(root.listMaterials().map(m => [m.getAlphaMode(), m.getAlphaCutoff(), m.getDoubleSided(), m.listExtensions().map(e => e.extensionName).sort().join()])),
    textures: root.listTextures().map(t => t.getName()),
    jsonCounts: ['nodes', 'meshes', 'materials', 'textures', 'images', 'samplers', 'skins', 'animations', 'cameras', 'scenes'].map(k => json[k]?.length ?? 0),
    skins: root.listSkins().map(s => [s.getName(), s.listJoints().length]),
    animations: root.listAnimations().map(a => a.getName()),
    scenes: named(root.listScenes()),
    extras: root.getExtras(),
  }
  return Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, stableJson(value)]))
}

/** JSON with object keys sorted (key order is not part of a glTF's meaning). */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** The parts of two signatures that differ, with their first difference. */
function signatureDiff(a, b) {
  return Object.keys(a).filter(key => a[key] !== b[key]).map(key => {
    let i = 0
    while (i < a[key].length && a[key][i] === b[key][i]) i++
    return `${key} (from …${a[key].slice(Math.max(0, i - 40), i + 60)}… to …${b[key].slice(Math.max(0, i - 40), i + 60)}…)`
  })
}

function glbJson(bytes) {
  const length = bytes.readUInt32LE(12)
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'))
}

async function compressModels(inputs, outDir, settings) {
  const [{ NodeIO, PropertyType }, { ALL_EXTENSIONS, KHRTextureBasisu }, { prune, listTextureInfoByMaterial }] = await Promise.all([
    import('@gltf-transform/core'), import('@gltf-transform/extensions'), import('@gltf-transform/functions'),
  ])
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const pool = new EncoderPool(settings.jobs)
  const sharpFn = await sharp()
  sharpFn.concurrency(1)

  // Read every model and plan its textures.
  const models = []
  const tasks = new Map() // content + kind → one encode, shared by every copy of the image
  for (const input of inputs) {
    const started = performance.now()
    const bytes = fs.readFileSync(input)
    const document = await io.readBinary(new Uint8Array(bytes))
    const root = document.getRoot()
    const model = {
      input, name: path.basename(input), bytes, document, signature: signature(document, glbJson(bytes)),
      textures: [], readMs: performance.now() - started,
    }
    for (const texture of root.listTextures()) {
      const image = texture.getImage()
      const entry = { texture, slots: slotsOf(texture, root), materials: materialsOf(texture), sourceBytes: image?.byteLength ?? 0 }
      // Unnamed textures (most car models') go by their first material and slot.
      entry.label = texture.getName() || texture.getURI() || `${entry.materials[0] ?? '?'}.${entry.slots[0] ?? '?'}`
      let size = null
      try { size = image && await sharpFn(image, { failOn: 'none', limitInputPixels: false }).metadata() } catch { /* not an image sharp reads */ }
      entry.width = size?.width ?? 0
      entry.height = size?.height ?? 0
      const plan = !image ? { keep: 'no image data' } : !size?.width ? { keep: `not a decodable image (${texture.getMimeType()})` } : classify(texture, root, settings)
      if (plan.keep) entry.keep = plan.keep
      else {
        entry.kind = plan.kind
        const key = `${createHash('sha1').update(image).digest('hex')}:${plan.kind}`
        let task = tasks.get(key)
        if (!task) { task = { key, image, kind: plan.kind, width: entry.width, height: entry.height, entries: [] }; tasks.set(key, task) }
        task.entries.push({ model, entry })
      }
      model.textures.push(entry)
    }
    models.push(model)
  }

  // Encode, largest first, a few images in flight per encoder thread.
  const queue = [...tasks.values()].sort((a, b) => b.width * b.height - a.width * a.height)
  const total = queue.length
  let done = 0
  const encodeStarted = performance.now()
  console.log(`${models.length} model(s), ${models.reduce((a, m) => a + m.textures.length, 0)} textures, ${total} distinct image(s) to encode on ${settings.jobs} thread(s)…`)
  const runTask = async task => {
    const started = performance.now()
    let { rgba, width, height, icc } = await decodeRgba(task.image)
    if (icc && task.kind !== 'srgb') console.warn(`  note: ${task.entries[0].entry.label} carries an ICC profile; its values were converted as colour`)
    const toWidth = Math.ceil(width / 4) * 4, toHeight = Math.ceil(height / 4) * 4
    if (toWidth !== width || toHeight !== height) {
      rgba = await resizeRgba(rgba, width, height, toWidth, toHeight)
      width = toWidth; height = toHeight
    }
    const bytes = await encodeTexture(pool, rgba, width, height, task.kind, settings)
    let check = null
    if (settings.verify) {
      const levelOne = width * height > MAX_SOURCE_TEXELS ? halve(rgba, width, height, task.kind) : null
      check = await verifyKtx2(bytes, rgba, width, height, task.kind, levelOne)
    }
    const ms = performance.now() - started
    for (const { model, entry } of task.entries) {
      Object.assign(entry, { ktx2: bytes, outWidth: width, outHeight: height, tiled: width * height > MAX_SOURCE_TEXELS, check, ms })
    }
    done++
    const psnr = check?.psnr.length ? ` ${check.psnr.map(p => p.toFixed(1)).join('/')} dB` : ''
    if (settings.verbose || ms > 20_000) console.log(`  [${done}/${total}] ${task.entries[0].entry.label} ${width}×${height} ${task.kind}${psnr} ${seconds(ms)}`)
  }
  const inFlight = new Set()
  const failures = []
  for (const task of queue) {
    const job = runTask(task).catch(error => { failures.push(`${task.entries[0].entry.label}: ${error.message}`) }).finally(() => inFlight.delete(job))
    inFlight.add(job)
    if (inFlight.size >= settings.jobs + 2) await Promise.race(inFlight)
  }
  await Promise.all(inFlight)
  await pool.close()
  const encodeMs = performance.now() - encodeStarted
  if (failures.length) throw new Error(`Textures failed to encode:\n  ${failures.join('\n  ')}`)
  console.log(`Encoded ${total} image(s) in ${seconds(encodeMs)}.`)

  // Write each model, check it and its sidecars, all at once (brotli 11 is
  // single-threaded per file and takes minutes on the large ones).
  const rows = await Promise.all(models.map(async model => {
    const started = performance.now()
    const { document } = model
    let encoded = 0
    for (const entry of model.textures) {
      if (!entry.ktx2) continue
      entry.texture.setImage(entry.ktx2)
      entry.texture.setMimeType('image/ktx2')
      encoded++
    }
    if (encoded) document.createExtension(KHRTextureBasisu).setRequired(true)
    let prunedSets = 0
    if (settings.prune) {
      prunedSets = pruneTexCoords(document, listTextureInfoByMaterial)
      // Only the accessors nothing refers to any more; every node, material and texture stays.
      await document.transform(prune({ propertyTypes: [PropertyType.ACCESSOR], keepAttributes: true, keepIndices: true, keepLeaves: true, keepSolidTextures: true, keepExtras: true }))
    }
    const bytes = Buffer.from(await io.writeBinary(document))
    const target = path.join(outDir, model.name)

    // Read back: the same structure, KTX2 where expected.
    const check = await io.readBinary(new Uint8Array(bytes))
    const json = glbJson(bytes)
    const problems = []
    for (const part of signatureDiff(model.signature, signature(check, json))) problems.push(`differs from the source: ${part}`)
    const ktxCount = check.getRoot().listTextures().filter(t => t.getMimeType() === 'image/ktx2').length
    if (ktxCount !== encoded) problems.push(`${ktxCount} KTX2 textures, expected ${encoded}`)
    if (encoded && !json.extensionsRequired?.includes('KHR_texture_basisu')) problems.push('KHR_texture_basisu is not required')
    for (const entry of model.textures) if (entry.check?.problems.length) problems.push(`${entry.label}: ${entry.check.problems.join('; ')}`)
    if (problems.length) throw new Error(`${model.name} failed its checks:\n  ${problems.join('\n  ')}`)

    const [before, after] = await Promise.all([compressedSizes(model.bytes), compressedSizes(bytes)])
    const sizes = await writeWithSidecars(target, bytes, after)
    const kept = model.textures.filter(e => e.keep)
    const psnrs = model.textures.flatMap(e => (e.check?.psnr.length ? [{ label: e.label, psnr: e.check.psnr[0] }] : []))
    const worst = psnrs.sort((a, b) => a.psnr - b.psnr)[0]
    const row = {
      name: model.name,
      before: { bytes: model.bytes.length, gz: before.gz.length, br: before.br.length },
      after: { bytes: bytes.length, gz: sizes.gz, br: sizes.br },
      gpuBefore: model.textures.reduce((a, e) => a + gpuBytes(e.width, e.height, false), 0),
      gpuAfter: model.textures.reduce((a, e) => a + (e.ktx2 ? gpuBytes(e.outWidth, e.outHeight, true) : gpuBytes(e.width, e.height, false)), 0),
      textures: model.textures.length, encoded, kept, prunedSets, worst,
      ms: model.readMs + performance.now() - started,
    }
    console.log(`Wrote ${target} (+ .br, .gz): ${json.nodes?.length ?? 0} nodes, ${json.textures?.length ?? 0} textures (${encoded} KTX2), structure checked${prunedSets ? `, ${prunedSets} unused UV set(s) dropped` : ''}.`)
    if (settings.verbose) {
      for (const e of model.textures) {
        const what = e.keep ? `kept (${e.keep})` : `${e.kind}${e.outWidth !== e.width || e.outHeight !== e.height ? ` → ${e.outWidth}×${e.outHeight}` : ''}${e.tiled ? ' strips' : ''} ${e.check?.psnr.map(p => p.toFixed(1)).join('/') ?? ''} dB`
        console.log(`    ${e.label.padEnd(36)} ${`${e.width}×${e.height}`.padEnd(11)} [${e.slots.join(', ')}] ${what}`)
      }
    }
    return row
  }))
  printTable(rows, { textures: true, encodeMs })
}

// ─── Report ─────────────────────────────────────────────────────────────────

const mb = bytes => (bytes / 1024 ** 2).toFixed(1)
const seconds = ms => `${(ms / 1000).toFixed(1)} s`
const pct = (after, before) => `${after <= before ? '−' : '+'}${Math.abs(Math.round((1 - after / before) * 100))}%`

function printTable(rows, { textures, encodeMs }) {
  const header = ['file', 'glb MB', 'gz MB', 'br MB', ...(textures ? ['GPU tex MB', 'textures', 'worst PSNR'] : []), 'time']
  const lines = rows.map(r => [
    r.name,
    `${mb(r.before.bytes)} → ${mb(r.after.bytes)}`,
    `${mb(r.before.gz)} → ${mb(r.after.gz)}`,
    `${mb(r.before.br)} → ${mb(r.after.br)}`,
    ...(textures ? [
      `${mb(r.gpuBefore)} → ${mb(r.gpuAfter)} (${pct(r.gpuAfter, r.gpuBefore)})`,
      `${r.encoded}/${r.textures} KTX2`,
      r.worst ? `${r.worst.psnr.toFixed(1)} dB (${r.worst.label})` : '—',
    ] : []),
    seconds(r.ms),
  ])
  const sum = key => rows.reduce((a, r) => a + key(r), 0)
  lines.push([
    'total',
    `${mb(sum(r => r.before.bytes))} → ${mb(sum(r => r.after.bytes))}`,
    `${mb(sum(r => r.before.gz))} → ${mb(sum(r => r.after.gz))}`,
    `${mb(sum(r => r.before.br))} → ${mb(sum(r => r.after.br))}`,
    ...(textures ? [`${mb(sum(r => r.gpuBefore))} → ${mb(sum(r => r.gpuAfter))} (${pct(sum(r => r.gpuAfter), sum(r => r.gpuBefore))})`, `${sum(r => r.encoded)}/${sum(r => r.textures)} KTX2`, ''] : []),
    encodeMs != null ? `encode ${seconds(encodeMs)}` : seconds(sum(r => r.ms)),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)))
  const format = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(`\n${format(header)}\n${widths.map(w => '─'.repeat(w)).join('  ')}\n${lines.map(format).join('\n')}`)
  if (textures) {
    console.log('\nGPU tex MB: before = RGBA8 + mips as authored; after = 1 byte/texel + mips (UASTC → ASTC 4×4 / BC7).')
    console.log('time: reading, writing, checking and compressing each file; the textures of all files encode together (total row).')
    const kept = rows.flatMap(r => r.kept.map(e => `${r.name}: ${e.label} [${e.slots.join(', ')}] — ${e.keep}`))
    console.log(kept.length ? `Left uncompressed:\n  ${kept.join('\n  ')}` : 'Left uncompressed: none.')
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

if (!isMainThread && workerData?.role === WORKER_ROLE) await runEncoderWorker()
else await main()
