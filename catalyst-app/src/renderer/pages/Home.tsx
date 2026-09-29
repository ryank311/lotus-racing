import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useResource } from '../useResource'
import { InlineLoadStatus, Skeleton, StatValue } from '../components/Loading'
import { AI_MODELS, defaultModelFor } from '../../shared/aiModels'
import type { AuthState, SyncStats, AiSettings, DashboardLayout, DbSessionRow, FocusStatus, FocusVerdict } from '../../shared/types'
import { humaniseBytes, api, msToLap } from '../api'
import { useUnits } from '../units'
import type { UnitSystem } from '../../shared/units'
import { NavLink, useNavigation } from '../navigation'
import { routeUrl, segment } from '../routes'
import './home-dashboard.css'

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
  // Newest first; undefined until the list has loaded.
  const [recentRows, setRecentRows] = useState<DbSessionRow[] | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    if (stats && !stats.sessionCount) setRecentRows([])
    if ((stats?.sessionCount ?? 0) > 0) void api.listSessions().then(rows => { if (!cancelled) setRecentRows(rows) }).catch(() => { if (!cancelled) setRecentRows([]) })
    return () => { cancelled = true }
  }, [stats?.sessionCount, stats?.sampleCount, busy])
  const latest = recentRows && latestSessionCallout(recentRows)
  // Hold the space empty until we know which entry to show, so it never swaps.
  const entryKnown = recentRows !== undefined || (!!stats && !stats.sessionCount) || !!statsError
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
  // Reload the dashboard when synced data changes, but not mid-sync: the
  // latest totals apply once the worker finishes.
  const dataKey = stats ? `${stats.sessionCount}:${stats.lapCount}:${stats.lastSyncEpoch ?? ''}` : statsError ? 'stats-unavailable' : null
  const [dashboardRevision, setDashboardRevision] = useState(dataKey)
  useEffect(() => { setDashboardRevision(previous => !busy || previous === null ? dataKey : previous) }, [dataKey, busy])
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
              {initialLoading ? <Skeleton /> : stats ? <>{stats.sampleCount?.toLocaleString() ?? '—'} samples · last sync {stats.lastSyncAgoHuman ?? 'never'}</> : 'Session summary unavailable'}
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

        <div className="home-workflow" aria-busy={!entryKnown}>
          {latest ? <LatestSessionCallout latest={latest} reviewAll={lastSessions()} />
            : entryKnown && <NavLink className="workflow-link" to={lastSessions()}>
              <span><strong>Review your driving</strong><small>Pick sessions · compare laps · get coaching</small></span><span aria-hidden="true">→</span>
            </NavLink>}
        </div>

        <Dashboard revision={dashboardRevision} archiveEmpty={stats?.sessionCount === 0} />

        <div className="stat-grid" aria-label="Telemetry summary" aria-busy={statsPending} data-route-loading={initialLoading || undefined}>
          <Tile label="Sessions in DB" loading={initialLoading} value={stats ? String(stats.sessionCount) : '—'} />
          <Tile label="Driven laps" loading={initialLoading} value={stats?.lapCount?.toLocaleString() ?? '—'} />
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

// ── Driver dashboard: one card per car and track layout ─────────────────────

const DASHBOARD_PREVIEW = 4

const VERDICTS: Record<FocusVerdict, { label: string; tone: 'good' | 'neutral' | 'bad' }> = {
  met: { label: 'Target met', tone: 'good' },
  improved: { label: 'Improving', tone: 'good' },
  no_change: { label: 'No change yet', tone: 'neutral' },
  not_measured: { label: 'Not measured', tone: 'neutral' },
  worse: { label: 'Went backwards', tone: 'bad' },
}

const seconds = (ms: number) => `${(Math.abs(ms) / 1000).toFixed(2)} s`

