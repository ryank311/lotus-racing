// PDR videos attached to sessions, and the car data decoded from them.
//
// Three tables: session_videos (one row per video and where it sits in the
// session), pdr_records (every telemetry record in the video, raw, so
// channels can be re-read or re-scaled later without the video), and
// pdr_lap_samples (the known channels on each lap's 1 m Garmin samples,
// which Analysis and Session Review read). The video file itself lives in
// the workspace's videos folder; callers own the file.

import type { DuckDBConnection } from '@duckdb/node-api'
import { readPdrFile, channelSeries, type PdrFile, type PdrRecords, type RawSeries } from './pdrFile.js'
import { alignVideo, lapCarSamples, pdrSignals, slipBaseline, type GarminLap, type PdrSignals, type VideoAlignment } from './pdrAlign.js'
import { lapLabel } from './lapData.js'
import { speedFromMps, speedUnitLabel, DEFAULT_UNIT_SYSTEM, type UnitSystem } from '../shared/units.js'
import type { CarData, CarTrace, SessionVideo, VideoImportResult } from '../shared/pdr.js'

export async function initVideoSchema(con: DuckDBConnection): Promise<void> {
  await con.run(`
    CREATE TABLE IF NOT EXISTS session_videos (
      video_id VARCHAR PRIMARY KEY,
      -- NULL until the video is matched to one of your sessions.
      session_guid VARCHAR,
      -- Why the last match found no session.
      match_note VARCHAR,
      file_name VARCHAR NOT NULL,
      size_bytes BIGINT,
      duration_s DOUBLE,
      recorded_at VARCHAR,
      device VARCHAR,
      width INTEGER,
      height INTEGER,
      -- Session time (s) = video time (s) + offset_s.
      offset_s DOUBLE,
      -- The offset the telemetry match found; offset_s differs once nudged.
      auto_offset_s DOUBLE,
      alignment VARCHAR,
      alignment_error DOUBLE,
      laps JSON,
      channels JSON,
      record_count INTEGER,
      slip_baseline DOUBLE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- Every PDR record: channel number, video time (s), raw value.
    CREATE TABLE IF NOT EXISTS pdr_records (
      video_id VARCHAR NOT NULL,
      channel USMALLINT NOT NULL,
      time_s DOUBLE NOT NULL,
      value INTEGER NOT NULL
    );
    -- Known channels on each lap's Garmin samples (same distance_m).
    CREATE TABLE IF NOT EXISTS pdr_lap_samples (
      session_guid VARCHAR NOT NULL,
      lap_index INTEGER NOT NULL,
      distance_m INTEGER NOT NULL,
      video_id VARCHAR NOT NULL,
      video_time_s DOUBLE NOT NULL,
      speed_kmh DOUBLE,
      rpm DOUBLE,
      throttle_pct DOUBLE,
      brake_bar DOUBLE,
      gear INTEGER,
      steering_deg DOUBLE,
      lat_g DOUBLE,
      long_g DOUBLE,
      wheel_fl_kmh DOUBLE,
      wheel_fr_kmh DOUBLE,
      wheel_rl_kmh DOUBLE,
      wheel_rr_kmh DOUBLE,
      rear_slip_pct DOUBLE
    );
    CREATE INDEX IF NOT EXISTS idx_pdr_lap_samples ON pdr_lap_samples(session_guid, lap_index);
  `)
}

const json = (value: unknown): any => {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}
const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))

function rowToVideo(r: Record<string, unknown>): SessionVideo {
  const offset = num(r.offset_s), auto = num(r.auto_offset_s)
  return {
    id: String(r.video_id), sessionGuid: r.session_guid == null ? null : String(r.session_guid),
    session: r.session_guid == null ? null : {
      start: r.session_start == null ? null : String(r.session_start),
      track: r.track_name == null ? null : String(r.track_name),
      layout: r.track_configuration_name == null ? null : String(r.track_configuration_name),
    },
    matchNote: r.match_note == null ? null : String(r.match_note),
    fileName: String(r.file_name),
    sizeBytes: num(r.size_bytes) ?? 0, durationS: num(r.duration_s) ?? 0,
    recordedAt: r.recorded_at == null ? null : String(r.recorded_at), device: r.device == null ? null : String(r.device),
    width: num(r.width), height: num(r.height),
    offsetS: offset,
    alignment: offset == null ? null : offset !== auto ? 'manual' : (String(r.alignment) as SessionVideo['alignment']),
    alignmentError: num(r.alignment_error),
    laps: Array.isArray(json(r.laps)) ? json(r.laps).map(Number) : [],
    channels: Array.isArray(json(r.channels)) ? json(r.channels).map(String) : [],
    recordCount: num(r.record_count) ?? 0,
    createdAt: r.created_at == null ? null : String(r.created_at),
  }
}

