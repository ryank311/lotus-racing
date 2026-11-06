/// <reference types="vite/client" />
// KTX2 textures (KHR_texture_basisu) in the replay's glTF models: a track's
// or car's images as Basis Universal, transcoded in workers to a format the
// GPU samples compressed (ASTC on an iPad, BC7 or ASTC on a desktop): about
// a quarter of the memory of decoded images, and no image decode or RGBA
// upload on the main thread. Models without them load as before.
//
// One KTX2Loader for the page: it keeps the transcoder and a pool of
// workers. The first renderer tells it what the GPU reads (configureKtx2);
// parseGltf hands it to a GLTFLoader. The transcoder (three's
// basis_transcoder.js and .wasm) is served from the app's own origin as
// build assets, and run in workers of the app's own (basisWorker.ts): the
// transcoder builds functions from strings, which the page's CSP forbids
// and a worker from a script of the app's origin is not held to.
//
// On a constrained device (budget.ts) a texture is capped by leaving out
// its top mip levels once transcoded (capCompressedTexture), fewer workers
// run, and they are let go whenever no model is loading: a worker's
// WebAssembly memory grows to its largest texture and is never given back.

import * as THREE from 'three'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { capCompressedTexture, replayProfile } from './budget'

// KTX2Loader fetches <path>basis_transcoder.js and .wasm; they are hashed
// build assets here, so the loader's manager maps those two names.
const TRANSCODER_PATH = 'basis-transcoder/'
let transcoder: { js: string; wasm: string } | null = null
let transcoderUrls: Promise<void> | null = null
let shared: KTX2Loader | null = null
let configured = false
let parsing = 0

function sharedLoader(): KTX2Loader {
  if (shared) return shared
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(url => {
    if (url === `${TRANSCODER_PATH}basis_transcoder.js`) return transcoder?.js ?? url
    if (url === `${TRANSCODER_PATH}basis_transcoder.wasm`) return transcoder?.wasm ?? url
    return url
  })
  const loader = new KTX2Loader(manager).setTranscoderPath(TRANSCODER_PATH).setWorkerLimit(replayProfile().constrained ? 2 : 4)
  shared = loader
  // KTX2Loader's own workers start from a blob: URL under the page's CSP,
  // where the transcoder cannot run (basisWorker.ts): ours run its worker
  // source instead, from a script of the app's origin.
  const internals = loader as unknown as {
    init(): Promise<void>
    workerSourceURL: string
    transcoderBinary: ArrayBuffer
    workerConfig: unknown
    workerPool: { setWorkerCreator(create: () => Worker): void }
  }
  const init = internals.init.bind(loader)
  let ready: Promise<void> | null = null
  internals.init = () => ready ??= init().then(async () => {
    const body = await (await fetch(internals.workerSourceURL)).text()
    internals.workerPool.setWorkerCreator(() => {
      const worker = new Worker(new URL('./basisWorker.ts', import.meta.url), { type: 'module' })
      worker.postMessage({ type: 'bootstrap', body })
      const transcoderBinary = internals.transcoderBinary.slice(0)
      worker.postMessage({ type: 'init', config: internals.workerConfig, transcoderBinary }, [transcoderBinary])
      return worker
    })
  }).catch(error => {
    ready = null
    throw error
  })
  return loader
}

// Imported when first needed (never in the Node tests that load car.ts).
function loadTranscoderUrls(): Promise<void> {
  transcoderUrls ??= Promise.all([
    import('three/examples/jsm/libs/basis/basis_transcoder.js?url&no-inline'),
    import('three/examples/jsm/libs/basis/basis_transcoder.wasm?url&no-inline'),
  ]).then(([js, wasm]) => { transcoder = { js: js.default, wasm: wasm.default } }, error => {
    transcoderUrls = null
    throw error
  })
  return transcoderUrls
}

/**
 * Tells the shared KTX2 loader which compressed formats the GPU reads.
 * Called once a WebGLRenderer exists (the replay's engine, the Garage's
 * viewer); every renderer on a device answers the same, so the loader and
 * its workers outlive any one of them.
 */
export function configureKtx2(renderer: THREE.WebGLRenderer) {
  if (renderer.getContext().isContextLost()) return
  const loader = sharedLoader()
  const before = JSON.stringify(loader.workerConfig)
  loader.detectSupport(renderer)
  configured = true
  // Workers take the formats as they start: idle ones with others go.
  if (before !== 'null' && before !== JSON.stringify(loader.workerConfig) && !parsing) loader.workerPool.dispose()
}

/** The shared loader, or one like it that caps each texture at `max` px on its long side. */
function ktx2Loader(max: number): KTX2Loader {
  const loader = sharedLoader()
  if (!Number.isFinite(max)) return loader
  const capped = <T extends THREE.CompressedTexture>(onLoad?: (texture: T) => void) => (texture: T) => onLoad?.(capCompressedTexture(texture, max))
  // GLTFLoader calls parse (images in the .glb) or load (separate files).
  return Object.assign(Object.create(loader) as KTX2Loader, {
    parse: (buffer: ArrayBuffer, onLoad?: (texture: THREE.CompressedTexture) => void, onError?: (error: unknown) => void) => loader.parse(buffer, capped(onLoad), onError),
    load: (url: string, onLoad: (texture: THREE.CompressedTexture) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void) => loader.load(url, capped(onLoad), onProgress, onError),
  })
}

// The slots GLTFLoader reads as colour (sRGB); every other one holds data.
const COLOUR_SLOTS = new Set(['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'])

/**
 * A KTX2 image carries its own transfer function, and an encoder may tag
 * every image sRGB: three would then read normals, roughness and the like
 * through the sRGB curve. A compressed texture used only for data reads its
 * values as they are, as GLTFLoader leaves its PNG and JPEG data textures.
 */
function dataTexturesLinear(root: THREE.Object3D) {
  const colour = new Set<THREE.Texture>(), data = new Set<THREE.Texture>()
  root.traverse(object => {
    const material = (object as THREE.Mesh).material
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const [slot, value] of Object.entries(m)) {
        if ((value as THREE.CompressedTexture | null)?.isCompressedTexture) (COLOUR_SLOTS.has(slot) ? colour : data).add(value as THREE.Texture)
      }
    }
  })
  for (const texture of data) if (!colour.has(texture)) texture.colorSpace = THREE.NoColorSpace
}

/**
 * Parses a .glb with `loader`, its KTX2 textures transcoded by the shared
 * loader and capped at `textureMax` px on the long side (budget.ts;
 * Infinity: as authored). Without configureKtx2 first, a model whose
 * textures are KTX2 only fails to load.
 */
export async function parseGltf(loader: GLTFLoader, buffer: ArrayBuffer, textureMax = Infinity): Promise<GLTF> {
  parsing++
  try {
    if (configured) {
      try {
        await loadTranscoderUrls()
        loader.setKTX2Loader(ktx2Loader(textureMax))
      } catch (error) { console.warn('[replay] KTX2 transcoder unavailable', error) }
    }
    const gltf = await loader.parseAsync(buffer, '')
    for (const scene of gltf.scenes) dataTexturesLinear(scene)
    return gltf
  } finally {
    // Every texture is in once parsed: a constrained device lets the workers go.
    if (--parsing === 0 && shared && replayProfile().lean) shared.workerPool.dispose()
  }
}
