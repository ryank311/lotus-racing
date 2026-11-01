// Asks the page's lap video to play (or cue) a stretch of track: a corner
// from Session Review's explorer, a heatmap cell or a coach note in Analysis.

import { useSyncExternalStore } from 'react'

export interface VideoRangeRequest {
  startM: number
  endM: number
  // Show this lap ("sg:lapIdx") if it has video; otherwise the current one.
  lapKey?: string | null
  // What is being played, for the player's badge ("T5 · Snake").
  label?: string
  // Start playing; otherwise only move there, paused.
  play?: boolean
}

const listeners = new Set<(request: VideoRangeRequest) => void>()
const watchers = new Set<() => void>()
const changed = () => watchers.forEach(w => w())

/** True when a video player on the page took the request. */
export function requestVideoRange(request: VideoRangeRequest): boolean {
  listeners.forEach(listener => listener(request))
  return listeners.size > 0
}

export function onVideoRange(listener: (request: VideoRangeRequest) => void): () => void {
  listeners.add(listener)
  changed()
  return () => { listeners.delete(listener); changed() }
}

/** Whether a lap video is on the page to take requests. */
export function useVideoPlayerPresent(): boolean {
  return useSyncExternalStore(cb => { watchers.add(cb); return () => { watchers.delete(cb) } }, () => listeners.size > 0)
}
