// 3D lap replay: the data the Replay page draws, shared by the backend
// (src/garmin/replayData.ts, terrain and car-model services) and the
// renderer (src/renderer/replay/*).
//
// Geography is plain WGS84 lat/lon throughout. The terrain grid and the
// aerial image cover a GeoBox and are linear in lat/lon (requested in
// EPSG:4326), so a point's texture/grid coordinate is a linear function of
// its lat/lon, and the renderer's local metres (equirectangular around the
// track, like trackGeometry.ts projectLatLon) map onto them directly.

import type { CarTrace } from './pdr'
import type { UnitSystem } from './units'

export interface GeoBox { south: number; west: number; north: number; east: number }

export interface ReplayCorner {
  turn: string
  name: string
  apexM: number
  startM: number
  endM: number
  direction?: 'left' | 'right'
}

/** The layout of a session's track, from its Garmin mean line. */
export interface ReplayTrack {
  trackName: string | null
  configName: string | null
  meanLineGuid: string
  totalDistM: number
  /** Track width from the mean line (10.64 m at VIR). */
  widthM: number
  /** The mean line at ~1 m spacing; dist 0 is start/finish. */
  line: { dist: number[]; lat: number[]; lon: number[] }
  corners: ReplayCorner[]
  /** Where each of Garmin's primary sectors starts, metres along the line, ascending (the first is usually 0); a sector runs to the next start, the last to totalDistM. */
  sectorsM: number[]
  /** The terrain area to load: the line's bounds plus a margin (~400 m). */
  area: GeoBox
}

export interface ReplayLapRef {
  sessionGuid: string
  /** A lap index, or 'optimal' for Garmin's optimal lap of the session. */
  lap: number | 'optimal'
}

export interface ReplayLapInfo extends ReplayLapRef {
  durationMs: number
  /** "May 24 16:15 · L3", "May 24 16:15 · Optimal". */
  label: string
  /** The fastest valid lap of its session. */
  isBest: boolean
  /** A synced video covers this lap. */
  hasVideo: boolean
}

export interface ReplayVehicle {
  guid: string | null
  make: string | null
  model: string | null
  year: number | null
  /** Normalised "MAKE MODEL", e.g. "LOTUS EXIGE"; matches CarModel.matches. */
  key: string | null
}

export interface ReplayScene {
  sessionGuid: string
  sessionStart: string | null
  vehicle: ReplayVehicle
  track: ReplayTrack
  units: UnitSystem
  /** This session's valid laps, in lap order (plus 'optimal' last when Garmin has one). */
  laps: ReplayLapInfo[]
  /** Laps to race as a ghost: the driver's other sessions on the same layout, fastest first (≤ 40). */
  ghostCandidates: ReplayLapInfo[]
  /** The weather and light the session ran in (the replay's sky, sun and surface); absent from older servers. */
  conditions?: ReplayConditions
}

/** A session's conditions as Garmin recorded them, with its time on the clock and in UTC. */
export interface ReplayConditions {
  /** Garmin's weather text ("Mostly Cloudy", "Light Rain"), or null. */
  description: string | null
  temperatureC: number | null
  humidityPct: number | null
  windMps: number | null
  /** Where the wind blows from, degrees clockwise from north. */
  windFromDeg: number | null
  /** The track's surface: the driver's correction in Session Review, else read from the description. */
  surface: 'dry' | 'damp' | 'wet' | 'mixed' | 'unknown'
  /** The session's start on the track's clock, "YYYY-MM-DD HH:MM:SS", or null. */
  localStart: string | null
  /** The same instant in UTC (ISO 8601), or null without a start. */
  utcStart: string | null
  /** Local time minus UTC, minutes. */
  utcOffsetMin: number | null
  /** The offset is reckoned from the track's longitude and its region's daylight-saving rules (Garmin's own offset is not stored). */
  utcOffsetEstimated: boolean
}

/**
 * Local time minus UTC (minutes) at a place and local wall-clock time, from
 * its longitude (the nearest whole hour) and, in North America and Europe,
 * their daylight-saving rules. A fallback for when the device's own offset
 * is unknown; good to the hour where a time zone follows its meridian.
 */
