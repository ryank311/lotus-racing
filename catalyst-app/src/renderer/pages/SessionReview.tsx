import { useCallback, useEffect, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { segment } from '../routes'
import { useUnits } from '../units'
import { SURFACES, type MetricComparison, type ReviewMetric, type ReviewSnapshot, type ReviewSummary, type SessionReviewResponse, type Surface } from '../../shared/review'
import type { DbSessionRow } from '../../shared/types'
import { ReviewCoachContent, ReviewDeltaBars, ReviewLapScatter, ReviewMap, ReviewMarkers, ReviewTrend } from '../components/ReviewCharts'

export const metricLabels: Record<ReviewMetric, string> = { timeMs: 'Traversal time', vminMps: 'V-min', vminDistanceM: 'V-min location', entryMps: 'Entry speed', exitMps: 'Exit speed', topSpeedMps: 'Top speed', consistencyMs: 'Consistency' }
export function useReviewFormat() {
  const units = useUnits()
  const time = (v: number) => `${(v / 1000).toFixed(2)} s`
  const speed = (v: number) => `${units.speedFromMps(v).toFixed(1)} ${units.speedUnit}`
  const format = (metric: ReviewMetric, v: number) => metric === 'timeMs' || metric === 'consistencyMs' ? time(v) : metric === 'vminDistanceM' ? `${v.toFixed(1)} m` : speed(v)
  return { ...units, time, speed, format }
}
const label = (s: DbSessionRow) => `${s.session_start ?? 'Date unavailable'} · ${s.track_configuration_name || s.track_name || 'Unknown layout'} · ${s.vehicle_model ?? 'Unknown car'}`

function MetricCard({ title, value, metric, format, neutral = false, note }: { title: string; value: string; metric: MetricComparison; format: (n: number) => string; neutral?: boolean; note?: string }) {
  const d = metric.delta
  return <article className="review-stat"><span className="review-eyebrow">{title}</span><strong className="review-stat-value">{value}</strong>
    <span className={neutral ? 'reference' : d == null ? 'muted' : d < 0 ? 'gain' : d > 0 ? 'loss' : 'muted'}>{d == null ? 'No matched baseline' : `${d > 0 ? '+' : ''}${format(d)} vs recent mean`}</span>
    {note && <small>{note}</small>}
    <details><summary>References</summary><div className="review-reference-list"><span>Previous matching session <b>{metric.previous == null ? '—' : format(metric.previous)}</b></span><span>Recent session mean <b>{metric.baseline == null ? '—' : format(metric.baseline)}</b></span>{metric.personalBest != null && <span>Prior matched PB <b>{format(metric.personalBest)}</b></span>}</div></details>
  </article>
}

function Conditions({ summary, onSave, disabled }: { summary: ReviewSummary; onSave: (action: () => Promise<void>) => Promise<void>; disabled: boolean }) {
  const units = useReviewFormat(), c = summary.conditions
  const [surface, setSurface] = useState<Surface>(c.surface)
  const [temperature, setTemperature] = useState(c.temperatureC == null ? '' : units.tempFromC(c.temperatureC).toFixed(1))
  useEffect(() => { setSurface(c.surface); setTemperature(c.temperatureC == null ? '' : units.tempFromC(c.temperatureC).toFixed(1)) }, [c.surface, c.temperatureC, units.system])
  return <details className="review-conditions"><summary><span>{c.surface} <small>({c.surfaceSource})</small></span><span>{c.temperatureC == null ? 'Temperature unknown' : `${units.tempFromC(c.temperatureC).toFixed(1)}${units.tempUnit}`}</span><span className="reference">Edit conditions</span></summary>
    <p>Weather at session start: {c.weather ?? 'unavailable'} · recorded temperature {c.originalTemperatureC == null ? 'unavailable' : `${units.tempFromC(c.originalTemperatureC).toFixed(1)}${units.tempUnit}`}. {c.correctedAt && `Corrected ${c.correctedAt}.`}</p>
    <form className="review-filter-row" onSubmit={e => { e.preventDefault(); const raw = temperature.trim() === '' ? null : Number(temperature); const temperatureC = raw == null ? null : units.system === 'imperial' ? (raw - 32) * 5 / 9 : raw; void onSave(() => api.updateReviewConditions(summary.sessionGuid, { surface, temperatureC })) }}>
      <label>Track surface<select value={surface} onChange={e => setSurface(e.target.value as Surface)}>{SURFACES.map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Ambient temperature ({units.tempUnit})<input type="number" step="0.1" value={temperature} placeholder="Use original reading" onChange={e => setTemperature(e.target.value)} /></label>
      <button className="btn primary" disabled={disabled}>Save conditions</button><button type="button" className="btn ghost" disabled={disabled} onClick={() => void onSave(() => api.updateReviewConditions(summary.sessionGuid, { surface: null, temperatureC: null }))}>Use Garmin estimate</button>
    </form><p className="muted">Matching always uses the same surface and ±5°C (±9°F). Unknown conditions do not form a comparison group.</p>
  </details>
}

function Regions({ snapshot }: { snapshot: ReviewSnapshot }) {
  const f = useReviewFormat()
  const [kind, setKind] = useState<'corner' | 'segment'>(snapshot.regions.some(r => r.region.kind === 'corner') ? 'corner' : 'segment')
  const [metric, setMetric] = useState<ReviewMetric>('timeMs'), [chosen, setChosen] = useState('')
  const rows = snapshot.regions.filter(r => r.region.kind === kind).sort((a, b) => (a.metrics.timeMs.delta ?? Infinity) - (b.metrics.timeMs.delta ?? Infinity))
  const current = rows.find(r => r.region.id === chosen) ?? rows[0], selected = current?.region.id ?? ''
  const regionHistory = current ? snapshot.history.filter(s => current.baselineSessions.includes(s.sessionGuid)) : []
  return <details className="review-panel review-regions" open><summary><span className="review-eyebrow">Corners & segments</span><span>Explore where the time changed</span></summary>
    <div className="review-filter-row"><div className="review-tabs" role="group" aria-label="Region type">{(['corner', 'segment'] as const).map(k => <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); setChosen('') }}>{k === 'corner' ? 'Corners' : 'Segments'}</button>)}</div>
      <label>Metric<select value={metric} onChange={e => setMetric(e.target.value as ReviewMetric)}>{Object.entries(metricLabels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label></div>
    {!rows.length ? <p>No {kind} definitions for this session. <NavLink to="/tracks">Open Tracks</NavLink></p> : <>
      <div className="review-region-visuals"><ReviewMap data={snapshot.current} regions={rows} selected={selected} onSelect={setChosen} /><ReviewDeltaBars rows={rows} metric={metric} selected={selected} onSelect={setChosen} format={v => f.format(metric, v)} /></div>
      <p className="muted">Regions are ranked by traversal-time change.</p>
      {current && <div className="review-region-detail"><h3>{current.region.name}</h3><p className="muted">{current.region.startM.toFixed(0)}–{current.region.endM.toFixed(0)} m · {current.region.count} fast laps · {current.baselineSessions.length} matching regional sessions</p>
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
  const [sessions, setSessions] = useState<DbSessionRow[]>([]), [response, setResponse] = useState<SessionReviewResponse | null>(null)
  const [error, setError] = useState(''), [phase, setPhase] = useState('Loading review…'), [saving, setSaving] = useState(false), [coaching, setCoaching] = useState(false)
  const generation = useRef(0), request = useRef(0), mounted = useRef(true), selectedId = useRef(id)
  selectedId.current = id
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { let cancelled = false; void api.listSessions().then(rows => { if (!cancelled) setSessions(rows) }).catch(e => { if (!cancelled) setError(String(e)) }); return () => { cancelled = true } }, [refreshTick])
  const reload = useCallback(async () => {
    if (!id) return
    const current = ++request.current, token = generation.current
    try { const value = await api.getSessionReview(id); if (mounted.current && token === generation.current && current === request.current) { setResponse(value); setError('') } }
    catch (e) { if (mounted.current && token === generation.current && current === request.current) setError(e instanceof Error ? e.message : String(e)) }
  }, [id])
  useEffect(() => {
    const token = ++generation.current
    setResponse(null); setError(''); setCoaching(false)
    if (!id) return
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
  return <><header className="page-header"><div><h1 className="page-title">Session Review</h1><p className="muted">Understand this run. Prepare for the next.</p></div><NavLink className="btn ghost" to={id ? `/progress?anchor=${segment(id)}` : '/progress'}>Progress history →</NavLink></header>
    <div className="page-body review-page">
      <label className="review-picker">Session<select aria-label="Review session" value={id ?? ''} onChange={e => go(e.target.value ? `/review/${segment(e.target.value)}` : '/review')}><option value="">Choose one session</option>{sessions.map(s => <option key={s.session_guid} value={s.session_guid}>{label(s)}</option>)}</select></label>
      {error && <div className="review-error" role="alert">{error}<button className="btn ghost" onClick={() => void mutate(async () => { if (id) await api.ensureSessionReview(id, response?.state === 'failed') })}>Retry review</button></div>}
      {!id && <div className="review-panel"><h2>Your next session starts here</h2><p>Select a session to compare your fastest laps with your recent progress.</p>{sessions[0] ? <NavLink className="btn primary" to={`/review/${segment(sessions[0].session_guid)}`}>Review latest session</NavLink> : <NavLink to="/overview">Sync sessions from Overview</NavLink>}</div>}
      {id && !error && !snapshot && <div className="review-panel" role={response?.state === 'failed' ? 'alert' : 'status'}><h2>{response?.state === 'failed' ? 'Review processing failed' : response?.state === 'needs-download' ? 'Downloading session telemetry…' : phase}</h2><p>{response?.error ?? 'Your session metrics are prepared in the background. You can keep using the app.'}</p>{response?.state === 'failed' && <button className="btn primary" onClick={() => void mutate(() => api.ensureSessionReview(id, true))}>Retry processing</button>}</div>}
      {snapshot && summary && <>
        <section className="review-session-heading"><span className="review-eyebrow">{summary.vehicle}</span><h2>{summary.track} <span>· {summary.layout}</span></h2><p>{summary.start}</p></section>
        <Conditions key={`conditions:${id}`} summary={summary} onSave={mutate} disabled={saving || busy === 'sync' || busy === 'load'} />
        <div className="review-baseline"><strong>{summary.fastLapCount === 3 ? 'Fastest 3 valid laps' : `Fastest ${summary.fastLapCount} valid lap(s)`}</strong><span>vs {snapshot.baseline.length} prior comparable session(s) · same car, layout and surface · ±5°C</span></div>
        {(snapshot.coverage.pending > 0 || snapshot.coverage.downloaded < snapshot.coverage.catalog || snapshot.coverage.failed > 0) && <div className="review-note" role="status">Partial history: {snapshot.coverage.processed}/{snapshot.coverage.downloaded} downloaded sessions processed; {snapshot.coverage.catalog - snapshot.coverage.downloaded} overviews without telemetry; {snapshot.coverage.failed} processing failures. <NavLink to="/sessions">Download older sessions</NavLink> · <NavLink to="/overview">Sync archive</NavLink></div>}
        <div className="review-stat-grid"><MetricCard title="Fast-three pace" value={msToLap(summary.paceMs)} metric={snapshot.pace} format={f.time} note={snapshot.pace.clearChange ? `Clear ${snapshot.pace.clearChange}` : 'Numerical change · limited evidence for a clear trend'} /><MetricCard title="Best eligible lap" value={msToLap(summary.bestLapMs)} metric={snapshot.bestLap} format={f.time} /><MetricCard title="Top speed · mean lap maximum" value={summary.topSpeedMps == null ? '—' : f.speed(summary.topSpeedMps)} metric={snapshot.topSpeed} format={f.speed} neutral note={summary.peakSpeedMps == null ? undefined : `Peak ${f.speed(summary.peakSpeedMps)} · L${(summary.peakSpeedLap ?? 0) + 1} · ${summary.peakSpeedDistanceM?.toFixed(0)} m`} /><MetricCard title="Consistency · lap σ" value={summary.consistencyMs == null ? '—' : f.time(summary.consistencyMs)} metric={snapshot.consistency} format={f.time} neutral note={`${summary.representativeCount} representative laps within 5% of best`} /></div>
        <div className="review-highlights">{[{ title: 'Biggest clear gain', row: regionGains[0], className: 'gain' }, { title: 'Biggest clear regression', row: regionLosses[0], className: 'loss' }].map(item => <article className="review-panel" key={item.title}><span className="review-eyebrow">{item.title}</span><h3>{item.row?.region.name ?? 'No clear change yet'}</h3><strong className={item.className}>{item.row ? `${item.row.metrics.timeMs.delta! > 0 ? '+' : ''}${f.time(item.row.metrics.timeMs.delta!)}` : '—'}</strong><small>{item.row ? 'Repeated time change beyond recent variability' : 'Explore all observed changes below.'}</small></article>)}</div>
        <section className="review-panel review-coach"><div className="review-section-heading"><div><span className="review-eyebrow">AI Coach</span><h2>Focus for the next session</h2></div><button className="btn primary" disabled={!!busy || coaching || saving || !!snapshot.coverage.pending} onClick={() => void askCoach()}>{coaching ? 'Coaching…' : response?.coaching?.result ? 'Regenerate coaching' : 'Ask Coach'}</button></div>
          {snapshot.coverage.pending > 0 && <p className="muted">Coaching becomes available when downloaded history finishes processing.</p>}
          {response?.coachingStale && <p className="review-note">This report uses an older review snapshot. Regenerate for updated conditions, laps, or history.</p>}
          {response?.coaching?.error && <p role="alert">{response.coaching.error}</p>}
          {response?.coaching?.result ? <><ReviewCoachContent result={response.coaching.result} evidence={response.coaching.evidence} /><small>Generated {response.coaching.createdAt} · {response.coaching.model} · {response.coaching.units} units · <NavLink to={`/coach/${segment(response.coaching.id)}`}>Saved report</NavLink></small></> : <p className="muted">Get up to three priorities grounded in this session and your matched history. Coaching runs only when you ask.</p>}
        </section>
        <Regions key={`regions:${id}`} snapshot={snapshot} />
        <section className="review-panel"><div className="review-section-heading"><h2>Progress in comparable conditions</h2><NavLink to={`/progress?anchor=${segment(id!)}`}>Explore progress →</NavLink></div><ReviewTrend title="Fast-three pace" secondaryLabel="Best lap" format={msToLap} points={[...snapshot.history, summary].map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.paceMs, secondary: s.bestLapMs }))} /></section>
        <details className="review-panel"><summary><span className="review-eyebrow">Baseline & data quality</span><span>See how this comparison was built</span></summary>
          <p>Session means are equally weighted. Regional comparisons also require matching meanlines and definitions. “Clear” changes need three current laps, three historical sessions with three laps each, agreement on two current laps, and a delta exceeding both historical variability and the practical threshold (0.30 s for pace; 0.10 s for regions).</p>
          <ul>{summary.qualityNotes.map(n => <li key={n}>{n}</li>)}</ul><h3>Primary baseline</h3>{!snapshot.baseline.length && <p>No earlier comparable sessions. This run starts your progress history.</p>}
          {baselineTemperatures.length > 0 && <p>{snapshot.baseline.reduce((count, s) => count + s.fastLapCount, 0)} selected laps across {snapshot.baseline.length} equally weighted sessions · temperature range {f.tempFromC(Math.min(...baselineTemperatures)).toFixed(1)}–{f.tempFromC(Math.max(...baselineTemperatures)).toFixed(1)}{f.tempUnit}.</p>}
          <ul>{snapshot.baseline.map(s => <li key={s.sessionGuid}><NavLink to={`/review/${segment(s.sessionGuid)}`}>{s.start}</NavLink> · {s.fastLapCount} laps · {s.conditions.surface} ({s.conditions.surfaceSource}) · {s.conditions.temperatureC == null ? 'unknown temperature' : `${f.tempFromC(s.conditions.temperatureC).toFixed(1)}${f.tempUnit}`} · {msToLap(s.paceMs)}</li>)}</ul>
          <details><summary>{snapshot.excludedSessions.length} earlier sessions outside the baseline</summary><ul>{snapshot.excludedSessions.map(s => <li key={s.sessionGuid}>{s.start ?? 'Unknown date'} · {s.reason}</li>)}</ul></details>
        </details>
        <LapControls key={`laps:${id}`} snapshot={snapshot} onSave={mutate} disabled={saving || busy === 'sync' || busy === 'load'} />
      </>}
    </div></>
}
