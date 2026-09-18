/**
 * DuckDB-backed Garage storage.
 *
 * Existing Markdown profile directories are imported once when the Garage
 * tables are first initialized. After that, the workspace database is the sole
 * source of truth; seed files are never modified or materialized from DuckDB.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { CarProfile } from '../shared/types.js'
import { DB_PATH, REPO_ROOT } from './paths.js'
import { initSchema, withDb } from './loadToDb.js'
import {
  discoverProfiles as discoverMarkdownProfiles,
  getActiveProfileName as getMarkdownActiveProfile,
  getVehicleProfileMap as getMarkdownVehicleMap,
} from './profiles.js'

const seedPromises = new Map<string, Promise<void>>()
const seededDbIdentities = new Map<string, string>()

function dbIdentity(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null
  const stat = fs.statSync(dbPath)
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

function safeName(value: string, label: string): string {
  const name = path.basename(value.trim())
  if (!name || name === '.' || name === '..' || name !== value.trim()) {
    throw new Error(`invalid ${label}`)
  }
  return name
}

function profileShape(name: string): CarProfile {
  // Legacy API paths identify database records; they need not exist on disk.
  const dir = path.join(REPO_ROOT, name)
  return { name, dir, carMdPath: path.join(dir, 'Car.md') }
}

async function seedGarage(dbPath: string): Promise<void> {
  await withDb(async con => {
    await initSchema(con)
    await con.run('BEGIN TRANSACTION')
    try {
      const seeded = (await con.runAndReadAll(
        "SELECT value FROM garage_settings WHERE key = 'seed_complete'",
      )).getRowsJson()
      if (seeded.length) {
        await con.run('COMMIT')
        return
      }
      const countRow = (await con.runAndReadAll('SELECT COUNT(*) FROM garage_profiles')).getRowsJson()[0] ?? []
      const isEmpty = Number(countRow[0] ?? 0) === 0

      if (isEmpty) {
        for (const profile of discoverMarkdownProfiles()) {
          await con.run(
            'INSERT OR IGNORE INTO garage_profiles (name) VALUES (?)',
            [profile.name] as any,
          )
          for (const fileName of fs.readdirSync(profile.dir)) {
            if (!fileName.toLowerCase().endsWith('.md')) continue
            const filePath = path.join(profile.dir, fileName)
            if (!fs.statSync(filePath).isFile()) continue
            const content = fs.readFileSync(filePath, 'utf8')
            await con.run(
              `INSERT OR IGNORE INTO garage_files (profile_name, file_name, content)
               VALUES (?, ?, ?)`,
              [profile.name, fileName, content] as any,
            )
          }
        }

        for (const [vehicleGuid, profileName] of Object.entries(getMarkdownVehicleMap())) {
          await con.run(
            `INSERT OR IGNORE INTO garage_vehicle_profiles (vehicle_guid, profile_name)
             VALUES (?, ?)`,
            [vehicleGuid, profileName] as any,
          )
        }
        const active = getMarkdownActiveProfile()
        if (active) {
          await con.run(
            `INSERT OR IGNORE INTO garage_settings (key, value) VALUES ('active_profile', ?)`,
            [active] as any,
          )
        }
      }

      // Existing database profiles are already canonical. Mark them initialized
      // without importing stale files; also remember an intentionally empty seed.
      await con.run("INSERT INTO garage_settings (key, value) VALUES ('seed_complete', 'true')")
      await con.run('COMMIT')
    } catch (error) {
      await con.run('ROLLBACK')
      throw error
    }
  }, dbPath)
}

export async function ensureGarageSeeded(dbPath = DB_PATH): Promise<void> {
  const currentIdentity = dbIdentity(dbPath)
  if (currentIdentity && seededDbIdentities.get(dbPath) === currentIdentity) return
  let current = seedPromises.get(dbPath)
  if (!current) {
    current = seedGarage(dbPath).then(() => {
      const identity = dbIdentity(dbPath)
      if (identity) seededDbIdentities.set(dbPath, identity)
    })
    seedPromises.set(dbPath, current)
  }
  try {
    await current
  } finally {
    if (seedPromises.get(dbPath) === current) seedPromises.delete(dbPath)
  }
}

export async function listGarageProfiles(dbPath = DB_PATH): Promise<CarProfile[]> {
  await ensureGarageSeeded(dbPath)
  return withDb(async con => {
    const rows = (await con.runAndReadAll('SELECT name FROM garage_profiles ORDER BY lower(name)')).getRowsJson()
    return rows.map(row => profileShape(String(row[0])))
  }, dbPath)
}

export async function listGarageFiles(profileName: string): Promise<Array<{ name: string; path: string }>> {
  await ensureGarageSeeded()
  const name = safeName(profileName, 'profile name')
  return withDb(async con => {
    const rows = (await con.runAndReadAll(
      `SELECT file_name FROM garage_files WHERE profile_name = ?
       ORDER BY CASE WHEN lower(file_name) = 'car.md' THEN 0 ELSE 1 END, lower(file_name)`,
      [name] as any,
    )).getRowsJson()
    return rows.map(row => ({ name: String(row[0]), path: path.join(REPO_ROOT, name, String(row[0])) }))
  })
}

export async function readGarageFile(filePath: string): Promise<string> {
  await ensureGarageSeeded()
  const relative = path.relative(REPO_ROOT, path.resolve(filePath))
  const parts = relative.split(path.sep)
  if (relative.startsWith('..') || parts.length !== 2) throw new Error('invalid Garage file path')
  const profileName = safeName(parts[0], 'profile name')
  const fileName = safeName(parts[1], 'file name')
  return withDb(async con => {
    const rows = (await con.runAndReadAll(
      'SELECT content FROM garage_files WHERE profile_name = ? AND file_name = ?',
      [profileName, fileName] as any,
    )).getRowsJson()
    if (!rows.length) throw new Error(`Garage file not found: ${fileName}`)
    return String(rows[0][0] ?? '')
  })
}

export async function writeGarageFile(profileName: string, fileNameOrPath: string, content: string): Promise<string> {
  await ensureGarageSeeded()
  const name = safeName(profileName, 'profile name')
  const fileName = safeName(path.basename(fileNameOrPath), 'file name')
  await withDb(async con => {
    await con.run(
      `INSERT OR REPLACE INTO garage_profiles (name, created_at, updated_at)
       VALUES (?, COALESCE((SELECT created_at FROM garage_profiles WHERE name = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
      [name, name] as any,
    )
    await con.run(
      `INSERT OR REPLACE INTO garage_files (profile_name, file_name, content, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      [name, fileName, content] as any,
    )
  })
  return path.join(REPO_ROOT, name, fileName)
}

export async function deleteGarageFile(profileName: string, fileName: string): Promise<void> {
  await ensureGarageSeeded()
  const name = safeName(profileName, 'profile name')
  const file = safeName(fileName, 'file name')
  if (file.toLowerCase() === 'car.md') throw new Error('Car.md cannot be deleted')
  await withDb(async con => {
    await con.run('DELETE FROM garage_files WHERE profile_name = ? AND file_name = ?', [name, file] as any)
  })
}

export async function ensureGarageProfile(nameValue: string, vehicleGuid?: string): Promise<CarProfile> {
  await ensureGarageSeeded()
  const name = safeName(nameValue, 'profile name')
  const existing = await listGarageFiles(name)
  if (!existing.some(file => file.name.toLowerCase() === 'car.md')) {
    await writeGarageFile(name, 'Car.md', `# ${name}\n\n<!-- Add car specs, setup notes, and driver feedback here. -->\n`)
  }
  if (vehicleGuid) await setGarageVehicleProfile(vehicleGuid, name)
  return profileShape(name)
}

export async function setGarageVehicleProfile(vehicleGuid: string, profileName: string | null): Promise<void> {
  await ensureGarageSeeded()
  await withDb(async con => {
    if (profileName) {
      const name = safeName(profileName, 'profile name')
      await con.run(
        `INSERT OR REPLACE INTO garage_vehicle_profiles (vehicle_guid, profile_name, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [vehicleGuid, name] as any,
      )
    } else {
      await con.run('DELETE FROM garage_vehicle_profiles WHERE vehicle_guid = ?', [vehicleGuid] as any)
    }
  })
}

export async function resolveGarageVehicleProfile(
  vehicleGuid: string | null,
  make: string | null,
  dbPath = DB_PATH,
): Promise<{ profile: string | null; explicit: boolean }> {
  const profiles = await listGarageProfiles(dbPath)
  if (vehicleGuid) {
    const explicit = await withDb(async con => (
      await con.runAndReadAll(
        'SELECT profile_name FROM garage_vehicle_profiles WHERE vehicle_guid = ?',
        [vehicleGuid] as any,
      )
    ).getRowsJson(), dbPath)
    if (explicit.length) return { profile: String(explicit[0][0]), explicit: true }
  }
  if (make) {
    const lowerMake = make.toLowerCase()
    const profile = profiles.find(item => {
      const lowerName = item.name.toLowerCase()
      return lowerName === lowerMake || lowerName.includes(lowerMake) || lowerMake.includes(lowerName)
    })
    if (profile) return { profile: profile.name, explicit: false }
  }
  return { profile: null, explicit: false }
}

export async function getGarageActiveProfile(dbPath = DB_PATH): Promise<string | null> {
  const profiles = await listGarageProfiles(dbPath)
  const rows = await withDb(async con => (
    await con.runAndReadAll("SELECT value FROM garage_settings WHERE key = 'active_profile'")
  ).getRowsJson(), dbPath)
  const selected = rows.length ? String(rows[0][0]) : null
  return selected && profiles.some(profile => profile.name === selected) ? selected : (profiles[0]?.name ?? null)
}

export async function setGarageActiveProfile(profileName: string): Promise<void> {
  await ensureGarageSeeded()
  const name = safeName(profileName, 'profile name')
  await withDb(async con => {
    await con.run(
      `INSERT OR REPLACE INTO garage_settings (key, value, updated_at)
       VALUES ('active_profile', ?, CURRENT_TIMESTAMP)`,
      [name] as any,
    )
  })
}

export async function resolveGarageProfile(name?: string | null, dbPath = DB_PATH): Promise<CarProfile> {
  const profiles = await listGarageProfiles(dbPath)
  const selected = name ?? await getGarageActiveProfile(dbPath)
  const profile = profiles.find(item => item.name === selected)
    ?? profiles.find(item => item.name.toLowerCase() === selected?.toLowerCase())
  if (profile) return profile
  throw new Error(selected ? `no Garage profile '${selected}'` : 'no Garage profile found')
}
