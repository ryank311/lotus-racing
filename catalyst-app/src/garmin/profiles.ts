// Discover car profile directories at the repo root.

import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, SETTINGS_PATH } from './paths.js'
import type { CarProfile } from '../shared/types.js'

const NON_PROFILE_DIRS = new Set([
  'garmin', 'catalyst_gui', 'catalyst-apk-decompiled', 'coaching',
  'tracks', 'data', 'logs', 'build', 'dist', 'release',
  'catalyst_coach.egg-info', '__pycache__', '.git', '.claude',
  'node_modules', 'catalyst-app', 'src',
])

export function discoverProfiles(): CarProfile[] {
  const out: CarProfile[] = []
  if (!fs.existsSync(REPO_ROOT)) return out
  for (const name of fs.readdirSync(REPO_ROOT).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    const dir = path.join(REPO_ROOT, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (name.startsWith('.') || NON_PROFILE_DIRS.has(name)) continue
    const carMd = path.join(dir, 'Car.md')
    if (fs.existsSync(carMd)) {
      out.push({ name, dir, carMdPath: carMd })
    }
  }
  return out
}

interface Settings {
  active_profile?: string
}

function readSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) return {}
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2))
}

export function getActiveProfileName(): string | null {
  const s = readSettings()
  if (s.active_profile) return s.active_profile
  const profiles = discoverProfiles()
  return profiles[0]?.name ?? null
}

export function setActiveProfileName(name: string): void {
  const s = readSettings()
  s.active_profile = name
  writeSettings(s)
}

export function resolveProfileDir(name?: string | null): CarProfile {
  if (name) {
    const profiles = discoverProfiles()
    const match = profiles.find(p => p.name === name) ||
      profiles.find(p => p.name.toLowerCase() === name.toLowerCase())
    if (match) return match
    throw new Error(`no profile '${name}' (missing ${name}/Car.md)`)
  }
  for (const candidate of ['Lotus', 'Vette']) {
    const dir = path.join(REPO_ROOT, candidate)
    if (fs.existsSync(path.join(dir, 'Car.md'))) {
      return { name: candidate, dir, carMdPath: path.join(dir, 'Car.md') }
    }
  }
  const first = discoverProfiles()[0]
  if (first) return first
  throw new Error('no profile found — need a folder with Car.md')
}
