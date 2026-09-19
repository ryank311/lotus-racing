import { lazy, Suspense, useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { NavLink, useNavigation, useOverlay, useRoute } from './navigation'
import { paths, reportAnalysisUrl, routeUrl } from './routes'
import { Sidebar, NavKey } from './components/Sidebar'
import { Home } from './pages/Home'
import { createActivityStore, type LogEntry } from './activityStore'
import { StatusBar } from './components/StatusBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Modal } from './components/Modal'
import { LoginModal } from './components/LoginModal'
import { SignedOutGate } from './components/SignedOutGate'
import { SignedOutBanner } from './components/SignedOutBanner'
import { api, isRemote } from './api'
import { AccountState, getActiveAccount, loadAccounts, removeAccount, tokenValid, upsertAccount } from './accounts'
import type { AuthState, SyncStats, WorkerEvent, CoachingSession, SyncOptions } from '../shared/types'

const Sessions = lazy(() => import('./pages/Sessions').then(module => ({ default: module.Sessions })))
const SessionReview = lazy(() => import('./pages/SessionReview').then(module => ({ default: module.SessionReview })))
const Progress = lazy(() => import('./pages/Progress').then(module => ({ default: module.Progress })))
const AICoach = lazy(() => import('./pages/AICoach').then(module => ({ default: module.AICoach })))
const Garage = lazy(() => import('./pages/Garage').then(module => ({ default: module.Garage })))
const Tracks = lazy(() => import('./pages/Tracks').then(module => ({ default: module.Tracks })))
const Analysis = lazy(() => import('./pages/Analysis').then(module => ({ default: module.Analysis })))
const Account = lazy(() => import('./pages/Account').then(module => ({ default: module.Account })))
const Logs = lazy(() => import('./pages/Logs').then(module => ({ default: module.Logs })))

function PageLoading() {
  return <div className="page-body" data-route-loading role="status" aria-live="polite">Loading page…</div>
}

function CoachToast({ onView, onDismiss }: { onView: () => void; onDismiss: () => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, 8000)
    return () => clearTimeout(timerRef.current)
  }, [onDismiss])

  return (
    <div className="coach-toast">
      <span className="coach-toast-icon">✦</span>
      <div className="coach-toast-body">
        <div className="coach-toast-title">Coach analysis ready</div>
        <div className="coach-toast-sub">Your coaching report is ready to view</div>
      </div>
      <button className="coach-toast-view" onClick={onView}>View</button>
      <button className="coach-toast-close" onClick={onDismiss}>×</button>
    </div>
  )
}

