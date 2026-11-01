// Garmin Catalyst session videos, as the device stores them:
//
//   …/Android/data/com.garmin.racingcoach/files/RaceData/
//     <DRIVER>/<Track name>/<CAR MAKE MODEL YEAR>/<YYYYMMDD>/<HHMMSS>/
//       video_1.mp4             the whole session (video_2.mp4… if split)
//       optimal_lap_video.mp4   Garmin's render of the optimal lap
//
// The folder clock is the device's local time (the track's) when the session
// was started on the device, and Garmin's lap times count from that moment.
// The recording itself starts at Garmin's session start (sessionStart, a few
// seconds to minutes later), about 0.4 s late. Neither the MP4 (no data
// track, no creation time) nor the synced telemetry carries anything else to
// line them up with, so a lap's time in the video is
//   lap time − (session start − folder clock) − 0.4 s.
// Measured by matching the video's rotation against Garmin's turn rate on four
// sessions from 2025–26: within 0.1–0.6 s of this (mean +0.4 s).

export type CatalystVideoKind = 'session' | 'optimal'

export interface CatalystVideoPath {
  // DRIVER/Track/Car/YYYYMMDD/HHMMSS/file: the same on any card or mount.
  key: string
  // The session folder: DRIVER/Track/Car/YYYYMMDD/HHMMSS.
  folder: string
  driver: string
  track: string
  car: string
  // Folder clock, "YYYY-MM-DD HH:MM:SS" (local track time).
  recordedAt: string
  fileName: string
  kind: CatalystVideoKind
  // video_N's N; 0 for the optimal-lap video.
  part: number
}

const SEGMENT_MAX = 200

/** A Catalyst video's place in RaceData, from any path ending in it; else null. */
export function parseCatalystPath(input: string): CatalystVideoPath | null {
  if (typeof input !== 'string' || input.length > 2048) return null
  const parts = input.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length < 6) return null
  const [driver, track, car, date, time, fileName] = parts.slice(-6)
  if ([driver, track, car].some(s => s.length > SEGMENT_MAX || s === '.' || s === '..')) return null
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(date)
  const t = /^(\d{2})(\d{2})(\d{2})$/.exec(time)
  const f = /^(?:video_(\d{1,3})|optimal_lap_video)\.mp4$/i.exec(fileName)
  if (!d || !t || !f) return null
  const recordedAt = `${d[1]}-${d[2]}-${d[3]} ${t[1]}:${t[2]}:${t[3]}`
  const check = new Date(`${recordedAt.replace(' ', 'T')}Z`)
  // Rejects 20261345 and the like.
  if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 19).replace('T', ' ') !== recordedAt) return null
  const part = f[1] ? Number(f[1]) : 0
  if (f[1] && part < 1) return null
  const folder = [driver, track, car, date, time].join('/')
  return { key: `${folder}/${fileName}`, folder, driver, track, car, recordedAt, fileName, kind: part ? 'session' : 'optimal', part }
}

/** How a Catalyst video is listed: "Catalyst 2026-10-30 08:29 · session video". */
export function catalystVideoName(p: CatalystVideoPath): string {
  const what = p.kind === 'optimal' ? 'optimal lap' : p.part > 1 ? `session video, part ${p.part}` : 'session video'
  return `Catalyst ${p.recordedAt.slice(0, 16)} · ${what}`
}

/** One file found on the device, as the browser reports it. */
export interface CatalystPlanEntry {
  // Any path ending in DRIVER/Track/Car/YYYYMMDD/HHMMSS/file.
  path: string
  size: number
}

export interface CatalystPlanFile {
  key: string
  fileName: string
  kind: CatalystVideoKind
  part: number
  size: number
  // Already on the account: its video ID and the session it is attached to.
  importedId: string | null
  importedSession: string | null
}

export interface CatalystSessionMatch {
  guid: string
  start: string
  track: string | null
  layout: string | null
  car: string | null
  // Session start − folder clock, in seconds (usually 0 to 10 minutes).
  gapS: number
}

export interface CatalystPlanFolder {
  folder: string
  driver: string
  track: string
  car: string
  recordedAt: string
  // The synced Garmin session this recording belongs to, or why none.
  session: CatalystSessionMatch | null
  note: string | null
  files: CatalystPlanFile[]
}

export interface CatalystPlan {
  // Newest recording first.
  folders: CatalystPlanFolder[]
}

// A session recording on the device starts this long before its Garmin
// session at most (seen: 0 s to 19 min), or a little after it.
export const CATALYST_MATCH_BEFORE_S = 3 * 60
export const CATALYST_MATCH_AFTER_S = 30 * 60

// The camera starts this long after Garmin's session start (measured mean).
export const CATALYST_VIDEO_LAG_S = 0.4

/**
 * Session time = video time + this, for video_1 of a folder recorded at
 * `folderClock` and the Garmin session starting at `sessionStart` (both
 * "YYYY-MM-DD HH:MM:SS", local); null when the two cannot be the same session.
 */
export function catalystVideoOffset(folderClock: string, sessionStart: string): number | null {
  const s = (c: string) => Date.parse(`${c.replace(' ', 'T').slice(0, 19)}Z`) / 1000
  const gap = s(sessionStart) - s(folderClock)
  if (!Number.isFinite(gap) || gap < -CATALYST_MATCH_BEFORE_S || gap > CATALYST_MATCH_AFTER_S) return null
  return Math.round((gap + CATALYST_VIDEO_LAG_S) * 1000) / 1000
}
