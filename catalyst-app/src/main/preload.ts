// Preload script — exposes a typed window.catalyst bridge to the renderer.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CatalystBridge,
  BriefOptions,
  WorkerEvent,
  CoachOptions,
  AiSettings,
} from '../shared/types.js'
import type { UnitSystem } from '../shared/units.js'
import type { LapFilter } from '../shared/coachingScope.js'
import type { TerrainInfo } from '../shared/replay.js'

// Binary IPC replies arrive as an ArrayBuffer or a view (a Node Buffer
// becomes a Uint8Array): a standalone copy of the bytes either way.
function ownBuffer(value: unknown): ArrayBuffer {
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
  if (value instanceof ArrayBuffer) return value
  return new Uint8Array(value as ArrayBuffer).slice().buffer
}

const bridge: CatalystBridge = {
  getSessionReview: guid => ipcRenderer.invoke('review:get', guid),
  ensureSessionReview: (guid, retry) => ipcRenderer.invoke('review:ensure', guid, retry),
  getProgress: filters => ipcRenderer.invoke('review:progress', filters),
  updateReviewConditions: (guid, value) => ipcRenderer.invoke('review:conditions', guid, value),
  setReviewLapExcluded: (guid, index, excluded, reason) => ipcRenderer.invoke('review:excludeLap', guid, index, excluded, reason),
  onReviewStatus: cb => {
    const listener = (_event: unknown, event: import('../shared/review.js').ReviewStatus) => cb(event)
    ipcRenderer.on('review:event', listener)
    return () => ipcRenderer.off('review:event', listener)
  },
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  getSessionFocus: guid => ipcRenderer.invoke('focus:forSession', guid),
  getSessionNotes: guid => ipcRenderer.invoke('notes:get', guid),
  saveSessionNotes: (guid, notes) => ipcRenderer.invoke('notes:save', guid, notes),
  listAiContextFiles: profileName => ipcRenderer.invoke('profiles:aiContext', profileName),
  setAiContextFile: (profileName, fileName, included) => ipcRenderer.invoke('profiles:setAiContext', profileName, fileName, included),
  getTrackComplexes: meanLineGuid => ipcRenderer.invoke('tracks:complexes', meanLineGuid),
  saveTrackComplexes: (meanLineGuid, complexes) => ipcRenderer.invoke('tracks:saveComplexes', meanLineGuid, complexes),
  regenerateTrackComplexes: meanLineGuid => ipcRenderer.invoke('tracks:regenerateComplexes', meanLineGuid),
  getAuthState: () => ipcRenderer.invoke('auth:state'),
  getSyncStats: () => ipcRenderer.invoke('auth:syncStats'),
  getAccountEmail: () => ipcRenderer.invoke('auth:email'),
  saveCredentials: (email, password) => ipcRenderer.invoke('auth:saveCredentials', email, password),
  clearTokens: () => ipcRenderer.invoke('auth:clearTokens'),
  signInWithCreds: (email: string, password: string) =>
    ipcRenderer.invoke('auth:signInWithCreds', email, password),
  signInMfa: (sessionId: string, code: string) =>
    ipcRenderer.invoke('auth:signInMfa', sessionId, code),
  cancelMfa: (sessionId: string) => ipcRenderer.invoke('auth:cancelMfa', sessionId),

  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  getActiveProfile: () => ipcRenderer.invoke('profiles:active'),
  setActiveProfile: name => ipcRenderer.invoke('profiles:setActive', name),
  readCarMd: name => ipcRenderer.invoke('profiles:readCarMd', name),
  writeCarMd: (profileName, fileName, content) =>
    ipcRenderer.invoke('profiles:writeCarMd', profileName, fileName, content),
  listProfileFiles: name => ipcRenderer.invoke('profiles:files', name),
  readProfileFile: p => ipcRenderer.invoke('profiles:readFile', p),

  listSessions: (accountLabel?: string | null) => ipcRenderer.invoke('db:listSessions', accountLabel),
  ensureSessions: (guids, opts) => ipcRenderer.invoke('db:ensureSessions', guids, opts),
  hasDb: () => ipcRenderer.invoke('db:hasDb'),
  listVehicles: () => ipcRenderer.invoke('db:listVehicles'),
  setVehicleProfile: (vehicleGuid: string, profileName: string | null) =>
    ipcRenderer.invoke('profiles:setVehicleProfile', vehicleGuid, profileName),
  resolveProfileForVehicle: (vehicleGuid: string | null, make: string | null) =>
    ipcRenderer.invoke('profiles:resolveForVehicle', vehicleGuid, make),
  importContextFile: (profileName: string, sourcePath: string, destName: string, contentBase64?: string) =>
    ipcRenderer.invoke('profiles:importContextFile', profileName, sourcePath, destName, contentBase64),
  deleteContextFile: (profileName: string, fileName: string) =>
    ipcRenderer.invoke('profiles:deleteContextFile', profileName, fileName),
  ensureProfile: (name: string, vehicleGuid?: string) =>
    ipcRenderer.invoke('profiles:ensureProfile', name, vehicleGuid),

  listBriefs: () => ipcRenderer.invoke('briefs:list'),
  readBrief: p => ipcRenderer.invoke('briefs:read', p),
  listResults: () => ipcRenderer.invoke('results:list'),
  readResult: (p: string) => ipcRenderer.invoke('results:read', p),
  generateBrief: (opts: BriefOptions) => ipcRenderer.invoke('briefs:generate', opts),
  revealInFinder: p => ipcRenderer.invoke('shell:reveal', p),

  startSync: opts => ipcRenderer.invoke('worker:startSync', opts),
  startLoad: () => ipcRenderer.invoke('worker:startLoad'),
  onWorker: cb => {
    const handler = (_e: unknown, evt: WorkerEvent) => cb(evt)
    ipcRenderer.on('worker:event', handler)
    return () => ipcRenderer.off('worker:event', handler)
  },
  onLog: cb => {
    const handler = (_e: unknown, msg: { level: string; message: string; ts: number }) => cb(msg)
    ipcRenderer.on('app:log', handler)
    return () => ipcRenderer.off('app:log', handler)
  },
  onSaveRequest: cb => {
    const handler = () => cb()
    ipcRenderer.on('app:save', handler)
    return () => ipcRenderer.off('app:save', handler)
  },

  buildAnalysis: (sessionGuids: string[], units?: UnitSystem, lapFilter?: LapFilter, comparisons?) =>
    ipcRenderer.invoke('analysis:build', sessionGuids, units, lapFilter, comparisons),
  // Other drivers come from the local Catalyst server the app starts.
  listDrivers: () => ipcRenderer.invoke('drivers:list'),
  listDriverSessions: driver => ipcRenderer.invoke('drivers:sessions', driver),

  // AI Coach
  runCoach: (opts: CoachOptions) => ipcRenderer.invoke('coach:run', opts),
  listCoachSessions: () => ipcRenderer.invoke('coach:list'),
  getCoachSession: (id: string) => ipcRenderer.invoke('coach:get', id),
  deleteCoachSession: (id: string) => ipcRenderer.invoke('coach:delete', id),
  getAiSettings: () => ipcRenderer.invoke('ai:getSettings'),
  saveAiSettings: (s: AiSettings) => ipcRenderer.invoke('ai:saveSettings', s),

  // Units (Metric vs Imperial)
  getUnits: () => ipcRenderer.invoke('units:get'),
  setUnits: (system: UnitSystem) => ipcRenderer.invoke('units:set', system),

  // Account / driver totals
  getAccountStats: () => ipcRenderer.invoke('account:stats'),

  // Tracks editor
  listTracks: () => ipcRenderer.invoke('tracks:listAll'),
  getTrack: (meanLineGuid: string) => ipcRenderer.invoke('tracks:get', meanLineGuid),
  saveTrackCorners: (opts: { meanLineGuid: string; corners: any[] }) =>
    ipcRenderer.invoke('tracks:saveCorners', opts),

  // PDR videos: the desktop app copies the picked file into the workspace.
  listVideos: () => ipcRenderer.invoke('videos:listAll'),
  listSessionVideos: guid => ipcRenderer.invoke('videos:list', guid),
  importVideo: async (file, opts) => {
    opts?.onProgress?.(0, file.size, 'uploading')
    const sourcePath = webUtils.getPathForFile(file)
    opts?.onProgress?.(file.size, file.size, 'matching')
    return ipcRenderer.invoke('videos:importPath', sourcePath, file.name, opts?.sessionGuid ?? null, opts?.catalystPath ?? null)
  },
  matchVideo: (id, guid) => ipcRenderer.invoke('videos:match', id, guid ?? null),
  deleteVideo: id => ipcRenderer.invoke('videos:delete', id),
  setVideoOffset: (id, offsetS) => ipcRenderer.invoke('videos:setOffset', id, offsetS),
  getSessionCarData: guid => ipcRenderer.invoke('videos:carData', guid),
  videoUrl: (id, driver) => driver
    ? `catalyst-video://driver/${encodeURIComponent(driver)}/${encodeURIComponent(id)}.mp4`
    : `catalyst-video://video/${encodeURIComponent(id)}.mp4`,
  planCatalystImport: entries => ipcRenderer.invoke('videos:catalystPlan', entries),

  // 3D replay. Terrain builds in the main process; this polls like the web.
  getReplayScene: guid => ipcRenderer.invoke('replay:scene', guid),
  getReplayLap: (sceneGuid, ref) => ipcRenderer.invoke('replay:lap', sceneGuid, ref),
  getTerrain: async (area, onState) => {
    let reported = false
    for (;;) {
      const status = await ipcRenderer.invoke('terrain:get', area) as { state: 'building' | 'ready'; terrain?: TerrainInfo }
      if (status.state === 'ready' && status.terrain) { onState?.('ready'); return status.terrain }
      if (!reported) { onState?.('building'); reported = true }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  },
  getTerrainGrid: async key => new Float32Array(ownBuffer(await ipcRenderer.invoke('terrain:grid', key))),
  getTerrainImage: async key => new Blob([ownBuffer(await ipcRenderer.invoke('terrain:image', key))], { type: 'image/jpeg' }),
  sampleTerrain: async (key, latLon) => new Float32Array(ownBuffer(await ipcRenderer.invoke('terrain:sample', key, latLon.slice().buffer))),
  listCarModels: () => ipcRenderer.invoke('carModels:list'),
  getCarModel: async id => ownBuffer(await ipcRenderer.invoke('carModels:get', id)),
  uploadCarModel: async (file, meta, onProgress) => {
    onProgress?.(0, file.size)
    const model = await ipcRenderer.invoke('carModels:importPath', webUtils.getPathForFile(file), file.name, meta)
    onProgress?.(file.size, file.size)
    return model
  },
  updateCarModel: (id, patch) => ipcRenderer.invoke('carModels:update', id, patch),
  deleteCarModel: async id => { await ipcRenderer.invoke('carModels:delete', id) },
  listTrackModels: () => ipcRenderer.invoke('trackModels:list'),
  getTrackModelFile: async (id, file) => ownBuffer(await ipcRenderer.invoke('trackModels:get', id, file)),
}

contextBridge.exposeInMainWorld('catalyst', bridge)
