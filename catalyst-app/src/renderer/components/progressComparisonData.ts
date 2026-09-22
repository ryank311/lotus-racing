import type { ReviewMetric, ReviewSummary } from '../../shared/review'

export interface ProgressPlot { regionId: string; metric: ReviewMetric }
export const plotKey = (plot: ProgressPlot) => JSON.stringify([plot.regionId, plot.metric])
export const metricFamily = (metric: ReviewMetric) => metric === 'timeMs' || metric === 'consistencyMs' ? 'time' : metric === 'vminDistanceM' ? 'distance' : 'speed'
export const finiteValue = (value: number | null | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Missing measurements break lines. A zero baseline cannot define a percentage change. */
export function comparisonValues(sessions: ReviewSummary[], plot: ProgressPlot, relative: boolean) {
  const raw = sessions.map(s => finiteValue(s.regions.find(r => r.id === plot.regionId)?.[plot.metric]))
  const baselineIndex = raw.findIndex(v => v !== null)
  const baseline = raw[baselineIndex] ?? null
  return { raw, baseline, baselineIndex, values: raw.map(value => value === null ? null : !relative ? value : baseline === null || baseline === 0 ? null : finiteValue((value - baseline) / Math.abs(baseline) * 100)) }
}
