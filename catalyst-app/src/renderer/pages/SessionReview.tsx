import { useResource } from '../useResource'
import { InlineLoadStatus } from '../components/Loading'
import { PreparingPanel, type PreparingStep } from '../components/Preparing'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { routeUrl, segment } from '../routes'
import { useUnits } from '../units'
import { SURFACES, type MetricComparison, type RegionKind, type ReviewMetric, type ReviewSnapshot, type ReviewSummary, type SessionReviewResponse, type Surface } from '../../shared/review'
import type { DbSessionRow, FocusStatus, SessionNotes } from '../../shared/types'
import { FocusCheckRow, ReviewCoachContent, ReviewDeltaBars, ReviewDeltaLegend, ReviewLapScatter, ReviewMap, ReviewMarkers, ReviewTrend, VerdictChip } from '../components/ReviewCharts'
import { startLabel } from '../components/reviewTimeline'
import './review-extras.css'

export const metricLabels: Record<ReviewMetric, string> = { timeMs: 'Traversal time', vminMps: 'V-min', vminDistanceM: 'V-min location', entryMps: 'Entry speed', exitMps: 'Exit speed', topSpeedMps: 'Top speed', consistencyMs: 'Consistency' }
export function useReviewFormat() {
  const units = useUnits()
  const time = (v: number) => `${(v / 1000).toFixed(2)} s`
  const speed = (v: number) => `${units.speedFromMps(v).toFixed(1)} ${units.speedUnit}`
  const format = (metric: ReviewMetric, v: number) => metric === 'timeMs' || metric === 'consistencyMs' ? time(v) : metric === 'vminDistanceM' ? `${v.toFixed(1)} m` : speed(v)
  return { ...units, time, speed, format }
}
/** Analysis focuses a corner by its ref: `corner:T11` → `T11`. */
export const regionRef = (id: string) => { const ref = id.slice(id.indexOf(':') + 1); return /^[A-Za-z0-9-]{1,16}$/.test(ref) ? ref : null }
const analysisUrl = (guid: string, regionId?: string) => routeUrl('/analysis', { session: [guid], focus: regionId ? regionRef(regionId) : null })
/** Newest first, grouped by track · layout, then vehicle; option labels use local track time. */
function sessionGroups(sessions: DbSessionRow[]) {
  const sorted = [...sessions].sort((a, b) => (b.session_start ?? '').localeCompare(a.session_start ?? ''))
  const layout = (s: DbSessionRow) => [s.track_name || 'Unknown track', s.track_configuration_name || 'Unknown layout'].join(' · ')
  const rank = new Map<string, number>(), groups = new Map<string, { label: string; rank: number; rows: DbSessionRow[] }>()
  for (const s of sorted) {
    if (!rank.has(layout(s))) rank.set(layout(s), rank.size)
    const label = `${layout(s)} · ${s.vehicle_model || 'Unknown car'}`
    if (!groups.has(label)) groups.set(label, { label, rank: rank.get(layout(s))!, rows: [] })
    groups.get(label)!.rows.push(s)
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank)
}
const optionLabel = (s: DbSessionRow) => `${startLabel(s.session_start)}${s.best_lap_ms ? ` · best ${msToLap(s.best_lap_ms)}` : ''}${s.lap_count ? ` · ${s.lap_count} laps` : ''}`

function MetricCard({ title, value, metric, format, neutral = false, note, badge, comparing = false }: { title: string; value: string; metric: MetricComparison; format: (n: number) => string; neutral?: boolean; note?: string; badge?: string | false; comparing?: boolean }) {
  const d = metric.delta
  // Colour only a clear change; limited evidence reads as a neutral number.
  const tone = neutral ? 'reference' : d == null ? 'muted' : metric.clearChange === 'gain' ? 'gain' : metric.clearChange === 'regression' ? 'loss' : 'neutral'
  // While history is still being measured the comparison would shift under
  // the driver; show this session's value and hold the comparison back, in
  // the same card shape so nothing moves when it arrives.
  if (comparing) return <article className="review-stat"><span className="review-eyebrow review-stat-title">{title}</span><strong className="review-stat-value">{value}</strong>
    <span className="muted">Comparing with history…</span>
    <details><summary>Details</summary><p className="muted">Comparisons with your matched sessions appear once your history is measured.</p></details>
  </article>
  return <article className="review-stat"><span className="review-eyebrow review-stat-title">{title}{badge && <b className="review-badge">{badge}</b>}</span><strong className="review-stat-value">{value}</strong>
    <span className={tone}>{d == null ? 'No matched baseline' : `${d > 0 ? '+' : ''}${format(d)} vs recent mean`}</span>
    <details><summary>Details</summary>{note && <p className="muted">{note}</p>}<div className="review-reference-list"><span>Previous matching session <b>{metric.previous == null ? '—' : format(metric.previous)}</b></span><span>Recent session mean <b>{metric.baseline == null ? '—' : format(metric.baseline)}</b></span>{metric.personalBest != null && <span>Prior matched PB <b>{format(metric.personalBest)}</b></span>}</div></details>
  </article>
}

