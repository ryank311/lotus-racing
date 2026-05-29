// Mini YAML reader/loader for the subset our exporter emits.
// Avoids pulling in a full YAML lib.

import fs from 'node:fs'

export interface TrackSegment {
  id: number
  start_dist_m: number
  end_dist_m: number
  length_m?: number
  flag?: number
}

export interface TrackCorner {
  turn: string
  name: string
  direction?: string
  character?: string
  apex_idx: number
  dist_idx_start: number
  dist_idx_end: number
  apex_lat?: number
  apex_lon?: number
  apex_radius_m?: number
}

export interface TrackYaml {
  track_name?: string
  track_configuration_name?: string
  mean_line_guid?: string
  total_dist_m?: number
  point_count?: number
  segments: TrackSegment[]
  corners: TrackCorner[]
}

function coerce(s: string): unknown {
  s = s.trim().replace(/^"|"$/g, '')
  if (s === '') return ''
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
  if (s.toLowerCase() === 'true') return true
  if (s.toLowerCase() === 'false') return false
  return s
}

export function loadTrackYaml(filePath: string): TrackYaml {
  const out: TrackYaml = { segments: [], corners: [] }
  if (!fs.existsSync(filePath)) return out

  let currentList: any[] | null = null
  let currentItem: Record<string, unknown> | null = null

  for (const rawLine of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line || line.trim().startsWith('#')) continue
    if (line === 'segments:' || line === 'corners:') {
      currentList = []
      ;(out as any)[line.slice(0, -1)] = currentList
      currentItem = null
      continue
    }
    if (line.startsWith('  - ')) {
      currentItem = {}
      currentList?.push(currentItem)
      const tail = line.slice(4)
      const idx = tail.indexOf(':')
      if (idx > -1) currentItem[tail.slice(0, idx).trim()] = coerce(tail.slice(idx + 1))
      continue
    }
    if (line.startsWith('    ') && currentItem) {
      const tail = line.trim()
      const idx = tail.indexOf(':')
      if (idx > -1) currentItem[tail.slice(0, idx).trim()] = coerce(tail.slice(idx + 1))
      continue
    }
    if (line.includes(':') && !line.startsWith(' ')) {
      const idx = line.indexOf(':')
      ;(out as any)[line.slice(0, idx).trim()] = coerce(line.slice(idx + 1))
      currentList = null
      currentItem = null
    }
  }
  return out
}
