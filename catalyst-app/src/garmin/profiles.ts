// Read legacy Markdown profiles and settings only for the initial database seed.

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
  // vehicleGuid → profile name. Persists user overrides for vehicles whose
  // make doesn't fuzzy-match a profile folder (e.g. a Cayman mapped to a
  // "Porsche" profile, when the vehicle make is "PORSCHE").
  vehicle_profile_map?: Record<string, string>
}

function readSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) return {}
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function getActiveProfileName(): string | null {
  const s = readSettings()
  if (s.active_profile) return s.active_profile
  const profiles = discoverProfiles()
  return profiles[0]?.name ?? null
}

export function getVehicleProfileMap(): Record<string, string> {
  return readSettings().vehicle_profile_map ?? {}
}