function Conditions({ summary, onSave, disabled }: { summary: ReviewSummary; onSave: (action: () => Promise<void>) => Promise<void>; disabled: boolean }) {
  const units = useReviewFormat(), c = summary.conditions
  const [surface, setSurface] = useState<Surface>(c.surface)
  const [temperature, setTemperature] = useState(c.temperatureC == null ? '' : units.tempFromC(c.temperatureC).toFixed(1))
  useEffect(() => { setSurface(c.surface); setTemperature(c.temperatureC == null ? '' : units.tempFromC(c.temperatureC).toFixed(1)) }, [c.surface, c.temperatureC, units.system])
  return <details className="review-conditions"><summary><span>{c.surface} · {c.temperatureC == null ? 'Temperature unknown' : `${units.tempFromC(c.temperatureC).toFixed(1)}${units.tempUnit}`}</span><span className="reference">Edit conditions</span></summary>
    <p>Surface: {c.surface} ({c.surfaceSource}). Weather at session start: {c.weather ?? 'unavailable'} · recorded temperature {c.originalTemperatureC == null ? 'unavailable' : `${units.tempFromC(c.originalTemperatureC).toFixed(1)}${units.tempUnit}`}. {c.correctedAt && `Corrected ${c.correctedAt}.`}</p>
    <form className="review-filter-row" onSubmit={e => { e.preventDefault(); const raw = temperature.trim() === '' ? null : Number(temperature); const temperatureC = raw == null ? null : units.system === 'imperial' ? (raw - 32) * 5 / 9 : raw; void onSave(() => api.updateReviewConditions(summary.sessionGuid, { surface, temperatureC })) }}>
      <label>Track surface<select value={surface} onChange={e => setSurface(e.target.value as Surface)}>{SURFACES.map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Ambient temperature ({units.tempUnit})<input type="number" step="0.1" value={temperature} placeholder="Use original reading" onChange={e => setTemperature(e.target.value)} /></label>
      <button className="btn primary" disabled={disabled}>Save conditions</button><button type="button" className="btn ghost" disabled={disabled} onClick={() => void onSave(() => api.updateReviewConditions(summary.sessionGuid, { surface: null, temperatureC: null }))}>Use Garmin estimate</button>
    </form><p className="muted">Matching always uses the same surface and ±5°C (±9°F). Unknown conditions do not form a comparison group.</p>
  </details>
}

interface RegionPick { kind: RegionKind | null; id: string }
// Rank regions by the chosen metric, most improved first: lower is better for
// times, higher for speeds; V-min location has no better direction, so the
// largest shift comes first. Regions without a baseline sort last.
const LOWER_IS_BETTER: ReviewMetric[] = ['timeMs', 'consistencyMs']
function byMetricChange(metric: ReviewMetric) {
  const score = (r: ReviewSnapshot['regions'][number]) => {
    const d = r.metrics[metric].delta
    if (d == null) return Infinity
    if (metric === 'vminDistanceM') return -Math.abs(d)
    return LOWER_IS_BETTER.includes(metric) ? d : -d
  }
  return (a: ReviewSnapshot['regions'][number], b: ReviewSnapshot['regions'][number]) => {
    const x = score(a), y = score(b)
    return x === y ? 0 : x - y
  }
}

function Regions({ snapshot, pick, onPick, panel }: { snapshot: ReviewSnapshot; pick: RegionPick; onPick: (pick: RegionPick) => void; panel: RefObject<HTMLDetailsElement> }) {
  const f = useReviewFormat(), guid = snapshot.current.summary.sessionGuid
  const kind = pick.kind ?? (snapshot.regions.some(r => r.region.kind === 'corner') ? 'corner' : 'segment'), chosen = pick.id
  const setChosen = (id: string) => onPick({ kind, id })
  const [metric, setMetric] = useState<ReviewMetric>('timeMs')
  const rows = snapshot.regions.filter(r => r.region.kind === kind).sort(byMetricChange(metric))
  const current = rows.find(r => r.region.id === chosen) ?? rows[0], selected = current?.region.id ?? ''
  const regionHistory = current ? snapshot.history.filter(s => current.baselineSessions.includes(s.sessionGuid)) : []
  return <details ref={panel} className="review-panel review-regions" open><summary><span className="review-eyebrow">Corners & segments</span><span>Explore where the time changed</span></summary>
    <div className="review-filter-row"><div className="review-tabs" role="group" aria-label="Region type">{(['corner', 'segment'] as const).map(k => <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'active' : ''} onClick={() => onPick({ kind: k, id: '' })}>{k === 'corner' ? 'Corners' : 'Segments'}</button>)}</div>
      <label>Metric<select value={metric} onChange={e => setMetric(e.target.value as ReviewMetric)}>{Object.entries(metricLabels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label></div>
    {!rows.length ? <p>No {kind} definitions for this session. <NavLink to="/tracks">Open Tracks</NavLink></p> : <>
      <div className="review-region-visuals"><ReviewMap data={snapshot.current} regions={rows} selected={selected} onSelect={setChosen} /><ReviewDeltaBars rows={rows} metric={metric} selected={selected} onSelect={setChosen} format={v => f.format(metric, v)} /></div>
      <ReviewDeltaLegend metric={metric} />
      <p className="muted">{metric === 'vminDistanceM' ? `Regions are ranked by the size of the ${metricLabels[metric].toLowerCase()} shift.` : `Regions are ranked by ${metricLabels[metric].toLowerCase()} change, most improved first.`}</p>
      {current && <div className="review-region-detail"><div className="review-section-heading"><h3>{current.region.name}</h3><NavLink className="btn ghost" to={analysisUrl(guid, current.region.id)}>Open in Analysis →</NavLink></div><p className="muted">{current.region.startM.toFixed(0)}–{current.region.endM.toFixed(0)} m · {current.region.count} fast laps · {current.baselineSessions.length} matching regional sessions</p>
        <div className="review-region-stats">{(Object.keys(metricLabels) as ReviewMetric[]).map(key => {
          const c = current.metrics[key]
          return <div key={key}><span>{metricLabels[key]}</span><strong>{c.current == null ? '—' : f.format(key, c.current)}</strong><ReviewMarkers current={c.current} baseline={c.baseline} format={v => f.format(key, v)} /><small>Baseline {c.baseline == null ? '—' : f.format(key, c.baseline)}</small><small>Previous {c.previous == null ? '—' : f.format(key, c.previous)}</small>{c.personalBest != null && <small>Prior PB {f.format(key, c.personalBest)}</small>}</div>
        })}</div>
        <p className="muted">Orange marker: current · cyan marker: recent baseline. Each metric has its own scale.</p>
        <p className="review-note">{current.metrics.timeMs.clearChange ? `Clear ${current.metrics.timeMs.clearChange} in traversal time.` : 'Numerical changes shown; evidence does not meet the clear-change threshold.'} Speed changes describe technique context. Overlapping gains are not added together.</p>
        <details><summary>Contributing measurements</summary><div className="review-table-wrap"><table className="tbl"><thead><tr><th>Source</th><th>Lap count</th><th>{metricLabels[metric]}</th></tr></thead><tbody>
          {snapshot.current.laps.filter(l => metric === 'consistencyMs' ? l.representative : l.selected).map(l => <tr key={l.index}><td>Current · Lap {l.index + 1}</td><td>1</td><td>{metric === 'consistencyMs' ? (l.regions[selected]?.timeMs == null ? '—' : f.time(l.regions[selected].timeMs!)) : l.regions[selected]?.[metric] == null ? '—' : f.format(metric, l.regions[selected][metric]!)}</td></tr>)}
          {regionHistory.map(s => { const r = s.regions.find(r => r.id === selected); return <tr key={s.sessionGuid}><td><NavLink to={`/review/${segment(s.sessionGuid)}`}>{s.start}</NavLink></td><td>{r?.count}</td><td>{r?.[metric] == null ? '—' : f.format(metric, r[metric]!)}</td></tr> })}
        </tbody></table></div></details>
        <ReviewTrend title={metricLabels[metric]} format={v => f.format(metric, v)} points={[...snapshot.history.filter(s => s.meanLineGuid === snapshot.current.summary.meanLineGuid && s.geometryRevision === snapshot.current.summary.geometryRevision), snapshot.current.summary].map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.regions.find(r => r.id === selected)?.[metric] ?? null }))} />
      </div>}
    </>}
  </details>
}

