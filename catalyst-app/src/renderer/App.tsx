import { useEffect, useState, useCallback } from 'react'
import { Sidebar, NavKey } from './components/Sidebar'
import { Home } from './pages/Home'
import { Sessions } from './pages/Sessions'
import { AICoach } from './pages/AICoach'
import { Garage } from './pages/Garage'
import { Tracks } from './pages/Tracks'
import { Analysis } from './pages/Analysis'
import { ErrorBoundary } from './components/ErrorBoundary'
import { api } from './api'
import { AccountState, getActiveAccount, loadAccounts, tokenValid } from './accounts'
import type { AuthState, SyncStats, WorkerEvent, WorkerProgress, CoachingSession } from '../shared/types'

export function App() {
  const [page, setPage] = useState<NavKey>('home')
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [stats, setStats] = useState<SyncStats | null>(null)
  const [logLine, setLogLine] = useState('')
  const [progress, setProgress] = useState<WorkerProgress | null>(null)
  const [busy, setBusy] = useState<'sync' | 'load' | 'coach' | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [accounts, setAccounts] = useState<AccountState>(() => loadAccounts())
  const [activeCoachSession, setActiveCoachSession] = useState<CoachingSession | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [logsExpanded, setLogsExpanded] = useState(false)

  // Selected session guids — accumulated on the Sessions tab, consumed by Analysis.
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([api.getAuthState(), api.getSyncStats()])
    setAuth(a)
    setStats(s)
  }, [])

  useEffect(() => {
    refresh()
    const unsub = api.onWorker((evt: WorkerEvent) => {
      if (evt.type === 'log' && evt.payload) {
        setLogLine(evt.payload)
        setLogLines(prev => [...prev.slice(-499), evt.payload!])
      }
      if (evt.type === 'progress' && evt.progress) setProgress(evt.progress)
      if (evt.type === 'done') {
        setBusy(null)
        const doneMsg = `${evt.kind} complete${evt.payload ? ` · ${evt.payload.slice(0, 40)}` : ''}`
        setLogLine(doneMsg)
        setLogLines(prev => [...prev.slice(-499), `✓ ${doneMsg}`])
        setProgress(null)
        if (evt.kind !== 'coach') refresh()
        setRefreshTick(t => t + 1)
      }
      if (evt.type === 'error') {
        setBusy(null)
        setProgress(null)
        const errMsg = `error: ${evt.payload}`
        setLogLine(errMsg)
        setLogLines(prev => [...prev.slice(-499), `✗ ${errMsg}`])
      }
    })
    return () => { unsub() }
  }, [refresh])

  const startSync = async () => {
    if (busy) return
    setBusy('sync')
    setLogLine('starting sync...')
    setProgress({ current: 0, total: 0, label: 'Fetching session list…' })
    const active = getActiveAccount(accounts)
    try {
      await api.startSync({
        token: tokenValid(active) ? active!.token : undefined,
        accountLabel: active?.label,
      })
    } catch (e: any) {
      setBusy(null); setLogLine(`error: ${e.message ?? e}`)
    }
  }

  const onAccountsChange = useCallback((next: AccountState) => {
    setAccounts(next)
    setRefreshTick(t => t + 1)
  }, [])

  const startLoad = async () => {
    if (busy) return
    setBusy('load')
    setLogLine('loading database...')
    setProgress({ current: 0, total: 0, label: 'Scanning sessions…' })
    try { await api.startLoad() } catch (e: any) {
      setBusy(null); setLogLine(`error: ${e.message ?? e}`)
    }
  }

  const openAnalysis = () => setPage('analysis')

  // Load a coaching session into the Analysis tab.
  const loadCoachSession = (session: CoachingSession) => {
    setSelected(new Set(session.session_guids))
    setActiveCoachSession(session)
    setPage('analysis')
  }

  return (
    <div className="app-shell">
      <Sidebar
        active={page}
        onChange={setPage}
        connected={!!auth?.tokenValid}
        selectionCount={selected.size}
      />
      <div className="main-pane">
        <ErrorBoundary label={`${page} page`} resetKey={page}>
          {page === 'home' && (
            <Home
              auth={auth} stats={stats} busy={busy}
              onSync={startSync} onLoad={startLoad}
              accounts={accounts} onAccountsChange={onAccountsChange}
            />
          )}
          {page === 'sessions' && (
            <Sessions
              refreshTick={refreshTick}
              selected={selected}
              setSelected={setSelected}
              onAnalyze={openAnalysis}
              activeAccount={accounts.activeLabel}
            />
          )}
          {page === 'coach' && (
            <AICoach
              refreshTick={refreshTick}
              selected={selected}
              busy={busy}
              setBusy={setBusy}
              onLoadSession={loadCoachSession}
            />
          )}
          {page === 'garage' && <Garage />}
          {page === 'tracks' && <Tracks />}
          {page === 'analysis' && (
            <Analysis
              selected={selected}
              setSelected={setSelected}
              onBack={() => setPage('sessions')}
              activeCoachSession={activeCoachSession}
              onClearCoachSession={() => setActiveCoachSession(null)}
              busy={busy}
              setBusy={setBusy}
            />
          )}
        </ErrorBoundary>

        {/* Status bar — click to expand full log panel */}
        <div
          className={`status-bar ${busy ? 'busy' : ''}`}
          style={{ display: busy ? undefined : 'none', cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: 0 }}
          onClick={() => setLogsExpanded(e => !e)}
        >
          {/* Collapsed row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', minHeight: 40 }}>
            {busy && <div className="spinner" />}
            {progress && progress.total > 0 ? (
              <div className="sync-progress" style={{ flex: 1 }}>
                <div className="sync-progress-row">
                  <span className="sync-progress-counter">{progress.current}/{progress.total}</span>
                  <span className="sync-progress-log">
                    {(logLine || progress.label).replace(/^\[\d+\/\d+\]\s*/, '')}
                  </span>
                  {progress.fileName && (
                    <span className="sync-progress-file">→ {progress.fileName}</span>
                  )}
                  <span className="sync-progress-pct">
                    {Math.round((progress.current / progress.total) * 100)}%
                  </span>
                </div>
                <div className="sync-progress-track">
                  <div className="sync-progress-fill" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
                </div>
              </div>
            ) : (
              <div className="log" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {logLine || 'working…'}
              </div>
            )}
            <div className="tag" style={{ flexShrink: 0 }}>
              {auth?.tokenValid ? `TOKEN · ${auth.tokenDaysRemaining}D` : 'NO TOKEN'}
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-mute)', flexShrink: 0 }}>
              {logsExpanded ? '▼ logs' : '▲ logs'}
            </span>
          </div>

          {/* Expanded log panel */}
          {logsExpanded && (
            <div
              onClick={e => e.stopPropagation()}
              style={{
                borderTop: '1px solid var(--border)',
                background: 'var(--bg)',
                maxHeight: 260,
                overflowY: 'auto',
                padding: '8px 16px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-mute)',
                lineHeight: 1.5,
              }}
            >
              {logLines.length === 0
                ? <span style={{ opacity: 0.4 }}>No log output yet.</span>
                : logLines.map((l, i) => (
                    <div key={i} style={{
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      color: l.startsWith('✗') ? 'var(--red)'
                           : l.startsWith('✓') ? 'var(--green)'
                           : l.startsWith('[stderr]') ? 'var(--amber)'
                           : l.startsWith('[harness]') || l.startsWith('[diag]') || l.startsWith('[fallback]') ? 'var(--cyan)'
                           : 'var(--text-mute)',
                    }}>{l}</div>
                  ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
