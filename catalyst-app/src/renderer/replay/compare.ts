// The second car (a ghost lap, or another driver's lap): its own clock, set
// apart from yours by an offset you scrub, and the "Both cars" camera's
// framing. Pure maths, tested without a GPU (tests/replayCompare.test.ts).
//
// The compared car's lap time is yours plus the offset. Scrubbing your car
// moves both and keeps the offset; scrubbing the compared car changes only
// the offset; playing runs both clocks at the same rate. Sync puts the
// offset back to 0 (both laps from their starts); Side by side sets it so
// the compared car is where yours is on the track now. The live gap stays
// the time between the two laps at the same spot (LapPath.timeAtDist),
// whatever the offset.

import type { LapPath } from './lapPath'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }

/** The compared car's lap time (ms) for yours. */
export function comparedTime(mainMs: number, offsetMs: number): number {
  return mainMs + offsetMs
}

/** An offset kept within a lap either way. */
export function clampOffset(offsetMs: number, mainDurationMs: number, comparedDurationMs: number): number {
  const limit = Math.max(mainDurationMs, comparedDurationMs, 0)
  return Number.isFinite(offsetMs) ? clamp(offsetMs, -limit, limit) : 0
}

/** The offset that puts the compared car at its lap time `comparedMs` (within its lap) while yours stays at `mainMs`. */
export function offsetFor(comparedMs: number, mainMs: number, comparedDurationMs: number): number {
  return clamp(comparedMs, 0, comparedDurationMs) - mainMs
}

/**
 * Side by side: the offset that puts the compared car level with yours on
 * the track now (the same metres along the scene's mean line), or null
 * where its lap does not reach that spot. `aheadM` moves its mark forward:
 * the difference between the two cars' data collectors (GPS) in front of
 * their centres, so the cars' centres line up rather than their units.
 */
export function sideBySideOffset(main: LapPath, compared: LapPath, mainMs: number, aheadM = 0): number | null {
  const at = compared.timeAtDist(main.distAt(mainMs) + aheadM)
  return at == null ? null : at - mainMs
}

/** The scrub bar's fraction for a lap time on your lap's time axis. */
export function scrubFraction(ms: number, mainDurationMs: number): number {
  return mainDurationMs > 0 ? clamp(ms / mainDurationMs, 0, 1) : 0
}

/** "−1.24 s", "+0.80 s", "±0.00 s": the compared car behind or ahead of its own clock. */
export function formatOffset(offsetMs: number): string {
  const s = offsetMs / 1000
  if (Math.abs(s) < 0.005) return '±0.00 s'
  return `${s < 0 ? '−' : '+'}${Math.abs(s).toFixed(2)} s`
}

// ─── The "Both cars" camera ─────────────────────────────────────────────────

/** Both cars stay framed up to this far apart; beyond FAR_M the camera follows yours. */
export const BOTH_NEAR_M = 90
export const BOTH_FAR_M = 150
/** Half a car and a little air round it (m). */
export const CAR_RADIUS_M = 2.8
/** Pitch above the cars, radians: a chase camera's when they are level, near top-down far apart. */
export const BOTH_PITCH: [number, number] = [0.42, 1.0]
const BOTH_PITCH_SPREAD_M = 80

export interface BothFrame {
  /** Where the camera looks: between the cars, sliding to yours as they part. */
  target: [number, number, number]
  /** A sphere round the target that holds the car(s) to keep in view. */
  radiusM: number
  /** 1 framing both, 0 following yours alone. */
  weight: number
  /** The cars' distance apart on the ground (m). */
  separationM: number
  /** Pitch above the target, radians. */
  pitch: number
}

/** The framing for your car at `a` and the compared car at `b` (null: not on track). */
export function frameBoth(a: readonly [number, number, number], b: readonly [number, number, number] | null): BothFrame {
  const separationM = b ? Math.hypot(b[0] - a[0], b[2] - a[2]) : 0
  const weight = b ? 1 - smoothstep(BOTH_NEAR_M, BOTH_FAR_M, separationM) : 0
  const k = 0.5 * weight
  const target: [number, number, number] = b ? [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] : [a[0], a[1], a[2]]
  const spread = separationM * weight
  return {
    target, weight, separationM,
    radiusM: CAR_RADIUS_M + spread / 2,
    pitch: BOTH_PITCH[0] + (BOTH_PITCH[1] - BOTH_PITCH[0]) * smoothstep(0, BOTH_PITCH_SPREAD_M, spread),
  }
}

/**
 * How far back the camera stands to hold a sphere of `radiusM` in view: the
 * narrower of the vertical and horizontal fields of view decides.
 */
export function framingDistance(radiusM: number, verticalFovDeg: number, aspect: number): number {
  const half = verticalFovDeg * Math.PI / 360
  const horizontal = Math.atan(Math.tan(half) * Math.max(0.1, aspect))
  return radiusM / Math.sin(Math.max(0.05, Math.min(half, horizontal)))
}
