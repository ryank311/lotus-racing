// Preload script — exposes a typed window.catalyst bridge to the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  CatalystBridge,
  BriefOptions,
  WorkerEvent,
  CoachOptions,
  AiSettings,
} from '../shared/types.js'

const bridge: CatalystBridge = {
  getAuthState: () => ipcRenderer.invoke('auth:state'),
  getSyncStats: () => ipcRenderer.invoke('auth:syncStats'),
  getAccountEmail: () => ipcRenderer.invoke('auth:email'),
  saveCredentials: (email, password) => ipcRenderer.invoke('auth:saveCredentials', email, password),
  clearTokens: () => ipcRenderer.invoke('auth:clearTokens'),
  signIn: () => ipcRenderer.invoke('auth:signIn'),
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
  hasDb: () => ipcRenderer.invoke('db:hasDb'),
  listVehicles: () => ipcRenderer.invoke('db:listVehicles'),
  setVehicleProfile: (vehicleGuid: string, profileName: string | null) =>
    ipcRenderer.invoke('profiles:setVehicleProfile', vehicleGuid, profileName),
  resolveProfileForVehicle: (vehicleGuid: string | null, make: string | null) =>
    ipcRenderer.invoke('profiles:resolveForVehicle', vehicleGuid, make),
  importContextFile: (profileName: string, sourcePath: string, destName: string) =>
    ipcRenderer.invoke('profiles:importContextFile', profileName, sourcePath, destName),
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

  startSync: (opts?: { token?: string; accountLabel?: string }) => ipcRenderer.invoke('worker:startSync', opts),
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

  buildAnalysis: (sessionGuids: string[]) => ipcRenderer.invoke('analysis:build', sessionGuids),

  // AI Coach
  runCoach: (opts: CoachOptions) => ipcRenderer.invoke('coach:run', opts),
  listCoachSessions: () => ipcRenderer.invoke('coach:list'),
  getCoachSession: (id: string) => ipcRenderer.invoke('coach:get', id),
  deleteCoachSession: (id: string) => ipcRenderer.invoke('coach:delete', id),
  getAiSettings: () => ipcRenderer.invoke('ai:getSettings'),
  saveAiSettings: (s: AiSettings) => ipcRenderer.invoke('ai:saveSettings', s),

  // Tracks editor
  listTracks: () => ipcRenderer.invoke('tracks:listAll'),
  getTrack: (meanLineGuid: string) => ipcRenderer.invoke('tracks:get', meanLineGuid),
  saveTrackCorners: (opts: { yamlPath: string; meanLineGuid: string; corners: any[] }) =>
    ipcRenderer.invoke('tracks:saveCorners', opts),
}

contextBridge.exposeInMainWorld('catalyst', bridge)
