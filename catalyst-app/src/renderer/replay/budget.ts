// The replay's memory budget on the device it runs on.
//
// Every browser on iPhone and iPad is WebKit (Safari's engine, memory limits
// and GPU process): a tab whose web content goes over its budget (often
// 1–1.5 GB on an iPad, less on older ones) is killed and reloaded, and
// before that texture uploads fail or the WebGL context is lost. A converted
// sim track and a car with a 4096² livery are about 1 GB of textures on the
// GPU and two thirds of that again in CPU copies, so such a device gets a
// constrained profile:
//
// - textures capped as they load (the track's at 1024 px on the long side,
//   decoded straight to that size a few at a time; the car's at 2048; the
//   aerial photo at 2048: acTrack.ts, car.ts parseGlb, terrain.ts);
// - the CPU copies of textures (and of the track's geometry) dropped once
//   they are on the GPU, and the downloaded model files once parsed (a lost
//   context then rebuilds the scene: engine.needsRebuild);
// - at most 1.5 × resolution, and Auto graphics on Low (no grass, smaller
//   shadows, the Garmin lens without multisampling);
// - the onboard video kept in step by rare seeks, not by nudging its rate.
//
// localStorage['catalyst:replay-profile'] overrides the detection: 'ios'
// (the iPad's profile anywhere, for testing), 'low' (constrained without
// the iOS video handling) or 'standard' (none of it, even on an iPad).

import * as THREE from 'three'
import type { GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import { REPLAY_DEBUG } from './debug'

export const PROFILE_KEY = 'catalyst:replay-profile'

export interface ReplayProfile {
  /** A small memory budget: capped textures, no CPU copies, Low graphics on Auto. */
  constrained: boolean
  /** iOS or iPadOS WebKit: its video stalls on playbackRate changes and slow seeks. */
  webkitMobile: boolean
  /** Why, for the Graphics panel and debugging. */
  reason: string
  maxPixelRatio: number
  /** Longest side of a texture as loaded (Infinity: as authored). */
  textureMax: { track: number; car: number; terrain: number }
  /** Drop CPU copies once on the GPU, and the downloaded files once parsed. */
  lean: boolean
  /** Track images decoded at once (each needs its full size in memory while it decodes). */
  decodeConcurrency: number
  /** What Auto graphics starts on. */
  autoGraphics: 'high' | 'low'
}

/** iPhone, iPod or iPad: an iPad asking for desktop sites says "Macintosh" but has a touch screen. */
export function isWebKitMobile(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1
}

let cached: ReplayProfile | null = null

export function replayProfile(): ReplayProfile {
  if (cached) return cached
  let forced: string | null = null
  try { forced = localStorage.getItem(PROFILE_KEY) } catch { /* private mode */ }
  const ios = isWebKitMobile()
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const standard: ReplayProfile = {
    constrained: false, webkitMobile: false, reason: 'standard', maxPixelRatio: 2,
    textureMax: { track: Infinity, car: Infinity, terrain: Infinity }, lean: false, decodeConcurrency: Infinity, autoGraphics: 'high',
  }
  const constrained = (reason: string, webkitMobile: boolean): ReplayProfile => ({
    constrained: true, webkitMobile, reason, maxPixelRatio: 1.5,
    textureMax: { track: 1024, car: 2048, terrain: 2048 }, lean: true, decodeConcurrency: 3, autoGraphics: 'low',
  })
  if (forced === 'standard') cached = { ...standard, reason: 'standard (forced)' }
  else if (forced === 'ios') cached = constrained('iOS profile (forced)', true)
  else if (forced === 'low') cached = constrained('low-memory profile (forced)', false)
  else if (ios) cached = constrained('iPhone or iPad (WebKit)', true)
  else if (memory != null && memory <= 2) cached = constrained(`${memory} GB device`, false)
  else cached = standard
  if (REPLAY_DEBUG) console.info(`[replay] device profile: ${cached.reason}`)
  return cached
}

// ─── Image sizes ────────────────────────────────────────────────────────────

/** Width and height from a JPEG, PNG or WebP header; null when not found. */
export function imageSize(bytes: Uint8Array): [number, number] | null {
  const b = bytes, n = b.length
  const u16be = (o: number) => (b[o] << 8) | b[o + 1]
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [u32be(16), u32be(20)]
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < n) {
      if (b[o] !== 0xff) { o++; continue }
      const marker = b[o + 1]
      if (marker === 0xff) { o++; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue }
      // Start of frame (not DHT, JPG or DAC): height, then width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [u16be(o + 7), u16be(o + 5)]
      o += 2 + u16be(o + 2)
    }
    return null
  }
  if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X') return [1 + u24le(24), 1 + u24le(27)]
    if (chunk === 'VP8 ') return [((b[27] << 8) | b[26]) & 0x3fff, ((b[29] << 8) | b[28]) & 0x3fff]
    if (chunk === 'VP8L') {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)]
    }
  }
  return null
}

