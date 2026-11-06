// A model's fit with its Garmin camera and data collector filled in: the
// fit's own mount, lens, tilt and GPS position, else the vehicle preset's, as the replay engine resolves them
// (engine.ts dashcam()). No three.js here: the Garage page uses it too.

import type { CarModelFit, CarPreset } from '../../shared/replay'

export type FullFit = CarModelFit & Required<Pick<CarModelFit, 'dashcamM' | 'dashcamFovDeg' | 'dashcamPitchDeg' | 'gpsM'>>

export function fullFit(fit: CarModelFit | null, preset: CarPreset): FullFit {
  const p = preset.fit
  return {
    ...(fit ?? p),
    eyeM: (fit ?? p).eyeM,
    dashcamM: fit?.dashcamM ?? p.dashcamM ?? [0, preset.heightM * 0.92, 0.1],
    dashcamFovDeg: fit?.dashcamFovDeg ?? p.dashcamFovDeg ?? 120,
    dashcamPitchDeg: fit?.dashcamPitchDeg ?? p.dashcamPitchDeg ?? 5,
    gpsM: fit?.gpsM ?? p.gpsM ?? [0, preset.heightM * 0.7, 0],
  }
}
