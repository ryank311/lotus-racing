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
  const { onProgress, signal, sessionGuid = null, catalystPath = null } = opts
  const started = await requestJson('/api/videos/uploads', {
    method: 'POST', body: JSON.stringify({ fileName: file.name, size: file.size, sessionGuid, catalystPath }),
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

// ─── 3D replay: terrain and car models ─────────────────────────────────────

async function requestBinary(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${remoteBaseUrl}${path}`, { ...init, credentials: 'include' })
  if (!response.ok) {
    let message = `Server request failed (${response.status})`
    try { message = (await response.json()).error ?? message } catch { /* not JSON */ }
    throw new Error(message)
  }
  return response
}

// The server builds terrain in the background (a first build downloads from
// USGS and outlasts a proxied request), so this polls until it is ready.
async function remoteTerrain(area: import('../shared/replay').GeoBox, onState?: (state: 'building' | 'ready') => void): Promise<import('../shared/replay').TerrainInfo> {
  let reported = false
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${remoteBaseUrl}/api/terrain`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ area }),
    })
    let payload: any = {}
    try { payload = await response.json() } catch { /* not JSON */ }
    if (response.status === 200) { onState?.('ready'); return payload.terrain }
    if (response.status !== 202) throw new Error(payload.error ?? `Terrain request failed (${response.status})`)
    if (!reported) { onState?.('building'); reported = true }
    await pause(Math.min(4000, 1000 + attempt * 500))
  }
}

async function remoteTerrainGrid(key: string): Promise<Float32Array> {
  const response = await requestBinary(`/api/terrain/${encodeURIComponent(key)}/grid`)
  return decodeTerrainGrid(await response.arrayBuffer())
}

// The grid travels as 16-bit steps between its min and max height (half the
// bytes); NaN marks a hole. Header: 'CTG1', width, height, min, max.
function decodeTerrainGrid(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== 'CTG1') throw new Error('The terrain grid could not be read.')
  const width = view.getUint32(4, true), height = view.getUint32(8, true)
  const min = view.getFloat32(12, true), max = view.getFloat32(16, true)
  const steps = new Uint16Array(buffer, 20, width * height)
  const out = new Float32Array(width * height)
  const scale = (max - min) / 65534
  for (let i = 0; i < out.length; i++) out[i] = steps[i] === 65535 ? NaN : min + steps[i] * scale
  return out
}

async function remoteTerrainImage(key: string): Promise<Blob> {
  const response = await requestBinary(`/api/terrain/${encodeURIComponent(key)}/image.jpg`)
  return response.blob()
}

async function remoteSampleTerrain(key: string, latLon: Float64Array): Promise<Float32Array> {
  const out = new Float32Array(latLon.length >> 1)
  // The server caps one request's points; larger asks go in batches.
  const batch = 2 * 200_000
  for (let at = 0; at < latLon.length; at += batch) {
    const part = latLon.subarray(at, Math.min(latLon.length, at + batch))
    const response = await requestBinary(`/api/terrain/${encodeURIComponent(key)}/sample`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: part.slice().buffer,
    })
    out.set(new Float32Array(await response.arrayBuffer()), at >> 1)
  }
  return out
}

// Track model files carry their version in the URL (from the last listing),
// so the browser keeps them until the file changes on the server.
const trackFileVersions = new Map<string, string>()

async function remoteTrackModels(): Promise<import('../shared/replay').TrackModel[]> {
  const payload = await requestJson('/api/track-models')
  const models: Array<import('../shared/replay').TrackModel & { versions?: Record<string, string> }> = payload.models ?? []
  for (const model of models) for (const [file, version] of Object.entries(model.versions ?? {})) trackFileVersions.set(`${model.id}/${file}`, version)
  return models
}

async function remoteTrackModelFile(id: string, file: string): Promise<ArrayBuffer> {
  const version = trackFileVersions.get(`${id}/${file}`)
  const response = await requestBinary(`/api/track-models/${encodeURIComponent(id)}/${encodeURIComponent(file)}${version ? `?v=${version}` : ''}`)
  return response.arrayBuffer()
}

