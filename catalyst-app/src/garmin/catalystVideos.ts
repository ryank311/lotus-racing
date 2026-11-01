// Garmin Catalyst session videos: which synced session each device folder
// belongs to, and importing a video into it. The device layout and timing
// are described in shared/catalystVideo.ts.
//
// A folder matches the session on the same track, in the same car, that
// starts closest after the folder clock (a few seconds to ~10 minutes in
// practice). Each session takes at most one folder.

import type { DuckDBConnection } from '@duckdb/node-api'
import { readVideoInfo } from './pdrFile.js'
import { attachPlainVideo, getSessionVideo, placePlainVideo, type EnsureDetails, type PlainPlacement } from './videoStore.js'
import {
  CATALYST_MATCH_AFTER_S, CATALYST_MATCH_BEFORE_S, catalystVideoName, parseCatalystPath,
  type CatalystPlan, type CatalystPlanEntry, type CatalystPlanFolder, type CatalystSessionMatch, type CatalystVideoPath,
} from '../shared/catalystVideo.js'
import type { SessionVideo, VideoImportResult } from '../shared/pdr.js'

interface SessionRow {
  guid: string
  start: string
  track: string | null
  layout: string | null
  make: string | null
  model: string | null
  year: number | null
}

interface FolderInfo { folder: string; track: string; car: string; recordedAt: string }

const clockS = (clock: string) => Date.parse(`${clock.replace(' ', 'T').slice(0, 19)}Z`) / 1000
const clockPlus = (clock: string, s: number) => new Date((clockS(clock) + s) * 1000).toISOString().slice(0, 19).replace('T', ' ')
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const sameName = (a: string | null, b: string | null) => !a || !b || words(a).join(' ') === words(b).join(' ')

// The folder says "LOTUS EXIGE 2008"; the session has make, model and year.
function sameCar(folderCar: string, s: SessionRow): boolean {
  const have = new Set(words(folderCar))
  const make = words(s.make), model = words(s.model)
  if (make.length && !make.every(w => have.has(w))) return false
  if (model.length && !have.has(model[0])) return false
  return true
}

const carLabel = (s: SessionRow) => [s.make, s.model, s.year].filter(v => v != null && v !== '').join(' ') || null
const hhmm = (clock: string) => clock.slice(11, 16)

async function sessionsNear(con: DuckDBConnection, folders: FolderInfo[]): Promise<SessionRow[]> {
  if (!folders.length) return []
  const times = folders.map(f => f.recordedAt).sort()
  const rows = (await con.runAndReadAll(`
    SELECT s.session_guid, CAST(s.session_start AS VARCHAR),
      COALESCE(s.track_name, tc.track_name), COALESCE(s.track_configuration_name, tc.track_configuration_name),
      s.vehicle_make, s.vehicle_model, s.vehicle_year
    FROM sessions s LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    WHERE s.session_start BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)
  `, [clockPlus(times[0], -CATALYST_MATCH_BEFORE_S - 1), clockPlus(times[times.length - 1], CATALYST_MATCH_AFTER_S + 1)])).getRowsJson()
  return rows.map(r => ({
    guid: String(r[0]), start: String(r[1]).slice(0, 19),
    track: r[2] == null ? null : String(r[2]), layout: r[3] == null ? null : String(r[3]),
    make: r[4] == null ? null : String(r[4]), model: r[5] == null ? null : String(r[5]), year: r[6] == null ? null : Number(r[6]),
  }))
}

/**
 * The session each folder belongs to, or why none. Closest pairs are taken
 * first, so two recordings never claim one session. Sessions in `taken`
 * already belong to another recording.
 */
