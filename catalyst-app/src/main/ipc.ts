// IPC handlers — bridge between renderer and the Garmin/DuckDB code.

import { ipcMain, BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  CATALYST_TOKEN_CACHE,
  GARTH_TOKEN_DIR,
  SESSIONS_DIR,
  DB_PATH,
  COACHING_DIR,
  DATA_DIR,
} from '../garmin/paths.js'
import { loadConfig, setCredentials } from '../garmin/config.js'
import {
  CatalystAPI,
  fetchAllSessions,
  loadCatalystToken,
  loadCatalystTokenExpiry,
} from '../garmin/catalystClient.js'
import { loadAll, openDb } from '../garmin/loadToDb.js'
import { runBrief } from '../garmin/promptPack.js'
import { buildAnalysis } from '../garmin/analysisData.js'
import {
  discoverProfiles,
  getActiveProfileName,
  setActiveProfileName,
} from '../garmin/profiles.js'
import type {
  AuthState,
  CarProfile,
  BriefOptions,
  BriefFile,
  DbSessionRow,
  SyncStats,
  WorkerEvent,
} from '../shared/types.js'
import { loginViaBrowser } from './auth.js'

function humaniseTimeAgo(epochSec: number | null): string {
  if (!epochSec) return 'never'
  const delta = Date.now() / 1000 - epochSec
  if (delta < 90) return `${Math.round(delta)}s ago`
  if (delta < 5400) return `${Math.floor(delta / 60)} min ago`
  if (delta < 172_800) return `${Math.floor(delta / 3600)} h ago`
  return `${Math.floor(delta / 86_400)} days ago`
}

function readSyncStats(): SyncStats {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return { sessionCount: 0, totalSizeBytes: 0, lastSyncEpoch: null, lastSyncAgoHuman: 'never' }
  }
  let total = 0
  let latest = 0
  let sessionCount = 0
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, name)
    const st = fs.statSync(dir)
    if (!st.isDirectory()) continue
    sessionCount++
    for (const fn of fs.readdirSync(dir)) {
      const fp = path.join(dir, fn)
      const fs2 = fs.statSync(fp)
      if (fs2.isFile()) {
        total += fs2.size
        if (fs2.mtimeMs / 1000 > latest) latest = fs2.mtimeMs / 1000
      }
    }
  }
  return {
    sessionCount,
    totalSizeBytes: total,
    lastSyncEpoch: latest || null,
    lastSyncAgoHuman: humaniseTimeAgo(latest || null),
  }
}

function readAuthState(): AuthState {
  const expiresAt = loadCatalystTokenExpiry()
  const hasCat = expiresAt !== null
  const tokenValid = hasCat && expiresAt! - 300 > Date.now() / 1000
  const daysRemain = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now() / 1000) / 86_400)) : null
  return {
    hasCatalystToken: hasCat,
    tokenExpiresAt: expiresAt,
    hasGarthTokens: fs.existsSync(GARTH_TOKEN_DIR),
    tokenValid,
    tokenDaysRemaining: daysRemain,
  }
}

// ---- worker event broadcast --------------------------------------------

function broadcast(window: BrowserWindow | null, evt: WorkerEvent): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send('worker:event', evt)
}

let activeWorker: { kind: WorkerEvent['kind'] } | null = null