export function App() {
  const [{ addLogEntry, logStore, statusStore }] = useState(createActivityStore)
  const { page, params, location } = useRoute()
  const { go, query, lastSessions } = useNavigation()
  const navigate = useNavigate()
  const selectionKey = JSON.stringify(params.getAll(page === 'sessions' ? 'selected' : 'session').sort())
  const selected = useMemo(() => new Set<string>(JSON.parse(selectionKey)), [selectionKey])
  const setSelected = (next: Set<string>) => query({ [page === 'sessions' ? 'selected' : 'session']: [...next], ...(page === 'analysis' ? { report: null } : {}) })
  const destination = (key: NavKey) => key === 'sessions' ? lastSessions() : ['analysis', 'coach'].includes(key) ? routeUrl(paths[key], { session: [...selected] }) : paths[key]
  const setPage = (key: NavKey) => go(destination(key))
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [stats, setStats] = useState<SyncStats | null>(null)
  const [busy, setBusy] = useState<'sync' | 'load' | 'coach' | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [accounts, setAccounts] = useState<AccountState>(() => isRemote
    ? { accounts: [], activeLabel: null }
    : loadAccounts())
  const [activeCoachSession, setActiveCoachSession] = useState<CoachingSession | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const reportId = page === 'analysis' ? params.get('report') : null
  useEffect(() => {
    let cancelled = false
    setActiveCoachSession(null); setReportError(null); setReportLoading(!!reportId)
    if (reportId) void api.getCoachSession(reportId).then(report => {
      if (cancelled) return
      if (!report) { setReportError('This coaching report is unavailable.'); return }
      setActiveCoachSession(report)
      // The saved report is authoritative when opening a direct report link.
      go(reportAnalysisUrl(report), { replace: true })
    }).catch(e => { if (!cancelled) setReportError(String(e)) }).finally(() => { if (!cancelled) setReportLoading(false) })
    return () => { cancelled = true }
  }, [reportId, go])
  const [coachToast, setCoachToast] = useState<{ sessionId: string } | null>(null)


  const refresh = useCallback(async () => {
    const [a, s, email] = await Promise.all([
      api.getAuthState(),
      api.getSyncStats(),
      isRemote ? api.getAccountEmail() : Promise.resolve(null),
    ])
    setAuth(a)
    setStats(s)
    if (isRemote) {
      const label = email ?? 'Garmin SSO'
      setAccounts(label && a.tokenExpiresAt ? {
        accounts: [{ label, token: '', expiresAt: a.tokenExpiresAt, addedAt: Date.now() }],
        activeLabel: label,
      } : { accounts: [], activeLabel: null })
    }
  }, [])

  // Intercept renderer console → log entries
  useEffect(() => {
    const methods = ['log', 'warn', 'error', 'info'] as const
    const originals = methods.map(m => console[m].bind(console))
    methods.forEach((m, i) => {
      console[m] = (...args: unknown[]) => {
        originals[i](...args)
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
        addLogEntry(m, 'main', msg)
      }
    })
    return () => { methods.forEach((m, i) => { console[m] = originals[i] }) }
  }, [addLogEntry])

  // Receive main-process console logs forwarded over IPC
  useEffect(() => {
    const unsub = api.onLog(({ level, message }) => {
      addLogEntry(level as LogEntry['level'], 'main', message)
    })
    return () => unsub()
  }, [addLogEntry])

  useEffect(() => {
    refresh()
    const unsub = api.onWorker((evt: WorkerEvent) => {
      if (evt.type === 'log' && evt.payload) {
        statusStore.setLogLine(evt.payload)
        statusStore.appendLine(evt.payload)
        addLogEntry(
          evt.payload.startsWith('[error]') || evt.payload.startsWith('✗') ? 'error'
            : evt.payload.startsWith('[diag]') || evt.payload.startsWith('[harness]') ? 'info'
            : 'log',
          'worker', evt.payload,
        )
      }
      if (evt.type === 'progress' && evt.progress) {
        setBusy(evt.kind === 'sync' ? 'sync' : evt.kind === 'coach' ? 'coach' : 'load')
        statusStore.setProgress(evt.progress)
      }
      if (evt.type === 'catalog') { void refresh(); setRefreshTick(t => t + 1) }
      if (evt.type === 'done') {
        setBusy(null)
        const doneMsg = `${evt.kind} complete${evt.payload ? ` · ${evt.payload.slice(0, 40)}` : ''}`
        statusStore.setLogLine(doneMsg)
        statusStore.appendLine(`✓ ${doneMsg}`)
        statusStore.setProgress(null)
        if (evt.kind === 'coach' && evt.payload) {
          setCoachToast({ sessionId: evt.payload })
        } else {
          refresh()
        }
        setRefreshTick(t => t + 1)
      }
      if (evt.type === 'error') {
        setBusy(null)
        statusStore.setProgress(null)
        const errMsg = `error: ${evt.payload}`
        statusStore.setLogLine(errMsg)
        statusStore.appendLine(`✗ ${errMsg}`)
        if (evt.kind === 'sync') void refresh()
        setRefreshTick(t => t + 1)
      }
    })
    return () => { unsub() }
  }, [refresh, addLogEntry, statusStore])

  const startSync = async (mode: SyncOptions['mode'] = 'recent') => {
    if (busy) return
    setBusy('sync')
    statusStore.setLogLine('starting sync...')
    statusStore.setProgress({ current: 0, total: 0, label: 'Fetching session list…' })
    // Read fresh from storage so an auto-sync right after sign-in picks up the
    // token that was just persisted (React state may not have flushed yet).
    const active = isRemote ? getActiveAccount(accounts) : getActiveAccount()
    try {
      await api.startSync(isRemote ? { mode } : {
        mode,
        token: tokenValid(active) ? active!.token : undefined,
        accountLabel: active?.label,
      })
    } catch (e: any) {
      setBusy(null); statusStore.setLogLine(`error: ${e.message ?? e}`)
    }
  }

  const ensureSessions = useCallback(async (guids: string[]) => {
    const active = isRemote ? null : getActiveAccount()
    try {
      await api.ensureSessions(guids, isRemote ? undefined : {
        token: tokenValid(active) ? active!.token : undefined,
        accountLabel: active?.label,
      })
    } finally {
      await refresh()
      setRefreshTick(t => t + 1)
    }
  }, [refresh, addLogEntry, statusStore])

  const onAccountsChange = useCallback((next: AccountState) => {
    setAccounts(next)
    setRefreshTick(t => t + 1)
  }, [])

  // ── Auth / sign-in modal ────────────────────────────────────────────────
  const signedIn = isRemote
    ? (!!auth?.tokenValid || tokenValid(getActiveAccount(accounts)))
    : tokenValid(getActiveAccount(accounts))
  const activeLabel = getActiveAccount(accounts)?.label ?? null
  // Cached telemetry already in the DB. When present, feature pages stay usable
  // read-only even while signed out (a banner notes sync is unavailable); only a
  // signed-out AND empty DB shows the full sign-in gate.
  const hasData = (stats?.sessionCount ?? 0) > 0
  const canView = signedIn || hasData
  const [loginOpen, setLoginOpen] = useOverlay('garmin-sign-in')
  const [signOutOpen, setSignOutOpen] = useOverlay('sign-out')
  const openLogin = useCallback(() => setLoginOpen(true), [])

  const handleSignedIn = (label: string, token: string, expiresAt: number) => {
    onAccountsChange(isRemote
      ? { accounts: [{ label, token: '', expiresAt, addedAt: Date.now() }], activeLabel: label }
      : upsertAccount(label, token, expiresAt))
    setLoginOpen(false)
    // The sign-in effect syncs once the new account state is available.
    void refresh()
  }

  const confirmSignOut = () => {
    if (activeLabel) onAccountsChange(isRemote
      ? { accounts: [], activeLabel: null }
      : removeAccount(activeLabel))
    setSignOutOpen(false)
    // Leave the Account page once signed out (it requires a session).
    // Keep the account route behind its signed-out gate; closing the dialog
    // consumes its own history entry without racing a second navigation.
    // Also wipe the main-process Garmin/Catalyst tokens so the app is truly
    // signed out everywhere (the cached config token must not keep "LINK" green
    // or let a stale token sync). Refresh auth state afterwards.
    void api.clearTokens().then(refresh).catch(() => {})
  }

  const startLoad = async () => {
    if (busy) return
    setBusy('load')
    statusStore.setLogLine('loading database...')
    statusStore.setProgress({ current: 0, total: 0, label: 'Scanning sessions…' })
    try { await api.startLoad() } catch (e: any) {
      setBusy(null); statusStore.setLogLine(`error: ${e.message ?? e}`)
    }
  }

  const openAnalysis = () => go(routeUrl('/analysis', { session: [...selected] }))
  const sessionsParent = location.state?.from?.startsWith('/sessions') ? location.state.from : routeUrl('/sessions', { selected: [...selected] })
  const backToSessions = () => {
    if (location.state?.from === sessionsParent && location.state?.fromKey) void navigate(-1)
    else go(sessionsParent)
  }

  // Load a coaching session into the Analysis tab.
  const loadCoachSession = (session: CoachingSession) => {
    go(reportAnalysisUrl(session))
  }

  return (
    <div className="app-shell">
      <Sidebar
        active={page === 'not-found' || page === 'sign-in' ? 'home' : page}
        onChange={setPage}
        destination={destination}
        connected={signedIn}
        selectionCount={selected.size}
        signedIn={signedIn}
        email={activeLabel}
        onSignIn={openLogin}
      />
      <div className="main-pane">
        {!signedIn && hasData && <SignedOutBanner onSignIn={openLogin} />}
        <ErrorBoundary label={`${page} page`} resetKey={page}>
          <Suspense fallback={<PageLoading />}>
            {page === 'home' && (
              <Home
                auth={auth} stats={stats} busy={busy}
                signedIn={signedIn}
                onSync={startSync}
                onRequestSignIn={openLogin}
                onSessions={() => setPage('sessions')}
              />
            )}
            {!auth && !stats && !['home', 'tracks', 'logs', 'not-found'].includes(page) ? <PageLoading /> : <>
            {page === 'sessions' && (
              canView ? (
                <Sessions
                  refreshTick={refreshTick}
                  selected={selected}
                  setSelected={setSelected}
                  onAnalyze={openAnalysis}
                  activeAccount={accounts.activeLabel}
                  onEnsureSessions={ensureSessions}
                />
              ) : <SignedOutGate feature="Sessions" onSignIn={openLogin} />
            )}
            {page === 'coach' && (
              canView ? (
                <AICoach
                  refreshTick={refreshTick}
                  selected={selected}
                  busy={busy}
                  setBusy={setBusy}
                  onLoadSession={loadCoachSession}
                />
              ) : <SignedOutGate feature="AI Coach" onSignIn={openLogin} />
            )}
            {page === 'review' && (canView ? <SessionReview refreshTick={refreshTick} busy={busy} /> : <SignedOutGate feature="Session Review" onSignIn={openLogin} />)}
            {page === 'progress' && (canView ? <Progress /> : <SignedOutGate feature="Progress" onSignIn={openLogin} />)}
            {page === 'garage' && (canView ? <Garage /> : <SignedOutGate feature="Garage" onSignIn={openLogin} />)}
            {page === 'tracks' && <Tracks />}
            {page === 'analysis' && (
              canView ? reportLoading || (reportId && !activeCoachSession && !reportError) ? <PageLoading /> : reportError ? <div className="page-body" role="alert">{reportError} <NavLink to={routeUrl('/analysis', { session: [...selected] })}>Open telemetry</NavLink></div> : (
                <Analysis
                  selected={selected}
                  setSelected={setSelected}
                  onBack={backToSessions}
                  activeCoachSession={activeCoachSession}
                  onClearCoachSession={() => query({ report: null })}
                  busy={busy}
                  setBusy={setBusy}
                />
              ) : <SignedOutGate feature="Analysis" onSignIn={openLogin} />
            )}
            {page === 'account' && (
              signedIn
                ? <Account email={activeLabel} auth={auth} onSignOut={() => setSignOutOpen(true)} />
                : <SignedOutGate feature="Account" onSignIn={openLogin} />
            )}

            {/* Logs page — full-height, outside page-body so its own toolbar stays fixed */}
            {page === 'logs' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Logs store={logStore} onLoad={startLoad} busy={busy} />
              </div>
            )}
            {page === 'not-found' && <><header className="page-header"><h1 className="page-title">Page not found</h1></header><div className="page-body"><NavLink to="/overview">Overview</NavLink> · <NavLink to="/sessions">Sessions</NavLink></div></>}
            </>}
          </Suspense>
        </ErrorBoundary>

        {/* Global sign-in modal */}
        {loginOpen && (
          <LoginModal
            initialEmail={activeLabel?.includes('@') ? activeLabel : ''}
            onClose={() => setLoginOpen(false)}
            onSignedIn={handleSignedIn}
          />
        )}

        {/* Sign-out confirmation */}
        {signOutOpen && (
          <Modal
            eyebrow="// account"
            title="Sign out"
            onClose={() => setSignOutOpen(false)}
            actions={<>
              <button className="btn ghost" onClick={() => setSignOutOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={confirmSignOut}>Sign out</button>
            </>}
          >
            Sign out {activeLabel ? <strong style={{ color: 'var(--text)' }}>{activeLabel}</strong> : 'this account'} and
            remove its Garmin token? You'll need to sign in again to sync.
          </Modal>
        )}

        {/* Coach analysis ready toast */}
        {coachToast && (
          <CoachToast
            onView={() => { go(`/coach/${encodeURIComponent(coachToast.sessionId)}`); setCoachToast(null) }}
            onDismiss={() => setCoachToast(null)}
          />
        )}

        <StatusBar store={statusStore} busy={busy} signedIn={signedIn} tokenDaysRemaining={auth?.tokenDaysRemaining ?? 0} />
      </div>
    </div>
  )
}
