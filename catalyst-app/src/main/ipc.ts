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
  fetchAndSaveSession,
  loadCatalystToken,
  loadCatalystTokenExpiry,
} from '../garmin/catalystClient.js'
import {
  existingSessionGuids,
  initSchema,
  loadAll,
  loadSession,
  loadTrackConfigs,
  openDb,
} from '../garmin/loadToDb.js'
import { MEAN_LINES_DIR } from '../garmin/paths.js'
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
import { signInWithCredentials, submitMfaCode, cancelMfa } from './garthLogin.js'

function humaniseTimeAgo(epochSec: number | null): string {
  if (!epochSec) return 'never'
  const delta = Date.now() / 1000 - epochSec
  if (delta < 90) return `${Math.round(delta)}s ago`
  if (delta < 5400) return `${Math.floor(delta / 60)} min ago`
  if (delta < 172_800) return `${Math.floor(delta / 3600)} h ago`
  return `${Math.floor(delta / 86_400)} days ago`
}

async function readSyncStats(): Promise<SyncStats> {
  const empty: SyncStats = {
    sessionCount: 0, lapCount: 0, sampleCount: 0,
    totalSizeBytes: 0, lastSyncEpoch: null, lastSyncAgoHuman: 'never',
  }
  if (!fs.existsSync(DB_PATH)) return empty

  let sessionCount = 0, lapCount = 0, sampleCount = 0
  try {
    const { con } = await openDb(DB_PATH, true)
    const reader = await con.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM sessions),
        (SELECT COUNT(*) FROM laps),
        (SELECT COUNT(*) FROM samples)
    `)
    const row = reader.getRowsJson()[0] ?? []
    sessionCount = Number(row[0] ?? 0)
    lapCount = Number(row[1] ?? 0)
    sampleCount = Number(row[2] ?? 0)
  } catch {
    // schema not initialised yet — treat as empty
    return empty
  }

  const st = fs.statSync(DB_PATH)
  const lastSync = st.mtimeMs / 1000
  return {
    sessionCount, lapCount, sampleCount,
    totalSizeBytes: st.size,
    lastSyncEpoch: lastSync,
    lastSyncAgoHuman: humaniseTimeAgo(lastSync),
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
  // Browser-based sign-in (last-resort fallback). The default path is the
  // credentials flow below — it's the Python `garth` library's exact sequence.
  ipcMain.handle('auth:signIn', async () => {
    const win = getMainWindow()
    const { accessToken, expiresIn } = await loginViaBrowser(win ?? undefined)
    return { token: accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn }
  })

  // Headless credentials sign-in — same wire format as garth's login().
  // Returns either a final token or `{ needsMfa: true, sessionId }` so the
  // renderer can prompt for a code and follow up with auth:signInMfa.
  ipcMain.handle('auth:signInWithCreds', async (_e, email: string, password: string) => {
    const result = await signInWithCredentials(email, password)
    if (result.kind === 'mfa') return { needsMfa: true, sessionId: result.sessionId }
    return {
      needsMfa: false,
      token: result.accessToken,
      expiresAt: Math.floor(Date.now() / 1000) + result.expiresIn,
    }
  })

  ipcMain.handle('auth:signInMfa', async (_e, sessionId: string, code: string) => {
    const { accessToken, expiresIn } = await submitMfaCode(sessionId, code)
    return { token: accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn }
  })

  ipcMain.handle('auth:cancelMfa', (_e, sessionId: string) => cancelMfa(sessionId))

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
  ipcMain.handle('db:listSessions', async (_e, accountLabel?: string | null): Promise<DbSessionRow[]> => {
    const matchesAccount = (a: string | null): boolean =>
      !accountLabel || a == null || a === accountLabel
    if (!fs.existsSync(DB_PATH)) {
      // Fall back to summary.json scan, using the .account sidecar for filtering.
      if (!fs.existsSync(SESSIONS_DIR)) return []
      const rows: DbSessionRow[] = []
      for (const name of fs.readdirSync(SESSIONS_DIR).sort().reverse()) {
        const sp = path.join(SESSIONS_DIR, name, 'summary.json')
        if (!fs.existsSync(sp)) continue
        const ap = path.join(SESSIONS_DIR, name, '.account')
        const acct = fs.existsSync(ap) ? fs.readFileSync(ap, 'utf-8').trim() || null : null
        if (!matchesAccount(acct)) continue
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
            account: acct,
          })
        } catch { /* ignore */ }
      }
      return rows
    }
    const { con } = await openDb(DB_PATH, true)
    const whereClause = accountLabel ? 'WHERE s.account = ? OR s.account IS NULL' : ''
    const reader = await con.runAndReadAll(`
      SELECT s.session_guid,
        CAST(s.session_start AS VARCHAR) AS session_start,
        COALESCE(tc.track_name, 'Unknown') AS track_name,
        COALESCE(tc.track_configuration_name, '') AS track_configuration_name,
        s.best_lap_ms,
        (SELECT COUNT(*) FROM laps l WHERE l.session_guid = s.session_guid) AS lap_count,
        (SELECT COUNT(*) FROM samples sm WHERE sm.session_guid = s.session_guid) AS sample_count,
        COALESCE(s.weather_description, '') AS weather_description,
        s.account
      FROM sessions s
      LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
      ${whereClause}
      ORDER BY s.session_start DESC NULLS LAST
    `, accountLabel ? [accountLabel] as any : undefined)
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

  ipcMain.handle('worker:startSync', async (_e, opts?: { token?: string; accountLabel?: string }) => {
    if (activeWorker) throw new Error('worker already running')
    activeWorker = { kind: 'sync' }
    const win = getMainWindow()
    const accountLabel = opts?.accountLabel ?? null
    const log = (msg: string) => broadcast(win, { kind: 'sync', type: 'log', payload: msg })

    // Smart sync: diff Garmin's session list against what's already in the DB,
    // fetch + load only the new ones, and update the DB incrementally.
    // No full rebuild — that's what the Rebuild DB button is for.
    void (async () => {
      try {
        let token = opts?.token || loadCatalystToken()
        if (!token) {
          log('[auth] No valid token — opening Garmin sign-in window')
          const { accessToken } = await loginViaBrowser(win ?? undefined)
          token = accessToken
          log('[auth] Login successful')
        } else {
          log(`[auth] Syncing as ${accountLabel ?? 'unlabeled account'}`)
        }
        const api = new CatalystAPI(token)
        api.pageSize = loadConfig().api?.page_size ?? 50

        // Open / initialise the DB before doing any network work so we can
        // diff against it.
        const { con } = await openDb()
        await initSchema(con)
        const knownGuids = await existingSessionGuids(con)
        log(`[sync] DB already contains ${knownGuids.size} session(s)`)

        log('[sync] Fetching session list from Garmin...')
        const summaries = await api.getSessions({
          onProgress: n => log(`  [sessions] fetched ${n} summaries so far...`),
        })
        const newSessions = summaries.filter(s => s.sessionGuid && !knownGuids.has(s.sessionGuid))
        const skipped = summaries.length - newSessions.length
        log(`[sync] Garmin has ${summaries.length} session(s) — ${newSessions.length} new, ${skipped} already loaded`)

        if (newSessions.length === 0) {
          log('[sync] Up to date — nothing to download.')
          broadcast(win, { kind: 'sync', type: 'done' })
          return
        }

        // Refresh track facilities + configurations once so new sessions' track
        // names resolve in the DB. These are small JSON blobs.
        try {
          log('[sync] Refreshing track facilities + configurations...')
          const facilities = await api.getTrackFacilities()
          fs.writeFileSync(path.join(DATA_DIR, 'track_facilities.json'), JSON.stringify(facilities, null, 2))
          const configsByTrack: Record<string, any[]> = {}
          for (const fac of facilities) {
            const cid = (fac as any).trackCartographyId
            if (!cid) continue
            try {
              configsByTrack[String(cid)] = await api.getTrackConfigurations(cid)
            } catch (e: any) {
              log(`  [WARN] configs ${cid}: ${e.message ?? e}`)
            }
          }
          fs.writeFileSync(path.join(DATA_DIR, 'track_configurations.json'), JSON.stringify(configsByTrack, null, 2))
          const n = await loadTrackConfigs(con)
          log(`  loaded ${n} track config rows`)
        } catch (e: any) {
          log(`[sync] track config refresh failed (continuing): ${e.message ?? e}`)
        }

        fs.mkdirSync(MEAN_LINES_DIR, { recursive: true })

        // Fetch + load each new session in order. Fetch is the slow part
        // (network); DB insert is fast via the Appender.
        let loaded = 0
        let failed = 0
        for (let i = 0; i < newSessions.length; i++) {
          const s = newSessions[i]
          const sg = s.sessionGuid!
          log(`[${i + 1}/${newSessions.length}] ${sg.slice(0, 8)}… ${s.trackName ?? ''} ${s.bestLap ?? ''}`)
          try {
            await fetchAndSaveSession(api, s, SESSIONS_DIR, MEAN_LINES_DIR,
              e => log(`  ${e.message}`),
              accountLabel,
            )
            const samples = await loadSession(con, path.join(SESSIONS_DIR, sg))
            log(`  ✓ loaded ${samples.toLocaleString()} samples into DB`)
            loaded++
          } catch (e: any) {
            failed++
            log(`  ✗ FAILED: ${e.message ?? e}`)
          }
          // Brief courtesy pause between sessions to avoid hammering the API.
          await new Promise(r => setTimeout(r, 300))
        }

        log(`[sync] done — ${loaded} loaded, ${failed} failed, ${skipped} skipped (already in DB)`)
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
