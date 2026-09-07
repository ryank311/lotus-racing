/** Passwordless multi-user HTTP server for Catalyst Coach. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { accountKey, defaultServerDataDir, userDirectory, USER_RE } from './serverStorage.js'

export interface CatalystServerOptions {
  host?: string
  port?: number
  dataDir?: string
  staticDir?: string
  devRendererUrl?: string
  templateRoot?: string
  resourcesPath?: string
}

export interface RunningCatalystServer {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

interface WorkerReply {
  type: 'ready' | 'fatal' | 'event' | 'rpc-result'
  requestId?: number
  ok?: boolean
  result?: unknown
  error?: string
  channel?: string
  payload?: unknown
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const COOKIE = 'catalyst_session'
const MAX_BODY = 25 * 1024 * 1024
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

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.ico': return 'image/x-icon'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
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
  ) {
    const workerPath = path.join(__dirname, 'userWorker.js')
    const env = { ...process.env }
    // Legacy desktop overrides must not escape a driver's instance directory.
    delete env.CATALYST_DATA_DIR
    delete env.CATALYST_DB_PATH
    delete env.CATALYST_REPO_ROOT
    this.child = fork(workerPath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        CATALYST_INSTANCE_DIR: instanceDir,
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
    if (message.type === 'fatal') {
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

export async function startCatalystServer(options: CatalystServerOptions = {}): Promise<RunningCatalystServer> {
  const host = options.host ?? process.env.CATALYST_SERVER_HOST ?? '0.0.0.0'
  const requestedPort = options.port ?? Number(process.env.CATALYST_SERVER_PORT ?? 3210)
  const dataDir = path.resolve(options.dataDir ?? defaultServerDataDir())
  const usersDir = path.join(dataDir, 'users')
  fs.mkdirSync(usersDir, { recursive: true })

  const secretPath = path.join(dataDir, '.session-secret')
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
  }
  const secret = fs.readFileSync(secretPath)
  // Account names are case-insensitive to prevent two worker processes from
  // opening the same hashed database directory (for example Ryan vs ryan).
  const backends = new Map<string, UserBackend>()
  let closing = false

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
      })
      backends.set(key, backend)
    }
    return backend
  }

  const staticDir = options.staticDir ? path.resolve(options.staticDir) : null
  const server: Server = createServer(async (req, res) => {
    const origin = req.headers.origin
    if (req.method === 'OPTIONS' && req.url?.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        if (typeof body?.channel !== 'string' || !Array.isArray(body.args)) {
          json(res, 400, { error: 'Invalid RPC request' }, origin)
          return
        }
        const result = await backendFor(username).call(body.channel, body.args)
        json(res, 200, { result }, origin)
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }); return }
      if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
        const decoded = decodeURIComponent(url.pathname)
        const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
        let filePath = path.resolve(staticDir, relative)
        if (!filePath.startsWith(staticDir + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          filePath = path.join(staticDir, 'index.html')
        }
        res.writeHead(200, { 'Content-Type': mimeType(filePath), 'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=3600' })
        if (req.method === 'HEAD') res.end()
        else fs.createReadStream(filePath).on('error', error => res.destroy(error)).pipe(res)
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
  const publicHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    host, port, url: `http://${publicHost}:${port}`,
    close: async () => {
      closing = true
      await Promise.all([
        ...[...backends.values()].map(backend => backend.close()),
        new Promise<void>(resolve => server.close(() => resolve())),
      ])
    },
  }
}
