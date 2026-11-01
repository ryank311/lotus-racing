// Corvette Performance Data Recorder (PDR) videos and the car data decoded
// from them. Shared by the backend (decoding, storage) and the renderer
// (labels, charts).
//
// A PDR MP4 carries a data track (handler "Cougar PDR 2.0", sample format
// "marl") of 16-byte records: 0xE000, a channel number, a signed 32-bit
// value and a 64-bit timestamp in 100 ns ticks on the video's own timeline.
// The channel meanings and scales below were identified against GPS and
// lap timing on a 2021 C8 Z51 at VIR; channels not listed are stored raw.

export interface PdrChannelInfo {
  key: string
  label: string
  unit: string
  // Raw record value → value in `unit`.
  scale: (raw: number) => number
  // Logged when the value changes (plus a 2 s heartbeat): hold the last
  // value rather than interpolate.
  hold?: boolean
}

export const PDR_CHANNELS: Record<number, PdrChannelInfo> = {
  0x06: { key: 'rpm', label: 'Engine speed', unit: 'rpm', scale: v => v / 4 },
  0x07: { key: 'throttle', label: 'Throttle', unit: '%', scale: v => Math.min(100, v / 2.55), hold: true },
  // Linear in deceleration (≈1.1 g at 141 on the C8); the unit is inferred.
  0x09: { key: 'brake', label: 'Brake pressure', unit: 'bar', scale: v => v, hold: true },
  0x16: { key: 'gear', label: 'Gear', unit: '', scale: v => v, hold: true },
  // Steering wheel angle, 1/16°, centred on 0x8000; positive = turning right.
  0x1a: { key: 'steering', label: 'Steering', unit: '°', scale: v => (v - 0x8000) / 16 },
  0x1b: { key: 'odometer', label: 'Odometer', unit: 'km', scale: v => v / 64 },
  0x1c: { key: 'speed', label: 'Vehicle speed', unit: 'km/h', scale: v => v / 64 },
  // Accelerations, calibrated against GPS; lateral positive = turning right
  // (Garmin's convention), longitudinal positive = accelerating.
  0x23: { key: 'latG', label: 'Lateral G', unit: 'g', scale: v => -v / 3470 },
  0x24: { key: 'longG', label: 'Longitudinal G', unit: 'g', scale: v => v / 3570 },
  0x26: { key: 'lat', label: 'Latitude', unit: '°', scale: v => v / 1e7 },
  0x27: { key: 'lon', label: 'Longitude', unit: '°', scale: v => v / 1e7 },
  0x28: { key: 'altitude', label: 'Altitude', unit: 'm', scale: v => v / 100 },
  0x29: { key: 'heading', label: 'GPS heading', unit: '°', scale: v => v / 100 },
  0x2c: { key: 'satellites', label: 'Satellites', unit: '', scale: v => v, hold: true },
  // Lap counter from the PDR's own start/finish line, once per lap.
  0x2d: { key: 'lap', label: 'PDR lap', unit: '', scale: v => v, hold: true },
  0x3a: { key: 'tripM', label: 'Trip distance', unit: 'm', scale: v => v },
  0x3b: { key: 'wheelFL', label: 'Wheel speed FL', unit: 'km/h', scale: v => v / 32 },
  0x3c: { key: 'wheelFR', label: 'Wheel speed FR', unit: 'km/h', scale: v => v / 32 },
  0x3d: { key: 'wheelRL', label: 'Wheel speed RL', unit: 'km/h', scale: v => v / 32 },
  0x3e: { key: 'wheelRR', label: 'Wheel speed RR', unit: 'km/h', scale: v => v / 32 },
}

export const PDR_CHANNEL_IDS: Record<string, number> = Object.fromEntries(
  Object.entries(PDR_CHANNELS).map(([id, info]) => [info.key, Number(id)]),
)

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
}

export interface CarDataVideo {
  id: string
  sg: string
  fileName: string
  durationS: number
  recordedAt: string | null
}

export interface CarData {
  videos: CarDataVideo[]
  traces: CarTrace[]
  speedUnit: string
}

/** Session Review's video panel: the session's videos and car data. */
export interface SessionCarData extends CarData {
  sessionGuid: string
  attached: SessionVideo[]
  laps: Array<{ lapIdx: number; durationMs: number; label: string; isBest: boolean }>
  corners: Array<{ turn: string; name: string; apexM: number; startM: number; endM: number }>
}

export const VIDEO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MAX_VIDEO_BYTES = 16 * 1024 ** 3
// Each upload request stays well under Cloudflare's 100 MB body limit.
export const VIDEO_UPLOAD_CHUNK = 32 * 1024 ** 2