export async function matchCatalystFolders(con: DuckDBConnection, folders: FolderInfo[], taken = new Set<string>()): Promise<Map<string, { session: CatalystSessionMatch | null; note: string | null }>> {
  const sessions = await sessionsNear(con, folders)
  const pairs: Array<{ folder: FolderInfo; session: SessionRow; gap: number; score: number }> = []
  const nearby = new Map<string, SessionRow[]>()
  for (const folder of folders) {
    for (const session of sessions) {
      const gap = clockS(session.start) - clockS(folder.recordedAt)
      if (gap < -CATALYST_MATCH_BEFORE_S || gap > CATALYST_MATCH_AFTER_S) continue
      nearby.set(folder.folder, [...(nearby.get(folder.folder) ?? []), session])
      if (taken.has(session.guid) || !sameName(folder.track, session.track) || !sameCar(folder.car, session)) continue
      // A session starting before the recording is unusual: weigh it more.
      pairs.push({ folder, session, gap, score: gap >= 0 ? gap : -gap * 4 })
    }
  }
  pairs.sort((a, b) => a.score - b.score)
  const out = new Map<string, { session: CatalystSessionMatch | null; note: string | null }>()
  const used = new Set<string>()
  for (const p of pairs) {
    if (out.has(p.folder.folder) || used.has(p.session.guid)) continue
    used.add(p.session.guid)
    out.set(p.folder.folder, {
      session: { guid: p.session.guid, start: p.session.start, track: p.session.track, layout: p.session.layout, car: carLabel(p.session), gapS: p.gap },
      note: null,
    })
  }
  for (const folder of folders) {
    if (out.has(folder.folder)) continue
    const near = nearby.get(folder.folder) ?? []
    const elsewhere = near.filter(s => !sameName(folder.track, s.track) || !sameCar(folder.car, s))
    let note: string
    if (!near.length) note = `No synced session starts near ${folder.recordedAt.slice(0, 16)}. Sync that day’s sessions, then choose the folder again.`
    else if (elsewhere.length === near.length) note = `Your session at ${hhmm(near[0].start)} is ${[near[0].track, carLabel(near[0])].filter(Boolean).join(' in ')}, not ${folder.track} in ${folder.car}.`
    else note = `The session at ${hhmm(near.find(s => !elsewhere.includes(s))!.start)} already has a closer recording.`
    out.set(folder.folder, { session: null, note })
  }
  return out
}

async function importedByKey(con: DuckDBConnection, keys: string[]): Promise<Map<string, Array<{ id: string; size: number; session: string | null }>>> {
  const out = new Map<string, Array<{ id: string; size: number; session: string | null }>>()
  if (!keys.length) return out
  for (let i = 0; i < keys.length; i += 500) {
    const batch = keys.slice(i, i + 500)
    const rows = (await con.runAndReadAll(`
      SELECT source_path, video_id, size_bytes, session_guid FROM session_videos
      WHERE source_path IN (${batch.map(() => '?').join(',')})
    `, batch)).getRowsJson()
    for (const [key, id, size, session] of rows) {
      const list = out.get(String(key)) ?? []
      list.push({ id: String(id), size: Number(size), session: session == null ? null : String(session) })
      out.set(String(key), list)
    }
  }
  return out
}

/** What a scan of the device's RaceData folder would import, folder by folder. */
export async function planCatalystImport(con: DuckDBConnection, entries: CatalystPlanEntry[]): Promise<CatalystPlan> {
  const files = new Map<string, { path: CatalystVideoPath; size: number }>()
  for (const entry of entries) {
    const parsed = parseCatalystPath(entry.path)
    if (parsed && !files.has(parsed.key)) files.set(parsed.key, { path: parsed, size: entry.size })
  }
  const folders = new Map<string, CatalystPlanFolder>()
  for (const { path: p } of files.values()) {
    if (!folders.has(p.folder)) folders.set(p.folder, { folder: p.folder, driver: p.driver, track: p.track, car: p.car, recordedAt: p.recordedAt, session: null, note: null, files: [] })
  }
  const imported = await importedByKey(con, [...files.keys()])
  const matches = await matchCatalystFolders(con, [...folders.values()])
  for (const { path: p, size } of files.values()) {
    const already = imported.get(p.key)?.find(v => v.size === size)
    folders.get(p.folder)!.files.push({
      key: p.key, fileName: p.fileName, kind: p.kind, part: p.part, size,
      importedId: already?.id ?? null, importedSession: already?.session ?? null,
    })
  }
  for (const folder of folders.values()) {
    Object.assign(folder, matches.get(folder.folder))
    folder.files.sort((a, b) => (a.kind === b.kind ? a.part - b.part : a.kind === 'session' ? -1 : 1))
  }
  return { folders: [...folders.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.folder.localeCompare(b.folder)) }
}