export function estimateUtcOffsetMin(lat: number, lon: number, localStart: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(localStart)
  if (!m || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const [year, month, day, hour, minute] = m.slice(1).map(Number)
  const standard = Math.round(lon / 15) * 60
  // Wall-clock minutes since the epoch (as if UTC), to compare with the switch instants.
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 60000
  // The n-th (or last, n < 0) Sunday of a month, as a UTC day number × minutes.
  const sunday = (mon: number, n: number) => {
    if (n > 0) {
      const first = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay()
      return Date.UTC(year, mon - 1, 1 + ((7 - first) % 7) + 7 * (n - 1)) / 60000
    }
    const last = new Date(Date.UTC(year, mon, 0))
    return Date.UTC(year, mon - 1, last.getUTCDate() - last.getUTCDay()) / 60000
  }
  let summer = false
  if (lat > 20 && lon < -50 && lon > -170) {
    // US and Canada: 2:00 local on the second Sunday of March to 2:00 on the first Sunday of November.
    summer = wall >= sunday(3, 2) + 120 && wall < sunday(11, 1) + 120
  } else if (lat > 34 && lon > -25 && lon < 45) {
    // Europe: 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October.
    const utc = wall - standard
    summer = utc >= sunday(3, -1) + 60 && utc < sunday(10, -1) + 60
  }
  return standard + (summer ? 60 : 0)
}

/**
 * One lap, columnar: one entry per Garmin sample (~1 m apart), in time order.
 * `dist` is metres along the *scene's* mean line (a lap from another mean
 * line is remapped onto it), so laps compare by distance.
 */
export interface ReplayLap extends ReplayLapRef {
  durationMs: number
  label: string
  dist: number[]
  timeMs: number[]
  lat: number[]
  lon: number[]
  altM: Array<number | null>       // GNSS altitude
  speedMps: number[]
  accelX: Array<number | null>     // m/s², longitudinal, braking negative
  accelY: Array<number | null>     // m/s², lateral
  headingDeg: Array<number | null> // compass: 0 = north, clockwise
  /**
   * The PDR/Catalyst video and car channels for this lap, when a synced
   * video covers it (the same trace Session Review uses; its `dist` is the
   * same metres, `videoT` the video time at each). Null without video.
   */
  car: CarTrace | null
}

// ─── Terrain (USGS 3DEP elevation + USDA NAIP imagery, public domain) ──────

export interface TerrainInfo {
  /** Cache key: the area rounded outward to 0.005°; the scene's area spans every layout of the facility, so its layouts share it. */
  key: string
  /** The exact area the grid and the image cover. */
  area: GeoBox
  /**
   * Bare-earth heights in metres, row-major, first row = north edge. A vertex
   * grid: vertex (i, j) is at lon = west + i·(east − west)/(width − 1),
   * lat = north − j·(north − south)/(height − 1), so the first and last
   * vertices lie on the area's edges (stretch the mesh edge to edge).
   */
  grid: { width: number; height: number; minM: number; maxM: number }
  /**
   * Aerial image of the same area (JPEG); null when imagery was unavailable.
   * Its outer pixel edges are the area's edges: u = (lon − west)/(east − west),
   * v = (north − lat)/(north − south), as a texture spans 0…1.
   */
  imagery: { width: number; height: number } | null
  attribution: string
}

// ─── Car models (user-supplied .glb, shared by every driver) ───────────────

/**
 * How a model sits in the car frame: origin on the ground under the middle
 * of the car, +y up, +z forward (the nose), +x to the driver's LEFT (three.js
 * is right-handed: up × forward = left).
 */
export interface CarModelFit {
  /** Rotation about +y applied first, so the nose points +z. */
  yawDeg: number
  /** The model is scaled so its length (along z) is this many metres. */
  lengthM: number
  /** Nudge after centring and scaling, metres: [left, up, forward]. */
  offsetM: [number, number, number]
  /** Driver's eye in the car frame, metres: [left, up, forward]. */
  eyeM: [number, number, number]
  /**
   * The Garmin Catalyst's camera, suction-mounted at the top of the
   * windscreen, metres [left, up, forward]; its lens's horizontal field of
   * view (degrees, barrel-distorted) and its tilt down from level (degrees;
   * negative tilts up, as the Catalyst usually sits on a raked screen).
   * Absent: the vehicle preset's.
   */
  dashcamM?: [number, number, number]
  dashcamFovDeg?: number
  dashcamPitchDeg?: number
  /**
   * Wheel hints, for a model whose wheels are not found (or found wrongly)
   * by name and shape: a regular expression (any case) for the node or
   * material names of the parts that roll (tyres, rims, discs), and true to
   * keep its wheels still and its body level.
   */
  wheelPartsPattern?: string
  staticWheels?: boolean
}

export interface CarModel {
  id: string
  name: string
  fileName: string
  sizeBytes: number
  /** Credit line shown in the replay, e.g. "“2006 Lotus Exige S” by ddiaz-design (CC BY-NC-SA 4.0)". */
  attribution: string | null
  /** Vehicle keys ("LOTUS EXIGE") whose sessions use this model. */
  matches: string[]
  fit: CarModelFit
  uploadedAt: string
}

export interface CarPreset {
  name: string
  lengthM: number
  widthM: number
  heightM: number
  wheelbaseM: number
  /** Default fit for an uploaded model of this car. */
  fit: CarModelFit
  dynamics: CarDynamics
}

/** How the replay moves the car (semi-realistic): its steering and its body on the springs. */
export interface CarDynamics {
  /** Steering-wheel degrees per degree at the front wheels. */
  steeringRatio: number
  /** Body roll toward the outside of a turn, degrees per g of lateral acceleration. */
  rollDegPerG: number
  /** Nose down under braking and up under acceleration, degrees per g. */
  diveDegPerG: number
  squatDegPerG: number
  /** The body's natural frequency on its springs (Hz) and damping ratio. */
  rideHz: number
  damping: number
}

// Real dimensions; the placeholder car is drawn from these, and an uploaded
// model of the car starts from its fit. Both are US cars: left-hand drive.
// The fits suit the Sketchfab models tested: "2006 Lotus Exige S" (Ddiaz
// Design) and "2020 Chevrolet Corvette C8 Stingray 3LT Z51" (Galaxy Car
// Showroom), which is modelled facing backwards. The Exige's Garmin camera
// matches a Catalyst video from the car (VIR front straight: horizon 58% down,
// the clam's humps 21% up from the bottom).
export const CAR_PRESETS: Record<string, CarPreset> = {
  'LOTUS EXIGE': {
    name: 'Lotus Exige S (S2)', lengthM: 3.80, widthM: 1.73, heightM: 1.16, wheelbaseM: 2.30,
    fit: { yawDeg: 0, lengthM: 3.80, offsetM: [0, 0, 0], eyeM: [0.31, 0.86, -0.36], dashcamM: [0, 1.06, 0.21], dashcamFovDeg: 120, dashcamPitchDeg: -6.5 },
    dynamics: { steeringRatio: 14, rollDegPerG: 1.0, diveDegPerG: 0.8, squatDegPerG: 0.5, rideHz: 1.9, damping: 0.65 },
  },
  'CHEVROLET CORVETTE': {
    name: 'Chevrolet Corvette C8 Z51', lengthM: 4.63, widthM: 1.93, heightM: 1.23, wheelbaseM: 2.72,
    fit: { yawDeg: 180, lengthM: 4.63, offsetM: [0, 0, 0], eyeM: [0.37, 0.98, -0.26], dashcamM: [0, 1.07, 0.36], dashcamFovDeg: 120, dashcamPitchDeg: -5 },
    dynamics: { steeringRatio: 15.7, rollDegPerG: 1.3, diveDegPerG: 0.8, squatDegPerG: 0.5, rideHz: 1.6, damping: 0.65 },
  },
}
export const DEFAULT_PRESET = 'LOTUS EXIGE'

/** "LOTUS EXIGE" from Garmin's make and model (null when both are missing). */
export function vehicleKey(make: string | null | undefined, model: string | null | undefined): string | null {
  const key = [make, model].map(s => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')).filter(Boolean).join(' ')
  return key || null
}

/** The preset for a vehicle key: an exact key, else one whose model word appears in it. */
export function presetFor(key: string | null): CarPreset {
  if (key && CAR_PRESETS[key]) return CAR_PRESETS[key]
  const hit = key ? Object.entries(CAR_PRESETS).find(([k]) => key.includes(k.split(' ').slice(1).join(' '))) : undefined
  return (hit ?? [DEFAULT_PRESET, CAR_PRESETS[DEFAULT_PRESET]])[1]
}

/**
 * The model a vehicle uses: the one whose matches name its key (the Garage
 * keeps one per key; of several, the newest), or null for the placeholder.
 */
export function carModelFor<T extends Pick<CarModel, 'matches' | 'uploadedAt'>>(models: readonly T[], key: string | null): T | null {
  if (!key) return null
  return models.filter(m => m.matches.includes(key)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0] ?? null
}

export const MAX_CAR_MODEL_BYTES = 300 * 1024 ** 2

/** Vehicle keys whose preset's model word ("EXIGE", "CORVETTE") appears in a text such as a model's title. */
export function presetKeysIn(text: string | null | undefined): string[] {
  const upper = ` ${(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `
  return Object.keys(CAR_PRESETS).filter(key => key.split(' ').slice(1).some(word => upper.includes(` ${word} `)))
}

// ─── .glb files ─────────────────────────────────────────────────────────────

/** The JSON chunk's byte length from a .glb's first 20 bytes (glTF 2 binary), or null. */
export function glbJsonLength(head: Uint8Array): number | null {
  if (head.length < 20) return null
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  // 'glTF', version 2, then the first chunk: its length and type 'JSON'.
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) return null
  const length = view.getUint32(12, true)
  return length > 0 ? length : null
}

/**
 * Name and credit line from a glTF's asset.extras, as Sketchfab writes them
 * ({ title, author: "Name (https://…)", license: "CC-BY-4.0 (http://…)", source }):
 * "“2006 Lotus Exige S” by Ddiaz Design (CC-BY-NC-SA-4.0) · https://sketchfab.com/…".
 */
export function glbCredits(gltf: unknown): { name: string | null; attribution: string | null } {
  const extras = (gltf as { asset?: { extras?: Record<string, unknown> } } | null)?.asset?.extras
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  // "Ddiaz Design (https://…)" → "Ddiaz Design".
  const withoutUrl = (v: string | null) => v?.replace(/\s*\(\s*https?:\/\/[^)]*\)\s*$/i, '').trim() || null
  const title = text(extras?.title), author = withoutUrl(text(extras?.author))
  const license = withoutUrl(text(extras?.license)), source = text(extras?.source)
  let attribution: string | null = null
  if (title || author) {
    attribution = [title ? `“${title}”` : 'Model', author ? `by ${author}` : null, license ? `(${license})` : null].filter(Boolean).join(' ')
    if (source) attribution += ` · ${source}`
  }
  return { name: title, attribution }
}

