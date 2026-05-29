// Plain helper functions that convert AnalysisData into LineChart-ready
// series. Lives in its own module (not Charts.tsx) so React Fast Refresh can
// hot-reload the chart components cleanly — Fast Refresh forbids modules that
// export both components and non-component values.

import { PALETTE, LAP_PALETTE } from './PlotlyChart'
import type { LineSeries } from './Charts'
import type { AnalysisData } from '../../garmin/analysisData'

export function speedSeries(data: AnalysisData): LineSeries[] {
  return data.speedTraces.map((t, i) => ({
    id: `${t.sg}-${t.lapIdx}`, label: `${t.isBest ? '★ ' : ''}L${t.lapIdx + 1}`,
    xs: t.dist, ys: t.speed_mph,
    color: t.isBest ? PALETTE.signal : LAP_PALETTE[i % LAP_PALETTE.length],
    width: t.isBest ? 2.5 : 1.4, opacity: t.isBest ? 1 : 0.6,
  }))
}

export function lateralSeries(data: AnalysisData): LineSeries[] {
  return data.lateralTraces.map((t, i) => ({
    id: `${t.sg}-${t.lapIdx}`, label: `${t.isBest ? '★ ' : ''}L${t.lapIdx + 1}`,
    xs: t.dist, ys: t.pos,
    color: t.isBest ? PALETTE.signal : LAP_PALETTE[i % LAP_PALETTE.length],
    width: t.isBest ? 2.5 : 1.2, opacity: t.isBest ? 1 : 0.5,
  }))
}

export function longGSeries(data: AnalysisData): LineSeries[] {
  return data.longgTraces.map((t, i) => ({
    id: `${t.sg}-${t.lapIdx}`, label: `${t.isBest ? '★ ' : ''}L${t.lapIdx + 1}`,
    xs: t.dist, ys: t.long_g,
    color: t.isBest ? PALETTE.signal : LAP_PALETTE[i % LAP_PALETTE.length],
    width: t.isBest ? 2.5 : 1.2, opacity: t.isBest ? 1 : 0.5,
  }))
}