// ---- handlers ----------------------------------------------------------

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('auth:state', () => readAuthState())
  ipcMain.handle('auth:syncStats', () => readSyncStats())
  ipcMain.handle('auth:email', () => loadConfig().auth?.email ?? null)
  ipcMain.handle('auth:saveCredentials', (_e, email: string, password: string) => {
    setCredentials(email, password)
  })
  ipcMain.handle('auth:clearTokens', () => {
    if (fs.existsSync(GARTH_TOKEN_DIR)) fs.rmSync(GARTH_TOKEN_DIR, { recursive: true, force: true })
    if (fs.existsSync(CATALYST_TOKEN_CACHE)) fs.rmSync(CATALYST_TOKEN_CACHE, { force: true })
  })

  ipcMain.handle('profiles:list', (): CarProfile[] => discoverProfiles())
  ipcMain.handle('profiles:active', () => getActiveProfileName())
  ipcMain.handle('profiles:setActive', (_e, name: string) => setActiveProfileName(name))
  ipcMain.handle('profiles:files', (_e, name: string) => {
    const profile = discoverProfiles().find(p => p.name === name)
    if (!profile) return []
    return fs.readdirSync(profile.dir)
      .filter(n => n.toLowerCase().endsWith('.md'))
      .sort((a, b) => (a.toLowerCase() === 'car.md' ? -1 : b.toLowerCase() === 'car.md' ? 1 : a.localeCompare(b)))
      .map(n => ({ name: n, path: path.join(profile.dir, n) }))
  })
  ipcMain.handle('profiles:readFile', (_e, filePath: string) => {
    return fs.readFileSync(filePath, 'utf-8')
  })
  ipcMain.handle('profiles:writeCarMd', (_e, profileName: string, fileName: string, content: string) => {
    const profile = discoverProfiles().find(p => p.name === profileName)
    if (!profile) throw new Error(`unknown profile ${profileName}`)
    fs.writeFileSync(path.join(profile.dir, fileName), content)
  })
  ipcMain.handle('profiles:readCarMd', (_e, name: string) => {
    const profile = discoverProfiles().find(p => p.name === name)
    if (!profile) return ''
    return fs.readFileSync(profile.carMdPath, 'utf-8')
  })

  ipcMain.handle('db:hasDb', () => fs.existsSync(DB_PATH))
  ipcMain.handle('db:listSessions', async (): Promise<DbSessionRow[]> => {
    if (!fs.existsSync(DB_PATH)) {
      // Fall back to summary.json scan.
      if (!fs.existsSync(SESSIONS_DIR)) return []
      const rows: DbSessionRow[] = []
      for (const name of fs.readdirSync(SESSIONS_DIR).sort().reverse()) {
        const sp = path.join(SESSIONS_DIR, name, 'summary.json')
        if (!fs.existsSync(sp)) continue
        try {
          const s = JSON.parse(fs.readFileSync(sp, 'utf-8'))
          rows.push({
            session_guid: s.sessionGuid ?? name,
            session_start: s.sessionStart ?? null,
            track_name: s.trackName ?? null,
            track_configuration_name: s.trackConfigurationName ?? null,
            best_lap_ms: null,
            lap_count: 0,
            sample_count: 0,
            weather_description: null,
          })
        } catch { /* ignore */ }
      }
      return rows
    }
    const { con } = await openDb(DB_PATH, true)
    const reader = await con.runAndReadAll(`
      SELECT s.session_guid,
        CAST(s.session_start AS VARCHAR) AS session_start,
        COALESCE(tc.track_name, 'Unknown') AS track_name,
        COALESCE(tc.track_configuration_name, '') AS track_configuration_name,
        s.best_lap_ms,
        (SELECT COUNT(*) FROM laps l WHERE l.session_guid = s.session_guid) AS lap_count,
        (SELECT COUNT(*) FROM samples sm WHERE sm.session_guid = s.session_guid) AS sample_count,
        COALESCE(s.weather_description, '') AS weather_description
      FROM sessions s
      LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
      ORDER BY s.session_start DESC NULLS LAST
    `)
    return reader.getRowObjectsJson() as unknown as DbSessionRow[]
  })

  ipcMain.handle('briefs:list', (): BriefFile[] => {
    if (!fs.existsSync(COACHING_DIR)) return []
    const files = fs.readdirSync(COACHING_DIR)
      .filter(n => n.toLowerCase().endsWith('.md'))
      .map(n => {
        const p = path.join(COACHING_DIR, n)
        const st = fs.statSync(p)
        return { name: n, path: p, sizeKb: st.size / 1024, mtime: st.mtimeMs }
      })
    files.sort((a, b) => {
      const aReadme = a.name.toLowerCase() === 'readme.md'
      const bReadme = b.name.toLowerCase() === 'readme.md'
      if (aReadme !== bReadme) return aReadme ? 1 : -1
      return b.mtime - a.mtime
    })
    return files
  })
  ipcMain.handle('briefs:read', (_e, p: string) => fs.readFileSync(p, 'utf-8'))
  ipcMain.handle('briefs:generate', async (_e, opts: BriefOptions) => {
    const res = await runBrief({
      scope: opts.scope,
      profile: opts.profile,
      mode: opts.mode,
      lastN: opts.lastN,
      sessionGuids: opts.sessionGuids,
      csv: opts.csv,
      includeGuides: opts.includeGuides,
    })
    return { outPath: res.outPath }
  })

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(p)
  })

  ipcMain.handle('analysis:build', async (_e, sessionGuids: string[]) => {
    return buildAnalysis(sessionGuids)
  })

  // ---- workers ---------------------------------------------------------

  ipcMain.handle('worker:startSync', async () => {
    if (activeWorker) throw new Error('worker already running')
    activeWorker = { kind: 'sync' }
    const win = getMainWindow()

    // Use cached token if valid; otherwise launch BrowserWindow login.
    void (async () => {
      try {
        let token = loadCatalystToken()
        if (!token) {
          broadcast(win, { kind: 'sync', type: 'log', payload: '[auth] No valid token — opening Garmin sign-in window' })
          const { accessToken } = await loginViaBrowser(win ?? undefined)
          token = accessToken
          broadcast(win, { kind: 'sync', type: 'log', payload: '[auth] Login successful' })
        } else {
          broadcast(win, { kind: 'sync', type: 'log', payload: '[auth] Using cached Catalyst token' })
        }
        const api = new CatalystAPI(token)
        api.pageSize = loadConfig().api?.page_size ?? 50
        await fetchAllSessions(api, SESSIONS_DIR, e => {
          broadcast(win, { kind: 'sync', type: 'log', payload: e.message })
        })
        broadcast(win, { kind: 'sync', type: 'done' })
      } catch (e: any) {
        broadcast(win, { kind: 'sync', type: 'error', payload: `${e.message ?? e}` })
      } finally {
        activeWorker = null
      }
    })()
  })

  ipcMain.handle('worker:startLoad', async () => {
    if (activeWorker) throw new Error('worker already running')
    activeWorker = { kind: 'load' }
    const win = getMainWindow()
    void (async () => {
      try {
        await loadAll(line => broadcast(win, { kind: 'load', type: 'log', payload: line }))
        broadcast(win, { kind: 'load', type: 'done' })
      } catch (e: any) {
        broadcast(win, { kind: 'load', type: 'error', payload: `${e.message ?? e}` })
      } finally {
        activeWorker = null
      }
    })()
  })
}
