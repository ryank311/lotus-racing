import type { CoachingSession } from './types'

// Which laps Analysis and coaching look at. Sessions usually hold five or
// six laps, so anything wider than these pulls in out-laps, in-laps and
// traffic. 'all' survives only for reports saved before the filter existed.
export type LapFilter = 'top10' | 'top5' | 'top3' | 'session-best' | 'top3-session' | 'all'

export interface LapFilterSpec {
  value: Exclude<LapFilter, 'all'>
  label: string
  // Completes "The charts now show …" and the coach packet's lap filter line.
  phrase: string
  limit: number
  perSession: boolean
}

export const LAP_FILTERS: readonly LapFilterSpec[] = [
  { value: 'top10', label: 'Top 10 overall', phrase: 'the 10 fastest laps overall', limit: 10, perSession: false },
  { value: 'top5', label: 'Top 5 overall', phrase: 'the 5 fastest laps overall', limit: 5, perSession: false },
  { value: 'top3', label: 'Top 3 overall', phrase: 'the 3 fastest laps overall', limit: 3, perSession: false },
  { value: 'session-best', label: 'Session bests', phrase: 'each session’s best lap', limit: 1, perSession: true },
  { value: 'top3-session', label: 'Top 3 / session', phrase: 'each session’s 3 fastest laps', limit: 3, perSession: true },
]
export const DEFAULT_LAP_FILTER: LapFilter = 'top10'
const ALL_LAPS = { label: 'All laps', phrase: 'all valid laps' }

export const isLapFilter = (value: unknown): value is LapFilter =>
  value === 'all' || LAP_FILTERS.some(f => f.value === value)
export const lapFilterSpec = (filter: LapFilter | null | undefined): LapFilterSpec | null =>
  LAP_FILTERS.find(f => f.value === filter) ?? null
export const lapFilterLabel = (filter: LapFilter) => (lapFilterSpec(filter) ?? ALL_LAPS).label
export const lapFilterPhrase = (filter: LapFilter) => (lapFilterSpec(filter) ?? ALL_LAPS).phrase

// Keeps the fastest laps the filter asks for, in their original order.
export function selectLaps<T extends { sg: string; durationMs: number }>(laps: T[], filter: LapFilter | null | undefined): T[] {
  const spec = lapFilterSpec(filter)
  if (!spec) return laps
  const groups = new Map<string, T[]>()
  for (const lap of laps) {
    const key = spec.perSession ? lap.sg : ''
    groups.set(key, [...(groups.get(key) ?? []), lap])
  }
  const kept = new Set<T>()
  for (const group of groups.values()) {
    for (const lap of [...group].sort((a, b) => a.durationMs - b.durationMs).slice(0, spec.limit)) kept.add(lap)
  }
  return laps.filter(lap => kept.has(lap))
}

// Reports record the lap filter they were generated with; older reports only
// carry it in their prompt header.
export function coachingLapFilter(session: Pick<CoachingSession, 'prompt'> & { parsed_result?: CoachingSession['parsed_result'] }): LapFilter {
  const saved = session.parsed_result?.context?.lapFilter
  if (isLapFilter(saved)) return saved
  const match = session.prompt.split('\n')[1]?.match(/_Laps: Top (3|5|10) fastest across selected sessions_/)
  return match ? `top${match[1]}` as LapFilter : 'all'
}
