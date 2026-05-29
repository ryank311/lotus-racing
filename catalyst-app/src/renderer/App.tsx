import { useEffect, useState, useCallback } from 'react'
import { Sidebar, NavKey } from './components/Sidebar'
import { Home } from './pages/Home'
import { Sessions } from './pages/Sessions'
import { Briefs } from './pages/Briefs'
import { Garage } from './pages/Garage'
import { api } from './api'
import type { AuthState, SyncStats, WorkerEvent } from '../shared/types'

export function App() {
  const [page, setPage] = useState<NavKey>('home')
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [stats, setStats] = useState<SyncStats | null>(null)
  const [logLine, setLogLine] = useState('')
  const [busy, setBusy] = useState<'sync' | 'load' | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([api.getAuthState(), api.getSyncStats()])
    setAuth(a)
    setStats(s)
  }, [])

  useEffect(() => {
    refresh()
    const unsub = api.onWorker((evt: WorkerEvent) => {
      if (evt.type === 'log' && evt.payload) setLogLine(evt.payload)
      if (evt.type === 'done') {
        setBusy(null)
        setLogLine(`${evt.kind} complete`)
        refresh()
        setRefreshTick(t => t + 1)
        if (evt.kind === 'sync') {
          // Auto-trigger DB reload after sync completes.
          setBusy('load')
          api.startLoad()
        }
      }
      if (evt.type === 'error') {
        setBusy(null)
        setLogLine(`error: ${evt.payload}`)
      }
    })
    return () => { unsub() }
  }, [refresh])

  const startSync = async () => {
    if (busy) return
    setBusy('sync')
    setLogLine('starting sync...')
    try {
      await api.startSync()
    } catch (e: any) {
      setBusy(null)
      setLogLine(`error: ${e.message ?? e}`)
    }
  }

  const startLoad = async () => {
    if (busy) return
    setBusy('load')
    setLogLine('loading database...')
    try {
      await api.startLoad()
    } catch (e: any) {
      setBusy(null)
      setLogLine(`error: ${e.message ?? e}`)
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        active={page}
        onChange={setPage}
        connected={!!auth?.tokenValid}
      />
      <div className="main-pane">
        {page === 'home' && (
          <Home auth={auth} stats={stats} busy={busy} onSync={startSync} onLoad={startLoad} />
        )}
        {page === 'sessions' && <Sessions refreshTick={refreshTick} />}
        {page === 'briefs' && <Briefs onRefresh={() => setRefreshTick(t => t + 1)} refreshTick={refreshTick} />}
        {page === 'garage' && <Garage />}

        <div className={`status-bar ${busy ? 'busy' : ''}`}>
          {busy && <div className="spinner" />}
          <div className="log">{logLine || 'ready'}</div>
          <div className="tag">
            {auth?.tokenValid ? `TOKEN · ${auth.tokenDaysRemaining}D` : 'NO TOKEN'}
          </div>
        </div>
      </div>
    </div>
  )
}
