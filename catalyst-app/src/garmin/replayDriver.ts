// Another driver's lap in your 3D replay (driver comparison).
//
// As with Analysis's comparison (driverComparison.ts), each backend reads
// only its own database. The server asks the compared driver's backend for
// the valid laps of one of their sessions (exportReplayLaps) or one of those
// laps (exportReplayLap): read-only, telemetry already in their workspace,
// never a sync or a download. It adds their name and hands the lap to your
// backend, which checks it is on your scene's course and moves it onto your
// scene's mean line (replayDriverLap), as replay:lap does for your own laps
// from another mean line. Their video travels by reference: the lap's car
// trace carries its ID and their name, and the player streams it through
// the server's driver video route, as Analysis does.

import type { DuckDBConnection } from '@duckdb/node-api'
import { fetchSessionMeta, sessionLayout, type SessionMeta } from './coachPacket.js'
import { fetchValidLaps, lapLabel, shortSessionLabel } from './lapData.js'
import { isMeanLineTrace, mapToOwnLine, ownLine, readMeanLineTrace, type MeanLineTrace } from './meanLineAlign.js'
import { remapReplayLap, sessionLap, videoLaps } from './replayData.js'
import { sameCourse, type TrackLayoutIdentity } from '../shared/trackLayout.js'
import { VIDEO_ID_RE } from '../shared/pdr.js'
import { replayLapRequest, vehicleKey, type ReplayDriverLap, type ReplayLap, type ReplayLapInfo, type ReplayVehicle } from '../shared/replay.js'

const GUID_RE = /^[a-zA-Z0-9_-]{1,128}$/

/** The compared session, as their backend describes it (enough to check the course). */
export interface ReplayLapSession {
  sg: string
  start: string | null
  trackName: string | null
  configName: string | null
  configurationId: number | null
  meanLineGuid: string | null
}

/** What the compared driver's backend returns for one lap. */
export interface ReplayLapExport {
  session: ReplayLapSession
  vehicle: ReplayVehicle
  /** Measured along their session's own mean line. */
  lap: ReplayLap
  /** That mean line, thinned, so your backend can map their metres onto yours. */
  line: MeanLineTrace | null
}

