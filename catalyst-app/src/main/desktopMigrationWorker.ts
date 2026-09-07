import fs from 'node:fs'
import { DuckDBInstance } from '@duckdb/node-api'
import { copyDesktopWorkspace, importedDesktopUsername, type LegacyDesktopWorkspace } from './desktopMigration.js'

process.on('disconnect', () => process.exit(1))
process.once('message', async ({ dataDir, legacy }: { dataDir: string; legacy: LegacyDesktopWorkspace }) => {
  try {
    const imported = importedDesktopUsername(dataDir, legacy)
    if (imported) {
      process.send?.({ username: imported }, () => process.exit(0))
      return
    }
    // Refuse to import from a database being written by another app. Keep a
    // connection alive through the copy, including any recovery WAL file.
    const source = fs.existsSync(legacy.dbPath)
      ? await DuckDBInstance.create(legacy.dbPath, { access_mode: 'READ_ONLY' })
      : null
    const connection = await source?.connect()
    let username: string | null
    try { username = copyDesktopWorkspace(dataDir, legacy) } finally { connection?.close() }
    process.send?.({ username }, () => process.exit(0))
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.exit(1))
  }
})
