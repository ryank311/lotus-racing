// Keeping the picture-in-picture video at the 3D car's place (Hud.tsx
// PipVideo), as a plan per frame: where to seek and what rate to play at.
//
// Smooth (desktop, Android): small drift closes by running the video up to
// 25 % fast or slow; beyond 0.6 s it seeks.
//
// Steady (iOS and iPadOS, every browser there being WebKit): AVFoundation
// stalls the picture on each playbackRate change, and a seek costs up to a
// keyframe interval of decoding (seconds, in a long-GOP video) plus a range
// request. Nudging the rate every frame there freezes the video, and seeking
// at a small threshold chases its own delay: the replay runs on while the
// seek decodes, the video lands behind again and seeks again. So the video
// plays at the replay's rate, seeks only past a second of drift, aims ahead
// by the time its recent seeks took, waits for a seek to settle before
// another, and leaves a video that is still buffering alone.

/** The replay frame's part in it. */
export interface PipFrame {
  playing: boolean
  rate: number
}

/** The video element's part (HTMLVideoElement has these). */
export interface PipVideoState {
  currentTime: number
  readyState: number
  seeking: boolean
  playbackRate: number
}

export interface PipPlan {
  /** Seek to (s), or null. */
  seekTo: number | null
  /** Set playbackRate to, or null to leave it. */
  rate: number | null
}

/** Steady mode: seek only past this much drift while playing (s). */
export const STEADY_SEEK_S = 1
/** Steady mode: after a seek while playing, wait this long before another (ms). */
export const STEADY_SETTLE_MS = 1500
const SMOOTH_SEEK_S = 0.6
const PAUSED_SEEK_S = 0.02
// HTMLMediaElement.HAVE_METADATA, HAVE_FUTURE_DATA.
const HAVE_METADATA = 1, HAVE_FUTURE_DATA = 3

export class PipSync {
  /** Seconds a seek has been taking (steady mode aims ahead by it). */
  latencyS = 0.25
  private seekStartedMs: number | null = null
  private settleUntilMs = 0

  constructor(readonly steady: boolean) {}

  /** The plan for a frame with the video due at `targetS`. */
  plan(frame: PipFrame, targetS: number, video: PipVideoState, nowMs: number): PipPlan {
    const plan: PipPlan = { seekTo: null, rate: null }
    if (video.readyState < HAVE_METADATA || video.seeking) return plan
    const drift = video.currentTime - targetS
    if (!frame.playing) {
      if (Math.abs(drift) > PAUSED_SEEK_S) plan.seekTo = targetS
      return plan
    }
    if (!this.steady) {
      if (Math.abs(drift) > SMOOTH_SEEK_S) { plan.seekTo = targetS + 0.08 * frame.rate; plan.rate = frame.rate }
      else plan.rate = frame.rate * Math.min(1.25, Math.max(0.8, 1 - drift * 0.9))
      return plan
    }
    if (video.playbackRate !== frame.rate) plan.rate = frame.rate
    // Still buffering where it is: it catches up once it plays.
    if (video.readyState < HAVE_FUTURE_DATA) return plan
    if (Math.abs(drift) > STEADY_SEEK_S && nowMs >= this.settleUntilMs) plan.seekTo = targetS + this.latencyS * frame.rate
    return plan
  }

  /** A seek was issued (any: scrubbing too measures how long seeks take). */
  seeking(nowMs: number) { this.seekStartedMs = nowMs }

  /** The video's 'seeked' event. */
  seeked(nowMs: number, playing: boolean) {
    if (this.seekStartedMs != null) {
      const took = (nowMs - this.seekStartedMs) / 1000
      this.latencyS = Math.min(1.5, Math.max(0.05, 0.5 * this.latencyS + 0.5 * took))
      this.seekStartedMs = null
    }
    if (playing) this.settleUntilMs = nowMs + STEADY_SETTLE_MS
  }
}