// ─── Track models (user-supplied 3D tracks, shared by every driver) ────────
//
// A folder per model under <shared>/track-models/<id>/: .glb files plus a
// track.json (TrackModelManifest). A model is drawn in place of the
// generated road and terrain when its trackName and a layout match the
// scene's. Third-party work: never part of the repository.

/**
 * Places a model's glTF coordinates on the earth. A glTF point p maps to
 *   world = offsetM + rotY(rotationDeg) · (scale · flip(p))
 * in the equirectangular frame around (originLat, originLon): x east,
 * y metres above sea level, z south, x = (lon − originLon)·cos(originLat)·R·π/180,
 * z = −(lat − originLat)·R·π/180 with R = 6378137 m (as geo.ts makeFrame).
 */
export interface TrackModelGeoref {
  originLat: number
  originLon: number
  /** Rotation about +y, three.js sense (counter-clockwise seen from above). */
  rotationDeg: number
  scale: number
  /** [east, up, south] metres; up is metres above sea level. */
  offsetM: [number, number, number]
  /** Axes negated before rotating (none for Assetto Corsa tracks). */
  flips?: { x?: boolean; z?: boolean }
}

export interface TrackModelLayout {
  /** The model's files to load for this layout, in order. */
  files: string[]
}

/**
 * Where the model has ground (glTF x/z), for public terrain drawn around it:
 * a greyscale PNG, 255 = covered; cell (i, j) spans x0 + i·cellM … +cellM,
 * z0 + j·cellM … +cellM.
 */
