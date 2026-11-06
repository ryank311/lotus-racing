/**
 * The drivers on a Catalyst server, for Analysis and coaching comparisons.
 *
 * Each driver's backend owns its database, so another driver's sessions and
 * laps are always fetched through that driver's backend (read-only channels
 * only). The HTTP server uses this for browser clients; the desktop app
 * passes it to its IPC handlers so the desktop workspace can compare against
 * the server's drivers too.
 *
 * The server has no passwords, so this exposes nothing a login would not. It
 * never creates a workspace for an unknown name.
 */

import fs from 'node:fs'
import path from 'node:path'
import { accountKey, userDirectory, USER_RE, workspaceDbPath, workspaceVideoFile } from './serverStorage.js'
import { VIDEO_ID_RE } from '../shared/pdr.js'
import { MAX_COMPARE_DRIVERS, MAX_COMPARE_SESSIONS, type DriverAccount } from '../shared/comparison.js'
import type { DbSessionRow } from '../shared/types.js'
import { replayLapRequest, type ReplayLapInfo } from '../shared/replay.js'
import type { ReplayLapBundle } from '../garmin/replayDriver.js'

const GUID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export interface DriverBackend {
  call(channel: string, args: unknown[]): Promise<unknown>
}

export interface DriverDirectory {
  /** Every driver except `self` (null: the desktop workspace, not a server driver). */
  list(self: string | null): DriverAccount[]
  /** A driver's sessions; throws for an unknown name or yourself. */
  sessions(driver: unknown, self: string | null): Promise<DbSessionRow[]>
  /**
   * Replace comparison requests with each driver's exported laps, so a
   * backend only ever receives telemetry fetched from the owner's backend.
   */
  resolve(self: string | null, lapFilter: unknown, requests: unknown): Promise<unknown[]>
  /**
   * A driver's video file, for playing their laps beside yours in a
   * comparison; null for an unknown driver or video. Video IDs are random,
   * and reach you only in that driver's comparison export.
   */
  videoFile(driver: unknown, videoId: unknown): string | null
  /**
   * The 3D replay's driver comparison: the valid laps of one of a driver's
   * sessions, and one of those laps exported by their backend (read-only,
   * the same laps Analysis's comparison may export), with their name added.
   */
  replayLaps(driver: unknown, sessionGuid: unknown, self: string | null): Promise<ReplayLapInfo[]>
  replayLap(self: string | null, request: unknown): Promise<ReplayLapBundle>
}

export function createDriverDirectory(dataDir: string, backendFor: (username: string) => DriverBackend, mediaDir: string | null = null): DriverDirectory {
  const usersDir = path.join(dataDir, 'users')
  const isSelf = (name: string, self: string | null) => self != null && accountKey(name) === accountKey(self)

  const accountName = (instanceDir: string): string | null => {
    try {
      const account = JSON.parse(fs.readFileSync(path.join(instanceDir, 'account.json'), 'utf8'))
      return typeof account?.username === 'string' && USER_RE.test(account.username) ? account.username : null
    } catch { return null }
  }
  const knownDriver = (name: unknown): string | null => {
    if (typeof name !== 'string' || !USER_RE.test(name)) return null
    return accountName(userDirectory(dataDir, name))
  }
  const hasTelemetry = (name: string) => fs.existsSync(workspaceDbPath(userDirectory(dataDir, name)))
  // Another driver you may compare against: known, not you, with telemetry.
  // Never starts a backend (or creates a workspace) for anyone else.
  const comparable = (driver: unknown, self: string | null): string => {
    const name = knownDriver(driver)
    if (!name) throw Object.assign(new Error(`No driver named "${String(driver ?? '').slice(0, 40)}" on this server.`), { status: 404 })
    if (isSelf(name, self)) throw Object.assign(new Error('Choose another driver; your own laps are in the ghost list already.'), { status: 400 })
    if (!hasTelemetry(name)) throw Object.assign(new Error(`${name} has not synced any telemetry yet.`), { status: 404 })
    return name
  }

  return {
    videoFile(driver, videoId) {
      const name = knownDriver(driver)
      if (!name || typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return null
      return workspaceVideoFile(userDirectory(dataDir, name), mediaDir, videoId)
    },

    list(self) {
      let dirs: string[] = []
      try { dirs = fs.readdirSync(usersDir) } catch { return [] }
      return dirs.flatMap(dir => {
        const instanceDir = path.join(usersDir, dir)
        const username = accountName(instanceDir)
        if (!username || isSelf(username, self)) return []
        return [{ username, hasTelemetry: fs.existsSync(workspaceDbPath(instanceDir)) }]
      }).sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }))
    },

    async sessions(driver, self) {
      const name = knownDriver(driver)
      if (!name || isSelf(name, self)) throw Object.assign(new Error('No such driver on this server.'), { status: 404 })
      // A driver with no database has nothing to compare; avoid starting
      // their backend just to say so.
      return hasTelemetry(name) ? await backendFor(name).call('db:listSessions', [null]) as DbSessionRow[] : []
    },

    async replayLaps(driver, sessionGuid, self) {
      const name = comparable(driver, self)
      if (typeof sessionGuid !== 'string' || !GUID_RE.test(sessionGuid)) throw Object.assign(new Error('Invalid session ID'), { status: 400 })
      try {
        return await backendFor(name).call('replay:exportLaps', [sessionGuid]) as ReplayLapInfo[]
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async replayLap(self, request) {
      const r = request as { driver?: unknown } | null
      const name = comparable(r?.driver, self)
      const lap = replayLapRequest(request)
      try {
        const exported = await backendFor(name).call('replay:exportLap', [lap]) as object
        return { ...exported, driver: name } as ReplayLapBundle
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    async resolve(self, lapFilter, requests) {
      if (requests == null) return []
      if (!Array.isArray(requests)) throw new Error('Invalid driver comparison.')
      if (requests.length > MAX_COMPARE_DRIVERS) throw new Error(`Compare up to ${MAX_COMPARE_DRIVERS} drivers at a time.`)
      const seen = new Set<string>()
      const resolved = requests.map(request => {
        const guids = request?.sessionGuids
        if (!Array.isArray(guids) || !guids.length || guids.length > MAX_COMPARE_SESSIONS || guids.some(g => typeof g !== 'string' || !g || g.length > 200)) {
          throw new Error(`Choose 1–${MAX_COMPARE_SESSIONS} sessions for each compared driver.`)
        }
        const name = knownDriver(request?.driver)
        if (!name) throw new Error(`No driver named "${String(request?.driver ?? '').slice(0, 40)}" on this server.`)
        if (isSelf(name, self)) throw new Error('Choose another driver to compare against; your own sessions are already in this analysis.')
        if (seen.has(accountKey(name))) throw new Error(`${name} is listed twice in this comparison.`)
        seen.add(accountKey(name))
        return { name, guids: guids as string[] }
      })
      return Promise.all(resolved.map(async ({ name, guids }) => {
        if (!hasTelemetry(name)) throw new Error(`${name} has not synced any telemetry yet.`)
        try {
          const exported = await backendFor(name).call('compare:export', [guids, lapFilter])
          return { ...(exported as object), driver: name }
        } catch (error) {
          throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }))
    },
  }
}
