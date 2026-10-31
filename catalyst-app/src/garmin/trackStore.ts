/**
 * DuckDB-backed track layouts: the named corners and corner complexes of each
 * mean line.
 *
 * Track YAML files (tracks/*.yaml) are seeds only. A layout's file is imported
 * once — at startup, or on the first read that finds no record for its mean
 * line — and the database is the sole source of truth from then on. Seed files
 * are never written, and never re-read for a layout that has a record.
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

export type { TrackCorner, TrackSegment } from './trackYaml.js'

// Where a layout's stored complexes came from. Derived complexes follow the
// corners (a corner save re-derives them); edited and imported ones are kept.
export type ComplexOrigin = 'derived' | 'edited' | 'seed'

export interface StoredComplex { startM: number; endM: number; name: string | null }

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

interface SessionLayoutRef {
  mean_line_guid: string | null
  track_name: string | null
  track_configuration_name: string | null
}

export async function initTrackSchema(con: DuckDBConnection): Promise<void> {
  await con.run(`
    CREATE TABLE IF NOT EXISTS track_layouts (
      mean_line_guid VARCHAR PRIMARY KEY,
      track_name VARCHAR,
      track_configuration_name VARCHAR,
      total_dist_m DOUBLE,
      segments JSON,
      complexes_origin VARCHAR,
      seed_file VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS track_corners (
      mean_line_guid VARCHAR NOT NULL,
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
      PRIMARY KEY (mean_line_guid, turn)
    );
    CREATE TABLE IF NOT EXISTS track_complexes (
      mean_line_guid VARCHAR NOT NULL,
      start_m DOUBLE NOT NULL,
      end_m DOUBLE NOT NULL,
      name VARCHAR,
      PRIMARY KEY (mean_line_guid, start_m)
    );
  `)
}

async function rows(con: DuckDBConnection, sql: string, params: any[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params)).getRowObjectsJson()
}

// Imports and saves run one at a time within the process: each is a short
// transaction, and two at once on the same layout would conflict.
let writeQueue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.catch(() => {})
  return run
}

async function inTransaction(con: DuckDBConnection, fn: () => Promise<void>): Promise<void> {
  await con.run('BEGIN TRANSACTION')
  try {
    await fn()
    await con.run('COMMIT')
  } catch (error) {
    await con.run('ROLLBACK')
    throw error
  }
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

// ─── Reading ────────────────────────────────────────────────────────────────

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

async function readLayout(con: DuckDBConnection, meanLineGuid: string): Promise<TrackLayout | null> {
  const layout = (await rows(con, `
    SELECT mean_line_guid, track_name, track_configuration_name, total_dist_m, CAST(segments AS VARCHAR) AS segments, complexes_origin
    FROM track_layouts WHERE mean_line_guid = ?`, [meanLineGuid]))[0]
  if (!layout) return null
  const corners = await rows(con, 'SELECT * FROM track_corners WHERE mean_line_guid = ? ORDER BY apex_idx, turn', [meanLineGuid])
  const complexes = await rows(con, 'SELECT start_m, end_m, name FROM track_complexes WHERE mean_line_guid = ? ORDER BY start_m', [meanLineGuid])
  let segments: TrackSegment[] = []
  try { segments = layout.segments ? JSON.parse(layout.segments) : [] } catch { segments = [] }
  return {
    meanLineGuid: String(layout.mean_line_guid),
    trackName: layout.track_name ?? null,
    configName: layout.track_configuration_name ?? null,
    totalDistM: finiteOrNull(layout.total_dist_m),
    segments: Array.isArray(segments) ? segments : [],
    corners: corners.map(cornerFromRow),
    complexes: complexes.map(c => ({ startM: Number(c.start_m), endM: Number(c.end_m), name: c.name ?? null })),
    complexesOrigin: (layout.complexes_origin ?? null) as ComplexOrigin | null,
  }
}

/** The stored layout for a mean line, importing its seed file on first use. */
export async function getTrackLayout(con: DuckDBConnection, meanLineGuid: string | null | undefined): Promise<TrackLayout | null> {
  if (!meanLineGuid) return null
  await initTrackSchema(con)
  const stored = await readLayout(con, meanLineGuid)
  if (stored) return stored
  if (!(await seedTrackLayouts(con, { only: meanLineGuid })).length) return null
  return readLayout(con, meanLineGuid)
}