export interface TrackModelFootprint {
  file: string
  x0: number
  z0: number
  cellM: number
  width: number
  height: number
}

export interface TrackModelFile {
  name: string
  sizeBytes: number
}

export interface TrackModel {
  id: string
  name: string
  /** Credit line shown in the replay. */
  attribution: string | null
  /** The facility as Garmin names it, e.g. "Virginia International Raceway" (matched case-insensitively). */
  trackName: string
  /** Layouts by Garmin configuration name ("Full Course", "North Course"). */
  layouts: Record<string, TrackModelLayout>
  georef: TrackModelGeoref
  footprint: TrackModelFootprint | null
  /**
   * Drivable surfaces (the car sits on them): glTF nodes whose extras have
   * `drivable: true` (and `ground: true` for grass and earth the car may
   * run onto). Nodes are also drivable when their name matches this pattern.
   */
  drivablePattern: string | null
  files: TrackModelFile[]
  /** Bytes of every file, for "≈ 60 MB" in the UI. */
  sizeBytes: number
  updatedAt: string
}

export const MAX_TRACK_MODEL_FILE_BYTES = 400 * 1024 ** 2

/** Track names compare without case, spacing or punctuation. */
export const normalTrackName = (name: string | null | undefined) => (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The model and layout for a track, or null. */
export function trackModelFor(models: TrackModel[], track: { trackName: string | null; configName: string | null }): { model: TrackModel; layout: TrackModelLayout } | null {
  const name = normalTrackName(track.trackName), config = normalTrackName(track.configName)
  if (!name || !config) return null
  for (const model of models) {
    if (normalTrackName(model.trackName) !== name) continue
    const key = Object.keys(model.layouts).find(k => normalTrackName(k) === config)
    if (key) return { model, layout: model.layouts[key] }
  }
  return null
}
