import { useEffect, useRef, useState } from 'react'
import { useResource } from '../useResource'
import { InlineLoadStatus, Skeleton, StatValue } from '../components/Loading'
import { AI_MODELS, defaultModelFor } from '../../shared/aiModels'
import type { AuthState, SyncStats, AiSettings } from '../../shared/types'
import { humaniseBytes, api } from '../api'
import { useUnits } from '../units'
import type { UnitSystem } from '../../shared/units'
import { NavLink, useNavigation } from '../navigation'
import { segment } from '../routes'

interface Props {
  auth: AuthState | null
  stats: SyncStats | null
  busy: 'sync' | 'load' | 'coach' | null
  signedIn: boolean
  statsPending: boolean
  statsError: string | null
  onRetryStats: () => void
  authPending: boolean
  authError: string | null
  onRetryAuth: () => void
  onSync: (mode?: 'recent' | 'all') => void
  onRequestSignIn: () => void
  onSessions: () => void
}

export function Home({ auth, stats, busy, signedIn, onSync, onRequestSignIn, onSessions, statsPending, statsError, onRetryStats, authPending, authError, onRetryAuth }: Props) {
  const { lastSessions } = useNavigation()
  const initialLoading = !stats && statsPending
  const [syncMenuOpen, setSyncMenuOpen] = useState(false)
  const [latestSession, setLatestSession] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!stats?.sessionCount) setLatestSession(null)
    if ((stats?.sessionCount ?? 0) > 0) void api.listSessions().then(rows => { if (!cancelled) setLatestSession(rows[0]?.session_guid ?? null) }).catch(() => {})
    return () => { cancelled = true }
  }, [stats?.sessionCount, stats?.sampleCount, busy])
  const syncMenuRef = useRef<HTMLDivElement>(null)
  const syncCaretRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!syncMenuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!syncMenuRef.current?.contains(event.target as Node)) setSyncMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSyncMenuOpen(false); syncCaretRef.current?.focus() }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [syncMenuOpen])
  useEffect(() => { if (busy) setSyncMenuOpen(false) }, [busy])
  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// driver dashboard</div>
          <div className="page-title">Over<span className="accent">view</span></div>
        </div>
        <div className="page-meta">
          <InlineLoadStatus label="overview" pending={statsPending} error={statsError} hasData={!!stats} onRetry={onRetryStats} />
          {!statsPending && !statsError && stats && <span className="muted">{stats.lastSyncAgoHuman ? `${stats.lastSyncAgoHuman} synced` : 'Not synced yet'}</span>}
        </div>
      </header>

      <div className="page-body">
        <div className="banner sync-banner">
          <div>
            <div className="banner-headline">
              {!stats || authPending || authError
                ? <>Telemetry archive</>
                : !signedIn
                ? <>Sign in to sync your Garmin telemetry</>
                : stats && stats.sessionCount > 0
                  ? <>Telemetry archive · <span style={{ color: 'var(--signal)' }}>{stats.sessionCount}</span> sessions indexed</>
                  : <>No telemetry yet — sync your first session</>}
            </div>
            <div className="banner-sub">
              {initialLoading ? <Skeleton /> : stats ? <>{stats.sampleCount.toLocaleString()} samples · last sync {stats.lastSyncAgoHuman ?? 'never'}</> : 'Session summary unavailable'}
            </div>
          </div>
          <div className="btn-row" style={{ margin: 0 }}>
            {authPending ? <button className="btn ghost" disabled>Checking account…</button> : authError ? <InlineLoadStatus label="account" pending={false} error={authError} onRetry={onRetryAuth} /> : signedIn ? (
              <div className="sync-split-button" ref={syncMenuRef}
                onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setSyncMenuOpen(false) }}>
                <button className="btn primary" disabled={!!busy} title="Refresh all overviews and download details for the latest 20 sessions"
                  onClick={() => { setSyncMenuOpen(false); onSync('recent') }}>
                  {busy === 'sync' ? 'Syncing…' : 'Sync now'}
                </button>
                <button className="btn primary sync-caret" disabled={!!busy} ref={syncCaretRef}
                  aria-label="More sync options" aria-expanded={syncMenuOpen} aria-controls="sync-options"
                  onClick={() => setSyncMenuOpen(open => !open)}>
                  <span aria-hidden="true">▾</span>
                </button>
                {syncMenuOpen && (
                  <div className="sync-dropdown" id="sync-options">
                    <button className="sync-all-option" onClick={() => { setSyncMenuOpen(false); onSync('all') }}>
                      <strong>Sync All</strong>
                      <span>Download details for every session</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button className="btn primary" onClick={onRequestSignIn}>Sign In</button>
            )}
          </div>
        </div>

        <div className="home-workflow">
          <NavLink className="workflow-link" to={lastSessions()}>
            <span><strong>Review your driving</strong><small>Pick sessions · compare laps · get coaching</small></span><span aria-hidden="true">→</span>
          </NavLink>
          <div className="home-latest-slot">{latestSession && <NavLink to={`/review/${segment(latestSession)}`}>Review latest session →</NavLink>}</div>
        </div>

        <div className="stat-grid" aria-label="Telemetry summary" aria-busy={statsPending} data-route-loading={initialLoading || undefined}>
          <Tile label="Sessions in DB" loading={initialLoading} value={stats ? String(stats.sessionCount) : '—'} />
          <Tile label="Driven laps" loading={initialLoading} value={stats ? stats.lapCount.toLocaleString() : '—'} />
          <Tile label="Tracks" loading={initialLoading} value={stats ? String(stats.trackCount) : '—'} />
          <Tile label="Last sync" loading={initialLoading} value={stats ? stats.lastSyncAgoHuman ?? 'never' : '—'} />
        </div>

        <section style={{ marginTop: 32 }}>
          <div className="home-settings-grid">
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

