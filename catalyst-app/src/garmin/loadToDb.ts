// Load downloaded Catalyst session data into a DuckDB database.
// 1:1 port of garmin/load_to_db.py.

import fs from 'node:fs'
import path from 'node:path'
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
import { DATA_DIR, SESSIONS_DIR, DB_PATH } from './paths.js'
import { decodePerformance } from './decodePerformance.js'

export function isoDurationToMs(s: string | undefined | null): number | null {
  if (!s || typeof s !== 'string' || !s.startsWith('PT')) return null
  let total = 0
  let num = ''
  for (const c of s.slice(2)) {
    if ((c >= '0' && c <= '9') || c === '.') {
      num += c
    } else if (c === 'M') {
      total += parseFloat(num) * 60
      num = ''
    } else if (c === 'S') {
      total += parseFloat(num)
      num = ''
    } else if (c === 'H') {
      total += parseFloat(num) * 3600
      num = ''
    }
  }
  return Math.round(total * 1000)
}

export async function initSchema(con: DuckDBConnection): Promise<void> {
  await con.run(`
    CREATE TABLE IF NOT EXISTS track_configs (
      track_cartography_id INTEGER,
      track_name VARCHAR,
      track_configuration_id INTEGER PRIMARY KEY,
      track_configuration_name VARCHAR,
      reverse BOOLEAN,
      direction VARCHAR,
      session_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_guid VARCHAR PRIMARY KEY,
      session_start TIMESTAMP,
      best_lap_ms INTEGER,
      best_lap_normal_ms INTEGER,
      track_cartography_id INTEGER,
      track_configuration_id INTEGER,
      mean_line_guid VARCHAR,
      garmin_guid VARCHAR,
      unit_id BIGINT,
      product_part_number VARCHAR,
      weather_description VARCHAR,
      temperature_c DOUBLE,
      humidity_pct DOUBLE,
      wind_speed_mps DOUBLE,
      wind_direction_deg DOUBLE,
      account VARCHAR,
      vehicle_guid VARCHAR,
      vehicle_make VARCHAR,
      vehicle_model VARCHAR,
      vehicle_year INTEGER,
      vehicle_type VARCHAR
    );

    -- IF NOT EXISTS migrations so older DBs pick up the new columns on next load.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account VARCHAR;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vehicle_guid VARCHAR;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vehicle_year INTEGER;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR;

    CREATE TABLE IF NOT EXISTS laps (
      session_guid VARCHAR,
      lap_index INTEGER,
      lap_type VARCHAR,
      duration_ms INTEGER,
      start_time_session_ms INTEGER,
      lap_descriptor INTEGER,
      min_speed_mps DOUBLE,
      max_speed_mps DOUBLE,
      avg_speed_mps DOUBLE,
      max_decel_mps2 DOUBLE,
      max_accel_mps2 DOUBLE,
      sample_count INTEGER,
      PRIMARY KEY (session_guid, lap_index)
    );

    CREATE TABLE IF NOT EXISTS samples (
      session_guid VARCHAR,
      lap_index INTEGER,
      distance_m INTEGER,
      time_ms INTEGER,
      lat DOUBLE,
      lon DOUBLE,
      gnss_speed_mps DOUBLE,
      gnss_heading_deg DOUBLE,
      gnss_heading_deriv_dps DOUBLE,
      gnss_accuracy_m DOUBLE,
      gnss_altitude_m DOUBLE,
      accel_x_mps2 DOUBLE,
      accel_y_mps2 DOUBLE,
      accel_z_mps2 DOUBLE,
      gyro_roll_dps DOUBLE,
      gyro_pitch_dps DOUBLE,
      gyro_yaw_dps DOUBLE,
      lateral_position DOUBLE
    );

    CREATE INDEX IF NOT EXISTS idx_samples_session_lap
      ON samples(session_guid, lap_index);
  `)
}

function nullIfNaN(v: number | undefined | null): number | null {
  if (v === undefined || v === null) return null
  if (Number.isNaN(v)) return null
  return v
}

