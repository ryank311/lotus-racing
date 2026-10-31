/**
 * Track layouts as each driver sees them: the named corners and corner
 * complexes of a course, on that driver's own mean line.
 *
 * Layouts are stored once per course in the shared track library
 * (trackLibrary.ts), so every driver on a server sees and edits the same
 * corners. Their positions are metres along the mean line they were drawn on;
 * a driver whose device recorded a different mean line for the course gets
 * them moved onto theirs (by projecting one line onto the other, see
 * meanLineAlign.ts), and their edits moved back.
 *
 * Track YAML files (tracks/*.yaml) are seeds only: a course's file is
 * imported when the library has no layout for it, and never read again for a
 * course that has one. Layouts saved in a driver's workspace before the
 * library existed are copied into it once (shareWorkspaceTrackLayouts).
 *
 * Complexes store only their boundaries and an optional name the driver typed.
 * Corner lists and default names are computed from the current corners on
 * every read, so editing corners can never leave a stale label behind.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DuckDBConnection } from '@duckdb/node-api'
import { TRACKS_DIR } from './paths.js'
import { loadTrackYaml, seedFileName, type TrackComplex, type TrackCorner, type TrackSegment, type TrackYaml } from './trackYaml.js'
import { cornerSpanLabel, labelComplexes, type ComplexDef } from './lapPhases.js'
import { distanceMap, invertMap, mapPosition, readMeanLineFile, thinTrace, type DistanceMap, type MeanLineFile, type MeanLineTrace } from './meanLineAlign.js'
import {
  hasCourseIdentity, matchCourse, trackLibrary,
  type ComplexOrigin, type CourseRef, type LayoutInput, type LibraryLayout, type StoredComplex,
} from './trackLibrary.js'

export type { TrackCorner, TrackSegment } from './trackYaml.js'
export type { ComplexOrigin, StoredComplex } from './trackLibrary.js'

export interface TrackLayout {
  meanLineGuid: string
  trackName: string | null
  configName: string | null
  totalDistM: number | null
  segments: TrackSegment[]
  corners: TrackCorner[]
  complexes: StoredComplex[]
  complexesOrigin: ComplexOrigin | null
}

export interface LayoutIdentity {
  trackName: string | null
  configName: string | null
  totalDistM: number | null
  segments: TrackSegment[]
}

export interface SessionLayoutRef {
  mean_line_guid: string | null
  track_name: string | null
  track_configuration_name: string | null
  track_configuration_id?: number | null
}

// Reference lines travel at about one point every 2 m: plenty to project.
const REFERENCE_STEP_M = 2

async function rows(con: DuckDBConnection, sql: string, params: any[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params)).getRowObjectsJson()
}

async function hasTable(con: DuckDBConnection, name: string): Promise<boolean> {
  return (await rows(con, 'SELECT 1 AS found FROM information_schema.tables WHERE table_name = ?', [name])).length > 0
}

const finiteOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const textOrNull = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

// ─── This workspace's mean lines ───────────────────────────────────────────

// A mean line's points never change for its ID, so a file read once stays.
const lineFiles = new Map<string, MeanLineFile>()
function localLine(guid: string | null | undefined): MeanLineFile | null {
  if (!guid) return null
  const cached = lineFiles.get(guid)
  if (cached) return cached
  const file = readMeanLineFile(guid)
  if (file) lineFiles.set(guid, file)
  return file
}

const referenceOf = (guid: string): MeanLineTrace | null => {
  const trace = localLine(guid)?.trace
  return trace ? thinTrace(trace, REFERENCE_STEP_M) : null
}

// The course a mean line was driven on: from this workspace's sessions, else
// the mean line file, else a seed file naming it.
async function courseFromWorkspace(con: DuckDBConnection, guid: string): Promise<CourseRef> {
  const session = (await rows(con, `
    SELECT s.track_configuration_id AS id,
      COALESCE(s.track_name, tc.track_name) AS track, COALESCE(s.track_configuration_name, tc.track_configuration_name) AS config,
      COUNT(*) AS n
    FROM sessions s LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    WHERE s.mean_line_guid = ? GROUP BY ALL ORDER BY n DESC LIMIT 1`, [guid]))[0]
  const file = localLine(guid)?.course
  return {
    configurationId: finiteOrNull(session?.id) ?? file?.configurationId ?? null,
    trackName: textOrNull(session?.track) ?? file?.trackName ?? null,
    configName: textOrNull(session?.config) ?? file?.configName ?? null,
  }
}

async function courseOfLine(con: DuckDBConnection, guid: string, dir = TRACKS_DIR): Promise<CourseRef> {
  const course = await courseFromWorkspace(con, guid)
  if (hasCourseIdentity(course)) return course
  const seed = readSeeds(dir).find(s => textOrNull(s.yaml.mean_line_guid) === guid)
  return seed ? { configurationId: null, trackName: textOrNull(seed.yaml.track_name), configName: textOrNull(seed.yaml.track_configuration_name) } : course
}

// ─── Moving positions between mean lines ───────────────────────────────────

interface Placement {
  identity: boolean
  toLine(referenceM: number): number
  fromLine(lineM: number): number
  totalM: number | null
}

const IDENTITY = (totalM: number | null): Placement => ({ identity: true, toLine: x => x, fromLine: x => x, totalM })

// Projections between two lines are fixed, so each pair is computed once.
const maps = new Map<string, DistanceMap>()
const referenceLines = new Map<string, MeanLineTrace>()

// How a stored layout's positions land on one of this workspace's mean lines.
async function placement(layout: LibraryLayout, guid: string | null): Promise<Placement> {
  const reference = layout.referenceLineGuid
  if (!guid || !reference || reference === guid) return IDENTITY(layout.totalDistM)
  const own = localLine(guid)?.trace
  if (!own) return IDENTITY(layout.totalDistM)
  const key = `${reference}>${guid}`
  let map = maps.get(key)
  if (!map) {
    const line = referenceLines.get(reference) ?? await trackLibrary().referenceLine(reference)
    if (line) {
      referenceLines.set(reference, line)
      map = distanceMap(line, own)
      maps.set(key, map)
    } else if (layout.totalDistM && layout.totalDistM > 0) {
      // The reference line's points are not shared yet: scale its length.
      map = [[0, 0], [layout.totalDistM, own.totalM]]
    } else {
      return IDENTITY(layout.totalDistM)
    }
  }
  const forward = map, back = invertMap(map)
  return { identity: false, toLine: x => mapPosition(forward, x), fromLine: y => mapPosition(back, y), totalM: own.totalM }
}

// Positions on another line land on whole metres, as they were drawn.
const onLine = (p: Placement) => (x: number) => (p.identity ? x : Math.round(p.toLine(x)))
const optional = (at: (x: number) => number, x: number | undefined) => (x == null ? x : at(x))

function layoutOnLine(layout: LibraryLayout, guid: string, p: Placement): TrackLayout {
  const at = onLine(p)
  return {
    meanLineGuid: guid,
    trackName: layout.trackName,
    configName: layout.configName,
    totalDistM: p.totalM,
    segments: p.identity ? layout.segments : layout.segments.map(s => {
      const out: TrackSegment = { ...s, start_dist_m: at(s.start_dist_m), end_dist_m: at(s.end_dist_m) }
      if (s.length_m != null) out.length_m = out.end_dist_m - out.start_dist_m
      return out
    }),
    corners: p.identity ? layout.corners : layout.corners.map(c => cornerAt(c, at)),
    complexes: p.identity ? layout.complexes : layout.complexes.map(c => ({ ...c, startM: at(c.startM), endM: at(c.endM) })),
    complexesOrigin: layout.complexesOrigin,
  }
}

function cornerAt(c: TrackCorner, at: (x: number) => number): TrackCorner {
  const out: TrackCorner = { ...c, apex_idx: at(c.apex_idx) }
  if (c.dist_idx_start != null) out.dist_idx_start = at(c.dist_idx_start)
  if (c.dist_idx_end != null) out.dist_idx_end = at(c.dist_idx_end)
  return out
}

// Edited positions back onto the reference line. Anything the driver left
// as it was keeps its stored position exactly, so saving from another mean
// line never nudges corners by a rounding metre.
function cornersToReference(corners: TrackCorner[], stored: LibraryLayout | null, p: Placement): TrackCorner[] {
  if (p.identity || !stored) return corners
  const at = onLine(p), back = (y: number) => Math.round(p.fromLine(y))
  return corners.map(c => {
    const before = stored.corners.find(s => s.turn === c.turn)
    const unchanged = before && at(before.apex_idx) === c.apex_idx
      && optional(at, before.dist_idx_start) === c.dist_idx_start && optional(at, before.dist_idx_end) === c.dist_idx_end
    if (unchanged) {
      const out: TrackCorner = { ...c, apex_idx: before.apex_idx }
      if (before.dist_idx_start != null) out.dist_idx_start = before.dist_idx_start
      if (before.dist_idx_end != null) out.dist_idx_end = before.dist_idx_end
      return out
    }
    return cornerAt(c, back)
  })
}

function complexesToReference(complexes: StoredComplex[], stored: LibraryLayout, p: Placement): StoredComplex[] {
  if (p.identity) return complexes
  const at = onLine(p), back = (y: number) => Math.round(p.fromLine(y))
  const position = (y: number, stored: number[]) => stored.find(x => at(x) === y) ?? back(y)
  const starts = stored.complexes.map(c => c.startM), ends = stored.complexes.map(c => c.endM)
  return complexes.map(c => ({ ...c, startM: position(c.startM, starts), endM: position(c.endM, ends) }))
}

// ─── Reading ────────────────────────────────────────────────────────────────

async function findWithSeeds(con: DuckDBConnection, course: CourseRef): Promise<LibraryLayout | null> {
  const found = await trackLibrary().find(course)
  if (found) return found
  return (await seedTrackLayouts(con, { course })).length ? trackLibrary().find(course) : null
}

/** The course's layout on this mean line, importing its seed file on first use. */
export async function getTrackLayout(con: DuckDBConnection, meanLineGuid: string | null | undefined): Promise<TrackLayout | null> {
  if (!meanLineGuid) return null
  const course = await courseOfLine(con, meanLineGuid)
  if (!hasCourseIdentity(course)) return null
  const layout = await findWithSeeds(con, course)
  return layout ? layoutOnLine(layout, meanLineGuid, await placement(layout, meanLineGuid)) : null
}

