import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { Link, useBlocker, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { matchRoute, MAX_ROUTE_LENGTH, normalizeRoute, safeReturnTo } from './routes'
import { NavigationContext as Context, type NavigationGuard as Guard, type NavigationOptions as Options } from './navigationContext'

const bootstrap = new URLSearchParams(window.location.search)
const transportKeys = ['remote', 'catalystServer', 'desktopDriver']
export function withTransport(url: string): string {
  if (window.location.protocol === 'file:') return url
  const [path, query] = url.split('?'), params = new URLSearchParams(query)
  for (const key of transportKeys) if (bootstrap.has(key)) params.set(key, bootstrap.get(key)!)
  return path + (params.size ? '?' + params : '')
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const location = useLocation(), navigate = useNavigate()
  const guard = useRef<Guard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const g = guard.current
    return !!g?.dirty && g.scope(currentLocation.pathname + currentLocation.search) !== g.scope(nextLocation.pathname + nextLocation.search)
  })
  const current = useRef(location)
  current.current = location
  const go = useCallback((url: string, options: Options = {}) => {
    const destination = withTransport(url)
    if (destination.length > MAX_ROUTE_LENGTH) { setError('This selection is too large for a link. Select fewer sessions.'); return }
    const loc = current.current
    const same = destination === loc.pathname + loc.search
    if (same && !options.state) { if (loc.state?.overlay) void navigate(-1); return }
    setError(null)
    void navigate(destination, {
      replace: options.replace ?? !!loc.state?.overlay,
      state: { ...(options.replace ? loc.state : {}),
        ...(options.replace ? { scrollKey: loc.state?.scrollKey ?? loc.key } : { from: loc.pathname + loc.search, fromKey: loc.key }),
        overlay: undefined, ...options.state },
    })
  }, [navigate])
  const query = useCallback((values: Record<string, string | string[] | null>) => {
    const loc = current.current, params = new URLSearchParams(loc.search)
    for (const [key, value] of Object.entries(values)) {
      params.delete(key)
      for (const item of Array.isArray(value) ? [...new Set(value)].sort() : [value]) if (item != null && item !== '') params.append(key, item)
    }
    const normalized = normalizeRoute(loc.pathname, '?' + params)
    if (normalized.error) { setError(normalized.error); return }
    go(normalized.url, { replace: true })
  }, [go])
  useEffect(() => {
    const normalized = normalizeRoute(location.pathname, location.search)
    if (normalized.error) { setError(normalized.error); return }
    if (normalized.url !== location.pathname + location.search) go(normalized.url, { replace: true })
    if (location.pathname === '/sessions') {
      try { sessionStorage.setItem('catalyst:last-sessions', location.pathname + location.search) } catch { /* optional */ }
    }
    const route = matchRoute(location.pathname)
    document.title = `${route.page === 'home' ? 'Overview' : route.page === 'not-found' ? 'Page not found' : route.page[0].toUpperCase() + route.page.slice(1)}${route.id ? ' · ' + route.id : ''} · Catalyst Coach`
  }, [location.pathname, location.search, go])
  const clearWorkspace = useCallback(() => {
    snapshots.clear()
    try { sessionStorage.removeItem('catalyst:last-sessions'); sessionStorage.removeItem('catalyst:scroll') } catch { /* optional */ }
  }, [])
  const lastSessions = useCallback(() => {
    try { const url = sessionStorage.getItem('catalyst:last-sessions'); return url?.startsWith('/sessions?') || url === '/sessions' ? safeReturnTo(url) : '/sessions' } catch { return '/sessions' }
  }, [])
  return <Context.Provider value={{ go, query, guard, error, clearWorkspace, lastSessions }}>
    <ScrollRestoration />
    {children}
    {error && <div className="navigation-error" role="alert">{error}<button className="btn ghost" onClick={() => setError(null)}>Dismiss</button></div>}
    {blocker.state === 'blocked' && <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" onKeyDown={event => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); blocker.reset() }
      if (event.key === 'Tab') {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div className="modal-card">
        <h2 id="unsaved-title">Unsaved changes</h2><p>Save your changes before leaving?</p>
        <div className="modal-actions">
          <button className="btn ghost" disabled={saving} autoFocus onClick={() => blocker.reset()}>Cancel</button>
          <button className="btn ghost" disabled={saving} onClick={() => blocker.proceed()}>Discard</button>
          <button className="btn primary" disabled={saving} onClick={async () => {
            setSaving(true)
            try { if (await guard.current?.save()) blocker.proceed(); else setError('Could not save. Your changes are still here; cancel to review the error or try again.') }
            catch (e) { setError(String(e)) }
            finally { setSaving(false) }
          }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>}
  </Context.Provider>
}

export function useNavigation() {
  const context = useContext(Context)
  if (!context) throw new Error('NavigationProvider required')
  return context
}
export function useRoute() {
  const location = useLocation()
  const params = useMemo(() => new URLSearchParams(normalizeRoute(location.pathname, location.search).url.split('?')[1]), [location.pathname, location.search])
  return { ...matchRoute(location.pathname), location, params }
}
export function NavLink({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { go } = useNavigation()
  return <Link {...props} to={withTransport(to)} onClick={event => {
    onClick?.(event)
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && (!props.target || props.target === '_self')) {
      event.preventDefault(); go(to)
    }
  }} />
}
export function useDebouncedQuery(key: string, value: string) {
  const { query } = useNavigation(), { location } = useRoute()
  const [draft, setDraft] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { clearTimeout(timer.current); setDraft(value) }, [value, location.key])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [draft, (next: string) => { setDraft(next); clearTimeout(timer.current); timer.current = setTimeout(() => query({ [key]: next }), 250) }] as const
}
export function useUnsavedChanges(dirty: boolean, save: () => Promise<boolean>, scope: (url: string) => string = url => url.split('?')[0]) {
  const { guard } = useNavigation()
  useLayoutEffect(() => { guard.current = { dirty, save, scope }; return () => { guard.current = null } }, [dirty, save, scope, guard])
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
}

