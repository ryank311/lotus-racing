// Preload script — exposes a typed window.catalyst bridge to the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  CatalystBridge,
  BriefOptions,
  WorkerEvent,
} from '../shared/types.js'

const bridge: CatalystBridge = {
  getAuthState: () => ipcRenderer.invoke('auth:state'),
  getSyncStats: () => ipcRenderer.invoke('auth:syncStats'),
  getAccountEmail: () => ipcRenderer.invoke('auth:email'),
  saveCredentials: (email, password) => ipcRenderer.invoke('auth:saveCredentials', email, password),
  clearTokens: () => ipcRenderer.invoke('auth:clearTokens'),
  signIn: () => ipcRenderer.invoke('auth:signIn'),

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

  listBriefs: () => ipcRenderer.invoke('briefs:list'),
  readBrief: p => ipcRenderer.invoke('briefs:read', p),
  generateBrief: (opts: BriefOptions) => ipcRenderer.invoke('briefs:generate', opts),
  revealInFinder: p => ipcRenderer.invoke('shell:reveal', p),

  startSync: (opts?: { token?: string; accountLabel?: string }) => ipcRenderer.invoke('worker:startSync', opts),
  startLoad: () => ipcRenderer.invoke('worker:startLoad'),
  onWorker: cb => {
    const handler = (_e: unknown, evt: WorkerEvent) => cb(evt)
    ipcRenderer.on('worker:event', handler)
    return () => ipcRenderer.off('worker:event', handler)
  },

  buildAnalysis: (sessionGuids: string[]) => ipcRenderer.invoke('analysis:build', sessionGuids),
}

contextBridge.exposeInMainWorld('catalyst', bridge)
