// Generate a data-dense LLM coaching brief from selected Catalyst sessions.
// Port of garmin/prompt_pack.py.

import fs from 'node:fs'
import path from 'node:path'
import { DuckDBConnection } from '@duckdb/node-api'
import { COACHING_DIR, DB_PATH, TRACKS_DIR } from './paths.js'
import { loadTrackYaml, resolveTrackYamlPath, TrackCorner, TrackSegment, TrackYaml } from './trackYaml.js'
import { resolveProfileDir, resolveVehicleProfile } from './profiles.js'
import { openDb } from './loadToDb.js'
import {
  DEFAULT_UNIT_SYSTEM, speedFromMps, speedUnitLabel, tempFromC, tempUnitLabel, type UnitSystem,
} from '../shared/units.js'

// Each entry: [sqlColumn, [units, interpretation], opts?]. `opts.display` is the
// name shown in the brief (when it differs from the SQL column); `opts.scale`
// multiplies the observed min/max/avg before display. `opts.speed` marks the
// raw m/s speed channel, which is converted to the active display unit (mph or
// km/h) at render time so the AI reads the same unit the app shows.
export const CONFIRMED_FIELD_LABELS: Array<[string, [string, string], { display?: string; scale?: number; speed?: boolean }?]> = [
  ['gnss_speed_mps', ['speed', 'GPS speed. Use this for all speed-dependent analysis.'], { speed: true }],
  ['gnss_heading_deg', ['°', 'Compass heading 0–360°. Increases clockwise (N=0, E=90). Rate of change indicates yaw; near-constant = straight.']],
  ['gnss_heading_deriv_dps', ['°/s', 'Heading rate of change (yaw rate from GPS). Near zero on straights, peaks in corners. Positive = turning right.']],
  ['gnss_accuracy_m', ['m', 'GPS fix accuracy estimate. Smaller = better. Typical: 0.4–1.5 m. Not a driver input channel.']],
  ['gnss_altitude_m', ['m MSL', 'GPS altitude above mean sea level. VIR Full Course ranges ~75–190 m. Use to identify elevation changes and their effect on grip.']],
  ['accel_x_mps2', ['m/s²', 'Longitudinal acceleration in the vehicle frame. Braking = NEGATIVE (peak ~−1.4 g = −13.7 m/s²). Acceleration = POSITIVE (peak ~+0.9 g = +8.8 m/s²). Divide by 9.81 for g-force.']],
  ['accel_y_mps2', ['m/s²', 'Lateral (cornering) acceleration. Left turn = NEGATIVE, right turn = POSITIVE. Peak ±1.5 g (±14.7 m/s²) on grippy tires. Divide by 9.81 for lateral g. This is the primary cornering-grip channel.']],
  ['accel_z_mps2', ['m/s²', 'Vertical acceleration including gravity. Flat ground at rest ≈ −9.81 m/s² (gravity pulls down). More negative = more downforce / bump. Typical range −16 to −4 m/s² (−1.6 to −0.4 g).']],
  ['gyro_roll_dps', ['°/s', 'Roll angular rate (body rotation about longitudinal axis). Near zero on flat track; non-zero in elevation changes or over bumps. NOT a lateral G channel.']],
  ['gyro_pitch_dps', ['°/s', 'Pitch angular rate (nose-up/nose-down rotation). Positive = nose rising. Peaks under acceleration / at crest of hills. NOT a longitudinal G channel.']],
  ['gyro_yaw_dps', ['°/s', 'Yaw angular rate from IMU (rotation about vertical axis). Complements gnss_heading_deriv_dps. Used internally for stability estimation.']],
  ['lateral_position', ['0–1', 'Normalised position across the track width relative to the GPS meanline. Interpretation: 0 = one edge, 1 = other edge, 0.5 = centerline. Use to track apexing behaviour and line width.']],
]

function msToLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const s = ms > 1000 ? ms / 1000 : ms
  const m = Math.floor(s / 60)
  const remain = s - m * 60
  return `${m}:${remain.toFixed(3).padStart(6, '0')}`
}

// Compass abbreviation for a wind-from bearing in degrees (meteorological).
const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
function compass(deg: number | null | undefined): string {
  if (deg == null || Number.isNaN(deg)) return ''
  return COMPASS_16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]
}

// Wind as "25.2 mph from NE (30°)"; empty string when no data. Presented in the
// active speed unit to match every other speed in the brief.
function fmtWind(speedMps: number | null | undefined, dirDeg: number | null | undefined, system: UnitSystem): string {
  if (speedMps == null || Number.isNaN(speedMps)) return ''
  const dir = compass(dirDeg)
  const from = dir ? ` from ${dir} (${Math.round(dirDeg!)}°)` : ''
  return `${speedFromMps(speedMps, system).toFixed(1)} ${speedUnitLabel(system)}${from}`
}

function inlineMd(p: string, headingDemote = 1): string {
  if (!fs.existsSync(p)) return `_(missing: ${path.basename(p)})_`
  let text = fs.readFileSync(p, 'utf-8')
  if (headingDemote > 0) {
    const pad = '#'.repeat(headingDemote)
    text = text.split('\n').map(l => (l.startsWith('#') ? pad + l : l)).join('\n')
  }
  return text
}

async function rowsToDicts(con: DuckDBConnection, sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
  const reader = await con.runAndReadAll(sql, params as any)
  return reader.getRowObjectsJson() as Record<string, any>[]
}

interface SessionRow {
  session_guid: string
  session_start: string | null
  best_lap_ms: number | null
  best_lap_normal_ms: number | null
  track_cartography_id: number | null
  track_configuration_id: number | null
  mean_line_guid: string | null
  weather_description: string | null
  temperature_c: number | null
  humidity_pct: number | null
  wind_speed_mps: number | null
  wind_direction_deg: number | null
  track_name: string | null
  track_configuration_name: string | null
  reverse: boolean | null
  vehicle_guid: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_year: number | null
  vehicle_type: string | null
}

async function fetchSessions(con: DuckDBConnection, guids: string[] | null, lastN: number | null): Promise<SessionRow[]> {
  if (guids && guids.length) {
    return (await rowsToDicts(con, `
      SELECT s.*, tc.track_name, tc.track_configuration_name, tc.reverse
      FROM sessions s
      LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
      WHERE s.session_guid IN (${guids.map(() => '?').join(',')})
      ORDER BY s.session_start DESC
    `, guids)) as SessionRow[]
  }
  const limit = lastN ?? 50
  return (await rowsToDicts(con, `
    SELECT s.*, tc.track_name, tc.track_configuration_name, tc.reverse
    FROM sessions s
    LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    ORDER BY s.session_start DESC
    LIMIT ?
  `, [limit])) as SessionRow[]
}

async function fetchLapTable(con: DuckDBConnection, sgList: string[]): Promise<any[]> {
  if (!sgList.length) return []
  const placeholders = sgList.map(() => '?').join(',')
  return rowsToDicts(con, `
    WITH stats AS (
      SELECT session_guid, lap_index,
        MAX(gnss_speed_mps) AS max_speed,
        MIN(gnss_speed_mps) AS min_speed,
        AVG(gnss_speed_mps) AS avg_speed,
        MAX(ABS(accel_y_mps2)) AS max_lat_g,
        MAX(accel_x_mps2) AS max_long_accel,
        MIN(accel_x_mps2) AS min_long_accel
      FROM samples WHERE session_guid IN (${placeholders})
      GROUP BY session_guid, lap_index
    )
    SELECT s.session_guid, CAST(s.session_start AS VARCHAR) AS session_start,
      tc.track_configuration_name AS config,
      l.lap_index, l.lap_type, l.duration_ms, l.sample_count,
      st.max_speed, st.min_speed, st.avg_speed, st.max_lat_g,
      st.max_long_accel, st.min_long_accel
    FROM laps l
    JOIN sessions s ON s.session_guid = l.session_guid
    LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
    LEFT JOIN stats st ON st.session_guid = l.session_guid AND st.lap_index = l.lap_index
    WHERE l.session_guid IN (${placeholders}) AND l.lap_type = 'DRIVEN'
    ORDER BY s.session_start DESC, l.lap_index
  `, [...sgList, ...sgList])
}

