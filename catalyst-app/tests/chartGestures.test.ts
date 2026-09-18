import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampRange, pinchBetween, pinchRange } from '../src/renderer/components/chartGestures'

test('pinch zoom is anchored to the fingers and follows their midpoint when panning', () => {
  const before = pinchBetween({ x: 200, y: 100 }, { x: 400, y: 100 })
  const spread = pinchBetween({ x: 100, y: 100 }, { x: 500, y: 100 })
  assert.deepEqual(pinchRange([0, 1000], [0, 1000], before, spread, 0, 600), [250, 750])
  const moved = pinchBetween({ x: 260, y: 100 }, { x: 460, y: 100 })
  assert.deepEqual(pinchRange([250, 750], [0, 1000], before, moved, 0, 600), [200, 700])
  const spreadAndMoved = pinchBetween({ x: 160, y: 140 }, { x: 560, y: 140 })
  assert.deepEqual(pinchRange([0, 1000], [0, 1000], before, spreadAndMoved, 0, 600), [200, 700])
})

test('navigation never leaves data extent or collapses into an unusable range', () => {
  assert.deepEqual(clampRange([-100, 100], [0, 1000]), [0, 200])
  assert.deepEqual(clampRange([900, 1100], [0, 1000]), [800, 1000])
  assert.deepEqual(clampRange([-100, 2000], [0, 1000]), [0, 1000])
  assert.deepEqual(clampRange([500, 500.001], [0, 1000]), [500, 510])
  assert.deepEqual(clampRange([0, 10], [5, 5]), [5, 5])
  assert.equal(pinchBetween({ x: 0, y: 0 }, { x: 0, y: 0 }).distance, 12)
})