// Corners never cross between mean lines. A session without a mean line falls
// back to the layout most recently saved under the same track and configuration.
export async function layoutForSession(con: DuckDBConnection, session: SessionLayoutRef): Promise<TrackLayout | null> {
  if (session.mean_line_guid) return getTrackLayout(con, session.mean_line_guid)
  if (!session.track_name || !session.track_configuration_name) return null
  await seedTrackLayouts(con)
  const match = (await rows(con, `
    SELECT mean_line_guid FROM track_layouts WHERE track_name = ? AND track_configuration_name = ?
    ORDER BY updated_at DESC LIMIT 1`, [session.track_name, session.track_configuration_name]))[0]
  return match ? readLayout(con, String(match.mean_line_guid)) : null
}

/** Complexes with IDs, corner lists and names computed from the current corners. */
export function layoutComplexes(layout: TrackLayout): ComplexDef[] {
  return labelComplexes(layout.corners, layout.complexes)
}

/** Corner count per stored mean line, for the Tracks list. */
export async function trackLayoutCornerCounts(con: DuckDBConnection): Promise<Map<string, number>> {
  await seedTrackLayouts(con)
  const counts = await rows(con, `
    SELECT l.mean_line_guid, COUNT(c.turn) AS corners FROM track_layouts l
    LEFT JOIN track_corners c ON c.mean_line_guid = l.mean_line_guid GROUP BY 1`)
  return new Map(counts.map(r => [String(r.mean_line_guid), Number(r.corners)]))
}

// ─── Saving ─────────────────────────────────────────────────────────────────

