import { useResource } from '../useResource'
import { InlineLoadStatus, Skeleton, StatValue } from '../components/Loading'
import { api } from '../api'
import type { AuthState } from '../../shared/types'

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
  const statsResource = useResource(async () => {
    if (typeof api.getAccountStats !== 'function') throw new Error('Restart the app to load account statistics.')
    return api.getAccountStats()
  }, email ?? '')
  const profileResource = useResource(() => api.getActiveProfile(), email ?? '')
  const stats = statsResource.data
  const profile = profileResource.data

  const initial = (email ?? '?').trim().charAt(0).toUpperCase()

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// driver</div>
          <div className="page-title">Acc<span className="accent">ount</span></div>
        </div>
        <div className="page-meta">
          <span className="muted">{!auth ? 'Checking account…' : auth.tokenValid ? `token · ${auth.tokenDaysRemaining}d remaining` : 'token expiring'}</span>
        </div>
      </header>

      <div className="page-body">
        {/* Driver profile */}
        <div className="account-profile">
          <div className="account-avatar">{initial}</div>
          <div className="account-id">
            <div className="account-email">{email ?? 'Account'}</div>
            <div className="account-sub">
              {profileResource.initialLoading ? <Skeleton /> : profileResource.error ? <InlineLoadStatus label="profile" pending={profileResource.pending} error={profileResource.error} onRetry={profileResource.reload} /> : profile ? <>Profile · <span style={{ color: 'var(--cyan)' }}>{profile}</span></> : 'Garmin Connect'}
            </div>
          </div>
          <button className="btn ghost" onClick={onSignOut}>Sign out</button>
        </div>

        <InlineLoadStatus label="account statistics" pending={statsResource.pending} error={statsResource.error} hasData={!!stats} onRetry={statsResource.reload} />
        {/* All time */}
        <div className="account-section-label">All time</div>
        <div className="stat-grid" aria-busy={statsResource.pending}>
          <Tile loading={statsResource.initialLoading} label="Laps driven" value={stats ? stats.allTime.laps.toLocaleString() : '—'} />
          <Tile loading={statsResource.initialLoading} label="Hours on track" value={stats ? fmtHours(stats.allTime.hours) : '—'} />
          <Tile loading={statsResource.initialLoading} label="Tracks" value={stats ? String(stats.allTime.tracks) : '—'} />
          <Tile loading={statsResource.initialLoading} label="Sessions" value={stats ? String(stats.allTime.sessions) : '—'} />
        </div>

        {/* This year */}
        <div className="account-section-label" style={{ marginTop: 26 }}>
          This year <span className="account-section-year">{stats?.year ?? new Date().getFullYear()}</span>
        </div>
        <div className="stat-grid stat-grid-2" aria-busy={statsResource.pending}>
          <Tile loading={statsResource.initialLoading} label="Laps driven" value={stats ? stats.thisYear.laps.toLocaleString() : '—'} accent />
          <Tile loading={statsResource.initialLoading} label="Hours on track" value={stats ? fmtHours(stats.thisYear.hours) : '—'} accent />
        </div>
      </div>
    </>
  )
}

function Tile({ label, value, accent, loading }: { label: string; value: string; accent?: boolean; loading: boolean }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <StatValue loading={loading}><span style={accent ? { color: 'var(--signal)' } : undefined}>{value}</span></StatValue>
    </div>
  )
}
