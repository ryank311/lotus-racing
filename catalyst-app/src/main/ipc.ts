// IPC handlers — bridge between renderer and the Garmin/DuckDB code.

import fs from 'node:fs'
import path from 'node:path'
import {
  CATALYST_TOKEN_CACHE,
  GARTH_TOKEN_DIR,
  SESSIONS_DIR,
  DB_PATH,
  COACHING_DIR,
  DATA_DIR,
  CONFIG_PATH,
  INSTANCE_DIR,
} from '../garmin/paths.js'
import { databaseAiKeyStore, migrateAiConfig, type AiKeyStore } from './aiKeyStore.js'
import { configuredModelFor } from '../shared/aiModels.js'
import { loadConfig, saveConfig, setAccountEmail, setCredentials } from '../garmin/config.js'
import { DEFAULT_UNIT_SYSTEM, type UnitSystem } from '../shared/units.js'
import { replaceSessionIds } from '../shared/sessionIdentity.js'
import {
  CatalystAPI,
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
  withDb,
  insertCoachingSession,
  listCoachingSessions,
  getCoachingSession,
  deleteCoachingSession,
} from '../garmin/loadToDb.js'
import { MEAN_LINES_DIR, TRACKS_DIR } from '../garmin/paths.js'
import { buildTrackGeometry } from '../garmin/trackGeometry.js'
import { loadTrackYaml, resolveTrackYamlPath, saveTrackYamlCorners, TrackCorner } from '../garmin/trackYaml.js'
import { runBrief, runCoach } from '../garmin/promptPack.js'
import { parseCoachResponse } from '../garmin/coachParser.js'
import { runAgent } from '../garmin/agentHarness.js'
import { COACHING_TOOL } from '../garmin/coachingTool.js'
import { buildAnalysis } from '../garmin/analysisData.js'
import { syncSessions, validateSessionGuids } from '../garmin/sessionSync.js'
import {
  deleteGarageFile,
  ensureGarageProfile,
  getGarageActiveProfile,
  listGarageFiles,
  listGarageProfiles,
  readGarageFile,
  resolveGarageVehicleProfile,
  setGarageActiveProfile,
  setGarageVehicleProfile,
  writeGarageFile,
} from '../garmin/garageStore.js'
import { randomUUID } from 'node:crypto'
import type {
  AuthState,
  CarProfile,
  BriefOptions,
  BriefFile,
  DbSessionRow,
  SyncStats,
  SyncOptions,
  AccountStats,
  WorkerEvent,
  CoachOptions,
  CoachingSession,
  AiSettings,
  AiProvider,
} from '../shared/types.js'
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
    sessionCount: 0, lapCount: 0, sampleCount: 0, trackCount: 0,
    totalSizeBytes: 0, lastSyncEpoch: null, lastSyncAgoHuman: 'never',
  }
  if (!fs.existsSync(DB_PATH)) {
    console.warn('[readSyncStats] DB file not found at', DB_PATH)
    return empty
  }

  let sessionCount = 0, lapCount = 0, sampleCount = 0, trackCount = 0
  try {
    await withDb(async con => {
      const reader = await con.runAndReadAll(`
        SELECT
          (SELECT COUNT(*) FROM sessions),
          (SELECT COUNT(*) FROM laps),
          (SELECT COUNT(*) FROM samples),
          (SELECT COUNT(DISTINCT track_configuration_id) FROM sessions
              WHERE track_configuration_id IS NOT NULL)
      `)
      const row = reader.getRowsJson()[0] ?? []
      sessionCount = Number(row[0] ?? 0)
      lapCount = Number(row[1] ?? 0)
      sampleCount = Number(row[2] ?? 0)
      trackCount = Number(row[3] ?? 0)
    }, DB_PATH)
  } catch (e: any) {
    console.error('[readSyncStats] query failed:', e?.message ?? e, '— DB path:', DB_PATH)
    return empty
  }

  const st = fs.statSync(DB_PATH)
  const lastSync = st.mtimeMs / 1000
  console.log(`[db] stats: ${sessionCount} sessions, ${lapCount} laps, ${sampleCount} samples, ${trackCount} tracks — ${(st.size/1024/1024).toFixed(1)} MB`)
  return {
    sessionCount, lapCount, sampleCount, trackCount,
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

export interface BackendEventTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

export type ApiHandler = (event: unknown, ...args: any[]) => unknown | Promise<unknown>
export type ApiRegistrar = (channel: string, handler: ApiHandler) => void

function broadcast(window: BackendEventTarget | null, evt: WorkerEvent): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send('worker:event', evt)
}

