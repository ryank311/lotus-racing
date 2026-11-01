// Renderer transport. Electron uses the preload bridge; browsers use the
// server's JSON RPC + Server-Sent Events endpoints.

import type { CatalystBridge, WorkerEvent } from '../shared/types'
import type { UnitSystem } from '../shared/units'
import type { LapFilter } from '../shared/coachingScope'
import type { ComparisonRequest } from '../shared/comparison'

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
  let payload: any
  try {
    payload = await response.json()
  } catch {
    if (!response.ok) throw new Error(`Server request failed (${response.status}). Please try again.`)
    throw new Error('The server response was incomplete or invalid. Please try again. If this keeps happening, check the server or tunnel connection.')
  }
  if (!response.ok) throw new Error(payload.error ?? `Server request failed (${response.status})`)
  return payload
}

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const payload = await requestJson('/api/rpc', {
    method: 'POST', body: JSON.stringify({ channel, args }),
  })
  return payload.result as T
}

// One chunk of a video upload, with byte progress (fetch has none).
function putChunk(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = e => onProgress(e.loaded)
    const abort = () => xhr.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const done = () => signal?.removeEventListener('abort', abort)
    xhr.onload = () => {
      done()
      let payload: any = {}
      try { payload = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      if (xhr.status === 200) resolve(payload)
      else reject(Object.assign(new Error(payload.error ?? `Upload failed (${xhr.status})`), { status: xhr.status, received: payload.received }))
    }
    xhr.onerror = () => { done(); reject(new Error('The connection dropped during the upload.')) }
    xhr.onabort = () => { done(); reject(new DOMException('Upload cancelled', 'AbortError')) }
    xhr.send(body)
  })
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Videos go up in chunks (proxies such as Cloudflare cap request bodies),
// resending a chunk that fails; the server then matches the video to a
// session in the background while this polls for the result.
async function uploadVideo(file: File, opts: import('../shared/types').VideoImportOptions = {}): Promise<import('../shared/pdr').VideoImportResult> {
  const { onProgress, signal, sessionGuid = null } = opts
  const started = await requestJson('/api/videos/uploads', {
    method: 'POST', body: JSON.stringify({ fileName: file.name, size: file.size, sessionGuid }),
  }) as { uploadId: string; chunkSize: number }
  const base = `/api/videos/uploads/${started.uploadId}`
  try {
    let offset = 0, failures = 0
    while (offset < file.size) {
      signal?.throwIfAborted()
      const at = offset
      try {
        const reply = await putChunk(`${remoteBaseUrl}${base}?offset=${at}`, file.slice(at, at + started.chunkSize), loaded => onProgress?.(at + loaded, file.size, 'uploading'), signal)
        offset = reply.received
        failures = 0
      } catch (error: any) {
        if (error?.name === 'AbortError' || error?.status === 404 || ++failures > 5) throw error
        if (typeof error?.received === 'number') offset = error.received
        await pause(1000 * failures)
      }
    }
    onProgress?.(file.size, file.size, 'matching')
    await requestJson(`${base}/finish`, { method: 'POST', body: '{}' })
  } catch (error) {
    void requestJson(base, { method: 'DELETE' }).catch(() => {})
    throw error
  }
  for (;;) {
    await pause(1500)
    const status = await requestJson(base)
    if (status.state === 'done') return status.result
    if (status.state === 'failed') throw new Error(status.error ?? 'The video could not be imported.')
  }
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
  getSessionReview: guid => rpc('review:get', guid),
  ensureSessionReview: (guid, retry = false) => rpc('review:ensure', guid, retry),
  getProgress: (filters = {}) => rpc('review:progress', filters),
  updateReviewConditions: (guid, value) => rpc('review:conditions', guid, value),
  setReviewLapExcluded: (guid, index, excluded, reason = '') => rpc('review:excludeLap', guid, index, excluded, reason),
  onReviewStatus: cb => subscribe('review:event', cb),
  getDashboard: () => rpc('dashboard:get'),
  getSessionFocus: guid => rpc('focus:forSession', guid),
  getSessionNotes: guid => rpc('notes:get', guid),
  saveSessionNotes: (guid, notes) => rpc('notes:save', guid, notes),
  listAiContextFiles: profileName => rpc('profiles:aiContext', profileName),
  setAiContextFile: (profileName, fileName, included) => rpc('profiles:setAiContext', profileName, fileName, included),
  getTrackComplexes: meanLineGuid => rpc('tracks:complexes', meanLineGuid),
  saveTrackComplexes: (meanLineGuid, complexes) => rpc('tracks:saveComplexes', meanLineGuid, complexes),
  regenerateTrackComplexes: meanLineGuid => rpc('tracks:regenerateComplexes', meanLineGuid),
  getAuthState: () => rpc('auth:state'),
  getSyncStats: () => rpc('auth:syncStats'),
  getAccountEmail: () => rpc('auth:email'),
  saveCredentials: (email, password) => rpc('auth:saveCredentials', email, password),
  clearTokens: () => rpc('auth:clearTokens'),
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
  ensureSessions: (guids, opts) => rpc('db:ensureSessions', guids, opts),
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

  buildAnalysis: (sessionGuids: string[], units?: UnitSystem, lapFilter?: LapFilter, comparisons?: ComparisonRequest[]) =>
    rpc('analysis:build', sessionGuids, units, lapFilter, comparisons ?? []),
  listDrivers: async () => (await requestJson('/api/drivers')).drivers ?? [],
  listDriverSessions: async driver => (await requestJson('/api/driver-sessions', {
    method: 'POST', body: JSON.stringify({ driver }),
  })).result ?? [],
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

  listVideos: () => rpc('videos:listAll'),
  listSessionVideos: guid => rpc('videos:list', guid),
  importVideo: (file, opts) => uploadVideo(file, opts),
  matchVideo: (id, guid) => rpc('videos:match', id, guid ?? null),
  deleteVideo: id => rpc('videos:delete', id),
  setVideoOffset: (id, offsetS) => rpc('videos:setOffset', id, offsetS),
  getSessionCarData: guid => rpc('videos:carData', guid),
  videoUrl: id => `${remoteBaseUrl}/api/videos/${encodeURIComponent(id)}.mp4`,
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