/** The coaching focus that applied going into this session, measured on this session's laps. */
function FocusCard({ focus }: { focus: FocusStatus }) {
  const checks = focus.checks?.length ? focus.checks : null
  return <section className="review-panel review-focus-card"><div className="review-section-heading"><div><span className="review-eyebrow">Last focus</span><h2>How this session measured up</h2></div><NavLink to={`/coach/${segment(focus.reportId)}`}>{focus.reportTitle || 'Coaching report'} · {startLabel(focus.createdAt?.slice(0, 10))} →</NavLink></div>
    <ul className="review-focus-list">{checks ? checks.map((c, i) => <FocusCheckRow key={`${c.focusId}:${i}`} check={c} />)
      : (focus.items ?? []).map(item => <li key={item.id} className="review-focus-row"><VerdictChip verdict="not_measured" /><span><b>{item.cue || item.complexName}</b><small>{item.metricLabel} · {item.display.baseline} → target {item.display.target}</small></span></li>)}</ul>
  </section>
}

const noteFields: Array<[keyof SessionNotes, string, string]> = [['tires', 'Tires', 'Compound, set, heat cycles'], ['pressures', 'Pressures', 'Cold / hot, front / rear'], ['setup', 'Setup changes', 'What changed since last session'], ['notes', 'Notes', 'Traffic, feel, what you worked on']]
const normalizeNotes = (value: Partial<SessionNotes> | null | undefined): SessionNotes => Object.fromEntries(noteFields.map(([key]) => [key, typeof value?.[key] === 'string' ? value[key] : ''])) as unknown as SessionNotes

