/**
 * The shared track library: the named corners and corner complexes of each
 * course, the same for every driver.
 *
 * Layouts are keyed by course (Garmin's track configuration ID, else the
 * track and configuration names), never by mean line: Catalyst gives each
 * device its own mean line, so two drivers on one course never share a
 * mean-line ID. A layout's positions are metres along the mean line they
 * were drawn on — its reference line, whose points are stored with it — and
 * trackStore.ts moves them onto each driver's own line on read and back on
 * save.
 *
 * On a server only the server process opens the library database (the
 * server's catalyst-app.duckdb, beside the users folder); user workers reach
 * it through private process IPC (userWorker.ts), never a browser-reachable
 * route. The desktop app and tests keep the library in the workspace
 * database.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DuckDBConnection } from '@duckdb/node-api'
import { withDb } from './loadToDb.js'
import { DB_PATH } from './paths.js'
import { isMeanLineTrace, type MeanLineTrace } from './meanLineAlign.js'
import type { TrackCorner, TrackSegment } from './trackYaml.js'

// Where a layout's stored complexes came from. Derived complexes follow the
// corners (a corner save re-derives them); edited and imported ones are kept.
export type ComplexOrigin = 'derived' | 'edited' | 'seed'

export interface StoredComplex { startM: number; endM: number; name: string | null }

// Where the layout came from: a seed file, a driver's workspace from before
// the library existed, or an edit in the app.
export type LayoutSource = 'seed' | 'workspace' | 'editor'

export interface CourseRef {
  configurationId: number | null
  trackName: string | null
  configName: string | null
}

export interface LibraryLayout {
  id: string
  configurationId: number | null
  trackName: string | null
  configName: string | null
  // The mean line the positions below are measured along.
  referenceLineGuid: string | null
  totalDistM: number | null
  segments: TrackSegment[]
  corners: TrackCorner[]
  complexes: StoredComplex[]
  complexesOrigin: ComplexOrigin | null
  source: LayoutSource
}

export interface LibraryLayoutSummary {
  id: string
  configurationId: number | null
  trackName: string | null
  configName: string | null
  referenceLineGuid: string | null
  hasReferenceLine: boolean
  cornerCount: number
}

// A layout to store, its positions measured along `referenceLineGuid`.
export interface LayoutInput {
  trackName: string | null
  configName: string | null
  referenceLineGuid: string | null
  referenceLine: MeanLineTrace | null
  totalDistM: number | null
  segments: TrackSegment[]
  corners: TrackCorner[]
  complexes: StoredComplex[]
  complexesOrigin: ComplexOrigin | null
  seedFile?: string | null
}

export interface TrackLibrary {
  find(course: CourseRef): Promise<LibraryLayout | null>
  list(): Promise<LibraryLayoutSummary[]>
  referenceLine(guid: string): Promise<MeanLineTrace | null>
  /** Store a reference line's points if they are not stored yet. */
  attachReferenceLine(line: MeanLineTrace): Promise<void>
  /**
   * Add a layout from a seed file or a pre-library workspace. A layout with
   * no corners or complexes is never imported. A seed only fills a course
   * with no layout. A workspace layout replaces a seed, or another imported
   * workspace layout with less data; it never replaces an edit made since.
   */
  importLayout(course: CourseRef, layout: LayoutInput, source: 'seed' | 'workspace'): Promise<boolean>
  /**
   * Replace a course's corners (creating its layout if needed). Positions are
   * along `layout.referenceLineGuid`, which must be the stored layout's.
   */
  saveCorners(course: CourseRef, layout: Omit<LayoutInput, 'corners' | 'complexes' | 'complexesOrigin'>, corners: TrackCorner[]): Promise<void>
  /** Replace a course's complexes. An empty list clears them so they re-derive. */
  saveComplexes(course: CourseRef, referenceLineGuid: string | null, complexes: StoredComplex[], origin: ComplexOrigin): Promise<void>
}

// ─── Course identity ───────────────────────────────────────────────────────

const text = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}
const finiteOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export function courseNameKey(course: Pick<CourseRef, 'trackName' | 'configName'>): string | null {
  const track = text(course.trackName)?.toLowerCase(), config = text(course.configName)?.toLowerCase()
  return track && config ? `${track}|${config}` : null
}

