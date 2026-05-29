// Mini YAML reader/loader for the subset our exporter emits.
// Avoids pulling in a full YAML lib.

import fs from 'node:fs'
import path from 'node:path'
import { TRACKS_DIR } from './paths.js'

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

function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Find the track YAML for a given (track, config, mean_line_guid). Single
// resolver shared by the Tracks editor, the Analysis page, and the brief
// generator so a save in one place is picked up by the others. Strategy:
//   1. Scan tracks/*.yaml and match by mean_line_guid (most reliable — the
//      Tracks editor writes this on save and any auto-generated file will
//      have stamped it from the .pb decode).
//   2. Fall back to matching by track_configuration_name + track_name.
//   3. Synthesize a path: `<track-alias>-<config-slug>.yaml` under tracks/.
export function resolveTrackYamlPath(
  trackName: string,
  configName: string,
  meanLineGuid: string | null,
): { path: string; exists: boolean } {
  if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR, { recursive: true })
  const yamls = fs.readdirSync(TRACKS_DIR).filter(n => n.toLowerCase().endsWith('.yaml'))

  if (meanLineGuid) {
    for (const fn of yamls) {
      const p = path.join(TRACKS_DIR, fn)
      const y = loadTrackYaml(p)
      if (y.mean_line_guid === meanLineGuid) return { path: p, exists: true }
    }
  }
  for (const fn of yamls) {
    const p = path.join(TRACKS_DIR, fn)
    const y = loadTrackYaml(p)
    if (y.track_configuration_name === configName && (!trackName || y.track_name === trackName)) {
      return { path: p, exists: true }
    }
  }
  const alias = slugify(trackName).split('-')[0] || slugify(trackName) || 'track'
  return { path: path.join(TRACKS_DIR, `${alias}-${slugify(configName)}.yaml`), exists: false }
}

// Rewrite the `corners:` section of an existing track YAML in place, leaving
// everything before it (track metadata, segments, comments) verbatim. Our
// convention keeps corners as the last block — we drop from `corners:` to EOF
// and append the new block.
export function saveTrackYamlCorners(filePath: string, corners: TrackCorner[]): void {
  const sorted = [...corners].sort((a, b) => (a.apex_idx ?? 0) - (b.apex_idx ?? 0))
  const block = 'corners:\n' + sorted.map(serializeCorner).join('\n') + '\n'

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Track configuration (created by Tracks editor)\n${block}`)
    return
  }
  const text = fs.readFileSync(filePath, 'utf-8')
  const lines = text.split('\n')
  const cornersIdx = lines.findIndex(l => l.trim() === 'corners:')
  if (cornersIdx === -1) {
    const sep = text.endsWith('\n') ? '' : '\n'
    fs.writeFileSync(filePath, text + sep + block)
    return
  }
  const head = lines.slice(0, cornersIdx).join('\n')
  const headSep = head.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(filePath, head + headSep + block)
}

function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function serializeCorner(c: TrackCorner): string {
  const lines: string[] = []
  lines.push(`  - turn: ${c.turn}`)
  if (c.name) lines.push(`    name: "${escapeYamlString(c.name)}"`)
  if (c.direction) lines.push(`    direction: ${c.direction}`)
  if (c.character) lines.push(`    character: "${escapeYamlString(c.character)}"`)
  if (c.apex_idx != null) lines.push(`    apex_idx: ${Math.round(c.apex_idx)}`)
  if (c.dist_idx_start != null) lines.push(`    dist_idx_start: ${Math.round(c.dist_idx_start)}`)
  if (c.dist_idx_end != null) lines.push(`    dist_idx_end: ${Math.round(c.dist_idx_end)}`)
  if (c.apex_lat != null) lines.push(`    apex_lat: ${c.apex_lat.toFixed(7)}`)
  if (c.apex_lon != null) lines.push(`    apex_lon: ${c.apex_lon.toFixed(7)}`)
  if (c.apex_radius_m != null) lines.push(`    apex_radius_m: ${c.apex_radius_m}`)
  return lines.join('\n')
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
