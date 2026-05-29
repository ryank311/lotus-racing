import { useEffect, useState } from 'react'

export type NavKey = 'home' | 'sessions' | 'briefs' | 'garage'

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
const BriefsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M5 3H15L19 7V21H5V3Z" />
    <path d="M15 3V7H19" /><path d="M8 12H16" /><path d="M8 16H13" />
  </svg>
)
const GarageIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="nav-icon">
    <path d="M3 11V21H21V11L12 4L3 11Z" />
    <path d="M7 21V15H17V21" /><circle cx="9" cy="17" r="0.5" fill="currentColor" />
  </svg>
)

const NAV: NavSpec[] = [
  { key: 'home',     label: 'Overview',  k: '1', icon: <HomeIcon /> },
  { key: 'sessions', label: 'Sessions',  k: '2', icon: <SessionsIcon /> },
  { key: 'briefs',   label: 'Briefs',    k: '3', icon: <BriefsIcon /> },
  { key: 'garage',   label: 'Garage',    k: '4', icon: <GarageIcon /> },
]

export function Sidebar({ active, onChange, connected }: { active: NavKey; onChange: (k: NavKey) => void; connected: boolean }) {
  // ⌘+1..4 to swap pages
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
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
        <div className="brand-title">Catalyst</div>
        <div className="brand-sub">// telemetry · vir</div>
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
            <span className="nav-key">⌘{n.k}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="row-center">
          <span className={`led ${connected ? '' : 'dim'}`} />
          <span>{connected ? 'LINK' : 'OFFLINE'}</span>
        </div>
        <span>{time.toTimeString().slice(0, 5)}</span>
      </div>
    </aside>
  )
}
