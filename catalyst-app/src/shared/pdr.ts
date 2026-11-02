// Corvette Performance Data Recorder (PDR) videos and the car data decoded
// from them. Shared by the backend (decoding, storage) and the renderer
// (labels, charts).
//
// A PDR MP4 carries a data track (handler "Cougar PDR 2.0", sample format
// "marl") of 16-byte records: 0xE000, a channel number, a signed 32-bit
// value and a 64-bit timestamp in 100 ns ticks on the video's own timeline.
// The data track's sample description also carries the PDR's own table of
// every channel (number, name, unit, logging period, and the scale and offset
// to SI units): the table Cosworth Toolbox reads. Each video is decoded with
// its own table; videos stored before it was read use the C8's, below.

/** One channel as the PDR describes it in the video's data track. */
export interface PdrChannelDef {
  id: number          // the channel number in each record
  name: string        // the PDR's name, e.g. "LF Tyre Pressure"
  unit: string        // the unit the PDR displays it in
  quantity: number    // the PDR's quantity code (4 temperature, 9 pressure…)
  periodS: number     // logging period
  // SI value (m/s, K, Pa, rad, m/s², a 0–1 ratio…) = raw × scale + offset.
  scale: number
  offset: number
}

/** A channel the app uses: its key, label, and unit once decoded. */
export interface PdrChannelInfo {
  key: string
  label: string
  unit: string
  // SI value → value in `unit`.
  fromSi: (si: number) => number
  // Slow or stepped channels: hold the last value rather than interpolate.
  // (The PDR logs every channel when it changes, plus a 2 s heartbeat.)
  hold?: boolean
  // Raw values that mean "no reading", such as a tyre sensor not yet heard.
  missing?: (raw: number) => boolean
}

const same = (v: number) => v
const percent = (ratio: number) => Math.min(100, ratio * 100)
const celsius = (kelvin: number) => kelvin - 273.15
const kpa = (pa: number) => pa / 1000
const kmh = (mps: number) => mps * 3.6
const degrees = (rad: number) => rad * 180 / Math.PI
const rpm = (radPerS: number) => radPerS * 30 / Math.PI
const gs = (mps2: number) => mps2 / 9.80665
// One-byte readings: 255 is the car's "unknown"; a tyre at 0 kPa is a sensor not yet heard.
const unknownByte = (raw: number) => raw >= 255
const unknownPressure = (raw: number) => raw <= 0 || raw >= 255

const wheel = (corner: string): PdrChannelInfo => ({ key: `wheel${corner}`, label: `Wheel speed ${corner}`, unit: 'km/h', fromSi: kmh })
const tyrePressure = (corner: string): PdrChannelInfo =>
  ({ key: `tyrePressure${corner}`, label: `Tyre pressure ${corner}`, unit: 'kPa', fromSi: kpa, hold: true, missing: unknownPressure })
const tyreTemp = (corner: string): PdrChannelInfo =>
  ({ key: `tyreTemp${corner}`, label: `Tyre temperature ${corner}`, unit: '°C', fromSi: celsius, hold: true, missing: unknownByte })
const fluidTemp = (key: string, label: string): PdrChannelInfo => ({ key, label, unit: '°C', fromSi: celsius, hold: true, missing: unknownByte })