const VIDEO_SELECT = `SELECT v.video_id, v.session_guid, v.match_note, v.file_name, v.size_bytes, v.duration_s, v.recorded_at, v.device,
  v.width, v.height, v.offset_s, v.auto_offset_s, v.alignment, v.alignment_error,
  CAST(v.laps AS VARCHAR) AS laps, CAST(v.channels AS VARCHAR) AS channels, v.record_count, CAST(v.created_at AS VARCHAR) AS created_at,
  CAST(s.session_start AS VARCHAR) AS session_start,
  COALESCE(s.track_name, tc.track_name) AS track_name,
  COALESCE(s.track_configuration_name, tc.track_configuration_name) AS track_configuration_name
  FROM session_videos v
  LEFT JOIN sessions s ON s.session_guid = v.session_guid
  LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id`

/** Every video on the account, newest recording first. */
export async function listAllVideos(con: DuckDBConnection): Promise<SessionVideo[]> {
  const rows = (await con.runAndReadAll(`${VIDEO_SELECT} ORDER BY v.recorded_at DESC NULLS LAST, v.created_at DESC`)).getRowObjectsJson()
  return rows.map(rowToVideo)
}

export async function listSessionVideos(con: DuckDBConnection, sessionGuid: string): Promise<SessionVideo[]> {
  const rows = (await con.runAndReadAll(`${VIDEO_SELECT} WHERE v.session_guid = ? ORDER BY v.recorded_at, v.created_at`, [sessionGuid])).getRowObjectsJson()
  return rows.map(rowToVideo)
}

export async function getSessionVideo(con: DuckDBConnection, videoId: string): Promise<SessionVideo | null> {
  const rows = (await con.runAndReadAll(`${VIDEO_SELECT} WHERE v.video_id = ?`, [videoId])).getRowObjectsJson()
  return rows.length ? rowToVideo(rows[0]) : null
}

/** Video counts per session, for the session list. */
export async function sessionVideoCounts(con: DuckDBConnection): Promise<Map<string, number>> {
  const rows = (await con.runAndReadAll('SELECT session_guid, COUNT(*) FROM session_videos WHERE session_guid IS NOT NULL GROUP BY 1')).getRowsJson()
  return new Map(rows.map(r => [String(r[0]), Number(r[1])]))
}

// A session's laps with their 1 m samples: what a video is matched against.
async function garminLaps(con: DuckDBConnection, sessionGuid: string): Promise<GarminLap[]> {
  const laps = (await con.runAndReadAll(
    'SELECT lap_index, start_time_session_ms, duration_ms FROM laps WHERE session_guid = ? AND start_time_session_ms IS NOT NULL ORDER BY lap_index',
    [sessionGuid],
  )).getRowsJson()
  const samples = (await con.runAndReadAll(`
    SELECT lap_index, distance_m, time_ms, gnss_speed_mps, lat, lon FROM samples
    WHERE session_guid = ? AND distance_m IS NOT NULL ORDER BY lap_index, distance_m, time_ms
  `, [sessionGuid])).getRowsJson()
  const byLap = new Map<number, GarminLap>()
  for (const [index, start, duration] of laps) {
    byLap.set(Number(index), { lapIndex: Number(index), startMs: Number(start), durationMs: Number(duration ?? 0), distM: [], timeMs: [], speed: [], lat: [], lon: [] })
  }
  for (const [index, dist, time, speed, lat, lon] of samples) {
    const lap = byLap.get(Number(index))
    if (!lap) continue
    const d = Number(dist), last = lap.distM.length - 1
    // Rounded distances can repeat; keep the last sample at each metre.
    if (last >= 0 && lap.distM[last] === d) { lap.timeMs[last] = num(time); lap.speed[last] = num(speed); lap.lat[last] = num(lat); lap.lon[last] = num(lon); continue }
    lap.distM.push(d); lap.timeMs.push(num(time)); lap.speed.push(num(speed)); lap.lat.push(num(lat)); lap.lon.push(num(lon))
  }
  return [...byLap.values()].filter(l => l.distM.length > 0)
}

