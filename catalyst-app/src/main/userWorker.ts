/**
 * Private backend process for one remote Catalyst username.
 *
 * CATALYST_INSTANCE_DIR is set by the parent server before this module loads,
 * so every imported data path is scoped to this user. The worker exposes the
 * same handler registry used by Electron IPC over Node's built-in IPC channel.
 */

import fs from 'node:fs'
import type { AiKeyStore, AiKeys } from './aiKeyStore.js'
import { registerApiHandlers, type ApiHandler, type BackendEventTarget } from './ipc.js'
import { DB_PATH, seedUserData } from '../garmin/paths.js'
import { initSchema, openDb } from '../garmin/loadToDb.js'
import { exchangeTicketForToken } from '../garmin/catalystClient.js'

interface RpcRequest {
  type: 'rpc'
  requestId: number
  channel: string
  args: unknown[]
}

let keyRequestId = 0
function keyRequest(operation: 'read' | 'write', keys?: AiKeys, onlyMissing?: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = ++keyRequestId
    const timer = setTimeout(() => { cleanup(); reject(new Error('AI key database request timed out')) }, 30_000)
    const listener = (message: any) => {
      if (message?.type !== 'ai-keys-result' || message.requestId !== requestId) return
      cleanup()
      if (message.ok) resolve(message.result)
      else reject(new Error(message.error))
    }
    const cleanup = () => { clearTimeout(timer); process.off('message', listener) }
    process.on('message', listener)
    send({ type: 'ai-keys', requestId, operation, keys, onlyMissing })
  })
}
const aiKeys: AiKeyStore = {
  read: () => keyRequest('read'),
  write: (keys, onlyMissing) => keyRequest('write', keys, onlyMissing),
}

const handlers = new Map<string, ApiHandler>()

function send(message: unknown): void {
  if (!process.connected) return
  process.send?.(message as any, error => {
    if (error) process.exit(1)
  })
}

// Do not leave a worker holding its database lock after the server exits.
process.on('disconnect', () => process.exit(0))

const eventTarget: BackendEventTarget = {
  isDestroyed: () => false,
  webContents: {
    send(channel, payload) {
      send({ type: 'event', channel, payload })
    },
  },
}

function forwardConsole(): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      const message = args.map(value => {
        if (typeof value === 'string') return value
        try { return JSON.stringify(value) } catch { return String(value) }
      }).join(' ')
      send({
        type: 'event', channel: 'app:log',
        payload: { level, message, ts: Date.now() },
      })
    }
  }
}

async function start(): Promise<void> {
  forwardConsole()
  seedUserData()
  if (fs.existsSync(DB_PATH)) {
    const db = await openDb(DB_PATH)
    try { await initSchema(db.con) } finally { await db.close() }
  }

  const backend = registerApiHandlers((channel, handler) => handlers.set(channel, handler), () => eventTarget, undefined, undefined, aiKeys)
  void backend.startReviews().catch(error => console.error('[review startup]', error))
  handlers.set('auth:completeSso', async (_event, ticket: string, serviceUrl: string) => {
    const { expiresIn } = await exchangeTicketForToken(ticket, serviceUrl)
    return { token: '', expiresAt: Math.floor(Date.now() / 1000) + expiresIn }
  })

  process.on('message', (message: RpcRequest) => {
    if (!message || message.type !== 'rpc') return
    const handler = handlers.get(message.channel)
    if (!handler) {
      send({
        type: 'rpc-result', requestId: message.requestId,
        ok: false, error: `Unknown API method: ${message.channel}`,
      })
      return
    }
    void Promise.resolve().then(() => handler({}, ...(message.args ?? []))).then(
      result => send({ type: 'rpc-result', requestId: message.requestId, ok: true, result }),
      error => send({
        type: 'rpc-result', requestId: message.requestId, ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })

  send({ type: 'ready' })
}

void start().catch(error => {
  process.send?.({ type: 'fatal', error: error instanceof Error ? error.stack : String(error) }, () => process.exit(1))
  if (!process.connected) process.exit(1)
})
