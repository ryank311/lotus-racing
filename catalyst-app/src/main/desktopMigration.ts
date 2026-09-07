/** Copy the old desktop workspace before starting any database or HTTP worker. */
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { userDirectory, USER_RE } from './serverStorage.js'

export interface LegacyDesktopWorkspace {
  repoRoot: string
  garminDir: string
  dataDir: string
  dbPath: string
  tracksDir: string
  coachingDir: string
  settingsPath: string
}

export async function migrateDesktopWorkspace(dataDir: string, legacy: LegacyDesktopWorkspace): Promise<string | null> {
  // A short-lived process holds the source DB's read lock during the copy.
  // Exiting releases it before the desktop fallback or imported worker opens.
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'desktopMigrationWorker.js'), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let result: { username: string | null } | undefined
    let failure: Error | undefined
    child.on('error', error => { failure = error })
    child.on('message', (message: { username: string | null; error?: string }) => {
      if (message.error) failure = new Error(message.error)
      else result = message
    })
    let finished = false
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      if (failure) reject(failure)
      else if (code !== 0 || !result) reject(new Error(`Desktop import process exited (${code})`))
      else resolve(result.username)
    }
    child.once('exit', finish)
    child.once('close', finish)
    child.send({ dataDir, legacy }, error => { if (error) { failure = error; child.kill() } })
  })
}

function desktopSourceId(legacy: LegacyDesktopWorkspace): string {
  return createHash('sha256').update(JSON.stringify(
    Object.entries(legacy).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, path.resolve(value)]),
  )).digest('hex')
}

export function importedDesktopUsername(dataDir: string, legacy: LegacyDesktopWorkspace): string | null {
  const sourceId = desktopSourceId(legacy)
  const usersDir = path.join(dataDir, 'users')
  if (fs.existsSync(usersDir)) {
    for (const id of fs.readdirSync(usersDir)) {
      const accountPath = path.join(usersDir, id, 'account.json')
      if (!fs.existsSync(accountPath)) continue
      const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'))
      if (account.desktopSource === sourceId && typeof account.username === 'string'
          && USER_RE.test(account.username) && path.basename(userDirectory(dataDir, account.username)) === id) {
        return account.username
      }
    }
  }
  return null
}

export function copyDesktopWorkspace(dataDir: string, legacy: LegacyDesktopWorkspace): string | null {
  const imported = importedDesktopUsername(dataDir, legacy)
  if (imported) return imported
  const usersDir = path.join(dataDir, 'users')
  const profiles = fs.existsSync(legacy.repoRoot)
    ? fs.readdirSync(legacy.repoRoot).filter(name =>
      !name.startsWith('.') && fs.existsSync(path.join(legacy.repoRoot, name, 'Car.md')))
    : []
  const hasEntries = (dir: string) => fs.existsSync(dir) && fs.readdirSync(dir).length > 0
  const garminFiles = ['config.json', '.catalyst_token.json', '.garth']
  if (!fs.existsSync(legacy.dbPath) && !fs.existsSync(legacy.settingsPath)
      && !garminFiles.some(name => fs.existsSync(path.join(legacy.garminDir, name)))
      && !profiles.length && ![legacy.dataDir, legacy.tracksDir, legacy.coachingDir].some(hasEntries)) {
    return null
  }

  // Never merge legacy data into an account someone has already used.
  let username = 'Desktop'
  for (let suffix = 2; fs.existsSync(userDirectory(dataDir, username)); suffix++) username = `Desktop ${suffix}`
  fs.mkdirSync(usersDir, { recursive: true })
  const staging = fs.mkdtempSync(path.join(dataDir, '.desktop-import-'))
  const copy = (source: string, dest: string) => {
    if (!fs.existsSync(source)) return
    const relative = path.relative(path.resolve(source), path.resolve(staging))
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('The server data directory must be outside the legacy folders being imported')
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(source, dest, { recursive: true, dereference: true })
  }
  try {
    copy(legacy.dataDir, path.join(staging, 'garmin', 'data'))
    for (const suffix of ['', '.wal']) {
      copy(legacy.dbPath + suffix, path.join(staging, 'garmin', 'data', 'catalyst-app.duckdb' + suffix))
    }
    for (const name of garminFiles) copy(path.join(legacy.garminDir, name), path.join(staging, 'garmin', name))
    const configPath = path.join(staging, 'garmin', 'config.json')
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (config.auth) delete config.auth.password
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    }
    copy(legacy.settingsPath, path.join(staging, 'settings.json'))
    copy(legacy.tracksDir, path.join(staging, 'tracks'))
    copy(legacy.coachingDir, path.join(staging, 'coaching'))
    for (const name of profiles) copy(path.join(legacy.repoRoot, name), path.join(staging, name))
    fs.writeFileSync(path.join(staging, 'account.json'), JSON.stringify({ username, desktopSource: desktopSourceId(legacy) }, null, 2))
    // The import marker travels with the data in one atomic rename. Interrupted
    // copies cannot publish a partial account or overwrite a completed import.
    fs.renameSync(staging, userDirectory(dataDir, username))
    return username
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
