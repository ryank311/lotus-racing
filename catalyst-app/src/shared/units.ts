// Single source of truth for unit conversions across the whole app.
//
// All telemetry is stored canonically in SI (speed m/s, temperature °C). The
// user's `UnitSystem` setting drives every display + the AI brief:
//   - metric   → speed km/h, temperature °C
//   - imperial → speed mph,  temperature °F
//
// Conversion helpers take a canonical SI value and the active system and return
// the display value; label helpers return the unit string. Keep all unit math
// here so a single setting flows everywhere.

export type UnitSystem = 'metric' | 'imperial'

export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'imperial'

const MPS_TO_MPH = 2.23694
const MPS_TO_KMH = 3.6
// mph is the canonical unit for coach-generated annotation speeds.
const MPH_TO_KMH = 1.609344

export function speedUnitLabel(system: UnitSystem): string {
  return system === 'imperial' ? 'mph' : 'km/h'
}

export function tempUnitLabel(system: UnitSystem): string {
  return system === 'imperial' ? '°F' : '°C'
}

// Canonical m/s → display speed in the active system.
export function speedFromMps(mps: number, system: UnitSystem): number {
  return mps * (system === 'imperial' ? MPS_TO_MPH : MPS_TO_KMH)
}

// Canonical °C → display temperature in the active system.
export function tempFromC(c: number, system: UnitSystem): number {
  return system === 'imperial' ? c * 9 / 5 + 32 : c
}

// Coach annotation speeds are emitted in mph; convert to the active display unit.
export function speedFromMph(mphValue: number, system: UnitSystem): number {
  return system === 'imperial' ? mphValue : mphValue * MPH_TO_KMH
}