// "YYYY-MM-DD HH:MM:SS" wall-clock times → seconds apart.
function clockGapS(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null
  const a = Date.parse(`${later.replace(' ', 'T').slice(0, 19)}Z`), b = Date.parse(`${earlier.replace(' ', 'T').slice(0, 19)}Z`)
  return Number.isFinite(a) && Number.isFinite(b) ? (a - b) / 1000 : null
}

async function writeLapSamples(con: DuckDBConnection, videoId: string, sessionGuid: string, signals: PdrSignals, durationS: number, offsetS: number, laps: GarminLap[], baseline: number): Promise<number> {
  await con.run('DELETE FROM pdr_lap_samples WHERE video_id = ?', [videoId])
  const appender = await con.createAppender('pdr_lap_samples')
  let count = 0
  const double = (v: number | null) => (v == null || !Number.isFinite(v) ? appender.appendNull() : appender.appendDouble(v))
  try {
    for (const lap of laps) {
      for (const s of lapCarSamples(signals, durationS, offsetS, lap, baseline)) {
        appender.appendVarchar(sessionGuid)
        appender.appendInteger(lap.lapIndex)
        appender.appendInteger(Math.round(s.distM))
        appender.appendVarchar(videoId)
        appender.appendDouble(s.videoT)
        double(s.speedKmh); double(s.rpm); double(s.throttle); double(s.brake)
        if (s.gear == null) appender.appendNull(); else appender.appendInteger(Math.round(s.gear))
        double(s.steering); double(s.latG); double(s.longG)
        for (const w of s.wheels) double(w)
        double(s.slip)
        appender.endRow()
        count++
      }
    }
    appender.flush()
  } finally {
    appender.close()
  }
  return count
}

async function writeRecords(con: DuckDBConnection, videoId: string, records: PdrRecords): Promise<void> {
  const appender = await con.createAppender('pdr_records')
  try {
    for (let i = 0; i < records.channel.length; i++) {
      appender.appendVarchar(videoId)
      appender.appendUSmallInt(records.channel[i])
      appender.appendDouble(records.timeS[i])
      appender.appendInteger(records.value[i])
      appender.endRow()
    }
    appender.flush()
  } finally {
    appender.close()
  }
}

async function storedSignals(con: DuckDBConnection, videoId: string): Promise<PdrSignals> {
  const reader = await con.runAndReadAll('SELECT channel, time_s, value FROM pdr_records WHERE video_id = ? ORDER BY time_s', [videoId])
  const [channels, times, values] = reader.getColumns() as unknown as [number[], number[], number[]]
  const counts = new Map<number, number>()
  for (const c of channels) counts.set(Number(c), (counts.get(Number(c)) ?? 0) + 1)
  const series = new Map<number, RawSeries & { n: number }>()
  for (const [c, n] of counts) series.set(c, { t: new Float64Array(n), v: new Int32Array(n), n: 0 })
  for (let i = 0; i < channels.length; i++) {
    const s = series.get(Number(channels[i]))!
    s.t[s.n] = Number(times[i]); s.v[s.n] = Number(values[i]); s.n++
  }
  return pdrSignals(new Map([...series].map(([c, s]) => [c, { t: s.t, v: s.v }])))
}

