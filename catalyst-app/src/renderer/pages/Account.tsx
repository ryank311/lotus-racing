import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AccountStats, AuthState } from '../../shared/types'

interface Props {
  email: string | null
  auth: AuthState | null
  onSignOut: () => void
}

function fmtHours(h: number): string {
  if (h <= 0) return '0 h'
  if (h < 1) return `${Math.round(h * 60)} min`
  const whole = Math.floor(h)
  const mins = Math.round((h - whole) * 60)
  return mins ? `${whole}h ${mins}m` : `${whole} h`
}

export function Account({ email, auth, onSignOut }: Props) {
  const [stats, setStats] = useState<AccountStats | null>(null)
  const [profile, setProfile] = useState<string | null>(null)

  useEffect(() => {
    // Guard against a stale preload bridge (getAccountStats added later) so the
    // page still renders rather than crashing until Electron is restarted.
    if (typeof api.getAccountStats === 'function') {
      void api.getAccountStats().then(setStats).catch(() => {})
    }
    void api.getActiveProfile().then(setProfile).catch(() => {})
  }, [])

  const initial = (email ?? '?').trim().charAt(0).toUpperCase()

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// driver</div>
          <div className="page-title">Acc<span className="accent">ount</span></div>
        </div>
        <div className="page-meta">
          <span className="muted">{auth?.tokenValid ? `token · ${auth.tokenDaysRemaining}d remaining` : 'token expiring'}</span>
        </div>
      </header>

      <div className="page-body">
        {/* Driver profile */}
        <div className="account-profile">
          <div className="account-avatar">{initial}</div>
          <div className="account-id">
            <div className="account-email">{email ?? 'unknown driver'}</div>
            <div className="account-sub">
              {profile ? <>Profile · <span style={{ color: 'var(--cyan)' }}>{profile}</span></> : 'Garmin Connect'}
            </div>
          </div>
          <button className="btn ghost" onClick={onSignOut}>Sign out</button>
        </div>

        {/* All time */}
        <div className="account-section-label">All time</div>
        <div className="stat-grid">
          <Tile label="Laps driven" value={stats ? stats.allTime.laps.toLocaleString() : '…'} />
          <Tile label="Hours on track" value={stats ? fmtHours(stats.allTime.hours) : '…'} />
          <Tile label="Tracks" value={stats ? String(stats.allTime.tracks) : '…'} />
          <Tile label="Sessions" value={stats ? String(stats.allTime.sessions) : '…'} />
        </div>

        {/* This year */}
        <div className="account-section-label" style={{ marginTop: 26 }}>
          This year <span className="account-section-year">{stats?.year ?? new Date().getFullYear()}</span>
        </div>
        <div className="stat-grid stat-grid-2">
          <Tile label="Laps driven" value={stats ? stats.thisYear.laps.toLocaleString() : '…'} accent />
          <Tile label="Hours on track" value={stats ? fmtHours(stats.thisYear.hours) : '…'} accent />
        </div>
      </div>
    </>
  )
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: 'var(--signal)' } : undefined}>{value}</div>
    </div>
  )
}
