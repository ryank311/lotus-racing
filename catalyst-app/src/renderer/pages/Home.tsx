import { useEffect, useState } from 'react'
import type { AuthState, SyncStats, AiSettings } from '../../shared/types'
import { humaniseBytes, api } from '../api'
import { BriefDialog } from '../components/BriefDialog'
import { AccountWidget } from '../components/AccountWidget'
import { AccountState, daysRemaining, getActiveAccount, tokenValid } from '../accounts'

interface Props {
  auth: AuthState | null
  stats: SyncStats | null
  busy: 'sync' | 'load' | 'coach' | null
  onSync: () => void
  onLoad: () => void
  accounts: AccountState
  onAccountsChange: (next: AccountState) => void
}

export function Home({ auth, stats, busy, onSync, onLoad, accounts, onAccountsChange }: Props) {
  const [briefOpen, setBriefOpen] = useState(false)

  const active = getActiveAccount(accounts)
  const email = active?.label ?? null

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
                ? <>Telemetry archive · <span style={{ color: 'var(--signal)' }}>{stats.sessionCount}</span> sessions loaded</>
                : <>No telemetry yet — sync your first session</>}
            </div>
            <div className="banner-sub">
              {(stats?.sampleCount ?? 0).toLocaleString()} samples · last sync {stats?.lastSyncAgoHuman ?? 'never'}
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
          <Tile label="Sessions in DB" value={String(stats?.sessionCount ?? 0)} />
          <Tile label="Driven laps" value={(stats?.lapCount ?? 0).toLocaleString()} mono />
          <Tile label="Tracks" value={String(stats?.trackCount ?? 0)} />
          <Tile label="Last sync" value={stats?.lastSyncAgoHuman ?? 'never'} mono />
        </div>

        <section style={{ marginTop: 32 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <AccountWidget state={accounts} onChange={onAccountsChange} />
            <AiSettingsCard />
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

function AiSettingsCard() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { void api.getAiSettings().then(setSettings) }, [])

  const save = async () => {
    if (!settings) return
    await api.saveAiSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!settings) return null

  return (
    <div className="card" style={{ padding: '20px 22px 18px' }}>
      <div className="card-label">AI Coach</div>
      <div className="card-corner-marks"><i /></div>

      <div style={{ marginTop: 14 }}>
        <div className="muted small" style={{ marginBottom: 8, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Harness</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['local', 'remote'] as const).map(h => (
            <div
              key={h}
              className={`radio ${settings.harness === h ? 'selected' : ''}`}
              style={{ flex: 1, padding: '7px 12px', textAlign: 'center', fontSize: 12 }}
              onClick={() => setSettings(s => s ? { ...s, harness: h } : s)}
            >
              {h === 'local' ? 'Local (claude CLI)' : 'Remote (API)'}
            </div>
          ))}
        </div>
      </div>

      {settings.harness === 'remote' && (
        <>
          <div style={{ marginTop: 14 }}>
            <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>API Key</div>
            <input
              type="password"
              value={settings.apiKey ?? ''}
              onChange={e => setSettings(s => s ? { ...s, apiKey: e.target.value } : s)}
              placeholder="sk-ant-api…"
              style={{
                width: '100%', background: 'var(--bg-elev)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                padding: '8px 12px', color: 'var(--text)',
                fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Model</div>
            <select
              value={settings.model ?? 'claude-opus-4-8'}
              onChange={e => setSettings(s => s ? { ...s, model: e.target.value } : s)}
              style={{
                width: '100%', background: 'var(--bg-elev)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                padding: '7px 10px', color: 'var(--text)',
                fontFamily: 'var(--font-mono)', fontSize: 11,
              }}
            >
              <option value="claude-opus-4-8">claude-opus-4-8 (latest)</option>
              <option value="claude-opus-4-7">claude-opus-4-7</option>
              <option value="claude-opus-4-5">claude-opus-4-5</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
            </select>
          </div>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Max tokens</div>
              <input
                type="number"
                min={1000} max={200000} step={1000}
                value={settings.maxTokens ?? 32000}
                onChange={e => setSettings(s => s ? { ...s, maxTokens: Number(e.target.value) } : s)}
                style={{
                  width: '100%', background: 'var(--bg-elev)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  padding: '7px 10px', color: 'var(--text)',
                  fontFamily: 'var(--font-mono)', fontSize: 11,
                }}
              />
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Response mode</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {([true, false] as const).map(v => (
                  <div
                    key={String(v)}
                    className={`radio ${(settings.stream ?? true) === v ? 'selected' : ''}`}
                    style={{ flex: 1, padding: '6px 0', textAlign: 'center', fontSize: 11 }}
                    onClick={() => setSettings(s => s ? { ...s, stream: v } : s)}
                  >
                    {v ? 'Stream' : 'Batch'}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {settings.harness === 'local' && (
        <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Uses the <code style={{ color: 'var(--cyan)' }}>claude</code> CLI on your PATH.
          Run <code style={{ color: 'var(--cyan)' }}>claude --version</code> to verify it's installed.
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={save} style={{ padding: '6px 16px' }}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </div>
    </div>
  )
}
