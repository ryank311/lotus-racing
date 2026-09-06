import path from 'node:path'
import { startCatalystServer } from './server.js'
import type { RunningCatalystServer } from './server.js'

function valueAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const host = valueAfter('--host') ?? process.env.CATALYST_SERVER_HOST ?? '0.0.0.0'
const port = Number(valueAfter('--port') ?? process.env.CATALYST_SERVER_PORT ?? 3210)
const dataDir = valueAfter('--data-dir') ?? process.env.CATALYST_SERVER_DATA_DIR
const appRoot = path.resolve(__dirname, '..', '..')

let running: RunningCatalystServer | null = null
let stopping = false

const stop = () => {
  if (stopping) return
  stopping = true
  if (!running) { process.exit(0); return }
  void running.close().finally(() => process.exit(0))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

void startCatalystServer({
  host,
  port,
  dataDir,
  staticDir: path.join(appRoot, 'dist-renderer'),
  templateRoot: path.resolve(appRoot, '..'),
}).then(server => {
  running = server
  console.log(`[catalyst] Headless server listening on ${host}:${server.port}`)
  console.log(`[catalyst] Open ${server.url}`)
  if (dataDir) console.log(`[catalyst] User data: ${path.resolve(dataDir)}`)
}).catch(error => {
  console.error('[catalyst] Server failed to start:', error)
  process.exitCode = 1
})