async function insertCorners(con: DuckDBConnection, meanLineGuid: string, corners: TrackCorner[]): Promise<void> {
  for (const c of corners) {
    await con.run(`INSERT INTO track_corners (mean_line_guid, turn, name, direction, character, apex_idx,
      dist_idx_start, dist_idx_end, apex_lat, apex_lon, apex_radius_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      meanLineGuid, c.turn, textOrNull(c.name), textOrNull(c.direction), textOrNull(c.character), c.apex_idx,
      finiteOrNull(c.dist_idx_start), finiteOrNull(c.dist_idx_end), finiteOrNull(c.apex_lat), finiteOrNull(c.apex_lon),
      finiteOrNull(c.apex_radius_m),
    ])
  }
}

async function insertComplexes(con: DuckDBConnection, meanLineGuid: string, complexes: StoredComplex[]): Promise<void> {
  for (const c of complexes) {
    await con.run('INSERT INTO track_complexes (mean_line_guid, start_m, end_m, name) VALUES (?, ?, ?, ?)',
      [meanLineGuid, c.startM, c.endM, textOrNull(c.name)])
  }
}

/**
 * Replace a layout's corners, creating its record if needed. Derived complexes
 * are dropped so the next read re-derives them from the new corners; edited
 * and imported complexes keep their boundaries.
 */
export async function saveTrackCorners(
  con: DuckDBConnection, meanLineGuid: string, identity: LayoutIdentity, corners: TrackCorner[],
): Promise<void> {
  // Import the seed first so its segments and complexes are not lost.
  await seedTrackLayouts(con, { only: meanLineGuid })
  await serialized(() => inTransaction(con, async () => {
    const existing = (await rows(con, 'SELECT complexes_origin FROM track_layouts WHERE mean_line_guid = ?', [meanLineGuid]))[0]
    if (!existing) {
      await con.run(`INSERT INTO track_layouts (mean_line_guid, track_name, track_configuration_name, total_dist_m, segments)
        VALUES (?, ?, ?, ?, ?)`, [meanLineGuid, identity.trackName, identity.configName, identity.totalDistM, JSON.stringify(identity.segments)])
    } else {
      await con.run(`UPDATE track_layouts SET
          track_name = COALESCE(track_name, ?), track_configuration_name = COALESCE(track_configuration_name, ?),
          total_dist_m = COALESCE(total_dist_m, ?), updated_at = now()
        WHERE mean_line_guid = ?`, [identity.trackName, identity.configName, identity.totalDistM, meanLineGuid])
      if (existing.complexes_origin === 'derived') {
        await con.run('DELETE FROM track_complexes WHERE mean_line_guid = ?', [meanLineGuid])
        await con.run('UPDATE track_layouts SET complexes_origin = NULL WHERE mean_line_guid = ?', [meanLineGuid])
      }
    }
    await con.run('DELETE FROM track_corners WHERE mean_line_guid = ?', [meanLineGuid])
    await insertCorners(con, meanLineGuid, corners)
  }))
}

/** Replace a layout's complexes. An empty list clears them so they re-derive. */
export async function saveTrackComplexes(
  con: DuckDBConnection, meanLineGuid: string, complexes: StoredComplex[], origin: ComplexOrigin,
): Promise<void> {
  await initTrackSchema(con)
  await serialized(() => inTransaction(con, async () => {
    const updated = await rows(con, `UPDATE track_layouts SET complexes_origin = ?, updated_at = now()
      WHERE mean_line_guid = ? RETURNING mean_line_guid`, [complexes.length ? origin : null, meanLineGuid])
    if (!updated.length) throw new Error('Save the corners for this layout before editing complexes.')
    await con.run('DELETE FROM track_complexes WHERE mean_line_guid = ?', [meanLineGuid])
    await insertComplexes(con, meanLineGuid, complexes)
  }))
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
interface SeedTarget { guid: string; trackName: string | null; configName: string | null }

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

async function knownLayouts(con: DuckDBConnection): Promise<SeedTarget[]> {
  try {
    return (await rows(con, `
      SELECT DISTINCT s.mean_line_guid AS guid,
        COALESCE(s.track_name, tc.track_name) AS track_name,
        COALESCE(s.track_configuration_name, tc.track_configuration_name) AS config_name
      FROM sessions s LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
      WHERE s.mean_line_guid IS NOT NULL`))
      .map(r => ({ guid: String(r.guid), trackName: r.track_name ?? null, configName: r.config_name ?? null }))
  } catch {
    return [] // no telemetry tables yet
  }
}

// Files without a mean line ID are matched the way the old file lookup did:
// by configuration and track name, else by the file name the editor gave them.
function headerlessTargets(seed: Seed, layouts: SeedTarget[]): SeedTarget[] {
  const config = textOrNull(seed.yaml.track_configuration_name)
  if (config) {
    const track = textOrNull(seed.yaml.track_name)
    return layouts.filter(l => l.configName === config && (!l.trackName || l.trackName === track))
  }
  const file = path.basename(seed.file)
  return layouts.filter(l => l.configName && seedFileName(l.trackName ?? '', l.configName) === file)
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

async function importSeed(con: DuckDBConnection, target: SeedTarget, seed: Seed): Promise<boolean> {
  const y = seed.yaml
  const complexes = seedComplexes(y.complexes)
  let imported = false
  await inTransaction(con, async () => {
    const inserted = await rows(con, `
      INSERT INTO track_layouts (mean_line_guid, track_name, track_configuration_name, total_dist_m, segments, complexes_origin, seed_file)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING mean_line_guid`, [
      target.guid, textOrNull(y.track_name) ?? target.trackName, textOrNull(y.track_configuration_name) ?? target.configName,
      finiteOrNull(y.total_dist_m), JSON.stringify(y.segments ?? []), complexes.length ? 'seed' : null, path.basename(seed.file),
    ])
    if (!inserted.length) return
    await insertCorners(con, target.guid, seedCorners(y.corners))
    await insertComplexes(con, target.guid, complexes)
    imported = true
  })
  return imported
}

/**
 * Import seed files for layouts the database has no record of. Safe to call
 * repeatedly: a layout with a record is never touched. Must not be called
 * inside an open transaction. Returns the mean lines imported.
 */
export async function seedTrackLayouts(
  con: DuckDBConnection, opts: { only?: string; dir?: string } = {},
): Promise<string[]> {
  await initTrackSchema(con)
  return serialized(async () => {
    const existing = new Set((await rows(con, 'SELECT mean_line_guid FROM track_layouts')).map(r => String(r.mean_line_guid)))
    if (opts.only && existing.has(opts.only)) return []
    const seeds = readSeeds(opts.dir ?? TRACKS_DIR)
    if (!seeds.length) return []
    // Files naming a mean line take precedence over files matched by name.
    const plan: Array<{ seed: Seed; targets: () => Promise<SeedTarget[]> }> = []
    let layouts: SeedTarget[] | null = null
    const known = async () => (layouts ??= await knownLayouts(con))
    for (const seed of seeds) {
      const guid = textOrNull(seed.yaml.mean_line_guid)
      if (guid) plan.push({ seed, targets: async () => [{ guid, trackName: null, configName: null }] })
    }
    for (const seed of seeds) {
      if (!textOrNull(seed.yaml.mean_line_guid)) plan.push({ seed, targets: async () => headerlessTargets(seed, await known()) })
    }
    const imported: string[] = []
    for (const { seed, targets } of plan) {
      for (const target of await targets()) {
        if (existing.has(target.guid) || (opts.only && target.guid !== opts.only)) continue
        existing.add(target.guid)
        try {
          if (await importSeed(con, target, seed)) imported.push(target.guid)
        } catch (error) {
          console.warn(`[tracks] could not import ${path.basename(seed.file)} for ${target.guid}:`, error instanceof Error ? error.message : error)
        }
      }
    }
    if (imported.length) console.log(`[tracks] imported ${imported.length} track layout(s) from seed files into the workspace database`)
    return imported
  })
}
