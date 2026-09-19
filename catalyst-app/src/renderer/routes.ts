import type { CoachingSession } from '../shared/types'
import { coachingLapFilter } from '../shared/coachingScope'

export type Page = 'home' | 'sessions' | 'review' | 'progress' | 'analysis' | 'coach' | 'garage' | 'tracks' | 'account' | 'logs' | 'sign-in' | 'not-found'
export const paths = { home: '/overview', sessions: '/sessions', review: '/review', progress: '/progress', analysis: '/analysis', coach: '/coach', garage: '/garage', tracks: '/tracks', account: '/account', logs: '/logs' } as const
export const MAX_ROUTE_LENGTH = 16000
export const segment = (value: string) => encodeURIComponent(value)
export function matchRoute(pathname: string): { page: Page; id?: string; fileId?: string } {
  try {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.some(p => !p || /[\u0000-\u001f/\\]/.test(p))) return { page: 'not-found' }
    if (!parts.length) return { page: 'home' }
    const page = Object.entries(paths).find(([, path]) => path === '/' + parts[0])?.[0] as Page | undefined
    if (parts[0] === 'sign-in' && parts.length === 1) return { page: 'sign-in' }
    if (!page) return { page: 'not-found' }
    if (parts.length === 1) return { page }
    if (['coach', 'garage', 'tracks', 'review'].includes(page) && parts.length === 2) return { page, id: parts[1] }
    if (page === 'garage' && parts.length === 4 && parts[2] === 'files') return { page, id: parts[1], fileId: parts[3] }
    return { page: 'not-found' }
  } catch { return { page: 'not-found' } }
}

export function routeUrl(path: string, values: Record<string, string | string[] | null | undefined> = {}): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? [...new Set(value)].sort() : [value]) {
      if (item != null && item !== '') query.append(key, item)
    }
  }
  return path + (query.size ? '?' + query.toString() : '')
}

export function reportAnalysisUrl(report: CoachingSession): string {
  if (report.review_context) return `/review/${segment(report.review_context.sessionGuid)}`
  return routeUrl('/analysis', { session: report.session_guids, report: report.id, laps: coachingLapFilter(report) })
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value) || value.length > MAX_ROUTE_LENGTH) return '/overview'
  const route = matchRoute(value.split(/[?#]/)[0])
  return ['not-found', 'sign-in'].includes(route.page) ? '/overview' : value
}

// Hex UTF-8 identifiers contain no dots/slashes and work with static fallback
// servers. Resolve them against the authorized profile file list, never a path.
export function fileId(name: string): string {
  return Array.from(new TextEncoder().encode(name), n => n.toString(16).padStart(2, '0')).join('')
}

const enums: Record<string, [string[], string]> = {
  sort: [['date', 'track', 'config', 'vehicle', 'best', 'laps', 'weather'], 'date'],
  dir: [['asc', 'desc'], 'desc'], laps: [['top3', 'top5', 'top10', 'all'], 'top10'],
  view: [['charts', 'map'], 'charts'], follow: [['0', '1'], '1'],
}
export function normalizeRoute(pathname: string, search: string): { url: string; error?: string } {
  const route = matchRoute(pathname)
  const path = pathname === '/' ? '/overview' : pathname.replace(/\/$/, '')
  if (route.page === 'not-found') return { url: pathname + search }
  const allowed: Partial<Record<Page, string[]>> = {
    progress: ['anchor', 'surface', 'temp'],
    sessions: ['q', 'vehicle', 'sort', 'dir', 'selected'], analysis: ['session', 'laps', 'view', 'report'],
    coach: ['session'], tracks: ['track', 'turn'], logs: ['q', 'level', 'follow'], 'sign-in': ['returnTo'],
  }
  const input = new URLSearchParams(search), output = new URLSearchParams()
  let error: string | undefined
  for (const key of [...(allowed[route.page] ?? []), 'remote', 'catalystServer', 'desktopDriver']) {
    let values = input.getAll(key)
    if (!values.length) continue
    if (['session', 'selected', 'level'].includes(key)) values = [...new Set(values)].sort()
    else values = values.slice(0, 1)
    for (const value of values) {
      if (!value) continue
      if (key === 'surface' && !['dry', 'damp', 'wet', 'mixed', 'unknown'].includes(value)) { error = 'Invalid surface.'; continue }
      if (key === 'temp' && (!Number.isFinite(Number(value)) || Number(value) < -60 || Number(value) > 70)) { error = 'Invalid temperature.'; continue }
      if (key === 'anchor' && !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) { error = 'Invalid session identifier.'; continue }
      if (enums[key]) {
        if (!enums[key][0].includes(value)) { error = `Invalid ${key} value.`; continue }
        if (value === enums[key][1]) continue
      }
      if (key === 'level' && !['log', 'info', 'warn', 'error', 'none'].includes(value)) { error = 'Invalid log level.'; continue }
      if (['session', 'selected', 'vehicle', 'report'].includes(key) && (value.length > 200 || /[\s/\\\u0000-\u001f]/.test(value))) { error = `Invalid ${key} identifier.`; continue }
      output.append(key, key === 'returnTo' ? safeReturnTo(value) : value)
    }
  }
  const url = path + (output.size ? '?' + output.toString() : '')
  if (url.length > MAX_ROUTE_LENGTH) error = 'This selection is too large for a link. Select fewer sessions.'
  return { url, error }
}
