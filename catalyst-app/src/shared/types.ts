// Shared types between main and renderer processes.

export interface SessionSummary {
  sessionGuid: string
  sessionStart?: string
  trackName?: string
  trackConfigurationName?: string
  trackConfigurationId?: number
  trackCartographyId?: number
  meanLineGuid?: string
  bestLap?: string
  bestLapNormal?: string
}

export interface AuthState {
  hasCatalystToken: boolean
  tokenExpiresAt: number | null
  hasGarthTokens: boolean
  tokenValid: boolean
  tokenDaysRemaining: number | null
}

export interface SyncStats {
  sessionCount: number       // rows in the `sessions` table (the source of truth)
  lapCount: number
  sampleCount: number
  trackCount: number         // distinct track configurations actually driven
  totalSizeBytes: number     // on-disk DB file size
  lastSyncEpoch: number | null
  lastSyncAgoHuman: string
}

export interface DbSessionRow {
  session_guid: string
  session_start: string | null
  track_name: string | null
  track_configuration_name: string | null
  best_lap_ms: number | null
  lap_count: number
  sample_count: number
  weather_description: string | null
  account: string | null
  vehicle_guid: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_year: number | null
  vehicle_type: string | null
}

// Distinct vehicles seen across the DB — used for the Sessions filter chips
// and the Garage mapping editor.
export interface VehicleSummary {
  vehicleGuid: string
  make: string | null
  model: string | null
  year: number | null
  sessionCount: number
  // Resolved profile (Lotus / Vette / …) — null if no match.
  profile: string | null
  // Whether the resolution came from an explicit user override (true) or a
  // fuzzy make-name fallback (false).
  explicit: boolean
}

export interface SignInResult {
  token: string
  expiresAt: number  // epoch seconds
}

// Credential sign-in returns either a final token OR a pending MFA challenge.
// In the MFA case, the renderer prompts the user for a code and follows up
// with signInMfa(sessionId, code).
export type SignInCredsResult =
  | { needsMfa: false; token: string; expiresAt: number }
  | { needsMfa: true; sessionId: string }

export interface LogLine {
  ts: number
  line: string
}

export type WorkerKind = 'sync' | 'load' | 'brief' | 'coach'

// Structured progress for the status bar. `current/total` drive the bar; the
// other fields populate the human-readable label. Emitted alongside `log`
// events so existing log consumers keep working unchanged.
export interface WorkerProgress {
  current: number          // 1-based session index (or 0 before sync starts)
  total: number            // total sessions to fetch (0 if not yet known)
  label: string            // short summary, e.g. "Virginia · Sat AM"
  fileName?: string        // last file written (weather.json, performance.pb…)
}

export interface WorkerEvent {
  kind: WorkerKind
  type: 'log' | 'done' | 'error' | 'progress'
  payload?: string
  progress?: WorkerProgress
}

export interface CarProfile {
  name: string
  dir: string
  carMdPath: string
}

// ─── AI Coach ──────────────────────────────────────────────────────────────

export type CoachAnnotationType = 'corner_tip' | 'segment_tip' | 'speed_annotation' | 'line_deviation'

export interface CoachAnnotation {
  type: CoachAnnotationType
  ref: string                       // 'T1'–'TN' for corners, 'S1'–'SN' for segments
  body: string
  actual_apex_dist_m?: number       // corner_tip: where driver apexed (m along track)
  recommended_apex_dist_m?: number  // corner_tip: where AI says apex should be
  actual_entry_mps?: number
  actual_apex_mps?: number
  actual_exit_mps?: number
  target_apex_mps?: number
  deviation_desc?: string
  severity?: 1 | 2 | 3             // 1=minor/cyan  2=moderate/amber  3=critical/signal
}

export interface CoachLineWaypoint {
  dist_m: number
  lateral_pos: number    // 0 = driver-left edge, 1 = driver-right edge
  note?: string
}

export interface CoachingResult {
  headline: string
  consistency_loss_ms: number
  tips: Array<{ section: string; body: string; annotations: CoachAnnotation[] }>
  drills: string[]
  annotations: CoachAnnotation[]   // flat list of all annotations across all tips
  coach_line?: CoachLineWaypoint[] // optional sparse AI-recommended line waypoints
}

export interface CoachingSession {
  id: string
  created_at: string
  session_guids: string[]
  profile_name: string
  model_used: string
  title: string
  prompt: string
  raw_response: string
  parsed_result: CoachingResult | null
}

export interface CoachOptions {
  profile: string
  scope: 'overview' | 'corner' | 'compare'
  sessionGuids: string[]
}

export interface AiSettings {
  harness: 'local' | 'remote'
  apiKey?: string
  model?: string
  maxTokens?: number
  stream?: boolean
}

