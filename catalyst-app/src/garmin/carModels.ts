// The 3D replay's car models: .glb files the drivers supply, shared by every
// driver on a server (desktop: one library per workspace). Kept in one
// folder as the .glb files plus models.json, which holds their names,
// credits, the vehicles that use them and how each sits in the car frame.
//
// A .glb copied into the folder by hand is registered the next time the
// library is read: it is checked like an upload, named and credited from its
// asset.extras (Sketchfab's title, author, licence and source), and matched
// to the vehicles whose model word its title names. The file stays where it
// is, so the folder may belong to another user as long as it is readable.
//
// Models are third-party work: they are never part of the repository.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  glbCredits, glbJsonLength, MAX_CAR_MODEL_BYTES, presetFor, presetKeysIn,
  type CarModel, type CarModelFit,
} from '../shared/replay.js'

export const CAR_MODEL_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/
const MAX_JSON_CHUNK = 64 * 1024 * 1024

export interface CarModelMeta {
  name: string
  attribution: string | null
  matches: string[]
}

export type CarModelPatch = Partial<Pick<CarModel, 'name' | 'attribution' | 'matches' | 'fit'>>

// models.json: the public fields plus the file's name in the folder.
interface Entry extends CarModel { file: string }
interface Index { version: 1; models: Entry[] }

// ─── Checks ─────────────────────────────────────────────────────────────────

/** Reads and checks a .glb's header and JSON chunk; throws a message for the driver otherwise. */
export async function readGlbJson(file: string): Promise<{ gltf: Record<string, any>; sizeBytes: number }> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size > MAX_CAR_MODEL_BYTES) throw new Error(`That model is larger than ${MAX_CAR_MODEL_BYTES / 1024 ** 2} MB.`)
    const head = Buffer.alloc(20)
    await handle.read(head, 0, 20, 0)
    const jsonLength = glbJsonLength(head)
    if (jsonLength == null) throw new Error('That is not a glTF 2 binary (.glb) file.')
    if (head.readUInt32LE(8) !== size) throw new Error('That .glb file is incomplete.')
    if (jsonLength > MAX_JSON_CHUNK || 20 + jsonLength > size) throw new Error('That .glb file is damaged.')
    const json = Buffer.alloc(jsonLength)
    await handle.read(json, 0, jsonLength, 20)
    let gltf: unknown
    try { gltf = JSON.parse(json.toString('utf8')) } catch { throw new Error('That .glb file’s scene description could not be read.') }
    const version = (gltf as any)?.asset?.version
    if (!gltf || typeof gltf !== 'object' || typeof version !== 'string' || !version.startsWith('2')) {
      throw new Error('That .glb file is not glTF 2.')
    }
    return { gltf: gltf as Record<string, any>, sizeBytes: size }
  } finally {
    await handle.close()
  }
}

const cleanText = (value: unknown, max: number): string | null => {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('Invalid text')
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return text || null
}

/** Vehicle keys as vehicleKey() writes them ("LOTUS EXIGE"), deduplicated. */
export function cleanMatches(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 50) throw new Error('Invalid vehicle list')
  const keys = value.map(v => cleanText(v, 80)?.toUpperCase()).filter((v): v is string => !!v)
  return [...new Set(keys)]
}

export function cleanFit(value: unknown): CarModelFit {
  const f = value as CarModelFit
  const n = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
  const triple = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(x => n(x, 50))
  if (!f || typeof f !== 'object' || !n(f.yawDeg, 360) || !n(f.lengthM, 30) || f.lengthM < 0.5 || !triple(f.offsetM) || !triple(f.eyeM)) {
    throw new Error('Invalid model fit')
  }
  // The Garmin camera's mount, lens and tilt are optional.
  if ((f.dashcamM != null && !triple(f.dashcamM))
    || (f.dashcamFovDeg != null && (!n(f.dashcamFovDeg, 170) || f.dashcamFovDeg < 40))
    || (f.dashcamPitchDeg != null && !n(f.dashcamPitchDeg, 45))) {
    throw new Error('Invalid model fit')
  }
  return {
    yawDeg: f.yawDeg, lengthM: f.lengthM, offsetM: [...f.offsetM], eyeM: [...f.eyeM],
    ...(f.dashcamM != null ? { dashcamM: [...f.dashcamM] as [number, number, number] } : {}),
    ...(f.dashcamFovDeg != null ? { dashcamFovDeg: f.dashcamFovDeg } : {}),
    ...(f.dashcamPitchDeg != null ? { dashcamPitchDeg: f.dashcamPitchDeg } : {}),
  }
}