/** The channels the app decodes, by the PDR's name for them. Others stay raw. */
export const PDR_CHANNELS: Record<string, PdrChannelInfo> = {
  'RPM': { key: 'rpm', label: 'Engine speed', unit: 'rpm', fromSi: rpm },
  'Accelerator': { key: 'throttle', label: 'Throttle', unit: '%', fromSi: percent, hold: true },
  // Pedal position, not line pressure.
  'Brake Pos': { key: 'brake', label: 'Brake', unit: '%', fromSi: percent, hold: true },
  'Gear': { key: 'gear', label: 'Gear', unit: '', fromSi: same, hold: true },
  // Steering wheel angle; positive = turning right.
  'Steering Angle': { key: 'steering', label: 'Steering', unit: '°', fromSi: degrees },
  'Distance': { key: 'odometer', label: 'Odometer', unit: 'km', fromSi: m => m / 1000 },
  'Speed': { key: 'speed', label: 'Vehicle speed', unit: 'km/h', fromSi: kmh },
  // Lateral positive = turning right (Garmin's convention; the PDR's is the
  // opposite), longitudinal positive = accelerating.
  'Lateral Acceleration': { key: 'latG', label: 'Lateral G', unit: 'g', fromSi: v => -gs(v) },
  'Longitudinal Acceleration': { key: 'longG', label: 'Longitudinal G', unit: 'g', fromSi: gs },
  'Latitude': { key: 'lat', label: 'Latitude', unit: '°', fromSi: degrees },
  'Longitude': { key: 'lon', label: 'Longitude', unit: '°', fromSi: degrees },
  'Altitude': { key: 'altitude', label: 'Altitude', unit: 'm', fromSi: same },
  'Heading': { key: 'heading', label: 'GPS heading', unit: '°', fromSi: degrees },
  'Number of Satellites': { key: 'satellites', label: 'Satellites', unit: '', fromSi: same, hold: true },
  // The PDR's own lap counter at its start/finish line.
  'Beacon': { key: 'lap', label: 'PDR lap', unit: '', fromSi: same, hold: true },
  'Recording Event Odometer': { key: 'tripM', label: 'Trip distance', unit: 'm', fromSi: same },
  'Wheel Speed Left Front': wheel('FL'),
  'Wheel Speed Right Front': wheel('FR'),
  'Wheel Speed Left Rear': wheel('RL'),
  'Wheel Speed Right Rear': wheel('RR'),
  // The TPMS sensors: pressure and the air temperature inside each tyre.
  'LF Tyre Pressure': tyrePressure('FL'),
  'RF Tyre Pressure': tyrePressure('FR'),
  'LR Tyre Pressure': tyrePressure('RL'),
  'RR Tyre Pressure': tyrePressure('RR'),
  'LF Tyre Temp': tyreTemp('FL'),
  'RF Tyre Temp': tyreTemp('FR'),
  'LR Tyre Temp': tyreTemp('RL'),
  'RR Tyre Temp': tyreTemp('RR'),
  'Coolant Temp': fluidTemp('coolant', 'Coolant'),
  'Oil Temp': fluidTemp('oilTemp', 'Engine oil'),
  'Trans Oil Temp': fluidTemp('transTemp', 'Transmission oil'),
  'Intake Air Temperature': fluidTemp('intakeAir', 'Intake air'),
  'Outside Air Temperature': fluidTemp('outsideAir', 'Outside air'),
  'Oil Pressure': { key: 'oilPressure', label: 'Oil pressure', unit: 'kPa', fromSi: kpa, hold: true },
  'Fuel Level': { key: 'fuel', label: 'Fuel', unit: '%', fromSi: percent, hold: true },
  'Battery Voltage': { key: 'battery', label: 'Battery', unit: 'V', fromSi: same, hold: true },
  'ABS Active': { key: 'abs', label: 'ABS', unit: '', fromSi: same, hold: true },
  'Traction Control Active': { key: 'tractionControl', label: 'Traction control', unit: '', fromSi: same, hold: true },
  'Vehicle Stability Active': { key: 'stability', label: 'Stability control', unit: '', fromSi: same, hold: true },
}

