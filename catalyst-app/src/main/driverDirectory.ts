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
