import type { CoachingResult } from './types.js'

export type SessionAliasMap = Record<string, string>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function humanSessionLabel(start: string | null | undefined, fallbackIndex: number): string {
  const match = String(start ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/)
  if (!match) return `Selected session ${fallbackIndex + 1}`
  const [, year, month, day, hour, minute] = match
  const date = `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`
  return hour && minute ? `${date} ${hour}:${minute}` : date
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The model may use session GUIDs as stable join keys while reasoning, but
// those database identifiers should never become user-facing prose. Replace
// both full GUIDs and the common eight-character shorthand.
export function replaceSessionIds(text: string, aliases: SessionAliasMap): string {
  let safe = text
  for (const [guid, label] of Object.entries(aliases).sort(([a], [b]) => b.length - a.length)) {
    safe = safe.replace(new RegExp(escapeRegExp(guid), 'gi'), label)
    const short = guid.slice(0, 8)
    if (short.length === 8) {
      safe = safe.replace(new RegExp(`\\b${escapeRegExp(short)}(?:…|\\.\\.\\.)?`, 'gi'), label)
    }
  }
  // Defensive fallback for an unexpected full UUID not present in the alias
  // map. It is better to show a generic label than leak an internal ID.
  return safe.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'selected session')
}

export function sanitizeCoachingResult(result: CoachingResult, aliases: SessionAliasMap): CoachingResult {
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceSessionIds(value, aliases)
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]))
    }
    return value
  }
  return scrub(result) as CoachingResult
}