// A session without a mean line gets its course's layout as stored.
export async function layoutForSession(con: DuckDBConnection, session: SessionLayoutRef): Promise<TrackLayout | null> {
  if (session.mean_line_guid) return getTrackLayout(con, session.mean_line_guid)
  const course: CourseRef = {
    configurationId: finiteOrNull(session.track_configuration_id), trackName: textOrNull(session.track_name), configName: textOrNull(session.track_configuration_name),
  }
  if (!hasCourseIdentity(course)) return null
  const layout = await findWithSeeds(con, course)
  return layout ? layoutOnLine(layout, layout.referenceLineGuid ?? '', IDENTITY(layout.totalDistM)) : null
}

/** Complexes with IDs, corner lists and names computed from the current corners. */
export function layoutComplexes(layout: TrackLayout): ComplexDef[] {
  return labelComplexes(layout.corners, layout.complexes)
}

interface LocalLine { guid: string; course: CourseRef }

async function workspaceLines(con: DuckDBConnection): Promise<LocalLine[]> {
  try {
    const lines = await rows(con, 'SELECT DISTINCT mean_line_guid FROM sessions WHERE mean_line_guid IS NOT NULL ORDER BY 1')
    const out: LocalLine[] = []
    for (const r of lines) out.push({ guid: String(r.mean_line_guid), course: await courseFromWorkspace(con, String(r.mean_line_guid)) })
    return out
  } catch {
    return [] // no telemetry tables yet
  }
}