function shortDate(iso: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** `revision` is null until the archive totals are known; the fetch waits for them. */
// A session driven in the last two days is what you want at the track: it
// becomes the Overview's main action. Older archives get the general entry.
const RECENT_SESSION_MS = 48 * 3600_000

interface LatestSession { row: DbSessionRow; startedAt: Date; sameDay: DbSessionRow[] }

function latestSessionCallout(rows: DbSessionRow[], now = Date.now()): LatestSession | null {
  const row = rows.find(r => r.session_start)
  const startedAt = row?.session_start ? new Date(row.session_start.replace(' ', 'T')) : null
  // Session times are local track time; allow for a device a zone or two away.
  if (!row || !startedAt || Number.isNaN(+startedAt) || now - +startedAt > RECENT_SESSION_MS || +startedAt - now > 3 * 3600_000) return null
  const day = row.session_start!.slice(0, 10)
  const sameLayout = (r: DbSessionRow) => r.vehicle_guid === row.vehicle_guid && (r.layout_key && row.layout_key
    ? r.layout_key === row.layout_key
    : r.track_name === row.track_name && r.track_configuration_name === row.track_configuration_name)
  return { row, startedAt, sameDay: rows.filter(r => r.session_start?.slice(0, 10) === day && sameLayout(r)) }
}

function whenLabel(startedAt: Date, now = new Date()): { day: string; ago: string } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((midnight.getTime() - new Date(startedAt.getFullYear(), startedAt.getMonth(), startedAt.getDate()).getTime()) / 86_400_000)
  const time = startedAt.toTimeString().slice(0, 5)
  const minutes = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 60_000))
  return {
    day: `${days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : startedAt.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`,
    ago: minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`,
  }
}

function LatestSessionCallout({ latest, reviewAll }: { latest: LatestSession; reviewAll: string }) {
  const { row, startedAt, sameDay } = latest
  const when = whenLabel(startedAt)
  const vehicle = [row.vehicle_year, row.vehicle_make, row.vehicle_model].filter(Boolean).join(' ')
  const pb = row.best_lap_ms != null && row.layout_best_ms != null && row.best_lap_ms <= row.layout_best_ms
  const track = [row.track_name, row.track_configuration_name].filter(Boolean).join(' · ') || 'Unknown track'
  return <section className="home-latest" aria-label="Latest session">
    <NavLink className="home-latest-main" to={`/review/${segment(row.session_guid)}`}>
      <span className="home-latest-text">
        <span className="home-latest-eyebrow">// latest session · {when.day} · {when.ago}</span>
        <strong className="home-latest-track">{track}</strong>
        <span className="home-latest-meta">
          {vehicle && <span>{vehicle}</span>}
          {row.lap_count > 0 && <span>{row.lap_count} {row.lap_count === 1 ? 'lap' : 'laps'}</span>}
          {row.best_lap_ms != null && <span>best <b>{msToLap(row.best_lap_ms)}</b>{pb && <em className="home-latest-pb">PB</em>}</span>}
          {!row.details_loaded && <span>Telemetry downloads when you open it</span>}
        </span>
      </span>
      <span className="home-latest-cta">Review session <span aria-hidden="true">→</span></span>
    </NavLink>
    <nav className="home-latest-more" aria-label="More review options">
      {sameDay.length > 1 && <NavLink to={routeUrl('/analysis', { session: sameDay.map(r => r.session_guid) })}>Compare {when.day.startsWith('Today') ? 'today’s' : 'that day’s'} {sameDay.length} sessions →</NavLink>}
      <NavLink to={reviewAll}>Review your driving · pick sessions →</NavLink>
    </nav>
  </section>
}

function Dashboard({ revision, archiveEmpty }: { revision: string | null; archiveEmpty: boolean }) {
  if (archiveEmpty) return <DashboardFrame><DashboardEmpty /></DashboardFrame>
  if (revision === null) return <DashboardFrame status={<InlineLoadStatus label="tracks" pending />} loading><DashboardSkeleton /></DashboardFrame>
  return <DashboardData revision={revision} />
}

function DashboardData({ revision }: { revision: string }) {
  const resource = useResource(async () => (await api.getDashboard()) ?? [], '', revision)
  const layouts = resource.data
  const [showAll, setShowAll] = useState(false)
  const status = <InlineLoadStatus label="tracks" pending={resource.pending} error={resource.error} hasData={!!layouts} onRetry={resource.reload} />
  if (!layouts) return <DashboardFrame status={status} loading={resource.pending}>{resource.pending && <DashboardSkeleton />}</DashboardFrame>
  if (!layouts.length) return <DashboardFrame status={status}><DashboardEmpty /></DashboardFrame>
  const visible = showAll ? layouts : layouts.slice(0, DASHBOARD_PREVIEW)
  return (
    <DashboardFrame status={status}>
      <div className="home-dash-grid">
        {visible.map(layout => <LayoutCard key={layout.key} layout={layout} />)}
      </div>
      {layouts.length > DASHBOARD_PREVIEW && (
        <button className="btn ghost home-dash-more" aria-expanded={showAll} onClick={() => setShowAll(open => !open)}>
          {showAll ? 'Show fewer' : `Show all ${layouts.length}`}
        </button>
      )}
    </DashboardFrame>
  )
}

function DashboardFrame({ status, loading = false, children }: { status?: ReactNode; loading?: boolean; children: ReactNode }) {
  return (
    <section className="home-dash" aria-labelledby="home-dash-title" aria-busy={loading} data-route-loading={loading || undefined}>
      <div className="home-dash-heading">
        <h2 id="home-dash-title">Your tracks</h2>
        {status}
      </div>
      {children}
    </section>
  )
}

function DashboardEmpty() {
  return <p className="home-dash-empty">No lap data yet. Sync your sessions to see your PB and coaching focus for each track.</p>
}

function DashboardSkeleton() {
  return (
    <div className="home-dash-grid" aria-hidden="true">
      {[0, 1].map(i => (
        <div className="card home-dash-card home-dash-card-loading" key={i}>
          <Skeleton />
          <Skeleton variant="value" />
          <Skeleton />
        </div>
      ))}
    </div>
  )
}

function LayoutCard({ layout }: { layout: DashboardLayout }) {
  const { pb, lastSession, lastVsPbMs, garminOptimalMs, focus } = layout
  const lastIsPb = !!pb && !!lastSession && lastSession.guid === pb.guid && lastVsPbMs != null && lastVsPbMs <= 0
  const potentialMs = pb && garminOptimalMs != null && garminOptimalMs > 0 ? pb.ms - garminOptimalMs : null
  const hasFocus = !!focus && focus.items.length > 0
  const titleId = `home-dash-${layout.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  let lastDelta: ReactNode = null
  if (lastIsPb) lastDelta = <span className="home-dash-delta is-gain">New PB</span>
  else if (lastVsPbMs != null && lastVsPbMs <= 0) lastDelta = <span className="home-dash-delta is-gain">Matched PB</span>
  else if (lastVsPbMs != null) lastDelta = <span className="home-dash-delta is-loss">+{seconds(lastVsPbMs)} to PB</span>
  return (
    <article className="card home-dash-card" aria-labelledby={titleId}>
      <header className="home-dash-card-head">
        <h3 id={titleId}>{layout.trackLabel}</h3>
        <p>{layout.vehicleLabel} · {layout.sessionCount} session{layout.sessionCount === 1 ? '' : 's'}</p>
      </header>

      <div className={`home-dash-card-body${hasFocus ? ' has-focus' : ''}`}>
        <div className="home-dash-times"><dl className="home-dash-metrics">
          <div className="home-dash-metric home-dash-metric-pb">
            <dt>PB</dt>
            <dd className="home-dash-time">{pb ? msToLap(pb.ms) : '—'}</dd>
            <dd className="home-dash-sub">{pb ? pb.label : 'No valid laps yet'}</dd>
          </div>
          <div className="home-dash-metric">
            <dt>Last session</dt>
            <dd className="home-dash-time">{lastSession?.bestMs != null ? msToLap(lastSession.bestMs) : '—'}</dd>
            {lastDelta && <dd className="home-dash-sub">{lastDelta}</dd>}
            <dd className="home-dash-sub">{!lastSession ? '—' : lastSession.bestMs == null ? `${lastSession.label} · no valid laps` : lastSession.label}</dd>
          </div>
          <div className="home-dash-metric">
            <dt>Garmin optimal</dt>
            <dd className="home-dash-time">{msToLap(garminOptimalMs)}</dd>
            {potentialMs != null && potentialMs > 0 && <dd className="home-dash-sub"><span className="home-dash-potential">{seconds(potentialMs)}</span> potential</dd>}
          </div>
        </dl></div>

        {hasFocus && focus && <FocusBlock focus={focus} />}
      </div>

      {lastSession && (
        <div className="home-dash-actions">
          <NavLink className="btn ghost home-dash-action" to={`/review/${segment(lastSession.guid)}`}>Review last session <span aria-hidden="true">→</span></NavLink>
          <NavLink className="btn ghost home-dash-action" to={`/progress?anchor=${segment(lastSession.guid)}`}>Progress <span aria-hidden="true">→</span></NavLink>
        </div>
      )}
    </article>
  )
}

function FocusBlock({ focus }: { focus: FocusStatus }) {
  const checks = new Map(focus.checks.map(check => [check.focusId, check]))
  const setOn = shortDate(focus.createdAt)
  return (
    <section className="home-dash-focus" aria-label="Current focus">
      <div className="home-dash-focus-head">
        <span className="home-dash-label">Current focus{setOn && <span className="home-dash-focus-date"> · set {setOn}</span>}</span>
        <NavLink to={`/coach/${segment(focus.reportId)}`} title={focus.reportTitle} aria-label={`Open coaching report: ${focus.reportTitle}`}>Report →</NavLink>
      </div>
      {focus.checks.length === 0 && <p className="home-dash-focus-note">Not driven since this focus was set</p>}
      <ul className="home-dash-focus-list">
        {focus.items.map(item => {
          const check = checks.get(item.id)
          const verdict = check ? VERDICTS[check.verdict] ?? VERDICTS.not_measured : null
          return (
            <li key={item.id}>
              <div className="home-dash-cue">{item.cue?.trim() || item.change}</div>
              <div className="home-dash-where">{[item.complexName, item.metricLabel].filter(Boolean).join(' · ')}</div>
              <div className="home-dash-target">
                target: <b>{item.display.target}</b> <span className="home-dash-was">({check ? 'was' : 'now'} {item.display.baseline})</span>
              </div>
              {check && verdict && (
                <div className="home-dash-check">
                  {check.verdict !== 'not_measured' && <span>last session: <b>{check.display.current}</b></span>}
                  <span className={`chip home-dash-verdict is-${verdict.tone}`}>{verdict.label}</span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
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
