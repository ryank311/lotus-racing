import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const USER_RE = /^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,39}$/u

export function accountKey(username: string): string {
  return username.normalize('NFKC').toLocaleLowerCase()
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
