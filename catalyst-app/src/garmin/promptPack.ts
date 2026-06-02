// Generate a data-dense LLM coaching brief from selected Catalyst sessions.
// Port of garmin/prompt_pack.py.

import fs from 'node:fs'
import path from 'node:path'
import { DuckDBConnection } from '@duckdb/node-api'
import { COACHING_DIR, DB_PATH, TRACKS_DIR } from './paths.js'
import { loadTrackYaml, resolveTrackYamlPath, TrackCorner, TrackSegment, TrackYaml } from './trackYaml.js'
import { resolveProfileDir } from './profiles.js'
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
    WHERE l.session_guid IN (${placeholders})
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
  exit_speed: number
  speed_drop: number
  max_lat_g: number
  min_accel_g: number
  max_accel_g: number
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
    const speeds = rows.filter(r => r.gnss_speed_mps != null).map(r => r.gnss_speed_mps as number)
    const longs = rows.filter(r => r.accel_x_mps2 != null).map(r => r.accel_x_mps2 as number)
    const lats = rows.filter(r => r.accel_y_mps2 != null).map(r => Math.abs(r.accel_y_mps2 as number))
    if (!speeds.length) continue
    const nEdge = Math.min(5, Math.max(1, Math.floor(speeds.length / 8)))
    const entry = speeds.slice(0, nEdge).reduce((a, b) => a + b, 0) / nEdge
    const exit = speeds.slice(-nEdge).reduce((a, b) => a + b, 0) / nEdge
    const apex = Math.min(...speeds)
    out.set(c.turn, {
      name: c.name ?? '',
      n_samples: rows.length,
      entry_speed: entry,
      apex_speed: apex,
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
}

export async function buildBrief(opts: BuildBriefOpts): Promise<string> {
  const { sessions, trackYaml, scope, con, profileDir, profileName, includeGuides, dataDirRelpath } = opts
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
  const sgList = sessions.map(s => s.session_guid)
  const parts: string[] = []

  parts.push(`# Coaching Brief — ${configName} (${scope})`)
  parts.push(`_Generated: ${today}_  ·  _Sessions: ${sessions.length}_`)
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
  parts.push(`| Date | Config | Weather | Temp ${tmpU} | Humidity % | Wind | Best Lap | Laps |`)
  parts.push('|------|--------|---------|--------:|-----------:|------|---------:|-----:|')
  for (const s of sessions) {
    const lapsRow = await rowsToDicts(con, 'SELECT COUNT(*) AS n FROM laps WHERE session_guid = ?', [s.session_guid])
    const nlaps = lapsRow[0]?.n ?? 0
    const temp = s.temperature_c != null ? tmp(s.temperature_c).toFixed(1) : ''
    const humidity = s.humidity_pct != null ? Math.round(s.humidity_pct) : ''
    parts.push(`| ${s.session_start ?? '?'} | ${s.track_configuration_name ?? '?'} | ${s.weather_description ?? ''} | ${temp} | ${humidity} | ${fmtWind(s.wind_speed_mps, s.wind_direction_deg, system)} | ${msToLap(s.best_lap_ms)} | ${nlaps} |`)
  }
  parts.push('')

  parts.push('## All laps')
  parts.push("One row per lap across every selected session. Δ best = duration minus the session's best lap.")
  parts.push('')

  const lapRows = await fetchLapTable(con, sgList)
  const bySession = new Map<string, any[]>()
  for (const L of lapRows) {
    if (!bySession.has(L.session_guid)) bySession.set(L.session_guid, [])
    bySession.get(L.session_guid)!.push(L)
  }

  parts.push(`| Session | Lap | Type | Duration | Δ best | Max speed (${spdU}) | Max |lat_g| (m/s²) | Max long_accel (m/s²) | Min long_accel (m/s²) |`)
  parts.push('|---------|----:|------|----------:|-------:|----------------:|------------------:|----------------------:|----------------------:|')
  for (const [sg, laps] of bySession) {
    const durs = laps.map(L => L.duration_ms).filter(Boolean)
    const bestMs = durs.length ? Math.min(...durs) : 0
    for (const L of laps) {
      const delta = bestMs && L.duration_ms ? (L.duration_ms - bestMs) / 1000 : 0
      parts.push(`| ${sg.slice(0, 8)}… | ${L.lap_index + 1} | ${L.lap_type ?? ''} | ${msToLap(L.duration_ms)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s | ${spd(L.max_speed).toFixed(1)} | ${(L.max_lat_g ?? 0).toFixed(3)} | ${(L.max_long_accel ?? 0) >= 0 ? '+' : ''}${(L.max_long_accel ?? 0).toFixed(3)} | ${(L.min_long_accel ?? 0) >= 0 ? '+' : ''}${(L.min_long_accel ?? 0).toFixed(3)} |`)
    }
  }
  parts.push('')

  // Per-segment splits
  parts.push('## Per-segment splits (sec) — all laps')
  parts.push('Computed by integrating 1/gnss_speed_mps over distance, scaled so the per-lap sum equals lap duration. Lap-relative; comparable across laps and sessions.')
  parts.push('')
  const segIds = segments.map(s => s.id)
  parts.push(`| Session | Lap | ${segIds.map(i => `S${i}`).join(' | ')} |`)
  parts.push(`|${new Array(segIds.length + 2).fill('------:').join('|')}|`)

  const pbPerSegment: number[] = new Array(segments.length).fill(Infinity)
  for (const sg of sgList) {
    const splits = await fetchSegmentSplits(con, sg, segments)
    for (let lapIdx = 0; lapIdx < splits.length; lapIdx++) {
      const row = splits[lapIdx]
      if (row.every(v => v == null)) continue
      const cells: string[] = []
      for (let i = 0; i < row.length; i++) {
        const v = row[i]
        if (v == null) cells.push('  —  ')
        else {
          cells.push(v.toFixed(2).padStart(6, ' '))
          if (v < pbPerSegment[i]) pbPerSegment[i] = v
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

  // Per-corner stats
  if (corners.length) {
    parts.push('## Per-corner stats — every lap')
    parts.push(`**entry**=avg speed first 5 samples of zone, **apex**=min speed in zone, **exit**=avg speed last 5 samples, **drop**=entry-apex. All speeds in ${spdU}. max_lat_g = max(|accel_y_mps2|) in m/s² (÷9.81 for g). min_accel_g = min(accel_x_mps2) m/s² — most negative = hardest braking.`)
    parts.push('')

    const allCornerRows: Array<{ sg: string; lap: number; turn: string } & CornerStat> = []
    for (const sg of sgList) {
      const laps = bySession.get(sg) ?? []
      for (const L of laps) {
        const stats = await fetchCornerStats(con, sg, L.lap_index, corners)
        for (const [turn, st] of stats) {
          allCornerRows.push({ sg, lap: L.lap_index + 1, turn, ...st })
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
    parts.push(`| Sess | Lap | Turn | Name | Entry (${spdU}) | Apex (${spdU}) | Exit (${spdU}) | Drop (${spdU}) | LatG (m/s²) | MinAccX (m/s²) | LPos Entry | LPos Apex | LPos Exit |`)
    parts.push('|------|----:|------|------|------------:|-----------:|-----------:|-----------:|------------:|---------------:|-----------:|----------:|----------:|')
    for (const r of allCornerRows) {
      const lat = lateralRows.get(`${r.sg}:${r.lap - 1}:${r.turn}`)
      const fmtL = (v: number | null | undefined) => v == null ? '—' : v.toFixed(2)
      parts.push(`| ${r.sg.slice(0, 8)}… | ${r.lap} | ${r.turn} | ${r.name} | ${spd(r.entry_speed).toFixed(1)} | ${spd(r.apex_speed).toFixed(1)} | ${spd(r.exit_speed).toFixed(1)} | ${spd(r.speed_drop).toFixed(1)} | ${r.max_lat_g.toFixed(3)} | ${r.min_accel_g >= 0 ? '+' : ''}${r.min_accel_g.toFixed(3)} | ${fmtL(lat?.entry)} | ${fmtL(lat?.apex)} | ${fmtL(lat?.exit)} |`)
    }
    parts.push('')

    parts.push('### Personal-best per corner')
    parts.push(`| Turn | Name | Best apex (${spdU}) | Best exit (${spdU}) | Hardest braking min(accel_x) m/s² | Max LatG |accel_y| m/s² |`)
    parts.push('|------|------|----------------:|----------------:|----------------------------------:|---------------------:|')
    for (const c of corners) {
      const pb = pbCorner.get(c.turn)
      if (!pb) continue
      parts.push(`| ${c.turn} | ${c.name ?? '?'} | ${spd(pb.best_apex_speed).toFixed(1)} | ${spd(pb.best_exit_speed).toFixed(1)} | ${pb.best_min_accel >= 0 ? '+' : ''}${pb.best_min_accel.toFixed(2)} | ${pb.best_max_lat_g.toFixed(2)} |`)
    }
    parts.push('')
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
    // Only include a track-specific guide if one exists for the current config.
    // We match by slugified config name (e.g. "VIR Full Course" → "vir-full-course")
    // against the available .md files, excluding Car.md which is always included above.
    const configSlug = configName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const trackGuide = fs.readdirSync(profileDir)
      .filter(n => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'car.md')
      .find(n => {
        const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/\.md$/, '')
        return slug.includes(configSlug) || configSlug.includes(slug.split('-').slice(0, 3).join('-'))
      })
    if (trackGuide) {
      parts.push(`## Track guide — ${trackGuide}`)
      parts.push(inlineMd(path.join(profileDir, trackGuide), 2))
      parts.push('')
    }
  }

  // Field labels + observed value stats
  parts.push('## Field labels — confirmed')
  parts.push('')
  parts.push('Field names confirmed from embedded proto descriptor strings in `libgecko.so` (`Racing.Core.Proto.GroupedSensorData`, `RacingTypes.pb.cc`). All verified against observed value ranges on real VIR Full Course data. The **observed ranges across this brief\'s data** are tabulated below.')
  parts.push('')

  const placeholders = sgList.map(() => '?').join(',')
  const statsSelectExpr = CONFIRMED_FIELD_LABELS.flatMap(([col]) => [`MIN(${col})`, `MAX(${col})`, `AVG(${col})`]).join(', ')
  const statsRow = sgList.length
    ? (await rowsToDicts(con, `SELECT ${statsSelectExpr} FROM samples WHERE session_guid IN (${placeholders})`, sgList))[0] ?? {}
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

  parts.push('---')
  parts.push('')
  parts.push('## Your task')
  parts.push('')
  parts.push(`You are a **professional HPDE coach** analyzing this driver's Catalyst telemetry. The driver (Ryan) is intermediate. The car for this brief is described in the "Car & driver — ${profileName}" section above — use its specs, mods, and driver notes as primary context (handling tendencies, target lap times, modification history all matter).

Use the tables above to produce a **data-grounded coaching report**. Every claim must cite a specific lap, segment, or corner from the data — do not generalize. Computation is encouraged: deltas vs PB, consistency variance per segment, correlations.

**Required sections** (markdown headings):

1. **Headline** — overall pace vs PB potential. Compute: best theoretical lap = sum of best splits per segment. Compare to actual best lap. The gap is "consistency loss." Quote the number.
2. **Per-segment analysis** — for each S1..S${segments.length || 'N'} segment, identify (a) whether the driver is consistent, (b) average gap to PB, (c) which corners live in that segment and what's happening there. Specifically call out the 3 segments with largest avg gap-to-PB.
3. **Per-corner analysis** — for each named corner with notable data, cite entry/apex/exit speeds vs PB.
4. **Cross-lap consistency** — which laps are outliers; describe what is different.
5. **Cross-session trends** — if multiple sessions, find improvement or regression; correlate to weather if there's a clear pattern.
6. **Prioritised recommendations** — top 3 concrete changes to work on with expected lap-time gain.
7. **Drills** — specific exercises for next track day.
8. **Car setup** (optional) — only if the telemetry shows a mechanical signature (understeer/oversteer, brake lock, grip falloff with temperature). Suggest concrete config changes (tyre pressure, alignment, suspension, ride height, brakes, aero) with the data that motivates them. If nothing in the data justifies a setup change, say so and recommend none — do not invent advice.

**Output format**: write your analysis to:

    coaching/${today}-${scope}.md

Be terse and specific. Cite lap numbers, segment IDs, dist_idx ranges, and exact deltas (e.g. "Lap 4 S6 31.50s vs PB 30.70s = +0.80s"). Skip generic HPDE advice — only conclusions that follow from the data above are useful.`)
  parts.push('')

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
    const lines = ['session_guid,lap_index,turn,corner_name,entry_speed_mps,apex_speed_mps,exit_speed_mps,speed_drop_mps,max_lat_g_mps2,min_accel_x_mps2,max_accel_x_mps2']
    let n = 0
    for (const sg of sgList) {
      const sessLaps = await rowsToDicts(con, 'SELECT lap_index FROM laps WHERE session_guid = ? ORDER BY lap_index', [sg])
      for (const { lap_index } of sessLaps) {
        const stats = await fetchCornerStats(con, sg, lap_index, corners)
        for (const [turn, st] of stats) {
          lines.push([sg, lap_index, turn, st.name, st.entry_speed, st.apex_speed, st.exit_speed, st.speed_drop, st.max_lat_g, st.min_accel_g, st.max_accel_g].join(','))
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

You are a professional HPDE coach analysing the telemetry data above. Write like you're talking directly to the driver — specific, clear, and grounded in the numbers. Produce:

1. **Headline** — one sentence naming the single biggest opportunity. Quantify the gap and name the area (e.g. "2.8s gap to theoretical best — Esses commitment and Oak Tree exit are the primary limiters").
2. **Tips** — 3–6 coaching tips, each focused on a specific corner (T4, T7-T9) or segment (S3). Describe what the driver is doing, why it costs time, and what to change. Express all speeds in ${spdU}.
3. **Drills** — 3–5 concrete practice exercises for the next track day that directly target the problems identified.
4. **Car setup** — setup/configuration changes the telemetry supports (tyre pressure, alignment, suspension, ride height, brakes, aero, differential, etc.). This is OPTIONAL and frequently empty: only suggest a change when the data shows a clear mechanical signature, not a driver-input one. Examples of evidence: a corner where the driver carries good entry speed but the car won't rotate (mid-corner understeer in lateral G + a wide apex line) → soften front bar / add front camber / lower front pressures; snap or scrub on exit (oversteer signature) → soften rear / raise rear pressures; lock-ups or long braking zones → brake bias; grip that falls off as air/track temperature rises across sessions → pressure or compound note. If nothing in the data justifies a change, return an empty \`setup\` array — do not invent advice.

After your written analysis, append a SINGLE JSON block in exactly this format (the app cannot display your coaching without it):

\`\`\`json
{
  "headline": "2.8s gap to theoretical best — Esses commitment and Oak Tree exit are the primary limiters",
  "consistency_loss_ms": 2800,
  "tips": [
    {
      "section": "T7-T9",
      "body": "You're lifting mid-corner through the Esses and losing 1-2 mph at each apex. Data shows entry at 116 mph with apex dropping to 112 mph — it should stay flat. Trust the grip and commit to throttle through all three crests.",
      "annotations": [
        {
          "type": "corner_tip",
          "ref": "T7",
          "body": "Apex is 112 mph where it should be 114 mph minimum. You're lifting when the car has grip to spare — stay flat through the crest.",
          "severity": 2,
          "actual_apex_mph": 112.0,
          "target_apex_mph": 114.0
        }
      ]
    }
  ],
  "drills": ["Practice T7-T9 on cool-down laps at 80% pace with deliberate full throttle through the apex to build confidence in the grip level."],
  "setup": [
    {
      "area": "Tire pressure",
      "change": "Drop front cold pressures ~2 psi for the next session.",
      "rationale": "Mid-corner understeer signature in T1 and T10 — lateral G plateaus ~0.1g below the rear-limited corners and your apex line runs wide despite a committed entry. Lower fronts should add front grip and help rotation.",
      "confidence": 2
    }
  ],
  "annotations": [],
  "coach_line": [
    {"dist_m": 100, "delta": +0.18, "note": "hold wider on entry"},
    {"dist_m": 150, "delta": -0.22, "note": "tighter apex — 3 car-widths left"},
    {"dist_m": 200, "delta": +0.15, "note": "full track-out"}
  ]
}
\`\`\`

All speed values in the data above are already in **${spdU}** — read them straight through, no conversion needed. (The JSON example above shows mph; quote ${spdU} in your output to match the tables.)

Rules for tip and annotation body text:
- Write in plain sentences — no bullet points, no raw data dumps
- Quote speeds in ${spdU} exactly as they appear in the tables
- tip \`body\`: 2–4 sentences. Describe the pattern you see, the time cost, and the specific fix
- annotation \`body\`: 1–2 sentences shown as a callout on the track map — direct and actionable, written to the driver

Rules for annotations:
- \`type\`: corner_tip | segment_tip | speed_annotation | line_deviation
- \`ref\` must be a single label exactly matching a corner (T4) or segment (S3) from the data — no ranges in ref, one annotation per corner
- \`severity\`: 1 = minor, 2 = meaningful gain available, 3 = critical issue affecting safety or significant time
- \`actual_apex_mph\` / \`target_apex_mph\`: the driver's and target apex speed, always in **mph** regardless of the table unit (these two numeric fields are canonical; the app converts to ${spdU} for display). Optional — include for corner_tip when the data supports it.
- The flat \`annotations\` array must list every annotation from every tip — this duplication is required
- Use empty arrays rather than omitting array fields; omit optional speed fields rather than guessing

Rules for setup:
- Each item: \`area\` (e.g. "Tire pressure", "Alignment", "Suspension", "Ride height", "Brakes", "Aero", "Differential"), \`change\` (the concrete adjustment, with direction and rough magnitude where the data allows), \`rationale\` (the data that motivates it — cite corners/segments/laps/conditions, speeds in ${spdU}), and \`confidence\` (1 speculative · 2 likely · 3 strong evidence).
- Distinguish car problems from driver problems. A wide line because the driver turned in early is a driving tip, not a setup change. Only recommend setup when the signature is mechanical (consistent across laps, present even on the driver's best laps, visible in lateral/longitudinal G or braking traces).
- Prefer one to three high-quality recommendations over a long speculative list. An empty \`setup: []\` is a valid and good answer when the data doesn't justify changes — say nothing rather than guessing.

Rules for coach_line:
- Each waypoint is a **delta from the driver's best lap** at that distance, as seen in the best-lap trace table above (the \`lateral_pos\` column). \`delta\` = recommended lateral_pos − driver's actual lateral_pos at that dist_m.
- \`delta\` range: −1.0 to +1.0. Positive = shift toward right track edge; negative = shift toward left. Clamp the resulting position to the track (0–1).
- Only emit waypoints where the recommended line meaningfully differs from the driver's — skip sections where the driver's line is already correct. Aim for 3–6 waypoints per problem corner (entry, turn-in, apex, mid-corner, exit), none on straights where delta is near zero.
- Use the \`lateral_pos\` values in the best-lap trace and per-corner stats tables to anchor your deltas. If the driver's apex is at lateral_pos=0.56 but it should be 0.15, delta = −0.41.
- \`dist_m\` must match a distance in the best-lap trace table (multiples of 50 m) or a corner apex/entry/exit distance from the corner tables — do not invent distances.
- \`note\`: ≤40 chars, shown as a label on the track map

Consistency loss: theoretical_best_ms − actual_best_ms from the lap table.
`
}

export async function buildCoachPrompt(opts: BuildBriefOpts): Promise<string> {
  const brief = await buildBrief(opts)
  return brief + structuredOutputInstructions(opts.system ?? DEFAULT_UNIT_SYSTEM)
}

export interface CoachRunOpts {
  sessionGuids: string[]
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

    const profile = resolveProfileDir(opts.profile)

    const prompt = await buildCoachPrompt({
      sessions, trackYaml, scope: opts.scope, con,
      profileDir: profile.dir, profileName: profile.name,
      includeGuides: true,
      system: opts.system,
    })

    return { prompt, profile: profile.name }
  } finally {
    await db.close()
  }
}