function SessionNotesPanel({ sessionGuid }: { sessionGuid: string }) {
  const resource = useResource(() => api.getSessionNotes(sessionGuid), sessionGuid)
  const saved = normalizeNotes(resource.data), [draft, setDraft] = useState<SessionNotes | null>(null)
  const [saving, setSaving] = useState(false), [status, setStatus] = useState('')
  const value = draft ?? saved, dirty = !!draft && noteFields.some(([key]) => draft[key] !== saved[key])
  const filled = noteFields.filter(([key]) => saved[key].trim())
  const save = async () => {
    setSaving(true); setStatus('')
    try { await api.saveSessionNotes(sessionGuid, value); resource.setData(value); setDraft(d => d === value ? null : d); setStatus('Saved') }
    catch (e) { setStatus(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  return <details className="review-panel review-notes"><summary><span className="review-eyebrow">Session notes</span><span>{filled.length ? filled.map(([key, name]) => `${name}: ${saved[key].trim().slice(0, 40)}`).join(' · ') : 'Add tires, pressures and setup changes'}</span></summary>
    <p className="muted">Notes are shared with the AI coach in future coaching reports.</p>
    <InlineLoadStatus label="notes" pending={resource.pending} error={resource.error} hasData={resource.data !== undefined} onRetry={resource.reload} />
    <form className="review-notes-form" onSubmit={e => { e.preventDefault(); void save() }}>
      {noteFields.map(([key, name, placeholder]) => <label key={key} className={key === 'notes' || key === 'setup' ? 'wide' : ''}>{name}{key === 'notes'
        ? <textarea rows={3} maxLength={2000} value={value[key]} placeholder={placeholder} onChange={e => { setDraft({ ...value, [key]: e.target.value }); setStatus('') }} />
        : <input maxLength={2000} value={value[key]} placeholder={placeholder} onChange={e => { setDraft({ ...value, [key]: e.target.value }); setStatus('') }} />}</label>)}
      <div className="review-notes-actions"><button className="btn primary" disabled={!dirty || saving || resource.pending}>{saving ? 'Saving…' : 'Save notes'}</button>{dirty && <button type="button" className="btn ghost" disabled={saving} onClick={() => setDraft(null)}>Discard</button>}{status && <span role="status" className={status === 'Saved' ? 'gain' : 'loss'}>{status}</span>}</div>
    </form>
  </details>
}

function LapControls({ snapshot, onSave, disabled }: { snapshot: ReviewSnapshot; onSave: (action: () => Promise<void>) => Promise<void>; disabled: boolean }) {
  const [reasons, setReasons] = useState<Record<number, string>>({})
  return <details className="review-panel"><summary><span className="review-eyebrow">Included laps</span><span>{snapshot.current.summary.eligibleLapCount} eligible · {snapshot.current.summary.representativeCount} representative</span></summary>
    <p>Exclude traffic, yellow-flag, or cooldown laps. Garmin flags and incomplete telemetry remain excluded automatically.</p>
    <ReviewLapScatter laps={snapshot.current.laps} />
    <div className="review-lap-list">{snapshot.current.laps.map(l => <div className="review-lap-row" key={l.index}>
      <label><input type="checkbox" checked={!l.excluded} disabled={disabled} onChange={e => void onSave(() => api.setReviewLapExcluded(snapshot.current.summary.sessionGuid, l.index, !e.target.checked, reasons[l.index]))} />Lap {l.index + 1} · {msToLap(l.durationMs)}{l.selected && <span className="chip signal">Fast sample</span>}</label>
      <small>{l.reasons.join(' · ') || (l.representative ? 'Representative lap' : 'Outside 5% representative window')}</small>
      <input aria-label={`Exclusion reason for lap ${l.index + 1}`} placeholder="Optional exclusion reason" maxLength={500} value={reasons[l.index] ?? l.exclusionReason ?? ''} onChange={e => setReasons(r => ({ ...r, [l.index]: e.target.value }))} onBlur={() => { if (l.excluded && reasons[l.index] !== undefined && reasons[l.index] !== (l.exclusionReason ?? '')) void onSave(() => api.setReviewLapExcluded(snapshot.current.summary.sessionGuid, l.index, true, reasons[l.index])) }} />
    </div>)}</div>
  </details>
}

export function SessionReview({ refreshTick, busy }: { refreshTick: number; busy: string | null }) {
  const { id } = useRoute(), { go } = useNavigation(), f = useReviewFormat()
  const catalogue = useResource(() => api.listSessions(), '', refreshTick)
  const sessions = catalogue.data ?? []
  const [response, setResponse] = useState<SessionReviewResponse | null>(null)
  const [error, setError] = useState(''), [phase, setPhase] = useState('Loading review…'), [saving, setSaving] = useState(false), [coaching, setCoaching] = useState(false)
  const [focus, setFocus] = useState<FocusStatus | null>(null), [regionPick, setRegionPick] = useState<RegionPick>({ kind: null, id: '' })
  const generation = useRef(0), request = useRef(0), focusRequest = useRef(0), mounted = useRef(true), selectedId = useRef(id), regionsPanel = useRef<HTMLDetailsElement>(null)
  selectedId.current = id
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // Focus tracking is optional context: failures leave the card hidden rather than blocking the review.
  const loadFocus = useCallback(async () => {
    if (!id) return
    const current = ++focusRequest.current
    try { const value = await api.getSessionFocus(id); if (mounted.current && selectedId.current === id && current === focusRequest.current) setFocus(value ?? null) } catch { /* optional */ }
  }, [id])
  const reload = useCallback(async () => {
    if (!id) return
    const current = ++request.current, token = generation.current
    try { const value = await api.getSessionReview(id); if (mounted.current && token === generation.current && current === request.current) { setResponse(value); setError(''); void loadFocus() } }
    catch (e) { if (mounted.current && token === generation.current && current === request.current) setError(e instanceof Error ? e.message : String(e)) }
  }, [id, loadFocus])
  useEffect(() => {
    const token = ++generation.current
    setResponse(null); setError(''); setCoaching(false); setFocus(null); setRegionPick({ kind: null, id: '' })
    if (!id) return
    void loadFocus()
    void (async () => {
      try {
        setPhase('Loading review…')
        const first = await api.getSessionReview(id)
        if (token !== generation.current) return
        setPhase(first.state === 'needs-download' ? 'Downloading session telemetry…' : 'Computing session metrics…')
        if (first.state === 'ready') setResponse(first)
        await api.ensureSessionReview(id)
        if (token === generation.current) await reload()
      } catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : String(e)) }
    })()
    return () => { generation.current++ }
  }, [id, reload])
  useEffect(() => { if (id) void reload() }, [refreshTick, reload, id])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = api.onReviewStatus(() => { clearTimeout(timer); timer = setTimeout(() => void reload(), 150) })
    const offCoach = api.onWorker(e => { if (e.kind === 'coach' && (e.type === 'done' || e.type === 'error')) { setCoaching(false); void reload() } })
    return () => { clearTimeout(timer); unsubscribe(); offCoach() }
  }, [reload])
  useEffect(() => {
    if (!id || error || response?.state === 'failed' || (response?.state === 'ready' && !response.snapshot?.coverage.pending)) return
    const timer = setInterval(() => void reload(), 2500); return () => clearInterval(timer)
  }, [id, error, response?.state, response?.snapshot?.coverage.pending, reload])
  const mutate = async (action: () => Promise<void>) => {
    const origin = id; setSaving(true); setError(''); setPhase('Computing session metrics…')
    try { await action(); if (selectedId.current === origin) await reload() }
    catch (e) { if (selectedId.current === origin) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setSaving(false) }
  }
  const askCoach = async () => {
    if (!response?.snapshot || !id) return
    const origin = id
    setCoaching(true); setError('')
    try { const profile = await api.getActiveProfile() ?? ''; await api.runCoach({ profile, scope: 'session-review', sessionGuids: [id], reviewRevision: response.snapshot.revision }) }
    catch (e) { if (selectedId.current === origin) { setCoaching(false); setError(e instanceof Error ? e.message : String(e)) } }
  }
  const snapshot = response?.snapshot, summary = snapshot?.current.summary
  const baselineTemperatures = snapshot?.baseline.map(s => s.conditions.temperatureC).filter((v): v is number => v !== null) ?? []
  const regionGains = snapshot?.regions.filter(r => r.metrics.timeMs.clearChange === 'gain').sort((a, b) => a.metrics.timeMs.delta! - b.metrics.timeMs.delta!) ?? []
  const regionLosses = snapshot?.regions.filter(r => r.metrics.timeMs.clearChange === 'regression').sort((a, b) => b.metrics.timeMs.delta! - a.metrics.timeMs.delta!) ?? []
  const showRegion = (ref: string) => {
    const match = snapshot?.regions.find(r => r.region.id === ref) ?? (ref.includes(':') ? undefined : snapshot?.regions.find(r => regionRef(r.region.id) === ref))
    return match ? () => {
      setRegionPick({ kind: match.region.kind, id: match.region.id })
      const panel = regionsPanel.current
      if (panel) { panel.open = true; requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' })) }
    } : null
  }
  const pb = !!snapshot && snapshot.bestLap.current != null && snapshot.bestLap.personalBest != null && snapshot.bestLap.current < snapshot.bestLap.personalBest
  const listed = sessions.find(s => s.session_guid === id)
  // Preparing: first load, telemetry download, this session's metrics, or the
  // matched history still being measured (comparisons would still move).
  const historyPending = !!snapshot && snapshot.coverage.pending > 0
  const stage: 'load' | 'download' | 'measure' | 'compare' | null = !id || error || response?.state === 'failed' ? null
    : snapshot ? (historyPending ? 'compare' : null)
    : response?.state === 'needs-download' || (!response && phase.startsWith('Downloading')) ? 'download'
    : response || phase.startsWith('Computing') ? 'measure' : 'load'
  const preparingSteps: PreparingStep[] = stage ? [
    { label: 'Session telemetry', detail: stage === 'download' ? 'Downloading from Garmin Catalyst' : 'Laps and 1 m samples', state: stage === 'load' || stage === 'download' ? 'active' : 'done' },
    { label: 'Measure this session', detail: 'Lap validity, corner and segment times, minimum speeds', state: stage === 'measure' ? 'active' : stage === 'compare' ? 'done' : 'waiting' },
    { label: 'Compare with your history', detail: historyPending ? `${snapshot!.coverage.processed} of ${snapshot!.coverage.downloaded} sessions measured` : 'Same car, layout and surface, within ±5°C', state: stage === 'compare' ? 'active' : 'waiting' },
  ] : []
  const [preparingSince, setPreparingSince] = useState<number | undefined>(undefined)
  useEffect(() => { setPreparingSince(stage ? Date.now() : undefined) }, [id, stage === null])
  const preparing = stage && <PreparingPanel
    eyebrow="session review"
    title={stage === 'download' ? 'Downloading session telemetry' : stage === 'measure' ? 'Measuring your session' : stage === 'compare' ? 'Comparing with your history' : 'Preparing session review'}
    detail={stage === 'compare' ? 'This session’s numbers are ready. Comparisons, clear gains, notes and coaching appear here once your history is measured.' : 'Reviews are prepared in the background, so you can keep using the app.'}
    steps={preparingSteps}
    progress={historyPending ? { done: snapshot!.coverage.processed, total: snapshot!.coverage.downloaded, label: `${snapshot!.coverage.processed} of ${snapshot!.coverage.downloaded} sessions measured` } : null}
    startedAt={preparingSince}
    standalone={!snapshot}
    delayMs={stage === 'load' ? 250 : 0}
  />
  return <div className="page-body review-page">
      <header className="review-page-header review-header-actions"><div><div className="page-eyebrow">// post-session</div><h1 className="page-title">Session <span className="accent">Review</span></h1></div>{id && <NavLink className="btn ghost" to={analysisUrl(id)}>Open in Analysis →</NavLink>}</header>
      <InlineLoadStatus label="sessions" pending={catalogue.pending} error={catalogue.error} hasData={catalogue.data !== undefined} onRetry={catalogue.reload} />
      <div className="review-context">
        <details className="review-picker review-context-picker" key={id ?? 'choose'} open={!id}>
          <summary><span className="review-context-label"><strong>{summary ? `${summary.track} · ${summary.layout}` : listed ? [listed.track_name, listed.track_configuration_name].filter(Boolean).join(' · ') : id ? 'Loading session…' : 'Choose a session'}</strong>{summary ? <span>{summary.vehicle} · {startLabel(summary.start)}</span> : listed && <span>{[listed.vehicle_year, listed.vehicle_make, listed.vehicle_model].filter(Boolean).join(' ')} · {startLabel(listed.session_start)}</span>}</span><span className="reference">Change session</span></summary>
          <label>Session<select aria-label="Review session" disabled={catalogue.data === undefined} value={id ?? ''} onChange={e => go(e.target.value ? `/review/${segment(e.target.value)}` : '/review')}><option value="">Choose one session</option>{sessionGroups(sessions).map(g => <optgroup key={g.label} label={g.label}>{g.rows.map(s => <option key={s.session_guid} value={s.session_guid}>{optionLabel(s)}</option>)}</optgroup>)}</select></label>
        </details>
        {summary && <Conditions key={`conditions:${id}`} summary={summary} onSave={mutate} disabled={saving || busy === 'sync' || busy === 'load'} />}
      </div>
      {error && <div className="review-error" role="alert">{error}<button className="btn ghost" onClick={() => void mutate(async () => { if (id) await api.ensureSessionReview(id, response?.state === 'failed') })}>Retry review</button></div>}
      {!id && catalogue.data !== undefined && <div className="review-panel"><h2>Your next session starts here</h2><p>Select a session to compare your fastest laps with your recent progress.</p>{sessions[0] ? <NavLink className="btn primary" to={`/review/${segment(sessionGroups(sessions)[0].rows[0].session_guid)}`}>Review latest session</NavLink> : <NavLink to="/overview">Sync sessions from Overview</NavLink>}</div>}
      {response?.state === 'failed' && !error && <div className="review-panel" role="alert"><h2>Review processing failed</h2><p>{response.error ?? 'This session could not be measured.'}</p><button className="btn primary" onClick={() => void mutate(() => api.ensureSessionReview(id!, true))}>Retry processing</button></div>}
      {stage && !snapshot && preparing}
      {snapshot && summary && <>
        <div className="review-baseline"><strong>Fastest {summary.fastLapCount} valid {summary.fastLapCount === 1 ? 'lap' : 'laps'}</strong><span>{historyPending ? 'Matching earlier sessions…' : `vs ${snapshot.baseline.length} matched ${snapshot.baseline.length === 1 ? 'session' : 'sessions'}`}</span></div>
        {(snapshot.coverage.downloaded < snapshot.coverage.catalog || snapshot.coverage.failed > 0) && <details className="review-coverage"><summary><span className="reference" role="status">Partial history · {snapshot.coverage.processed}/{snapshot.coverage.downloaded} sessions processed{snapshot.coverage.failed > 0 && ` · ${snapshot.coverage.failed} failed`}</span></summary><p className="review-note">{snapshot.coverage.catalog - snapshot.coverage.downloaded} overviews without telemetry; {snapshot.coverage.failed} processing failures. <NavLink to="/sessions">Download older sessions</NavLink> · <NavLink to="/overview">Sync archive</NavLink></p></details>}
        <div className="review-stat-grid"><MetricCard comparing={historyPending} title="Fast-three pace" value={msToLap(summary.paceMs)} metric={snapshot.pace} format={f.time} note={snapshot.pace.clearChange ? `Clear ${snapshot.pace.clearChange}` : 'Numerical change · limited evidence for a clear trend'} /><MetricCard comparing={historyPending} title="Best eligible lap" value={msToLap(summary.bestLapMs)} metric={snapshot.bestLap} format={f.time} badge={pb && 'PB · matched conditions'} note={pb ? `Faster than your prior PB in the same conditions (${msToLap(snapshot.bestLap.personalBest)}); sessions outside ±5°C or on another surface are not compared.` : undefined} /><MetricCard comparing={historyPending} title="Top speed" value={summary.topSpeedMps == null ? '—' : f.speed(summary.topSpeedMps)} metric={snapshot.topSpeed} format={f.speed} neutral note={`Mean of lap maximum speeds.${summary.peakSpeedMps == null ? '' : ` Peak ${f.speed(summary.peakSpeedMps)} · L${(summary.peakSpeedLap ?? 0) + 1} · ${summary.peakSpeedDistanceM?.toFixed(0)} m`}`} /><MetricCard comparing={historyPending} title="Consistency" value={summary.consistencyMs == null ? '—' : f.time(summary.consistencyMs)} metric={snapshot.consistency} format={f.time} neutral note={`Lap standard deviation · ${summary.representativeCount} representative laps within 5% of best`} /></div>
        {historyPending ? preparing : <>
        <div className="review-highlights">{[{ title: 'Biggest clear gain', row: regionGains[0], className: 'gain' }, { title: 'Biggest clear regression', row: regionLosses[0], className: 'loss' }].map(item => <article className="review-panel" key={item.title}><span className="review-eyebrow">{item.title}</span><h3>{item.row?.region.name ?? 'No clear change yet'}</h3><strong className={item.className}>{item.row ? `${item.row.metrics.timeMs.delta! > 0 ? '+' : ''}${f.time(item.row.metrics.timeMs.delta!)}` : '—'}</strong><small>{item.row ? 'Repeated time change beyond recent variability' : 'Explore all observed changes below.'}</small></article>)}</div>
        {focus && <FocusCard focus={focus} />}
        <SessionNotesPanel key={`notes:${id}`} sessionGuid={id!} />
        <section className="review-panel review-coach"><div className="review-section-heading"><div><span className="review-eyebrow">AI Coach</span><h2>Focus for the next session</h2></div><button className={`btn ask-coach-btn${coaching ? ' is-running' : ''}`} disabled={!!busy || coaching || saving || !!snapshot.coverage.pending} onClick={() => void askCoach()}>{coaching ? 'Coaching…' : response?.coaching?.result ? 'Regenerate coaching' : 'Ask Coach'}</button></div>
          {snapshot.coverage.pending > 0 && <p className="muted">Coaching becomes available when downloaded history finishes processing.</p>}
          {response?.coachingStale && <p className="review-note">This report uses an older review snapshot. Regenerate for updated conditions, laps, or history.</p>}
          {response?.coaching?.error && <p role="alert">{response.coaching.error}</p>}
          {response?.coaching?.result ? <><ReviewCoachContent result={response.coaching.result} evidence={response.coaching.evidence} showRegion={showRegion} /><small>Generated {response.coaching.createdAt} · {response.coaching.model} · {response.coaching.units} units · <NavLink to={`/coach/${segment(response.coaching.id)}`}>Saved report</NavLink></small></> : <p className="muted">Get up to three priorities grounded in this session and your matched history. Coaching runs only when you ask.</p>}
        </section>
        <Regions key={`regions:${id}`} snapshot={snapshot} pick={regionPick} onPick={setRegionPick} panel={regionsPanel} />
        <section className="review-panel"><div className="review-section-heading"><h2>Progress in comparable conditions</h2><NavLink to={`/progress?anchor=${segment(id!)}`}>Explore progress →</NavLink></div><ReviewTrend title="Fast-three pace" secondaryLabel="Best lap" format={msToLap} points={[...snapshot.history, summary].map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.paceMs, secondary: s.bestLapMs }))} /></section>
        <details className="review-panel"><summary><span className="review-eyebrow">Baseline & data quality</span><span>See how this comparison was built</span></summary>
          <p>Comparisons use prior sessions with the same car, layout and surface, within ±5°C (±9°F). Session means are equally weighted. Regional comparisons also require matching meanlines and definitions. “Clear” changes need three current laps, three historical sessions with three laps each, agreement on two current laps, and a delta exceeding both historical variability and the practical threshold (0.30 s for pace; 0.10 s for regions).</p>
          <ul>{summary.qualityNotes.map(n => <li key={n}>{n}</li>)}</ul><h3>Primary baseline</h3>{!snapshot.baseline.length && <p>No earlier comparable sessions. This run starts your progress history.</p>}
          {baselineTemperatures.length > 0 && <p>{snapshot.baseline.reduce((count, s) => count + s.fastLapCount, 0)} selected laps across {snapshot.baseline.length} equally weighted sessions · temperature range {f.tempFromC(Math.min(...baselineTemperatures)).toFixed(1)}–{f.tempFromC(Math.max(...baselineTemperatures)).toFixed(1)}{f.tempUnit}.</p>}
          <ul>{snapshot.baseline.map(s => <li key={s.sessionGuid}><NavLink to={`/review/${segment(s.sessionGuid)}`}>{s.start}</NavLink> · {s.fastLapCount} laps · {s.conditions.surface} ({s.conditions.surfaceSource}) · {s.conditions.temperatureC == null ? 'unknown temperature' : `${f.tempFromC(s.conditions.temperatureC).toFixed(1)}${f.tempUnit}`} · {msToLap(s.paceMs)}</li>)}</ul>
          <details><summary>{snapshot.excludedSessions.length} earlier sessions outside the baseline</summary><ul>{snapshot.excludedSessions.map(s => <li key={s.sessionGuid}>{s.start ?? 'Unknown date'} · {s.reason}</li>)}</ul></details>
        </details>
        <LapControls key={`laps:${id}`} snapshot={snapshot} onSave={mutate} disabled={saving || busy === 'sync' || busy === 'load'} />
        </>}
      </>}
    </div>
}
