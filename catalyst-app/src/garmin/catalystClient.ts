// Garmin Catalyst data fetcher — TS port of garmin/catalyst_client.py.
//
// This module is HTTP-only; it knows nothing about Electron. The auth flow
// has two paths:
//   1. cached Catalyst token in .catalyst_token.json (90-day lifetime)
//   2. an externally-provided bearer token (mitmproxy capture or pasted)
//
// The full Garmin SSO login flow (garth-equivalent) is implemented in
// src/main/auth.ts because it requires an Electron BrowserWindow to handle
// MFA / captcha. CLI usage relies on a pre-captured bearer token or the
// existing Python script's cached token at .catalyst_token.json.

import fs from 'node:fs'
import path from 'node:path'
import { CATALYST_TOKEN_CACHE } from './paths.js'

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const CATALYST_CLIENT_ID = 'GARMIN_MOBILE_CATALYST_ANDROID'
export const SSO_TOKEN_URL = 'https://services.garmin.com/api/oauth/token'
const API_BASE = 'https://api.gcs.garmin.com'
const AUTOSPORT_PREFIX = '/autosport/api/v1'

export interface CachedToken {
  access_token: string
  expires_at: number // epoch seconds
}

export function loadCatalystToken(): string | null {
  if (!fs.existsSync(CATALYST_TOKEN_CACHE)) return null
  try {
    const data: CachedToken = JSON.parse(fs.readFileSync(CATALYST_TOKEN_CACHE, 'utf-8'))
    if (Date.now() / 1000 < data.expires_at - 300) return data.access_token
  } catch {
    // fall through
  }
  return null
}

export function saveCatalystToken(accessToken: string, expiresIn: number): void {
  fs.mkdirSync(path.dirname(CATALYST_TOKEN_CACHE), { recursive: true })
  const payload: CachedToken = {
    access_token: accessToken,
    expires_at: Date.now() / 1000 + expiresIn,
  }
  fs.writeFileSync(CATALYST_TOKEN_CACHE, JSON.stringify(payload))
}

export function loadCatalystTokenExpiry(): number | null {
  if (!fs.existsSync(CATALYST_TOKEN_CACHE)) return null
  try {
    const data: CachedToken = JSON.parse(fs.readFileSync(CATALYST_TOKEN_CACHE, 'utf-8'))
    return data.expires_at ?? null
  } catch {
    return null
  }
}

export async function exchangeTicketForToken(
  ticket: string,
  serviceUrl: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: 'service_ticket',
    client_id: CATALYST_CLIENT_ID,
    service_ticket: ticket,
    service_url: serviceUrl,
  })
  const resp = await fetch(SSO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
    },
    body,
  })
  if (!resp.ok) throw new Error(`token exchange ${resp.status}: ${(await resp.text()).slice(0, 500)}`)
  const payload = (await resp.json()) as { access_token?: string; expires_in?: number }
  const token = payload.access_token
  if (!token) throw new Error(`no access_token in response: ${JSON.stringify(payload)}`)
  const expiresIn = Number(payload.expires_in ?? 7_776_000)
  saveCatalystToken(token, expiresIn)
  return { accessToken: token, expiresIn }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionGuid?: string
  sessionStart?: string
  trackName?: string
  trackConfigurationName?: string
  trackConfigurationId?: number
  trackCartographyId?: number
  meanLineGuid?: string
  bestLap?: string
  bestLapNormal?: string
  [k: string]: unknown
}

export class CatalystAPI {
  pageSize = 50
  private extraHeaders: Record<string, string>

  constructor(private bearerToken: string, extraHeaders: Record<string, string> = {}) {
    if (!bearerToken) throw new Error('bearer token required')
    this.extraHeaders = extraHeaders
  }

