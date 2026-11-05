// What the sky and the track look like for a session: the sun where it stood
// at the session's start, the cloud and haze Garmin's weather text implies,
// and how wet the surface was. Pure: the atmosphere (atmosphere.ts) turns a
// look into lights, a sky and fog.

import { estimateUtcOffsetMin, type ReplayConditions, type ReplayScene } from '../../shared/replay'
import { sunPosition, type SunPosition } from './sun'

/** The weather to show: the session's own, or one of the looks to check. */
export type WeatherChoice = 'auto' | 'sunny' | 'overcast' | 'wet'
export const WEATHER_CHOICES: WeatherChoice[] = ['auto', 'sunny', 'overcast', 'wet']

export interface Look {
  /** What it is, for the page ("Cloudy", "Sunny"). */
  label: string
  sun: SunPosition
  /** Fair-weather cumulus over a clear sky, 0–1 of it. */
  cumulus: number
  /** A grey deck over the whole sky, 0 (none) – 1 (solid). */
  overcast: number
  /** Rain cloud: the deck darker and lower, 0–1. */
  rain: number
  /** The surface: 0 dry, 0.5 damp, 1 wet with standing water. */
  wetness: number
  /** Meteorological visibility, km (haze and mist). */
  visibilityKm: number
  /** Aerosol turbidity of the clear sky (2 crisp – 6 hazy). */
  turbidity: number
  /** Wind for the grass, m/s, and where it blows towards (degrees from north). */
  windMps: number
  windToDeg: number
}

const CLEAR = { cumulus: 0.06, overcast: 0, rain: 0 }
// Garmin's weather texts (as at VIR: Fair, Mostly Clear, Partly Cloudy,
// Mostly Cloudy, Cloudy, Mist, Light Rain) to sky cover.
function skyFor(text: string): { cumulus: number; overcast: number; rain: number } {
  const t = text.toLowerCase()
  if (/thunder|storm|heavy rain|downpour/.test(t)) return { cumulus: 0, overcast: 1, rain: 1 }
  if (/rain|shower|drizzle|sleet|snow/.test(t)) return { cumulus: 0, overcast: 1, rain: /light|drizzle/.test(t) ? 0.55 : 0.8 }
  if (/fog|mist|haze|smoke/.test(t)) return { cumulus: 0, overcast: 1, rain: 0.15 }
  if (/overcast|^cloudy/.test(t)) return { cumulus: 0, overcast: 1, rain: 0 }
  if (/mostly cloudy|considerable cloud/.test(t)) return { cumulus: 0.7, overcast: 0.62, rain: 0 }
  if (/partly (cloudy|sunny)|scattered/.test(t)) return { cumulus: 0.42, overcast: 0, rain: 0 }
  if (/mostly (clear|sunny)|few clouds/.test(t)) return { cumulus: 0.2, overcast: 0, rain: 0 }
  return CLEAR // fair, clear, sunny, or unknown
}

/** Visibility from the text and humidity: humid summer air at VIR is hazy; mist is a kilometre or two. */
function visibilityFor(text: string, humidity: number | null, temperatureC: number | null, rain: number): number {
  const t = text.toLowerCase()
  if (/fog/.test(t)) return 0.8
  if (/mist/.test(t)) return 2.5
  if (/haze|smoke/.test(t)) return 6
  let km = 32
  if (humidity != null) km *= 1 - 0.65 * Math.min(1, Math.max(0, (humidity - 35) / 65)) ** 1.5
  if (temperatureC != null && temperatureC > 26) km *= 0.8 // summer haze
  if (rain > 0) km = Math.min(km, 9 - 4 * rain)
  return Math.max(1, km)
}

const where = (scene: ReplayScene) => {
  const { line } = scene.track
  const mid = line.lat.length >> 1
  return { lat: line.lat[mid] ?? (scene.track.area.south + scene.track.area.north) / 2, lon: line.lon[mid] ?? (scene.track.area.west + scene.track.area.east) / 2 }
}

/** The session's start as a UTC instant (ms), from its conditions or, on an older server, its local start. */
function startUtc(scene: ReplayScene): number | null {
  const c = scene.conditions
  if (c?.utcStart) return Date.parse(c.utcStart)
  const local = c?.localStart ?? scene.sessionStart
  if (!local) return null
  const { lat, lon } = where(scene)
  const offset = estimateUtcOffsetMin(lat, lon, local)
  const wall = Date.parse(`${local.replace(' ', 'T').slice(0, 19)}Z`)
  return offset == null || !Number.isFinite(wall) ? null : wall - offset * 60000
}

export function lookFor(scene: ReplayScene, choice: WeatherChoice): Look {
  const c: Partial<ReplayConditions> = scene.conditions ?? {}
  const { lat, lon } = where(scene)
  // A few minutes into the session: laps start after the out lap.
  const utc = startUtc(scene)
  const sun = utc != null ? sunPosition(utc + 10 * 60_000, lat, lon) : { elevationDeg: 38, azimuthDeg: 215 }
  // Keep a little daylight: a dusk session still reads.
  sun.elevationDeg = Math.max(sun.elevationDeg, 4)
  const text = choice === 'sunny' ? 'Fair' : choice === 'overcast' ? 'Cloudy' : choice === 'wet' ? 'Light Rain' : (c.description ?? '')
  const sky = skyFor(text)
  const surface = choice === 'auto' ? c.surface ?? 'unknown' : choice === 'wet' ? 'wet' : 'dry'
  // Mist and rain leave the track at least damp, whatever the surface says.
  let wetness = surface === 'wet' ? 1 : surface === 'damp' || surface === 'mixed' ? 0.5 : 0
  if (choice === 'auto' && surface === 'unknown' && /mist|drizzle|fog/i.test(text)) wetness = 0.45
  const humidity = choice === 'auto' ? c.humidityPct ?? null : choice === 'sunny' ? 50 : choice === 'overcast' ? 70 : 95
  const temperature = choice === 'auto' ? c.temperatureC ?? null : null
  const visibilityKm = visibilityFor(text, humidity, temperature, sky.rain)
  const turbidity = 2.2 + 4 * Math.min(1, Math.max(0, 1 - visibilityKm / 32))
  // Garmin's wind field is labelled m/s but reads like km/h (4.83, 9.66, 12.87: whole mph); either way a breeze.
  const wind = c.windMps ?? null
  const windMps = choice === 'auto' && wind != null ? Math.min(12, wind / 3.6) : choice === 'wet' ? 4 : 2
  const windToDeg = ((c.windFromDeg ?? 250) + 180) % 360
  const label = choice === 'auto' ? c.description || 'Weather unknown' : { sunny: 'Sunny', overcast: 'Overcast', wet: 'Wet' }[choice]
  return { label, sun, ...sky, wetness, visibilityKm, turbidity, windMps, windToDeg }
}
