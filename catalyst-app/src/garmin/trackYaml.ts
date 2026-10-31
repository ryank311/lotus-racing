// Mini YAML reader for track seed files (tracks/*.yaml), covering the subset
// detect_corners emits. Avoids pulling in a full YAML lib.
//
// These files only seed the workspace database: trackStore imports a layout's
// file once, and the database is the source of truth from then on. Nothing in
// the app writes track YAML.

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

// A corner complex runs from one braking zone to the next. `corners` is a
// comma-separated list because this YAML subset has no inline lists.
export interface TrackComplex {
  id: string
  name: string
  start_m: number
  end_m: number
  corners?: string
}

export interface TrackYaml {
  track_name?: string
  track_configuration_name?: string
  mean_line_guid?: string
  total_dist_m?: number
  point_count?: number
  segments: TrackSegment[]
  corners: TrackCorner[]
  complexes?: TrackComplex[]
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

export function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// The file name the old Tracks editor gave a layout it created a file for:
// `<track-alias>-<config-slug>.yaml`. Such files may carry no header, so this
// is the only way to tell which layout they describe.
export function seedFileName(trackName: string, configName: string): string {
  const alias = slugify(trackName).split('-')[0] || slugify(trackName) || 'track'
  return `${alias}-${slugify(configName)}.yaml`
}

export function loadTrackYaml(filePath: string): TrackYaml {
  const out: TrackYaml = { segments: [], corners: [] }
  if (!fs.existsSync(filePath)) return out

  let currentList: any[] | null = null
  let currentItem: Record<string, unknown> | null = null

  for (const rawLine of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line || line.trim().startsWith('#')) continue
    if (line === 'segments:' || line === 'corners:' || line === 'complexes:') {
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