export function hasCourseIdentity(course: CourseRef): boolean {
  return course.configurationId != null || courseNameKey(course) !== null
}

// Garmin's course ID decides when both sides have one. Names match only a
// layout with no ID or the same ID, so a reversed course of the same name
// (its own ID) is never taken for another.
export function matchCourse<T extends Pick<CourseRef, 'configurationId' | 'trackName' | 'configName'>>(entries: T[], course: CourseRef): T | null {
  if (course.configurationId != null) {
    const byId = entries.find(e => e.configurationId === course.configurationId)
    if (byId) return byId
  }
  const name = courseNameKey(course)
  if (!name) return null
  return entries.find(e => courseNameKey(e) === name && (e.configurationId == null || course.configurationId == null)) ?? null
}

// The amount of driver data in a layout, for choosing between imports.
const dataScore = (corners: number, complexes: number) => corners * 1000 + complexes

// ─── DuckDB implementation ─────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS course_layouts (
    layout_id VARCHAR PRIMARY KEY,
    configuration_id INTEGER,
    track_name VARCHAR,
    track_configuration_name VARCHAR,
    reference_line_guid VARCHAR,
    total_dist_m DOUBLE,
    segments JSON,
    complexes_origin VARCHAR,
    source VARCHAR NOT NULL,
    seed_file VARCHAR,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS course_corners (
    layout_id VARCHAR NOT NULL,
    turn VARCHAR NOT NULL,
    name VARCHAR,
    direction VARCHAR,
    character VARCHAR,
    apex_idx DOUBLE NOT NULL,
    dist_idx_start DOUBLE,
    dist_idx_end DOUBLE,
    apex_lat DOUBLE,
    apex_lon DOUBLE,
    apex_radius_m DOUBLE,
    PRIMARY KEY (layout_id, turn)
  );
  CREATE TABLE IF NOT EXISTS course_complexes (
    layout_id VARCHAR NOT NULL,
    start_m DOUBLE NOT NULL,
    end_m DOUBLE NOT NULL,
    name VARCHAR,
    PRIMARY KEY (layout_id, start_m)
  );
  CREATE TABLE IF NOT EXISTS course_reference_lines (
    mean_line_guid VARCHAR PRIMARY KEY,
    total_m DOUBLE NOT NULL,
    points JSON NOT NULL
  );
  CREATE TABLE IF NOT EXISTS library_migrations (
    key VARCHAR PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`

async function rows(con: DuckDBConnection, sql: string, params: any[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params)).getRowObjectsJson()
}

async function inTransaction<T>(con: DuckDBConnection, fn: () => Promise<T>): Promise<T> {
  await con.run('BEGIN TRANSACTION')
  try {
    const result = await fn()
    await con.run('COMMIT')
    return result
  } catch (error) {
    await con.run('ROLLBACK')
    throw error
  }
}

function cornerFromRow(r: any): TrackCorner {
  // Absent zone bounds stay absent (not NaN), as they were in the seed file.
  const c = { turn: String(r.turn), name: r.name ?? '', apex_idx: Number(r.apex_idx) } as TrackCorner
  if (r.dist_idx_start != null) c.dist_idx_start = Number(r.dist_idx_start)
  if (r.dist_idx_end != null) c.dist_idx_end = Number(r.dist_idx_end)
  if (r.direction != null) c.direction = String(r.direction)
  if (r.character != null) c.character = String(r.character)
  if (r.apex_lat != null) c.apex_lat = Number(r.apex_lat)
  if (r.apex_lon != null) c.apex_lon = Number(r.apex_lon)
  if (r.apex_radius_m != null) c.apex_radius_m = Number(r.apex_radius_m)
  return c
}

interface IndexRow { id: string; configurationId: number | null; trackName: string | null; configName: string | null; referenceLineGuid: string | null; source: LayoutSource }

async function index(con: DuckDBConnection): Promise<IndexRow[]> {
  return (await rows(con, `SELECT layout_id, configuration_id, track_name, track_configuration_name, reference_line_guid, source
    FROM course_layouts ORDER BY updated_at DESC, layout_id`)).map(r => ({
    id: String(r.layout_id), configurationId: finiteOrNull(r.configuration_id), trackName: r.track_name ?? null,
    configName: r.track_configuration_name ?? null, referenceLineGuid: r.reference_line_guid ?? null, source: r.source as LayoutSource,
  }))
}

async function readLayout(con: DuckDBConnection, id: string): Promise<LibraryLayout | null> {
  const r = (await rows(con, `SELECT layout_id, configuration_id, track_name, track_configuration_name, reference_line_guid,
    total_dist_m, CAST(segments AS VARCHAR) AS segments, complexes_origin, source FROM course_layouts WHERE layout_id = ?`, [id]))[0]
  if (!r) return null
  const corners = await rows(con, 'SELECT * FROM course_corners WHERE layout_id = ? ORDER BY apex_idx, turn', [id])
  const complexes = await rows(con, 'SELECT start_m, end_m, name FROM course_complexes WHERE layout_id = ? ORDER BY start_m', [id])
  let segments: TrackSegment[] = []
  try { segments = r.segments ? JSON.parse(r.segments) : [] } catch { segments = [] }
  return {
    id: String(r.layout_id), configurationId: finiteOrNull(r.configuration_id),
    trackName: r.track_name ?? null, configName: r.track_configuration_name ?? null,
    referenceLineGuid: r.reference_line_guid ?? null, totalDistM: finiteOrNull(r.total_dist_m),
    segments: Array.isArray(segments) ? segments : [],
    corners: corners.map(cornerFromRow),
    complexes: complexes.map(c => ({ startM: Number(c.start_m), endM: Number(c.end_m), name: c.name ?? null })),
    complexesOrigin: (r.complexes_origin ?? null) as ComplexOrigin | null,
    source: r.source as LayoutSource,
  }
}

// A layout found by name gains the course ID once one is known.
async function locate(con: DuckDBConnection, course: CourseRef): Promise<IndexRow | null> {
  const found = matchCourse(await index(con), course)
  if (found && found.configurationId == null && course.configurationId != null) {
    await con.run('UPDATE course_layouts SET configuration_id = ? WHERE layout_id = ?', [course.configurationId, found.id])
    found.configurationId = course.configurationId
  }
  return found
}

async function insertCorners(con: DuckDBConnection, id: string, corners: TrackCorner[]): Promise<void> {
  for (const c of corners) {
    await con.run(`INSERT INTO course_corners (layout_id, turn, name, direction, character, apex_idx,
      dist_idx_start, dist_idx_end, apex_lat, apex_lon, apex_radius_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, c.turn, text(c.name), text(c.direction), text(c.character), c.apex_idx,
      finiteOrNull(c.dist_idx_start), finiteOrNull(c.dist_idx_end), finiteOrNull(c.apex_lat), finiteOrNull(c.apex_lon),
      finiteOrNull(c.apex_radius_m),
    ])
  }
}