  private async request(pth: string, params?: Record<string, unknown>, accept = 'application/json'): Promise<Response> {
    const url = new URL(API_BASE + AUTOSPORT_PREFIX + '/' + pth.replace(/^\//, ''))
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
      Accept: accept,
      'User-Agent': BROWSER_UA,
      ...this.extraHeaders,
    }
    const resp = await fetch(url.toString(), { headers })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status} ${pth}: ${txt.slice(0, 300)}`)
    }
    return resp
  }

  async getJson(pth: string, params?: Record<string, unknown>): Promise<unknown> {
    const resp = await this.request(pth, params, 'application/json')
    if (resp.status === 204) return null
    return resp.json()
  }

  async getBytes(pth: string, params?: Record<string, unknown>): Promise<Uint8Array> {
    const resp = await this.request(pth, params, '*/*')
    return new Uint8Array(await resp.arrayBuffer())
  }

  // ---- session list ------------------------------------------------------

  async getSessions(opts: {
    limit?: number
    offset?: number
    sortType?: 'SESSION_START_TIME' | 'TRACK_NAME' | 'BEST_LAP'
    sortOrder?: 'ASCENDING' | 'DESCENDING'
    onProgress?: (n: number) => void
  } = {}): Promise<SessionSummary[]> {
    const sortType = opts.sortType ?? 'SESSION_START_TIME'
    const sortOrder = opts.sortOrder ?? 'DESCENDING'
    const onProgress = opts.onProgress ?? (() => {})
    const baseParams: Record<string, unknown> = { sortType, sortOrder }

    const fetchPage = async (offset: number, lim: number): Promise<SessionSummary[]> => {
      const data = (await this.getJson('sessions', { ...baseParams, offset, limit: lim })) as
        | { sessionsSummaries?: SessionSummary[] }
        | SessionSummary[]
        | null
      if (!data) return []
      if (Array.isArray(data)) return data
      return data.sessionsSummaries ?? []
    }

    if (opts.limit !== undefined) return fetchPage(opts.offset ?? 0, opts.limit)

    const all: SessionSummary[] = []
    let pageOffset = opts.offset ?? 0
    while (true) {
      const page = await fetchPage(pageOffset, this.pageSize)
      if (page.length === 0) break
      all.push(...page)
      onProgress(all.length)
      if (page.length < this.pageSize) break
      pageOffset += this.pageSize
      await new Promise(r => setTimeout(r, 200))
    }
    return all
  }

  async getSessionMetadata(guid: string): Promise<Record<string, unknown>> {
    return (await this.getJson(`session/${guid}/metadata`)) as Record<string, unknown>
  }

  async getSessionWeather(guid: string): Promise<Record<string, unknown>> {
    return (await this.getJson(`session/${guid}/weather`)) as Record<string, unknown>
  }

  async getSessionPerformanceData(guid: string): Promise<Uint8Array> {
    return this.getBytes(`session/${guid}/performanceData`)
  }

  async getSessionOptimalLap(guid: string): Promise<Uint8Array> {
    return this.getBytes(`session/${guid}/optimalLap`)
  }

  async getMeanLine(meanLineGuid: string): Promise<Uint8Array> {
    return this.getBytes(`meanLine/${meanLineGuid}`)
  }

  async getTrackFacilities(): Promise<any[]> {
    const data = (await this.getJson('trackFacilities', { limit: 100 })) as any
    if (Array.isArray(data)) return data
    return data?.trackFacilities ?? []
  }

  async getTrackConfigurations(trackCartographyId?: number): Promise<any[]> {
    const params = trackCartographyId ? { trackCartographyId } : undefined
    const data = (await this.getJson('trackConfigurations', params)) as any
    if (Array.isArray(data)) return data
    return data?.trackConfigurations ?? []
  }
}

// ---------------------------------------------------------------------------
// Bulk fetch — mirrors fetch_all_sessions() in the Python script.
// ---------------------------------------------------------------------------

export interface FetchProgressEvent {
  kind: 'list' | 'session' | 'file' | 'warn' | 'done'
  message: string
  index?: number
  total?: number
}

function saveJson(p: string, data: unknown, pretty = true): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, pretty ? 2 : 0))
}

function saveBytes(p: string, data: Uint8Array): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
}

export async function fetchAndSaveSession(
  api: CatalystAPI,
  summary: SessionSummary,
  dataDir: string,
  meanLineDir: string,
  log: (e: FetchProgressEvent) => void,
  accountLabel?: string | null,
): Promise<void> {
  const sg = summary.sessionGuid
  if (!sg) {
    log({ kind: 'warn', message: 'summary has no sessionGuid' })
    return
  }
  const out = path.join(dataDir, sg)
  fs.mkdirSync(out, { recursive: true })
  saveJson(path.join(out, 'summary.json'), summary)
  if (accountLabel) {
    fs.writeFileSync(path.join(out, '.account'), accountLabel)
  }
  log({ kind: 'session', message: `[session] ${sg} (${summary.trackName ?? '?'}, best=${summary.bestLap ?? '?'})` })

  const fetches: Array<[string, string, () => Promise<unknown>, 'json' | 'bytes']> = [
    ['metadata', 'metadata.json', () => api.getSessionMetadata(sg), 'json'],
    ['weather', 'weather.json', () => api.getSessionWeather(sg), 'json'],
    ['optimal_lap', 'optimal_lap.pb', () => api.getSessionOptimalLap(sg), 'bytes'],
    ['performance', 'performance.pb', () => api.getSessionPerformanceData(sg), 'bytes'],
  ]
  for (const [label, fname, fn, kind] of fetches) {
    const p = path.join(out, fname)
    if (fs.existsSync(p) && fs.statSync(p).size > 0) continue
    try {
      const data = await fn()
      if (kind === 'json') saveJson(p, data)
      else saveBytes(p, data as Uint8Array)
      log({ kind: 'file', message: `  wrote ${fname} (${fs.statSync(p).size.toLocaleString()} bytes)` })
    } catch (e: any) {
      log({ kind: 'warn', message: `  [WARN] ${label} failed: ${e.message ?? e}` })
    }
  }

  const mlGuid = summary.meanLineGuid
  if (mlGuid) {
    const mlPath = path.join(meanLineDir, `${mlGuid}.pb`)
    if (!fs.existsSync(mlPath) || fs.statSync(mlPath).size === 0) {
      try {
        const bytes = await api.getMeanLine(mlGuid)
        saveBytes(mlPath, bytes)
        log({ kind: 'file', message: `  wrote mean_line/${mlGuid}.pb (${fs.statSync(mlPath).size.toLocaleString()} bytes)` })
      } catch (e: any) {
        log({ kind: 'warn', message: `  [WARN] mean line failed: ${e.message ?? e}` })
      }
    }
  }
}

export async function fetchAllSessions(
  api: CatalystAPI,
  dataDir: string,
  log: (e: FetchProgressEvent) => void,
  accountLabel?: string | null,
): Promise<number> {
  log({ kind: 'list', message: '[sessions] Fetching session list...' })
  const sessions = await api.getSessions({
    onProgress: n => log({ kind: 'list', message: `  fetched ${n} so far...` }),
  })
  log({ kind: 'list', message: `[sessions] Found ${sessions.length} sessions` })

  const parent = path.dirname(dataDir)
  saveJson(path.join(parent, 'sessions_index.json'), sessions)

  try {
    const facilities = await api.getTrackFacilities()
    saveJson(path.join(parent, 'track_facilities.json'), facilities)
    const configsByTrack: Record<string, any[]> = {}
    for (const fac of facilities) {
      const cid = fac.trackCartographyId
      if (!cid) continue
      try {
        configsByTrack[String(cid)] = await api.getTrackConfigurations(cid)
      } catch (e: any) {
        log({ kind: 'warn', message: `[WARN] configs for trackCartographyId=${cid}: ${e.message ?? e}` })
      }
    }
    saveJson(path.join(parent, 'track_configurations.json'), configsByTrack)
  } catch (e: any) {
    log({ kind: 'warn', message: `[WARN] track facilities/configurations failed: ${e.message ?? e}` })
  }

  const meanLineDir = path.join(parent, 'mean_lines')
  fs.mkdirSync(meanLineDir, { recursive: true })

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    if (!s.sessionGuid) continue
    log({ kind: 'session', message: `\n[${i + 1}/${sessions.length}]`, index: i + 1, total: sessions.length })
    await fetchAndSaveSession(api, s, dataDir, meanLineDir, log, accountLabel)
    await new Promise(r => setTimeout(r, 300))
  }

  log({ kind: 'done', message: `[done] fetched ${sessions.length} sessions` })
  return sessions.length
}