async function fetchSegmentSplits(
  con: DuckDBConnection,
  sg: string,
  segments: TrackSegment[],
): Promise<Array<Array<number | null>>> {
  if (!segments.length) return []
  const lapDurRows = await rowsToDicts(con,
    'SELECT lap_index, duration_ms FROM laps WHERE session_guid = ?', [sg])
  const lapDurations = new Map<number, number>()
  for (const r of lapDurRows) lapDurations.set(r.lap_index, r.duration_ms)

  const rows = await rowsToDicts(con, `
    SELECT lap_index, distance_m, gnss_speed_mps
    FROM samples
    WHERE session_guid = ? AND gnss_speed_mps IS NOT NULL AND gnss_speed_mps > 0
    ORDER BY lap_index, distance_m
  `, [sg])

  const byLap = new Map<number, Array<[number, number]>>()
  for (const r of rows) {
    if (!byLap.has(r.lap_index)) byLap.set(r.lap_index, [])
    byLap.get(r.lap_index)!.push([r.distance_m, r.gnss_speed_mps])
  }

  const out: Array<Array<number | null>> = []
  const lapIndices = [...byLap.keys()].sort((a, b) => a - b)
  for (const lapIdx of lapIndices) {
    const samples = byLap.get(lapIdx)!
    const lapMs = lapDurations.get(lapIdx) ?? 0
    if (!lapMs || !samples.length) {
      out.push(new Array(segments.length).fill(null))
      continue
    }
    const weights = samples.map(([, sp]) => 1.0 / sp)
    const totalW = weights.reduce((a, b) => a + b, 0)
    if (totalW <= 0) {
      out.push(new Array(segments.length).fill(null))
      continue
    }
    const scale = lapMs / 1000.0 / totalW
    const segTimes: Array<number | null> = new Array(segments.length).fill(0)
    for (let i = 0; i < samples.length; i++) {
      const [d] = samples[i]
      const w = weights[i]
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]
        if (d >= seg.start_dist_m && d < seg.end_dist_m) {
          ;(segTimes[si] as number) += w * scale
          break
        }
      }
    }
    out.push(segTimes)
  }
  return out
}

interface CornerStat {
  name: string
  n_samples: number
  entry_speed: number
  apex_speed: number
  vmin_distance_m: number
  exit_speed: number
  speed_drop: number
  max_lat_g: number
  min_accel_g: number
  max_accel_g: number
}

interface CornerBrakingStat {
  onset_dist_m: number
  release_dist_m: number
  peak_brake_g: number
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
}

// Braking is inferred from longitudinal acceleration because Catalyst does not
// expose brake-pedal pressure. This mirrors the chart computation: a lightly
// smoothed episode below -0.08 g containing a peak of at least -0.18 g.
async function fetchCornerBrakingStats(
  con: DuckDBConnection,
  sg: string,
  lapIdx: number,
  corners: TrackCorner[],
): Promise<Map<string, CornerBrakingStat>> {
  const out = new Map<string, CornerBrakingStat>()
  const raw = await rowsToDicts(con, `
    SELECT distance_m, accel_x_mps2
    FROM samples
    WHERE session_guid = ? AND lap_index = ?
      AND distance_m IS NOT NULL AND accel_x_mps2 IS NOT NULL
    ORDER BY distance_m, time_ms
  `, [sg, lapIdx])
  if (raw.length < 5) return out
  const dist = raw.map(row => Number(row.distance_m))
  const gs = raw.map(row => Number(row.accel_x_mps2) / 9.80665)
  const smooth = gs.map((_, i) => {
    const lo = Math.max(0, i - 2), hi = Math.min(gs.length - 1, i + 2)
    let sum = 0
    for (let j = lo; j <= hi; j++) sum += gs[j]
    return sum / (hi - lo + 1)
  })

  for (const corner of corners) {
    const apex = corner.apex_idx
    if (!Number.isFinite(apex)) continue
    const loDist = Math.max(0, corner.dist_idx_start - 450)
    const hiDist = corner.dist_idx_end + 150
    let peakIdx = -1
    for (let i = 0; i < dist.length && dist[i] <= apex + 30; i++) {
      if (dist[i] < loDist || smooth[i] > -0.18) continue
      if (peakIdx < 0 || dist[i] > dist[peakIdx] + 35 || smooth[i] < smooth[peakIdx]) peakIdx = i
    }
    if (peakIdx < 0) continue
    let onsetIdx = peakIdx
    while (onsetIdx > 0 && dist[onsetIdx - 1] >= loDist && smooth[onsetIdx - 1] <= -0.08) onsetIdx--
    let releaseIdx = peakIdx
    let clearCount = 0
    for (let i = peakIdx + 1; i < dist.length && dist[i] <= hiDist; i++) {
      if (smooth[i] > -0.08) clearCount++
      else clearCount = 0
      if (clearCount >= 3) { releaseIdx = i - 2; break }
      releaseIdx = i
    }
    if (releaseIdx <= onsetIdx) continue
    out.set(corner.turn, {
      onset_dist_m: dist[onsetIdx],
      release_dist_m: dist[releaseIdx],
      peak_brake_g: Math.abs(smooth[peakIdx]),
    })
  }
  return out
}

async function fetchCornerStats(
  con: DuckDBConnection,
  sg: string,
  lapIdx: number,
  corners: TrackCorner[],
): Promise<Map<string, CornerStat>> {
  const out = new Map<string, CornerStat>()
  for (const c of corners) {
    const lo = c.dist_idx_start, hi = c.dist_idx_end
    if (lo == null || hi == null) continue
    const rows = await rowsToDicts(con, `
      SELECT distance_m, gnss_speed_mps, accel_x_mps2, accel_y_mps2
      FROM samples
      WHERE session_guid = ? AND lap_index = ?
        AND distance_m BETWEEN ? AND ?
      ORDER BY distance_m
    `, [sg, lapIdx, lo, hi])
    if (!rows.length) continue
    const speedRows = rows.filter(r => r.gnss_speed_mps != null)
    const speeds = speedRows.map(r => r.gnss_speed_mps as number)
    const longs = rows.filter(r => r.accel_x_mps2 != null).map(r => r.accel_x_mps2 as number)
    const lats = rows.filter(r => r.accel_y_mps2 != null).map(r => Math.abs(r.accel_y_mps2 as number))
    if (!speeds.length) continue
    const nEdge = Math.min(5, Math.max(1, Math.floor(speeds.length / 8)))
    const entry = speeds.slice(0, nEdge).reduce((a, b) => a + b, 0) / nEdge
    const exit = speeds.slice(-nEdge).reduce((a, b) => a + b, 0) / nEdge
    const vminRow = speedRows.reduce((minimum, row) =>
      (row.gnss_speed_mps as number) < (minimum.gnss_speed_mps as number) ? row : minimum)
    const apex = vminRow.gnss_speed_mps as number
    out.set(c.turn, {
      name: c.name ?? '',
      n_samples: rows.length,
      entry_speed: entry,
      apex_speed: apex,
      vmin_distance_m: vminRow.distance_m as number,
      exit_speed: exit,
      speed_drop: entry - apex,
      max_lat_g: lats.length ? Math.max(...lats) : 0,
      min_accel_g: longs.length ? Math.min(...longs) : 0,
      max_accel_g: longs.length ? Math.max(...longs) : 0,
    })
  }
  return out
}

