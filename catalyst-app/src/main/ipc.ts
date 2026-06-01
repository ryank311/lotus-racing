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
  REPO_ROOT,
} from '../garmin/paths.js'
import { loadConfig, saveConfig, setCredentials } from '../garmin/config.js'
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
import {
  discoverProfiles,
  getActiveProfileName,
  resolveVehicleProfile,
  setActiveProfileName,
  setVehicleProfile,
} from '../garmin/profiles.js'
import { randomUUID } from 'node:crypto'
import type {
  AuthState,
  CarProfile,
  BriefOptions,
  BriefFile,
  DbSessionRow,
  SyncStats,
  WorkerEvent,
  CoachOptions,
  CoachingSession,
  AiSettings,
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
          // metadata.json may also be on disk with vehicle info — pull it if so.
          const mp = path.join(SESSIONS_DIR, name, 'metadata.json')
          const m = fs.existsSync(mp)
            ? (() => { try { return JSON.parse(fs.readFileSync(mp, 'utf-8')) } catch { return {} } })()
            : {}
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
          SELECT s.session_guid,
            CAST(s.session_start AS VARCHAR) AS session_start,
            COALESCE(tc.track_name, 'Unknown') AS track_name,
            COALESCE(tc.track_configuration_name, '') AS track_configuration_name,
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

  ipcMain.handle('db:listVehicles', async (): Promise<import('../shared/types.js').VehicleSummary[]> => {
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
    return rows.map(r => {
      const resolved = resolveVehicleProfile(r.vehicle_guid, r.make)
      return {
        vehicleGuid: r.vehicle_guid,
        make: r.make ?? null,
        model: r.model ?? null,
        year: r.year != null ? Number(r.year) : null,
        sessionCount: Number(r.session_count ?? 0),
        profile: resolved.profile,
        explicit: resolved.explicit,
      }
    })
  })

  ipcMain.handle('profiles:setVehicleProfile', (_e, vehicleGuid: string, profileName: string | null) => {
    setVehicleProfile(vehicleGuid, profileName)
  })
  ipcMain.handle('profiles:resolveForVehicle', (_e, vehicleGuid: string | null, make: string | null) => {
    return resolveVehicleProfile(vehicleGuid, make)
  })

  // Import an external file into a profile's context directory.
  // sourcePath is the dropped file's path on disk (provided by Electron's File API).
  ipcMain.handle('profiles:importContextFile', (_e, profileName: string, sourcePath: string, destName: string) => {
    const profile = discoverProfiles().find(p => p.name === profileName)
    if (!profile) throw new Error(`unknown profile '${profileName}'`)
    const dest = path.join(profile.dir, destName)
    fs.copyFileSync(sourcePath, dest)
  })

  // Delete a context file from a profile directory. Car.md is protected.
  ipcMain.handle('profiles:deleteContextFile', (_e, profileName: string, fileName: string) => {
    if (fileName.toLowerCase() === 'car.md') throw new Error('Car.md cannot be deleted')
    const profile = discoverProfiles().find(p => p.name === profileName)
    if (!profile) throw new Error(`unknown profile '${profileName}'`)
    fs.rmSync(path.join(profile.dir, fileName))
  })

  // Create a new profile directory with a blank Car.md and optionally link it to a vehicle.
  ipcMain.handle('profiles:ensureProfile', (_e, name: string, vehicleGuid?: string) => {
    const dir = path.join(REPO_ROOT, name)
    fs.mkdirSync(dir, { recursive: true })
    const carMd = path.join(dir, 'Car.md')
    if (!fs.existsSync(carMd)) {
      fs.writeFileSync(carMd, `# ${name}\n\n<!-- Add car specs, setup notes, and driver feedback here. -->\n`)
    }
    if (vehicleGuid) setVehicleProfile(vehicleGuid, name)
    return { name, dir, carMdPath: carMd } as import('../shared/types.js').CarProfile
  })

  // ── AI Settings ────────────────────────────────────────────────────────────

  ipcMain.handle('ai:getSettings', (): AiSettings => {
    const cfg = loadConfig()
    return {
      harness:   cfg.ai?.harness   ?? 'local',
      apiKey:    cfg.ai?.api_key,
      model:     cfg.ai?.model     ?? 'claude-sonnet-4-6',
      maxTokens: cfg.ai?.max_tokens ?? 32000,
      stream:    cfg.ai?.stream    ?? true,
    }
  })

  ipcMain.handle('ai:saveSettings', (_e, s: AiSettings) => {
    const cfg = loadConfig()
    cfg.ai = {
      harness:    s.harness,
      api_key:    s.apiKey,
      model:      s.model,
      max_tokens: s.maxTokens,
      stream:     s.stream,
    }
    saveConfig(cfg)
  })

  // ── Coach sessions ──────────────────────────────────────────────────────────

  ipcMain.handle('coach:list', async (): Promise<CoachingSession[]> => {
    if (!fs.existsSync(DB_PATH)) return []
    return withDb(con => listCoachingSessions(con), DB_PATH).catch(() => [])
  })

  ipcMain.handle('coach:get', async (_e, id: string): Promise<CoachingSession | null> => {
    if (!fs.existsSync(DB_PATH)) return null
    return withDb(con => getCoachingSession(con, id), DB_PATH).catch(() => null)
  })

  ipcMain.handle('coach:delete', async (_e, id: string) => {
    if (!fs.existsSync(DB_PATH)) return
    await withDb(con => deleteCoachingSession(con, id))
  })

  // ── Run coach (streaming worker) ────────────────────────────────────────────

  ipcMain.handle('coach:run', async (_e, opts: CoachOptions): Promise<{ sessionId: null }> => {
    if (activeWorker) throw new Error('Another worker is already running')
    activeWorker = { kind: 'coach' }
    const win = getMainWindow()

    void (async () => {
      let builtPrompt = ''
      let resolvedProfileName = opts.profile
      const collectedLogs: string[] = []
      const log = (msg: string) => {
        broadcast(win, { kind: 'coach', type: 'log', payload: msg })
        collectedLogs.push(msg)
      }

      try {
        log('[coach] Building prompt from telemetry…')
        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 0, total: 3, label: 'Building prompt…' } })

        const { prompt, profile: resolvedProfile } = await runCoach({
          sessionGuids: opts.sessionGuids,
          profile: opts.profile,
          scope: opts.scope,
          dbPath: DB_PATH,
        })
        builtPrompt = prompt
        resolvedProfileName = resolvedProfile

        log(`[coach] Prompt ready (${prompt.length.toLocaleString()} chars). Sending to LLM…`)
        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 1, total: 3, label: 'Sending to LLM…' } })

        const cfg = loadConfig()
        const harnessConfig: Parameters<typeof runAgent>[1] =
          cfg.ai?.harness === 'remote' && cfg.ai?.api_key
            ? {
                harness:   'remote',
                apiKey:    cfg.ai.api_key,
                model:     cfg.ai.model     ?? 'claude-sonnet-4-6',
                maxTokens: cfg.ai.max_tokens ?? 32000,
                stream:    cfg.ai.stream    ?? true,
                tools:     [COACHING_TOOL],
                toolChoice: { type: 'tool' as const, name: COACHING_TOOL.name },
              }
            : { harness: 'local' }

        const rawResponse = await runAgent(prompt, harnessConfig, (text) => {
          if (text.startsWith('[status] ')) {
            const label = text.slice(9).trim()
            broadcast(win, { kind: 'coach', type: 'progress', progress: { current: 2, total: 3, label } })
          } else {
            broadcast(win, { kind: 'coach', type: 'log', payload: text })
            collectedLogs.push(text)
          }
        })

        log('[coach] Response received. Parsing annotations…')
        broadcast(win, { kind: 'coach', type: 'progress',
          progress: { current: 2, total: 3, label: 'Parsing result…' } })

        const parsed = parseCoachResponse(rawResponse)
        const modelUsed = harnessConfig.harness === 'remote' ? harnessConfig.model : 'local-cli'
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
          raw_response: rawResponse,
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
        const errMsg = String(e.message ?? e)
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
              raw_response: collectedLogs.join('') + '\n\nERROR: ' + errMsg,
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

  ipcMain.handle('tracks:listAll', async () => {
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

  ipcMain.handle('tracks:get', (_e, meanLineGuid: string) => {
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

  ipcMain.handle('tracks:saveCorners', (_e, opts: {
    yamlPath: string
    meanLineGuid: string
    corners: TrackCorner[]
  }) => {
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

  // Results = LLM-generated markdown saved alongside the briefs in coaching/.
  // Convention: brief prompts end with `-brief.md`; everything else is a result.
  ipcMain.handle('results:list', (): BriefFile[] => {
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
  ipcMain.handle('results:read', (_e, p: string) => fs.readFileSync(p, 'utf-8'))
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
    // Tracks the current progress state so we can incrementally update file/
    // session labels without losing the previous fields. Emit on any change.
    const prog: { current: number; total: number; label: string; fileName?: string } = {
      current: 0, total: 0, label: '',
    }
    const sendProgress = () =>
      broadcast(win, { kind: 'sync', type: 'progress', progress: { ...prog } })

    // Smart sync: diff Garmin's session list against what's already in the DB,
    // fetch + load only the new ones, and update the DB incrementally.
    // No full rebuild — that's what the Rebuild DB button is for.
    void (async () => {
      let syncDb: Awaited<ReturnType<typeof openDb>> | null = null
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
        // diff against it. Closed in finally to guarantee the Windows file lock is released.
        syncDb = await openDb()
        const con = syncDb.con
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

        if (newSessions.length > 0) {
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
          prog.total = newSessions.length
          sendProgress()
          for (let i = 0; i < newSessions.length; i++) {
            const s = newSessions[i]
            const sg = s.sessionGuid!
            prog.current = i + 1
            prog.label = `${s.trackName ?? sg.slice(0, 8)} · ${(s.sessionStart ?? '').slice(0, 10)}`
            prog.fileName = undefined
            sendProgress()
            log(`[${i + 1}/${newSessions.length}] ${sg.slice(0, 8)}… ${s.trackName ?? ''} ${s.bestLap ?? ''}`)
            try {
              await fetchAndSaveSession(api, s, SESSIONS_DIR, MEAN_LINES_DIR,
                e => {
                  log(`  ${e.message}`)
                  if (e.kind === 'file' && e.fileName) {
                    prog.fileName = e.fileName
                    sendProgress()
                  }
                },
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
        } else {
          log('[sync] Up to date — nothing to download.')
        }

        const dbExists = fs.existsSync(DB_PATH)
        const dbSize = dbExists ? fs.statSync(DB_PATH).size : 0
        log(`[sync] DB path: ${DB_PATH}`)
        log(`[sync] DB exists: ${dbExists}, size: ${(dbSize / 1024 / 1024).toFixed(1)} MB`)
        broadcast(win, { kind: 'sync', type: 'done' })
      } catch (e: any) {
        broadcast(win, { kind: 'sync', type: 'error', payload: `${e.message ?? e}` })
      } finally {
        await syncDb?.close()
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
