// The replay's resolution and graphics ladder: pure decisions, tested
// without a GPU (tests/replayResolution.test.ts); engine.ts measures frames
// and applies them.
//
// Every change of resolution is a visible jump (fine detail such as leaves
// most of all), so it must not hunt. While playing, frames are measured in
// windows of 3 s; below 45 fps the ladder steps down one rung and that
// resolution becomes a ceiling it is not raised past again in this world.
// Auto graphics go:
//
//   … 1.75 → 1.5 → 1.25 × → Medium → 1.0 → 0.85 → 0.75 × → Low
//
// (a fixed graphics level only goes down to 1.0 ×; the canvas is scaled up
// by CSS below 1). A step that does not raise the next window's frame rate by
// a tenth is undone and the ladder stops for this world: the device is
// capped (Low Power Mode, a browser's energy saver at 30 fps) or bound by
// its CPU, not its GPU, and a blurrier picture would buy nothing.

export type Level = 'high' | 'medium' | 'low'

/** A place on the ladder: the pixel ratio, the graphics level and the highest ratio allowed back. */
export interface Rung {
  ratio: number
  quality: Level
  ceiling: number
}

export interface Ladder extends Rung {
  /** No more steps down in this world: the last one did not help. */
  capped: boolean
  /** The step just taken, until the next window judges it: where it came from and the frame rate there. */
  trial: { from: Rung; fps: number } | null
  /** No step up before this time (ms). */
  raiseAfter: number
}

/** Below this frame rate the ladder steps down; above FAST_FPS it may step back up (to its ceiling). */
export const SLOW_FPS = 45
export const FAST_FPS = 58
/** A step down must raise the frame rate this much to stay. */
export const MIN_IMPROVEMENT = 1.1
/** Measured frames per decision (ms), and the longest interval that counts as a frame. */
export const WINDOW_MS = 3000
export const MAX_FRAME_GAP_MS = 250
/** Between steps up (ms). */
export const RAISE_WAIT_MS = 10_000
/** Auto graphics step down to Medium only at or below this pixel ratio. */
export const AUTO_QUALITY_RATIO = 1.25
/** Auto's rungs below 1 ×, and its floor. */
const BELOW_ONE = [0.85, 0.75]
export const MIN_RATIO = BELOW_ONE[BELOW_ONE.length - 1]
const STEP = 0.25

/** The next rung down from `rung`, or null at the bottom. `auto`: Auto graphics (quality and below 1 × too). */
export function stepDown(rung: Rung, auto: boolean): Rung | null {
  const { ratio, quality, ceiling } = rung
  if (auto && quality === 'high' && ratio <= AUTO_QUALITY_RATIO) return { ratio, quality: 'medium', ceiling }
  if (ratio > 1) {
    const next = Math.max(1, ratio - STEP)
    return { ratio: next, quality, ceiling: next }
  }
  if (!auto) return null
  for (const next of BELOW_ONE) if (ratio > next) return { ratio: next, quality, ceiling: next }
  if (quality !== 'low') return { ratio, quality: 'low', ceiling }
  return null
}

/** The next ratio up from `ratio`, no higher than `max`. */
export function stepUp(ratio: number, max: number): number {
  const below = [...BELOW_ONE].reverse().find(r => r > ratio)
  const next = ratio < 1 ? below ?? 1 : ratio + STEP
  return Math.min(max, next)
}

/**
 * One window's decision: `fps` measured over it; `limit` the highest ratio
 * the device and its profile allow (budget.ts, devicePixelRatio).
 */
export function adapt(state: Ladder, fps: number, { auto, limit, now }: { auto: boolean; limit: number; now: number }): Ladder {
  let s = state
  if (s.trial) {
    const { from, fps: before } = s.trial
    // It did not help: back to where it was, and no further down in this world.
    if (fps < before * MIN_IMPROVEMENT) return { ...s, ...from, capped: true, trial: null }
    s = { ...s, trial: null }
  }
  if (fps < SLOW_FPS) {
    const next = s.capped ? null : stepDown(s, auto)
    return next ? { ...s, ...next, trial: { from: { ratio: s.ratio, quality: s.quality, ceiling: s.ceiling }, fps } } : s
  }
  const max = Math.min(s.ceiling, limit)
  if (fps > FAST_FPS && s.ratio < max && now > s.raiseAfter) return { ...s, ratio: stepUp(s.ratio, max), raiseAfter: now + RAISE_WAIT_MS }
  return s
}

/**
 * The frame rate over windows of real frame intervals. An interval over
 * MAX_FRAME_GAP_MS (the tab or app in the background, a stall) is left out:
 * it is not the rate frames are drawn at.
 */
export class FrameWindow {
  private last: number | null = null
  private time = 0
  private frames = 0

  constructor(private spanMs = WINDOW_MS, private maxGapMs = MAX_FRAME_GAP_MS) {}

  /** Start again (from the next frame). */
  reset() {
    this.last = null
    this.time = 0
    this.frames = 0
  }

  /** A frame drawn at `now` (ms): the frame rate once the window holds `spanMs` of frames (then a new one starts), else null. */
  add(now: number): number | null {
    const last = this.last
    this.last = now
    if (last === null) return null
    const dt = now - last
    if (!(dt > 0) || dt > this.maxGapMs) return null
    this.time += dt
    this.frames++
    if (this.time < this.spanMs) return null
    const fps = this.frames * 1000 / this.time
    this.time = 0
    this.frames = 0
    return fps
  }
}