export interface BriefOptions {
  profile: string
  scope: 'overview' | 'corner' | 'compare'
  mode: 'last' | 'selected' | 'all'
  lastN?: number
  sessionGuids?: string[]
  csv?: boolean
  includeGuides?: boolean
}

export interface BriefFile {
  name: string
  path: string
  sizeKb: number
  mtime: number
}

export interface LapRow {
  session_guid: string
  lap_index: number
  lap_type: string | null
  duration_ms: number | null
  max_speed: number | null
  max_lat_g: number | null
  max_long_accel: number | null
  min_long_accel: number | null
}

// Analysis page — chart-ready data shape.
// (Keeping it as `unknown` here so the renderer can import the rich types
// directly from src/garmin/analysisData.ts without main↔renderer drift.)
export type AnalysisDataPayload = unknown

// Tracks editor types — kept loose for the same reason as AnalysisDataPayload;
// the page imports concrete shapes from garmin/trackGeometry and trackYaml.
export type TrackGeometryDetailed = unknown
export type TrackCornerPayload = unknown
export interface TrackListEntry {
  trackName: string
  configName: string
  meanLineGuid: string | null
  sessionCount: number
  yamlPath: string | null
  yamlExists: boolean
  cornerCount: number
  meanLineExists: boolean
}
export interface TrackDetail {
  geometry: TrackGeometryDetailed
  yamlPath: string
  yamlExists: boolean
  corners: TrackCornerPayload[]
}

// Bridge exposed on window via preload.
export interface CatalystBridge {
  // Auth + state
  getAuthState(): Promise<AuthState>
  getSyncStats(): Promise<SyncStats>
  getAccountEmail(): Promise<string | null>
  saveCredentials(email: string, password: string): Promise<void>
  clearTokens(): Promise<void>
  signIn(): Promise<SignInResult>
  signInWithCreds(email: string, password: string): Promise<SignInCredsResult>
  signInMfa(sessionId: string, code: string): Promise<SignInResult>
  cancelMfa(sessionId: string): Promise<void>

  // Profiles
  listProfiles(): Promise<CarProfile[]>
  getActiveProfile(): Promise<string | null>
  setActiveProfile(name: string): Promise<void>
  readCarMd(name: string): Promise<string>
  writeCarMd(profileName: string, fileName: string, content: string): Promise<void>
  listProfileFiles(name: string): Promise<{ name: string; path: string }[]>
  readProfileFile(path: string): Promise<string>

  // Sessions / DB
  listSessions(accountLabel?: string | null): Promise<DbSessionRow[]>
  hasDb(): Promise<boolean>
  listVehicles(): Promise<VehicleSummary[]>
  setVehicleProfile(vehicleGuid: string, profileName: string | null): Promise<void>
  resolveProfileForVehicle(
    vehicleGuid: string | null,
    make: string | null,
  ): Promise<{ profile: string | null; explicit: boolean }>
  importContextFile(profileName: string, sourcePath: string, destName: string): Promise<void>
  deleteContextFile(profileName: string, fileName: string): Promise<void>
  ensureProfile(name: string, vehicleGuid?: string): Promise<CarProfile>

  // Briefs
  listBriefs(): Promise<BriefFile[]>
  readBrief(path: string): Promise<string>
  listResults(): Promise<BriefFile[]>
  readResult(path: string): Promise<string>
  generateBrief(opts: BriefOptions): Promise<{ outPath: string }>
  revealInFinder(path: string): Promise<void>

  // Long-running workers
  startSync(opts?: { token?: string; accountLabel?: string }): Promise<void>
  startLoad(): Promise<void>
  onWorker(cb: (evt: WorkerEvent) => void): () => void

  // AI Coach
  runCoach(opts: CoachOptions): Promise<{ sessionId: null }>
  listCoachSessions(): Promise<CoachingSession[]>
  getCoachSession(id: string): Promise<CoachingSession | null>
  deleteCoachSession(id: string): Promise<void>
  getAiSettings(): Promise<AiSettings>
  saveAiSettings(s: AiSettings): Promise<void>

  // Analysis (Plotly data)
  buildAnalysis(sessionGuids: string[]): Promise<AnalysisDataPayload>

  // Tracks editor
  listTracks(): Promise<TrackListEntry[]>
  getTrack(meanLineGuid: string): Promise<TrackDetail | null>
  saveTrackCorners(opts: {
    yamlPath: string
    meanLineGuid: string
    corners: TrackCornerPayload[]
  }): Promise<{ savedTo: string; cornerCount: number }>
}

declare global {
  interface Window {
    catalyst: CatalystBridge
  }
}
