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
import { DB_PATH, LEGACY_VIDEOS_DIR, VIDEOS_DIR, seedUserData } from '../garmin/paths.js'
import { initSchema, openDb, withDb } from '../garmin/loadToDb.js'
import { redecodeVideos, storedVideoFile } from '../garmin/videoStore.js'
import { syncCatalystVideoOffsets } from '../garmin/catalystVideos.js'
import { prepareTrackLibrary } from '../garmin/trackStore.js'
import { remoteTrackLibrary, useTrackLibrary } from '../garmin/trackLibrary.js'

interface RpcRequest {
  type: 'rpc'
  requestId: number
  channel: string
  args: unknown[]
}

// Requests to the server process for data shared by every driver (AI keys,
// the track library); answered as `<type>-result`.
let serverRequestId = 0
function serverRequest(type: 'ai-keys' | 'tracks', payload: object, label: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = ++serverRequestId
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} request timed out`)) }, 30_000)
    const listener = (message: any) => {
      if (message?.type !== `${type}-result` || message.requestId !== requestId) return
      cleanup()
      if (message.ok) resolve(message.result)
      else reject(new Error(message.error))
    }
    const cleanup = () => { clearTimeout(timer); process.off('message', listener) }
    process.on('message', listener)
    send({ type, requestId, ...payload })
  })
}
const aiKeys: AiKeyStore = {
  read: () => serverRequest('ai-keys', { operation: 'read' }, 'AI key database'),
  write: (keys, onlyMissing) => serverRequest('ai-keys', { operation: 'write', keys, onlyMissing }, 'AI key database'),
}
// Track layouts are shared by every driver on the server.
useTrackLibrary(remoteTrackLibrary((op, args) => serverRequest('tracks', { op, args }, 'Track library')))

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
    try {
      await initSchema(db.con)
      // This workspace's older layouts and the track YAML seeds go into the
      // server's shared track library.
      await prepareTrackLibrary(db.con)
      // Catalyst videos imported before their recording clock was used.
      await syncCatalystVideoOffsets(db.con).catch(error => console.error('[video] re-sync failed:', error))
    } finally { await db.close() }
  }
  // The server's one-time pass over every driver's workspace stops here.
  if (process.env.CATALYST_WORKER_TASK === 'share-tracks') {
    send({ type: 'ready' })
    return
  }

  const backend = registerApiHandlers((channel, handler) => handlers.set(channel, handler), () => eventTarget, undefined, aiKeys)
  void backend.startReviews().catch(error => console.error('[review startup]', error))

  process.on('message', (message: RpcRequest | { type: 'tracks-changed' }) => {
    if (message?.type === 'tracks-changed') { backend.tracksChanged(); return }
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
  // Videos stored before the car data was decoded the current way: after
  // ready, since it reads every stored record.
  if (fs.existsSync(DB_PATH)) {
    void withDb(con => redecodeVideos(con, id => storedVideoFile([VIDEOS_DIR, LEGACY_VIDEOS_DIR], id)), DB_PATH)
      .catch(error => console.error('[video] decoding stored videos again failed:', error))
  }
}

void start().catch(error => {
  process.send?.({ type: 'fatal', error: error instanceof Error ? error.stack : String(error) }, () => process.exit(1))
  if (!process.connected) process.exit(1)
})
