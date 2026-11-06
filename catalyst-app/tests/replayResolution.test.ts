// The replay's resolution and graphics ladder (src/renderer/replay/resolution.ts):
// Auto's rungs down to 0.75 × and Low, a fixed level's down to 1 ×, the
// ceiling that keeps it from hunting, undoing a step that did not help (a
// capped or CPU-bound device), the way back up, and the frame measurement.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adapt, FrameWindow, MIN_RATIO, RAISE_WAIT_MS, stepDown, stepUp, type Ladder, type Rung } from '../src/renderer/replay/resolution'

// Every rung down from `start` until the ladder ends.
function ladder(start: Rung, auto: boolean): string[] {
  const out: string[] = []
  for (let rung: Rung | null = stepDown(start, auto); rung; rung = stepDown(rung, auto)) {
    out.push(`${rung.ratio} ${rung.quality} ≤${rung.ceiling}`)
    assert.ok(out.length < 20)
  }
  return out
}

const fresh = (ratio: number, quality: Ladder['quality']): Ladder => ({ ratio, quality, ceiling: 2, capped: false, trial: null, raiseAfter: 0 })

test('Auto steps down to 1.25 ×, Medium, 1 ×, then 0.85 ×, 0.75 × and Low', () => {
  assert.deepEqual(ladder({ ratio: 2, quality: 'high', ceiling: 2 }, true), [
    '1.75 high ≤1.75', '1.5 high ≤1.5', '1.25 high ≤1.25', '1.25 medium ≤1.25', '1 medium ≤1', '0.85 medium ≤0.85', '0.75 medium ≤0.75', '0.75 low ≤0.75',
  ])
  // A screen at 1 ×: Medium first, then below 1 ×.
  assert.deepEqual(ladder({ ratio: 1, quality: 'high', ceiling: 2 }, true), ['1 medium ≤2', '0.85 medium ≤0.85', '0.75 medium ≤0.75', '0.75 low ≤0.75'])
})

test('the iPad (Auto on Low at 1.5 ×) goes down to 0.75 × and no further', () => {
  assert.deepEqual(ladder({ ratio: 1.5, quality: 'low', ceiling: 2 }, true), ['1.25 low ≤1.25', '1 low ≤1', '0.85 low ≤0.85', '0.75 low ≤0.75'])
})

test('a fixed graphics level only steps its resolution, down to 1 ×', () => {
  assert.deepEqual(ladder({ ratio: 2, quality: 'high', ceiling: 2 }, false), ['1.75 high ≤1.75', '1.5 high ≤1.5', '1.25 high ≤1.25', '1 high ≤1'])
  assert.deepEqual(ladder({ ratio: 1.1, quality: 'medium', ceiling: 2 }, false), ['1 medium ≤1'])
  assert.equal(stepDown({ ratio: 1, quality: 'low', ceiling: 1 }, false), null)
})

test('never below 0.75 ×, and never up the ladder on the way down', () => {
  for (const auto of [true, false]) {
    for (const quality of ['high', 'medium', 'low'] as const) {
      for (let ratio = 0.5; ratio <= 3; ratio += 0.05) {
        const next = stepDown({ ratio, quality, ceiling: 2 }, auto)
        if (!next) continue
        assert.ok(next.ratio <= ratio)
        assert.ok(next.ratio >= Math.min(ratio, auto ? MIN_RATIO : 1))
        assert.ok(next.ratio < ratio || next.quality !== quality)
      }
    }
  }
})

test('a slow window steps down; the next judges it and keeps a step that helped', () => {
  let s = adapt(fresh(1.5, 'high'), 38, { auto: true, limit: 2, now: 3000 })
  assert.equal(s.ratio, 1.25)
  assert.equal(s.ceiling, 1.25)
  assert.deepEqual(s.trial, { from: { ratio: 1.5, quality: 'high', ceiling: 2 }, fps: 38 })
  // 42 fps is better by more than a tenth: kept, and still slow, so on to Medium.
  s = adapt(s, 42, { auto: true, limit: 2, now: 6000 })
  assert.equal(s.ratio, 1.25)
  assert.equal(s.quality, 'medium')
  assert.equal(s.capped, false)
  assert.equal(s.trial?.fps, 42)
  // Fast enough now: kept, the trial over, and no step back up past the ceiling.
  s = adapt(s, 60, { auto: true, limit: 2, now: 9000 })
  assert.equal(s.trial, null)
  assert.equal(s.ratio, 1.25)
  assert.equal(s.quality, 'medium')
})

