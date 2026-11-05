// 3D lap replay: a session's track, laps and ghost candidates
// (replay:scene), and one lap's samples measured along the scene's mean line
// (replay:lap). Both read only this workspace's database and mean lines.

import type { DuckDBConnection } from '@duckdb/node-api'
import { fetchSessionMeta, sessionLayout, type SessionMeta } from './coachPacket.js'
import { layoutForSession } from './trackStore.js'
import { buildTrackGeometry } from './trackGeometry.js'
import { fetchOptimalLapTimes, fetchValidLaps, lapLabel, shortSessionLabel, validLapPredicate } from './lapData.js'
import { mapPosition, mapToOwnLine, ownLine, readMeanLineTrace, type DistanceMap } from './meanLineAlign.js'
import { carDataForLaps } from './videoStore.js'
import { sameCourse } from '../shared/trackLayout.js'
import { DEFAULT_UNIT_SYSTEM, type UnitSystem } from '../shared/units.js'
import type { CarTrace } from '../shared/pdr.js'
import { vehicleKey, type GeoBox, type ReplayCorner, type ReplayLap, type ReplayLapInfo, type ReplayLapRef, type ReplayScene } from '../shared/replay.js'

const MAX_GHOSTS = 40
// Terrain reaches this far past the track on every side.
const AREA_MARGIN_M = 400
// A facility's layouts share one terrain unless together they span more than this.
const MAX_FACILITY_SPAN_DEG = 0.06
const M_PER_DEG = 111_320
const GUID_RE = /^[a-zA-Z0-9_-]{1,128}$/

async function rows(con: DuckDBConnection, sql: string, params: unknown[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params as any[])).getRowObjectsJson() as any[]
}