const lapCount = async (con: DuckDBConnection, guid: string) =>
  Number((await con.runAndReadAll('SELECT COUNT(*) FROM laps WHERE session_guid = ? AND start_time_session_ms IS NOT NULL', [guid])).getRowsJson()[0]?.[0] ?? 0)

// Sessions already holding another folder's session video.
async function takenSessions(con: DuckDBConnection, folder: string): Promise<Set<string>> {
  const rows = (await con.runAndReadAll(`
    SELECT DISTINCT session_guid FROM session_videos
    WHERE source = 'catalyst' AND session_guid IS NOT NULL AND NOT starts_with(source_path, ? || '/')
  `, [folder])).getRowsJson()
  return new Set(rows.map(r => String(r[0])))
}

/**
 * Where a Catalyst video goes in a session. video_1 starts at the session
 * start; later parts follow the earlier ones; the optimal-lap render has no
 * place on the session's timeline.
 */
async function placement(con: DuckDBConnection, p: CatalystVideoPath, sessionGuid: string | null, note: string | null): Promise<PlainPlacement> {
  if (!sessionGuid) return { sessionGuid: null, offsetS: null, note }
  if (p.kind === 'optimal') return { sessionGuid, offsetS: null, note: null }
  if (p.part === 1) return { sessionGuid, offsetS: 0, note: null }
  const before = (await con.runAndReadAll(`
    SELECT source_path, duration_s FROM session_videos WHERE source = 'catalyst' AND starts_with(source_path, ? || '/')
  `, [p.folder])).getRowsJson()
  const durations = new Map(before.map(r => [parseCatalystPath(String(r[0]))?.part ?? 0, Number(r[1])]))
  // Session time = video time + offset: part N starts where part N−1 ended.
  let offsetS = 0
  for (let part = 1; part < p.part; part++) {
    const d = durations.get(part)
    if (d == null) return { sessionGuid, offsetS: null, note: `Import video_${part}.mp4 from the same folder, then match this part again to sync it.` }
    offsetS += d
  }
  return { sessionGuid, offsetS, note: null }
}

async function sessionExists(con: DuckDBConnection, guid: string): Promise<boolean> {
  return (await con.runAndReadAll('SELECT 1 FROM sessions WHERE session_guid = ?', [guid])).getRowsJson().length > 0
}

// The session for this folder: the chosen one, or the best match.
async function resolveSession(con: DuckDBConnection, p: CatalystVideoPath, sessionGuid: string | null): Promise<{ guid: string | null; note: string | null }> {
  if (sessionGuid) {
    if (!(await sessionExists(con, sessionGuid))) throw new Error('That session is not in your workspace.')
    return { guid: sessionGuid, note: null }
  }
  const match = (await matchCatalystFolders(con, [p], await takenSessions(con, p.folder))).get(p.folder)
  return { guid: match?.session?.guid ?? null, note: match?.note ?? null }
}

// Telemetry first, so the video's laps can be found (best effort).
async function withLaps(con: DuckDBConnection, guid: string | null, ensureDetails: EnsureDetails): Promise<string | null> {
  if (!guid || (await lapCount(con, guid)) > 0) return null
  try { await ensureDetails([guid]) } catch (error) {
    return `Its session’s telemetry could not be downloaded yet (${error instanceof Error ? error.message : String(error)}); the laps appear once it is.`
  }
  return null
}

