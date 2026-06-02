import { useEffect, useRef, useState } from 'react'
import type { AuthState, SyncStats, AiSettings } from '../../shared/types'
import { humaniseBytes, api } from '../api'
import { useUnits } from '../units'
import type { UnitSystem } from '../../shared/units'

interface Props {
  auth: AuthState | null
  stats: SyncStats | null
  busy: 'sync' | 'load' | 'coach' | null
  signedIn: boolean
  onSync: () => void
  onRequestSignIn: () => void
}

export function Home({ auth, stats, busy, signedIn, onSync, onRequestSignIn }: Props) {
  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// driver dashboard</div>
          <div className="page-title">Over<span className="accent">view</span></div>
        </div>
        <div className="page-meta">
          <span className="muted">{signedIn ? `${stats?.lastSyncAgoHuman ?? 'never'} synced` : 'sign in to sync'}</span>
        </div>
      </header>

      <div className="page-body">
        <div className="banner">
          <div>
            <div className="banner-headline">
              {!signedIn
                ? <>Sign in to sync your Garmin telemetry</>
                : stats && stats.sessionCount > 0
                  ? <>Telemetry archive · <span style={{ color: 'var(--signal)' }}>{stats.sessionCount}</span> sessions loaded</>
                  : <>No telemetry yet — sync your first session</>}
            </div>
            <div className="banner-sub">
              {(stats?.sampleCount ?? 0).toLocaleString()} samples · last sync {stats?.lastSyncAgoHuman ?? 'never'}
            </div>
          </div>
          <div className="btn-row" style={{ margin: 0 }}>
            {signedIn ? (
              <button className="btn primary" disabled={busy === 'sync'} onClick={onSync}>
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
            ) : (
              <button className="btn primary" onClick={onRequestSignIn}>Sign In</button>
            )}
          </div>
        </div>

        <div className="stat-grid">
          <Tile label="Sessions in DB" value={String(stats?.sessionCount ?? 0)} />
          <Tile label="Driven laps" value={(stats?.lapCount ?? 0).toLocaleString()} />
          <Tile label="Tracks" value={String(stats?.trackCount ?? 0)} />
          <Tile label="Last sync" value={stats?.lastSyncAgoHuman ?? 'never'} />
        </div>

        <section style={{ marginTop: 32 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'stretch' }}>
            <AiSettingsCard />
            <SettingsCard />
          </div>
        </section>
      </div>

    </>
  )
}

function SettingsCard() {
  const { system, setSystem } = useUnits()
  const OPTIONS: Array<{ value: UnitSystem; label: string; hint: string }> = [
    { value: 'imperial', label: 'Imperial', hint: 'mph · °F' },
    { value: 'metric',   label: 'Metric',   hint: 'km/h · °C' },
  ]
  return (
    <div className="card" style={{ padding: '20px 22px 18px' }}>
      <div className="card-label">Settings</div>
      <div className="card-corner-marks"><i /></div>

      <div style={{ marginTop: 14 }}>
        <div className="muted small" style={{ marginBottom: 8, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Units</div>
        <div className="units-switch" style={{ gap: 0 }}>
          <div className="units-switch-track" data-active={system}>
            <div className="units-switch-thumb" />
            {OPTIONS.map(o => (
              <button
                key={o.value}
                className={`units-switch-opt ${system === o.value ? 'on' : ''}`}
                onClick={() => setSystem(o.value)}
              >
                <span className="units-switch-opt-label">{o.label}</span>
                <span className="units-switch-opt-hint">{o.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 10, lineHeight: 1.5, marginTop: 10 }}>
          Applies to speed and temperature across the app, charts, and AI coaching briefs.
        </div>
      </div>
    </div>
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
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => { void api.getAiSettings().then(setSettings) }, [])

  const updateSettings = (updater: (s: AiSettings) => AiSettings) => {
    setSettings(prev => {
      if (!prev) return prev
      const next = updater(prev)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => { void api.saveAiSettings(next) }, 300)
      return next
    })
  }

  if (!settings) return null

  return (
    <div className="card" style={{ padding: '20px 22px 18px' }}>
      <div className="card-label">AI Coach</div>
      <div className="card-corner-marks"><i /></div>

      <div style={{ marginTop: 14 }}>
        <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>API Key</div>
        <input
          type="password"
          value={settings.apiKey ?? ''}
          onChange={e => updateSettings(s => ({ ...s, apiKey: e.target.value }))}
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
          value={settings.model ?? 'claude-sonnet-4-6'}
          onChange={e => updateSettings(s => ({ ...s, model: e.target.value }))}
          style={{
            width: '100%', background: 'var(--bg-elev)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: '7px 10px', color: 'var(--text)',
            fontFamily: 'var(--font-mono)', fontSize: 11,
          }}
        >
          <option value="claude-opus-4-8">High — claude-opus-4-8</option>
          <option value="claude-opus-4-6">High — claude-opus-4-6</option>
          <option value="claude-sonnet-4-6">Medium — claude-sonnet-4-6</option>
          <option value="claude-haiku-4-5-20251001">Low — claude-haiku-4-5</option>
        </select>
      </div>
    </div>
  )
}
