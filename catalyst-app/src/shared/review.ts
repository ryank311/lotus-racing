/** Review storage and transport use SI units: milliseconds, metres, m/s, °C. */
export type Surface = 'dry' | 'damp' | 'wet' | 'mixed' | 'unknown'
export const SURFACES: Surface[] = ['dry', 'damp', 'wet', 'mixed', 'unknown']
export type ReviewMetric = 'timeMs' | 'vminMps' | 'vminDistanceM' | 'entryMps' | 'exitMps' | 'topSpeedMps' | 'consistencyMs'
export const REVIEW_METRICS: ReviewMetric[] = ['timeMs', 'vminMps', 'vminDistanceM', 'entryMps', 'exitMps', 'topSpeedMps', 'consistencyMs']
export type RegionKind = 'corner' | 'segment'
export interface ReviewRegion { id: string; name: string; kind: RegionKind; startM: number; endM: number }
export interface RegionMeasurement {
  timeMs: number | null; vminMps: number | null; vminDistanceM: number | null
  entryMps: number | null; exitMps: number | null; topSpeedMps: number | null
}
export interface ReviewLap {
  index: number; durationMs: number; eligible: boolean; reasons: string[]
  excluded: boolean; exclusionReason: string | null; selected: boolean; representative: boolean
  topSpeedMps: number | null; topSpeedDistanceM: number | null
  regions: Record<string, RegionMeasurement>
}
export interface RegionAggregate extends ReviewRegion, RegionMeasurement {
  count: number; consistencyMs: number | null; bestTimeMs: number | null
}
export interface ReviewConditions {
  weather: string | null; originalTemperatureC: number | null
  surface: Surface; temperatureC: number | null
  surfaceSource: 'estimated' | 'corrected' | 'unknown'; temperatureSource: 'recorded' | 'corrected'
  correctedAt: string | null
}
export interface ReviewSummary {
  sessionGuid: string; start: string | null; track: string; layout: string; vehicle: string
  account: string | null; vehicleGuid: string | null; configurationId: number | null
  cartographyId: number | null; reverse: boolean | null; direction: string | null
  meanLineGuid: string | null; geometryRevision: string; sourceRevision: string
  conditions: ReviewConditions; fastLapCount: number; eligibleLapCount: number; representativeCount: number
  paceMs: number | null; bestLapMs: number | null; consistencyMs: number | null
  topSpeedMps: number | null; peakSpeedMps: number | null; peakSpeedLap: number | null; peakSpeedDistanceM: number | null
  regions: RegionAggregate[]; qualityNotes: string[]
}
export interface ReviewAggregate {
  version: number; revision: string; summary: ReviewSummary; laps: ReviewLap[]
  map: Array<{ dist: number; x: number; y: number }>
}
export interface MetricComparison {
  current: number | null; baseline: number | null; previous: number | null; personalBest: number | null
  delta: number | null; baselineCount: number; clearChange: 'gain' | 'regression' | null
}
export interface ReviewRegionComparison {
  region: RegionAggregate; metrics: Record<ReviewMetric, MetricComparison>
  baselineSessions: string[]
}
export interface ReviewSnapshot {
  revision: string; version: number; current: ReviewAggregate
  pace: MetricComparison; bestLap: MetricComparison; topSpeed: MetricComparison; consistency: MetricComparison
  baseline: ReviewSummary[]; history: ReviewSummary[]; regions: ReviewRegionComparison[]
  excludedSessions: Array<{ sessionGuid: string; start: string | null; reason: string }>
  coverage: { catalog: number; downloaded: number; processed: number; pending: number; failed: number }
}
export type ReviewState = 'pending' | 'processing' | 'ready' | 'failed' | 'needs-download'
export interface SessionReviewResponse {
  state: ReviewState; error: string | null; snapshot: ReviewSnapshot | null
  coaching: ReviewCoachingReport | null; coachingStale: boolean
}
export interface ReviewStatus { sessionGuid: string; state: ReviewState; error?: string }
export interface ConditionOverride { surface: Surface | null; temperatureC: number | null }
export interface ProgressFilters {
  vehicleGuid?: string; configurationId?: number; cartographyId?: number
  account?: string; reverse?: boolean; direction?: string | null
  /** Omit temperatureC to include all temperatures; when set, match within ±5°C. */
  surface?: Surface; temperatureC?: number; anchorSessionGuid?: string
}
export interface ProgressResponse {
  filters: ProgressFilters; available: ReviewSummary[]; sessions: ReviewSummary[]
  references: Array<{ sessionGuid: string; baselineMs: number | null; priorBestMs: number | null }>
  coverage: ReviewSnapshot['coverage']
}
export interface ReviewCoachResult {
  summary: string; strengths: string[]; regressions: string[]
  priorities: Array<{ ref: string; advice: string; evidence: string[]; cue: string; successMetric: string }>
  limitations: string[]
}
export interface ReviewCoachingReport {
  id: string; sessionGuid: string; revision: string; createdAt: string; model: string; units: string
  result: ReviewCoachResult | null; error: string | null
  evidence: Record<string, string>
}
