// Pure helpers over PDR car data: moving between a lap's distance and the
// video's time, chart series, and per-corner driver inputs.

import type { CarTrace } from '../../shared/pdr'

// Linear interpolation over paired arrays with gaps (nulls skipped).
function lookup(xs: Array<number | null>, ys: Array<number | null>, x: number): number | null {
  let lo = -1, hi = -1
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i]
    if (xi == null || ys[i] == null) continue
    if (xi <= x) lo = i
    if (xi >= x) { hi = i; break }
  }
  if (lo < 0 || hi < 0) return null
  if (lo === hi || xs[hi] === xs[lo]) return ys[lo]
  const f = (x - xs[lo]!) / (xs[hi]! - xs[lo]!)
  return ys[lo]! + (ys[hi]! - ys[lo]!) * f
}

/** Video time (s) at a distance on the lap, or null outside the video. */
export function videoTimeAt(trace: CarTrace, distM: number): number | null {
  return lookup(trace.dist, trace.videoT, distM)
}

/** Distance on the lap at a video time, or null when the video is not on this lap. */
export function distanceAt(trace: CarTrace, videoT: number): number | null {
  return lookup(trace.videoT, trace.dist, videoT)
}

/** The video time span a trace covers. */
export function videoSpan(trace: CarTrace): [number, number] | null {
  const times = trace.videoT.filter((t): t is number => t != null)
  return times.length ? [times[0], times[times.length - 1]] : null
}

export const traceKey = (t: { sg: string; lapIdx: number }) => `${t.sg}:${t.lapIdx}`

export type CarChannel = 'throttle' | 'brake' | 'rpm' | 'gear' | 'steering' | 'slip' | 'speed'

/** One channel as chart points, skipping gaps. */
export function channelPoints(trace: CarTrace, channel: CarChannel): { xs: number[]; ys: number[] } {
  const xs: number[] = [], ys: number[] = []
  const values = trace[channel]
  for (let i = 0; i < trace.dist.length; i++) {
    const v = values[i]
    if (v == null) continue
    xs.push(trace.dist[i]); ys.push(v)
  }
  return { xs, ys }
}

export interface CornerInputs {
  turn: string
  name: string
  // Metres before the apex where braking starts (positive = before).
  brakeOnM: number | null
  peakBrake: number | null
  // Seconds between releasing the brake and picking up the throttle.
  coastS: number | null
  // Metres after the apex where the throttle is back on (negative = before).
  throttleOnM: number | null
  minGear: number | null
  maxSteering: number | null
}

const BRAKE_ON = 5      // bar
const THROTTLE_ON = 20  // %

/**
 * Driver inputs through each corner on one lap: where braking starts, how
 * hard, any coasting between brake and throttle, and the throttle pickup.
 * A corner's window runs from the previous corner's apex (at most 350 m
 * back) to the next one (at most 250 m on).
 */
export function cornerInputs(trace: CarTrace, corners: Array<{ turn: string; name: string; apexM: number }>): CornerInputs[] {
  const sorted = [...corners].sort((a, b) => a.apexM - b.apexM)
  const timeAt = (i: number) => trace.videoT[i]
  return sorted.map((corner, k) => {
    const from = Math.max(corner.apexM - 350, k > 0 ? sorted[k - 1].apexM : -Infinity)
    const to = Math.min(corner.apexM + 250, k + 1 < sorted.length ? sorted[k + 1].apexM : Infinity)
    const idx: number[] = []
    for (let i = 0; i < trace.dist.length; i++) if (trace.dist[i] >= from && trace.dist[i] <= to) idx.push(i)
    const out: CornerInputs = { turn: corner.turn, name: corner.name, brakeOnM: null, peakBrake: null, coastS: null, throttleOnM: null, minGear: null, maxSteering: null }
    if (!idx.length) return out
    const before = idx.filter(i => trace.dist[i] <= corner.apexM)
    const onIdx = before.find(i => (trace.brake[i] ?? 0) >= BRAKE_ON)
    let releaseIdx: number | undefined
    if (onIdx != null) {
      out.brakeOnM = Math.round(corner.apexM - trace.dist[onIdx])
      const braking = idx.filter(i => i >= onIdx && trace.dist[i] <= corner.apexM + 60)
      out.peakBrake = Math.max(...braking.map(i => trace.brake[i] ?? 0))
      releaseIdx = braking.find((i, n) => n > 0 && (trace.brake[i] ?? 0) < 2)
    }
    const pickupFrom = releaseIdx ?? onIdx ?? idx[0]
    const pickup = idx.find(i => i >= pickupFrom && (trace.throttle[i] ?? 0) >= THROTTLE_ON && trace.dist[i] >= corner.apexM - 150)
    if (pickup != null) out.throttleOnM = Math.round(trace.dist[pickup] - corner.apexM)
    if (releaseIdx != null && pickup != null) {
      const a = timeAt(releaseIdx), b = timeAt(pickup)
      if (a != null && b != null) out.coastS = Math.max(0, Math.round((b - a) * 100) / 100)
    }
    const gears = idx.map(i => trace.gear[i]).filter((g): g is number => g != null && g > 0)
    out.minGear = gears.length ? Math.min(...gears) : null
    const steer = idx.map(i => trace.steering[i]).filter((s): s is number => s != null)
    out.maxSteering = steer.length ? Math.round(Math.max(...steer.map(Math.abs))) : null
    return out
  })
}