function describe(video: SessionVideo, extra: string | null): string {
  const s = video.session
  const where = `${[s?.track, s?.layout].filter(Boolean).join(' · ') || 'your session'}${s?.start ? ` on ${s.start.slice(0, 16)}` : ''}`
  let message: string
  if (!video.sessionGuid) message = video.matchNote ?? 'No matching session.'
  else if (video.source === 'catalyst-optimal') message = `Attached to ${where} (Garmin’s optimal-lap video).`
  else if (video.offsetS == null) message = `Attached to ${where}. ${video.matchNote ?? ''}`.trim()
  else message = `Matched to ${where}: ${video.laps.length ? `${video.laps.length} lap${video.laps.length === 1 ? '' : 's'} (${video.laps.map(i => `L${i + 1}`).join(', ')})` : 'no complete laps'}.`
  return extra ? `${message} ${extra}` : message
}

export type CatalystImportResult = VideoImportResult & { duplicate: boolean }

/**
 * Store a Catalyst video copied into the workspace and attach it to its
 * session: the chosen one, or the folder's best match. A file already on the
 * account (same device path and size) is not stored twice; `duplicate` tells
 * the caller to discard the new copy.
 */
export async function importCatalystVideo(con: DuckDBConnection, opts: {
  videoId: string; filePath: string; sizeBytes: number; sourcePath: string; sessionGuid: string | null; ensureDetails: EnsureDetails
}): Promise<CatalystImportResult> {
  const p = parseCatalystPath(opts.sourcePath)
  if (!p) throw new Error('This file is not in a Catalyst RaceData session folder (…/RaceData/DRIVER/Track/Car/YYYYMMDD/HHMMSS/video_1.mp4).')
  const existing = (await importedByKey(con, [p.key])).get(p.key)?.find(v => v.size === opts.sizeBytes)
  if (existing) {
    const video = (await getSessionVideo(con, existing.id))!
    return { video, matched: !!video.sessionGuid, message: `Already imported. ${describe(video, null)}`, duplicate: true }
  }
  const info = await readVideoInfo(opts.filePath)
  const session = await resolveSession(con, p, opts.sessionGuid)
  const telemetry = await withLaps(con, session.guid, opts.ensureDetails)
  const video = await attachPlainVideo(con, {
    videoId: opts.videoId, fileName: catalystVideoName(p), sizeBytes: opts.sizeBytes, durationS: info.durationS,
    recordedAt: p.recordedAt, device: 'Garmin Catalyst', width: info.width, height: info.height,
    source: p.kind === 'optimal' ? 'catalyst-optimal' : 'catalyst', sourcePath: p.key,
  }, await placement(con, p, session.guid, session.note))
  console.log(`[video] ${p.key}: ${video.sessionGuid ? `session ${video.sessionGuid.slice(0, 8)}, offset ${video.offsetS ?? '—'} s` : video.matchNote}`)
  return { video, matched: !!video.sessionGuid, message: describe(video, telemetry), duplicate: false }
}

/** Match a Catalyst video again: to the given session, or its folder's best match. */
export async function rematchCatalystVideo(con: DuckDBConnection, videoId: string, sessionGuid: string | null, ensureDetails: EnsureDetails): Promise<VideoImportResult> {
  const stored = await getSessionVideo(con, videoId)
  if (!stored) throw new Error('That video is no longer on your account.')
  const p = stored.sourcePath ? parseCatalystPath(stored.sourcePath) : null
  if (!p) throw new Error('This video has no Catalyst folder to match by.')
  const session = await resolveSession(con, p, sessionGuid)
  const telemetry = await withLaps(con, session.guid, ensureDetails)
  const video = await placePlainVideo(con, videoId, await placement(con, p, session.guid, session.note))
  return { video, matched: !!video.sessionGuid, message: describe(video, telemetry) }
}
