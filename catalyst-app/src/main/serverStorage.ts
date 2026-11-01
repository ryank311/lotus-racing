import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { DRIVER_NAME_RE, driverKey } from '../shared/comparison.js'

export const USER_RE = DRIVER_NAME_RE

export function accountKey(username: string): string {
  return driverKey(username)
}

export function userDirectory(dataDir: string, username: string): string {
  const userId = createHash('sha256').update(accountKey(username)).digest('hex').slice(0, 24)
  return path.join(dataDir, 'users', userId)
}

export function defaultServerDataDir(): string {
  if (process.env.CATALYST_SERVER_DATA_DIR) return path.resolve(process.env.CATALYST_SERVER_DATA_DIR)
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'catalyst-coach', 'server')
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'catalyst-coach', 'server')
  }
  return path.join(os.homedir(), '.config', 'catalyst-coach', 'server')
}

// Mirrors paths.ts for an instance directory (a driver workspace).
export function workspaceDbPath(instanceDir: string): string {
  return path.join(instanceDir, 'garmin', 'data', 'catalyst-app.duckdb')
}

// Mirrors paths.ts VIDEOS_DIR for an instance directory.
export function workspaceVideoDir(instanceDir: string): string {
  return path.join(instanceDir, 'garmin', 'data', 'videos')
}