const fitFor = (matches: string[]): CarModelFit => structuredClone(presetFor(matches[0] ?? null).fit)
const publicModel = ({ file: _file, ...model }: Entry): CarModel => model
const fileTitle = (fileName: string) => path.basename(fileName).replace(/\.glb$/i, '').replace(/[_]+/g, ' ').trim()

// ─── Library ────────────────────────────────────────────────────────────────

export class CarModelLibrary {
  private index: Index | null = null
  private writes: Promise<unknown> = Promise.resolve()
  // Files that could not be registered, by name: tried again once they change.
  private readonly rejected = new Map<string, number>()

  constructor(readonly dir: string, private readonly log: (message: string) => void = message => console.log(message)) {}

  /** Where uploads collect before they are checked. */
  get incomingDir(): string { return path.join(this.dir, '.incoming') }

  /** Every model, registering any .glb dropped into the folder by hand. */
  list(): Promise<CarModel[]> {
    return this.serial(async () => {
      const index = await this.load()
      let changed = false
      let names: string[] = []
      try { names = await fs.promises.readdir(this.dir) } catch { /* no folder yet */ }
      // A file removed by hand leaves the library.
      const present = new Set(names)
      const kept = index.models.filter(m => present.has(m.file))
      if (kept.length !== index.models.length) { index.models = kept; changed = true }
      const known = new Set(index.models.map(m => m.file))
      for (const name of names.filter(n => /\.glb$/i.test(n) && !n.startsWith('.') && !known.has(n)).sort()) {
        const stamp = await fs.promises.stat(path.join(this.dir, name)).then(s => s.mtimeMs + s.size, () => NaN)
        if (this.rejected.get(name) === stamp) continue
        try {
          index.models.push(await this.register(name, index))
          changed = true
          this.rejected.delete(name)
          this.log(`[car models] registered ${name}`)
        } catch (error) {
          this.rejected.set(name, stamp)
          this.log(`[car models] ${name} was not registered: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (changed) await this.save(index)
      return index.models.map(publicModel).sort((a, b) => a.name.localeCompare(b.name))
    })
  }

  /** The .glb file of a model, or null. */
  async file(id: unknown): Promise<string | null> {
    if (typeof id !== 'string' || !CAR_MODEL_ID_RE.test(id)) return null
    const entry = (await this.serial(() => this.load())).models.find(m => m.id === id)
    if (!entry) return null
    const file = path.join(this.dir, entry.file)
    return fs.existsSync(file) ? file : null
  }

  /**
   * Adds a finished upload at `source` (moved into the folder). The name and
   * credit fall back to the file's asset.extras; the fit to the first
   * vehicle's preset. A file that is not a glTF 2 binary is deleted.
   */
  add(source: string, fileName: string, meta: Partial<CarModelMeta>): Promise<CarModel> {
    return this.serial(async () => {
      let checked: Awaited<ReturnType<typeof readGlbJson>>
      try { checked = await readGlbJson(source) } catch (error) {
        await fs.promises.rm(source, { force: true })
        throw error
      }
      const credits = glbCredits(checked.gltf)
      const index = await this.load()
      const id = randomUUID()
      const matches = cleanMatches(meta.matches)
      const entry: Entry = {
        id, file: `${id}.glb`,
        name: cleanText(meta.name, 120) ?? credits.name ?? (fileTitle(fileName) || 'Car model'),
        fileName: path.basename(fileName).slice(0, 200) || `${id}.glb`,
        sizeBytes: checked.sizeBytes,
        attribution: cleanText(meta.attribution, 500) ?? credits.attribution,
        matches, fit: fitFor(matches), uploadedAt: new Date().toISOString(),
      }
      await fs.promises.mkdir(this.dir, { recursive: true })
      await fs.promises.rename(source, path.join(this.dir, entry.file))
      index.models.push(entry)
      await this.save(index)
      return publicModel(entry)
    })
  }

  /** Desktop: copy a picked file into the folder, then add it. */
  async importFile(sourcePath: string, fileName: string, meta: Partial<CarModelMeta>): Promise<CarModel> {
    const { size } = await fs.promises.stat(sourcePath)
    if (size > MAX_CAR_MODEL_BYTES) throw new Error(`That model is larger than ${MAX_CAR_MODEL_BYTES / 1024 ** 2} MB.`)
    await fs.promises.mkdir(this.incomingDir, { recursive: true })
    const part = path.join(this.incomingDir, `${randomUUID()}.part`)
    await fs.promises.copyFile(sourcePath, part)
    return this.add(part, fileName, meta)
  }

  update(id: unknown, patch: unknown): Promise<CarModel> {
    return this.serial(async () => {
      const index = await this.load()
      const entry = index.models.find(m => m.id === id)
      if (!entry) throw new Error('That car model is no longer in the library.')
      const p = (patch ?? {}) as Record<string, unknown>
      if (typeof p !== 'object') throw new Error('Invalid change')
      if ('name' in p) entry.name = cleanText(p.name, 120) ?? entry.name
      if ('attribution' in p) entry.attribution = cleanText(p.attribution, 500)
      if ('matches' in p) entry.matches = cleanMatches(p.matches)
      if ('fit' in p) entry.fit = cleanFit(p.fit)
      await this.save(index)
      return publicModel(entry)
    })
  }

  remove(id: unknown): Promise<boolean> {
    return this.serial(async () => {
      const index = await this.load()
      const entry = index.models.find(m => m.id === id)
      if (!entry) return false
      // The file first: a model whose file stays would be registered again.
      await fs.promises.rm(path.join(this.dir, entry.file), { force: true })
      index.models = index.models.filter(m => m !== entry)
      await this.save(index)
      return true
    })
  }

  // One change at a time, so models.json never loses a concurrent edit.
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task, task)
    this.writes = run.catch(() => {})
    return run
  }

  private async load(): Promise<Index> {
    if (this.index) return this.index
    let index: Index = { version: 1, models: [] }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'models.json'), 'utf8'))
      if (Array.isArray(parsed?.models)) {
        index = { version: 1, models: parsed.models.filter((m: Entry) => m && typeof m.id === 'string' && CAR_MODEL_ID_RE.test(m.id) && typeof m.file === 'string' && path.basename(m.file) === m.file) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[car models] models.json could not be read: ${error instanceof Error ? error.message : error}`)
    }
    this.index = index
    return index
  }

  // Written atomically. A folder the server cannot write (copied in as
  // root, say) keeps working from memory and says so.
  private async save(index: Index): Promise<void> {
    const file = path.join(this.dir, 'models.json')
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.promises.mkdir(this.dir, { recursive: true })
      await fs.promises.writeFile(tmp, JSON.stringify(index, null, 2))
      await fs.promises.rename(tmp, file)
    } catch (error) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
      this.log(`[car models] could not save ${file} (${error instanceof Error ? error.message : error}); changes last until the server restarts. Make the folder writable by the server.`)
    }
  }

  // A .glb found in the folder: named and credited from its asset.extras.
  private async register(name: string, index: Index): Promise<Entry> {
    const file = path.join(this.dir, name)
    const checked = await readGlbJson(file)
    const credits = glbCredits(checked.gltf)
    const title = credits.name ?? fileTitle(name)
    const base = name.replace(/\.glb$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'model'
    let id = base
    for (let n = 2; index.models.some(m => m.id === id); n++) id = `${base}-${n}`
    const matches = presetKeysIn(title)
    const { mtime } = await fs.promises.stat(file)
    return {
      id, file: name, name: title || 'Car model', fileName: name, sizeBytes: checked.sizeBytes,
      attribution: credits.attribution, matches, fit: fitFor(matches), uploadedAt: mtime.toISOString(),
    }
  }
}
