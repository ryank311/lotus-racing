// Synthetic Corvette PDR videos for tests: telemetry records for a car
// driving the compare fixture's laps, in an MP4 laid out like the PDR's
// (a stub video track and a "Cougar PDR 2.0" data track of 16-byte records).

const fs = require('node:fs')
const { lapRows } = require('./compareFixture.cjs')

// One record: 0xE000, channel, int32 value, 64-bit time in 100 ns ticks.
function record(channel, value, timeS) {
  const b = Buffer.alloc(16)
  const ticks = Math.round(timeS * 1e7)
  b.writeUInt16BE(0xe000, 0); b.writeUInt16BE(channel, 2); b.writeInt32BE(Math.round(value), 4)
  b.writeUInt32BE(Math.floor(ticks / 2 ** 32), 8); b.writeUInt32BE(ticks % 2 ** 32, 12)
  return b
}

// Where the car is at a session time (s): on one of the laps (scales, run
// back to back from 30 s like compareFixture's seed), or parked before/after.
function carAt(laps, sessionS) {
  let start = 30
  for (const lap of laps) {
    const end = start + lap.durationMs / 1000
    if (sessionS >= start && sessionS <= end) {
      const ms = (sessionS - start) * 1000
      const rows = lap.rows
      let i = rows.findIndex(r => r.t >= ms)
      if (i <= 0) i = 1
      const a = rows[i - 1], b = rows[i]
      const f = b.t === a.t ? 0 : (ms - a.t) / (b.t - a.t)
      const mix = k => a[k] + (b[k] - a[k]) * f
      return { moving: true, d: mix('d'), v: mix('v'), ax: mix('ax'), ay: mix('ay'), lat: mix('lat'), lon: mix('lon') }
    }
    start = end
  }
  return { moving: false, d: 0, v: 0, ax: 0, ay: 0, lat: 37, lon: -79 }
}

/**
 * Records for a video whose first frame is at session time `startS`.
 * `scales` are the session's laps (as passed to compareFixture's seed).
 */
function drivingRecords(scales, startS, durationS, { moving = true } = {}) {
  const laps = scales.map(scale => lapRows(scale))
  const out = []
  for (let k = 0; k * 0.1 <= durationS; k++) {
    const t = k * 0.1
    const car = moving ? carAt(laps, startS + t) : carAt([], 0)
    const kmh = car.v * 3.6
    const throttle = car.ax > 0.2 ? 255 * Math.min(1, car.ax / 3) : car.ax > -0.2 ? 60 : 0
    const brake = car.ax < -0.5 ? Math.min(140, -car.ax * 15) : 0
    const gear = kmh < 1 ? 1 : kmh < 80 ? 2 : 3
    out.push(record(0x26, car.lat * 1e7, t), record(0x27, car.lon * 1e7, t))
    out.push(record(0x06, (900 + kmh * 40) * 4, t), record(0x07, throttle, t), record(0x09, brake, t))
    out.push(record(0x1a, 0x8000 + car.ay * 16 * 8, t))
    for (const ch of [0x3b, 0x3c, 0x3d, 0x3e]) out.push(record(ch, kmh * 32 * (ch >= 0x3d ? 1.01 : 1), t))
    if (k % 2 === 0) out.push(record(0x1c, kmh * 64, t), record(0x16, gear, t))
  }
  return out
}

function box(type, ...parts) {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0); head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
const u32 = (...values) => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b }
const full = (type, version, ...parts) => box(type, u32(version << 24), ...parts)

function tkhd(width, height) {
  const b = Buffer.alloc(80)
  b.writeUInt32BE(width * 65536, 72); b.writeUInt32BE(height * 65536, 76)
  return full('tkhd', 0, b)
}
const mdhd = (scale, duration) => full('mdhd', 0, u32(0, 0, scale, duration, 0))
const hdlr = (type, name) => full('hdlr', 0, u32(0), Buffer.from(type, 'latin1'), Buffer.alloc(12), Buffer.from(`${name}\0`, 'utf8'))
const stsd = format => full('stsd', 0, u32(1), box(format, Buffer.alloc(8)))

function track({ width = 0, height = 0, scale, duration, handler, name, format, sizes = [], offsets = [] }) {
  const stbl = box('stbl',
    stsd(format),
    full('stts', 0, u32(0)),
    full('stsc', 0, ...(sizes.length ? [u32(1, 1, 1, 1)] : [u32(0)])),
    full('stsz', 0, u32(0, sizes.length, ...sizes)),
    full('stco', 0, u32(offsets.length, ...offsets)),
  )
  return box('trak', tkhd(width, height), box('mdia', mdhd(scale, duration), hdlr(handler, name), box('minf', stbl)))
}

// "YYYY-MM-DD HH:MM:SS" → seconds since 1904, as written by the PDR.
const mp4Seconds = clock => Math.round(Date.parse(`${clock.replace(' ', 'T')}Z`) / 1000 + 2082844800)

/** Write a PDR-like MP4 holding `records`, ~2 s of records per sample. */
function writePdrVideo(file, records, { durationS, recordedAt }) {
  const samples = []
  for (let i = 0; i < records.length; i += 200) samples.push(Buffer.concat(records.slice(i, i + 200)))
  const ftyp = box('ftyp', Buffer.from('mp42', 'latin1'), u32(0), Buffer.from('mp42isom', 'latin1'))
  const moov = offsets => box('moov',
    full('mvhd', 0, u32(mp4Seconds(recordedAt), mp4Seconds(recordedAt), 1000, Math.round(durationS * 1000)), Buffer.alloc(80)),
    track({ width: 1920, height: 1080, scale: 3000, duration: Math.round(durationS * 3000), handler: 'vide', name: 'VideoHandler', format: 'avc1' }),
    track({ scale: 1000, duration: Math.round(durationS * 1000), handler: 'meta', name: 'Cougar PDR 2.0', format: 'marl', sizes: samples.map(s => s.length), offsets }),
  )
  const head = ftyp.length + moov(samples.map(() => 0)).length + 8
  const offsets = []
  let at = head
  for (const s of samples) { offsets.push(at); at += s.length }
  fs.writeFileSync(file, Buffer.concat([ftyp, moov(offsets), box('mdat', ...samples)]))
}

module.exports = { record, drivingRecords, writePdrVideo }
