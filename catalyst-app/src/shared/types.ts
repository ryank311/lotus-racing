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

export type WorkerKind = 'sync' | 'load' | 'brief'

export interface WorkerEvent {
  kind: WorkerKind
  type: 'log' | 'done' | 'error'
  payload?: string
}

export interface CarProfile {
  name: string
  dir: string
  carMdPath: string
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

  // Analysis (Plotly data)
  buildAnalysis(sessionGuids: string[]): Promise<AnalysisDataPayload>
}

declare global {
  interface Window {
    catalyst: CatalystBridge
  }
}
