import fs from 'node:fs'
import path from 'node:path'
import { CatalystAPI, fetchAndSaveSession, type SessionSummary } from './catalystClient.js'
import { existingSessionGuids, initSchema, loadSession, loadSessionSummary, loadTrackConfigs, openDb } from './loadToDb.js'
import { DATA_DIR, MEAN_LINES_DIR, SESSIONS_DIR } from './paths.js'
import type { WorkerProgress } from '../shared/types.js'

export const RECENT_SESSION_LIMIT = 20

export function validateSessionGuids(guids: string[]): void {
  if (!Array.isArray(guids) || guids.some(guid => typeof guid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(guid))) {
    throw new Error('Invalid session IDs')
  }
}

/** Refresh the entire catalogue, but only materialize the requested telemetry. */
export async function syncSessions(options: {
  api: CatalystAPI
  accountLabel: string | null
  mode?: 'recent' | 'all'
  sessionGuids?: string[]
  log: (message: string) => void
  onProgress: (progress: WorkerProgress) => void
  onCatalog: () => void
}): Promise<void> {
  const { api, accountLabel, log, onProgress } = options
  const db = await openDb()
  try {
    await initSchema(db.con)
    const known = await existingSessionGuids(db.con)
    let summaries: SessionSummary[]
    if (options.sessionGuids) {
      validateSessionGuids(options.sessionGuids)
      summaries = [...new Set(options.sessionGuids)].filter(guid => !known.has(guid)).map(guid => {
        const directory = path.join(SESSIONS_DIR, guid)
        const summaryPath = path.join(directory, 'summary.json')
        if (!fs.existsSync(summaryPath)) throw new Error('Session overview is missing. Run Sync now first.')
        const ownerPath = path.join(directory, '.account')
        const owner = fs.existsSync(ownerPath) ? fs.readFileSync(ownerPath, 'utf8').trim() : null
        if (accountLabel && owner && owner !== accountLabel) throw new Error('Sign in with the account that owns this session.')
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as SessionSummary
        if (summary.sessionGuid !== guid) throw new Error('Session overview has an invalid ID.')
        return summary
      })
    } else {
      log('[sync] Fetching session overviews from Garmin…')
      summaries = await api.getSessions({ onProgress: n => log(`[sessions] ${n} overviews fetched`) })
      summaries = [...new Map(summaries.filter(s => s.sessionGuid).map(s => [s.sessionGuid, s])).values()]
      validateSessionGuids(summaries.map(s => s.sessionGuid!))
      summaries.sort((a, b) => (b.sessionStart ?? '').localeCompare(a.sessionStart ?? ''))
      // Keep summaries on disk as well, so Rebuild DB retains the full catalogue.
      for (const summary of summaries) {
        const directory = path.join(SESSIONS_DIR, summary.sessionGuid!)
        fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary))
        if (accountLabel) fs.writeFileSync(path.join(directory, '.account'), accountLabel)
        await loadSessionSummary(db.con, summary, accountLabel)
      }
      log(`[sync] Saved ${summaries.length} session overviews`)
      options.onCatalog()
      if (options.mode !== 'all') summaries = summaries.slice(0, RECENT_SESSION_LIMIT)
    }

    const targets = summaries.filter(s => !known.has(s.sessionGuid!))
    log(`[sync] Downloading details for ${targets.length} session(s); cached details are reused`)
    onProgress({ current: 0, total: targets.length, label: 'Downloading session details…' })

    // Refresh only track configurations used by these sessions.
    if (targets.length) {
      try {
        const facilities = await api.getTrackFacilities()
        fs.writeFileSync(path.join(DATA_DIR, 'track_facilities.json'), JSON.stringify(facilities))
        const configPath = path.join(DATA_DIR, 'track_configurations.json')
        const configs = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
        for (const id of new Set(targets.map(s => s.trackCartographyId).filter(id => id != null))) {
          try { configs[String(id)] = await api.getTrackConfigurations(id!) }
          catch (error) { log(`[sync] Track configuration unavailable: ${error}`) }
        }
        fs.writeFileSync(configPath, JSON.stringify(configs))
        await loadTrackConfigs(db.con)
      } catch (error) { log(`[sync] Track refresh failed (continuing): ${error}`) }
    }

    let failed = 0
    for (const [index, summary] of targets.entries()) {
      const guid = summary.sessionGuid!
      const progress = { current: index + 1, total: targets.length,
        label: `${summary.trackName ?? guid.slice(0, 8)} · ${(summary.sessionStart ?? '').slice(0, 10)}` }
      onProgress(progress)
      try {
        await fetchAndSaveSession(api, summary, SESSIONS_DIR, MEAN_LINES_DIR, event => {
          log(event.message)
          if (event.fileName) onProgress({ ...progress, fileName: event.fileName })
        }, accountLabel)
        const samples = await loadSession(db.con, path.join(SESSIONS_DIR, guid))
        log(`[sync] ${guid.slice(0, 8)}: saved ${samples.toLocaleString()} samples`)
      } catch (error) {
        failed++
        log(`[sync] ${guid.slice(0, 8)} failed: ${error}`)
      }
      if (index < targets.length - 1) await new Promise(resolve => setTimeout(resolve, 300))
    }
    if (failed) throw new Error(`${failed} session download(s) failed. Successfully downloaded sessions were saved; retry to fetch the rest.`)
    log(`[sync] Complete — ${targets.length} session(s) downloaded`)
  } finally {
    await db.close()
  }
}
