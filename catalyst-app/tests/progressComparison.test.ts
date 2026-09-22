import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comparisonValues, metricFamily } from '../src/renderer/components/progressComparisonData'
import type { ReviewSummary } from '../src/shared/review'

const sessions = (values: Array<number | null | undefined>) => values.map(value => ({ regions: value === undefined ? [] : [{ id: 't1', timeMs: value }] }) as unknown as ReviewSummary)
const plot = { regionId: 't1', metric: 'timeMs' as const }
test('relative overlays use the first finite measurement and preserve missing data', () => {
  const result = comparisonValues(sessions([null, 1000, 900, undefined, NaN, 1100]), plot, true)
  assert.equal(result.baselineIndex, 1)
  assert.equal(result.baseline, 1000)
  assert.deepEqual(result.values, [null, 0, -10, null, null, 10])
  assert.deepEqual(comparisonValues(sessions([900, 1100]), plot, true).values, [0, 200 / 900 * 100])
})
test('zero baselines have no percentage change but retain actual measurements', () => {
  assert.deepEqual(comparisonValues(sessions([0, 10]), plot, true).values, [null, null])
  assert.deepEqual(comparisonValues(sessions([0, 10]), plot, false).values, [0, 10])
  assert.deepEqual(comparisonValues(sessions([null, Infinity]), plot, true).values, [null, null])
})
test('only metrics with compatible dimensions share an actual-value axis', () => {
  assert.equal(metricFamily('entryMps'), metricFamily('exitMps'))
  assert.equal(metricFamily('timeMs'), metricFamily('consistencyMs'))
  assert.notEqual(metricFamily('vminDistanceM'), metricFamily('vminMps'))
  assert.notEqual(metricFamily('timeMs'), metricFamily('entryMps'))
})
