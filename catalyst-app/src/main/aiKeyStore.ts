import fs from 'node:fs'
import path from 'node:path'
import { withDb } from '../garmin/loadToDb.js'
import type { AiProvider } from '../shared/types.js'

export type AiKeys = Partial<Record<AiProvider, string>>
export interface AiKeyStore {
  read(): Promise<AiKeys>
  write(keys: AiKeys, onlyMissing?: boolean): Promise<void>
}

// Only the server process opens the shared database. User workers access it
// through private process IPC, never through a browser-accessible RPC method.
const stores = new Map<string, AiKeyStore>()
export function databaseAiKeyStore(filename: string): AiKeyStore {
  filename = path.resolve(filename)
  const existing = stores.get(filename)
  if (existing) return existing
  let initialized = false
  let queue: Promise<unknown> = Promise.resolve()
  const run = <T>(operation: Parameters<typeof withDb<T>>[0]): Promise<T> => {
    const result = queue.then(() => withDb(async con => {
      if (!initialized) {
        await con.run('CREATE TABLE IF NOT EXISTS ai_provider_keys (provider VARCHAR PRIMARY KEY, api_key VARCHAR NOT NULL)')
        initialized = true
      }
      return operation(con)
    }, filename))
    queue = result.catch(() => {})
    return result
  }
  const store: AiKeyStore = {
    read: () => run(async con => {
      const rows = (await con.runAndReadAll('SELECT provider, api_key FROM ai_provider_keys')).getRowsJson()
      return Object.fromEntries(rows.map(row => [String(row[0]), String(row[1])])) as AiKeys
    }),
    write: (keys, onlyMissing = false) => {
      if (keys.anthropic === undefined && keys.openai === undefined) return Promise.resolve()
      return run(async con => {
        await con.run('BEGIN TRANSACTION')
        try {
          for (const provider of ['anthropic', 'openai'] as const) {
            if (keys[provider] === undefined) continue
            if (typeof keys[provider] !== 'string') throw new Error('API key must be a string')
            // Empty values are tombstones: a later legacy import must not
            // resurrect a key that a user explicitly removed.
            await con.run(`INSERT INTO ai_provider_keys VALUES (?, ?) ON CONFLICT (provider) ${
              onlyMissing ? 'DO NOTHING' : 'DO UPDATE SET api_key = excluded.api_key'
            }`, [provider, keys[provider]!.trim()])
          }
          await con.run('COMMIT')
        } catch (error) { await con.run('ROLLBACK'); throw error }
      })
    },
  }
  stores.set(filename, store)
  return store
}

export async function migrateAiConfig(filename: string, store: AiKeyStore): Promise<void> {
  if (!fs.existsSync(filename)) return
  let cfg: any
  try { cfg = JSON.parse(fs.readFileSync(filename, 'utf8')) }
  catch (error) {
    // One corrupt driver config must not prevent every other login from starting.
    if (error instanceof SyntaxError) return
    throw error
  }
  if (!cfg?.ai || typeof cfg.ai !== 'object') return
  const fields = ['api_key', 'anthropic_api_key', 'openai_api_key']
  if (!fields.some(field => Object.hasOwn(cfg.ai, field))) return
  const anthropic = cfg.ai.anthropic_api_key || cfg.ai.api_key
  const openai = cfg.ai.openai_api_key
  await store.write({ ...(anthropic ? { anthropic } : {}), ...(openai ? { openai } : {}) }, true)
  // Re-read after the asynchronous database commit to preserve other settings.
  const latest = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (latest.ai) for (const field of fields) delete latest.ai[field]
  fs.writeFileSync(filename, JSON.stringify(latest, null, 2))
}

export async function migrateServerAiKeys(dataDir: string, store: AiKeyStore): Promise<void> {
  const usersDir = path.join(dataDir, 'users')
  const configs = fs.readdirSync(usersDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(usersDir, entry.name, 'garmin', 'config.json'))
    .filter(filename => fs.existsSync(filename))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || a.localeCompare(b))
  // Existing database keys win; otherwise the newest config wins per provider.
  for (const filename of configs) await migrateAiConfig(filename, store)
}
