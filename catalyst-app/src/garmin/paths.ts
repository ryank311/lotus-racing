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

// Stable Application Support dir — must match SETTINGS_PATH and must NOT
// depend on Electron's productName ("Catalyst Coach" vs "catalyst-coach") or
// on app.getPath('userData') being callable before `ready`. A mismatch here
// is why Garage markdown saves looked like they worked in one session and
// vanished after relaunch in the packaged app.
function defaultUserDataDir(): string {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'catalyst-coach')
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'catalyst-coach')
  }
  return path.join(os.homedir(), '.config', 'catalyst-coach')
}

function getUserDataDir(): string {
  const fallback = defaultUserDataDir()
  try {
    const electron = require('electron') as typeof import('electron')
    const app = electron.app
    if (!app) return fallback
    // Pin userData before `ready` so Chromium, window-state, and profile
    // markdown all share the same folder in packaged and unpackaged runs.
    try { app.setPath('userData', fallback) } catch { /* already ready */ }
    try { return app.getPath('userData') } catch { return fallback }
  } catch {
    return fallback
  }
}

const REPO_ROOT_DEFAULT = isPackaged
  ? path.join(getUserDataDir(), 'catalyst-data')
  : findRepoRoot(__dirname)

// The remote server launches one backend process per Catalyst username. Each
// process receives an instance directory before this module is loaded, so all
// of the existing path constants naturally point at that user's private data.
// This keeps DuckDB, raw sessions, tokens, settings, coaching, and Garage files
// isolated without adding user predicates to every query in the application.
export const INSTANCE_DIR = process.env.CATALYST_INSTANCE_DIR
  ? path.resolve(process.env.CATALYST_INSTANCE_DIR)
  : null

export const REPO_ROOT = INSTANCE_DIR ?? (process.env.CATALYST_REPO_ROOT
  ? path.resolve(process.env.CATALYST_REPO_ROOT)
  : REPO_ROOT_DEFAULT)

export const GARMIN_DIR = INSTANCE_DIR
  ? path.join(INSTANCE_DIR, 'garmin')
  : isPackaged
  ? path.join(getUserDataDir(), 'garmin')
  : path.join(REPO_ROOT, 'garmin')

export const DATA_DIR = INSTANCE_DIR
  ? path.join(GARMIN_DIR, 'data')
  : process.env.CATALYST_DATA_DIR
  ? path.resolve(process.env.CATALYST_DATA_DIR)
  : path.join(GARMIN_DIR, 'data')

export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
export const MEAN_LINES_DIR = path.join(DATA_DIR, 'mean_lines')

export const CONFIG_PATH = path.join(GARMIN_DIR, 'config.json')
export const GARTH_TOKEN_DIR = path.join(GARMIN_DIR, '.garth')
export const CATALYST_TOKEN_CACHE = path.join(GARMIN_DIR, '.catalyst_token.json')

// DB lives in a path the Electron app owns exclusively.
export const DB_PATH = INSTANCE_DIR
  ? path.join(DATA_DIR, 'catalyst-app.duckdb')
  : process.env.CATALYST_DB_PATH
  ? path.resolve(process.env.CATALYST_DB_PATH)
  : path.join(DATA_DIR, 'catalyst-app.duckdb')

export const TRACKS_DIR = INSTANCE_DIR
  ? path.join(INSTANCE_DIR, 'tracks')
  : isPackaged
  ? path.join(getUserDataDir(), 'tracks')
  : path.join(REPO_ROOT, 'tracks')

export const COACHING_DIR = INSTANCE_DIR
  ? path.join(INSTANCE_DIR, 'coaching')
  : isPackaged
  ? path.join(getUserDataDir(), 'coaching')
  : path.join(REPO_ROOT, 'coaching')

// App-data settings (active profile, etc.).
export const SETTINGS_PATH = INSTANCE_DIR
  ? path.join(INSTANCE_DIR, 'settings.json')
  : path.join(defaultUserDataDir(), 'settings.json')

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

function copyWritable(src: string, dest: string): void {
  fs.copyFileSync(src, dest)
  // extraResources inside the .app are often mode 0444. copyFileSync keeps
  // that mode, and a later Garage save then fails with EACCES — only in the
  // packaged app, which is exactly the "works in dev" report.
  try { fs.chmodSync(dest, 0o644) } catch { /* non-fatal */ }
}