/** The export plus the driver's name, added by the server. */
export interface ReplayLapBundle extends ReplayLapExport {
  driver: string
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// The session, only when its telemetry is in this workspace.
async function downloadedSession(con: DuckDBConnection, sessionGuid: string): Promise<SessionMeta> {
  const [meta] = await fetchSessionMeta(con, [sessionGuid])
  if (!meta) throw new Error('That session is no longer available. Choose another.')
  const [row] = (await con.runAndReadAll('SELECT COALESCE(details_loaded, false) AS loaded FROM sessions WHERE session_guid = ?', [sessionGuid])).getRowObjectsJson()
  if (row?.loaded !== true) throw new Error('The telemetry for that session has not been downloaded. That driver can download it from their Sessions page.')
  return meta
}

// ─── Export (runs in the compared driver's backend) ─────────────────────────

/** One session's valid laps, in lap order, with its best and the laps a video covers. */
export async function exportReplayLaps(con: DuckDBConnection, sessionGuid: unknown): Promise<ReplayLapInfo[]> {
  if (typeof sessionGuid !== 'string' || !GUID_RE.test(sessionGuid)) throw new Error('Invalid session ID')
  const meta = await downloadedSession(con, sessionGuid)
  const valid = (await fetchValidLaps(con, [sessionGuid])).sort((a, b) => a.lapIndex - b.lapIndex)
  const covered = await videoLaps(con, [sessionGuid])
  const best = valid.length ? Math.min(...valid.map(l => l.durationMs)) : null
  return valid.map(l => ({
    sessionGuid, lap: l.lapIndex, durationMs: l.durationMs, label: lapLabel(meta.start, l.lapIndex),
    isBest: l.durationMs === best, hasVideo: covered.has(`${sessionGuid}:${l.lapIndex}`),
  }))
}

/**
 * One valid lap (the same laps Analysis's comparison may export: valid and
 * not excluded), on this workspace's mean line, with the session's course
 * and car and that mean line.
 */
export async function exportReplayLap(con: DuckDBConnection, request: unknown): Promise<ReplayLapExport> {
  const { sessionGuid, lap, units } = replayLapRequest(request)
  const meta = await downloadedSession(con, sessionGuid)
  const valid = await fetchValidLaps(con, [sessionGuid])
  if (!valid.some(l => l.lapIndex === lap)) throw new Error(`L${lap + 1} is not a valid lap of that session.`)
  return {
    session: {
      sg: meta.session_guid, start: meta.start, trackName: meta.track_name, configName: meta.track_configuration_name,
      configurationId: num(meta.track_configuration_id), meanLineGuid: meta.mean_line_guid,
    },
    vehicle: {
      guid: meta.vehicle_guid, make: meta.vehicle_make, model: meta.vehicle_model,
      year: num(meta.vehicle_year), key: vehicleKey(meta.vehicle_make, meta.vehicle_model),
    },
    lap: await sessionLap(con, meta, { sessionGuid, lap }, units),
    // Every 5 m is plenty to map it onto your line (as Analysis's export).
    line: readMeanLineTrace(meta.mean_line_guid, 5),
  }
}

// ─── Your side (runs in your backend) ───────────────────────────────────────

const finiteArray = (v: unknown, n: number, nullable: boolean) =>
  Array.isArray(v) && v.length === n && v.every(x => (nullable && x === null) || (typeof x === 'number' && Number.isFinite(x)))
const text = (v: unknown) => v === null || typeof v === 'string'

/** Structural check of a lap received from another backend. */
export function isReplayLapBundle(value: unknown): value is ReplayLapBundle {
  const b = value as ReplayLapBundle
  if (!b || typeof b !== 'object' || typeof b.driver !== 'string' || !b.driver) return false
  const s = b.session, v = b.vehicle, lap = b.lap
  if (!s || typeof s !== 'object' || typeof s.sg !== 'string' || !GUID_RE.test(s.sg) || !text(s.start) || !text(s.trackName) || !text(s.configName) || !text(s.meanLineGuid)) return false
  if (s.configurationId !== null && !Number.isFinite(s.configurationId)) return false
  if (!v || typeof v !== 'object' || !text(v.make) || !text(v.model) || !text(v.key)) return false
  if (!lap || typeof lap !== 'object' || lap.sessionGuid !== s.sg || !Number.isSafeInteger(lap.lap) || !(lap.durationMs > 0)) return false
  const n = Array.isArray(lap.dist) ? lap.dist.length : 0
  if (!n || !finiteArray(lap.dist, n, false) || !finiteArray(lap.timeMs, n, false) || !finiteArray(lap.lat, n, false) || !finiteArray(lap.lon, n, false)
    || !finiteArray(lap.speedMps, n, false) || !finiteArray(lap.altM, n, true) || !finiteArray(lap.accelX, n, true)
    || !finiteArray(lap.accelY, n, true) || !finiteArray(lap.headingDeg, n, true)
    || (lap.lateral !== undefined && !finiteArray(lap.lateral, n, true))) return false
  const car = lap.car
  if (car != null && (typeof car !== 'object' || typeof car.videoId !== 'string' || !VIDEO_ID_RE.test(car.videoId) || !Array.isArray(car.dist) || !Array.isArray(car.videoT))) return false
  return b.line == null || isMeanLineTrace(b.line)
}

const layoutOf = (s: ReplayLapSession): TrackLayoutIdentity => ({
  meanLineGuid: s.meanLineGuid, configurationId: s.configurationId, trackLabel: `${s.trackName ?? ''} · ${s.configName ?? ''}`,
})

/**
 * Their lap in your replay: on your scene's course (matched by Garmin's
 * course ID, as their mean line is their own device's), measured along your
 * scene's mean line, labelled with their name and car.
 */
export async function replayDriverLap(con: DuckDBConnection, sceneGuid: string, bundle: unknown): Promise<ReplayDriverLap> {
  if (bundle && typeof bundle === 'object' && !('lap' in bundle && 'session' in bundle)) {
    throw new Error('Racing another driver needs the Catalyst server. Open Catalyst Coach in a browser and sign in with your driver name.')
  }
  if (!isReplayLapBundle(bundle)) throw new Error('The other driver’s lap was incomplete. Try again.')
  const [scene] = await fetchSessionMeta(con, [sceneGuid])
  if (!scene) throw new Error('That session is not in your workspace.')
  const theirs = bundle.session
  if (!sameCourse(sessionLayout(scene), layoutOf(theirs))) {
    const where = [theirs.trackName, theirs.configName].filter(Boolean).join(' · ') || 'an unknown layout'
    const own = [scene.track_name, scene.track_configuration_name].filter(Boolean).join(' · ') || 'this layout'
    throw new Error(`${bundle.driver}'s session from ${shortSessionLabel(theirs.start)} is on ${where}. Choose one of their sessions on ${own}.`)
  }
  // Their device's mean line onto your scene's (meanLineAlign.ts).
  const theirGuid = theirs.meanLineGuid ?? bundle.line?.guid ?? null
  const map = mapToOwnLine(theirGuid, bundle.line, bundle.lap.dist.at(-1) ?? 0, ownLine(scene.mean_line_guid, 0))
  const lap = map ? remapReplayLap(bundle.lap, map) : bundle.lap
  const car = lap.car ? { ...lap.car, driver: bundle.driver, label: `${bundle.driver} · ${lap.label}` } : null
  return { ...lap, car, driver: bundle.driver, vehicle: bundle.vehicle }
}