/** Corner count per mean line of this workspace whose course has a layout, for the Tracks list. */
export async function trackLayoutCornerCounts(con: DuckDBConnection): Promise<Map<string, number>> {
  await seedTrackLayouts(con)
  const library = await trackLibrary().list()
  const counts = new Map<string, number>()
  for (const line of await workspaceLines(con)) {
    const layout = matchCourse(library, line.course)
    if (layout) counts.set(line.guid, layout.cornerCount)
  }
  return counts
}

// ─── Saving ─────────────────────────────────────────────────────────────────

async function courseForSave(con: DuckDBConnection, meanLineGuid: string, identity?: Pick<LayoutIdentity, 'trackName' | 'configName'>): Promise<CourseRef> {
  const course = await courseOfLine(con, meanLineGuid)
  return { ...course, trackName: course.trackName ?? identity?.trackName ?? null, configName: course.configName ?? identity?.configName ?? null }
}

/**
 * Replace a course's corners from this mean line, creating its layout if
 * needed (drawn on this line). Derived complexes are dropped so the next read
 * re-derives them from the new corners; edited and imported complexes keep
 * their boundaries.
 */
export async function saveTrackCorners(
  con: DuckDBConnection, meanLineGuid: string, identity: LayoutIdentity, corners: TrackCorner[],
): Promise<void> {
  const course = await courseForSave(con, meanLineGuid, identity)
  // Import the seed first so its segments and complexes are not lost.
  const stored = await findWithSeeds(con, course)
  const p = stored ? await placement(stored, meanLineGuid) : IDENTITY(identity.totalDistM)
  await trackLibrary().saveCorners(course, {
    trackName: identity.trackName, configName: identity.configName,
    referenceLineGuid: stored ? stored.referenceLineGuid : meanLineGuid,
    referenceLine: stored ? null : referenceOf(meanLineGuid),
    // Only fills a missing length: a stored one is on the reference line.
    totalDistM: stored ? null : identity.totalDistM,
    segments: identity.segments,
  }, cornersToReference(corners, stored, p))
}

