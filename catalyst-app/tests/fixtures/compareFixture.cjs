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

// Another Catalyst device's mean line for the same course: every device
// builds its own, so its ID and length differ. This one is 10 m longer, all
// of it before T1 (a wider line in), and runs 2.7 m east of yours. `toCourse`
// gives the spot on your line for one of its metres.
const OTHER_LINE = { meanLine: 'other-line', totalM: 1010, lonOffset: 3e-5,
  toCourse: t => (t <= 510 ? t * 500 / 510 : 500 + (t - 510)) }

const latAt = d => 37 + d * 1e-5

// A mean line .pb as Catalyst sends it: one point per metre (field 8: fixed32
// distance, then a position of fixed64 lat/lon).
function meanLinePb(points) {
  const varint = n => { const out = []; while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 } out.push(n); return Buffer.from(out) }
  const field = (no, bytes) => Buffer.concat([varint((no << 3) | 2), varint(bytes.length), bytes])
  const f32 = (no, v) => { const b = Buffer.alloc(5); b[0] = (no << 3) | 5; b.writeFloatLE(v, 1); return b }
  const f64 = (no, v) => { const b = Buffer.alloc(9); b[0] = (no << 3) | 1; b.writeDoubleLE(v, 1); return b }
  return Buffer.concat(points.map(p => field(8, Buffer.concat([f32(1, p.dist), field(2, Buffer.concat([f64(1, p.lat), f64(2, p.lon)]))]))))
}

function writeMeanLines(dir) {
  require('node:fs').mkdirSync(dir, { recursive: true })
  const path = require('node:path')
  const own = Array.from({ length: TOTAL_M + 1 }, (_, d) => ({ dist: d, lat: latAt(d), lon: -79 }))
  const other = Array.from({ length: OTHER_LINE.totalM + 1 }, (_, t) => ({ dist: t, lat: latAt(OTHER_LINE.toCourse(t)), lon: -79 + OTHER_LINE.lonOffset }))
  require('node:fs').writeFileSync(path.join(dir, `${LAYOUT.meanLine}.pb`), meanLinePb(own))
  require('node:fs').writeFileSync(path.join(dir, `${OTHER_LINE.meanLine}.pb`), meanLinePb(other))
}

function speedAt(d, scale) {
  const base = d < 400 ? 40 : d < 500 ? 40 - (d - 400) / 100 * 20 : d < 700 ? 20 + (d - 500) / 200 * 20 : 40
  return base * scale
}

// One lap's samples. On another mean line (`line`), distances are that
// line's metres while speed, timing and position follow the course.
function lapRows(scale, line = null) {
  const total = line ? line.totalM : TOTAL_M
  const course = line ? line.toCourse : d => d
  const at = Array.from({ length: total + 1 }, (_, d) => course(d))
  const v = at.map(c => speedAt(c, scale))
  const rows = []
  let t = 0
  for (let d = 0; d <= total; d++) {
    if (d > 0) t += 1000 * (at[d] - at[d - 1]) * 2 / (v[d] + v[d - 1])
    const lo = Math.max(0, d - 1), hi = Math.min(total, d + 1)
    const dvdd = (v[hi] - v[lo]) / (at[hi] - at[lo])
    rows.push({
      d, t: Math.round(t), v: v[d], ax: v[d] * dvdd,
      ay: at[d] >= 460 && at[d] <= 560 ? v[d] ** 2 / 60 : 0,
      lat: latAt(at[d]), lon: -79 + (line?.lonOffset ?? 0), lateral: 0.5,
    })
  }
  return { rows, durationMs: Math.round(t) }
}

// sessions: [{ sg, start, vehicle, meanLine?, configId?, config?, detailsLoaded?, laps: [scale, ...] }]
// A session on OTHER_LINE's mean line gets laps measured along it.
async function seed(con, sessions) {
  for (const s of sessions) {
    const line = s.meanLine === OTHER_LINE.meanLine ? OTHER_LINE : null
    await con.run(`INSERT INTO sessions (session_guid, session_start, track_name, track_configuration_name,
      track_configuration_id, mean_line_guid, vehicle_guid, vehicle_make, vehicle_model, account, details_loaded, best_lap_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'LOTUS', 'EXIGE', 'driver', ?, ?)`, [
      s.sg, s.start, LAYOUT.track, s.config ?? LAYOUT.config, s.configId ?? LAYOUT.configId,
      s.meanLine ?? LAYOUT.meanLine, s.vehicle ?? 'car', s.detailsLoaded ?? true,
      Math.min(...s.laps.map(scale => lapRows(scale, line).durationMs)),
    ])
    for (const [index, scale] of s.laps.entries()) {
      const { rows, durationMs } = lapRows(scale, line)
      await con.run("INSERT INTO laps (session_guid, lap_index, lap_type, duration_ms, lap_descriptor, sample_count) VALUES (?, ?, 'DRIVEN', ?, 0, ?)",
        [s.sg, index, durationMs, rows.length])
      const values = rows.map(r => `('${s.sg}', ${index}, ${r.d}, ${r.t}, ${r.lat}, ${r.lon}, ${r.v}, ${r.ax}, ${r.ay}, ${r.lateral})`).join(',')
      await con.run(`INSERT INTO samples (session_guid, lap_index, distance_m, time_ms, lat, lon, gnss_speed_mps, accel_x_mps2, accel_y_mps2, lateral_position) VALUES ${values}`)
    }
  }
}

module.exports = { TOTAL_M, LAYOUT, OTHER_LINE, TRACK_YAML, lapRows, seed, speedAt, writeMeanLines }

if (require.main === module) {
  const [dbPath, spec] = process.argv.slice(2)
  const { initSchema, withDb } = require('../../dist-main/garmin/loadToDb.js')
  require('node:fs').mkdirSync(require('node:path').dirname(dbPath), { recursive: true })
  withDb(async con => { await initSchema(con); await seed(con, JSON.parse(spec)) }, dbPath)
    .then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
