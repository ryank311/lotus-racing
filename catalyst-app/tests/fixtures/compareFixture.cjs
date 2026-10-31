// Synthetic telemetry for driver-comparison tests: a 1 km lap with one
// hairpin (T1, apex 500 m) split into two segments. `scale` multiplies every
// speed, so a larger scale is a uniformly faster lap.
//
// Also runnable as a script to seed a workspace database in its own process
// (DuckDB keeps a file lock until the process exits):
//   node compareFixture.cjs <dbPath> '<json sessions>'

const TOTAL_M = 1000
const LAYOUT = { track: 'Test Raceway', config: 'Full Course', meanLine: 'test-line', configId: 41 }

const TRACK_YAML = `track_name: ${LAYOUT.track}
track_configuration_name: ${LAYOUT.config}
mean_line_guid: ${LAYOUT.meanLine}
total_dist_m: ${TOTAL_M}
segments:
  - id: 1
    start_dist_m: 0
    end_dist_m: 500
  - id: 2
    start_dist_m: 500
    end_dist_m: ${TOTAL_M}
corners:
  - turn: T1
    name: "Hairpin"
    direction: left
    apex_idx: 500
    dist_idx_start: 470
    dist_idx_end: 530
`

function speedAt(d, scale) {
  const base = d < 400 ? 40 : d < 500 ? 40 - (d - 400) / 100 * 20 : d < 700 ? 20 + (d - 500) / 200 * 20 : 40
  return base * scale
}

function lapRows(scale) {
  const v = Array.from({ length: TOTAL_M + 1 }, (_, d) => speedAt(d, scale))
  const rows = []
  let t = 0
  for (let d = 0; d <= TOTAL_M; d++) {
    if (d > 0) t += 1000 * 2 / (v[d] + v[d - 1])
    const dvdd = (v[Math.min(TOTAL_M, d + 1)] - v[Math.max(0, d - 1)]) / (d === 0 || d === TOTAL_M ? 1 : 2)
    rows.push({
      d, t: Math.round(t), v: v[d], ax: v[d] * dvdd,
      ay: d >= 460 && d <= 560 ? v[d] ** 2 / 60 : 0,
      lat: 37 + d * 1e-5, lon: -79, lateral: 0.5,
    })
  }
  return { rows, durationMs: Math.round(t) }
}

// sessions: [{ sg, start, vehicle, meanLine?, configId?, config?, detailsLoaded?, laps: [scale, ...] }]
async function seed(con, sessions) {
  for (const s of sessions) {
    await con.run(`INSERT INTO sessions (session_guid, session_start, track_name, track_configuration_name,
      track_configuration_id, mean_line_guid, vehicle_guid, vehicle_make, vehicle_model, account, details_loaded, best_lap_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'LOTUS', 'EXIGE', 'driver', ?, ?)`, [
      s.sg, s.start, LAYOUT.track, s.config ?? LAYOUT.config, s.configId ?? LAYOUT.configId,
      s.meanLine ?? LAYOUT.meanLine, s.vehicle ?? 'car', s.detailsLoaded ?? true,
      Math.min(...s.laps.map(scale => lapRows(scale).durationMs)),
    ])
    for (const [index, scale] of s.laps.entries()) {
      const { rows, durationMs } = lapRows(scale)
      await con.run("INSERT INTO laps (session_guid, lap_index, lap_type, duration_ms, lap_descriptor, sample_count) VALUES (?, ?, 'DRIVEN', ?, 0, ?)",
        [s.sg, index, durationMs, rows.length])
      const values = rows.map(r => `('${s.sg}', ${index}, ${r.d}, ${r.t}, ${r.lat}, ${r.lon}, ${r.v}, ${r.ax}, ${r.ay}, ${r.lateral})`).join(',')
      await con.run(`INSERT INTO samples (session_guid, lap_index, distance_m, time_ms, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2, lateral_position) VALUES ${values}`)
    }
  }
}

module.exports = { TOTAL_M, LAYOUT, TRACK_YAML, lapRows, seed }

if (require.main === module) {
  const [dbPath, spec] = process.argv.slice(2)
  const { initSchema, withDb } = require('../../dist-main/garmin/loadToDb.js')
  require('node:fs').mkdirSync(require('node:path').dirname(dbPath), { recursive: true })
  withDb(async con => { await initSchema(con); await seed(con, JSON.parse(spec)) }, dbPath)
    .then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