/** Replace a course's complexes from this mean line. An empty list clears them so they re-derive. */
export async function saveTrackComplexes(
  con: DuckDBConnection, meanLineGuid: string, complexes: StoredComplex[], origin: ComplexOrigin,
): Promise<void> {
  const course = await courseForSave(con, meanLineGuid)
  const stored = hasCourseIdentity(course) ? await trackLibrary().find(course) : null
  if (!stored) throw new Error('Save the corners for this layout before editing complexes.')
  const p = await placement(stored, meanLineGuid)
  await trackLibrary().saveComplexes(course, stored.referenceLineGuid, complexesToReference(complexes, stored, p), origin)
}

// A name equal to the one the corners would give is not a custom name; storing
// it would freeze today's corner names into the complex.
export function customComplexNames(corners: TrackCorner[], complexes: StoredComplex[]): StoredComplex[] {
  const defaults = labelComplexes(corners, complexes.map(c => ({ startM: c.startM, endM: c.endM })))
  return complexes.map((c, i) => {
    const name = c.name?.trim() ?? ''
    return { ...c, name: name && name !== defaults[i].name ? name : null }
  })
}

// ─── Seeding from YAML ──────────────────────────────────────────────────────

interface Seed { file: string; mtimeMs: number; yaml: TrackYaml }

function readSeeds(dir: string): Seed[] {
  if (!fs.existsSync(dir)) return []
  const seeds: Seed[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.yaml')) continue
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      seeds.push({ file, mtimeMs: stat.mtimeMs, yaml: loadTrackYaml(file) })
    } catch (error) {
      console.warn(`[tracks] skipped unreadable seed ${name}:`, error instanceof Error ? error.message : error)
    }
  }
  // Newest first: when two files describe one layout, the last-edited wins.
  return seeds.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
}

// Files without a mean line ID are matched the way the old file lookup did:
// by configuration and track name, else by the file name the editor gave them.
function headerlessTargets(seed: Seed, lines: LocalLine[]): LocalLine[] {
  const config = textOrNull(seed.yaml.track_configuration_name)
  if (config) {
    const track = textOrNull(seed.yaml.track_name)
    return lines.filter(l => l.course.configName === config && (!l.course.trackName || l.course.trackName === track))
  }
  const file = path.basename(seed.file)
  return lines.filter(l => l.course.configName && seedFileName(l.course.trackName ?? '', l.course.configName) === file)
}

