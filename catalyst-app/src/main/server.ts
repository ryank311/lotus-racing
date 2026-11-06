/** Passwordless multi-user HTTP server for Catalyst Coach. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { accountKey, defaultServerDataDir, moveVideosToMedia, userDirectory, USER_RE, workspaceVideoDir, workspaceVideoFile } from './serverStorage.js'
import { MAX_VIDEO_BYTES, VIDEO_ID_RE, VIDEO_UPLOAD_CHUNK } from '../shared/pdr.js'
import { createDriverDirectory, type DriverDirectory } from './driverDirectory.js'
import { databaseAiKeyStore, migrateServerAiKeys, type AiKeyStore, type AiKeys } from './aiKeyStore.js'
import { localTrackLibrary, serveTrackLibrary, type TrackLibrary } from '../garmin/trackLibrary.js'
import { serveStaticAsset } from './staticAssets.js'
import { MAX_SAMPLE_POINTS, TerrainService } from '../garmin/terrain.js'
import { CAR_MODEL_ID_RE, CarModelLibrary, cleanMatches, type CarModelMeta } from '../garmin/carModels.js'
import { TRACK_MODEL_ID_RE, TrackModelLibrary } from '../garmin/trackModels.js'
import { MAX_CAR_MODEL_BYTES } from '../shared/replay.js'

export interface CatalystServerOptions {
  host?: string
  port?: number
  dataDir?: string
  /** Videos' own volume, apart from the data directory (CATALYST_MEDIA_DIR). */
  mediaDir?: string
  staticDir?: string
  devRendererUrl?: string
  templateRoot?: string
  resourcesPath?: string
}

export interface RunningCatalystServer {
  host: string
  port: number
  url: string
  // The server's drivers, for the desktop app's comparisons.
  drivers: DriverDirectory
  close(): Promise<void>
}

interface WorkerReply {
  type: 'ready' | 'fatal' | 'event' | 'rpc-result' | 'ai-keys' | 'tracks'
  requestId?: number
  ok?: boolean
  result?: unknown
  error?: string
  channel?: string
  payload?: unknown
  operation?: 'read' | 'write'
  keys?: AiKeys
  onlyMissing?: boolean
  op?: string
  args?: unknown[]
}

// What every driver's backend shares, owned by the server process.
interface SharedServices {
  aiKeys: AiKeyStore
  tracks: TrackLibrary
  // A backend changed a shared track layout.
  tracksChanged(from: UserBackend): void
}
const TRACK_WRITES = new Set(['importLayout', 'saveCorners', 'saveComplexes'])

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const COOKIE = 'catalyst_session'
const MAX_BODY = 25 * 1024 * 1024
// Backend calls the server makes itself; never from /api/rpc.
const INTERNAL_CHANNELS = new Set(['videos:import', 'videos:importPath'])

// A video arriving in chunks (each request stays under Cloudflare's body
// limit). Chunks append to a part file in the driver's videos folder.
interface VideoUpload {
  id: string
  owner: string
  username: string
  dir: string
  partPath: string
  size: number
  received: number
  fileName: string
  sessionGuid: string | null
  // A Garmin Catalyst video: its DRIVER/Track/Car/YYYYMMDD/HHMMSS/file path on the device.
  catalystPath: string | null
  busy: boolean
  touched: number
}
const UPLOAD_IDLE_MS = 60 * 60 * 1000
// A car model arriving in chunks, the same way, into the shared library's
// incoming folder; checked and added when the last chunk is in.
interface ModelUpload {
  id: string
  owner: string
  partPath: string
  size: number
  received: number
  fileName: string
  meta: CarModelMeta
  busy: boolean
  touched: number
}
interface VideoImport { owner: string; state: 'importing' | 'done' | 'failed'; result?: unknown; error?: string; touched: number }

// Serve a file with HTTP range support (video seeking).
function serveFileRange(req: IncomingMessage, res: ServerResponse, filePath: string, contentType: string): void {
  const { size } = fs.statSync(filePath)
  const headers: Record<string, string | number> = {
    'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
  }
  const range = req.headers.range
  let start = 0, end = size - 1
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 }
      else { start = Math.max(0, size - Number(m[2])) }
    }
    if (!m || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size })
  }
  if (req.method === 'HEAD' || size === 0) { res.end(); return }
  const stream = fs.createReadStream(filePath, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function json(res: ServerResponse, status: number, value: unknown, origin?: string): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    } : {}),
  })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY) throw new Error('Request body is too large')
    chunks.push(buf)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Invalid JSON body') }
}

// A binary body, or null when it is larger than `max` (read to the end
// either way, so the reply reaches the client).
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size <= max) chunks.push(buf)
  }
  return size > max ? null : Buffer.concat(chunks)
}

