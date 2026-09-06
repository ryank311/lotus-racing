/** Passwordless multi-user HTTP server for Catalyst Coach. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
const USER_RE = /^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,39}$/u

function defaultServerDataDir(): string {
  if (process.env.CATALYST_SERVER_DATA_DIR) return path.resolve(process.env.CATALYST_SERVER_DATA_DIR)
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'catalyst-coach', 'server')
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'catalyst-coach', 'server')
  }
  return path.join(os.homedir(), '.config', 'catalyst-coach', 'server')
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
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private listeners = new Set<ServerResponse>()

  constructor(
    readonly username: string,
    instanceDir: string,
    options: CatalystServerOptions,
  ) {
    const workerPath = path.join(__dirname, 'userWorker.js')
    this.child = fork(workerPath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CATALYST_INSTANCE_DIR: instanceDir,
        ...(options.templateRoot ? { CATALYST_TEMPLATE_ROOT: options.templateRoot } : {}),
        ...(options.resourcesPath ? { CATALYST_BUNDLED_RESOURCES: options.resourcesPath } : {}),
      },
    })

    this.ready = new Promise((resolve, reject) => {
      const onInitial = (message: WorkerReply) => {
        if (message.type === 'ready') { this.child.off('message', onInitial); resolve() }
        if (message.type === 'fatal') { this.child.off('message', onInitial); reject(new Error(message.error)) }
      }
      this.child.on('message', onInitial)
      this.child.once('exit', code => reject(new Error(`Backend for ${username} exited during startup (${code})`)))
    })

    this.child.on('message', (message: WorkerReply) => this.onMessage(message))
    this.child.on('exit', code => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error(`Backend process exited (${code})`))
      }
      this.pending.clear()
      for (const stream of this.listeners) stream.end()
      this.listeners.clear()
    })
  }

  private onMessage(message: WorkerReply): void {
    if (message.type === 'rpc-result' && message.requestId != null) {
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

  async call(channel: string, args: unknown[]): Promise<unknown> {
    await this.ready
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Backend request timed out: ${channel}`))
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.child.send({ type: 'rpc', requestId, channel, args })
    })
  }

  addEventStream(res: ServerResponse): void {
    this.listeners.add(res)
    res.write(`data: ${JSON.stringify({ channel: 'server:connected', payload: { username: this.username } })}\n\n`)
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000)
    res.on('close', () => { clearInterval(heartbeat); this.listeners.delete(res) })
  }

  close(): void {
    this.child.kill()
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
    const accountKey = username.normalize('NFKC').toLocaleLowerCase()
    let backend = backends.get(accountKey)
    if (!backend) {
      const userId = createHash('sha256').update(accountKey).digest('hex').slice(0, 24)
      const instanceDir = path.join(usersDir, userId)
      fs.mkdirSync(instanceDir, { recursive: true })
      fs.writeFileSync(path.join(instanceDir, 'account.json'), JSON.stringify({ username }, null, 2))
      backend = new UserBackend(username, instanceDir, options)
      backends.set(accountKey, backend)
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

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const username = verify(parseCookies(req)[COOKIE])

    try {
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
        const candidate = typeof body.username === 'string' ? body.username.trim().normalize('NFKC') : ''
        if (!USER_RE.test(candidate)) {
          json(res, 400, { error: 'Use 1–40 letters, numbers, spaces, dots, dashes, or underscores.' }, origin)
          return
        }
        backendFor(candidate)
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
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' } : {}),
        })
        backendFor(username).addEventStream(res)
        return
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        if (!username) { json(res, 401, { error: 'Not signed in' }, origin); return }
        const body = await readJson(req)
        if (typeof body.channel !== 'string' || !Array.isArray(body.args)) {
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
        else fs.createReadStream(filePath).pipe(res)
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
      json(res, 500, { error: error instanceof Error ? error.message : String(error) }, origin)
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
    close: () => new Promise(resolve => {
      for (const backend of backends.values()) backend.close()
      server.close(() => resolve())
    }),
  }
}