function seedCorners(list: TrackCorner[] | undefined): TrackCorner[] {
  const seen = new Set<string>()
  const out: TrackCorner[] = []
  for (const raw of list ?? []) {
    const turn = textOrNull(raw?.turn)
    const apex = finiteOrNull(raw?.apex_idx)
    if (!turn || apex == null || seen.has(turn)) continue
    seen.add(turn)
    out.push({
      ...raw, turn, name: textOrNull(raw.name) ?? '', apex_idx: apex,
      direction: textOrNull(raw.direction) ?? undefined, character: textOrNull(raw.character) ?? undefined,
    })
  }
  return out
}

// A seed complex keeps its boundaries. Its name is kept only if the driver
// typed it: names the app generated from the corners of the time ("T4b–T8b ·
// Snake Entry …", "Complex 3") are recomputed from the current corners.
function seedComplexes(list: TrackComplex[] | undefined): StoredComplex[] {
  const out: StoredComplex[] = []
  for (const raw of list ?? []) {
    const startM = finiteOrNull(raw?.start_m), endM = finiteOrNull(raw?.end_m)
    if (startM == null || endM == null || endM <= startM || out.some(c => c.startM === startM)) continue
    const name = textOrNull(raw.name)
    const span = cornerSpanLabel(String(raw.corners ?? '').split(',').map(s => s.trim()).filter(Boolean))
    const generated = !name || /^(Start straight|Complex \d+)$/.test(name) || (!!span && (name === span || name.startsWith(`${span} · `)))
    out.push({ startM, endM, name: generated ? null : name })
  }
  return out.sort((a, b) => a.startM - b.startM)
}

function seedLayout(seed: Seed, referenceLineGuid: string): LayoutInput {
  const y = seed.yaml
  const complexes = seedComplexes(y.complexes)
  return {
    trackName: textOrNull(y.track_name), configName: textOrNull(y.track_configuration_name),
    referenceLineGuid, referenceLine: referenceOf(referenceLineGuid),
    totalDistM: finiteOrNull(y.total_dist_m), segments: y.segments ?? [],
    corners: seedCorners(y.corners), complexes, complexesOrigin: complexes.length ? 'seed' : null,
    seedFile: path.basename(seed.file),
  }
}

/**
 * Import seed files for courses the library has no layout for. Safe to call
 * repeatedly: a course with a layout is never touched. `course` limits the
 * import to one course. Returns the mean lines whose seed was imported.
 */
export async function seedTrackLayouts(
  con: DuckDBConnection, opts: { course?: CourseRef; dir?: string } = {},
): Promise<string[]> {
  const dir = opts.dir ?? TRACKS_DIR
  const seeds = readSeeds(dir)
  if (!seeds.length) return []
  // Files naming a mean line take precedence over files matched by name.
  const plan: Array<{ seed: Seed; targets: () => Promise<LocalLine[]> }> = []
  let lines: LocalLine[] | null = null
  const known = async () => (lines ??= await workspaceLines(con))
  for (const seed of seeds) {
    const guid = textOrNull(seed.yaml.mean_line_guid)
    if (!guid) continue
    plan.push({ seed, targets: async () => {
      // The file's own names, unless this workspace knows the line better.
      const local = await courseFromWorkspace(con, guid)
      return [{ guid, course: hasCourseIdentity(local) ? local
        : { configurationId: null, trackName: textOrNull(seed.yaml.track_name), configName: textOrNull(seed.yaml.track_configuration_name) } }]
    } })
  }
  for (const seed of seeds) {
    if (!textOrNull(seed.yaml.mean_line_guid)) plan.push({ seed, targets: async () => headerlessTargets(seed, await known()) })
  }
  const imported: string[] = []
  for (const { seed, targets } of plan) {
    for (const target of await targets()) {
      if (!hasCourseIdentity(target.course) || (opts.course && !matchCourse([target.course], opts.course))) continue
      try {
        if (await trackLibrary().importLayout(target.course, seedLayout(seed, target.guid), 'seed')) imported.push(target.guid)
      } catch (error) {
        console.warn(`[tracks] could not import ${path.basename(seed.file)} for ${target.guid}:`, error instanceof Error ? error.message : error)
      }
    }
  }
  if (imported.length) console.log(`[tracks] imported ${imported.length} track layout(s) from seed files into the track library`)
  return imported
}

