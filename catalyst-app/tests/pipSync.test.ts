// The picture-in-picture video's sync (src/renderer/replay/pipSync.ts),
// simulated against a model of iOS WebKit's video: each playbackRate change
// stalls the picture, and a seek decodes from the previous keyframe (long
// GOPs: seconds) after a range request. The steady plan must keep the video
// moving and within about a second of the car; the smooth plan (desktop,
// Android) shows why it is not used there. On desktop the smooth plan must
// stay tight without changing playbackRate every frame.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PipSync, SMOOTH_DEADBAND_S, SMOOTH_RATE_STEP, STEADY_SEEK_S } from '../src/renderer/replay/pipSync'

interface Device {
  /** Picture frozen after a playbackRate change while playing (s). */
  rateStallS: number
  /** Seek time: fixed part (request, pipeline) plus decoding from the keyframe at this speed (× real time). */
  seekBaseS: number
  gopS: number
  decodeSpeed: number
}

const IOS: Device = { rateStallS: 0.15, seekBaseS: 0.25, gopS: 8.33, decodeSpeed: 10 }
const DESKTOP: Device = { rateStallS: 0, seekBaseS: 0.03, gopS: 8.33, decodeSpeed: 60 }

interface Result { frozenS: number; seeks: number; rateChanges: number; meanDriftS: number; maxDriftAfterStartS: number; rates: Set<number> }

/**
 * Plays a 120 s lap at rate 1 with 60 fps frames, a hitch of 0.3 s (frame
 * clamped to 0.1 s, so the replay loses 0.2 s against the video) every 7 s,
 * and a jump of the replay 30 s ahead at 60 s (a scrub while playing).
 * `jitterS`: the video's reported currentTime wanders by up to this much
 * either way (a browser's clock is coarse), from a fixed seed.
 */
function simulate(steady: boolean, device: Device, jitterS = 0): Result {
  const sync = new PipSync(steady)
  let seed = 7
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 * 2 - 1) * jitterS }
  const rates = new Set<number>()
  const video = { currentTime: 0, readyState: 4, seeking: false, playbackRate: 1 }
  let wall = 0, replay = 0, stallUntil = 0, seekDoneAt = 0, seekTo = 0
  let frozen = 0, seeks = 0, rateChanges = 0, driftSum = 0, frames = 0, maxDrift = 0
  const dt = 1 / 60
  while (wall < 120) {
    // The replay's clock: frames of 1/60 s, a hitch now and then (clamped to 0.1 s).
    let step = dt
    if (Math.floor((wall + dt) / 7) > Math.floor(wall / 7)) step = 0.1
    const hitch = step > dt ? 0.3 : dt
    wall += hitch
    replay += step
    if (wall >= 60 && wall - hitch < 60) replay += 30
    // The video in that time.
    const before = video.currentTime
    if (video.seeking) {
      if (wall >= seekDoneAt) {
        video.seeking = false
        video.currentTime = seekTo
        sync.seeked(wall * 1000, true)
      }
    } else if (wall >= stallUntil) video.currentTime += hitch * video.playbackRate
    if (video.currentTime === before) frozen += hitch
    // This frame's plan.
    const plan = sync.plan({ playing: true, rate: 1 }, replay, { ...video, currentTime: video.currentTime + noise() }, wall * 1000)
    if (plan.seekTo != null) {
      seeks++
      sync.seeking(wall * 1000)
      video.seeking = true
      seekTo = plan.seekTo
      const fromKeyframe = plan.seekTo % device.gopS
      seekDoneAt = wall + device.seekBaseS + fromKeyframe / device.decodeSpeed
    }
    if (plan.rate != null && plan.rate !== video.playbackRate) {
      rateChanges++
      rates.add(plan.rate)
      video.playbackRate = plan.rate
      stallUntil = wall + device.rateStallS
    }
    const drift = Math.abs(video.currentTime - replay)
    driftSum += drift; frames++
    if (wall > 3 && Math.abs(wall - 60) > 4) maxDrift = Math.max(maxDrift, drift)
  }
  return { frozenS: frozen, seeks, rateChanges, meanDriftS: driftSum / frames, maxDriftAfterStartS: maxDrift, rates }
}

test('on iOS the steady plan keeps the video moving and close to the car', () => {
  const smooth = simulate(false, IOS), steady = simulate(true, IOS)
  console.log('iOS model   smooth:', summary(smooth))
  console.log('iOS model   steady:', summary(steady))
  // Nudging the rate stalls the picture over and over.
  assert.ok(smooth.rateChanges > 100, `smooth changes the rate ${smooth.rateChanges} times`)
  assert.ok(steady.rateChanges === 0, 'steady never changes the rate at rate 1')
  assert.ok(steady.frozenS < smooth.frozenS / 4, `frozen ${steady.frozenS.toFixed(1)} s against ${smooth.frozenS.toFixed(1)} s`)
  assert.ok(steady.frozenS < 6, `frozen ${steady.frozenS.toFixed(1)} s of 120`)
  // A handful of seeks (the hitches add up to a second now and then, and the scrub), never a chase.
  assert.ok(steady.seeks <= 8, `${steady.seeks} seeks`)
  assert.ok(steady.maxDriftAfterStartS < STEADY_SEEK_S + 0.6, `drift up to ${steady.maxDriftAfterStartS.toFixed(2)} s`)
})