/** The size that fits within `max` on its longest side (unchanged when it already does). */
export function fitSize(width: number, height: number, max: number): [number, number] {
  const long = Math.max(width, height)
  if (!(long > max)) return [width, height]
  const k = max / long
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))]
}

// ImageBitmapLoader's options (three keeps glTF images unpremultiplied).
const BITMAP_OPTIONS: ImageBitmapOptions = { premultiplyAlpha: 'none' }

/**
 * An image as an ImageBitmap no larger than `max` on its long side. Decoded
 * at that size when the browser can (createImageBitmap's resize options),
 * else decoded and then scaled.
 */
export async function decodeFitted(blob: Blob, max: number): Promise<ImageBitmap> {
  if (!Number.isFinite(max)) return createImageBitmap(blob, BITMAP_OPTIONS)
  const head = imageSize(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()))
  if (head) {
    const [w, h] = fitSize(head[0], head[1], max)
    if (w === head[0] && h === head[1]) return createImageBitmap(blob, BITMAP_OPTIONS)
    try {
      const bitmap = await createImageBitmap(blob, { ...BITMAP_OPTIONS, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
      if (bitmap.width === w && bitmap.height === h) return bitmap
      // Resize options ignored: scaled below.
      return await shrinkBitmap(bitmap, max)
    } catch { /* decoded whole below */ }
  }
  return shrinkBitmap(await createImageBitmap(blob, BITMAP_OPTIONS), max)
}

/** A smaller copy of an image (the original ImageBitmap is closed); the image itself when it fits. */
export async function shrinkBitmap<T extends ImageBitmap | HTMLImageElement | HTMLCanvasElement>(image: T, max: number): Promise<T | ImageBitmap> {
  const [w0, h0] = [image.width, image.height]
  const [w, h] = fitSize(w0, h0, max)
  if (w === w0 && h === h0) return image
  let out: ImageBitmap | null = null
  try {
    out = await createImageBitmap(image, { ...BITMAP_OPTIONS, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    if (out.width !== w || out.height !== h) { out.close(); out = null }
  } catch { out = null }
  if (!out) {
    // Through a canvas (premultiplied, which only matters at cut-out edges).
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!context) return image
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, w, h)
    out = await createImageBitmap(canvas)
  }
  if (image instanceof ImageBitmap) image.close()
  return out
}

// A few decodes at a time: each holds its full-size image while it decodes.
function limiter(concurrency: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => queue.push(resolve))
    active++
    try { return await task() } finally { active--; queue.shift()?.() }
  }
}

/**
 * A GLTFLoader plugin that decodes the file's images no larger than `max`
 * (glTF textures from their own sources; extension sources such as
 * EXT_texture_webp's are left to their plugins). Register with
 * loader.register(parser => fittedTextures(parser, max, concurrency)).
 */