async function fetchBestLapTrace(
  con: DuckDBConnection,
  sg: string,
  lapIdx: number,
  strideM = 50,
): Promise<any[]> {
  return rowsToDicts(con, `
    SELECT distance_m, gnss_speed_mps, accel_x_mps2, accel_y_mps2,
           gnss_altitude_m, lateral_position, gnss_heading_deg
    FROM samples
    WHERE session_guid = ? AND lap_index = ? AND distance_m % ? = 0
    ORDER BY distance_m
  `, [sg, lapIdx, strideM])
}

// ---------------------------------------------------------------------------
// Brief assembly
// ---------------------------------------------------------------------------

export interface BuildBriefOpts {
  sessions: SessionRow[]
  trackYaml: TrackYaml
  scope: 'overview' | 'corner' | 'compare'
  con: DuckDBConnection
  profileDir: string
  profileName: string
  includeGuides?: boolean
  dataDirRelpath?: string | null
  system?: UnitSystem
  lapLimit?: 3 | 5 | 10 | null
  includeTask?: boolean
}

export async function buildBrief(opts: BuildBriefOpts): Promise<string> {
  const { sessions: selectedSessions, trackYaml, scope, con, profileDir, profileName, includeGuides, dataDirRelpath } = opts
  // Active unit system — every speed/temperature in the brief uses these so the
  // AI reads and answers in the same units the app displays.
  const system = opts.system ?? DEFAULT_UNIT_SYSTEM
  const spd = (mps: number | null | undefined): number => speedFromMps(mps ?? 0, system)
  const spdU = speedUnitLabel(system)
  const tmp = (c: number): number => tempFromC(c, system)
  const tmpU = tempUnitLabel(system)
  const today = new Date().toISOString().slice(0, 10)
  const configName = trackYaml.track_configuration_name ?? 'Unknown'
  const segments = trackYaml.segments ?? []
  const corners = trackYaml.corners ?? []
  const selectedGuids = selectedSessions.map(s => s.session_guid)
  const allLapRows = await fetchLapTable(con, selectedGuids)
  const lapRows = opts.lapLimit
    ? [...allLapRows]
      .filter(lap => lap.duration_ms > 0)
      .sort((a, b) => a.duration_ms - b.duration_ms)
      .slice(0, opts.lapLimit)
    : allLapRows
  const includedSessionGuids = new Set(lapRows.map(lap => lap.session_guid))
  const sessions = opts.lapLimit
    ? selectedSessions.filter(session => includedSessionGuids.has(session.session_guid))
    : selectedSessions
  const sgList = sessions.map(s => s.session_guid)
  const bySession = new Map<string, any[]>()
  for (const lap of lapRows) {
    if (!bySession.has(lap.session_guid)) bySession.set(lap.session_guid, [])
    bySession.get(lap.session_guid)!.push(lap)
  }
  const sessionBestByGuid = new Map<string, number>()
  for (const lap of allLapRows) {
    if (!(lap.duration_ms > 0)) continue
    const current = sessionBestByGuid.get(lap.session_guid) ?? Infinity
    sessionBestByGuid.set(lap.session_guid, Math.min(current, lap.duration_ms))
  }
  const representativeLapKeys = new Set(
    lapRows
      .filter(lap => {
        const best = sessionBestByGuid.get(lap.session_guid) ?? 0
        return best > 0 && lap.duration_ms > 0 && lap.duration_ms <= best * 1.05
      })
      .map(lap => `${lap.session_guid}:${lap.lap_index}`),
  )
  const parts: string[] = []

  parts.push(`# Coaching Brief — ${configName} (${scope})`)
  parts.push(`_Generated: ${today}_  ·  _Sessions: ${sessions.length}_  ·  _Laps: ${opts.lapLimit ? `Top ${opts.lapLimit} fastest across selected sessions` : 'All'}_`)
  if (sessions.length) {
    const dates = sessions.map(s => String(s.session_start ?? '')).filter(Boolean).sort()
    if (dates.length) parts.push(`_Date range: ${dates[0]} — ${dates[dates.length - 1]}_`)
  }
  if (dataDirRelpath) {
    parts.push('')
    parts.push(`**Raw data CSVs in \`${dataDirRelpath}/\`** ` +
      '(laps.csv, segment_splits.csv, corner_stats.csv, best_lap_trace.csv). ' +
      'Use them if you have code execution.')
  }
  parts.push('')
  parts.push('## Analysis scope & guardrails')
  parts.push('')
  parts.push(`- This report contains ${lapRows.length} driven laps from ${sessions.length} selected sessions on **${configName}**. Keep comparisons within this exact track configuration.`)
  parts.push('- All included laps remain visible. Treat laps >5% slower than that session\'s best as outliers/cool-down/mistake candidates: use them to diagnose repeatability, but do not let them set pace targets.')
  parts.push('- Pace targets must be anchored to this driver\'s repeatable observed bests. A track-guide statement is context, not measured proof that the car/driver can achieve it in these conditions.')
  parts.push('- Catalyst does not provide throttle position, brake pressure, steering angle, gear/RPM, tire temperature/pressure, or video in this dataset. Describe those inputs only as hypotheses (for example, “the speed/acceleration trace suggests a lift”), never as measured facts.')
  parts.push('- Longitudinal acceleration also contains grade, aero drag, and bumps. The braking table is a deceleration-derived proxy, not a brake-pedal channel; do not diagnose lockup or brake bias from it alone.')
  parts.push('')
  parts.push('---')
  parts.push('')

  parts.push(`## Car & driver — ${profileName}`)
  parts.push(inlineMd(path.join(profileDir, 'Car.md'), 2))
  parts.push('')

  parts.push(`## Track — ${configName}`)
  parts.push(`_${trackYaml.total_dist_m ?? '?'} m total_`)
  parts.push('')
  parts.push('### Garmin reference segments (primary unit for pacing analysis)')
  parts.push('')
  parts.push('| # | Start m | End m | Length m | Flag |')
  parts.push('|---|--------:|------:|---------:|:----:|')
  for (const s of segments) {
    parts.push(`| S${s.id ?? '?'} | ${s.start_dist_m ?? '?'} | ${s.end_dist_m ?? '?'} | ${s.length_m ?? '?'} | ${s.flag ?? '?'} |`)
  }
  parts.push('')

  if (corners.length) {
    parts.push('### Named corners (canonical, in driving order)')
    parts.push("Each corner's `range` corresponds to `distance_m` in the samples table (metres along the track from lap start).")
    parts.push('')
    parts.push('| Turn | Name | Dir | Apex | Range | R(m) | Notes |')
    parts.push('|------|------|-----|-----:|------:|-----:|-------|')
    for (const c of corners) {
      const rng = `${c.dist_idx_start ?? '?'}-${c.dist_idx_end ?? '?'}`
      parts.push(`| ${c.turn ?? '?'} | ${c.name ?? '?'} | ${c.direction ?? ''} | ${c.apex_idx ?? '?'} | ${rng} | ${c.apex_radius_m ?? '?'} | ${c.character ?? ''} |`)
    }
    parts.push('')
  }

  parts.push('## Sessions')
  parts.push('')
  parts.push('Weather is captured per session at session start. Conditions (temperature, humidity, wind) materially affect grip, braking, and achievable pace — weigh them when comparing sessions and laps.')
  parts.push('')
  parts.push(`| Date | Vehicle | Config | Weather | Temp ${tmpU} | Humidity % | Wind | Best Lap | Included laps |`)
  parts.push('|------|---------|--------|---------|--------:|-----------:|------|---------:|--------------:|')
  for (const s of sessions) {
    const nlaps = bySession.get(s.session_guid)?.length ?? 0
    const temp = s.temperature_c != null ? tmp(s.temperature_c).toFixed(1) : ''
    const humidity = s.humidity_pct != null ? Math.round(s.humidity_pct) : ''
    const vehicle = [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ') || 'Unknown'
    parts.push(`| ${s.session_start ?? '?'} | ${vehicle} | ${s.track_configuration_name ?? '?'} | ${s.weather_description ?? ''} | ${temp} | ${humidity} | ${fmtWind(s.wind_speed_mps, s.wind_direction_deg, system)} | ${msToLap(s.best_lap_ms)} | ${nlaps} |`)
  }
  parts.push('')

  parts.push(`## ${opts.lapLimit ? `Top ${opts.lapLimit} fastest laps` : 'All laps'}`)
  parts.push("One row per lap across every selected session. Δ best = duration minus the session's best lap.")
  parts.push('')

  parts.push(`| Session | Lap | Quality | Duration | Δ session best | Max speed (${spdU}) | Max |lat_g| (m/s²) | Max long_accel (m/s²) | Min long_accel (m/s²) |`)
  parts.push('|---------|----:|---------|----------:|---------------:|----------------:|------------------:|----------------------:|----------------------:|')
  for (const [sg, laps] of bySession) {
    const bestMs = sessionBestByGuid.get(sg) ?? 0
    for (const L of laps) {
      const delta = bestMs && L.duration_ms ? (L.duration_ms - bestMs) / 1000 : 0
      const pct = bestMs > 0 && L.duration_ms > 0 ? (L.duration_ms / bestMs - 1) * 100 : 0
      const quality = pct > 15 ? 'major outlier' : pct > 5 ? 'outlier' : 'representative'
      parts.push(`| ${sg.slice(0, 8)}… | ${L.lap_index + 1} | ${quality} | ${msToLap(L.duration_ms)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s | ${spd(L.max_speed).toFixed(1)} | ${(L.max_lat_g ?? 0).toFixed(3)} | ${(L.max_long_accel ?? 0) >= 0 ? '+' : ''}${(L.max_long_accel ?? 0).toFixed(3)} | ${(L.min_long_accel ?? 0) >= 0 ? '+' : ''}${(L.min_long_accel ?? 0).toFixed(3)} |`)
    }
  }
  parts.push('')

  parts.push('### Session pace & consistency summary')
  parts.push('Representative laps are within 5% of that session PB. Compare session medians only when weather, vehicle, and lap population are reasonably comparable.')
  parts.push('')
  parts.push('| Session | Representative / included | Session PB | Representative median | σ s | Outliers |')
  parts.push('|---------|--------------------------:|-----------:|----------------------:|----:|---------:|')
  for (const [sg, laps] of bySession) {
    const rep = laps.filter(lap => representativeLapKeys.has(`${sg}:${lap.lap_index}`))
    const durations = rep.map(lap => Number(lap.duration_ms) / 1000)
    const sessionBest = sessionBestByGuid.get(sg) ?? 0
    parts.push(`| ${sg.slice(0, 8)}… | ${rep.length} / ${laps.length} | ${msToLap(sessionBest)} | ${durations.length ? msToLap(median(durations) * 1000) : '—'} | ${stddev(durations).toFixed(3)} | ${laps.length - rep.length} |`)
  }
  parts.push('')

  // Per-segment splits
  parts.push(`## Per-segment splits (sec) — ${opts.lapLimit ? `top ${opts.lapLimit} laps` : 'all laps'}`)
  parts.push('Computed by integrating 1/gnss_speed_mps over distance, scaled so the per-lap sum equals lap duration. Lap-relative; comparable across laps and sessions.')
  parts.push('')
  const segIds = segments.map(s => s.id)
  parts.push(`| Session | Lap | ${segIds.map(i => `S${i}`).join(' | ')} |`)
  parts.push(`|${new Array(segIds.length + 2).fill('------:').join('|')}|`)

  const pbPerSegment: number[] = new Array(segments.length).fill(Infinity)
  const valuesPerSegment: number[][] = Array.from({ length: segments.length }, () => [])
  for (const sg of sgList) {
    const splits = await fetchSegmentSplits(con, sg, segments)
    for (let lapIdx = 0; lapIdx < splits.length; lapIdx++) {
      if (!(bySession.get(sg) ?? []).some(lap => lap.lap_index === lapIdx)) continue
      const row = splits[lapIdx]
      if (row.every(v => v == null)) continue
      const cells: string[] = []
      for (let i = 0; i < row.length; i++) {
        const v = row[i]
        if (v == null) cells.push('  —  ')
        else {
          cells.push(v.toFixed(2).padStart(6, ' '))
          if (v < pbPerSegment[i]) pbPerSegment[i] = v
          if (representativeLapKeys.has(`${sg}:${lapIdx}`)) valuesPerSegment[i].push(v)
        }
      }
      parts.push(`| ${sg.slice(0, 8)}… | ${lapIdx + 1} | ${cells.join(' | ')} |`)
    }
  }
  parts.push('')

  parts.push("### Personal-best per segment (this brief's data)")
  parts.push('')
  parts.push(`| Metric | ${segIds.map(i => `S${i}`).join(' | ')} |`)
  parts.push(`|---|${new Array(segIds.length).fill('----:').join('|')}|`)
  parts.push('| PB sec | ' + pbPerSegment.map(v => v < Infinity ? v.toFixed(2).padStart(6, ' ') : '  —  ').join(' | ') + ' |')
  parts.push('')

  const validLapDurations = lapRows.filter(lap => lap.duration_ms > 0).map(lap => Number(lap.duration_ms))
  const actualBestSec = validLapDurations.length
    ? Math.min(...validLapDurations) / 1000
    : 0
  const theoreticalBestSec = pbPerSegment.every(value => value < Infinity)
    ? pbPerSegment.reduce((sum, value) => sum + value, 0)
    : 0
  const consistencyLossSec = actualBestSec && theoreticalBestSec
    ? Math.max(0, actualBestSec - theoreticalBestSec)
    : 0
  parts.push('### Segment opportunity & repeatability summary — representative laps only')
  parts.push(`Actual best ${msToLap(actualBestSec * 1000)}; theoretical best ${msToLap(theoreticalBestSec * 1000)}; recoverable consistency gap **${consistencyLossSec.toFixed(3)} s** (actual best minus sum of segment PBs).`)
  parts.push('Median gap is the safer coaching opportunity estimate; standard deviation (σ) measures repeatability. Rank priorities using both, not a single heroic PB split.')
  parts.push('')
  parts.push('| Segment | N | PB s | Median s | Median gap s | Mean gap s | σ s |')
  parts.push('|---------|--:|-----:|---------:|-------------:|-----------:|----:|')
  for (let i = 0; i < segments.length; i++) {
    const values = valuesPerSegment[i]
    if (!values.length || !(pbPerSegment[i] < Infinity)) continue
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const med = median(values)
    parts.push(`| S${segments[i].id} | ${values.length} | ${pbPerSegment[i].toFixed(3)} | ${med.toFixed(3)} | ${(med - pbPerSegment[i]).toFixed(3)} | ${(mean - pbPerSegment[i]).toFixed(3)} | ${stddev(values).toFixed(3)} |`)
  }
  parts.push('')

  // Per-corner stats
  if (corners.length) {
    parts.push(`## Per-corner stats — ${opts.lapLimit ? `top ${opts.lapLimit} laps` : 'every lap'}`)
    parts.push(`**entry**=avg speed first 5 samples of zone, **V-min**=minimum speed in the corner zone, **V-min distance**=the exact distance_m sample where that minimum occurred, **exit**=avg speed last 5 samples, **drop**=entry−V-min. All speeds in ${spdU}. V-min and its location are critical comparison metrics: use them to compare laps/runs and distinguish line, braking, rotation, and throttle differences. max_lat_g = max(|accel_y_mps2|) in m/s² (÷9.81 for g). min_accel_g = min(accel_x_mps2) m/s² — most negative = hardest braking.`)
    parts.push('')

    const allCornerRows: Array<{ sg: string; lap: number; turn: string } & CornerStat> = []
    const allBrakingRows: Array<{ sg: string; lap: number; turn: string } & CornerBrakingStat> = []
    for (const sg of sgList) {
      const laps = bySession.get(sg) ?? []
      for (const L of laps) {
        const stats = await fetchCornerStats(con, sg, L.lap_index, corners)
        for (const [turn, st] of stats) {
          allCornerRows.push({ sg, lap: L.lap_index + 1, turn, ...st })
        }
        const braking = await fetchCornerBrakingStats(con, sg, L.lap_index, corners)
        for (const [turn, st] of braking) {
          allBrakingRows.push({ sg, lap: L.lap_index + 1, turn, ...st })
        }
      }
    }

    const pbCorner = new Map<string, { best_apex_speed: number; best_exit_speed: number; best_min_accel: number; best_max_lat_g: number }>()
    for (const row of allCornerRows) {
      const cur = pbCorner.get(row.turn) ?? { best_apex_speed: 0, best_exit_speed: 0, best_min_accel: 0, best_max_lat_g: 0 }
      cur.best_apex_speed = Math.max(cur.best_apex_speed, row.apex_speed)
      cur.best_exit_speed = Math.max(cur.best_exit_speed, row.exit_speed)
      cur.best_min_accel = Math.min(cur.best_min_accel, row.min_accel_g)
      cur.best_max_lat_g = Math.max(cur.best_max_lat_g, row.max_lat_g)
      pbCorner.set(row.turn, cur)
    }

    // Fetch lateral positions at entry/apex/exit for every (lap, corner) pair.
    const lateralRows = new Map<string, { entry: number | null; apex: number | null; exit: number | null }>()
    for (const sg of sgList) {
      const laps = bySession.get(sg) ?? []
      for (const L of laps) {
        for (const c of corners) {
          const lo = c.dist_idx_start, apx = c.apex_idx, hi = c.dist_idx_end
          if (lo == null || hi == null || apx == null) continue
          const WINDOW = 10
          const r = await rowsToDicts(con, `
            SELECT distance_m, lateral_position FROM samples
            WHERE session_guid = ? AND lap_index = ?
              AND distance_m BETWEEN ? AND ?
              AND lateral_position IS NOT NULL
            ORDER BY distance_m
          `, [sg, L.lap_index, lo, hi])
          if (!r.length) continue
          const entry = r.filter(p => (p.distance_m as number) <= lo + WINDOW)
          const exit = r.filter(p => (p.distance_m as number) >= hi - WINDOW)
          const apexPts = r.filter(p => Math.abs((p.distance_m as number) - apx) <= WINDOW)
          const avg = (pts: typeof r) => pts.length ? pts.reduce((s, p) => s + (p.lateral_position as number), 0) / pts.length : null
          lateralRows.set(`${sg}:${L.lap_index}:${c.turn}`, {
            entry: avg(entry), apex: avg(apexPts), exit: avg(exit),
          })
        }
      }
    }

    parts.push('### One row per (lap, corner)')
    parts.push(`Speed columns in ${spdU}. lat_g = |accel_y_mps2| m/s². min_accel_g = min(accel_x_mps2) m/s² (negative = braking). ÷9.81 for g-force.`)
    parts.push('lateral_pos: 0=driver-left edge, 1=driver-right edge, 0.5=centerline. entry/apex/exit lateral_pos shows line choice through the corner.')
    parts.push(`| Sess | Lap | Turn | Name | Entry (${spdU}) | V-min (${spdU}) | V-min dist (m) | Exit (${spdU}) | Drop (${spdU}) | LatG (m/s²) | MinAccX (m/s²) | LPos Entry | LPos Apex | LPos Exit |`)
    parts.push('|------|----:|------|------|------------:|------------:|---------------:|-----------:|-----------:|------------:|---------------:|-----------:|----------:|----------:|')
    for (const r of allCornerRows) {
      const lat = lateralRows.get(`${r.sg}:${r.lap - 1}:${r.turn}`)
      const fmtL = (v: number | null | undefined) => v == null ? '—' : v.toFixed(2)
      parts.push(`| ${r.sg.slice(0, 8)}… | ${r.lap} | ${r.turn} | ${r.name} | ${spd(r.entry_speed).toFixed(1)} | ${spd(r.apex_speed).toFixed(1)} | ${r.vmin_distance_m.toFixed(1)} | ${spd(r.exit_speed).toFixed(1)} | ${spd(r.speed_drop).toFixed(1)} | ${r.max_lat_g.toFixed(3)} | ${r.min_accel_g >= 0 ? '+' : ''}${r.min_accel_g.toFixed(3)} | ${fmtL(lat?.entry)} | ${fmtL(lat?.apex)} | ${fmtL(lat?.exit)} |`)
    }
    parts.push('')

    parts.push('### Personal-best per corner')
    parts.push(`| Turn | Name | Best V-min (${spdU}) | Best exit (${spdU}) | Hardest braking min(accel_x) m/s² | Max LatG |accel_y| m/s² |`)
    parts.push('|------|------|----------------:|----------------:|----------------------------------:|---------------------:|')
    for (const c of corners) {
      const pb = pbCorner.get(c.turn)
      if (!pb) continue
      parts.push(`| ${c.turn} | ${c.name ?? '?'} | ${spd(pb.best_apex_speed).toFixed(1)} | ${spd(pb.best_exit_speed).toFixed(1)} | ${pb.best_min_accel >= 0 ? '+' : ''}${pb.best_min_accel.toFixed(2)} | ${pb.best_max_lat_g.toFixed(2)} |`)
    }
    parts.push('')

    parts.push('### Corner repeatability summary — representative laps only')
    parts.push(`Use V-min and exit medians as repeatable pace, not just the maximum. V-min distance σ and V-min speed σ expose inconsistent rotation/timing. Speeds are ${spdU}.`)
    parts.push('')
    parts.push('| Turn | N | Median entry | Best V-min | Median V-min | V-min σ | Median V-min dist m | Dist σ m | Best exit | Median exit |')
    parts.push('|------|--:|-------------:|-----------:|-------------:|--------:|--------------------:|---------:|----------:|------------:|')
    for (const c of corners) {
      const rows = allCornerRows.filter(row =>
        row.turn === c.turn && representativeLapKeys.has(`${row.sg}:${row.lap - 1}`))
      if (!rows.length) continue
      const entries = rows.map(row => spd(row.entry_speed))
      const vmins = rows.map(row => spd(row.apex_speed))
      const dists = rows.map(row => row.vmin_distance_m)
      const exits = rows.map(row => spd(row.exit_speed))
      parts.push(`| ${c.turn} | ${rows.length} | ${median(entries).toFixed(1)} | ${Math.max(...vmins).toFixed(1)} | ${median(vmins).toFixed(1)} | ${stddev(vmins).toFixed(2)} | ${median(dists).toFixed(1)} | ${stddev(dists).toFixed(1)} | ${Math.max(...exits).toFixed(1)} | ${median(exits).toFixed(1)} |`)
    }
    parts.push('')

    if (allBrakingRows.length) {
      parts.push('### Deceleration-derived braking episodes — one row per (lap, corner)')
      parts.push('Episodes are inferred from smoothed accel_x (<−0.08 g with a ≥0.18 g peak). Onset relative to apex = apex_dist − onset_dist (larger means earlier); release relative to apex = release_dist − apex_dist (negative means release before geometric apex). This is a technique-comparison proxy, not measured pedal pressure.')
      parts.push('')
      parts.push('| Sess | Lap | Turn | Onset m | Release m | Onset before apex m | Release vs apex m | Peak decel g |')
      parts.push('|------|----:|------|--------:|----------:|--------------------:|------------------:|-------------:|')
      for (const row of allBrakingRows) {
        const corner = corners.find(c => c.turn === row.turn)
        if (!corner) continue
        parts.push(`| ${row.sg.slice(0, 8)}… | ${row.lap} | ${row.turn} | ${row.onset_dist_m.toFixed(1)} | ${row.release_dist_m.toFixed(1)} | ${(corner.apex_idx - row.onset_dist_m).toFixed(1)} | ${(row.release_dist_m - corner.apex_idx).toFixed(1)} | ${row.peak_brake_g.toFixed(2)} |`)
      }
      parts.push('')
      parts.push('### Braking repeatability summary — representative laps only')
      parts.push('| Turn | N | Median onset before apex m | Onset σ m | Median release vs apex m | Release σ m | Median peak g |')
      parts.push('|------|--:|---------------------------:|----------:|-------------------------:|------------:|--------------:|')
      for (const c of corners) {
        const rows = allBrakingRows.filter(row =>
          row.turn === c.turn && representativeLapKeys.has(`${row.sg}:${row.lap - 1}`))
        if (!rows.length) continue
        const onsets = rows.map(row => c.apex_idx - row.onset_dist_m)
        const releases = rows.map(row => row.release_dist_m - c.apex_idx)
        const peaks = rows.map(row => row.peak_brake_g)
        parts.push(`| ${c.turn} | ${rows.length} | ${median(onsets).toFixed(1)} | ${stddev(onsets).toFixed(1)} | ${median(releases).toFixed(1)} | ${stddev(releases).toFixed(1)} | ${median(peaks).toFixed(2)} |`)
      }
      parts.push('')
    }
  }

  // Best-lap trace
  if (sessions.length) {
    const bestSession = sessions.reduce((acc, s) => (s.best_lap_ms ?? Infinity) < (acc.best_lap_ms ?? Infinity) ? s : acc, sessions[0])
    const sessLaps = bySession.get(bestSession.session_guid) ?? []
    if (sessLaps.length) {
      const bestLap = sessLaps.reduce((acc, L) => (L.duration_ms ?? Infinity) < (acc.duration_ms ?? Infinity) ? L : acc, sessLaps[0])
      parts.push('## Best-lap trace — every ~50 m')
      parts.push(`_${bestSession.session_guid.slice(0, 8)}… lap ${bestLap.lap_index + 1} (${msToLap(bestLap.duration_ms)})_`)
      parts.push('')
      const trace = await fetchBestLapTrace(con, bestSession.session_guid, bestLap.lap_index, 50)
      parts.push(`speed in ${spdU} (converted from gnss_speed_mps), long_accel=accel_x_mps2 (m/s², neg=braking), lat_g=accel_y_mps2 (m/s², |val|/9.81=g), altitude=gnss_altitude_m (m MSL), lateral_pos=lateral_position (0–1), heading=gnss_heading_deg (°)`)
      parts.push('')
      parts.push(`| dist_m | speed (${spdU}) | long_accel (m/s²) | lat_g (m/s²) | altitude (m) | lateral_pos | heading (°) |`)
      parts.push('|-------:|------------:|------------------:|-------------:|-------------:|------------:|------------:|')
      for (const p of trace) {
        parts.push(`| ${p.distance_m} | ${spd(p.gnss_speed_mps).toFixed(1)} | ${(p.accel_x_mps2 ?? 0) >= 0 ? '+' : ''}${(p.accel_x_mps2 ?? 0).toFixed(3)} | ${(p.accel_y_mps2 ?? 0) >= 0 ? '+' : ''}${(p.accel_y_mps2 ?? 0).toFixed(3)} | ${(p.gnss_altitude_m ?? 0).toFixed(1)} | ${(p.lateral_position ?? 0).toFixed(3)} | ${(p.gnss_heading_deg ?? 0).toFixed(1)} |`)
      }
      parts.push('')
    }
  }

  if (includeGuides) {
    // Include the matching track guide plus driver/coaching notes. Setup research
    // remains in Car.md unless explicitly framed as driver context; injecting
    // every reference document would dilute the lap evidence and inflate prompts.
    const configSlug = configName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const contextGuides = fs.readdirSync(profileDir)
      .filter(n => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'car.md')
      .filter(n => {
        const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/\.md$/, '')
        const trackMatch = slug.includes(configSlug) || configSlug.includes(slug.split('-').slice(0, 3).join('-'))
        return trackMatch || /driver|coach/i.test(n)
      })
    for (const guide of contextGuides) {
      parts.push(`## Driver/track context — ${guide}`)
      parts.push(inlineMd(path.join(profileDir, guide), 2))
      parts.push('')
    }
  }

  // Field labels + observed value stats
  parts.push('## Field labels — confirmed')
  parts.push('')
  parts.push('Field names confirmed from embedded proto descriptor strings in `libgecko.so` (`Racing.Core.Proto.GroupedSensorData`, `RacingTypes.pb.cc`). All verified against observed value ranges on real VIR Full Course data. The **observed ranges across this brief\'s data** are tabulated below.')
  parts.push('')

  const statsSelectExpr = CONFIRMED_FIELD_LABELS.flatMap(([col]) => [`MIN(${col})`, `MAX(${col})`, `AVG(${col})`]).join(', ')
  const lapPairClause = lapRows.map(() => '(session_guid = ? AND lap_index = ?)').join(' OR ')
  const lapPairParams = lapRows.flatMap(lap => [lap.session_guid, lap.lap_index])
  const statsRow = lapRows.length
    ? (await rowsToDicts(con, `SELECT ${statsSelectExpr} FROM samples WHERE ${lapPairClause}`, lapPairParams))[0] ?? {}
    : {}
  const statsArr: number[] = Object.values(statsRow).map(v => (v == null ? 0 : Number(v)))

  parts.push('| Column | Units | Interpretation | min | max | avg |')
  parts.push('|--------|-------|----------------|----:|----:|----:|')
  CONFIRMED_FIELD_LABELS.forEach(([col, [units, note], opts], i) => {
    // The speed channel is converted to the active display unit; others pass through.
    const scale = opts?.speed ? speedFromMps(1, system) : (opts?.scale ?? 1)
    const unitLabel = opts?.speed ? spdU : units
    const display = opts?.speed ? `gnss_speed_${system === 'imperial' ? 'mph' : 'kmh'}` : (opts?.display ?? col)
    const mn = (statsArr[i * 3] ?? 0) * scale
    const mx = (statsArr[i * 3 + 1] ?? 0) * scale
    const av = (statsArr[i * 3 + 2] ?? 0) * scale
    const fmt = (Math.abs(mx) < 10 && Math.abs(mn) < 10) ? 3 : 2
    parts.push(`| \`${display}\` | ${unitLabel} | ${note} | ${mn.toFixed(fmt)} | ${mx.toFixed(fmt)} | ${av.toFixed(fmt)} |`)
  })
  parts.push('')

  if (opts.includeTask !== false) {
    parts.push('---')
    parts.push('')
    parts.push('## Your task')
    parts.push('')
    parts.push(`You are a **professional HPDE coach** analyzing this driver's Catalyst telemetry. The car and driver are described in the "Car & driver — ${profileName}" section above — use those specs, modifications, goals, and driver notes as primary context.

Use the tables above to produce a **data-grounded coaching report**. Every claim must cite a specific lap, segment, or corner from the data — do not generalize. Computation is encouraged: deltas vs PB, consistency variance per segment, correlations.

**Required sections** (markdown headings):

1. **Headline** — overall pace vs PB potential. Compute: best theoretical lap = sum of best splits per segment. Compare to actual best lap. The gap is "consistency loss." Quote the number.
2. **Per-segment analysis** — for each S1..S${segments.length || 'N'} segment, identify (a) whether the driver is consistent, (b) average gap to PB, (c) which corners live in that segment and what's happening there. Specifically call out the 3 segments with largest avg gap-to-PB.
3. **Per-corner analysis** — for each named corner with notable data, cite entry/V-min/exit speeds vs PB and compare where V-min occurs. Treat V-min as a critical metric: when its value or location reveals a meaningful opportunity, explain it explicitly and carry it into the coaching recommendation.
4. **Cross-lap consistency** — which laps are outliers; describe what is different.
5. **Cross-session trends** — if multiple sessions, find improvement or regression; correlate to weather if there's a clear pattern.
6. **Prioritised recommendations** — top 3 concrete changes to work on with expected lap-time gain.
7. **Drills** — specific exercises for next track day.
8. **Car setup** (optional) — only if the telemetry shows a mechanical signature (understeer/oversteer, brake lock, grip falloff with temperature). Suggest concrete config changes (tyre pressure, alignment, suspension, ride height, brakes, aero) with the data that motivates them. If nothing in the data justifies a setup change, say so and recommend none — do not invent advice.

**Output format**: write your analysis to:

    coaching/${today}-${scope}.md

Be terse and specific. Cite lap numbers, segment IDs, dist_idx ranges, and exact deltas (e.g. "Lap 4 S6 31.50s vs PB 30.70s = +0.80s"). Skip generic HPDE advice — only conclusions that follow from the data above are useful.`)
    parts.push('')
  }

  return parts.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Entry point: build + write brief.
// ---------------------------------------------------------------------------

export interface BriefRunOpts {
  scope?: 'overview' | 'corner' | 'compare'
  profile?: string
  mode?: 'last' | 'selected' | 'all'
  lastN?: number
  sessionGuids?: string[]
  includeGuides?: boolean
  csv?: boolean
  outPath?: string
  dbPath?: string
  system?: UnitSystem
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/ /g, '-')
}