// Seed writable userData directories from bundled read-only resources.
// Called once at startup in the packaged app. Safe to call repeatedly — only
// copies files that don't already exist in userData (preserving user edits).
export function seedUserData(): void {
  if (INSTANCE_DIR) {
    ensureDir(INSTANCE_DIR)
    ensureDir(GARMIN_DIR)
    ensureDir(DATA_DIR)
    ensureDir(SESSIONS_DIR)
    ensureDir(MEAN_LINES_DIR)
    ensureDir(TRACKS_DIR)
    ensureDir(COACHING_DIR)

    // Development/headless installs can seed Garage profiles and track YAMLs
    // from the repository. Packaged Electron supplies the resources directory.
    const templateRoot = process.env.CATALYST_TEMPLATE_ROOT
      ? path.resolve(process.env.CATALYST_TEMPLATE_ROOT)
      : null
    const resourcesRoot = process.env.CATALYST_BUNDLED_RESOURCES
      ? path.resolve(process.env.CATALYST_BUNDLED_RESOURCES)
      : null

    const tracksSource = resourcesRoot
      ? path.join(resourcesRoot, 'bundled-tracks')
      : templateRoot ? path.join(templateRoot, 'tracks') : null
    if (tracksSource && fs.existsSync(tracksSource)) {
      for (const fn of fs.readdirSync(tracksSource)) {
        if (!fn.toLowerCase().endsWith('.yaml')) continue
        const dest = path.join(TRACKS_DIR, fn)
        if (!fs.existsSync(dest)) copyWritable(path.join(tracksSource, fn), dest)
      }
    }

    const copyProfile = (name: string, srcDir: string) => {
      if (!fs.existsSync(path.join(srcDir, 'Car.md'))) return
      const destDir = path.join(INSTANCE_DIR, name)
      ensureDir(destDir)
      for (const fn of fs.readdirSync(srcDir)) {
        if (fn.startsWith('.')) continue
        const src = path.join(srcDir, fn)
        if (!fs.statSync(src).isFile()) continue
        const dest = path.join(destDir, fn)
        if (!fs.existsSync(dest)) copyWritable(src, dest)
      }
    }

    if (resourcesRoot) {
      const profilesRoot = path.join(resourcesRoot, 'bundled-profiles')
      if (fs.existsSync(profilesRoot)) {
        for (const name of fs.readdirSync(profilesRoot)) {
          copyProfile(name, path.join(profilesRoot, name))
        }
      }
    } else if (templateRoot && fs.existsSync(templateRoot)) {
      for (const name of fs.readdirSync(templateRoot)) {
        const srcDir = path.join(templateRoot, name)
        try {
          if (fs.statSync(srcDir).isDirectory()) copyProfile(name, srcDir)
        } catch { /* ignore unreadable template entries */ }
      }
    }
    return
  }

  if (!isPackaged) return

  const resourcesPath = (process as any).resourcesPath as string | undefined
  if (!resourcesPath) return

  // Seed track YAMLs from the bundled-tracks extraResource.
  try {
    const bundledTracks = path.join(resourcesPath, 'bundled-tracks')
    if (fs.existsSync(bundledTracks)) {
      ensureDir(TRACKS_DIR)
      for (const fn of fs.readdirSync(bundledTracks)) {
        if (!fn.toLowerCase().endsWith('.yaml')) continue
        const dest = path.join(TRACKS_DIR, fn)
        if (!fs.existsSync(dest)) copyWritable(path.join(bundledTracks, fn), dest)
      }
    }
  } catch (e) {
    console.warn('seedUserData: failed to seed tracks', e)
  }

  // Seed car profile directories (Lotus, Vette, …) from bundled-profiles.
  // Each profile is a directory of .md context files used for brief generation.
  try {
    const bundledProfiles = path.join(resourcesPath, 'bundled-profiles')
    if (fs.existsSync(bundledProfiles)) {
      for (const profileName of fs.readdirSync(bundledProfiles)) {
        const srcDir = path.join(bundledProfiles, profileName)
        if (!fs.statSync(srcDir).isDirectory()) continue
        const destDir = path.join(REPO_ROOT, profileName)
        ensureDir(destDir)
        for (const fn of fs.readdirSync(srcDir)) {
          const dest = path.join(destDir, fn)
          if (!fs.existsSync(dest)) copyWritable(path.join(srcDir, fn), dest)
          else try { fs.chmodSync(dest, 0o644) } catch { /* already writable */ }
        }
      }
    }
  } catch (e) {
    console.warn('seedUserData: failed to seed profiles', e)
  }
}