// Car model files too: the version of each from the last listing, in the URL.
const carModelVersions = new Map<string, string>()

async function remoteCarModels(): Promise<import('../shared/replay').CarModel[]> {
  const payload = await requestJson('/api/car-models')
  const models: Array<import('../shared/replay').CarModel & { version?: string }> = payload.models ?? []
  for (const model of models) if (model.version) carModelVersions.set(model.id, model.version)
  return models
}

async function remoteCarModel(id: string): Promise<ArrayBuffer> {
  const version = carModelVersions.get(id)
  const response = await requestBinary(`/api/car-models/${encodeURIComponent(id)}.glb${version ? `?v=${version}` : ''}`)
  return response.arrayBuffer()
}

// Car models go up in chunks like videos, then the server checks the GLB.
async function uploadCarModel(
  file: File,
  meta: { name: string; attribution: string | null; matches: string[] },
  onProgress?: (sent: number, total: number) => void,
): Promise<import('../shared/replay').CarModel> {
  const started = await requestJson('/api/car-models/uploads', {
    method: 'POST', body: JSON.stringify({ fileName: file.name, size: file.size, ...meta }),
  }) as { uploadId: string; chunkSize: number }
  const base = `/api/car-models/uploads/${started.uploadId}`
  try {
    let offset = 0, failures = 0
    while (offset < file.size) {
      const at = offset
      try {
        const reply = await putChunk(`${remoteBaseUrl}${base}?offset=${at}`, file.slice(at, at + started.chunkSize), loaded => onProgress?.(at + loaded, file.size))
        offset = reply.received
        failures = 0
      } catch (error: any) {
        if (error?.status === 404 || error?.status === 400 || ++failures > 5) throw error
        if (typeof error?.received === 'number') offset = error.received
        await pause(1000 * failures)
      }
    }
    onProgress?.(file.size, file.size)
    return (await requestJson(`${base}/finish`, { method: 'POST', body: '{}' })).model
  } catch (error) {
    void requestJson(base, { method: 'DELETE' }).catch(() => {})
    throw error
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
  videoUrl: (id, driver) => driver
    ? `${remoteBaseUrl}/api/drivers/${encodeURIComponent(driver)}/videos/${encodeURIComponent(id)}.mp4`
    : `${remoteBaseUrl}/api/videos/${encodeURIComponent(id)}.mp4`,
  planCatalystImport: entries => rpc('videos:catalystPlan', entries),

  getReplayScene: guid => rpc('replay:scene', guid),
  getReplayLap: (sceneGuid, ref) => rpc('replay:lap', sceneGuid, ref),
  listDriverLaps: async (driver, sessionGuid) => (await requestJson('/api/driver-laps', {
    method: 'POST', body: JSON.stringify({ driver, sessionGuid }),
  })).result ?? [],
  // The server swaps the request for that driver's own export before your backend sees it.
  getReplayDriverLap: (sceneGuid, ref, units) => rpc('replay:driverLap', sceneGuid, { ...ref, units }),
  getReplayCoaching: guid => rpc('replay:coaching', guid),
  getTerrain: (area, onState) => remoteTerrain(area, onState),
  getTerrainGrid: key => remoteTerrainGrid(key),
  getTerrainImage: key => remoteTerrainImage(key),
  sampleTerrain: (key, latLon) => remoteSampleTerrain(key, latLon),
  listCarModels: () => remoteCarModels(),
  getCarModel: id => remoteCarModel(id),
  uploadCarModel: (file, meta, onProgress) => uploadCarModel(file, meta, onProgress),
  updateCarModel: async (id, patch) => (await requestJson(`/api/car-models/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  })).model,
  assignCarModel: async (vehicleKey, modelId) => (await requestJson('/api/car-models/assign', {
    method: 'POST', body: JSON.stringify({ vehicleKey, modelId }),
  })).models ?? [],
  deleteCarModel: async id => { await requestJson(`/api/car-models/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
  listTrackModels: () => remoteTrackModels(),
  getTrackModelFile: (id, file) => remoteTrackModelFile(id, file),
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