test('on desktop the smooth plan stays tight', () => {
  const smooth = simulate(false, DESKTOP)
  console.log('desktop model smooth:', summary(smooth))
  assert.ok(smooth.meanDriftS < 0.3)
  assert.ok(smooth.frozenS < 2)
})

test('on desktop the smooth plan changes the rate rarely, in steps', () => {
  for (const jitterS of [0, 0.005, 0.01]) {
    const smooth = simulate(false, DESKTOP, jitterS)
    console.log(`desktop model smooth, ±${jitterS * 1000} ms jitter:`, summary(smooth))
    // A few steps to close each hitch (17 in the lap), not one every frame (7200 frames).
    assert.ok(smooth.rateChanges <= 100, `${smooth.rateChanges} rate changes in 120 s`)
    assert.ok(smooth.meanDriftS < 0.12, `mean drift ${smooth.meanDriftS.toFixed(3)} s`)
    assert.ok(smooth.maxDriftAfterStartS < 0.35, `drift up to ${smooth.maxDriftAfterStartS.toFixed(2)} s`)
    for (const rate of smooth.rates) assert.ok(Math.abs(rate / SMOOTH_RATE_STEP - Math.round(rate / SMOOTH_RATE_STEP)) < 1e-9, `rate ${rate} is not a step`)
  }
})

test('smooth: within the dead band the video plays at exactly the replay rate', () => {
  const sync = new PipSync(false)
  const video = { currentTime: 10, readyState: 4, seeking: false, playbackRate: 1 }
  // In step: nothing to change.
  for (const drift of [0, 0.02, -0.03, SMOOTH_DEADBAND_S * 0.9]) {
    assert.equal(sync.plan({ playing: true, rate: 1 }, 10 - drift, video, 0).rate, null, `drift ${drift}`)
  }
  // Ahead by 0.1 s: a step slower, once; the same plan again changes nothing.
  const slower = sync.plan({ playing: true, rate: 1 }, 9.9, video, 0).rate
  assert.equal(slower, 0.9)
  assert.equal(sync.plan({ playing: true, rate: 1 }, 9.9, { ...video, playbackRate: slower! }, 0).rate, null)
  // Caught up: back to exactly the replay's rate.
  assert.equal(sync.plan({ playing: true, rate: 1 }, 9.99, { ...video, playbackRate: slower! }, 0).rate, 1)
  // A rate of its own (half speed) is played exactly too.
  assert.equal(new PipSync(false).plan({ playing: true, rate: 0.5 }, 10, video, 0).rate, 0.5)
})

test('paused, both seek straight to the frame', () => {
  for (const steady of [false, true]) {
    const sync = new PipSync(steady)
    const plan = sync.plan({ playing: false, rate: 1 }, 12.5, { currentTime: 10, readyState: 4, seeking: false, playbackRate: 1 }, 0)
    assert.equal(plan.seekTo, 12.5)
    assert.equal(plan.rate, null)
    // Nothing while a seek is under way or before the metadata.
    assert.equal(sync.plan({ playing: false, rate: 1 }, 12.5, { currentTime: 10, readyState: 4, seeking: true, playbackRate: 1 }, 0).seekTo, null)
    assert.equal(sync.plan({ playing: false, rate: 1 }, 12.5, { currentTime: 10, readyState: 0, seeking: false, playbackRate: 1 }, 0).seekTo, null)
  }
})

test('steady aims a seek ahead by how long seeks take, and waits for it to settle', () => {
  const sync = new PipSync(true)
  sync.seeking(0)
  sync.seeked(900, true)
  assert.ok(sync.latencyS > 0.5 && sync.latencyS < 0.6, `latency ${sync.latencyS}`)
  const video = { currentTime: 10, readyState: 4, seeking: false, playbackRate: 1 }
  // Within the settle time: no seek.
  assert.equal(sync.plan({ playing: true, rate: 1 }, 20, video, 1000).seekTo, null)
  const plan = sync.plan({ playing: true, rate: 1 }, 20, video, 2500)
  assert.ok(plan.seekTo != null && Math.abs(plan.seekTo - (20 + sync.latencyS)) < 1e-9)
  // Faster playback: the rate follows the replay's, once.
  assert.equal(sync.plan({ playing: true, rate: 2 }, 10.2, video, 3000).rate, 2)
  // Buffering where it is: no seek.
  assert.equal(sync.plan({ playing: true, rate: 1 }, 20, { ...video, readyState: 2 }, 5000).seekTo, null)
})

function summary({ rates, ...result }: Result): string {
  return JSON.stringify({ ...result, rates: [...rates].sort((a, b) => a - b) })
}