async function writeCsvPack(
  outDir: string,
  sessions: SessionRow[],
  trackYaml: TrackYaml,
  con: DuckDBConnection,
): Promise<Record<string, number>> {
  fs.mkdirSync(outDir, { recursive: true })
  const segments = trackYaml.segments ?? []
  const corners = trackYaml.corners ?? []
  const sgList = sessions.map(s => s.session_guid)
  const counts: Record<string, number> = {}

  // sessions.csv
  {
    const lines: string[] = []
    lines.push('session_guid,session_start,config,best_lap_ms,weather,temperature_c,humidity_pct,wind_speed_mps,wind_direction_deg')
    for (const s of sessions) {
      lines.push([s.session_guid, s.session_start ?? '', s.track_configuration_name ?? '', s.best_lap_ms ?? '', s.weather_description ?? '', s.temperature_c ?? '', s.humidity_pct ?? '', s.wind_speed_mps ?? '', s.wind_direction_deg ?? ''].join(','))
    }
    fs.writeFileSync(path.join(outDir, 'sessions.csv'), lines.join('\n'))
    counts['sessions.csv'] = sessions.length
  }

  // laps.csv
  const laps = await fetchLapTable(con, sgList)
  if (laps.length) {
    const cols = Object.keys(laps[0])
    const lines = [cols.join(',')]
    for (const r of laps) lines.push(cols.map(c => (r[c] ?? '')).join(','))
    fs.writeFileSync(path.join(outDir, 'laps.csv'), lines.join('\n'))
  }
  counts['laps.csv'] = laps.length

  // segment_splits.csv
  {
    const lines = ['session_guid,lap_index,segment_id,start_m,end_m,split_sec']
    let n = 0
    for (const sg of sgList) {
      const splits = await fetchSegmentSplits(con, sg, segments)
      for (let lapIdx = 0; lapIdx < splits.length; lapIdx++) {
        const row = splits[lapIdx]
        for (let i = 0; i < segments.length; i++) {
          lines.push([sg, lapIdx, segments[i].id, segments[i].start_dist_m, segments[i].end_dist_m, row[i] ?? ''].join(','))
          n++
        }
      }
    }
    fs.writeFileSync(path.join(outDir, 'segment_splits.csv'), lines.join('\n'))
    counts['segment_splits.csv'] = n
  }

  // corner_stats.csv + best_lap_trace.csv
  {
    const lines = ['session_guid,lap_index,turn,corner_name,entry_speed_mps,vmin_speed_mps,vmin_distance_m,exit_speed_mps,speed_drop_mps,max_lat_g_mps2,min_accel_x_mps2,max_accel_x_mps2']
    let n = 0
    for (const sg of sgList) {
      const sessLaps = await rowsToDicts(con, 'SELECT lap_index FROM laps WHERE session_guid = ? ORDER BY lap_index', [sg])
      for (const { lap_index } of sessLaps) {
        const stats = await fetchCornerStats(con, sg, lap_index, corners)
        for (const [turn, st] of stats) {
          lines.push([sg, lap_index, turn, st.name, st.entry_speed, st.apex_speed, st.vmin_distance_m, st.exit_speed, st.speed_drop, st.max_lat_g, st.min_accel_g, st.max_accel_g].join(','))
          n++
        }
      }
    }
    fs.writeFileSync(path.join(outDir, 'corner_stats.csv'), lines.join('\n'))
    counts['corner_stats.csv'] = n
  }

  {
    const lines = ['session_guid,lap_index,distance_m,gnss_speed_mps,accel_x_mps2,accel_y_mps2,gnss_altitude_m,lateral_position,gnss_heading_deg']
    let n = 0
    for (const sg of sgList) {
      const sessLaps = await rowsToDicts(con, 'SELECT lap_index FROM laps WHERE session_guid = ? ORDER BY lap_index', [sg])
      for (const { lap_index } of sessLaps) {
        const trace = await fetchBestLapTrace(con, sg, lap_index, 50)
        for (const p of trace) {
          lines.push([sg, lap_index, p.distance_m, p.gnss_speed_mps ?? '', p.accel_x_mps2 ?? '', p.accel_y_mps2 ?? '', p.gnss_altitude_m ?? '', p.lateral_position ?? '', p.gnss_heading_deg ?? ''].join(','))
          n++
        }
      }
    }
    fs.writeFileSync(path.join(outDir, 'best_lap_trace.csv'), lines.join('\n'))
    counts['best_lap_trace.csv'] = n
  }

  return counts
}

