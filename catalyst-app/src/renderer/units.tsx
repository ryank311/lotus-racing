// Renderer-wide units state. One provider at the app root holds the active
// UnitSystem; every component reads it via useUnits() and formats with the
// shared converters, so toggling Metric/Imperial updates the whole UI at once.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import {
  DEFAULT_UNIT_SYSTEM,
  speedFromMph,
  speedFromMps,
  speedUnitLabel,
  tempFromC,
  tempUnitLabel,
  type UnitSystem,
} from '../shared/units'

interface UnitsContextValue {
  system: UnitSystem
  setSystem: (s: UnitSystem) => void
  speedUnit: string
  tempUnit: string
  // canonical → display
  speedFromMps: (mps: number) => number
  speedFromMph: (mph: number) => number
  tempFromC: (c: number) => number
}

const UnitsContext = createContext<UnitsContextValue | null>(null)

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [system, setSystemState] = useState<UnitSystem>(DEFAULT_UNIT_SYSTEM)

  // Guard against a stale preload bridge (getUnits/setUnits added later): fall
  // back to the default rather than crashing the whole app.
  useEffect(() => {
    if (typeof api.getUnits !== 'function') return
    void api.getUnits().then(setSystemState).catch(() => {})
  }, [])

  const setSystem = (s: UnitSystem) => {
    setSystemState(s)
    if (typeof api.setUnits === 'function') void api.setUnits(s).catch(() => {})
  }

  const value: UnitsContextValue = {
    system,
    setSystem,
    speedUnit: speedUnitLabel(system),
    tempUnit: tempUnitLabel(system),
    speedFromMps: (mps: number) => speedFromMps(mps, system),
    speedFromMph: (mph: number) => speedFromMph(mph, system),
    tempFromC: (c: number) => tempFromC(c, system),
  }

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>
}

export function useUnits(): UnitsContextValue {
  const ctx = useContext(UnitsContext)
  if (!ctx) throw new Error('useUnits must be used within a UnitsProvider')
  return ctx
}
