import { useEffect, useRef, useState } from 'react'
import { ServerUserSwitcher } from './ServerGate'

export type NavKey = 'home' | 'sessions' | 'analysis' | 'coach' | 'garage' | 'tracks' | 'logs' | 'account'

interface NavSpec {
  key: NavKey
  label: string
  k: string
  icon: JSX.Element
}

const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M3 12L12 3L21 12" />
    <path d="M5 10V21H19V10" />
  </svg>
)
const SessionsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <rect x="3" y="5" width="18" height="14" rx="1" />
    <path d="M3 10H21" /><path d="M9 5V19" />
  </svg>
)
const CoachIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <circle cx="12" cy="8" r="4" />
    <path d="M6 20v-1a6 6 0 0112 0v1" />
    <path d="M12 12v2" /><circle cx="12" cy="15" r="0.8" fill="currentColor" />
  </svg>
)
const GarageIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M3 11V21H21V11L12 4L3 11Z" />
    <path d="M7 21V15H17V21" /><circle cx="9" cy="17" r="0.5" fill="currentColor" />
  </svg>
)
const AnalysisIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M3 20H21" />
    <path d="M5 17V11" /><path d="M10 17V8" /><path d="M15 17V13" /><path d="M20 17V5" />
  </svg>
)
const ResultsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M4 4H20V20H4Z" />
    <path d="M8 9H16" /><path d="M8 13H16" /><path d="M8 17H13" />
  </svg>
)
const TracksIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M5 5C5 12 19 12 19 19" />
    <circle cx="9" cy="9" r="1.4" fill="currentColor" />
    <circle cx="16" cy="14" r="1.4" fill="currentColor" />
  </svg>
)

const NAV: NavSpec[] = [
  { key: 'home',     label: 'Overview',  k: '1', icon: <HomeIcon /> },
  { key: 'sessions', label: 'Sessions',  k: '2', icon: <SessionsIcon /> },
  { key: 'analysis', label: 'Analysis',  k: '3', icon: <AnalysisIcon /> },
  { key: 'coach',    label: 'AI Coach',  k: '4', icon: <CoachIcon /> },
  { key: 'garage',   label: 'Garage',    k: '5', icon: <GarageIcon /> },
  { key: 'tracks',   label: 'Tracks',    k: '6', icon: <TracksIcon /> },
]

const BugIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15">
    <path d="M12 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
    <path d="M12 14v6" />
    <path d="M8 10H4m0 0-1-3m1 3v2" />
    <path d="M16 10h4m0 0 1-3m-1 3v2" />
    <path d="M9 7l-1-3" /><path d="M15 7l1-3" />
    <path d="M8 20H5m11 0h3" />
  </svg>
)

const UserIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <circle cx="12" cy="8" r="4" />
    <path d="M5 21v-1a7 7 0 0 1 14 0v1" />
  </svg>
)

export function Sidebar({ active, onChange, connected, selectionCount = 0, signedIn, email, onSignIn }: {
  active: NavKey
  onChange: (k: NavKey) => void
  connected: boolean
  selectionCount?: number
  signedIn: boolean
  email: string | null
  onSignIn: () => void
}) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [open, setOpen] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const navigate = (key: NavKey) => { onChange(key); setOpen(false) }
  useEffect(() => {
    const query = window.matchMedia('(max-width: 800px)')
    const update = () => { setMobile(query.matches); setOpen(false) }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => { setOpen(false) }, [active])
  useEffect(() => {
    if (!open || !mobile) return
    const main = document.querySelector('.main-pane')
    main?.setAttribute('inert', '')
    const drawer = drawerRef.current!
    const focusables = () => Array.from(drawer.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex="0"]')).filter(el => !el.hasAttribute('disabled'))
    focusables()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      if (event.key === 'Tab') {
        const items = focusables()
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      main?.removeAttribute('inert')
      document.removeEventListener('keydown', onKey)
      toggleRef.current?.focus()
    }
  }, [open, mobile])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) {
        e.preventDefault()
        onChange(NAV[parseInt(e.key, 10) - 1].key)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onChange])

  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <>
    <header className="mobile-topbar">
      <button ref={toggleRef} className="mobile-menu-button" aria-label="Open navigation" aria-expanded={open} aria-controls="workspace-navigation" onClick={() => setOpen(true)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      <span className="brand-title">Catalyst<span className="mobile-brand-slash"> / </span><span className="mobile-page-name">{NAV.find(n => n.key === active)?.label ?? (active === 'logs' ? 'Logs' : 'Account')}</span></span>
      <span className={`led ${connected ? '' : 'dim'}`} title={connected ? 'Connected' : 'Offline'} />
    </header>
    {mobile && open && <div className="mobile-nav-backdrop" onClick={() => setOpen(false)} />}
    <aside ref={drawerRef} id="workspace-navigation" className={`sidebar ${open ? 'is-open' : ''}`} role={mobile && open ? 'dialog' : undefined} aria-modal={mobile && open ? true : undefined} aria-label="Workspace navigation">
      <button className="mobile-nav-close" aria-label="Close navigation" onClick={() => setOpen(false)}>×</button>
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-text">
          <div className="brand-title">Catalyst</div>
          <div className="brand-sub">// telemetry · vir</div>
        </div>
      </div>

      <nav className="nav" aria-label="Main navigation">
        <div className="nav-section-label">Workspace</div>
        {NAV.map(n => (
          <button
            type="button"
            aria-current={active === n.key ? 'page' : undefined}
            key={n.key}
            className={`nav-item ${active === n.key ? 'active' : ''}`}
            onClick={() => navigate(n.key)}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.key === 'analysis' && selectionCount > 0 && (
              <span style={{
                marginLeft: 'auto',
                marginRight: 6,
                background: 'var(--signal)',
                color: '#1a0500',
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 2,
                letterSpacing: '0.08em',
              }}>
                {selectionCount}
              </span>
            )}
            <span className="nav-key" style={n.key === 'analysis' && selectionCount > 0 ? { marginLeft: 0 } : {}}>⌘{n.k}</span>
          </button>
        ))}
      </nav>

      <button
        className={`sidebar-account ${active === 'account' ? 'active' : ''}`}
        onClick={() => { setOpen(false); signedIn ? onChange('account') : onSignIn() }}
        title={signedIn ? (email ?? 'Account') : 'Sign in'}
      >
        <UserIcon />
        <span className="sidebar-account-label">{signedIn ? email : 'Sign in'}</span>
      </button>

      <div className="sidebar-footer">
        <div className="row-center">
          <span className={`led ${connected ? '' : 'dim'}`} />
          <span>{connected ? 'LINK' : 'OFFLINE'}</span>
        </div>
        <div className="row-center" style={{ gap: 8 }}>
          <span>{time.toTimeString().slice(0, 5)}</span>
          <button
            className={`sidebar-log-btn ${active === 'logs' ? 'active' : ''}`}
            onClick={() => navigate('logs')}
            title="Debug logs"
          >
            <BugIcon />
          </button>
        </div>
      </div>
      <ServerUserSwitcher />
    </aside>
    </>
  )
}