async function insertComplexes(con: DuckDBConnection, id: string, complexes: StoredComplex[]): Promise<void> {
  for (const c of complexes) {
    await con.run('INSERT INTO course_complexes (layout_id, start_m, end_m, name) VALUES (?, ?, ?, ?)', [id, c.startM, c.endM, text(c.name)])
  }
}

async function storeReferenceLine(con: DuckDBConnection, line: MeanLineTrace | null): Promise<void> {
  if (!line || !isMeanLineTrace(line)) return
  await con.run('INSERT INTO course_reference_lines (mean_line_guid, total_m, points) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [line.guid, line.totalM, JSON.stringify({ dist: line.dist, lat: line.lat, lon: line.lon })])
}

async function insertLayout(con: DuckDBConnection, id: string, course: CourseRef, layout: LayoutInput, source: LayoutSource): Promise<void> {
  await con.run(`INSERT INTO course_layouts (layout_id, configuration_id, track_name, track_configuration_name, reference_line_guid,
    total_dist_m, segments, complexes_origin, source, seed_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    // The course it is filed under names it; the layout's own names only fill gaps.
    id, course.configurationId, text(course.trackName) ?? text(layout.trackName), text(course.configName) ?? text(layout.configName),
    layout.referenceLineGuid, finiteOrNull(layout.totalDistM), JSON.stringify(layout.segments ?? []),
    layout.complexes.length ? layout.complexesOrigin ?? 'seed' : null, source, layout.seedFile ?? null,
  ])
  await insertCorners(con, id, layout.corners)
  await insertComplexes(con, id, layout.complexes)
  await storeReferenceLine(con, layout.referenceLine)
}

async function deleteLayout(con: DuckDBConnection, id: string): Promise<void> {
  await con.run('DELETE FROM course_corners WHERE layout_id = ?', [id])
  await con.run('DELETE FROM course_complexes WHERE layout_id = ?', [id])
  await con.run('DELETE FROM course_layouts WHERE layout_id = ?', [id])
}

function assertReference(found: IndexRow, referenceLineGuid: string | null): void {
  if ((found.referenceLineGuid ?? null) !== (referenceLineGuid ?? null)) {
    throw new Error('This track layout was changed by another driver. Reload the page and try again.')
  }
}

export interface LocalTrackLibrary extends TrackLibrary {
  migrated(key: string): Promise<boolean>
  markMigrated(key: string): Promise<void>
}

// One library per database file, its operations one at a time: each is a
// short transaction, and two at once on a layout would conflict.
const libraries = new Map<string, LocalTrackLibrary>()

export function localTrackLibrary(filename: string): LocalTrackLibrary {
  filename = path.resolve(filename)
  const existing = libraries.get(filename)
  if (existing) return existing
  let initialized = false
  let queue: Promise<unknown> = Promise.resolve()
  const run = <T>(operation: (con: DuckDBConnection) => Promise<T>): Promise<T> => {
    const result = queue.then(() => withDb(async con => {
      if (!initialized) { await con.run(SCHEMA); initialized = true }
      return operation(con)
    }, filename))
    queue = result.catch(() => {})
    return result
  }

  const library: LocalTrackLibrary = {
    find: course => run(async con => {
      const found = await locate(con, course)
      return found ? readLayout(con, found.id) : null
    }),

    list: () => run(async con => (await rows(con, `
      SELECT l.layout_id, l.configuration_id, l.track_name, l.track_configuration_name, l.reference_line_guid,
        r.mean_line_guid IS NOT NULL AS has_line, (SELECT COUNT(*) FROM course_corners c WHERE c.layout_id = l.layout_id) AS corners
      FROM course_layouts l LEFT JOIN course_reference_lines r ON r.mean_line_guid = l.reference_line_guid
      ORDER BY l.updated_at DESC, l.layout_id`)).map(r => ({
      id: String(r.layout_id), configurationId: finiteOrNull(r.configuration_id),
      trackName: r.track_name ?? null, configName: r.track_configuration_name ?? null,
      referenceLineGuid: r.reference_line_guid ?? null, hasReferenceLine: !!r.has_line, cornerCount: Number(r.corners ?? 0),
    }))),

    referenceLine: guid => run(async con => {
      const r = (await rows(con, 'SELECT total_m, CAST(points AS VARCHAR) AS points FROM course_reference_lines WHERE mean_line_guid = ?', [guid]))[0]
      if (!r) return null
      try {
        const p = JSON.parse(r.points)
        const line = { guid, totalM: Number(r.total_m), dist: p.dist, lat: p.lat, lon: p.lon }
        return isMeanLineTrace(line) ? line : null
      } catch { return null }
    }),

    attachReferenceLine: line => run(con => storeReferenceLine(con, line)),

    importLayout: (course, layout, source) => {
      if (!hasCourseIdentity(course)) return Promise.resolve(false)
      const score = dataScore(layout.corners.length, layout.complexes.length)
      if (!score) return Promise.resolve(false)
      return run(con => inTransaction(con, async () => {
        const found = await locate(con, course)
        if (found) {
          if (source === 'seed' || found.source === 'editor') return false
          if (found.source === 'workspace') {
            const current = await readLayout(con, found.id)
            if (current && dataScore(current.corners.length, current.complexes.length) >= score) return false
          }
          await deleteLayout(con, found.id)
        }
        await insertLayout(con, found?.id ?? randomUUID(), { ...course, configurationId: course.configurationId ?? found?.configurationId ?? null }, layout, source)
        return true
      }))
    },

    saveCorners: (course, layout, corners) => {
      if (!hasCourseIdentity(course)) return Promise.reject(new Error('This layout has no track or configuration name to save it under.'))
      return run(con => inTransaction(con, async () => {
        const found = await locate(con, course)
        if (!found) {
          await insertLayout(con, randomUUID(), course, { ...layout, corners, complexes: [], complexesOrigin: null }, 'editor')
          return
        }
        assertReference(found, layout.referenceLineGuid)
        const current = await readLayout(con, found.id)
        await con.run(`UPDATE course_layouts SET
            track_name = COALESCE(track_name, ?), track_configuration_name = COALESCE(track_configuration_name, ?),
            total_dist_m = COALESCE(total_dist_m, ?), source = 'editor', updated_at = now()
          WHERE layout_id = ?`, [text(layout.trackName), text(layout.configName), finiteOrNull(layout.totalDistM), found.id])
        if (current?.complexesOrigin === 'derived') {
          await con.run('DELETE FROM course_complexes WHERE layout_id = ?', [found.id])
          await con.run('UPDATE course_layouts SET complexes_origin = NULL WHERE layout_id = ?', [found.id])
        }
        await con.run('DELETE FROM course_corners WHERE layout_id = ?', [found.id])
        await insertCorners(con, found.id, corners)
        await storeReferenceLine(con, layout.referenceLine)
      }))
    },

    saveComplexes: (course, referenceLineGuid, complexes, origin) => run(con => inTransaction(con, async () => {
      const found = await locate(con, course)
      if (!found) throw new Error('Save the corners for this layout before editing complexes.')
      assertReference(found, referenceLineGuid)
      // Deriving complexes is not a driver edit; editing them is.
      await con.run(`UPDATE course_layouts SET complexes_origin = ?, updated_at = now()${origin === 'derived' ? '' : ", source = 'editor'"}
        WHERE layout_id = ?`, [complexes.length ? origin : null, found.id])
      await con.run('DELETE FROM course_complexes WHERE layout_id = ?', [found.id])
      await insertComplexes(con, found.id, complexes)
    })),

    migrated: key => run(async con => (await rows(con, 'SELECT 1 AS done FROM library_migrations WHERE key = ?', [key])).length > 0),
    markMigrated: key => run(async con => { await con.run('INSERT OR IGNORE INTO library_migrations (key) VALUES (?)', [key]) }),
  }
  libraries.set(filename, library)
  return library
}

// ─── The library this process uses ─────────────────────────────────────────

let configured: TrackLibrary | null = null

/** Server workers use the server's library (userWorker.ts sets this). */
export function useTrackLibrary(library: TrackLibrary | null): void {
  configured = library
}

/** The process's library: set by useTrackLibrary, else the workspace database's. */
export function trackLibrary(): TrackLibrary {
  return configured ?? localTrackLibrary(DB_PATH)
}

// ─── Over process IPC ──────────────────────────────────────────────────────

const OPERATIONS = ['find', 'list', 'referenceLine', 'attachReferenceLine', 'importLayout', 'saveCorners', 'saveComplexes'] as const
type Operation = typeof OPERATIONS[number]

/** A worker's view of the server's library, through `call`. */
export function remoteTrackLibrary(call: (op: Operation, args: unknown[]) => Promise<unknown>): TrackLibrary {
  return Object.fromEntries(OPERATIONS.map(op => [op, (...args: unknown[]) => call(op, args)])) as unknown as TrackLibrary
}

/** Run a worker's library request against the server's library. */
export function serveTrackLibrary(library: TrackLibrary, op: unknown, args: unknown): Promise<unknown> {
  if (!OPERATIONS.includes(op as Operation) || !Array.isArray(args)) return Promise.reject(new Error('Unknown track library operation'))
  return (library[op as Operation] as (...a: unknown[]) => Promise<unknown>)(...args)
}