export async function loadTrackConfigs(con: DuckDBConnection): Promise<number> {
  const facPath = path.join(DATA_DIR, 'track_facilities.json')
  const cfgPath = path.join(DATA_DIR, 'track_configurations.json')
  if (!fs.existsSync(facPath) || !fs.existsSync(cfgPath)) return 0

  const configsByTrack = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, any[]>
  const rows: any[][] = []
  for (const configs of Object.values(configsByTrack)) {
    for (const c of configs) {
      rows.push([
        c.trackCartographyId ?? null,
        c.trackName ?? null,
        c.trackConfigurationId,
        c.trackConfigurationName ?? null,
        !!c.trackIsReverse,
        c.trackDirection ?? null,
        c.sessionCount ?? null,
      ])
    }
  }
  for (const r of rows) {
    await con.run(
      'INSERT OR REPLACE INTO track_configs VALUES (?, ?, ?, ?, ?, ?, ?)',
      r as any,
    )
  }
  return rows.length
}

export async function loadSession(con: DuckDBConnection, sessionDir: string): Promise<number> {
  const sg = path.basename(sessionDir)
  const summaryP = path.join(sessionDir, 'summary.json')
  const metadataP = path.join(sessionDir, 'metadata.json')
  const weatherP = path.join(sessionDir, 'weather.json')
  const perfP = path.join(sessionDir, 'performance.pb')

  if (!fs.existsSync(summaryP) || !fs.existsSync(perfP)) return 0

  const summary = JSON.parse(fs.readFileSync(summaryP, 'utf-8'))
  const metadata = fs.existsSync(metadataP) ? JSON.parse(fs.readFileSync(metadataP, 'utf-8')) : {}
  const weather = fs.existsSync(weatherP) ? JSON.parse(fs.readFileSync(weatherP, 'utf-8')) : {}

  const accountFile = path.join(sessionDir, '.account')
  const account = fs.existsSync(accountFile) ? fs.readFileSync(accountFile, 'utf-8').trim() || null : null

  await con.run(
    `INSERT OR REPLACE INTO sessions
       (session_guid, session_start, best_lap_ms, best_lap_normal_ms,
        track_cartography_id, track_configuration_id, mean_line_guid,
        garmin_guid, unit_id, product_part_number,
        weather_description, temperature_c, humidity_pct,
        wind_speed_mps, wind_direction_deg, account,
        vehicle_guid, vehicle_make, vehicle_model, vehicle_year, vehicle_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sg,
      summary.sessionStart ?? null,
      isoDurationToMs(summary.bestLap),
      isoDurationToMs(summary.bestLapNormal),
      summary.trackCartographyId ?? null,
      summary.trackConfigurationId ?? null,
      summary.meanLineGuid ?? null,
      metadata.garminGuid ?? null,
      metadata.productIdentifier?.unitId ?? null,
      metadata.productIdentifier?.productSku ?? null,
      weather.description ?? null,
      nullIfNaN(weather.temperature),
      nullIfNaN(weather.relativeHumidity),
      nullIfNaN(weather.windSpeed),
      nullIfNaN(weather.windDirection),
      account,
      metadata.vehicleGuid ?? null,
      metadata.vehicleMake ?? null,
      metadata.vehicleModel ?? null,
      metadata.vehicleYear ?? null,
      metadata.vehicleType ?? null,
    ] as any,
  )

  const decoded = decodePerformance(new Uint8Array(fs.readFileSync(perfP)))
  await con.run('DELETE FROM samples WHERE session_guid = ?', [sg] as any)

  // Laps are tiny (~10 rows/session) — per-row INSERT is fine.
  for (let lapIdx = 0; lapIdx < decoded.driven_laps.length; lapIdx++) {
    const lap = decoded.driven_laps[lapIdx]
    await con.run(
      'INSERT OR REPLACE INTO laps VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        sg, lapIdx, lap.type ?? null, lap.duration_ms ?? null,
        lap.start_time_session_ms ?? null, lap.lap_descriptor ?? null,
        nullIfNaN(lap.min_speed_mps), nullIfNaN(lap.max_speed_mps),
        nullIfNaN(lap.avg_speed_mps), nullIfNaN(lap.max_decel_mps2),
        nullIfNaN(lap.max_accel_mps2), lap.samples.length,
      ] as any,
    )
  }

  // Samples are ~30k/session — use the bulk Appender. SQL INSERT per row
  // through prepared statements was ~100× slower in practice.
  const appender = await con.createAppender('samples')
  const appendDoubleOrNull = (v: number | undefined | null) => {
    if (v == null || Number.isNaN(v)) appender.appendNull()
    else appender.appendDouble(v)
  }
  let sampleCount = 0
  try {
    for (let lapIdx = 0; lapIdx < decoded.driven_laps.length; lapIdx++) {
      const lap = decoded.driven_laps[lapIdx]
      for (const s of lap.samples) {
        appender.appendVarchar(sg)
        appender.appendInteger(lapIdx)
        appender.appendInteger(Math.round(s.distance_m ?? 0))
        if (s.time_ms == null) appender.appendNull(); else appender.appendInteger(s.time_ms)
        if (s.position?.lat == null) appender.appendNull(); else appender.appendDouble(s.position.lat)
        if (s.position?.lon == null) appender.appendNull(); else appender.appendDouble(s.position.lon)
        appendDoubleOrNull(s.gnss_speed_mps)
        appendDoubleOrNull(s.gnss_heading_deg)
        appendDoubleOrNull(s.gnss_heading_deriv_dps)
        appendDoubleOrNull(s.gnss_accuracy_m)
        appendDoubleOrNull(s.gnss_altitude_m)
        appendDoubleOrNull(s.accel_x_mps2)
        appendDoubleOrNull(s.accel_y_mps2)
        appendDoubleOrNull(s.accel_z_mps2)
        appendDoubleOrNull(s.gyro_roll_dps)
        appendDoubleOrNull(s.gyro_pitch_dps)
        appendDoubleOrNull(s.gyro_yaw_dps)
        appendDoubleOrNull(s.lateral_position)
        appender.endRow()
        sampleCount++
      }
    }
    appender.flush()
  } finally {
    appender.close()
  }
  return sampleCount
}

// Read the set of session_guids currently materialized in the DB. Returns an
// empty set if the table doesn't exist yet — used by the smart-sync worker to
// skip what we already have without re-downloading.
export async function existingSessionGuids(con: DuckDBConnection): Promise<Set<string>> {
  try {
    const reader = await con.runAndReadAll('SELECT session_guid FROM sessions')
    const out = new Set<string>()
    for (const row of reader.getRowsJson()) {
      if (row[0]) out.add(String(row[0]))
    }
    return out
  } catch {
    return new Set()
  }
}

export async function openDb(dbPath = DB_PATH, readOnly = false): Promise<{ instance: DuckDBInstance; con: DuckDBConnection }> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const instance = await DuckDBInstance.create(dbPath, readOnly ? { access_mode: 'READ_ONLY' } : {})
  const con = await instance.connect()
  return { instance, con }
}

export async function loadAll(
  log: (line: string) => void,
  dbPath = DB_PATH,
): Promise<{ sessions: number; samples: number }> {
  // Always rebuild from scratch. The JSON+protobuf files in SESSIONS_DIR are
  // the source of truth; the DB is just a derived cache. Wiping it dodges
  // ART-index corruption that's accumulated from prior crashes or
  // cross-version writes (e.g. Python writing the same file with a different
  // libduckdb). Re-ingest is ~10s per 50 sessions thanks to the Appender.
  for (const ext of ['', '.wal', '.tmp']) {
    const p = dbPath + ext
    if (fs.existsSync(p)) {
      try { fs.rmSync(p, { recursive: true, force: true }); log(`[rebuild] removed ${path.basename(p)}`) }
      catch (e: any) { log(`[rebuild] could not remove ${p}: ${e.message ?? e}`) }
    }
  }

  const { con } = await openDb(dbPath)
  await initSchema(con)
  const tcCount = await loadTrackConfigs(con)
  log(`[track_configs] ${tcCount} rows`)

  if (!fs.existsSync(SESSIONS_DIR)) {
    log(`[ERROR] no sessions directory at ${SESSIONS_DIR}`)
    return { sessions: 0, samples: 0 }
  }
  const targets = fs.readdirSync(SESSIONS_DIR)
    .map(n => path.join(SESSIONS_DIR, n))
    .filter(p => fs.statSync(p).isDirectory())
    .sort()

  let totalSamples = 0
  for (let i = 0; i < targets.length; i++) {
    const d = targets[i]
    try {
      const n = await loadSession(con, d)
      totalSamples += n
      log(`[${i + 1}/${targets.length}] ${path.basename(d)}: ${n.toLocaleString()} samples`)
    } catch (e: any) {
      log(`[${i + 1}/${targets.length}] ${path.basename(d)}: FAILED ${e.message ?? e}`)
    }
  }
  return { sessions: targets.length, samples: totalSamples }
}
