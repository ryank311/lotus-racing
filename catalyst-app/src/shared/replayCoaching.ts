// Coaching drawn in the 3D replay (replay:coaching): what the coach and the
// session's own data say about each corner, anchored by distance along the
// session's mean line (the replay scene's metres), with the brake, minimum
// speed and throttle points of every valid lap and of the best pass, and
// suggested lines as lat/lon. Built by src/garmin/replayCoaching.ts, drawn by
// src/renderer/replay/coachOverlay.ts.

import type { FocusVerdict } from './types.js'
import type { UnitSystem } from './units.js'

/**
 * Where a note comes from, most authoritative first: the AI coach (a Session
 * Review or Analysis report), the coach's previous focus measured on this
 * session, Session Review's comparison with matched sessions, and the
 * session's own laps (best pass against the median).
 */
export type ReplayCoachSource = 'coach' | 'focus' | 'review' | 'laps'
export const COACH_SOURCE_ORDER: ReplayCoachSource[] = ['coach', 'focus', 'review', 'laps']

/** loss: slower than usual · gain: quicker · coach: advice or a focus · note: time to find. */
export type ReplayCoachTone = 'loss' | 'gain' | 'coach' | 'note'

export interface ReplayCoachNote {
  source: ReplayCoachSource
  tone: ReplayCoachTone
  /** One short line for the label over the track and the callout. */
  headline: string
  /** The advice or the evidence, a sentence or two. */
  text: string
  verdict?: FocusVerdict
}

/** Where a lap braked, reached its minimum speed and picked up the throttle (metres along the mean line). */
export interface ReplayCoachMarks {
  brakeM: number | null
  vminM: number | null
  vminMps: number | null
  throttleM: number | null
  /** Time through the corner's window (from the braking zone to its exit), ms. */
  timeMs: number | null
}

/** A position the coach asks for: brake, apex or throttle here. */
export interface ReplayCoachTarget {
  kind: 'brake' | 'apex' | 'throttle'
  atM: number
  label: string
}

export interface ReplayCoachPoint {
  /** "corner:T11", "segment:S3" or "session". */
  id: string
  /** "T11", "S3"; "" for the session as a whole. */
  ref: string
  /** "T11 · Oak Tree Entry". */
  title: string
  /** The first note's: the most authoritative. */
  tone: ReplayCoachTone
  headline: string
  notes: ReplayCoachNote[]
  /** Null for a session-wide note (listed, not placed). */
  atM: number | null
  startM: number | null
  endM: number | null
  /** The corner's window: each lap's time and marks run over it. */
  windowM: [number, number] | null
  /** The best pass through the window among the session's representative laps. */
  reference: (ReplayCoachMarks & { lap: number; label: string }) | null
  /** Median window time over the representative laps, ms. */
  medianTimeMs: number | null
  /** Each valid lap's marks, by lap index ("0", "1"…). */
  laps: Record<string, ReplayCoachMarks>
  targets: ReplayCoachTarget[]
}

/** A line to compare with the driver's: lat/lon by distance along the mean line. */
export interface ReplayCoachLine {
  id: 'best-sectors' | 'coach'
  label: string
  detail: string
  dist: number[]
  lat: number[]
  lon: number[]
}

export interface ReplayCoachingSourceInfo {
  source: ReplayCoachSource
  label: string
  /** The saved report, for a link. */
  reportId?: string
  createdAt?: string
  /** The report was written for an older review of this session. */
  stale?: boolean
}

export interface ReplayCoaching {
  sessionGuid: string
  units: UnitSystem
  sources: ReplayCoachingSourceInfo[]
  /** Placed points by distance, then session-wide notes. */
  points: ReplayCoachPoint[]
  lines: ReplayCoachLine[]
}

export const emptyCoaching = (sessionGuid: string, units: UnitSystem): ReplayCoaching => ({ sessionGuid, units, sources: [], points: [], lines: [] })