export async function runBrief(opts: BriefRunOpts): Promise<{ outPath: string; sessions: number }> {
  const dbPath = opts.dbPath ?? DB_PATH
  if (!fs.existsSync(dbPath)) {
    throw new Error(`no database at ${dbPath}. Run load first.`)
  }
  const db = await openDb(dbPath)
  const con = db.con
  try {
    const scope = opts.scope ?? 'overview'

    let sessions: SessionRow[]
    if (opts.mode === 'selected' && opts.sessionGuids?.length) {
      sessions = await fetchSessions(con, opts.sessionGuids, null)
    } else if (opts.mode === 'all') {
      sessions = await fetchSessions(con, null, 10_000)
    } else {
      sessions = await fetchSessions(con, null, opts.lastN ?? 5)
    }
    if (!sessions.length) throw new Error('no sessions matched.')

    const counts = new Map<string, number>()
    for (const s of sessions) {
      const c = s.track_configuration_name ?? ''
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    const topConfig = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    // Mean-line GUID is the primary key the Tracks editor stamps on save; we
    // resolve by that first so brief generation picks up corner edits even if
    // the YAML lives under a non-canonical filename.
    const mlgCounts = new Map<string, number>()
    for (const s of sessions) {
      if (s.mean_line_guid) mlgCounts.set(s.mean_line_guid, (mlgCounts.get(s.mean_line_guid) ?? 0) + 1)
    }
    const topMeanLineGuid = [...mlgCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const topTrackName = sessions.find(s => s.track_name)?.track_name ?? ''
    const trackPath = resolveTrackYamlPath(topTrackName, topConfig, topMeanLineGuid).path
    const trackYaml = loadTrackYaml(trackPath)

    const profile = resolveProfileDir(opts.profile)
    fs.mkdirSync(COACHING_DIR, { recursive: true })

    const outPath = opts.outPath ?? path.join(
      COACHING_DIR,
      `${new Date().toISOString().slice(0, 10)}-${profile.name.toLowerCase()}-${scope}-brief.md`,
    )

    let dataRelPath: string | null = null
    if (opts.csv) {
      const dataDir = path.join(path.dirname(outPath), path.basename(outPath, '.md').replace('-brief', '') + '-data')
      dataRelPath = path.basename(dataDir)
      await writeCsvPack(dataDir, sessions, trackYaml, con)
    }

    const brief = await buildBrief({
      sessions, trackYaml, scope, con,
      profileDir: profile.dir, profileName: profile.name,
      includeGuides: opts.includeGuides,
      dataDirRelpath: dataRelPath,
      system: opts.system,
    })
    fs.writeFileSync(outPath, brief)
    return { outPath, sessions: sessions.length }
  } finally {
    await db.close()
  }
}

// ─── AI Coach: structured-output prompt ──────────────────────────────────────

function structuredOutputInstructions(system: UnitSystem): string {
  const spdU = speedUnitLabel(system)
  return `

---

## Coaching output instructions

You are a professional HPDE coach. Analyze the complete Catalyst dataset above, then call \`submit_coaching_report\` exactly once with the finished report. Do not return a separate essay or JSON code fence. Write directly to the driver in plain, concise language.

### Analysis standard

- Start from the driver's car/profile, experience, goals, known setup, and past handling notes. Do not recommend a change the profile says is already installed, unavailable, or intentionally constrained.
- Treat dated setup/tire notes temporally: match them to each session date, prefer explicit “current” values, and do not project a later modification backward onto older laps. When the profile is ambiguous, state the uncertainty instead of assuming.
- Establish comparable populations first: same track configuration, representative laps, and reasonably similar conditions. Keep slow/outlier laps for mistake and repeatability analysis, but do not use them to define pace.
- Quantify the actual best, theoretical best, and **consistency loss = actual best − theoretical best**. It must be non-negative.
- Rank opportunities using repeatable median gap, variance, and corroborating corner traces—not a single maximum speed or isolated heroic split. Distinguish correlation from causation.
- For every recommendation, trace the chain: measured evidence → likely technique/mechanism → exact action → measurable success criterion. If the sensor set cannot prove the input, use “suggests,” “consistent with,” or a testable hypothesis.
- Estimate gains conservatively. Avoid double-counting overlapping segment/corner gains, and do not let the combined headline opportunity exceed the measured consistency gap without clearly identifying separate long-term pace potential.
- Treat safety-critical patterns first, but do not invent safety concerns.

### Required report content

1. **Headline**: the single largest repeatable opportunity, its conservative gain, and where it occurs.
2. **Strengths**: 2–4 data-backed habits to preserve. Positive reinforcement must be as specific as corrective advice.
3. **Prioritized tips**: 3–6 tips. Each must include priority (1 highest), conservative \`estimated_gain_ms\` when supportable, confidence, 1–3 exact evidence strings (session short ID + lap + S/T reference + measurement), a short in-car cue, and a Catalyst success metric. The body must explain what changes and why in 2–4 sentences.
4. **Drills**: 3–5 safe, progressive exercises tied to the tips. Specify the corner/segment, number of laps or repetitions, what to hold constant, and when to stop escalating.
5. **Next-session plan**: 2–4 runs that sequence baseline, one-variable practice, verification, and consolidation. Give each run one primary focus and a measurable review criterion.
6. **Car setup**: optional and often empty. Only recommend a configuration change when a repeated mechanical signature remains on representative/best laps and the available telemetry supports it. Make one change at a time and describe how to validate or revert it. Do not infer tire pressures/temperatures, brake bias, lockup, steering input, or damper behavior from channels that are not present.
7. **Data-quality notes**: only limitations that materially affect confidence or block a conclusion. Include an empty array when there are none.

All narrative speeds must use **${spdU}**. The annotation schema stores speed values in **mph** for app compatibility; when the brief is metric, convert only the annotation numeric fields to mph while leaving prose in ${spdU}.

### Annotation rules

- \`type\`: corner_tip | segment_tip | speed_annotation | line_deviation.
- \`ref\` is exactly one corner (T4) or segment (S3), never a range. Duplicate every nested annotation in the flat \`annotations\` array.
- V-min is the measured minimum inside the corner zone, not necessarily the geometric apex. Compare both speed and distance across laps.
- Include \`actual_vmin_mph\`, \`target_vmin_mph\`, and \`actual_vmin_dist_m\` only when supported. A target should normally be a repeatable observed personal best or a small progressive step toward it, not an invented ideal.
- Severity: 1 minor, 2 meaningful gain, 3 safety-critical or major time loss. Omit unknown optional numbers instead of guessing.

### Coach-line rules

- Each waypoint is a **delta from the driver's best lap** at that distance, as seen in the best-lap trace table above (the \`lateral_pos\` column). \`delta\` = recommended lateral_pos − driver's actual lateral_pos at that dist_m.
- \`delta\` range: −1.0 to +1.0. Positive = shift toward right track edge; negative = shift toward left. Clamp the resulting position to the track (0–1).
- Emit waypoints only when same-driver faster laps or the supplied track guide provide a defensible line reference. Otherwise return an empty array; do not invent an “ideal” line from normalized lateral position alone.
- \`dist_m\` must match a distance in the best-lap trace table (multiples of 50 m) or a corner apex/entry/exit distance from the corner tables — do not invent distances.
- \`note\`: ≤40 chars, shown as a label on the track map
`
}

export async function buildCoachPrompt(opts: BuildBriefOpts): Promise<string> {
  const brief = await buildBrief({ ...opts, includeTask: false })
  return brief + structuredOutputInstructions(opts.system ?? DEFAULT_UNIT_SYSTEM)
}

export interface CoachRunOpts {
  sessionGuids: string[]
  lapLimit?: 3 | 5 | 10 | null
  profile: string
  scope: 'overview' | 'corner' | 'compare'
  dbPath?: string
  system?: UnitSystem
}

export async function runCoach(opts: CoachRunOpts): Promise<{ prompt: string; profile: string }> {
  const dbPath = opts.dbPath ?? DB_PATH
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}. Run load first.`)
  const db = await openDb(dbPath)
  const con = db.con
  try {
    const sessions = await fetchSessions(con, opts.sessionGuids, null)
    if (!sessions.length) throw new Error('no sessions matched the provided GUIDs.')

    const trackConfigs = new Map<string, string>()
    for (const session of sessions) {
      const key = String(session.track_configuration_id ?? session.track_configuration_name ?? 'unknown')
      trackConfigs.set(key, session.track_configuration_name ?? key)
    }
    if (trackConfigs.size > 1) {
      throw new Error(`AI coaching requires one track configuration at a time. Selected: ${[...trackConfigs.values()].join(', ')}.`)
    }
    const vehicleGuids = new Set(sessions.map(session => session.vehicle_guid).filter(Boolean))
    if (vehicleGuids.size > 1) {
      throw new Error('AI coaching requires sessions from one vehicle at a time so setup and pace comparisons stay valid.')
    }

    const counts = new Map<string, number>()
    for (const s of sessions) {
      const c = s.track_configuration_name ?? ''
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    const topConfig = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    const mlgCounts = new Map<string, number>()
    for (const s of sessions) {
      if (s.mean_line_guid) mlgCounts.set(s.mean_line_guid, (mlgCounts.get(s.mean_line_guid) ?? 0) + 1)
    }
    const topMeanLineGuid = [...mlgCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const topTrackName = sessions.find(s => s.track_name)?.track_name ?? ''
    const trackPath = resolveTrackYamlPath(topTrackName, topConfig, topMeanLineGuid).path
    const trackYaml = loadTrackYaml(trackPath)

    const mappedProfile = resolveVehicleProfile(sessions[0].vehicle_guid, sessions[0].vehicle_make).profile
    const profile = resolveProfileDir(mappedProfile ?? opts.profile)

    const prompt = await buildCoachPrompt({
      sessions, trackYaml, scope: opts.scope, con,
      profileDir: profile.dir, profileName: profile.name,
      includeGuides: true,
      system: opts.system,
      lapLimit: opts.lapLimit,
    })

    return { prompt, profile: profile.name }
  } finally {
    await db.close()
  }
}
