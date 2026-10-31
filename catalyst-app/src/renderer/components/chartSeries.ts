// Plain helper functions that convert AnalysisData into LineChart-ready
// series. Lives in its own module (not Charts.tsx) so React Fast Refresh can
// hot-reload the chart components cleanly — Fast Refresh forbids modules that
// export both components and non-component values.

import { PALETTE, LAP_PALETTE, DRIVER_PALETTE } from './chartTheme'
import type { LineSeries } from './Charts'
import type { AnalysisData, LapMeta, TimeDeltaTrace } from '../../garmin/analysisData'

// One colour per lap on every chart and the map: the fastest lap is signal
// orange, the rest use the stable palette slot the server assigned. When
// other drivers are compared, colour identifies the driver instead: all of
// your laps are orange and each compared driver has their own colour.
export function lapColor(lap: Pick<LapMeta, 'isBest' | 'colorIndex' | 'driverIndex'>): string {
  if (lap.driverIndex != null) return driverColor(lap.driverIndex)
  return lap.isBest ? PALETTE.signal : LAP_PALETTE[(lap.colorIndex ?? 0) % LAP_PALETTE.length]
}

// 0 = you; 1+ = compared drivers in order.
export function driverColor(index: number): string {
  return index <= 0 ? PALETTE.signal : DRIVER_PALETTE[(index - 1) % DRIVER_PALETTE.length]
}

// Drawn prominently: your fastest lap and each compared driver's fastest.
export function isLeadLap(lap: Pick<LapMeta, 'isBest' | 'driverBest'>): boolean {
  return lap.isBest || !!lap.driverBest
}

// "May 24 16:15 · L3" — falls back to the lap number for payloads built
// before labels existed (a renderer left open across a server restart).
export function lapName(lap: Pick<LapMeta, 'label' | 'lapIdx'>): string {
  return lap.label || `L${lap.lapIdx + 1}`
}

export function speedSeries(data: AnalysisData): LineSeries[] {
  return data.speedTraces.map(t => ({
    id: `${t.sg}-${t.lapIdx}`, label: `${isLeadLap(t) ? '★ ' : ''}${lapName(t)}`,
    xs: t.dist, ys: t.speed_mph,
    color: lapColor(t),
    width: isLeadLap(t) ? 2.5 : 1.4, opacity: isLeadLap(t) ? 1 : 0.6,
  }))
}

function interpolate(xs: number[], ys: number[], target: number): number | null {
  if (!xs.length || target < xs[0] || target > xs[xs.length - 1]) return null
  let lo = 0, hi = xs.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1
    if (xs[mid] <= target) lo = mid
    else hi = mid
  }
  if (lo === hi || xs[hi] === xs[lo]) return ys[lo]
  const t = (target - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + (ys[hi] - ys[lo]) * t
}

/** Speed difference at the same track distance versus the fastest actual lap. */
export function speedDeltaSeries(data: AnalysisData): LineSeries[] {
  const reference = data.speedTraces.find(trace => trace.isBest)
    ?? [...data.speedTraces].filter(trace => trace.durationMs > 0).sort((a, b) => a.durationMs - b.durationMs)[0]
  if (!reference) return []

  return data.speedTraces.map(trace => {
    const xs: number[] = []
    const ys: number[] = []
    for (let j = 0; j < trace.dist.length; j++) {
      const refSpeed = interpolate(reference.dist, reference.speed_mph, trace.dist[j])
      if (refSpeed == null) continue
      xs.push(trace.dist[j])
      ys.push(trace.speed_mph[j] - refSpeed)
    }
    return {
      id: `${trace.sg}-${trace.lapIdx}`,
      label: `${trace.isBest ? '★ ref ' : trace.driverBest ? '★ ' : ''}${lapName(trace)}`,
      xs,
      ys,
      color: lapColor(trace),
      width: isLeadLap(trace) ? 1.8 : 1.4,
      opacity: isLeadLap(trace) ? 0.85 : 0.65,
    }
  })
}

export function lateralSeries(data: AnalysisData): LineSeries[] {
  return data.lateralTraces.map(t => ({
    id: `${t.sg}-${t.lapIdx}`, label: `${t.isBest ? '★ ' : ''}${lapName(t)}`,
    xs: t.dist, ys: t.pos,
    color: lapColor(t),
    width: t.isBest ? 2.5 : 1.2, opacity: t.isBest ? 1 : 0.5,
  }))
}

export function timeDeltaSeries(data: AnalysisData): LineSeries[] {
  return (data.timeDeltaTraces ?? []).map(t => ({
    id: `${t.sg}-${t.lapIdx}`,
    label: `${t.isBest ? '★ ref ' : t.driverBest ? '★ ' : ''}${lapName(t)}`,
    xs: t.dist,
    ys: t.delta_s,
    color: lapColor(t),
    width: isLeadLap(t) ? 1.8 : 1.5,
    opacity: isLeadLap(t) ? 0.8 : 0.75,
  }))
}

// Every lap against a virtual reference lap (the theoretical best or Garmin's
// optimal lap); the fastest real lap is drawn prominently.
function referenceDeltaSeries(traces: TimeDeltaTrace[] | undefined): LineSeries[] {
  return (traces ?? []).map(t => ({
    id: `${t.sg}-${t.lapIdx}`,
    label: `${t.isBest ? '★ best ' : t.driverBest ? '★ ' : ''}${lapName(t)}`,
    xs: t.dist,
    ys: t.delta_s,
    color: lapColor(t),
    width: isLeadLap(t) ? 2.4 : 1.5,
    opacity: isLeadLap(t) ? 1 : 0.72,
  }))
}

export function optimalTimeDeltaSeries(data: AnalysisData): LineSeries[] {
  return referenceDeltaSeries(data.optimalTimeDeltaTraces)
}

export function garminOptimalTimeDeltaSeries(data: AnalysisData): LineSeries[] {
  return referenceDeltaSeries(data.garminOptimalTimeDeltaTraces)
}

export function longGSeries(data: AnalysisData): LineSeries[] {
  return data.longgTraces.map(t => ({
    id: `${t.sg}-${t.lapIdx}`, label: `${isLeadLap(t) ? '★ ' : ''}${lapName(t)}`,
    xs: t.dist, ys: t.long_g,
    color: lapColor(t),
    width: isLeadLap(t) ? 2.5 : 1.2, opacity: isLeadLap(t) ? 1 : 0.5,
  }))
}
