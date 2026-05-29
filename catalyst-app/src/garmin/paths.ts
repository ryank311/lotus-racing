// Filesystem locations shared across the app.
//
// Dev mode: piggyback on the existing Python `garmin/` data folder so the
// same data works in both projects. Override with CATALYST_DATA_DIR.
// Packaged: all writable paths live under app.getPath('userData') so we
// never try to write inside the read-only .asar archive.

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// Detect packaged build: __dirname is inside .asar when packaged.
const isPackaged = __dirname.includes('app.asar') || ((): boolean => {
  try { return require('electron').app?.isPackaged ?? false } catch { return false }
})()

function findRepoRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'garmin', 'config.example.json'))) return dir
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

// In dev, resolve paths relative to the source tree.
// In packaged builds, use the user-data directory for everything writable.
function getUserDataDir(): string {
  try { return require('electron').app.getPath('userData') } catch { return os.homedir() }
}

const REPO_ROOT_DEFAULT = isPackaged
  ? path.join(getUserDataDir(), 'catalyst-data')
  : findRepoRoot(__dirname)

export const REPO_ROOT = process.env.CATALYST_REPO_ROOT
  ? path.resolve(process.env.CATALYST_REPO_ROOT)
  : REPO_ROOT_DEFAULT

export const GARMIN_DIR = isPackaged
  ? path.join(getUserDataDir(), 'garmin')
  : path.join(REPO_ROOT, 'garmin')

export const DATA_DIR = process.env.CATALYST_DATA_DIR
  ? path.resolve(process.env.CATALYST_DATA_DIR)
  : path.join(GARMIN_DIR, 'data')

export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
export const MEAN_LINES_DIR = path.join(DATA_DIR, 'mean_lines')

export const CONFIG_PATH = path.join(GARMIN_DIR, 'config.json')
export const GARTH_TOKEN_DIR = path.join(GARMIN_DIR, '.garth')
export const CATALYST_TOKEN_CACHE = path.join(GARMIN_DIR, '.catalyst_token.json')

// DB lives in a path the Electron app owns exclusively.
export const DB_PATH = process.env.CATALYST_DB_PATH
  ? path.resolve(process.env.CATALYST_DB_PATH)
  : path.join(DATA_DIR, 'catalyst-app.duckdb')

export const TRACKS_DIR = isPackaged
  ? path.join(getUserDataDir(), 'tracks')
  : path.join(REPO_ROOT, 'tracks')

export const COACHING_DIR = isPackaged
  ? path.join(getUserDataDir(), 'coaching')
  : path.join(REPO_ROOT, 'coaching')

// App-data settings (active profile, etc.).
export const SETTINGS_PATH = path.join(
  process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config')),
  'catalyst-coach',
  'settings.json',
)

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

// Seed writable userData directories from bundled read-only resources.
// Called once at startup in the packaged app. Safe to call repeatedly — only
// copies files that don't already exist in userData (preserving user edits).
export function seedUserData(): void {
  if (!isPackaged) return

  // Seed track YAMLs from the bundled-tracks extraResource.
  try {
    const resourcesPath = (process as any).resourcesPath as string | undefined
    if (!resourcesPath) return
    const bundledTracks = path.join(resourcesPath, 'bundled-tracks')
    if (!fs.existsSync(bundledTracks)) return
    ensureDir(TRACKS_DIR)
    for (const fn of fs.readdirSync(bundledTracks)) {
      if (!fn.toLowerCase().endsWith('.yaml')) continue
      const dest = path.join(TRACKS_DIR, fn)
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(bundledTracks, fn), dest)
      }
    }
  } catch (e) {
    console.warn('seedUserData: failed to seed tracks', e)
  }
}