// "YYYY-MM-DD HH:MM:SS" + seconds, in the same wall-clock format.
function clockPlus(value: string, seconds: number): string {
  return new Date(Date.parse(`${value.replace(' ', 'T').slice(0, 19)}Z`) + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

interface Candidate { guid: string; start: string | null }

/**
 * Sessions the video may belong to, most likely first. The PDR writes its
 * local clock, which can be whole hours off (time zone or daylight saving):
 * sessions near that clock come first, then those whole hours away.
 */
async function candidateSessions(con: DuckDBConnection, recordedAt: string | null, durationS: number): Promise<Candidate[]> {
  if (!recordedAt || !Number.isFinite(Date.parse(`${recordedAt.replace(' ', 'T').slice(0, 19)}Z`))) return []
  const rows = (await con.runAndReadAll(`
    SELECT session_guid, CAST(session_start AS VARCHAR) FROM sessions
    WHERE session_start BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)
  `, [clockPlus(recordedAt, -15 * 3600), clockPlus(recordedAt, 15 * 3600 + durationS)])).getRowsJson()
  // A session usually starts a little before the recording, or during it.
  const near = (gap: number) => (gap < -3 * 3600 ? Infinity : gap <= durationS + 900 ? Math.abs(gap) : gap - durationS)
  return rows.map(r => {
    const gap = clockGapS(String(r[1]), recordedAt) ?? Infinity
    const hours = Math.round(gap / 3600)
    const score = Math.min(near(gap), hours ? 7200 + near(gap - hours * 3600) : Infinity)
    return { guid: String(r[0]), start: r[1] == null ? null : String(r[1]), score }
  }).filter(c => Number.isFinite(c.score)).sort((a, b) => a.score - b.score).slice(0, 5)
}

interface Decoded { durationS: number; recordedAt: string | null; signals: PdrSignals }

/** Downloads sessions' telemetry when it is not in the workspace yet. */
export type EnsureDetails = (guids: string[]) => Promise<void>

type Found = { guid: string; align: VideoAlignment; laps: GarminLap[] } | { guid: null; note: string }

const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} min`

/** The session (and where in it) this video belongs, or why none matched. */
async function findSession(con: DuckDBConnection, video: Decoded, sessionGuid: string | null, ensureDetails: EnsureDetails): Promise<Found> {
  const speed = video.signals.get('speed')
  const when = video.recordedAt ? `recorded ${video.recordedAt.slice(0, 16)}, ${minutes(video.durationS)}` : minutes(video.durationS)
  if (!speed) return { guid: null, note: `This video (${when}) has no vehicle speed channel to match against your laps.` }
  if (!speed.v.some(v => v > 30)) return { guid: null, note: `The car is not driving in this video (${when}), so it cannot be placed on a lap.` }

  const candidates: Candidate[] = sessionGuid
    ? (await con.runAndReadAll('SELECT session_guid, CAST(session_start AS VARCHAR) FROM sessions WHERE session_guid = ?', [sessionGuid])).getRowsJson()
      .map(r => ({ guid: String(r[0]), start: r[1] == null ? null : String(r[1]) }))
    : await candidateSessions(con, video.recordedAt, video.durationS)
  if (sessionGuid && !candidates.length) return { guid: null, note: 'That session is not in your workspace.' }

  let best: Extract<Found, { align: VideoAlignment }> | null = null
  const problems: string[] = []
  for (const candidate of candidates) {
    let laps = await garminLaps(con, candidate.guid)
    if (!laps.length) {
      // Its telemetry was never downloaded: fetch it now.
      try { await ensureDetails([candidate.guid]); laps = await garminLaps(con, candidate.guid) } catch (error) {
        problems.push(`telemetry for your ${candidate.start?.slice(0, 16) ?? ''} session could not be downloaded (${error instanceof Error ? error.message : String(error)})`)
      }
      if (!laps.length) continue
    }
    const align = alignVideo(video.signals, video.durationS, laps, clockGapS(video.recordedAt, candidate.start))
    if (!align) continue
    const better = !best || (align.method === best.align.method ? align.error < best.align.error : align.method === 'position')
    if (better) best = { guid: candidate.guid, align, laps }
  }
  if (best) return best
  const also = problems.length ? ` Also: ${problems.join('; ')}.` : ''
  if (sessionGuid) {
    const near = (await candidateSessions(con, video.recordedAt, video.durationS)).filter(c => c.guid !== sessionGuid).slice(0, 2)
    return { guid: null, note: `This video (${when}) does not match any lap of that session.${near.length ? ` By its clock it is closer to your session from ${near.map(c => c.start?.slice(0, 16)).join(' or ')}.` : ''}${also}` }
  }
  return {
    guid: null,
    note: `No Garmin session matches this video (${when}).${candidates.length ? ` Checked ${candidates.length} session${candidates.length === 1 ? '' : 's'} near its clock.` : ' No session starts near its clock.'}${also} Sync your sessions, then match it again on the Import page.`,
  }
}

async function placeVideo(con: DuckDBConnection, videoId: string, found: Found, video: Decoded): Promise<void> {
  await con.run('DELETE FROM pdr_lap_samples WHERE video_id = ?', [videoId])
  if (found.guid === null) {
    await con.run(`UPDATE session_videos SET session_guid = NULL, match_note = ?, offset_s = NULL, auto_offset_s = NULL,
      alignment = NULL, alignment_error = NULL, laps = '[]' WHERE video_id = ?`, [found.note, videoId])
    return
  }
  const baseline = slipBaseline(video.signals)
  await con.run(`UPDATE session_videos SET session_guid = ?, match_note = NULL, offset_s = ?, auto_offset_s = ?, alignment = ?,
    alignment_error = ?, laps = ?, slip_baseline = ? WHERE video_id = ?`, [
    found.guid, found.align.offsetS, found.align.offsetS, found.align.method, found.align.error,
    JSON.stringify(found.align.laps), baseline, videoId,
  ] as any)
  await writeLapSamples(con, videoId, found.guid, video.signals, video.durationS, found.align.offsetS, found.laps, baseline)
}

function describe(video: SessionVideo, matched: boolean): string {
  if (!matched) return video.matchNote ?? 'No matching session.'
  const s = video.session
  const laps = video.laps.length ? `${video.laps.length} lap${video.laps.length === 1 ? '' : 's'} (${video.laps.map(i => `L${i + 1}`).join(', ')})` : 'no complete laps'
  return `Matched to ${[s?.track, s?.layout].filter(Boolean).join(' · ') || 'your session'}${s?.start ? ` on ${s.start.slice(0, 16)}` : ''}: ${laps}.`
}

async function inTransaction(con: DuckDBConnection, work: () => Promise<void>): Promise<void> {
  await con.run('BEGIN TRANSACTION')
  try {
    await work()
    await con.run('COMMIT')
  } catch (error) {
    await con.run('ROLLBACK').catch(() => {})
    throw error
  }
}

/**
 * Decode a PDR video, store its telemetry, and attach it to the session it
 * was recorded in: the given one, or the best match by clock and telemetry.
 * A video that matches no session is kept, unattached, with the reason.
 */
export async function importVideo(con: DuckDBConnection, opts: {
  videoId: string; filePath: string; fileName: string; sizeBytes: number; sessionGuid: string | null; ensureDetails: EnsureDetails
}): Promise<VideoImportResult> {
  const file: PdrFile = await readPdrFile(opts.filePath)
  const video: Decoded = { durationS: file.durationS, recordedAt: file.recordedAt, signals: pdrSignals(channelSeries(file.records)) }
  const found = await findSession(con, video, opts.sessionGuid, opts.ensureDetails)
  await inTransaction(con, async () => {
    await con.run(`
      INSERT INTO session_videos (video_id, file_name, size_bytes, duration_s, recorded_at, device, width, height, channels, record_count, laps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
    `, [
      opts.videoId, opts.fileName, opts.sizeBytes, file.durationS, file.recordedAt, file.device, file.width, file.height,
      JSON.stringify([...video.signals.keys()].sort()), file.records.channel.length,
    ] as any)
    await writeRecords(con, opts.videoId, file.records)
    await placeVideo(con, opts.videoId, found, video)
  })
  const stored = (await getSessionVideo(con, opts.videoId))!
  const matched = found.guid !== null
  console.log(`[video] ${opts.fileName}: ${matched ? `session ${found.guid!.slice(0, 8)}, offset ${stored.offsetS} s by ${stored.alignment} (±${stored.alignmentError})` : found.note}`)
  return { video: stored, matched, message: describe(stored, matched) }
}

/** Match a stored video again: to the given session, or the best match. */
export async function rematchVideo(con: DuckDBConnection, videoId: string, sessionGuid: string | null, ensureDetails: EnsureDetails): Promise<VideoImportResult> {
  const stored = await getSessionVideo(con, videoId)
  if (!stored) throw new Error('That video is no longer on your account.')
  const video: Decoded = { durationS: stored.durationS, recordedAt: stored.recordedAt, signals: await storedSignals(con, videoId) }
  const found = await findSession(con, video, sessionGuid, ensureDetails)
  // A failed match against a chosen session leaves an attached video where it was.
  if (found.guid === null && stored.sessionGuid) return { video: stored, matched: false, message: found.note }
  await inTransaction(con, () => placeVideo(con, videoId, found, video))
  const updated = (await getSessionVideo(con, videoId))!
  return { video: updated, matched: found.guid !== null, message: describe(updated, found.guid !== null) }
}

/** Recompute a video's lap samples (new offset, or the session's laps reloaded). */
async function relayVideo(con: DuckDBConnection, video: SessionVideo, offsetS: number): Promise<void> {
  if (!video.sessionGuid) return
  const laps = await garminLaps(con, video.sessionGuid)
  const signals = await storedSignals(con, video.id)
  const baseline = num((await con.runAndReadAll('SELECT slip_baseline FROM session_videos WHERE video_id = ?', [video.id])).getRowsJson()[0]?.[0]) ?? 1
  const covered = laps.filter(lap => {
    const times = lap.timeMs.filter((t): t is number => t != null)
    const inside = times.filter(t => { const v = (lap.startMs + t) / 1000 - offsetS; return v >= 0 && v <= video.durationS }).length
    return times.length > 0 && inside / times.length >= 0.5
  }).map(l => l.lapIndex)
  const guid = video.sessionGuid
  await inTransaction(con, async () => {
    await con.run('UPDATE session_videos SET offset_s = ?, laps = ? WHERE video_id = ?', [offsetS, JSON.stringify(covered), video.id] as any)
    await writeLapSamples(con, video.id, guid, signals, video.durationS, offsetS, laps, baseline)
  })
}

/** Nudge a video's sync; null returns to the matched offset. */
export async function setVideoOffset(con: DuckDBConnection, videoId: string, offsetS: number | null): Promise<SessionVideo> {
  const video = await getSessionVideo(con, videoId)
  if (!video) throw new Error('That video is no longer on your account.')
  if (!video.sessionGuid) throw new Error('Match this video to a session before adjusting its sync.')
  let target = offsetS
  if (target == null) target = num((await con.runAndReadAll('SELECT auto_offset_s FROM session_videos WHERE video_id = ?', [videoId])).getRowsJson()[0]?.[0])
  if (target == null || !Number.isFinite(target)) throw new Error('Invalid video offset')
  await relayVideo(con, video, Math.round(target * 1000) / 1000)
  return (await getSessionVideo(con, videoId))!
}

/** A session's laps were reloaded from Garmin: put its videos back on them. */
export async function refreshSessionVideos(con: DuckDBConnection, sessionGuid: string): Promise<void> {
  for (const video of await listSessionVideos(con, sessionGuid)) if (video.offsetS != null) await relayVideo(con, video, video.offsetS)
}

/** Remove a video's rows; the caller deletes the file. */
export async function deleteSessionVideo(con: DuckDBConnection, videoId: string): Promise<SessionVideo | null> {
  const video = await getSessionVideo(con, videoId)
  if (!video) return null
  await inTransaction(con, async () => {
    await con.run('DELETE FROM pdr_lap_samples WHERE video_id = ?', [videoId])
    await con.run('DELETE FROM pdr_records WHERE video_id = ?', [videoId])
    await con.run('DELETE FROM session_videos WHERE video_id = ?', [videoId])
  })
  return video
}

const round = (v: unknown, places: number): number | null => {
  const n = num(v)
  if (n == null) return null
  const f = 10 ** places
  return Math.round(n * f) / f
}

/**
 * Car data for these laps on a `strideM` grid. A lap covered by more than
 * one video uses the one with the most samples on it.
 */
export async function carDataForLaps(
  con: DuckDBConnection,
  laps: Array<{ sg: string; lapIdx: number }>,
  system: UnitSystem = DEFAULT_UNIT_SYSTEM,
  strideM = 5,
): Promise<CarData | null> {
  const sessions = [...new Set(laps.map(l => l.sg))]
  if (!sessions.length) return null
  const marks = sessions.map(() => '?').join(',')
  const videos = (await con.runAndReadAll(`
    SELECT video_id, session_guid, file_name, duration_s, recorded_at, CAST(laps AS VARCHAR) FROM session_videos
    WHERE session_guid IN (${marks}) AND offset_s IS NOT NULL ORDER BY recorded_at, created_at
  `, sessions)).getRowsJson()
  if (!videos.length) return null
  const wanted = new Set(laps.map(l => `${l.sg}:${l.lapIdx}`))
  // Only laps a video mostly covers (its `laps`); a lap's first or last
  // seconds at the edge of a recording are left out.
  const covers = new Set(videos.flatMap(v => (Array.isArray(json(v[5])) ? json(v[5]) : []).map((lap: unknown) => `${v[0]}:${v[1]}:${lap}`)))
  const coverage = (await con.runAndReadAll(`
    SELECT session_guid, lap_index, video_id, COUNT(*) FROM pdr_lap_samples
    WHERE session_guid IN (${marks}) GROUP BY ALL
  `, sessions)).getRowsJson()
  const chosen = new Map<string, { videoId: string; n: number }>()
  for (const [sg, lap, video, n] of coverage) {
    const key = `${sg}:${lap}`
    if (!wanted.has(key) || !covers.has(`${video}:${key}`)) continue
    if (!chosen.has(key) || Number(n) > chosen.get(key)!.n) chosen.set(key, { videoId: String(video), n: Number(n) })
  }
  const toSpeed = (kmh: unknown) => { const v = num(kmh); return v == null ? null : round(speedFromMps(v / 3.6, system), 1) }
  const traces: CarTrace[] = []
  for (const lap of laps) {
    const pick = chosen.get(`${lap.sg}:${lap.lapIdx}`)
    if (!pick) continue
    const rows = (await con.runAndReadAll(`
      SELECT distance_m, video_time_s, throttle_pct, brake_bar, rpm, gear, steering_deg, rear_slip_pct, speed_kmh
      FROM pdr_lap_samples WHERE session_guid = ? AND lap_index = ? AND video_id = ? AND distance_m % ? = 0
      ORDER BY distance_m
    `, [lap.sg, lap.lapIdx, pick.videoId, strideM])).getRowsJson()
    const trace: CarTrace = { sg: lap.sg, lapIdx: lap.lapIdx, videoId: pick.videoId, dist: [], videoT: [], throttle: [], brake: [], rpm: [], gear: [], steering: [], slip: [], speed: [] }
    for (const r of rows) {
      const d = Number(r[0])
      if (trace.dist.length && trace.dist[trace.dist.length - 1] === d) continue
      trace.dist.push(d); trace.videoT.push(round(r[1], 3))
      trace.throttle.push(round(r[2], 0)); trace.brake.push(round(r[3], 1)); trace.rpm.push(round(r[4], 0))
      trace.gear.push(num(r[5])); trace.steering.push(round(r[6], 1)); trace.slip.push(round(r[7], 2)); trace.speed.push(toSpeed(r[8]))
    }
    if (trace.dist.length) traces.push(trace)
  }
  return {
    videos: videos.map(v => ({ id: String(v[0]), sg: String(v[1]), fileName: String(v[2]), durationS: num(v[3]) ?? 0, recordedAt: v[4] == null ? null : String(v[4]) })),
    traces,
    speedUnit: speedUnitLabel(system),
  }
}

/** Every lap of a session, labelled, with car data where a video covers it. */
export async function sessionLapList(con: DuckDBConnection, sessionGuid: string): Promise<Array<{ lapIdx: number; durationMs: number; label: string; isBest: boolean }>> {
  const rows = (await con.runAndReadAll(`
    SELECT l.lap_index, l.duration_ms, CAST(s.session_start AS VARCHAR) FROM laps l JOIN sessions s USING (session_guid)
    WHERE l.session_guid = ? AND l.duration_ms > 0 ORDER BY l.lap_index
  `, [sessionGuid])).getRowsJson()
  const best = Math.min(...rows.map(r => Number(r[1])))
  return rows.map(r => ({ lapIdx: Number(r[0]), durationMs: Number(r[1]), label: lapLabel(r[2] == null ? null : String(r[2]), Number(r[0])), isBest: Number(r[1]) === best }))
}
