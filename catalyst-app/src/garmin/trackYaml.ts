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
