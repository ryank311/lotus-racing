// Deterministic app data: navigation tests never touch a driver's database.
const report = { id: 'report-1', title: 'Brake earlier at Oak Tree', profile_name: 'Lotus', model_used: 'test', created_at: '2026-09-18', session_guids: ['s1'], prompt: 'Test\n_Laps: Top 3 fastest across selected sessions_', raw_response: '', parsed_result: {
  headline: 'Brake earlier at Oak Tree', strengths: ['Consistent exits through the esses'],
  tips: Array.from({ length: 8 }, (_, i) => ({ section: `T${i + 1}`, body: 'Brake smoothly and release pressure as you turn. Keep your eyes on the exit.', priority: 1 })),
  next_session_plan: [{ run: 'Run 1', focus: 'Practice consistent braking', success_metric: 'Repeat within two metres' }], drills: ['Repeat the braking marker for three laps'],
} }
const rows = Array.from({ length: 35 }, (_, i) => ({ session_guid: `s${i + 1}`, session_start: `2026-09-${String(30 - i % 28).padStart(2, '0')}`, track_name: 'VIR', vehicle_guid: 'v1', vehicle_make: 'Lotus', lap_count: 10, best_lap_ms: 90000, details_loaded: true }))
let documentText = 'Original vehicle notes'
let worker: ((event: unknown) => void) | undefined
const bridge = {
  getAuthState: async () => ({ tokenValid: true }),
  getSyncStats: async () => ({ sessionCount: rows.length, lapCount: 350, trackCount: 1, sampleCount: 1000 }),
  getUnits: async () => 'imperial', setUnits: async () => {},
  getAiSettings: async () => ({ provider: 'anthropic', hasAnthropicApiKey: true }),
  listSessions: async () => rows, hasDb: async () => true,
  onLog: () => () => {}, onWorker: (callback: typeof worker) => { worker = callback; return () => {} }, onSaveRequest: () => () => {},
  listCoachSessions: async () => [report], getCoachSession: async (id: string) => id === report.id ? report : null,
  listVehicles: async () => [{ vehicleGuid: 'v1', make: 'Lotus', model: 'Exige', sessionCount: 35, profile: 'Lotus' }],
  listProfiles: async () => [{ name: 'Lotus' }],
  listProfileFiles: async () => [{ name: 'Car.md', path: '/test/Car.md' }],
  readProfileFile: async () => documentText,
  writeCarMd: async (_profile: string, _path: string, content: string) => { documentText = content },
  listTracks: async () => [{ trackName: 'VIR', configName: 'Full', meanLineGuid: 'layout-1', meanLineExists: true, sessionCount: 35 }],
  getTrack: async (id: string) => id === 'layout-1' ? { yamlPath: '/test/vir.yaml', yamlExists: true, geometry: null, corners: [] } : null,
  buildAnalysis: async () => { throw new Error('Fixture: analysis unavailable') },
}
;(window as any).catalyst = bridge
;(window as any).completeCoach = () => worker?.({ type: 'done', kind: 'coach', payload: report.id })
await import('../../src/renderer/main')