async function hasTable(con: DuckDBConnection, name: string): Promise<boolean> {
  return (await rows(con, "SELECT 1 FROM duckdb_tables() WHERE table_name = ? AND schema_name = 'main'", [name])).length > 0
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const round = (v: number, places: number) => { const f = 10 ** places; return Math.round(v * f) / f }

/** Validates a lap reference from the renderer. */
export function replayLapRef(value: unknown): ReplayLapRef {
  const ref = value as ReplayLapRef
  if (!ref || typeof ref !== 'object' || typeof ref.sessionGuid !== 'string' || !GUID_RE.test(ref.sessionGuid)) throw new Error('Invalid lap')
  if (ref.lap !== 'optimal' && !(Number.isSafeInteger(ref.lap) && ref.lap >= 0)) throw new Error('Invalid lap')
  return { sessionGuid: ref.sessionGuid, lap: ref.lap }
}

// ─── Mean-line bounds (a mean line's points never change for its ID) ────────

const lineBounds = new Map<string, GeoBox | null>()
function boundsOfLine(guid: string): GeoBox | null {
  if (lineBounds.has(guid)) return lineBounds.get(guid)!
  const trace = readMeanLineTrace(guid)
  const box = trace ? {
    south: Math.min(...trace.lat), north: Math.max(...trace.lat),
    west: Math.min(...trace.lon), east: Math.max(...trace.lon),
  } : null
  lineBounds.set(guid, box)
  return box
}

// The terrain to load: every layout of this facility the driver has a mean
// line for, plus a margin, so the facility's layouts share one terrain.
async function sceneArea(con: DuckDBConnection, meta: SessionMeta, own: GeoBox): Promise<GeoBox> {
  const others = await rows(con, `
    SELECT DISTINCT s.mean_line_guid AS guid FROM sessions s
    JOIN sessions me ON me.session_guid = ?
    WHERE s.mean_line_guid IS NOT NULL AND s.mean_line_guid <> COALESCE(me.mean_line_guid, '')
      AND (s.track_cartography_id = me.track_cartography_id
        OR (s.track_cartography_id IS NULL OR me.track_cartography_id IS NULL) AND s.track_name = me.track_name)
  `, [meta.session_guid])
  let box = { ...own }
  for (const { guid } of others) {
    const b = boundsOfLine(String(guid))
    if (!b) continue
    const merged = { south: Math.min(box.south, b.south), north: Math.max(box.north, b.north), west: Math.min(box.west, b.west), east: Math.max(box.east, b.east) }
    // A stray line far away (another facility of the same name) is left out.
    if (merged.north - merged.south <= MAX_FACILITY_SPAN_DEG && merged.east - merged.west <= MAX_FACILITY_SPAN_DEG) box = merged
  }
  const dLat = AREA_MARGIN_M / M_PER_DEG
  const dLon = AREA_MARGIN_M / (M_PER_DEG * Math.cos(((box.south + box.north) / 2) * Math.PI / 180))
  return {
    south: round(box.south - dLat, 6), north: round(box.north + dLat, 6),
    west: round(box.west - dLon, 6), east: round(box.east + dLon, 6),
  }
}

// ─── Videos ─────────────────────────────────────────────────────────────────

// "sg:lapIdx" for every lap a synced video covers.
async function videoLaps(con: DuckDBConnection, sessionGuids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (!sessionGuids.length || !await hasTable(con, 'session_videos')) return out
  const found = await rows(con, `
    SELECT session_guid, CAST(laps AS VARCHAR) AS laps FROM session_videos
    WHERE session_guid IN (${sessionGuids.map(() => '?').join(',')}) AND offset_s IS NOT NULL
  `, sessionGuids)
  for (const row of found) {
    let laps: unknown
    try { laps = JSON.parse(String(row.laps ?? '[]')) } catch { laps = [] }
    if (Array.isArray(laps)) for (const lap of laps) out.add(`${row.session_guid}:${lap}`)
  }
  return out
}

// ─── Scene ──────────────────────────────────────────────────────────────────

export async function replayScene(con: DuckDBConnection, sessionGuid: string, units: UnitSystem = DEFAULT_UNIT_SYSTEM): Promise<ReplayScene> {
  const [meta] = await fetchSessionMeta(con, [sessionGuid])
  if (!meta) throw new Error('That session is not in your workspace.')
  const geometry = meta.mean_line_guid ? buildTrackGeometry(meta.mean_line_guid) : null
  if (!geometry) throw new Error('This session has no track map yet: its mean line has not been downloaded.')

  // The mean line at its own ~1 m spacing, strictly increasing.
  const line: ReplayScene['track']['line'] = { dist: [], lat: [], lon: [] }
  for (const p of geometry.centerline) {
    const last = line.dist.at(-1)
    if (![p.dist, p.lat, p.lon].every(Number.isFinite) || (last != null && p.dist <= last)) continue
    line.dist.push(round(p.dist, 2)); line.lat.push(round(p.lat, 8)); line.lon.push(round(p.lon, 8))
  }
  if (line.dist.length < 3) throw new Error('This session’s mean line is empty.')
  const totalDistM = line.dist.at(-1)!

  const layout = await layoutForSession(con, meta)
  const corners: ReplayCorner[] = (layout?.corners ?? [])
    .filter(c => Number.isFinite(c.apex_idx))
    .sort((a, b) => a.apex_idx - b.apex_idx)
    .map(c => ({
      turn: c.turn, name: c.name ?? '', apexM: c.apex_idx,
      startM: c.dist_idx_start ?? c.apex_idx, endM: c.dist_idx_end ?? c.apex_idx,
      ...(c.direction === 'left' || c.direction === 'right' ? { direction: c.direction } : {}),
    }))
  // Garmin's primary sectors (flag 1); each runs from its start to the next.
  const segments = layout?.segments?.length ? layout.segments : geometry.segments
  const primary = segments.some(s => s.flag === 1) ? segments.filter(s => s.flag === 1) : segments
  const sectorsM = [...new Set(primary.map(s => s.start_dist_m).filter(m => Number.isFinite(m) && m >= 0 && m < totalDistM))].sort((a, b) => a - b)

  const own: GeoBox = {
    south: Math.min(...line.lat), north: Math.max(...line.lat), west: Math.min(...line.lon), east: Math.max(...line.lon),
  }
  const area = await sceneArea(con, meta, own)

  // The driver's other sessions on this course (their mean lines may differ).
  const candidates = (await rows(con, `
    SELECT s.session_guid, s.mean_line_guid, s.track_configuration_id,
      COALESCE(s.track_name, tc.track_name) AS track_name,
      COALESCE(s.track_configuration_name, tc.track_configuration_name) AS track_configuration_name
    FROM sessions s LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    WHERE s.session_guid <> ?
  `, [sessionGuid])).filter(s => sameCourse(sessionLayout(meta), sessionLayout(s as SessionMeta))).map(s => String(s.session_guid))

  const covered = await videoLaps(con, [sessionGuid, ...candidates])
  const valid = (await fetchValidLaps(con, [sessionGuid])).sort((a, b) => a.lapIndex - b.lapIndex)
  const best = valid.length ? Math.min(...valid.map(l => l.durationMs)) : null
  const laps: ReplayLapInfo[] = valid.map(l => ({
    sessionGuid, lap: l.lapIndex, durationMs: l.durationMs, label: lapLabel(meta.start, l.lapIndex),
    isBest: l.durationMs === best, hasVideo: covered.has(`${sessionGuid}:${l.lapIndex}`),
  }))
  const optimal = await optimalLapInfo(con, sessionGuid, meta.start)
  if (optimal) laps.push(optimal)

  let ghostCandidates: ReplayLapInfo[] = []
  if (candidates.length) {
    const predicate = await validLapPredicate(con)
    ghostCandidates = (await rows(con, `
      SELECT l.session_guid, l.lap_index, l.duration_ms, CAST(s.session_start AS VARCHAR) AS start,
        MIN(l.duration_ms) OVER (PARTITION BY l.session_guid) AS session_best
      FROM laps l JOIN sessions s ON s.session_guid = l.session_guid
      WHERE l.session_guid IN (${candidates.map(() => '?').join(',')}) AND ${predicate}
      -- A lap stored twice (a session loaded again) is offered once.
      QUALIFY ROW_NUMBER() OVER (PARTITION BY l.session_guid, l.lap_index ORDER BY l.duration_ms) = 1
      ORDER BY l.duration_ms, s.session_start, l.lap_index
      LIMIT ${MAX_GHOSTS}
    `, candidates)).map(r => ({
      sessionGuid: String(r.session_guid), lap: Number(r.lap_index), durationMs: Number(r.duration_ms),
      label: lapLabel(r.start == null ? null : String(r.start), Number(r.lap_index)),
      isBest: Number(r.duration_ms) === Number(r.session_best),
      hasVideo: covered.has(`${r.session_guid}:${r.lap_index}`),
    }))
  }

  return {
    sessionGuid,
    sessionStart: meta.start,
    vehicle: {
      guid: meta.vehicle_guid, make: meta.vehicle_make, model: meta.vehicle_model,
      year: num(meta.vehicle_year), key: vehicleKey(meta.vehicle_make, meta.vehicle_model),
    },
    track: {
      trackName: meta.track_name ?? (geometry.trackName || null),
      configName: meta.track_configuration_name ?? (geometry.configName || null),
      meanLineGuid: geometry.meanLineGuid,
      totalDistM,
      widthM: Number.isFinite(geometry.widthM) && geometry.widthM > 0 ? round(geometry.widthM, 2) : 10.64,
      line, corners, sectorsM, area,
    },
    units,
    laps,
    ghostCandidates,
  }
}

async function optimalLapInfo(con: DuckDBConnection, sessionGuid: string, start: string | null): Promise<ReplayLapInfo | null> {
  if (!await hasTable(con, 'optimal_lap_samples')) return null
  const [found] = await rows(con, 'SELECT COUNT(*) AS n, MAX(time_ms) - MIN(time_ms) AS span FROM optimal_lap_samples WHERE session_guid = ?', [sessionGuid])
  if (!found || !Number(found.n)) return null
  const durationMs = (await fetchOptimalLapTimes(con, [sessionGuid])).get(sessionGuid) ?? num(found.span)
  if (!durationMs) return null
  return { sessionGuid, lap: 'optimal', durationMs, label: optimalLabel(start), isBest: false, hasVideo: false }
}

const optimalLabel = (start: string | null) => `${shortSessionLabel(start)} · Optimal`

// ─── One lap ────────────────────────────────────────────────────────────────

// Distance maps between two mean lines are fixed, so each pair is built once.
const lineMaps = new Map<string, DistanceMap | null>()

export async function replayLap(con: DuckDBConnection, sceneGuid: string, ref: ReplayLapRef, units: UnitSystem = DEFAULT_UNIT_SYSTEM): Promise<ReplayLap> {
  const metas = await fetchSessionMeta(con, [...new Set([sceneGuid, ref.sessionGuid])])
  const scene = metas.find(m => m.session_guid === sceneGuid)
  const session = metas.find(m => m.session_guid === ref.sessionGuid)
  if (!scene || !session) throw new Error('That session is not in your workspace.')
  if (!sameCourse(sessionLayout(scene), sessionLayout(session))) throw new Error('That lap was driven on another track layout.')

  const optimal = ref.lap === 'optimal'
  if (optimal && !await hasTable(con, 'optimal_lap_samples')) throw new Error('This session has no optimal lap.')
  const found = optimal
    ? await rows(con, `
      SELECT distance_m, time_ms, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2, NULL AS alt, NULL AS heading
      FROM optimal_lap_samples WHERE session_guid = ? AND distance_m IS NOT NULL AND time_ms IS NOT NULL
      ORDER BY time_ms, distance_m`, [ref.sessionGuid])
    : await rows(con, `
      SELECT distance_m, time_ms, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2, gnss_altitude_m AS alt, gnss_heading_deg AS heading
      FROM samples WHERE session_guid = ? AND lap_index = ? AND distance_m IS NOT NULL AND time_ms IS NOT NULL
      ORDER BY time_ms, distance_m`, [ref.sessionGuid, ref.lap])

  const lap: ReplayLap = {
    sessionGuid: ref.sessionGuid, lap: ref.lap, durationMs: 0, label: '',
    dist: [], timeMs: [], lat: [], lon: [], altM: [], speedMps: [], accelX: [], accelY: [], headingDeg: [], car: null,
  }
  const t0 = num(found[0]?.time_ms) ?? 0
  for (const r of found) {
    const d = num(r.distance_m), t = num(r.time_ms), lat = num(r.lat), lon = num(r.lon), speed = num(r.gnss_speed_mps)
    // A sample without a position cannot be drawn.
    if (d == null || t == null || lat == null || lon == null) continue
    lap.dist.push(d); lap.timeMs.push(t - t0); lap.lat.push(lat); lap.lon.push(lon)
    lap.speedMps.push(speed == null ? 0 : round(speed, 3))
    const ax = num(r.accel_x_mps2), ay = num(r.accel_y_mps2), alt = num(r.alt), heading = num(r.heading)
    lap.accelX.push(ax == null ? null : round(ax, 3)); lap.accelY.push(ay == null ? null : round(ay, 3))
    lap.altM.push(alt == null ? null : round(alt, 2)); lap.headingDeg.push(heading == null ? null : round(heading, 2))
  }
  if (!lap.dist.length) throw new Error(optimal ? 'This session has no optimal lap.' : 'That lap has no telemetry.')

  if (optimal) {
    lap.durationMs = (await fetchOptimalLapTimes(con, [ref.sessionGuid])).get(ref.sessionGuid) ?? lap.timeMs.at(-1)!
    lap.label = optimalLabel(session.start)
  } else {
    const [row] = await rows(con, 'SELECT duration_ms FROM laps WHERE session_guid = ? AND lap_index = ?', [ref.sessionGuid, ref.lap])
    lap.durationMs = num(row?.duration_ms) ?? lap.timeMs.at(-1)!
    lap.label = lapLabel(session.start, ref.lap as number)
    if (await hasTable(con, 'session_videos')) {
      const car = await carDataForLaps(con, [{ sg: ref.sessionGuid, lapIdx: ref.lap as number }], units)
      const trace: CarTrace | undefined = car?.traces[0]
      if (trace) lap.car = { ...trace, label: lap.label, durationMs: lap.durationMs }
    }
  }

  // Measured along another mean line (another device's, or one Garmin
  // rebuilt): moved onto the scene's, so laps compare by distance.
  const map = sceneMap(scene, session, lap.dist.at(-1)!)
  if (map) {
    lap.dist = lap.dist.map(d => round(mapPosition(map, d), 2))
    if (lap.car) lap.car = { ...lap.car, dist: lap.car.dist.map(d => round(mapPosition(map, d), 2)) }
  }
  return lap
}

function sceneMap(scene: SessionMeta, session: SessionMeta, lapEndM: number): DistanceMap | null {
  const ours = scene.mean_line_guid, theirs = session.mean_line_guid
  if (!ours || !theirs || ours === theirs) return null
  const key = `${theirs}>${ours}`
  if (lineMaps.has(key)) return lineMaps.get(key)!
  const own = ownLine(ours, 0)
  const theirLine = readMeanLineTrace(theirs)
  const map = mapToOwnLine(theirs, theirLine, lapEndM, own)
  // Without both lines the map scales this lap's length: not reusable.
  if (theirLine && own.trace) lineMaps.set(key, map)
  return map
}
