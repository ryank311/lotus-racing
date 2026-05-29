import { useState } from 'react'
import type { AuthState, SyncStats } from '../../shared/types'
import { humaniseBytes } from '../api'
import { BriefDialog } from '../components/BriefDialog'
import { AccountWidget } from '../components/AccountWidget'
import { AccountState, daysRemaining, getActiveAccount, tokenValid } from '../accounts'

interface Props {
  auth: AuthState | null
  stats: SyncStats | null
  busy: 'sync' | 'load' | null
  onSync: () => void
  onLoad: () => void
  accounts: AccountState
  onAccountsChange: (next: AccountState) => void
}

export function Home({ auth, stats, busy, onSync, onLoad, accounts, onAccountsChange }: Props) {
  const [briefOpen, setBriefOpen] = useState(false)

  const active = getActiveAccount(accounts)
  const activeValid = tokenValid(active)
  const email = active?.label ?? null
  const tokenStatus = activeValid
    ? { cls: 'ok', text: `${daysRemaining(active)}d` }
    : active
      ? { cls: 'warn', text: 'expired' }
      : auth?.tokenValid
        ? { cls: 'ok', text: `${auth.tokenDaysRemaining}d` }
        : { cls: 'err', text: 'no account' }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// driver dashboard</div>
          <div className="page-title">Over<span className="accent">view</span></div>
        </div>
        <div className="page-meta">
          {email ?? 'no account'}<br />
          <span className="muted">{stats?.lastSyncAgoHuman ?? 'never'} synced</span>
        </div>
      </header>

      <div className="page-body">
        <div className="banner">
          <div>
            <div className="banner-headline">
              {stats && stats.sessionCount > 0
                ? <>Telemetry archive · <span style={{ color: 'var(--signal)' }}>{stats.sessionCount}</span> sessions on disk</>
                : <>No telemetry yet — sync your first session</>}
            </div>
            <div className="banner-sub">
              {humaniseBytes(stats?.totalSizeBytes ?? 0)} · last sync {stats?.lastSyncAgoHuman ?? 'never'}
            </div>
          </div>
          <div className="btn-row" style={{ margin: 0 }}>
            <button className="btn primary" disabled={busy === 'sync'} onClick={onSync}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={onLoad}>
              Rebuild DB
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => setBriefOpen(true)}>
              New brief
            </button>
          </div>
        </div>

        <div className="stat-grid">
          <Tile label="Sessions on disk" value={String(stats?.sessionCount ?? 0)} />
          <Tile label="Total telemetry" value={humaniseBytes(stats?.totalSizeBytes ?? 0)} mono />
          <Tile label="Token expires in" value={tokenStatus.text} valueClass={tokenStatus.cls} />
          <Tile label="Last sync" value={stats?.lastSyncAgoHuman ?? 'never'} mono />
        </div>

        <section style={{ marginTop: 32 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <InfoCard label="Account" rows={[
              ['email', email ?? '—'],
              ['token', auth?.tokenValid ? 'valid (Catalyst OAuth2)' : 'missing/expired'],
              ['garth tokens', auth?.hasGarthTokens ? 'present' : 'absent'],
            ]} />
            <InfoCard label="Pipeline" rows={[
              ['data dir', '~/garmin/data/sessions'],
              ['db file', '~/garmin/data/catalyst.duckdb'],
              ['fetcher', 'autosport.api.gcs.garmin.com'],
            ]} />
          </div>
        </section>
      </div>

      {briefOpen && <BriefDialog onClose={() => setBriefOpen(false)} />}
    </>
  )
}

function Tile({ label, value, mono, valueClass }: { label: string; value: string; mono?: boolean; valueClass?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${mono ? 'mono' : ''} ${valueClass ?? ''}`}>{value}</div>
    </div>
  )
}

function InfoCard({ label, rows }: { label: string; rows: Array<[string, string]> }) {
  return (
    <div className="card" style={{ padding: '20px 22px 18px' }}>
      <div className="card-label">{label}</div>
      <div className="card-corner-marks"><i /></div>
      <table className="tbl" style={{ background: 'transparent', border: 0 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="muted small" style={{ borderBottom: 0, paddingLeft: 0 }}>{k}</td>
              <td className="num" style={{ borderBottom: 0, color: 'var(--text)' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