test('a capped device (30 fps whatever the resolution): the step is undone and the ladder stops', () => {
  let s = adapt(fresh(1.5, 'high'), 30, { auto: true, limit: 2, now: 3000 })
  assert.equal(s.ratio, 1.25)
  s = adapt(s, 30.5, { auto: true, limit: 2, now: 6000 })
  assert.deepEqual({ ratio: s.ratio, quality: s.quality, ceiling: s.ceiling, capped: s.capped, trial: s.trial }, { ratio: 1.5, quality: 'high', ceiling: 2, capped: true, trial: null })
  // Still 30 fps: it stays where it is.
  for (let now = 9000; now < 60_000; now += 3000) s = adapt(s, 30, { auto: true, limit: 2, now })
  assert.equal(s.ratio, 1.5)
  assert.equal(s.quality, 'high')
  // A quality step that did not help is undone too.
  let q = adapt(fresh(1.25, 'high'), 40, { auto: true, limit: 2, now: 3000 })
  assert.equal(q.quality, 'medium')
  q = adapt(q, 43, { auto: true, limit: 2, now: 6000 })
  assert.equal(q.quality, 'high')
  assert.equal(q.capped, true)
})

test('steps up only when fast, to the ceiling, ten seconds apart', () => {
  // Started below the device's ratio (a resize, a new world): up a quarter at a time.
  let s: Ladder = { ...fresh(1, 'high'), ceiling: 1.5 }
  s = adapt(s, 60, { auto: true, limit: 2, now: 20_000 })
  assert.equal(s.ratio, 1.25)
  assert.equal(s.raiseAfter, 20_000 + RAISE_WAIT_MS)
  s = adapt(s, 60, { auto: true, limit: 2, now: 23_000 })
  assert.equal(s.ratio, 1.25)
  s = adapt(s, 60, { auto: true, limit: 2, now: 31_000 })
  assert.equal(s.ratio, 1.5)
  s = adapt(s, 60, { auto: true, limit: 2, now: 50_000 })
  assert.equal(s.ratio, 1.5)
  // Never past the device's (or its profile's) limit: the iPad's 1.5.
  assert.equal(adapt({ ...fresh(1.25, 'low'), ceiling: 2 }, 60, { auto: true, limit: 1.5, now: 20_000 }).ratio, 1.5)
  assert.equal(adapt({ ...fresh(1.5, 'low'), ceiling: 2 }, 60, { auto: true, limit: 1.5, now: 20_000 }).ratio, 1.5)
  // Between 45 and 58 fps nothing changes.
  assert.deepEqual(adapt(fresh(1.25, 'high'), 50, { auto: true, limit: 2, now: 20_000 }), fresh(1.25, 'high'))
  // From below 1 × back up by the same rungs.
  assert.equal(stepUp(0.75, 2), 0.85)
  assert.equal(stepUp(0.85, 2), 1)
  assert.equal(stepUp(1, 2), 1.25)
  assert.equal(stepUp(1, 1.1), 1.1)
})

test('frames are measured over 3 s of real intervals, leaving out gaps', () => {
  const w = new FrameWindow()
  let fps: number | null = null
  let t = 1000
  // 30 fps for a while, then the tab is away for 5 s, then 30 fps again.
  assert.equal(w.add(t), null)
  for (let i = 0; i < 60; i++) { t += 1000 / 30; fps = w.add(t) ?? fps }
  assert.equal(fps, null)
  t += 5000
  assert.equal(w.add(t), null)
  for (let i = 0; i < 31 && fps === null; i++) { t += 1000 / 30; fps = w.add(t) }
  assert.ok(fps !== null && Math.abs(fps - 30) < 0.01, `30 fps, not slowed by the gap: ${fps}`)
  // A reset starts afresh from the next frame.
  w.reset()
  assert.equal(w.add(t + 10), null)
  let n = 0
  for (fps = null; fps === null; n++) fps = w.add(t + 10 + (n + 1) * (1000 / 60))
  assert.ok(Math.abs(fps - 60) < 0.01)
  assert.ok(n >= 179 && n <= 181)
})
