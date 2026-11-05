// The 3D replay's track models: user-supplied 3D tracks (converted sim
// tracks, say), shared by every driver on a server (desktop: one library per
// workspace). One folder per model:
//
//   <dir>/<id>/track.json   name, credits, trackName, layouts → files, georef,
//                           footprint (see TrackModel in shared/replay.ts)
//   <dir>/<id>/*.glb        the model, split however the layouts share it
//   <dir>/.cache/<id>/      gzipped copies of the .glb files, made on first use
//
// A folder copied in by hand is registered the next time the library is
// read: its track.json and the files it names are checked, and it is left
// out (and logged once) until they are valid. Nothing in the folder is ever
// changed, so it may belong to another user as long as it is readable.
//
// Models are third-party work: they are never part of the repository.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import {
  glbJsonLength, MAX_TRACK_MODEL_FILE_BYTES,
  type TrackModel, type TrackModelFile, type TrackModelFootprint, type TrackModelGeoref, type TrackModelLayout,
} from '../shared/replay.js'

export const TRACK_MODEL_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/
// Plain file names in the model's folder; no paths.
export const TRACK_MODEL_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._()-]{0,150}\.(glb|png|jpg|jpeg|webp)$/i
const MANIFEST = 'track.json'
const MAX_MANIFEST_BYTES = 1024 * 1024

export const TRACK_MODEL_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
}

/** A model as the library keeps it: the public fields plus where its files are. */
interface Entry {
  model: TrackModel
  dir: string
  /** mtime + size of track.json and every file, so a change re-reads the folder. */
  stamp: string
  /** Version per file name (size and mtime), for cache-busting URLs and gzip copies. */
  versions: Map<string, string>
}

// ─── Checks ─────────────────────────────────────────────────────────────────

const finite = (v: unknown, max = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null)

export function cleanGeoref(value: unknown): TrackModelGeoref {
  const g = value as TrackModelGeoref
  if (!g || typeof g !== 'object') throw new Error('georef is missing')
  if (!finite(g.originLat, 90) || !finite(g.originLon, 180)) throw new Error('georef.originLat/originLon are not a position')
  if (!finite(g.rotationDeg, 360)) throw new Error('georef.rotationDeg is not an angle')
  if (!finite(g.scale) || g.scale < 0.5 || g.scale > 2) throw new Error('georef.scale must be between 0.5 and 2')
  if (!Array.isArray(g.offsetM) || g.offsetM.length !== 3 || !g.offsetM.every(v => finite(v, 100_000))) throw new Error('georef.offsetM must be three numbers')
  const flips = g.flips && typeof g.flips === 'object' ? { x: g.flips.x === true, z: g.flips.z === true } : { x: false, z: false }
  return { originLat: g.originLat, originLon: g.originLon, rotationDeg: g.rotationDeg, scale: g.scale, offsetM: [g.offsetM[0], g.offsetM[1], g.offsetM[2]], flips }
}

function cleanFootprint(value: unknown): TrackModelFootprint | null {
  if (value == null) return null
  const f = value as TrackModelFootprint
  if (typeof f !== 'object' || typeof f.file !== 'string' || !TRACK_MODEL_FILE_RE.test(f.file) || !/\.png$/i.test(f.file)) throw new Error('footprint.file must be a .png in the folder')
  if (!finite(f.x0, 100_000) || !finite(f.z0, 100_000) || !finite(f.cellM) || f.cellM <= 0 || f.cellM > 1000) throw new Error('footprint placement is invalid')
  const size = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 16384
  if (!size(f.width) || !size(f.height)) throw new Error('footprint size is invalid')
  return { file: f.file, x0: f.x0, z0: f.z0, cellM: f.cellM, width: f.width, height: f.height }
}

function cleanLayouts(value: unknown): Record<string, TrackModelLayout> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('layouts must map configuration names to files')
  const out: Record<string, TrackModelLayout> = {}
  for (const [name, layout] of Object.entries(value as Record<string, unknown>)) {
    const key = text(name, 120)
    const files = (layout as TrackModelLayout)?.files
    if (!key || !Array.isArray(files) || !files.length || files.length > 32) throw new Error(`layout "${name}" needs a list of files`)
    for (const file of files) if (typeof file !== 'string' || !TRACK_MODEL_FILE_RE.test(file) || !/\.glb$/i.test(file)) throw new Error(`layout "${name}": "${file}" is not a .glb in the folder`)
    out[key] = { files: [...new Set(files as string[])] }
  }
  if (!Object.keys(out).length) throw new Error('layouts is empty')
  return out
}