// The table in a 2021 C8 Z51's PDR (software 85004973AG v21.2.6), for the
// channels above: [id, name, unit, quantity, period s, scale, offset].
const C8_TABLE: Array<[number, string, string, number, number, number, number]> = [
  [0x02, 'Coolant Temp', '°C', 4, 1, 1, 233.15],
  [0x04, 'Oil Pressure', 'kPa', 9, 0.5, 4000, 0],
  [0x05, 'Oil Temp', '°C', 4, 1, 1, 233.15],
  [0x06, 'RPM', 'rpm', 8, 0.01, Math.PI / 120, 0],
  [0x07, 'Accelerator', '%', 16, 0.02, 0.00392157, 0],
  [0x09, 'Brake Pos', '%', 16, 0.01, 0.00392157, 0],
  [0x0a, 'LF Tyre Pressure', 'kPa', 9, 1, 4000, 0],
  [0x0b, 'RF Tyre Pressure', 'kPa', 9, 1, 4000, 0],
  [0x0c, 'LR Tyre Pressure', 'kPa', 9, 1, 4000, 0],
  [0x0d, 'RR Tyre Pressure', 'kPa', 9, 1, 4000, 0],
  [0x12, 'LF Tyre Temp', '°C', 4, 1, 1, 253.15],
  [0x13, 'RF Tyre Temp', '°C', 4, 1, 1, 253.15],
  [0x14, 'LR Tyre Temp', '°C', 4, 1, 1, 253.15],
  [0x15, 'RR Tyre Temp', '°C', 4, 1, 1, 253.15],
  [0x16, 'Gear', '', 0, 0.25, 1, 0],
  [0x17, 'Trans Oil Temp', '°C', 4, 1, 1, 233.15],
  [0x18, 'Fuel Level', '%', 16, 1, 0.00392157, 0],
  [0x1a, 'Steering Angle', '°', 7, 0.01, Math.PI / 2880, -2048 * Math.PI / 180],
  [0x1b, 'Distance', 'km', 1, 1, 15.625, 0],
  [0x1c, 'Speed', 'kph', 3, 0.1, 1 / 230.4, 0],
  [0x1d, 'ABS Active', '', 0, 0.5, 1, 0],
  [0x1e, 'Traction Control Active', '', 0, 1, 1, 0],
  [0x1f, 'Vehicle Stability Active', '', 0, 1, 1, 0],
  [0x22, 'Battery Voltage', 'V', 11, 1, 0.1, 3],
  [0x23, 'Lateral Acceleration', 'G', 10, 0.05, 0.002960205, 0],
  [0x24, 'Longitudinal Acceleration', 'G', 10, 0.05, 0.002960205, 0],
  [0x26, 'Latitude', '°', 7, 0.1, Math.PI / 180 / 1e7, 0],
  [0x27, 'Longitude', '°', 7, 0.1, Math.PI / 180 / 1e7, 0],
  [0x28, 'Altitude', 'm', 1, 0.1, 0.01, 0],
  [0x29, 'Heading', '°', 7, 0.1, Math.PI / 180 / 100, 0],
  [0x2c, 'Number of Satellites', '', 0, 0.1, 1, 0],
  [0x2d, 'Beacon', '', 0, 0, 1, 0],
  [0x3a, 'Recording Event Odometer', 'km', 1, 1, 0.976573, 0],
  [0x3b, 'Wheel Speed Left Front', 'kph', 3, 0.01, 1 / 115.2, 0],
  [0x3c, 'Wheel Speed Right Front', 'kph', 3, 0.01, 1 / 115.2, 0],
  [0x3d, 'Wheel Speed Left Rear', 'kph', 3, 0.01, 1 / 115.2, 0],
  [0x3e, 'Wheel Speed Right Rear', 'kph', 3, 0.01, 1 / 115.2, 0],
  [0x3f, 'Outside Air Temperature', '°C', 4, 0.25, 0.5, 233.15],
  [0x40, 'Intake Air Temperature', '°C', 4, 1, 1, 233.15],
]
export const C8_CHANNELS: PdrChannelDef[] = C8_TABLE.map(([id, name, unit, quantity, periodS, scale, offset]) => ({ id, name, unit, quantity, periodS, scale, offset }))

export interface PdrDecoder { key: string; hold: boolean; value: (raw: number) => number | null }

/** How to read each channel number of a video, from its table (else the C8's). */
export function pdrDecoders(table: PdrChannelDef[]): Map<number, PdrDecoder> {
  const out = new Map<number, PdrDecoder>()
  for (const def of table.length ? table : C8_CHANNELS) {
    const info = PDR_CHANNELS[def.name]
    if (!info || out.has(def.id)) continue
    out.set(def.id, {
      key: info.key, hold: !!info.hold,
      value: raw => (info.missing?.(raw) ? null : info.fromSi(raw * def.scale + def.offset)),
    })
  }
  return out
}

export const TYRE_CORNERS = ['FL', 'FR', 'RL', 'RR'] as const

// Tyre and fluid channels on each lap's samples, for the distance charts.
export const SENSOR_KEYS = [
  'tyrePressureFL', 'tyrePressureFR', 'tyrePressureRL', 'tyrePressureRR',
  'tyreTempFL', 'tyreTempFR', 'tyreTempRL', 'tyreTempRR',
  'oilTemp', 'coolant', 'transTemp', 'oilPressure',
] as const
export type SensorKey = typeof SENSOR_KEYS[number]

// Slow channels summarised per lap (first, last, lowest, highest).
export const LAP_STAT_KEYS = [
  ...TYRE_CORNERS.map(c => `tyrePressure${c}`), ...TYRE_CORNERS.map(c => `tyreTemp${c}`),
  'oilTemp', 'coolant', 'transTemp', 'oilPressure', 'intakeAir', 'outsideAir', 'fuel', 'battery',
]