function Tile({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return <div className="stat-tile"><div className="stat-label">{label}</div><StatValue loading={loading}>{value}</StatValue></div>
}

function AiSettingsCard() {
  const settingsResource = useResource(() => api.getAiSettings())
  const { data: settings, setData: setSettings } = settingsResource
  const [draftKeys, setDraftKeys] = useState<Pick<AiSettings, 'anthropicApiKey' | 'openAiApiKey'>>({})
  const [saving, setSaving] = useState(false)
  const [editingKey, setEditingKey] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')


  const savePreferences = async (next: AiSettings) => {
    const previous = settings
    setSettings(next)
    setSaving(true)
    setMessage('')
    setError('')
    try {
      await api.saveAiSettings(next)
    } catch (e) {
      setSettings(previous)
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }
  const save = async () => {
    if (!settings) return
    setSaving(true)
    setError('')
    try {
      await api.saveAiSettings({ ...settings, ...draftKeys })
      setSettings(await api.getAiSettings())
      setDraftKeys({})
      setEditingKey(false)
      setMessage('Saved')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  if (!settings) return <div className="card home-settings-loading">
    <div className="card-label">AI Coach</div>
    <InlineLoadStatus label="AI settings" pending={settingsResource.pending} error={settingsResource.error} onRetry={settingsResource.reload} />
    {settingsResource.pending && <div aria-busy="true"><Skeleton variant="field" /><Skeleton variant="field" /><Skeleton /></div>}
  </div>

  const provider = settings.provider ?? 'anthropic'
  const providerLabel = provider === 'openai' ? 'OpenAI' : 'Anthropic'
  const keyField = provider === 'openai' ? 'openAiApiKey' : 'anthropicApiKey'
  const selectedKey = draftKeys[keyField]
  const hasKey = provider === 'openai' ? settings.hasOpenAiApiKey : settings.hasAnthropicApiKey
  const modelOptions = AI_MODELS[provider]
  const showKeyEditor = !hasKey || editingKey
  const changeProvider = (next: 'anthropic' | 'openai') => {
    setEditingKey(false)
    setDraftKeys({})
    setError('')
    void savePreferences({ ...settings, provider: next, model: defaultModelFor(next) })
  }
  const changeKey = (value: string) => {
    setDraftKeys(prev => ({ ...prev, [keyField]: value }))
    setMessage('')
  }

  return (
    <div className="card" style={{ padding: '20px 22px 18px' }}>
      <div className="card-label">AI Coach</div>
      <div className="card-corner-marks"><i /></div>

      <div style={{ marginTop: 14 }}>
        <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Provider</div>
        <select
          aria-label="AI provider"
          value={provider}
          disabled={saving}
          onChange={e => changeProvider(e.target.value as 'anthropic' | 'openai')}
          style={{
            width: '100%', background: 'var(--bg-elev)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: '7px 10px', color: 'var(--text)',
            fontFamily: 'var(--font-mono)', fontSize: 11,
          }}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="muted small" style={{ marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>Model</div>
        <select
          aria-label="AI model"
          value={settings.model ?? defaultModelFor(provider)}
          disabled={saving}
          onChange={e => void savePreferences({ ...settings, model: e.target.value })}
          style={{
            width: '100%', background: 'var(--bg-elev)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: '7px 10px', color: 'var(--text)',
            fontFamily: 'var(--font-mono)', fontSize: 11,
          }}
        >
          {modelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {showKeyEditor && (
        <div id="ai-key-editor" style={{ marginTop: 16 }}>
          <label htmlFor="ai-api-key" className="muted small" style={{ display: 'block', marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 9 }}>{providerLabel} API key</label>
          <input
            id="ai-api-key"
            type="password"
            value={selectedKey ?? ''}
            onChange={e => changeKey(e.target.value)}
            disabled={saving}
            autoComplete="new-password"
            autoFocus={editingKey}
            aria-describedby="ai-key-help"
            placeholder={hasKey ? 'Enter a new key, or leave blank to clear' : provider === 'openai' ? 'sk-…' : 'sk-ant-api…'}
            style={{
              width: '100%', background: 'var(--bg-elev)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              padding: '8px 12px', color: 'var(--text)',
              fontFamily: 'var(--font-mono)', fontSize: 11,
            }}
          />
          <div id="ai-key-help" className="muted" style={{ fontSize: 10, lineHeight: 1.5, marginTop: 8 }}>
            {hasKey ? 'Enter a replacement key, or save an empty field to clear the existing key. ' : 'Add an API key to enable coaching. '}
            {settings.keysShared
              ? 'This key is shared by all logins. Changes affect everyone.'
              : 'Keys are stored in your Catalyst Coach database.'}
          </div>
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
        {showKeyEditor && <button className="btn primary" disabled={saving || selectedKey === undefined} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>}
        {hasKey && (editingKey ? (
          <button className="btn ghost" disabled={saving} onClick={() => {
            setEditingKey(false)
            setDraftKeys({})
            setError('')
          }}>Cancel</button>
        ) : (
          <button className="btn ghost" disabled={saving} aria-controls="ai-key-editor" aria-expanded={false} onClick={() => {
            setEditingKey(true)
            changeKey('')
          }}>Edit API key</button>
        ))}
        {message && <span role="status" className="muted">{message}</span>}
      </div>
      {error && <div role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  )
}