// Overlay state lives in owned, same-URL history entries. A reload drops the
// marker; Forward cannot reopen a dialog after its component has unmounted.
export function useOverlay(name: string): [boolean, (open: boolean | ((old: boolean) => boolean)) => void] {
  const context = useContext(Context)
  const [fallback, setFallback] = useState(false)
  return context ? useRoutedOverlay(name) : [fallback, setFallback]
}
function useRoutedOverlay(name: string): [boolean, (open: boolean | ((old: boolean) => boolean)) => void] {
  const location = useLocation(), navigate = useNavigate()
  const current = useRef(location)
  current.current = location
  const open = location.state?.overlay === name
  const set = useCallback((value: boolean | ((old: boolean) => boolean)) => {
    const location = current.current
    const open = location.state?.overlay === name
    const next = typeof value === 'function' ? value(open) : value
    if (next === open) return
    if (next) void navigate(location.pathname + location.search, { state: { ...location.state, overlay: name, scrollKey: location.state?.scrollKey ?? location.key } })
    else if (open) void navigate(-1)
  }, [navigate, name])
  return [open, set]
}

type Snapshot = { positions: Record<string, [number, number]>; focus?: string }
const snapshots = new Map<string, Snapshot>()
const paneSelector = '.page-body, .analysis-charts, .analysis-map, .viewer-pane, .garage-detail, .garage-editor, .logs-list, .coach-session-viewer, .tracks-corner-list'
function panes() { return Array.from(document.querySelectorAll<HTMLElement>(paneSelector)) }
function ScrollRestoration() {
  const location = useLocation(), action = useNavigationType()
  const key = location.state?.scrollKey ?? location.key
  useLayoutEffect(() => {
    let snapshot = snapshots.get(key)
    if (!snapshot) try { snapshot = JSON.parse(sessionStorage.getItem('catalyst:scroll') ?? '{}')[key] } catch { /* optional */ }
    let restoring = action === 'POP' && !!snapshot
    const capture = () => {
      if (restoring) return
      const positions: Snapshot['positions'] = {}
      panes().forEach((el, i) => { positions[i] = [el.scrollLeft, el.scrollTop] })
      const active = document.activeElement
      snapshots.set(key, { positions, focus: active?.id ? '#' + CSS.escape(active.id) : active?.getAttribute('aria-label') ? `[aria-label=${JSON.stringify(active.getAttribute('aria-label'))}]` : undefined })
      try { sessionStorage.setItem('catalyst:scroll', JSON.stringify(Object.fromEntries([...snapshots].slice(-50)))) } catch { /* optional */ }
    }
    let focused = false
    const resetPanes = new WeakSet<HTMLElement>()
    const restore = () => {
      const elements = panes()
      if (!elements.length || document.querySelector('[data-route-loading]')) return
      if (restoring && snapshot) {
        elements.forEach((el, i) => { const pos = snapshot!.positions[i]; if (pos) { el.scrollLeft = pos[0]; el.scrollTop = pos[1] } })
        if (snapshot.focus) document.querySelector<HTMLElement>(snapshot.focus)?.focus({ preventScroll: true })
      } else if (action !== 'REPLACE') {
        elements.forEach(el => { if (!resetPanes.has(el)) { el.scrollTop = 0; el.scrollLeft = 0; resetPanes.add(el) } })
        const title = document.querySelector<HTMLElement>('.page-title, h1')
        if (title && !focused) { title.tabIndex = -1; title.focus({ preventScroll: true }); focused = true }
      }
    }
    restore()
    const observer = new MutationObserver(restore)
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    const timeout = setTimeout(() => { restoring = false; observer.disconnect() }, 5000)
    const stopRestoring = () => { restoring = false; observer.disconnect() }
    document.addEventListener('scroll', capture, true)
    document.addEventListener('focusin', capture)
    document.addEventListener('pointerdown', stopRestoring, { once: true })
    document.addEventListener('wheel', stopRestoring, { once: true })
    return () => {
      clearTimeout(timeout); observer.disconnect()
      document.removeEventListener('scroll', capture, true); document.removeEventListener('focusin', capture)
      document.removeEventListener('pointerdown', stopRestoring); document.removeEventListener('wheel', stopRestoring)
    }
  }, [key])
  return null
}