/** A PDR video on your account, attached to one of your sessions or not yet. */
export interface SessionVideo {
  id: string
  // Null until the video is matched to a session.
  sessionGuid: string | null
  // The attached session, for lists.
  session: { start: string | null; track: string | null; layout: string | null } | null
  // Why an unattached video found no session (or the last match attempt).
  matchNote: string | null
  fileName: string
  sizeBytes: number
  durationS: number
  // The PDR's clock at the first frame, as recorded (local track time).
  recordedAt: string | null
  device: string | null
  width: number | null
  height: number | null
  // Session time = video time + offsetS (seconds; session time counts from
  // the Garmin session start).
  offsetS: number | null
  // How offsetS was found: matching the PDR's GPS track or speed against
  // the Garmin laps, the Catalyst's own clock, or set by hand.
  alignment: 'position' | 'speed' | 'clock' | 'manual' | null
  // Typical distance between the two GPS tracks (m) or 1 − speed correlation.
  alignmentError: number | null
  // Your laps the video covers, by lap index.
  laps: number[]
  channels: string[]
  recordCount: number
  createdAt: string | null
  // Where it came from: a Corvette PDR video, or a Garmin Catalyst session
  // video or optimal-lap render (see shared/catalystVideo.ts).
  source: VideoSource
  // Catalyst videos: DRIVER/Track/Car/YYYYMMDD/HHMMSS/file on the device.
  sourcePath: string | null
}

export type VideoSource = 'pdr' | 'catalyst' | 'catalyst-optimal'

/** What happened to one imported video. */
export interface VideoImportResult {
  video: SessionVideo
  matched: boolean
  message: string
}

/** Car data for one lap on the 5 m grid Analysis draws. */
export interface CarTrace {
  sg: string
  lapIdx: number
  videoId: string
  // A compared driver's lap: their name (the video streams from their
  // workspace) and their position in the comparison (1+).
  driver?: string
  driverIndex?: number
  // Their lap's label ("Sep 22 08:30 · L1") and time, for the player.
  label?: string
  durationMs?: number
  dist: number[]
  // Video time at each distance, for syncing the player to the charts.
  videoT: Array<number | null>
  throttle: Array<number | null>
  brake: Array<number | null>
  rpm: Array<number | null>
  gear: Array<number | null>
  steering: Array<number | null>
  // Rear-wheel slip against the front wheels, % (positive = rears faster:
  // wheelspin; negative = rears slower: locking or engine braking).
  slip: Array<number | null>
  speed: Array<number | null>   // display unit, from the car's speedometer
  // Tyre pressures and temperatures, fluid temperatures and oil pressure in
  // CarData's units; only the channels the video logged.
  sensors?: Partial<Record<SensorKey, Array<number | null>>>
}

export interface CarDataVideo {
  id: string
  sg: string
  fileName: string
  durationS: number
  recordedAt: string | null
}

/** A slow channel over one lap, in its display unit. */
export interface LapStat { first: number; last: number; min: number; max: number }

/** Tyre pressures and temperatures, fluids and electrics on one lap (your laps only). */
export interface CarLapStats {
  sg: string
  lapIdx: number
  // By LAP_STAT_KEYS key; a channel the video did not log is absent.
  values: Record<string, LapStat>
}

export interface CarData {
  videos: CarDataVideo[]
  traces: CarTrace[]
  speedUnit: string
  lapStats: CarLapStats[]
  // Display units of lapStats: temperatures, and pressures (tyres, oil).
  tempUnit: string
  pressureUnit: string
}

/** Session Review's video panel: the session's videos and car data. */
export interface SessionCarData extends CarData {
  sessionGuid: string
  attached: SessionVideo[]
  laps: Array<{ lapIdx: number; durationMs: number; label: string; isBest: boolean }>
  corners: Array<{ turn: string; name: string; apexM: number; startM: number; endM: number }>
  // Garmin's segments end to end (S1, S2…): where the stitched optimal lap cuts.
  splits: Array<{ id: string; startM: number; endM: number }>
}

export const VIDEO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MAX_VIDEO_BYTES = 16 * 1024 ** 3
// Each upload request stays well under Cloudflare's 100 MB body limit.
export const VIDEO_UPLOAD_CHUNK = 32 * 1024 ** 2
