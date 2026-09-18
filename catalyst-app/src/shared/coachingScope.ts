import type { CoachingSession } from './types'

export type LapFilter = 'all' | 'top3' | 'top5' | 'top10'

// Saved reports already include this app-generated scope in their prompt.
// Reading it also restores the right filter for reports saved before this fix.
export function coachingLapFilter(session: Pick<CoachingSession, 'prompt'>): LapFilter {
  const match = session.prompt.split('\n')[1]?.match(/_Laps: Top (3|5|10) fastest across selected sessions_/)
  return match ? `top${match[1]}` as LapFilter : 'all'
}
