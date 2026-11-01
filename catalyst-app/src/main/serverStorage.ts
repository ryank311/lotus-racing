import { createHash } from 'node:crypto'
import fs from 'node:fs'
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

// A driver's videos. They are large and written once, so a server with a
// media directory (CATALYST_MEDIA_DIR, its own volume in the NAS image) keeps
// them there, apart from the data directory: backups of the database never
// copy them. Mirrors paths.ts VIDEOS_DIR for an instance directory.
export function workspaceVideoDir(instanceDir: string, mediaDir: string | null = null): string {
  return mediaDir ? path.join(mediaDir, 'users', path.basename(instanceDir), 'videos') : legacyVideoDir(instanceDir)
}

// Where videos were kept before the media directory, and still are without one.
export function legacyVideoDir(instanceDir: string): string {
  return path.join(instanceDir, 'garmin', 'data', 'videos')
}

// A video's file, or null. Videos not yet moved to the media directory are
// still read from the data directory.
export function workspaceVideoFile(instanceDir: string, mediaDir: string | null, videoId: string): string | null {
  for (const dir of [workspaceVideoDir(instanceDir, mediaDir), legacyVideoDir(instanceDir)]) {
    const file = path.join(dir, `${videoId}.mp4`)
    if (fs.existsSync(file)) return file
  }
  return null
}

// Deleting a video removes its data-directory copy first (ipc.ts), so a
// video deleted mid-move is never left behind on the media volume.
async function moveVideo(source: string, target: string): Promise<boolean> {
  try {
    await fs.promises.rename(source, target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  // Separate volumes: copy (a reflink where the filesystem allows), then swap.
  const size = (await fs.promises.stat(source)).size
  if ((await fs.promises.stat(target).catch(() => null))?.size !== size) {
    const partial = `${target}.moving`
    await fs.promises.copyFile(source, partial, fs.constants.COPYFILE_FICLONE)
    await fs.promises.rename(partial, target)
  }
  if (fs.existsSync(source)) { await fs.promises.rm(source, { force: true }); return true }
  await fs.promises.rm(target, { force: true })
  return false
}

const MOVABLE_VIDEO = /^[0-9a-f-]{36}\.mp4$/

// Moves every workspace's videos from the data directory to the media
// directory, one file at a time, while the server runs. A file copied across
// volumes lands under a temporary name and is renamed into place before the
// original is removed, so each video is readable from one place or the other
// throughout. Stops between files once `stop` returns true.
export async function moveVideosToMedia(dataDir: string, mediaDir: string, stop: () => boolean = () => false): Promise<number> {
  const list = (dir: string) => fs.promises.readdir(dir).catch(() => [] as string[])
  let moved = 0
  for (const user of await list(path.join(dataDir, 'users'))) {
    const instanceDir = path.join(dataDir, 'users', user)
    const from = legacyVideoDir(instanceDir)
    const names = await list(from)
    if (!names.length) continue
    const to = workspaceVideoDir(instanceDir, mediaDir)
    await fs.promises.mkdir(to, { recursive: true })
    for (const name of await list(to)) if (name.endsWith('.moving')) await fs.promises.rm(path.join(to, name), { force: true })
    for (const name of names) {
      if (stop()) return moved
      const source = path.join(from, name)
      // Uploads cut off by a restart cannot resume; new ones go to the media directory.
      if (name === '.incoming') { await fs.promises.rm(source, { recursive: true, force: true }); continue }
      if (!MOVABLE_VIDEO.test(name)) continue
      try {
        if (await moveVideo(source, path.join(to, name))) moved++
      } catch (error) {
        // Deleted before it could move.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await fs.promises.rmdir(from).catch(() => {})
  }
  return moved
}