function cleanPattern(value: unknown): string | null {
  const source = text(value, 200)
  if (!source) return null
  try { new RegExp(source, 'i') } catch { throw new Error('drivablePattern is not a regular expression') }
  return source
}

/** Checks a .glb's header: glTF 2 binary, complete. */
async function checkGlb(file: string, size: number): Promise<void> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const head = Buffer.alloc(20)
    await handle.read(head, 0, 20, 0)
    if (glbJsonLength(head) == null) throw new Error(`${path.basename(file)} is not a glTF 2 binary (.glb)`)
    if (head.readUInt32LE(8) !== size) throw new Error(`${path.basename(file)} is incomplete`)
  } finally {
    await handle.close()
  }
}

const versionOf = (stat: fs.Stats) => createHash('sha1').update(`${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 12)

// ─── Library ────────────────────────────────────────────────────────────────

export class TrackModelLibrary {
  private entries = new Map<string, Entry>()
  // Folders that could not be registered, by id: tried again once they change.
  private readonly rejected = new Map<string, string>()
  private reading: Promise<TrackModel[]> | null = null
  private readonly gzipping = new Map<string, Promise<string | null>>()

  constructor(readonly dir: string, private readonly log: (message: string) => void = message => console.log(message)) {}

  get cacheDir(): string { return path.join(this.dir, '.cache') }

  /** Every valid model, registering folders added (or changed) by hand. One read at a time. */
  list(): Promise<TrackModel[]> {
    if (!this.reading) this.reading = this.read().finally(() => { this.reading = null })
    return this.reading
  }

  /** The listing for the web: each model with its files' versions (for cache-busting URLs). */
  async listWithVersions(): Promise<Array<TrackModel & { versions: Record<string, string> }>> {
    const models = await this.list()
    return models.map(model => ({ ...model, versions: Object.fromEntries(this.entries.get(model.id)?.versions ?? []) }))
  }

  private async read(): Promise<TrackModel[]> {
    let names: string[] = []
    try { names = (await fs.promises.readdir(this.dir, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name) } catch { /* no folder yet */ }
    const present = new Set(names)
    for (const id of [...this.entries.keys()]) if (!present.has(id)) { this.entries.delete(id); this.log(`[track models] ${id} was removed`) }
    for (const id of names.sort()) {
      if (!TRACK_MODEL_ID_RE.test(id)) continue
      const dir = path.join(this.dir, id)
      const stamp = await this.stampOf(dir)
      if (stamp == null) { this.entries.delete(id); continue }
      if (this.entries.get(id)?.stamp === stamp || this.rejected.get(id) === stamp) continue
      try {
        const entry = await this.register(id, dir, stamp)
        const known = this.entries.has(id)
        this.entries.set(id, entry)
        this.rejected.delete(id)
        this.log(`[track models] ${known ? 'updated' : 'registered'} ${id} (${Object.keys(entry.model.layouts).join(', ')})`)
        // Compress the models now, so the first replay is served gzipped.
        for (const file of entry.model.files) if (/\.glb$/i.test(file.name)) void this.gzipped(id, file.name).catch(() => {})
      } catch (error) {
        this.entries.delete(id)
        this.rejected.set(id, stamp)
        this.log(`[track models] ${id} was not registered: ${error instanceof Error ? error.message : error}`)
      }
    }
    return [...this.entries.values()].map(e => e.model).sort((a, b) => a.name.localeCompare(b.name))
  }

  // A folder's state: track.json and the files beside it (null without track.json).
  private async stampOf(dir: string): Promise<string | null> {
    try {
      const names = (await fs.promises.readdir(dir)).filter(n => n === MANIFEST || TRACK_MODEL_FILE_RE.test(n)).sort()
      if (!names.includes(MANIFEST)) return null
      const parts: string[] = []
      for (const name of names) {
        const stat = await fs.promises.stat(path.join(dir, name))
        parts.push(`${name}:${stat.size}:${stat.mtimeMs}`)
      }
      return parts.join('|')
    } catch { return null }
  }

  private async register(id: string, dir: string, stamp: string): Promise<Entry> {
    const manifestPath = path.join(dir, MANIFEST)
    const { size } = await fs.promises.stat(manifestPath)
    if (size > MAX_MANIFEST_BYTES) throw new Error('track.json is too large')
    let raw: Record<string, unknown>
    try { raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) } catch { throw new Error('track.json is not valid JSON') }
    if (!raw || typeof raw !== 'object') throw new Error('track.json is not an object')
    const trackName = text(raw.trackName, 200)
    if (!trackName) throw new Error('track.json needs a trackName (the facility as Garmin names it)')
    const layouts = cleanLayouts(raw.layouts)
    const georef = cleanGeoref(raw.georef)
    const footprint = cleanFootprint(raw.footprint)
    const drivablePattern = cleanPattern(raw.drivablePattern)
    const names = new Set(Object.values(layouts).flatMap(l => l.files))
    if (footprint) names.add(footprint.file)
    const files: TrackModelFile[] = []
    const versions = new Map<string, string>()
    let total = 0, newest = 0
    for (const name of [...names].sort()) {
      let stat: fs.Stats
      try { stat = await fs.promises.stat(path.join(dir, name)) } catch { throw new Error(`${name} is missing`) }
      if (!stat.isFile()) throw new Error(`${name} is not a file`)
      if (stat.size > MAX_TRACK_MODEL_FILE_BYTES) throw new Error(`${name} is larger than ${MAX_TRACK_MODEL_FILE_BYTES / 1024 ** 2} MB`)
      if (/\.glb$/i.test(name)) await checkGlb(path.join(dir, name), stat.size)
      files.push({ name, sizeBytes: stat.size })
      versions.set(name, versionOf(stat))
      total += stat.size
      newest = Math.max(newest, stat.mtimeMs)
    }
    const model: TrackModel = {
      id, name: text(raw.name, 120) ?? id, attribution: text(raw.attribution, 500), trackName,
      layouts, georef, footprint, drivablePattern, files, sizeBytes: total, updatedAt: new Date(newest).toISOString(),
    }
    return { model, dir, stamp, versions }
  }

  /** A model's file (one its track.json names), or null. */
  async file(id: unknown, name: unknown): Promise<{ path: string; version: string; type: string } | null> {
    if (typeof id !== 'string' || !TRACK_MODEL_ID_RE.test(id) || typeof name !== 'string' || !TRACK_MODEL_FILE_RE.test(name)) return null
    if (!this.entries.has(id)) await this.list()
    const entry = this.entries.get(id)
    const version = entry?.versions.get(name)
    if (!entry || !version) return null
    const file = path.join(entry.dir, name)
    if (!fs.existsSync(file)) return null
    return { path: file, version, type: TRACK_MODEL_TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream' }
  }

  /**
   * A gzipped copy of a model's file, made on first use (one build per file
   * at a time) in the cache folder; null when it cannot be made (a folder
   * the server cannot write), and the file is served as it is.
   */
  async gzipped(id: string, name: string): Promise<string | null> {
    const source = await this.file(id, name)
    if (!source) return null
    const target = path.join(this.cacheDir, id, `${name}.${source.version}.gz`)
    if (fs.existsSync(target)) return target
    const key = target
    let job = this.gzipping.get(key)
    if (!job) {
      job = (async () => {
        const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
        try {
          await fs.promises.mkdir(path.dirname(target), { recursive: true })
          // Older versions of this file go.
          for (const old of await fs.promises.readdir(path.dirname(target))) {
            if (old.startsWith(`${name}.`) && old.endsWith('.gz') && old !== path.basename(target)) await fs.promises.rm(path.join(path.dirname(target), old), { force: true })
          }
          await pipeline(fs.createReadStream(source.path), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp))
          await fs.promises.rename(tmp, target)
          return target
        } catch (error) {
          await fs.promises.rm(tmp, { force: true }).catch(() => {})
          this.log(`[track models] could not compress ${id}/${name}: ${error instanceof Error ? error.message : error}`)
          return null
        } finally {
          this.gzipping.delete(key)
        }
      })()
      this.gzipping.set(key, job)
    }
    return job
  }
}
