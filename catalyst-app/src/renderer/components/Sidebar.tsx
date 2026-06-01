import { useEffect, useState } from 'react'

export type NavKey = 'home' | 'sessions' | 'analysis' | 'coach' | 'garage' | 'tracks' | 'logs'

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

export function Sidebar({ active, onChange, connected, selectionCount = 0 }: {
  active: NavKey
  onChange: (k: NavKey) => void
  connected: boolean
  selectionCount?: number
}) {
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
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-text">
          <div className="brand-title">Catalyst</div>
          <div className="brand-sub">// telemetry · vir</div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-section-label">Workspace</div>
        {NAV.map(n => (
          <div
            key={n.key}
            className={`nav-item ${active === n.key ? 'active' : ''}`}
            onClick={() => onChange(n.key)}
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
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="row-center">
          <span className={`led ${connected ? '' : 'dim'}`} />
          <span>{connected ? 'LINK' : 'OFFLINE'}</span>
        </div>
        <div className="row-center" style={{ gap: 8 }}>
          <span>{time.toTimeString().slice(0, 5)}</span>
          <button
            className={`sidebar-log-btn ${active === 'logs' ? 'active' : ''}`}
            onClick={() => onChange('logs')}
            title="Debug logs"
          >
            <BugIcon />
          </button>
        </div>
      </div>
    </aside>
  )
}
