// Filesystem locations shared across the app.
//
// We piggyback on the existing Python `garmin/` data folder so the same data
// works in both projects. Override with CATALYST_DATA_DIR to point elsewhere.

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

function findRepoRoot(start: string): string {
  // Walk up looking for a sibling `garmin/` folder or `.git`.
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'garmin', 'config.example.json'))) return dir
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

const REPO_ROOT_DEFAULT = findRepoRoot(__dirname)

export const REPO_ROOT = process.env.CATALYST_REPO_ROOT
  ? path.resolve(process.env.CATALYST_REPO_ROOT)
  : REPO_ROOT_DEFAULT

export const GARMIN_DIR = path.join(REPO_ROOT, 'garmin')

export const DATA_DIR = process.env.CATALYST_DATA_DIR
  ? path.resolve(process.env.CATALYST_DATA_DIR)
  : path.join(GARMIN_DIR, 'data')

export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
export const MEAN_LINES_DIR = path.join(DATA_DIR, 'mean_lines')

export const CONFIG_PATH = path.join(GARMIN_DIR, 'config.json')
export const GARTH_TOKEN_DIR = path.join(GARMIN_DIR, '.garth')
export const CATALYST_TOKEN_CACHE = path.join(GARMIN_DIR, '.catalyst_token.json')
// DB lives in a path the Electron app owns exclusively. Sharing the same
// .duckdb file with the Python pipeline (different libduckdb version) has
// caused ART-index corruption + SIGBUS crashes during commit cleanup. The
// underlying telemetry (JSON + protobuf) is the source of truth; the DB is
// a derived cache and can be rebuilt in seconds.
export const DB_PATH = process.env.CATALYST_DB_PATH
  ? path.resolve(process.env.CATALYST_DB_PATH)
  : path.join(DATA_DIR, 'catalyst-app.duckdb')
export const TRACKS_DIR = path.join(REPO_ROOT, 'tracks')
export const COACHING_DIR = path.join(REPO_ROOT, 'coaching')

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
