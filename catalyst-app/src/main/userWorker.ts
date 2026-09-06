/**
 * Private backend process for one remote Catalyst username.
 *
 * CATALYST_INSTANCE_DIR is set by the parent server before this module loads,
 * so every imported data path is scoped to this user. The worker exposes the
 * same handler registry used by Electron IPC over Node's built-in IPC channel.
 */

import fs from 'node:fs'
import { registerApiHandlers, type ApiHandler, type BackendEventTarget } from './ipc.js'
import { DB_PATH, seedUserData } from '../garmin/paths.js'
import { initSchema, openDb } from '../garmin/loadToDb.js'

interface RpcRequest {
  type: 'rpc'
  requestId: number
  channel: string
  args: unknown[]
}

const handlers = new Map<string, ApiHandler>()

const eventTarget: BackendEventTarget = {
  isDestroyed: () => false,
  webContents: {
    send(channel, payload) {
      process.send?.({ type: 'event', channel, payload })
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
      process.send?.({
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

  registerApiHandlers((channel, handler) => handlers.set(channel, handler), () => eventTarget)

  process.on('message', (message: RpcRequest) => {
    if (!message || message.type !== 'rpc') return
    const handler = handlers.get(message.channel)
    if (!handler) {
      process.send?.({
        type: 'rpc-result', requestId: message.requestId,
        ok: false, error: `Unknown API method: ${message.channel}`,
      })
      return
    }
    void Promise.resolve(handler({}, ...(message.args ?? []))).then(
      result => process.send?.({ type: 'rpc-result', requestId: message.requestId, ok: true, result }),
      error => process.send?.({
        type: 'rpc-result', requestId: message.requestId, ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })

  process.send?.({ type: 'ready' })
}

void start().catch(error => {
  process.send?.({ type: 'fatal', error: error instanceof Error ? error.stack : String(error) })
  process.exitCode = 1
})