export function fittedTextures(parser: GLTFParser, max: number, concurrency = 3): GLTFLoaderPlugin {
  const run = limiter(concurrency)
  const loader = {
    // The parser wraps an ImageBitmap in a Texture for a loader like this one.
    isImageBitmapLoader: true,
    load(url: string, onLoad: (bitmap: ImageBitmap) => void, _onProgress: unknown, onError: (error: unknown) => void) {
      run(async () => decodeFitted(await (await fetch(url)).blob(), max)).then(onLoad, onError)
    },
  }
  return {
    name: 'catalyst_fitted_textures',
    loadTexture(textureIndex: number) {
      const json = parser.json as { textures: Array<{ source?: number; extensions?: Record<string, unknown> }>; images: Array<{ uri?: string; bufferView?: number }> }
      const def = json.textures[textureIndex]
      if (def.source == null || (def.extensions && Object.keys(def.extensions).length) || typeof createImageBitmap === 'undefined') return null
      const image = json.images[def.source]
      if (image.bufferView == null && !image.uri) return null
      return (parser as unknown as { loadTextureImage: (t: number, s: number, l: unknown) => Promise<THREE.Texture | null> }).loadTextureImage(textureIndex, def.source, loader)
    },
  } as GLTFLoaderPlugin
}

/** Every texture of the materials under `root`, by its image source. */
function texturesUnder(root: THREE.Object3D): Map<THREE.Texture["source"], Set<THREE.Texture>> {
  const bySource = new Map<THREE.Texture["source"], Set<THREE.Texture>>()
  root.traverse(object => {
    const material = (object as THREE.Mesh).material
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m)) {
        const texture = value as THREE.Texture
        if (!texture?.isTexture || (texture as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture) continue
        let set = bySource.get(texture.source)
        if (!set) bySource.set(texture.source, set = new Set())
        set.add(texture)
      }
    }
  })
  return bySource
}

// ─── CPU copies ─────────────────────────────────────────────────────────────

// Image sources whose CPU copy goes once every texture using it is on the GPU.
const pendingSources = new Map<THREE.Texture["source"], Set<THREE.Texture>>()
let releasedCount = 0

/**
 * Drop the CPU copies under `root` once they are on the GPU: each image
 * when every texture using it has been uploaded (releaseUploaded, after
 * each frame), and with `geometry` each vertex and index buffer as it is
 * uploaded. Nothing under `root` can be uploaded again afterwards (a lost
 * context means building it again), and its geometry cannot be measured or
 * read: only for what is never changed or queried once drawn.
 */
export function releaseWhenUploaded(root: THREE.Object3D, geometry = false) {
  for (const [source, textures] of texturesUnder(root)) {
    let set = pendingSources.get(source)
    if (!set) pendingSources.set(source, set = new Set())
    for (const texture of textures) {
      if (set.has(texture)) continue
      set.add(texture)
      texture.addEventListener('dispose', () => {
        const users = pendingSources.get(source)
        users?.delete(texture)
        if (users && !users.size) pendingSources.delete(source)
      })
    }
  }
  if (!geometry) return
  root.traverse(object => {
    const g = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (!g?.isBufferGeometry) return
    // Bounds for culling (and anything that asks) while the arrays are here.
    if (!g.boundingSphere) g.computeBoundingSphere()
    if (!g.boundingBox) g.computeBoundingBox()
    for (const attribute of [...Object.values(g.attributes), g.index]) {
      if (!attribute) continue
      const buffer = (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (attribute as THREE.InterleavedBufferAttribute).data : attribute as THREE.BufferAttribute
      buffer.onUpload(dropArray)
    }
  })
}

function dropArray(this: { array: ArrayLike<number> | null }) {
  this.array = null
  releasedCount++
}

/** After a frame: drop the images whose every texture is now on the GPU. */
export function releaseUploaded(renderer: THREE.WebGLRenderer) {
  if (!pendingSources.size) return
  for (const [source, textures] of pendingSources) {
    let uploaded = true
    for (const texture of textures) {
      const state = renderer.properties.get(texture) as { __version?: number }
      if (state.__version !== texture.version) { uploaded = false; break }
    }
    if (!uploaded) continue
    pendingSources.delete(source)
    const image = source.data as ImageBitmap | { width?: number; height?: number } | null
    if (!image) continue
    for (const texture of textures) texture.userData.gpuSize = [image.width ?? 0, image.height ?? 0]
    source.data = null
    if (typeof (image as ImageBitmap).close === 'function') (image as ImageBitmap).close()
    releasedCount++
  }
}

/** Some CPU copy is gone: what was on the GPU cannot be uploaded again (after a lost context). */
export function anyReleased(): boolean {
  return releasedCount > 0
}

if (REPLAY_DEBUG) Object.assign(window, { replayProfile })
