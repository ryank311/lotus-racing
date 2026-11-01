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

/** One stretch of a stitched lap: this split, played from this lap. */
export interface StitchPiece { id: string; startM: number; endM: number; trace: CarTrace; timeS: number }

export interface StitchedLap {
  pieces: StitchPiece[]
  // The pieces end to end, for the charts (its videoT jumps at each cut, so
  // never look distances up from it: use the pieces).
  trace: CarTrace
  timeS: number
  // The laps it is made of, by index.
  laps: number[]
}

const lastDist = (t: CarTrace) => t.dist[t.dist.length - 1] ?? 0

/**
 * The optimal lap on one video, as Garmin builds it: every split from
 * whichever lap went through it fastest. Laps in the same video only, so the
 * player can cut between them by seeking. Null without at least two laps or
 * when a split is on none of them.
 */
export function stitchOptimalLap(traces: CarTrace[], splits: Array<{ id: string; startM: number; endM: number }>): StitchedLap | null {
  if (!splits.length) return null
  const byVideo = new Map<string, CarTrace[]>()
  for (const t of traces) if (t.videoT.some(v => v != null)) byVideo.set(t.videoId, [...(byVideo.get(t.videoId) ?? []), t])
  const group = [...byVideo.values()].sort((a, b) => b.length - a.length)[0] ?? []
  if (group.length < 2) return null
  const pieces: StitchPiece[] = []
  const ordered = [...splits].sort((a, b) => a.startM - b.startM)
  for (const [i, split] of ordered.entries()) {
    let best: StitchPiece | null = null
    for (const trace of group) {
      // The lap's own first and last metres stand in for the lap's ends.
      const startM = i === 0 ? Math.max(split.startM, trace.dist[0] ?? 0) : split.startM
      const endM = i === ordered.length - 1 ? Math.min(split.endM, lastDist(trace)) : split.endM
      const a = videoTimeAt(trace, startM), b = videoTimeAt(trace, endM)
      if (a == null || b == null || b <= a) continue
      if (!best || b - a < best.timeS) best = { id: split.id, startM: split.startM, endM: split.endM, trace, timeS: b - a }
    }
    if (!best) return null
    pieces.push(best)
  }
  const first = group[0]
  const trace: CarTrace = { sg: first.sg, lapIdx: -1, videoId: first.videoId, dist: [], videoT: [], throttle: [], brake: [], rpm: [], gear: [], steering: [], slip: [], speed: [] }
  const channels = ['videoT', 'throttle', 'brake', 'rpm', 'gear', 'steering', 'slip', 'speed'] as const
  for (const [k, piece] of pieces.entries()) {
    const last = k === pieces.length - 1
    piece.trace.dist.forEach((d, i) => {
      if (d < piece.startM || (last ? d > piece.endM : d >= piece.endM)) return
      trace.dist.push(d)
      for (const c of channels) trace[c].push(piece.trace[c][i])
    })
  }
  return {
    pieces, trace,
    timeS: pieces.reduce((n, p) => n + p.timeS, 0),
    laps: [...new Set(pieces.map(p => p.trace.lapIdx))].sort((a, b) => a - b),
  }
}

/** Index of the piece that holds a distance. */
export function pieceAt(pieces: StitchPiece[], distM: number): number {
  const i = pieces.findIndex(p => distM < p.endM)
  return i < 0 ? pieces.length - 1 : i
}

/** Video time at a distance on a stitched lap. */
export function stitchedTimeAt(pieces: StitchPiece[], distM: number): number | null {
  const p = pieces[pieceAt(pieces, distM)]
  return p ? videoTimeAt(p.trace, Math.min(Math.max(distM, p.startM), Math.min(p.endM, lastDist(p.trace)))) : null
}

/** Where a piece starts and ends in the video. */
export function pieceSpan(p: StitchPiece): [number, number] | null {
  const a = videoTimeAt(p.trace, Math.max(p.startM, p.trace.dist[0] ?? 0)), b = videoTimeAt(p.trace, Math.min(p.endM, lastDist(p.trace)))
  return a == null || b == null ? null : [a, b]
}

/** Seconds into the stitched lap at this video time in piece `index`. */
export function stitchedElapsed(pieces: StitchPiece[], index: number, videoT: number): number | null {
  const span = pieceSpan(pieces[index])
  if (!span) return null
  return pieces.slice(0, index).reduce((n, p) => n + p.timeS, 0) + Math.max(0, videoT - span[0])
}

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
