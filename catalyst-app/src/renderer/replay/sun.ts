// Where the sun stands at a place and instant: NOAA's solar position
// equations (the "General Solar Position Calculations" sheet), good to a
// fraction of a degree, which is far finer than the light needs.

const DEG = Math.PI / 180

export interface SunPosition {
  /** Degrees above the horizon (negative below), with refraction near the horizon. */
  elevationDeg: number
  /** Degrees clockwise from true north. */
  azimuthDeg: number
}

/** The sun at `utc` (ms since the epoch) seen from lat/lon in degrees. */
export function sunPosition(utc: number, lat: number, lon: number): SunPosition {
  const date = new Date(utc)
  const year = date.getUTCFullYear()
  const start = Date.UTC(year, 0, 1)
  const days = (Date.UTC(year + 1, 0, 1) - start) / 86_400_000
  const dayOfYear = Math.floor((utc - start) / 86_400_000)
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  // Fractional year, radians.
  const g = 2 * Math.PI / days * (dayOfYear + (hours - 12) / 24)
  const eqTimeMin = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g))
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g)
  const trueSolarMin = hours * 60 + eqTimeMin + 4 * lon
  const hourAngle = (trueSolarMin / 4 - 180) * DEG
  const phi = lat * DEG
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle)))
  const zenith = Math.acos(cosZenith)
  // Azimuth from north, clockwise.
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI
  let elevation = 90 - zenith / DEG
  // Atmospheric refraction lifts the sun near the horizon (about half a degree there).
  if (elevation > -1 && elevation < 85) {
    const e = Math.max(elevation, -0.575)
    elevation += 1.02 / Math.tan((e + 10.3 / (e + 5.11)) * DEG) / 60
  }
  return { elevationDeg: elevation, azimuthDeg: ((azimuth / DEG) % 360 + 360) % 360 }
}

/** A unit vector towards the sun in the replay's frame (x east, y up, z south). */
export function sunDirection(position: SunPosition, out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }) {
  const e = position.elevationDeg * DEG, a = position.azimuthDeg * DEG
  out.x = Math.sin(a) * Math.cos(e)
  out.y = Math.sin(e)
  out.z = -Math.cos(a) * Math.cos(e)
  return out
}
