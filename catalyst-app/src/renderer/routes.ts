import type { CoachingSession } from '../shared/types'
import { coachingLapFilter } from '../shared/coachingScope'
import { compareParams, isCompareParam } from '../shared/comparison'
import { isReplayGhostParam } from '../shared/replay'

export type Page = 'home' | 'sessions' | 'review' | 'progress' | 'analysis' | 'replay' | 'coach' | 'garage' | 'tracks' | 'import' | 'account' | 'logs' | 'sign-in' | 'not-found'
export const paths = { home: '/overview', sessions: '/sessions', review: '/review', progress: '/progress', analysis: '/analysis', replay: '/replay', coach: '/coach', garage: '/garage', tracks: '/tracks', import: '/import', account: '/account', logs: '/logs' } as const
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
    if (['coach', 'garage', 'tracks', 'review', 'replay'].includes(page) && parts.length === 2) return { page, id: parts[1] }
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
  // A report that compared other drivers reopens with them.
  const compare = compareParams(report.parsed_result?.context?.comparisons ?? [])
  return routeUrl('/analysis', { session: report.session_guids, report: report.id, laps: coachingLapFilter(report), compare })
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
  sort: [['date', 'track', 'config', 'vehicle', 'best', 'laps', 'weather', 'video'], 'date'],
  dir: [['asc', 'desc'], 'desc'], laps: [['top10', 'top5', 'top3', 'session-best', 'top3-session'], 'top10'],
  view: [['charts', 'map'], 'charts'], follow: [['0', '1'], '1'],
}
// Pages that give a shared param name other values.
const pageEnums: Partial<Record<Page, Record<string, [string[], string]>>> = {
  // No default to drop: chasing is the default alone, both cars racing another driver (Replay.tsx).
  replay: { view: [['chase', 'driver', 'garmin', 'both'], ''] },
  // A selected car's panel: its 3D model (the default) or its context files.
  garage: { tab: [['model', 'files'], 'model'] },
}
// A lap index or Garmin's optimal lap; a ghost is <session guid>:<lap>,
// another driver's driver:<name>:<session guid>:<lap>, or none (isReplayGhostParam).
const REPLAY_LAP = /^(\d{1,4}|optimal)$/
// The Garage selects a car by its make and model ("LOTUS EXIGE"), e.g. from the replay.
const isVehicleKey = (value: string) => value.length <= 80 && value === value.trim() && !/[\u0000-\u001f/\\]/.test(value)
export function normalizeRoute(pathname: string, search: string): { url: string; error?: string } {
  const route = matchRoute(pathname)
  const path = pathname === '/' ? '/overview' : pathname.replace(/\/$/, '')
  if (route.page === 'not-found') return { url: pathname + search }
  const allowed: Partial<Record<Page, string[]>> = {
    progress: ['anchor', 'surface', 'temp'],
    sessions: ['q', 'vehicle', 'track', 'sort', 'dir', 'selected'], analysis: ['session', 'laps', 'view', 'report', 'focus', 'compare'],
    coach: ['session'], tracks: ['track', 'turn'], replay: ['lap', 'ghost', 'view'], logs: ['q', 'level', 'follow'], 'sign-in': ['returnTo'],
    garage: ['tab', 'vehicle'],
  }
  const input = new URLSearchParams(search), output = new URLSearchParams()
  let error: string | undefined
  for (const key of [...(allowed[route.page] ?? []), 'remote', 'catalystServer', 'desktopDriver']) {
    let values = input.getAll(key)
    if (!values.length) continue
    if (['session', 'selected', 'level', 'compare'].includes(key)) values = [...new Set(values)].sort()
    else values = values.slice(0, 1)
    for (const value of values) {
      if (!value) continue
      if (key === 'surface' && !['any', 'dry', 'damp', 'wet', 'mixed', 'unknown'].includes(value)) { error = 'Invalid surface.'; continue }
      if (key === 'focus' && !/^[A-Za-z0-9-]{1,16}$/.test(value)) { error = 'Invalid corner.'; continue }
      // <driver>:<session guid>; driver names may contain spaces.
      if (key === 'compare' && !isCompareParam(value)) { error = 'Invalid driver comparison.'; continue }
      if (key === 'temp' && (!Number.isFinite(Number(value)) || Number(value) < -60 || Number(value) > 70)) { error = 'Invalid temperature.'; continue }
      if (key === 'anchor' && !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) { error = 'Invalid session identifier.'; continue }
      if (key === 'lap' && !REPLAY_LAP.test(value)) { error = 'Invalid lap.'; continue }
      if (key === 'ghost' && !isReplayGhostParam(value)) { error = 'Invalid ghost lap.'; continue }
      if (key === 'vehicle' && route.page === 'garage' && !isVehicleKey(value)) { error = 'Invalid vehicle.'; continue }
      const choices = pageEnums[route.page]?.[key] ?? enums[key]
      if (choices) {
        if (!choices[0].includes(value)) { error = `Invalid ${key} value.`; continue }
        if (value === choices[1]) continue
      }
      if (key === 'level' && !['log', 'info', 'warn', 'error', 'none'].includes(value)) { error = 'Invalid log level.'; continue }
      // Sessions filters by layout key; the Tracks page uses circuit names, which contain spaces.
      const identifier = ['session', 'selected', 'report'].includes(key) || (key === 'vehicle' && route.page !== 'garage') || (key === 'track' && route.page === 'sessions')
      if (identifier && (value.length > 200 || /[\s/\\\u0000-\u001f]/.test(value))) { error = `Invalid ${key} identifier.`; continue }
      output.append(key, key === 'returnTo' ? safeReturnTo(value) : value)
    }
  }
  const url = path + (output.size ? '?' + output.toString() : '')
  if (url.length > MAX_ROUTE_LENGTH) error = 'This selection is too large for a link. Select fewer sessions.'
  return { url, error }
}