// ─── Startup ────────────────────────────────────────────────────────────────

const SHARED_KEY = 'shared-track-library'

/**
 * Copy the layouts this workspace kept before the shared library existed
 * (its own track_layouts tables) into the library, once. A layout with
 * corners or complexes replaces a seed or an imported layout with less data;
 * empty ones are skipped. Returns the number copied.
 */
export async function shareWorkspaceTrackLayouts(con: DuckDBConnection): Promise<number> {
  if (!await hasTable(con, 'app_migrations')) return 0
  if ((await rows(con, 'SELECT 1 AS done FROM app_migrations WHERE key = ?', [SHARED_KEY])).length) return 0
  let shared = 0
  if (await hasTable(con, 'track_layouts')) {
    const layouts = await rows(con, `SELECT mean_line_guid, track_name, track_configuration_name, total_dist_m,
      CAST(segments AS VARCHAR) AS segments, complexes_origin, seed_file FROM track_layouts ORDER BY mean_line_guid`)
    for (const l of layouts) {
      const guid = String(l.mean_line_guid)
      const corners = (await rows(con, 'SELECT * FROM track_corners WHERE mean_line_guid = ? ORDER BY apex_idx, turn', [guid])).map(r => {
        const c = { turn: String(r.turn), name: r.name ?? '', apex_idx: Number(r.apex_idx) } as TrackCorner
        for (const key of ['dist_idx_start', 'dist_idx_end', 'apex_lat', 'apex_lon', 'apex_radius_m'] as const) if (r[key] != null) (c as any)[key] = Number(r[key])
        for (const key of ['direction', 'character'] as const) if (r[key] != null) (c as any)[key] = String(r[key])
        return c
      })
      const complexes = (await rows(con, 'SELECT start_m, end_m, name FROM track_complexes WHERE mean_line_guid = ? ORDER BY start_m', [guid]))
        .map(c => ({ startM: Number(c.start_m), endM: Number(c.end_m), name: c.name ?? null }))
      let segments: TrackSegment[] = []
      try { segments = l.segments ? JSON.parse(l.segments) : [] } catch { segments = [] }
      const local = await courseFromWorkspace(con, guid)
      const course = { ...local, trackName: local.trackName ?? textOrNull(l.track_name), configName: local.configName ?? textOrNull(l.track_configuration_name) }
      const layout: LayoutInput = {
        trackName: textOrNull(l.track_name), configName: textOrNull(l.track_configuration_name),
        referenceLineGuid: guid, referenceLine: referenceOf(guid), totalDistM: finiteOrNull(l.total_dist_m),
        segments: Array.isArray(segments) ? segments : [], corners, complexes,
        complexesOrigin: (l.complexes_origin ?? null) as ComplexOrigin | null, seedFile: l.seed_file ?? null,
      }
      if (await trackLibrary().importLayout(course, layout, 'workspace')) shared++
    }
  }
  await con.run('INSERT OR IGNORE INTO app_migrations (key) VALUES (?)', [SHARED_KEY])
  if (shared) console.log(`[tracks] shared ${shared} track layout(s) from this workspace with every driver`)
  return shared
}

/** Share the points of this workspace's mean lines that library layouts are drawn on. */
export async function shareReferenceLines(): Promise<void> {
  for (const layout of await trackLibrary().list()) {
    if (!layout.referenceLineGuid || layout.hasReferenceLine) continue
    const line = referenceOf(layout.referenceLineGuid)
    if (line) await trackLibrary().attachReferenceLine(line)
  }
}

/** Startup: this workspace's older layouts, then seed files, then reference lines. */
export async function prepareTrackLibrary(con: DuckDBConnection): Promise<void> {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn() } catch (error) { console.error(`[tracks] ${label} failed:`, error) }
  }
  await step('sharing workspace layouts', () => shareWorkspaceTrackLayouts(con))
  await step('seed import', () => seedTrackLayouts(con))
  await step('sharing reference lines', () => shareReferenceLines())
}