let activeWorker: { kind: WorkerEvent['kind'] } | null = null

function assertPathInside(baseDir: string, candidate: string): string {
  const base = path.resolve(baseDir)
  const resolved = path.resolve(candidate)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path is outside this Catalyst workspace')
  }
  return resolved
}

// ---- handlers ----------------------------------------------------------

/** Register the transport-neutral Catalyst backend API.
 *
 * Electron supplies ipcMain.handle; the remote server supplies an RPC map.
 * Keeping one handler table prevents the browser version from drifting into a
 * reduced, view-only copy of the desktop application.
 */
export function registerApiHandlers(
  register: ApiRegistrar,
  getMainWindow: () => BackendEventTarget | null,
  revealPath: (filePath: string) => void = () => {},
  loginViaBrowser: () => Promise<{ accessToken: string; expiresIn: number }> = async () => {
    throw new Error('Sign in with your Garmin email and password before syncing')
  },
  aiKeys: AiKeyStore = databaseAiKeyStore(DB_PATH),
): void {
  register('auth:state', () => readAuthState())
  register('auth:syncStats', () => readSyncStats())
  register('auth:email', () => loadConfig().auth?.email ?? null)
  register('auth:saveCredentials', (_e, email: string, password: string) => {
    if (INSTANCE_DIR) setAccountEmail(email)
    else setCredentials(email, password)
  })
  register('auth:clearTokens', () => {
    if (fs.existsSync(GARTH_TOKEN_DIR)) fs.rmSync(GARTH_TOKEN_DIR, { recursive: true, force: true })
    if (fs.existsSync(CATALYST_TOKEN_CACHE)) fs.rmSync(CATALYST_TOKEN_CACHE, { force: true })
  })
  // Hosted Garmin sign-in for the desktop IPC transport. HTTP clients use
  // the server's one-use callback routes instead.
  register('auth:signIn', async () => {
    if (INSTANCE_DIR) throw new Error('Use email/password sign-in when connected to a remote server')
    const { accessToken, expiresIn } = await loginViaBrowser()
    return { token: accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn }
  })

  // Headless credentials sign-in — same wire format as garth's login().
  // Returns either a final token or `{ needsMfa: true, sessionId }` so the
  // renderer can prompt for a code and follow up with auth:signInMfa.
  register('auth:signInWithCreds', async (_e, email: string, password: string) => {
    const result = await signInWithCredentials(email, password)
    setAccountEmail(email)
    if (result.kind === 'mfa') return { needsMfa: true, sessionId: result.sessionId }
    return {
      needsMfa: false,
      token: INSTANCE_DIR ? '' : result.accessToken,
      expiresAt: Math.floor(Date.now() / 1000) + result.expiresIn,
    }
  })

  register('auth:signInMfa', async (_e, sessionId: string, code: string) => {
    const { accessToken, expiresIn } = await submitMfaCode(sessionId, code)
    return { token: INSTANCE_DIR ? '' : accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn }
  })

  register('auth:cancelMfa', (_e, sessionId: string) => cancelMfa(sessionId))

  register('profiles:list', (): Promise<CarProfile[]> => listGarageProfiles())
  register('profiles:active', () => getGarageActiveProfile())
  register('profiles:setActive', (_e, name: string) => setGarageActiveProfile(name))
  register('profiles:files', (_e, name: string) => listGarageFiles(name))
  register('profiles:readFile', (_e, filePath: string) => readGarageFile(filePath))
  register('profiles:writeCarMd', async (_e, profileName: string, fileName: string, content: string) => {
    const dest = await writeGarageFile(profileName, fileName, content)
    console.log(`[profiles] saved ${profileName}/${path.basename(fileName)} to workspace database (${content.length} chars)`)
    return dest
  })
  register('profiles:readCarMd', async (_e, name: string) => {
    const files = await listGarageFiles(name)
    const carMd = files.find(file => file.name.toLowerCase() === 'car.md')
    return carMd ? readGarageFile(carMd.path) : ''
  })

  register('db:hasDb', () => fs.existsSync(DB_PATH))
  register('db:listSessions', async (_e, accountLabel?: string | null): Promise<DbSessionRow[]> => {
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
          // metadata.json may also be on disk with vehicle info — pull it if so.
          const mp = path.join(SESSIONS_DIR, name, 'metadata.json')
          const m = fs.existsSync(mp)
            ? (() => { try { return JSON.parse(fs.readFileSync(mp, 'utf-8')) } catch { return {} } })()
            : {}
          rows.push({
            session_guid: s.sessionGuid ?? name,
            details_loaded: false,
            session_start: s.sessionStart ?? null,
            track_name: s.trackName ?? null,
            track_configuration_name: s.trackConfigurationName ?? null,
            best_lap_ms: null,
            lap_count: 0,
            sample_count: 0,
            weather_description: null,
            account: acct,
            vehicle_guid: m.vehicleGuid ?? null,
            vehicle_make: m.vehicleMake ?? null,
            vehicle_model: m.vehicleModel ?? null,
            vehicle_year: m.vehicleYear ?? null,
            vehicle_type: m.vehicleType ?? null,
          })
        } catch { /* ignore */ }
      }
      return rows
    }
    const whereClause = accountLabel ? 'WHERE s.account = ? OR s.account IS NULL' : ''
    try {
      return await withDb(async con => {
        const reader = await con.runAndReadAll(`
          SELECT s.session_guid, s.details_loaded,
            CAST(s.session_start AS VARCHAR) AS session_start,
            COALESCE(s.track_name, tc.track_name, 'Unknown') AS track_name,
            COALESCE(s.track_configuration_name, tc.track_configuration_name, '') AS track_configuration_name,
            s.best_lap_ms,
            (SELECT COUNT(*) FROM laps l WHERE l.session_guid = s.session_guid) AS lap_count,
            (SELECT COUNT(*) FROM samples sm WHERE sm.session_guid = s.session_guid) AS sample_count,
            COALESCE(s.weather_description, '') AS weather_description,
            s.account,
            s.vehicle_guid, s.vehicle_make, s.vehicle_model, s.vehicle_year, s.vehicle_type
          FROM sessions s
          LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
          ${whereClause}
          ORDER BY s.session_start DESC NULLS LAST
        `, accountLabel ? [accountLabel] as any : undefined)
        return reader.getRowObjectsJson() as unknown as DbSessionRow[]
      }, DB_PATH)
    } catch (e: any) {
      console.error('[db:listSessions] query failed:', e?.message ?? e)
      return []
    }
  })

  register('db:listVehicles', async (): Promise<import('../shared/types.js').VehicleSummary[]> => {
    if (!fs.existsSync(DB_PATH)) return []
    let rows: any[] = []
    try {
      await withDb(async con => {
        const reader = await con.runAndReadAll(`
          SELECT vehicle_guid, ANY_VALUE(vehicle_make) AS make,
                 ANY_VALUE(vehicle_model) AS model, ANY_VALUE(vehicle_year) AS year,
                 COUNT(*) AS session_count
          FROM sessions
          WHERE vehicle_guid IS NOT NULL
          GROUP BY vehicle_guid
          ORDER BY session_count DESC
        `)
        rows = reader.getRowObjectsJson()
      }, DB_PATH)
    } catch {
      return []
    }
    return Promise.all(rows.map(async r => {
      const resolved = await resolveGarageVehicleProfile(r.vehicle_guid, r.make)
      return {
        vehicleGuid: r.vehicle_guid,
        make: r.make ?? null,
        model: r.model ?? null,
        year: r.year != null ? Number(r.year) : null,
        sessionCount: Number(r.session_count ?? 0),
        profile: resolved.profile,
        explicit: resolved.explicit,
      }
    }))
  })

  register('profiles:setVehicleProfile', (_e, vehicleGuid: string, profileName: string | null) => {
    return setGarageVehicleProfile(vehicleGuid, profileName)
  })
  register('profiles:resolveForVehicle', (_e, vehicleGuid: string | null, make: string | null) => {
    return resolveGarageVehicleProfile(vehicleGuid, make)
  })

  // Import external context into the workspace database.
  // sourcePath is the dropped file's path on disk (provided by Electron's File API).
  register('profiles:importContextFile', async (
    _e,
    profileName: string,
    sourcePath: string,
    destName: string,
    contentBase64?: string,
  ) => {
    const safeName = path.basename(destName)
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('invalid file name')
    let content: string
    if (contentBase64 != null) content = Buffer.from(contentBase64, 'base64').toString('utf8')
    else {
      if (INSTANCE_DIR) throw new Error('Remote imports must upload file content')
      content = fs.readFileSync(sourcePath, 'utf8')
    }
    await writeGarageFile(profileName, safeName, content)
  })

  // Delete a context record from the workspace database. Car.md is protected.
  register('profiles:deleteContextFile', (_e, profileName: string, fileName: string) =>
    deleteGarageFile(profileName, fileName))

  // Create a database profile with blank car context and optionally link it to a vehicle.
  register('profiles:ensureProfile', (_e, name: string, vehicleGuid?: string) =>
    ensureGarageProfile(name, vehicleGuid))

  // ── AI Settings ────────────────────────────────────────────────────────────

  const providerFor = (ai: ReturnType<typeof loadConfig>['ai']): AiProvider =>
    ai?.provider ?? (ai?.model?.startsWith('gpt-') ? 'openai' : 'anthropic')

  const readAiKeys = async () => {
    await migrateAiConfig(CONFIG_PATH, aiKeys)
    return aiKeys.read()
  }

  register('ai:getSettings', async (): Promise<AiSettings> => {
    const keys = await readAiKeys()
    const cfg = loadConfig()
    const provider = providerFor(cfg.ai)
    return {
      provider,
      hasAnthropicApiKey: !!keys.anthropic,
      hasOpenAiApiKey: !!keys.openai,
      keysShared: !!INSTANCE_DIR,
      model: configuredModelFor(cfg.ai?.model, provider),
    }
  })

  register('ai:saveSettings', async (_e, s: AiSettings) => {
    if (!s || typeof s !== 'object') throw new Error('Invalid AI settings')
    if (s.provider !== undefined && s.provider !== 'anthropic' && s.provider !== 'openai') {
      throw new Error('Invalid AI provider')
    }
    if (s.model !== undefined && typeof s.model !== 'string') throw new Error('Invalid AI model')
    await migrateAiConfig(CONFIG_PATH, aiKeys)
    // Omitted keys are untouched; an explicit empty string removes that key.
    await aiKeys.write({ anthropic: s.anthropicApiKey, openai: s.openAiApiKey })
    const cfg = loadConfig()
    const provider = s.provider ?? providerFor(cfg.ai)
    cfg.ai = { provider, model: configuredModelFor(s.model ?? cfg.ai?.model, provider) }
    saveConfig(cfg)
  })

  // ── Account / driver totals ──────────────────────────────────────────────────
  register('account:stats', async (): Promise<AccountStats> => {
    const year = new Date().getFullYear()
    const empty: AccountStats = {
      allTime: { laps: 0, tracks: 0, sessions: 0, hours: 0 },
      year, thisYear: { laps: 0, hours: 0 },
    }
    if (!fs.existsSync(DB_PATH)) return empty
    try {
      return await withDb(async con => {
        const a = (await con.runAndReadAll(`
          SELECT
            (SELECT COUNT(*) FROM laps WHERE lap_type = 'DRIVEN'),
            (SELECT COUNT(DISTINCT track_configuration_id) FROM sessions WHERE track_configuration_id IS NOT NULL),
            (SELECT COUNT(*) FROM sessions),
            (SELECT COALESCE(SUM(duration_ms), 0) FROM laps WHERE lap_type = 'DRIVEN')
        `)).getRowsJson()[0] ?? []
        const y = (await con.runAndReadAll(`
          SELECT COUNT(*), COALESCE(SUM(l.duration_ms), 0)
          FROM laps l JOIN sessions s ON s.session_guid = l.session_guid
          WHERE l.lap_type = 'DRIVEN' AND EXTRACT(year FROM s.session_start) = ?
        `, [year])).getRowsJson()[0] ?? []
        return {
          allTime: {
            laps: Number(a[0] ?? 0),
            tracks: Number(a[1] ?? 0),
            sessions: Number(a[2] ?? 0),
            hours: Number(a[3] ?? 0) / 3_600_000,
          },
          year,
          thisYear: {
            laps: Number(y[0] ?? 0),
            hours: Number(y[1] ?? 0) / 3_600_000,
          },
        }
      }, DB_PATH)
    } catch (e: any) {
      console.error('[account:stats] query failed:', e?.message ?? e)
      return empty
    }
  })

  // ── Units (Metric vs Imperial) ───────────────────────────────────────────────
  register('units:get', (): UnitSystem => loadConfig().units ?? DEFAULT_UNIT_SYSTEM)
  register('units:set', (_e, system: UnitSystem) => {
    const cfg = loadConfig()
    cfg.units = system
    saveConfig(cfg)
  })

  // ── Coach sessions ──────────────────────────────────────────────────────────

  register('coach:list', async (): Promise<CoachingSession[]> => {
    if (!fs.existsSync(DB_PATH)) return []
    return withDb(con => listCoachingSessions(con), DB_PATH).catch(() => [])
  })

  register('coach:get', async (_e, id: string): Promise<CoachingSession | null> => {
    if (!fs.existsSync(DB_PATH)) return null
    return withDb(con => getCoachingSession(con, id), DB_PATH).catch(() => null)
  })

  register('coach:delete', async (_e, id: string) => {
    if (!fs.existsSync(DB_PATH)) return
    await withDb(con => deleteCoachingSession(con, id))
  })

  // ── Run coach (streaming worker) ────────────────────────────────────────────

  register('coach:run', async (_e, opts: CoachOptions): Promise<{ sessionId: null }> => {
    await ensureSessionDetails(opts.sessionGuids)
    if (activeWorker) throw new Error('Another worker is already running')
    activeWorker = { kind: 'coach' }
    const win = getMainWindow()

    void (async () => {
      let builtPrompt = ''
      let resolvedProfileName = opts.profile
      let sessionAliases: Record<string, string> = {}
      const collectedLogs: string[] = []
      const log = (msg: string) => {
        broadcast(win, { kind: 'coach', type: 'log', payload: msg })
        collectedLogs.push(msg)
      }

      try {
        log('[coach] Building prompt from telemetry…')
        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 0, total: 3, label: 'Building prompt…' } })

        const coachRun = await runCoach({
          sessionGuids: opts.sessionGuids,
          lapLimit: opts.lapLimit,
          profile: opts.profile,
          scope: opts.scope,
          dbPath: DB_PATH,
          system: loadConfig().units ?? DEFAULT_UNIT_SYSTEM,
        })
        const { prompt, profile: resolvedProfile } = coachRun
        sessionAliases = coachRun.sessionAliases
        builtPrompt = prompt
        resolvedProfileName = resolvedProfile

        log(`[coach] Prompt ready (${prompt.length.toLocaleString()} chars). Sending to LLM…`)
        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 1, total: 3, label: 'Sending to LLM…' } })

        const cfg = loadConfig()
        const provider = providerFor(cfg.ai)
        const apiKey = (await readAiKeys())[provider]
        if (!apiKey) {
          const label = provider === 'openai' ? 'OpenAI' : 'Anthropic'
          throw new Error(`No ${label} API key configured. Add it under AI Coach on the Overview page.`)
        }
        const harnessConfig: Parameters<typeof runAgent>[1] = {
          provider,
          apiKey,
          model: configuredModelFor(cfg.ai?.model, provider),
          reasoningEffort: provider === 'openai' ? 'xhigh' : undefined,
          maxTokens: provider === 'openai' ? 64000 : 32000,
          stream: provider === 'anthropic',
          tools:     [COACHING_TOOL],
          toolChoice: { type: 'tool' as const, name: COACHING_TOOL.name },
        }

        const rawResponse = await runAgent(prompt, harnessConfig, (text) => {
          if (text.startsWith('[status] ')) {
            const label = text.slice(9).trim()
            broadcast(win, { kind: 'coach', type: 'progress', progress: { current: 2, total: 3, label } })
          } else {
            const safeText = replaceSessionIds(text, sessionAliases)
            broadcast(win, { kind: 'coach', type: 'log', payload: safeText })
            collectedLogs.push(safeText)
          }
        })

        log('[coach] Response received. Parsing annotations…')
        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 2, total: 3, label: 'Parsing result…' } })

        // Keep GUIDs available to the model as analysis keys, then remove them
        // before any response text is persisted or rendered to the driver.
        const safeResponse = replaceSessionIds(rawResponse, sessionAliases)
        const parsed = parseCoachResponse(safeResponse)
        const modelUsed = harnessConfig.model
        const title = parsed?.headline
          ?? `Coach · ${resolvedProfile} · ${new Date().toISOString().slice(0, 10)}`

        const sessionId = randomUUID()
        const coachingSession: CoachingSession = {
          id: sessionId,
          created_at: new Date().toISOString(),
          session_guids: opts.sessionGuids,
          profile_name: resolvedProfile,
          model_used: modelUsed,
          title,
          prompt,
          raw_response: safeResponse,
          parsed_result: parsed,
        }

        await withDb(async con => {
          await initSchema(con)
          await insertCoachingSession(con, coachingSession)
        })

        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 3, total: 3, label: 'Done' } })
        broadcast(win, { kind: 'coach', type: 'done', payload: sessionId })
        log(`[coach] Session saved (${sessionId.slice(0, 8)}…)`)
      } catch (e: any) {
        const errMsg = replaceSessionIds(String(e.message ?? e), sessionAliases)
        log(`[coach] ✗ ${errMsg}`)
        broadcast(win, { kind: 'coach', type: 'error', payload: errMsg })

        // Always save a failed session — create the DB/schema if needed.
        const errorId = randomUUID()
        try {
          await withDb(async con => {
            await initSchema(con)
            const errorSession: CoachingSession = {
              id: errorId,
              created_at: new Date().toISOString(),
              session_guids: opts.sessionGuids,
              profile_name: resolvedProfileName,
              model_used: 'error',
              title: `⚠ Failed · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${errMsg.slice(0, 60)}`,
              prompt: builtPrompt,
              raw_response: replaceSessionIds(collectedLogs.join('') + '\n\nERROR: ' + errMsg, sessionAliases),
              parsed_result: null,
            }
            await insertCoachingSession(con, errorSession)
          })
        } catch (saveErr: any) {
          log(`[coach] (could not save error session: ${saveErr.message})`)
        }
        // Always fire done so the UI unlocks and the AI Coach tab can refresh.
        broadcast(win, { kind: 'coach', type: 'done', payload: errorId })
      } finally {
        activeWorker = null
      }
    })()

    return { sessionId: null }
  })

  // ── Tracks editor ─────────────────────────────────────────────────────────
  //
  // The Tracks workspace tab is for cleaning up corner annotations. We expose:
  //   tracks:listAll        — every (track, config, meanLineGuid) we have data
  //                            for, paired with its YAML path (resolved or to-
  //                            be-created), session count, and corner count.
  //   tracks:get(guid)      — geometry (centerline + edges + sectors) plus the
  //                            parsed YAML corners — everything the editor needs.
  //   tracks:saveCorners    — rewrite just the corners block in the YAML; lat/
  //                            lon are filled in from the mean_line's apex_idx
  //                            so the renderer doesn't have to ship them back.

  register('tracks:listAll', async () => {
    if (!fs.existsSync(DB_PATH)) return []
    const rows = await withDb(async con => {
      const reader = await con.runAndReadAll(`
        SELECT tc.track_name, tc.track_configuration_name, s.mean_line_guid,
               COUNT(*) AS session_count
        FROM sessions s
        LEFT JOIN track_configs tc ON tc.track_configuration_id = s.track_configuration_id
        WHERE s.mean_line_guid IS NOT NULL
        GROUP BY 1, 2, 3
        ORDER BY session_count DESC
      `)
      return reader.getRowsJson()
    }, DB_PATH)
    const out = rows.map((r: any) => {
      const trackName = String(r[0] ?? 'Unknown')
      const configName = String(r[1] ?? '')
      const meanLineGuid = r[2] != null ? String(r[2]) : null
      const sessionCount = Number(r[3] ?? 0)
      const resolved = meanLineGuid ? resolveTrackYamlPath(trackName, configName, meanLineGuid) : null
      const yaml = resolved?.exists ? loadTrackYaml(resolved.path) : null
      return {
        trackName, configName, meanLineGuid, sessionCount,
        yamlPath: resolved?.path ?? null,
        yamlExists: !!resolved?.exists,
        cornerCount: yaml?.corners?.length ?? 0,
        meanLineExists: meanLineGuid
          ? fs.existsSync(path.join(MEAN_LINES_DIR, `${meanLineGuid}.pb`))
          : false,
      }
    })
    return out
  })

  register('tracks:get', (_e, meanLineGuid: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(meanLineGuid)) throw new Error('invalid mean-line id')
    const geom = buildTrackGeometry(meanLineGuid)
    if (!geom) return null
    const resolved = resolveTrackYamlPath(geom.trackName, geom.configName, meanLineGuid)
    const yaml = resolved.exists ? loadTrackYaml(resolved.path) : null
    return {
      geometry: {
        meanLineGuid: geom.meanLineGuid,
        trackName: geom.trackName,
        configName: geom.configName,
        totalDistM: geom.totalDistM,
        widthM: geom.widthM,
        bbox: geom.bbox,
        centerline: geom.centerline.map(p => ({ x: p.x, y: p.y, dist: p.dist, lat: p.lat, lon: p.lon })),
        leftEdge: geom.leftEdge,
        rightEdge: geom.rightEdge,
        sectorMarks: geom.sectorMarks,
      },
      yamlPath: resolved.path,
      yamlExists: resolved.exists,
      corners: yaml?.corners ?? [],
    }
  })

  // The renderer sends back corners without lat/lon (and possibly without
  // dist_idx_start/end). We enrich each one from the mean-line geometry so
  // the YAML is fully populated for downstream consumers (Analysis charts,
  // brief generator). Defaults: zone = apex ± 50 m clamped to [0, total], and
  // apex_radius_m derived from local curvature.
  const DEFAULT_ZONE_HALF = 50

  function curvatureRadiusAt(
    centerline: Array<{ x: number; y: number }>,
    i: number,
  ): number {
    // Three-point circle radius estimate using points at ±20m. Robust at the
    // 1m sample spacing on Garmin meanlines without bumping into GPS noise.
    const n = centerline.length
    const a = centerline[Math.max(0, i - 20)]
    const b = centerline[i]
    const c = centerline[Math.min(n - 1, i + 20)]
    const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if (Math.abs(d) < 1e-6) return 9999
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return Math.hypot(ux - bx, uy - by)
  }

  register('tracks:saveCorners', (_e, opts: {
    yamlPath: string
    meanLineGuid: string
    corners: TrackCorner[]
  }) => {
    assertPathInside(TRACKS_DIR, opts.yamlPath)
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(opts.meanLineGuid)) throw new Error('invalid mean-line id')
    const geom = buildTrackGeometry(opts.meanLineGuid)
    const maxIdx = geom ? geom.centerline.length - 1 : 0

    const enriched = opts.corners.map(c => {
      const out: TrackCorner = { ...c }
      if (geom && c.apex_idx != null) {
        const i = Math.max(0, Math.min(maxIdx, Math.round(c.apex_idx)))
        const p = geom.centerline[i]
        out.apex_lat = p.lat
        out.apex_lon = p.lon
        // Default the corner zone to ±50 m around apex if the user didn't set
        // explicit bounds. These are what the Analysis page's corner shading,
        // entry/apex/exit speed extraction, and the brief generator key off.
        if (out.dist_idx_start == null) out.dist_idx_start = Math.max(0, i - DEFAULT_ZONE_HALF)
        if (out.dist_idx_end == null)   out.dist_idx_end   = Math.min(maxIdx, i + DEFAULT_ZONE_HALF)
        if (out.apex_radius_m == null) {
          out.apex_radius_m = Math.round(curvatureRadiusAt(geom.centerline, i) * 10) / 10
        }
      }
      return out
    })
    saveTrackYamlCorners(opts.yamlPath, enriched)
    return { savedTo: opts.yamlPath, cornerCount: enriched.length }
  })

  register('briefs:list', (): BriefFile[] => {
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
  register('briefs:read', (_e, p: string) => fs.readFileSync(assertPathInside(COACHING_DIR, p), 'utf-8'))

  // Results = LLM-generated markdown saved alongside the briefs in coaching/.
  // Convention: brief prompts end with `-brief.md`; everything else is a result.
  register('results:list', (): BriefFile[] => {
    if (!fs.existsSync(COACHING_DIR)) return []
    const files = fs.readdirSync(COACHING_DIR)
      .filter(n => {
        const lower = n.toLowerCase()
        if (!lower.endsWith('.md')) return false
        if (lower.endsWith('-brief.md')) return false
        if (lower === 'readme.md') return false
        return true
      })
      .map(n => {
        const p = path.join(COACHING_DIR, n)
        const st = fs.statSync(p)
        return { name: n, path: p, sizeKb: st.size / 1024, mtime: st.mtimeMs }
      })
    files.sort((a, b) => b.mtime - a.mtime)
    return files
  })
  register('results:read', (_e, p: string) => fs.readFileSync(assertPathInside(COACHING_DIR, p), 'utf-8'))
  register('briefs:generate', async (_e, opts: BriefOptions) => {
    if (opts.sessionGuids?.length) await ensureSessionDetails(opts.sessionGuids)
    const res = await runBrief({
      scope: opts.scope,
      profile: opts.profile,
      mode: opts.mode,
      lastN: opts.lastN,
      sessionGuids: opts.sessionGuids,
      csv: opts.csv,
      includeGuides: opts.includeGuides,
      system: loadConfig().units ?? DEFAULT_UNIT_SYSTEM,
    })
    return { outPath: res.outPath }
  })

  register('shell:reveal', (_e, p: string) => {
    revealPath(p)
  })

  register('analysis:build', async (_e, sessionGuids: string[], units?: UnitSystem, lapLimit?: 3 | 5 | 10 | null) => {
    await ensureSessionDetails(sessionGuids)
    return buildAnalysis(sessionGuids, units ?? loadConfig().units ?? DEFAULT_UNIT_SYSTEM, lapLimit)
  })

  // ---- workers ---------------------------------------------------------

  let syncTask: Promise<void> | null = null
  let detailQueue: Promise<void> = Promise.resolve()

  function startSyncTask(opts: SyncOptions = {}, sessionGuids?: string[]): Promise<void> {
    if (activeWorker) throw new Error('Another worker is already running')
    activeWorker = { kind: 'sync' }
    const win = getMainWindow()
    const log = (payload: string) => broadcast(win, { kind: 'sync', type: 'log', payload })
    broadcast(win, { kind: 'sync', type: 'progress', progress: {
      current: 0, total: 0, label: sessionGuids ? 'Preparing selected sessions…' : 'Fetching session overviews…',
    } })
    const task = (async () => {
      let token = opts.token || loadCatalystToken()
      if (!token) {
        log('[auth] Sign in to Garmin to download session details')
        const { accessToken } = await loginViaBrowser()
        token = accessToken
      }
      const api = new CatalystAPI(token)
      api.pageSize = loadConfig().api?.page_size ?? 50
      await syncSessions({
        api, accountLabel: opts.accountLabel ?? loadConfig().auth?.email ?? null,
        mode: opts.mode, sessionGuids, log,
        onProgress: progress => broadcast(win, { kind: 'sync', type: 'progress', progress }),
        onCatalog: () => broadcast(win, { kind: 'sync', type: 'catalog' }),
      })
    })()
    // Release the worker before notifying clients, so queued selections can start immediately.
    syncTask = task.then(() => {
      activeWorker = null
      syncTask = null
      broadcast(win, { kind: 'sync', type: 'done' })
    }, error => {
      activeWorker = null
      syncTask = null
      broadcast(win, { kind: 'sync', type: 'error', payload: String(error?.message ?? error) })
      throw error
    })
    return syncTask
  }

  function ensureSessionDetails(guids: string[], opts?: SyncOptions): Promise<void> {
    validateSessionGuids(guids)
    const task = detailQueue.then(async () => {
      // Serialize downloads, including requests from multiple browser tabs.
      for (;;) {
        while (syncTask) await syncTask.catch(() => {})
        const known = fs.existsSync(DB_PATH) ? await withDb(existingSessionGuids) : new Set<string>()
        if (syncTask) continue
        const missing = [...new Set(guids)].filter(guid => !known.has(guid))
        if (missing.length) await startSyncTask(opts, missing)
        return
      }
    })
    detailQueue = task.catch(() => {})
    return task
  }

  register('db:ensureSessions', (_e, guids: string[], opts?: SyncOptions) => ensureSessionDetails(guids, opts))
  register('worker:startSync', (_e, opts?: SyncOptions) => {
    if (opts?.mode && opts.mode !== 'recent' && opts.mode !== 'all') throw new Error('Invalid sync mode')
    if (syncTask && opts?.mode !== 'all') return
    void startSyncTask(opts).catch(() => {}) // Errors are reported through worker events.
  })

  register('worker:startLoad', async () => {
    if (activeWorker) throw new Error('worker already running')
    activeWorker = { kind: 'load' }
    const win = getMainWindow()
    void (async () => {
      try {
        await loadAll(
          line => broadcast(win, { kind: 'load', type: 'log', payload: line }),
          undefined,
          p => broadcast(win, {
            kind: 'load',
            type: 'progress',
            progress: { current: p.current, total: p.total, label: p.label },
          }),
        )
        const dbSize = fs.existsSync(DB_PATH) ? (fs.statSync(DB_PATH).size/1024/1024).toFixed(1) : '0'
        console.log(`[load] complete — DB ${dbSize} MB at ${DB_PATH}`)
        broadcast(win, { kind: 'load', type: 'done' })
      } catch (e: any) {
        console.error('[load] failed:', e.message ?? e)
        broadcast(win, { kind: 'load', type: 'error', payload: `${e.message ?? e}` })
      } finally {
        activeWorker = null
      }
    })()
  })
}