// Terrain never changes for its key: browsers keep it.
const IMMUTABLE = 'private, max-age=31536000, immutable'

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, headers: Record<string, string>): void {
  const { size } = fs.statSync(file)
  res.writeHead(200, { ...headers, 'Content-Length': size })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = fs.createReadStream(file)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

// Appends one upload chunk at `offset` to a part file (at most `limit` bytes).
async function appendChunk(req: IncomingMessage, partPath: string, offset: number, limit: number): Promise<number> {
  let bytes = 0
  try {
    await pipeline(req, new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length
        done(bytes > limit ? new Error('Chunk too large') : null, chunk)
      },
    }), fs.createWriteStream(partPath, { flags: 'r+', start: offset }))
  } catch (error) {
    // Drop whatever part of the chunk landed; the client resends it.
    fs.truncateSync(partPath, offset)
    throw error
  }
  return bytes
}

class UserBackend {
  private child: ChildProcess
  private ready: Promise<void>
  private rejectReady!: (error: Error) => void
  private closed: Promise<void>
  private failure: Error | null = null
  private startupTimer: ReturnType<typeof setTimeout>
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private listeners = new Set<ServerResponse>()

  constructor(
    readonly username: string,
    instanceDir: string,
    options: CatalystServerOptions,
    onClosed: () => void,
    private shared: SharedServices,
    // A one-off job instead of serving requests (see userWorker.ts).
    task?: 'share-tracks',
  ) {
    // tsx runs the source tree in dev; packaged/compiled servers use JavaScript.
    const workerPath = path.join(__dirname, `userWorker${path.extname(__filename)}`)
    const env = { ...process.env }
    // Legacy desktop overrides must not escape a driver's instance directory.
    delete env.CATALYST_DATA_DIR
    delete env.CATALYST_DB_PATH
    delete env.CATALYST_REPO_ROOT
    delete env.CATALYST_MEDIA_DIR
    this.child = fork(workerPath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        CATALYST_INSTANCE_DIR: instanceDir,
        ...(options.mediaDir ? { CATALYST_MEDIA_DIR: options.mediaDir } : {}),
        ...(task ? { CATALYST_WORKER_TASK: task } : {}),
        ...(options.templateRoot ? { CATALYST_TEMPLATE_ROOT: options.templateRoot } : {}),
        ...(options.resourcesPath ? { CATALYST_BUNDLED_RESOURCES: options.resourcesPath } : {}),
      },
    })

    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject
      const onInitial = (message: WorkerReply) => {
        if (message.type === 'ready') {
          clearTimeout(this.startupTimer)
          this.child.off('message', onInitial)
          resolve()
        }
      }
      this.child.on('message', onInitial)
    })
    // Startup may fail before an RPC or event subscriber awaits readiness.
    void this.ready.catch(() => {})
    this.startupTimer = setTimeout(() => this.fail(new Error('Backend startup timed out')), 30_000)

    this.child.on('message', (message: WorkerReply) => this.onMessage(message))
    this.child.on('error', error => this.fail(error))
    this.child.on('disconnect', () => this.fail(new Error('Backend disconnected')))
    this.child.on('exit', code => this.fail(new Error(`Backend process exited (${code})`)))
    this.closed = new Promise(resolve => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        // Only allow a replacement after the process releases its DB lock.
        onClosed()
        resolve()
      }
      this.child.once('exit', finish)
      // Failed spawns emit close without an exit event.
      this.child.once('close', finish)
    })
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.startupTimer)
    this.rejectReady(error)
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
    for (const stream of this.listeners) stream.end()
    this.listeners.clear()
    this.child.kill()
  }

  private onMessage(message: WorkerReply): void {
    if (message.type === 'ai-keys') {
      const { aiKeys } = this.shared
      const operation = message.operation === 'read' ? aiKeys.read()
        : message.operation === 'write' ? aiKeys.write(message.keys ?? {}, message.onlyMissing)
        : Promise.reject(new Error('Unknown key operation'))
      void operation.then(
        result => this.replyKeys(message.requestId, { ok: true, result }),
        () => this.replyKeys(message.requestId, { ok: false, error: 'Could not access AI key database' }),
      )
    } else if (message.type === 'tracks') {
      void serveTrackLibrary(this.shared.tracks, message.op, message.args).then(
        result => {
          this.reply('tracks-result', message.requestId, { ok: true, result })
          if (TRACK_WRITES.has(String(message.op)) && result !== false) this.shared.tracksChanged(this)
        },
        error => this.reply('tracks-result', message.requestId, { ok: false, error: error instanceof Error ? error.message : 'Track library request failed' }),
      )
    } else if (message.type === 'fatal') {
      this.fail(new Error(message.error ?? 'Backend startup failed'))
    } else if (message.type === 'rpc-result' && message.requestId != null) {
      const call = this.pending.get(message.requestId)
      if (!call) return
      this.pending.delete(message.requestId)
      clearTimeout(call.timer)
      if (message.ok) call.resolve(message.result)
      else call.reject(new Error(message.error ?? 'Backend request failed'))
    } else if (message.type === 'event' && message.channel) {
      const data = JSON.stringify({ channel: message.channel, payload: message.payload })
      for (const stream of this.listeners) stream.write(`data: ${data}\n\n`)
    }
  }

  private replyKeys(requestId: number | undefined, reply: object): void {
    this.reply('ai-keys-result', requestId, reply)
  }

  private reply(type: string, requestId: number | undefined, reply: object): void {
    if (this.child.connected) this.child.send({ type, requestId, ...reply }, () => {})
  }

  /** Tell a running worker that another driver changed a shared track layout. */
  notifyTracksChanged(): void {
    if (!this.failure && this.child.connected) this.child.send({ type: 'tracks-changed' }, () => {})
  }

  async waitUntilReady(): Promise<void> {
    await this.ready
    if (this.failure) throw this.failure
    if (!this.child.connected) throw new Error('Backend disconnected')
  }

  async call(channel: string, args: unknown[]): Promise<unknown> {
    await this.waitUntilReady()
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Backend request timed out: ${channel}`))
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.child.send({ type: 'rpc', requestId, channel, args }, error => {
          if (error) this.fail(error)
        })
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  addEventStream(res: ServerResponse): void {
    this.listeners.add(res)
    res.write(`data: ${JSON.stringify({ channel: 'server:connected', payload: { username: this.username } })}\n\n`)
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000)
    res.on('close', () => { clearInterval(heartbeat); this.listeners.delete(res) })
  }

  async close(): Promise<void> {
    this.fail(new Error('Server is shutting down'))
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000)
    try { await this.closed } finally { clearTimeout(timer) }
  }
}

export async function startCatalystServer(serverOptions: CatalystServerOptions = {}): Promise<RunningCatalystServer> {
  const media = serverOptions.mediaDir ?? process.env.CATALYST_MEDIA_DIR
  const mediaDir = media ? path.resolve(media) : null
  // Workers keep their videos where the server stores and serves them.
  const options: CatalystServerOptions = { ...serverOptions, mediaDir: mediaDir ?? undefined }
  const host = options.host ?? process.env.CATALYST_SERVER_HOST ?? '0.0.0.0'
  const requestedPort = options.port ?? Number(process.env.CATALYST_SERVER_PORT ?? 3210)
  const dataDir = path.resolve(options.dataDir ?? defaultServerDataDir())
  const usersDir = path.join(dataDir, 'users')
  fs.mkdirSync(usersDir, { recursive: true })
  if (mediaDir) fs.mkdirSync(mediaDir, { recursive: true })

  const aiKeys = databaseAiKeyStore(path.join(dataDir, 'catalyst-app.duckdb'))
  await migrateServerAiKeys(dataDir, aiKeys)
  // Track layouts are shared by every driver: one library per server. When
  // one driver changes a layout, the others' reviews recompute.
  const tracks = localTrackLibrary(path.join(dataDir, 'catalyst-app.duckdb'))
  const shared: SharedServices = {
    aiKeys, tracks,
    tracksChanged: from => { for (const backend of backends.values()) if (backend !== from) backend.notifyTracksChanged() },
  }

  // The 3D replay's terrain and car models are shared by every driver and
  // kept with the media (large, rebuilt or re-uploaded rather than backed up).
  const sharedDir = path.join(mediaDir ?? dataDir, 'shared')
  const terrain = new TerrainService(path.join(sharedDir, 'terrain'))
  const carModels = new CarModelLibrary(path.join(sharedDir, 'car-models'))
  // The server makes the folder, so it owns it; models copied into it by
  // hand are registered now.
  try { fs.mkdirSync(carModels.dir, { recursive: true }) } catch (error) { console.error('[car models] could not create the folder:', error) }
  void carModels.list().catch(error => console.error('[car models] could not read the library:', error))
  // Track models are folders copied in by hand (see trackModels.ts).
  const trackModels = new TrackModelLibrary(path.join(sharedDir, 'track-models'))
  try { fs.mkdirSync(trackModels.dir, { recursive: true }) } catch (error) { console.error('[track models] could not create the folder:', error) }
  void trackModels.list().catch(error => console.error('[track models] could not read the library:', error))

  const secretPath = path.join(dataDir, '.session-secret')
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
  }
  const secret = fs.readFileSync(secretPath)
  // Account names are case-insensitive to prevent two worker processes from
  // opening the same hashed database directory (for example Ryan vs ryan).
  const backends = new Map<string, UserBackend>()
  let closing = false
  const uploads = new Map<string, VideoUpload>()
  const imports = new Map<string, VideoImport>()
  const modelUploads = new Map<string, ModelUpload>()
  // Abandoned uploads (closed tab, lost connection) are removed after an hour.
  const sweepUploads = () => {
    for (const upload of uploads.values()) {
      if (upload.busy || Date.now() - upload.touched < UPLOAD_IDLE_MS) continue
      uploads.delete(upload.id)
      fs.rmSync(upload.partPath, { force: true })
    }
    for (const [id, job] of imports) if (job.state !== 'importing' && Date.now() - job.touched > UPLOAD_IDLE_MS) imports.delete(id)
    for (const upload of modelUploads.values()) {
      if (upload.busy || Date.now() - upload.touched < UPLOAD_IDLE_MS) continue
      modelUploads.delete(upload.id)
      fs.rmSync(upload.partPath, { force: true })
    }
  }
  const sweepTimer = setInterval(sweepUploads, 10 * 60 * 1000)
  sweepTimer.unref()

  const sign = (username: string): string => {
    const encoded = Buffer.from(username, 'utf8').toString('base64url')
    const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }
  const verify = (token: string | undefined): string | null => {
    if (!token) return null
    const [encoded, supplied] = token.split('.')
    if (!encoded || !supplied) return null
    const expected = createHmac('sha256', secret).update(encoded).digest()
    let actual: Buffer
    try { actual = Buffer.from(supplied, 'base64url') } catch { return null }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
    try {
      const username = Buffer.from(encoded, 'base64url').toString('utf8')
      return USER_RE.test(username) ? username : null
    } catch { return null }
  }
  const backendFor = (username: string): UserBackend => {
    if (closing) throw new Error('Server is shutting down')
    const key = accountKey(username)
    let backend = backends.get(key)
    if (!backend) {
      const instanceDir = userDirectory(dataDir, username)
      fs.mkdirSync(instanceDir, { recursive: true })
      const accountPath = path.join(instanceDir, 'account.json')
      if (!fs.existsSync(accountPath)) fs.writeFileSync(accountPath, JSON.stringify({ username }, null, 2))
      backend = new UserBackend(username, instanceDir, options, () => {
        if (backends.get(key) === backend) backends.delete(key)
      }, shared)
      backends.set(key, backend)
    }
    return backend
  }

  // Drivers can read each other's sessions and laps for comparisons.
  const drivers = createDriverDirectory(dataDir, backendFor, mediaDir)

  // Once per server: before the track library, each driver kept their own
  // layouts. Every workspace shares its layouts with the library now (the
  // one with the most corners wins a course), before anyone signs in, so a
  // driver who has not opened the app since still contributes theirs.
  if (!(await tracks.migrated('workspace-track-layouts'))) {
    for (const username of drivers.list(null).filter(d => d.hasTelemetry).map(d => d.username)) {
      const job = new UserBackend(username, userDirectory(dataDir, username), options, () => {}, shared, 'share-tracks')
      try { await job.waitUntilReady() } catch (error) {
        console.error(`[tracks] could not share ${username}'s track layouts; they are shared when ${username} next signs in:`, error)
      } finally { await job.close() }
    }
    await tracks.markMigrated('workspace-track-layouts')
  }

  const staticDir = options.staticDir ? path.resolve(options.staticDir) : null
  const server: Server = createServer(async (req, res) => {
    const origin = req.headers.origin
    if (req.method === 'OPTIONS' && req.url?.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Vary': 'Origin',
      })
      res.end()
      return
    }

    try {
      let url: URL
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        decodeURIComponent(url.pathname)
      } catch {
        json(res, 400, { error: 'Invalid request URL or Host header' }, origin)
        return
      }
      const username = verify(parseCookies(req)[COOKIE])
      if (url.pathname === '/api/health') {
        json(res, 200, { ok: true, service: 'catalyst-coach', users: backends.size }, origin)
        return
      }
      if (url.pathname === '/api/session' && req.method === 'GET') {
        json(res, username ? 200 : 401, username ? { username } : { error: 'Not signed in' }, origin)
        return
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const body = await readJson(req)
        const candidate = typeof body?.username === 'string' ? body.username.trim().normalize('NFKC') : ''
        if (!USER_RE.test(candidate)) {
          json(res, 400, { error: 'Use 1–40 letters, numbers, spaces, dots, dashes, or underscores.' }, origin)
          return
        }
        await backendFor(candidate).waitUntilReady()
        res.setHeader('Set-Cookie', `${COOKIE}=${sign(candidate)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
        json(res, 200, { username: candidate }, origin)
        return
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
        json(res, 200, { ok: true }, origin)
        return
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const backend = backendFor(username)
        await backend.waitUntilReady()
        if (res.destroyed) return
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' } : {}),
        })
        backend.addEventStream(res)
        return
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        if (typeof body?.channel !== 'string' || !Array.isArray(body.args) || INTERNAL_CHANNELS.has(body.channel)) {
          json(res, 400, { error: 'Invalid RPC request' }, origin)
          return
        }
        const args = [...body.args]
        // Comparison requests become the compared drivers' exported laps.
        if (body.channel === 'analysis:build') args[3] = await drivers.resolve(username, args[2], args[3])
        // The replay's other driver: always their backend's export, never the renderer's own.
        if (body.channel === 'replay:driverLap') args[1] = await drivers.replayLap(username, args[1])
        if (body.channel === 'coach:run' && args[0] && typeof args[0] === 'object') {
          args[0] = { ...args[0], comparisons: await drivers.resolve(username, args[0].lapFilter, args[0].comparisons) }
        }
        const result = await backendFor(username).call(body.channel, args)
        json(res, 200, { result }, origin)
        return
      }
      // ---- PDR videos: chunked upload, then the worker matches it ----
      if (url.pathname === '/api/videos/uploads' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        const size = Number(body?.size)
        const fileName = path.basename(String(body?.fileName ?? '')).slice(0, 200)
        const sessionGuid = body?.sessionGuid == null || body.sessionGuid === '' ? null : String(body.sessionGuid)
        const catalystPath = body?.catalystPath == null || body.catalystPath === '' ? null : String(body.catalystPath)
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) { json(res, 400, { error: 'Choose a video under 16 GB.' }, origin); return }
        if (!/\.(mp4|mov)$/i.test(fileName)) { json(res, 400, { error: 'Videos must be .mp4 files.' }, origin); return }
        if (sessionGuid !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionGuid)) { json(res, 400, { error: 'Invalid session ID' }, origin); return }
        if (catalystPath !== null && catalystPath.length > 2048) { json(res, 400, { error: 'Invalid Catalyst video path' }, origin); return }
        sweepUploads()
        const dir = workspaceVideoDir(userDirectory(dataDir, username), mediaDir)
        const incoming = path.join(dir, '.incoming')
        fs.mkdirSync(incoming, { recursive: true })
        // Part files left by a server restart mid-upload.
        for (const name of fs.readdirSync(incoming)) {
          const part = path.join(incoming, name)
          if (!uploads.has(name.replace(/\.part$/, '')) && Date.now() - fs.statSync(part).mtimeMs > UPLOAD_IDLE_MS) fs.rmSync(part, { force: true })
        }
        const id = randomUUID()
        const upload: VideoUpload = {
          id, owner: accountKey(username), username, dir, partPath: path.join(incoming, `${id}.part`),
          size, received: 0, fileName, sessionGuid, catalystPath, busy: false, touched: Date.now(),
        }
        fs.writeFileSync(upload.partPath, '')
        uploads.set(id, upload)
        json(res, 200, { uploadId: id, chunkSize: VIDEO_UPLOAD_CHUNK }, origin)
        return
      }
      const uploadMatch = /^\/api\/videos\/uploads\/([0-9a-f-]{36})(\/finish)?$/.exec(url.pathname)
      if (uploadMatch) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        // A finished upload being decoded and matched; the client polls this.
        const job = imports.get(uploadMatch[1])
        if (job && job.owner === accountKey(username) && !uploadMatch[2] && req.method === 'GET') {
          job.touched = Date.now()
          json(res, 200, { state: job.state, result: job.result, error: job.error }, origin)
          return
        }
        const upload = uploads.get(uploadMatch[1])
        if (!upload || upload.owner !== accountKey(username)) { json(res, 404, { error: 'This upload is no longer open. Start it again.' }, origin); return }
        if (upload.busy) { json(res, 409, { error: 'This upload is busy', received: upload.received }, origin); return }
        upload.touched = Date.now()
        if (!uploadMatch[2] && req.method === 'GET') { json(res, 200, { state: 'uploading', received: upload.received }, origin); return }
        if (!uploadMatch[2] && req.method === 'PUT') {
          const offset = Number(url.searchParams.get('offset'))
          if (offset !== upload.received) { json(res, 409, { error: 'Upload out of order', received: upload.received }, origin); return }
          const limit = Math.min(VIDEO_UPLOAD_CHUNK * 2, upload.size - upload.received)
          let bytes = 0
          upload.busy = true
          try {
            await pipeline(req, new Transform({
              transform(chunk: Buffer, _enc, done) {
                bytes += chunk.length
                done(bytes > limit ? new Error('Chunk too large') : null, chunk)
              },
            }), fs.createWriteStream(upload.partPath, { flags: 'r+', start: upload.received }))
            upload.received += bytes
          } catch (error) {
            // Drop whatever part of the chunk landed; the client resends it.
            fs.truncateSync(upload.partPath, upload.received)
            throw error
          } finally { upload.busy = false }
          json(res, 200, { received: upload.received }, origin)
          return
        }
        if (!uploadMatch[2] && req.method === 'DELETE') {
          uploads.delete(upload.id)
          fs.rmSync(upload.partPath, { force: true })
          json(res, 200, { ok: true }, origin)
          return
        }
        if (uploadMatch[2] && req.method === 'POST') {
          if (upload.received !== upload.size) { json(res, 409, { error: 'The upload is incomplete', received: upload.received }, origin); return }
          uploads.delete(upload.id)
          fs.renameSync(upload.partPath, path.join(upload.dir, `${upload.id}.mp4`))
          // Matching can download session telemetry first, which may outlast
          // a proxy's request timeout: run it in the background.
          const importJob: VideoImport = { owner: upload.owner, state: 'importing', touched: Date.now() }
          imports.set(upload.id, importJob)
          backendFor(username).call('videos:import', [upload.id, upload.fileName, upload.sessionGuid, upload.catalystPath]).then(
            result => { importJob.state = 'done'; importJob.result = result },
            error => { importJob.state = 'failed'; importJob.error = error instanceof Error ? error.message : String(error) },
          )
          json(res, 202, { state: 'importing' }, origin)
          return
        }
        json(res, 405, { error: 'Method not allowed' }, origin)
        return
      }
      const videoMatch = /^\/api\/videos\/([0-9a-f-]{36})\.mp4$/.exec(url.pathname)
      if (videoMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const file = VIDEO_ID_RE.test(videoMatch[1]) ? workspaceVideoFile(userDirectory(dataDir, username), mediaDir, videoMatch[1]) : null
        if (!file) { json(res, 404, { error: 'Video not found' }, origin); return }
        serveFileRange(req, res, file, 'video/mp4')
        return
      }

      // A compared driver's video, played beside or over yours in Analysis.
      const driverVideo = /^\/api\/drivers\/([^/]{1,200})\/videos\/([0-9a-f-]{36})\.mp4$/.exec(url.pathname)
      if (driverVideo && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        let name: string
        try { name = decodeURIComponent(driverVideo[1]) } catch { json(res, 404, { error: 'Video not found' }, origin); return }
        const file = drivers.videoFile(name, driverVideo[2])
        if (!file) { json(res, 404, { error: 'Video not found' }, origin); return }
        serveFileRange(req, res, file, 'video/mp4')
        return
      }
      if (url.pathname === '/api/drivers' && req.method === 'GET') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        json(res, 200, { drivers: drivers.list(username) }, origin)
        return
      }
      // The replay's driver comparison: one of their sessions' valid laps.
      if (url.pathname === '/api/driver-laps' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        try {
          json(res, 200, { result: await drivers.replayLaps(body?.driver, body?.sessionGuid, username) }, origin)
        } catch (error: any) {
          json(res, error?.status ?? 500, { error: error instanceof Error ? error.message : String(error) }, origin)
        }
        return
      }
      if (url.pathname === '/api/driver-sessions' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        try {
          json(res, 200, { result: await drivers.sessions(body?.driver, username) }, origin)
        } catch (error: any) {
          json(res, error?.status ?? 500, { error: error instanceof Error ? error.message : String(error) }, origin)
        }
        return
      }

      // ---- 3D replay: terrain (USGS, built once per area) ----
      // Never held open for a build (proxies cut requests at ~100 s): 202
      // while it builds in the background, and the client polls.
      if (url.pathname === '/api/terrain' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        let status: ReturnType<TerrainService['status']>
        try { status = terrain.status(body?.area) } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : 'Invalid terrain area' }, origin)
          return
        }
        if (status.state === 'ready') json(res, 200, { terrain: status.terrain }, origin)
        else if (status.state === 'building') json(res, 202, { state: 'building' }, origin)
        else json(res, 502, { error: `The terrain could not be downloaded from USGS: ${status.error}` }, origin)
        return
      }
      const terrainMatch = /^\/api\/terrain\/([a-z0-9._]{1,80})\/(grid|image\.jpg|sample)$/.exec(url.pathname)
      if (terrainMatch) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const [, key, product] = terrainMatch
        if (product === 'sample') {
          if (req.method !== 'POST') { json(res, 405, { error: 'Method not allowed' }, origin); return }
          if (!terrain.info(key)) { json(res, 404, { error: 'That terrain has not been built.' }, origin); return }
          // [lat, lon, …] as little-endian float64 → heights as float32.
          const body = await readBody(req, MAX_SAMPLE_POINTS * 16)
          if (!body) { json(res, 413, { error: `Send at most ${MAX_SAMPLE_POINTS} points at a time.` }, origin); return }
          if (body.length % 16) { json(res, 400, { error: 'Send latitude and longitude pairs as 64-bit floats.' }, origin); return }
          const heights = await terrain.sample(key, new Float64Array(new Uint8Array(body).buffer))
          const out = Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength)
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': out.length, 'Cache-Control': 'no-store' })
          res.end(out)
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }, origin); return }
        if (product === 'grid') {
          const file = terrain.gridFile(key)
          if (!file) { json(res, 404, { error: 'That terrain has not been built.' }, origin); return }
          const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': IMMUTABLE, 'Vary': 'Accept-Encoding' }
          if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) serveFile(req, res, file, { ...headers, 'Content-Encoding': 'gzip' })
          else {
            const bytes = gunzipSync(fs.readFileSync(file))
            res.writeHead(200, { ...headers, 'Content-Length': bytes.length })
            res.end(req.method === 'HEAD' ? undefined : bytes)
          }
          return
        }
        const file = terrain.imageFile(key)
        if (!file) { json(res, 404, { error: 'This terrain has no aerial photo.' }, origin); return }
        serveFile(req, res, file, { 'Content-Type': 'image/jpeg', 'Cache-Control': IMMUTABLE })
        return
      }

      // ---- 3D replay: car models, a library shared by every driver ----
      if (url.pathname === '/api/car-models' && req.method === 'GET') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        json(res, 200, { models: await carModels.list() }, origin)
        return
      }
      if (url.pathname === '/api/car-models/uploads' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        const size = Number(body?.size)
        const fileName = path.basename(String(body?.fileName ?? '')).slice(0, 200)
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CAR_MODEL_BYTES) {
          json(res, 400, { error: `Choose a model under ${MAX_CAR_MODEL_BYTES / 1024 ** 2} MB.` }, origin)
          return
        }
        if (!/\.glb$/i.test(fileName)) { json(res, 400, { error: 'Car models must be .glb files.' }, origin); return }
        let meta: CarModelMeta
        try {
          const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
          meta = { name: text(body?.name, 120), attribution: text(body?.attribution, 500) || null, matches: cleanMatches(body?.matches) }
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : 'Invalid model details' }, origin)
          return
        }
        sweepUploads()
        fs.mkdirSync(carModels.incomingDir, { recursive: true })
        const id = randomUUID()
        const upload: ModelUpload = {
          id, owner: accountKey(username), partPath: path.join(carModels.incomingDir, `${id}.part`),
          size, received: 0, fileName, meta, busy: false, touched: Date.now(),
        }
        fs.writeFileSync(upload.partPath, '')
        modelUploads.set(id, upload)
        json(res, 200, { uploadId: id, chunkSize: VIDEO_UPLOAD_CHUNK }, origin)
        return
      }
      const modelUploadMatch = /^\/api\/car-models\/uploads\/([0-9a-f-]{36})(\/finish)?$/.exec(url.pathname)
      if (modelUploadMatch) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const upload = modelUploads.get(modelUploadMatch[1])
        if (!upload || upload.owner !== accountKey(username)) { json(res, 404, { error: 'This upload is no longer open. Start it again.' }, origin); return }
        if (upload.busy) { json(res, 409, { error: 'This upload is busy', received: upload.received }, origin); return }
        upload.touched = Date.now()
        const finish = !!modelUploadMatch[2]
        if (!finish && req.method === 'GET') { json(res, 200, { state: 'uploading', received: upload.received }, origin); return }
        if (!finish && req.method === 'PUT') {
          if (Number(url.searchParams.get('offset')) !== upload.received) { json(res, 409, { error: 'Upload out of order', received: upload.received }, origin); return }
          upload.busy = true
          try {
            upload.received += await appendChunk(req, upload.partPath, upload.received, Math.min(VIDEO_UPLOAD_CHUNK * 2, upload.size - upload.received))
          } finally { upload.busy = false }
          json(res, 200, { received: upload.received }, origin)
          return
        }
        if (!finish && req.method === 'DELETE') {
          modelUploads.delete(upload.id)
          fs.rmSync(upload.partPath, { force: true })
          json(res, 200, { ok: true }, origin)
          return
        }
        if (finish && req.method === 'POST') {
          if (upload.received !== upload.size) { json(res, 409, { error: 'The upload is incomplete', received: upload.received }, origin); return }
          modelUploads.delete(upload.id)
          try {
            json(res, 200, { model: await carModels.add(upload.partPath, upload.fileName, upload.meta) }, origin)
          } catch (error) {
            fs.rmSync(upload.partPath, { force: true })
            json(res, 400, { error: error instanceof Error ? error.message : String(error) }, origin)
          }
          return
        }
        json(res, 405, { error: 'Method not allowed' }, origin)
        return
      }
      // The Garage's choice of a vehicle's model: { vehicleKey, modelId | null }.
      if (url.pathname === '/api/car-models/assign' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        try {
          json(res, 200, { models: await carModels.assign(body?.vehicleKey, body?.modelId ?? null) }, origin)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, /no longer/.test(message) ? 404 : 400, { error: message }, origin)
        }
        return
      }
      const modelMatch = /^\/api\/car-models\/([a-zA-Z0-9_-]{1,100})(\.glb)?$/.exec(url.pathname)
      if (modelMatch && CAR_MODEL_ID_RE.test(modelMatch[1])) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const [, id, glb] = modelMatch
        if (glb && (req.method === 'GET' || req.method === 'HEAD')) {
          const file = await carModels.file(id)
          if (!file) { json(res, 404, { error: 'Car model not found' }, origin); return }
          serveFileRange(req, res, file, 'model/gltf-binary')
          return
        }
        if (!glb && req.method === 'PATCH') {
          const body = await readJson(req)
          try {
            json(res, 200, { model: await carModels.update(id, body) }, origin)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            json(res, /no longer/.test(message) ? 404 : 400, { error: message }, origin)
          }
          return
        }
        if (!glb && req.method === 'DELETE') {
          const removed = await carModels.remove(id)
          json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Car model not found' }, origin)
          return
        }
        json(res, 405, { error: 'Method not allowed' }, origin)
        return
      }

      // ---- 3D replay: track models, folders shared by every driver ----
      if (url.pathname === '/api/track-models' && req.method === 'GET') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        json(res, 200, { models: await trackModels.listWithVersions() }, origin)
        return
      }
      const trackFileMatch = /^\/api\/track-models\/([^/]{1,100})\/([^/]{1,160})$/.exec(url.pathname)
      if (trackFileMatch) {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }, origin); return }
        let id: string, name: string
        try { [id, name] = [decodeURIComponent(trackFileMatch[1]), decodeURIComponent(trackFileMatch[2])] } catch { json(res, 400, { error: 'Invalid file name' }, origin); return }
        const file = TRACK_MODEL_ID_RE.test(id) ? await trackModels.file(id, name) : null
        if (!file) { json(res, 404, { error: 'Track model file not found' }, origin); return }
        // A URL naming the file's current version never changes: browsers keep it.
        const versioned = url.searchParams.get('v') === file.version
        const headers: Record<string, string> = {
          'Content-Type': file.type, 'ETag': `"${file.version}"`, 'Vary': 'Accept-Encoding',
          'Cache-Control': versioned ? IMMUTABLE : 'private, no-cache',
        }
        if (req.headers['if-none-match'] === `"${file.version}"`) { res.writeHead(304, headers); res.end(); return }
        const gzip = /\.glb$/i.test(name) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? await trackModels.gzipped(id, name) : null
        if (gzip) serveFile(req, res, gzip, { ...headers, 'Content-Encoding': 'gzip' })
        else serveFile(req, res, file.path, headers)
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }); return }
      if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
        serveStaticAsset(req, res, staticDir, url.pathname)
        return
      }
      if (options.devRendererUrl) {
        const target = new URL(options.devRendererUrl)
        target.searchParams.set('catalystServer', `${url.protocol}//${url.host}`)
        res.writeHead(302, { Location: target.toString() })
        res.end()
        return
      }
      json(res, 503, { error: 'Renderer build not found. Run npm run build.' })
    } catch (error) {
      if (res.headersSent) res.end()
      else if (!res.destroyed) json(res, 500, { error: error instanceof Error ? error.message : String(error) }, origin)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort
  // Videos uploaded before the media directory move there while the server
  // runs; each is served from wherever it is meanwhile.
  const movingVideos = mediaDir
    ? moveVideosToMedia(dataDir, mediaDir, () => closing).then(
      moved => { if (moved) console.log(`[videos] moved ${moved} video(s) to ${mediaDir}`) },
      error => console.error('[videos] could not move videos to the media directory; retrying at the next start:', error))
    : Promise.resolve()
  const publicHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    host, port, url: `http://${publicHost}:${port}`, drivers,
    close: async () => {
      closing = true
      clearInterval(sweepTimer)
      // Give open requests a moment, then drop them so a restart stays short.
      const force = setTimeout(() => server.closeAllConnections(), 5_000)
      try {
        await Promise.all([
          ...[...backends.values()].map(backend => backend.close()),
          new Promise<void>(resolve => server.close(() => resolve())),
        ])
      } finally { clearTimeout(force) }
      await movingVideos
      await terrain.close()
    },
  }
}
