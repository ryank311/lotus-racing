// Renderer transport. Electron uses the preload bridge; browsers use the
// server's JSON RPC + Server-Sent Events endpoints.

import type { CatalystBridge, WorkerEvent } from '../shared/types'
import type { UnitSystem } from '../shared/units'

const params = new URLSearchParams(window.location.search)
const configuredServer = params.get('catalystServer')
const forceRemote = params.get('remote') === '1' || configuredServer !== null

export const isRemote = forceRemote || typeof window.catalyst === 'undefined'
export const remoteBaseUrl = configuredServer?.replace(/\/$/, '') ?? window.location.origin

async function requestJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${remoteBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `Server request failed (${response.status})`)
  return payload
}

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const payload = await requestJson('/api/rpc', {
    method: 'POST', body: JSON.stringify({ channel, args }),
  })
  return payload.result as T
}

type EventListener = (payload: any) => void
const eventListeners = new Map<string, Set<EventListener>>()
let eventSource: EventSource | null = null

function subscribe(channel: string, listener: EventListener): () => void {
  let listeners = eventListeners.get(channel)
  if (!listeners) { listeners = new Set(); eventListeners.set(channel, listeners) }
  listeners.add(listener)
  if (!eventSource) {
    eventSource = new EventSource(`${remoteBaseUrl}/api/events`, { withCredentials: true })
    eventSource.onmessage = event => {
      try {
        const message = JSON.parse(event.data) as { channel: string; payload: unknown }
        for (const cb of eventListeners.get(message.channel) ?? []) cb(message.payload)
      } catch (error) {
        console.error('[server events]', error)
      }
    }
  }
  return () => {
    listeners!.delete(listener)
    if ([...eventListeners.values()].every(set => set.size === 0)) {
      eventSource?.close()
      eventSource = null
    }
  }
}

const remoteBridge: CatalystBridge = {
  getAuthState: () => rpc('auth:state'),
  getSyncStats: () => rpc('auth:syncStats'),
  getAccountEmail: () => rpc('auth:email'),
  saveCredentials: (email, password) => rpc('auth:saveCredentials', email, password),
  clearTokens: () => rpc('auth:clearTokens'),
  signIn: () => rpc('auth:signIn'),
  signInWithCreds: (email, password) => rpc('auth:signInWithCreds', email, password),
  signInMfa: (sessionId, code) => rpc('auth:signInMfa', sessionId, code),
  cancelMfa: sessionId => rpc('auth:cancelMfa', sessionId),

  listProfiles: () => rpc('profiles:list'),
  getActiveProfile: () => rpc('profiles:active'),
  setActiveProfile: name => rpc('profiles:setActive', name),
  readCarMd: name => rpc('profiles:readCarMd', name),
  writeCarMd: (profileName, fileName, content) => rpc('profiles:writeCarMd', profileName, fileName, content),
  listProfileFiles: name => rpc('profiles:files', name),
  readProfileFile: filePath => rpc('profiles:readFile', filePath),

  listSessions: accountLabel => rpc('db:listSessions', accountLabel),
  hasDb: () => rpc('db:hasDb'),
  listVehicles: () => rpc('db:listVehicles'),
  setVehicleProfile: (vehicleGuid, profileName) => rpc('profiles:setVehicleProfile', vehicleGuid, profileName),
  resolveProfileForVehicle: (vehicleGuid, make) => rpc('profiles:resolveForVehicle', vehicleGuid, make),
  importContextFile: (profileName, sourcePath, destName, contentBase64) =>
    rpc('profiles:importContextFile', profileName, sourcePath, destName, contentBase64),
  deleteContextFile: (profileName, fileName) => rpc('profiles:deleteContextFile', profileName, fileName),
  ensureProfile: (name, vehicleGuid) => rpc('profiles:ensureProfile', name, vehicleGuid),

  listBriefs: () => rpc('briefs:list'),
  readBrief: filePath => rpc('briefs:read', filePath),
  listResults: () => rpc('results:list'),
  readResult: filePath => rpc('results:read', filePath),
  generateBrief: opts => rpc('briefs:generate', opts),
  revealInFinder: filePath => rpc('shell:reveal', filePath),

  startSync: opts => rpc('worker:startSync', opts),
  startLoad: () => rpc('worker:startLoad'),
  onWorker: cb => subscribe('worker:event', cb as (evt: WorkerEvent) => void),
  onLog: cb => subscribe('app:log', cb),
  onSaveRequest: () => () => {},

  buildAnalysis: (sessionGuids: string[], units?: UnitSystem, lapLimit?: 3 | 5 | 10 | null) =>
    rpc('analysis:build', sessionGuids, units, lapLimit),
  runCoach: opts => rpc('coach:run', opts),
  listCoachSessions: () => rpc('coach:list'),
  getCoachSession: id => rpc('coach:get', id),
  deleteCoachSession: id => rpc('coach:delete', id),
  getAiSettings: () => rpc('ai:getSettings'),
  saveAiSettings: settings => rpc('ai:saveSettings', settings),
  getUnits: () => rpc('units:get'),
  setUnits: system => rpc('units:set', system),
  getAccountStats: () => rpc('account:stats'),
  listTracks: () => rpc('tracks:listAll'),
  getTrack: meanLineGuid => rpc('tracks:get', meanLineGuid),
  saveTrackCorners: opts => rpc('tracks:saveCorners', opts),
}

export const api: CatalystBridge = isRemote ? remoteBridge : window.catalyst

export async function getServerSession(): Promise<{ username: string } | null> {
  if (!isRemote) return null
  try { return await requestJson('/api/session') } catch { return null }
}

export function loginToServer(username: string): Promise<{ username: string }> {
  return requestJson('/api/login', { method: 'POST', body: JSON.stringify({ username }) })
}

export function logoutFromServer(): Promise<void> {
  eventSource?.close()
  eventSource = null
  return requestJson('/api/logout', { method: 'POST', body: '{}' })
}

export function humaniseBytes(n: number): string {
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (n < 1024) return unit === 'B' ? `${Math.round(n)} ${unit}` : `${n.toFixed(1)} ${unit}`
    n /= 1024
  }
  return `${n.toFixed(1)} TB`
}

export function msToLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const s = ms / 1000
  const m = Math.floor(s / 60)
  const remain = s - m * 60
  return `${m}:${remain.toFixed(3).padStart(6, '0')}`
}
