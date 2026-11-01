// PDR video uploads, one at a time, shared by every page (Overview's button,
// the Import page, Session Review) so progress survives navigation.

import { useSyncExternalStore } from 'react'
import { api, isRemote } from './api'
import type { VideoImportResult } from '../shared/pdr'

export type UploadPhase = 'waiting' | 'uploading' | 'matching' | 'done' | 'failed' | 'cancelled'

export interface VideoUpload {
  key: number
  fileName: string
  size: number
  sent: number
  phase: UploadPhase
  sessionGuid: string | null
  result?: VideoImportResult
  error?: string
}

interface Entry extends VideoUpload { file: File; controller: AbortController }

let entries: Entry[] = []
let snapshot: VideoUpload[] = []
let nextKey = 1
let running = false
const listeners = new Set<() => void>()
const importedListeners = new Set<(result: VideoImportResult) => void>()

function publish() {
  snapshot = entries.map(({ file: _file, controller: _controller, ...rest }) => ({ ...rest }))
  listeners.forEach(listener => listener())
}

function update(entry: Entry, patch: Partial<VideoUpload>) {
  Object.assign(entry, patch)
  publish()
}

async function run() {
  if (running) return
  running = true
  try {
    for (let entry = entries.find(e => e.phase === 'waiting'); entry; entry = entries.find(e => e.phase === 'waiting')) {
      const current = entry
      update(current, { phase: 'uploading', sent: 0 })
      // Progress events arrive per network packet; repaint at most ~5×/s.
      let last = 0
      try {
        const result = await api.importVideo(current.file, {
          sessionGuid: current.sessionGuid,
          // The desktop bridge copies the file locally and cannot pass a signal.
          ...(isRemote ? { signal: current.controller.signal } : {}),
          onProgress: (sent, _total, phase) => {
            const now = Date.now()
            if (phase === 'matching' || now - last > 200) { last = now; update(current, { sent, phase }) }
          },
        })
        update(current, { phase: 'done', sent: current.size, result })
        importedListeners.forEach(listener => listener(result))
      } catch (error: any) {
        update(current, error?.name === 'AbortError'
          ? { phase: 'cancelled' }
          : { phase: 'failed', error: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    running = false
  }
}

const isVideo = (file: File) => /\.(mp4|mov)$/i.test(file.name)

/** Queue PDR videos; returns the names skipped because they are not videos. */
export function queueVideoUploads(files: Iterable<File>, sessionGuid: string | null = null): string[] {
  const skipped: string[] = []
  for (const file of files) {
    if (!isVideo(file)) { skipped.push(file.name); continue }
    entries.push({ key: nextKey++, fileName: file.name, size: file.size, sent: 0, phase: 'waiting', sessionGuid, file, controller: new AbortController() })
  }
  publish()
  void run()
  return skipped
}

export function cancelVideoUpload(key: number) {
  const entry = entries.find(e => e.key === key)
  if (!entry) return
  if (entry.phase === 'waiting') update(entry, { phase: 'cancelled' })
  else if (entry.phase === 'uploading') entry.controller.abort()
}

export function clearFinishedUploads() {
  entries = entries.filter(e => e.phase === 'waiting' || e.phase === 'uploading' || e.phase === 'matching')
  publish()
}

export function useVideoUploads(): VideoUpload[] {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => snapshot)
}

/** Called after each video is imported (matched or not). */
export function onVideoImported(listener: (result: VideoImportResult) => void): () => void {
  importedListeners.add(listener)
  return () => importedListeners.delete(listener)
}

export const uploadsActive = (uploads: VideoUpload[]) => uploads.some(u => u.phase === 'waiting' || u.phase === 'uploading' || u.phase === 'matching')
