import { useResource } from '../useResource'
import { InlineLoadStatus } from '../components/Loading'
import { PreparingPanel } from '../components/Preparing'
import { useEffect, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { segment } from '../routes'
import { SURFACES, type ReviewSummary, type Surface } from '../../shared/review'
import { ReviewTrend } from '../components/ReviewCharts'
import { ProgressComparison } from '../components/RegionProgressComparison'
import { useReviewFormat } from './SessionReview'
import { startLabel } from '../components/reviewTimeline'
import './review-extras.css'

const layoutKey = (s: ReviewSummary) => JSON.stringify([s.account, s.cartographyId, s.configurationId, s.reverse, s.direction])
export function Progress() {
  const { params } = useRoute(), { query } = useNavigation(), f = useReviewFormat()
  const anchor = params.get('anchor'), surface = params.get('surface'), temperature = params.get('temp')
  const resource = useResource(() => api.getProgress({ ...(anchor ? { anchorSessionGuid: anchor } : {}), ...(surface ? { surface: surface as Surface } : {}), ...(temperature !== null ? { temperatureC: Number(temperature) } : {}) }), JSON.stringify([anchor, surface, temperature]))
  const { data, error, reload: load } = resource
  const [temperatureDraft, setTemperatureDraft] = useState('')
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.onReviewStatus(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 200) })
    return () => { clearTimeout(timer); off() }
  }, [load])
  useEffect(() => { if (!data?.coverage.pending) return; const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer) }, [data?.coverage.pending, load])
  useEffect(() => { setTemperatureDraft(data?.filters.temperatureC == null ? '' : f.tempFromC(data.filters.temperatureC).toFixed(1)) }, [data?.filters.temperatureC, f.system])
  const available = data?.available ?? [], sessions = data?.sessions ?? []
  const vehicles = [...new Map(available.filter(s => s.vehicleGuid).map(s => [s.vehicleGuid!, s])).values()]
  const layouts = [...new Map(available.filter(s => s.vehicleGuid === data?.filters.vehicleGuid).map(s => [layoutKey(s), s])).values()]
  const chosenLayout = layouts.find(s => s.account === data?.filters.account && s.cartographyId === data?.filters.cartographyId && s.configurationId === data?.filters.configurationId && s.reverse === data?.filters.reverse && s.direction === data?.filters.direction)
  const last = sessions.at(-1)
  const ref = new Map(data?.references.map(r => [r.sessionGuid, r]))
  const setAnchor = (id: string) => { query({ anchor: id, surface: null, temp: null }) }
  // The anchor is the session whose filters are shown: the explicit one, else the latest session with this vehicle and layout.
  const sameLayout = (s: ReviewSummary) => s.vehicleGuid === data?.filters.vehicleGuid && s.account === data?.filters.account && s.cartographyId === data?.filters.cartographyId && s.configurationId === data?.filters.configurationId && s.reverse === data?.filters.reverse && s.direction === data?.filters.direction
  const anchorSession = available.find(s => s.sessionGuid === data?.filters.anchorSessionGuid) ?? [...available].reverse().find(s => sameLayout(s) && (data?.filters.surface === 'any' || s.conditions.surface === data?.filters.surface)) ?? [...available].reverse().find(sameLayout)
  const centreSource = [anchorSession, ...[...sessions].reverse()].find(s => s?.conditions.temperatureC != null)
  const centreC = temperature === null ? null : Number(temperature)
  const fromSession = centreC === null ? undefined : [anchorSession, ...[...sessions].reverse()].find(s => s?.conditions.temperatureC != null && Math.abs(s.conditions.temperatureC - centreC) < .05)
  const centreLabel = centreC === null ? '' : `${f.tempFromC(centreC).toFixed(1)}${f.tempUnit} ${fromSession ? `from ${fromSession === anchorSession ? 'anchor session ' : ''}${startLabel(fromSession.start, false)}` : !centreSource && centreC === 20 ? '(default; no session temperature recorded)' : 'set manually'}`
  const band = `±${f.system === 'imperial' ? '9°F' : '5°C'}`
  // While sessions are still being measured the trends would redraw as each
  // one lands; show real progress instead and plot once history is complete.
  const measuring = !!data && data.coverage.pending > 0
  const [preparingSince, setPreparingSince] = useState<number | undefined>(undefined)
  useEffect(() => { setPreparingSince(resource.initialLoading || measuring ? Date.now() : undefined) }, [resource.initialLoading || measuring])
  return <div className="page-body review-page">
      <header className="review-page-header"><div className="page-eyebrow">// performance history</div><h1 className="page-title">Pro<span className="accent">gress</span></h1></header>
      <InlineLoadStatus label="progress" pending={resource.pending && !resource.initialLoading && !measuring} error={error} hasData={!!data} onRetry={load} />
      {resource.initialLoading && <PreparingPanel standalone delayMs={250} eyebrow="progress" title="Loading your progress history" detail="Measured sessions for this car and layout, matched by surface and temperature." status="Loading measured sessions…" steps={[]} startedAt={preparingSince} />}
      {data && <>
        <details className="review-context-picker review-progress-filters" open={!sessions.length}>
          <summary><span className="review-context-label"><strong>{chosenLayout ? `${chosenLayout.track} · ${chosenLayout.layout}` : 'Choose a comparison'}</strong><span>{vehicles.find(s => s.vehicleGuid === data.filters.vehicleGuid)?.vehicle ?? 'No vehicle'} · {data.filters.surface === 'any' ? 'any surface' : data.filters.surface ?? 'unknown'} · {temperature === null ? 'All temperatures' : `${band} centred on ${centreLabel}`}</span></span><span className="reference">Filters</span></summary>
          <div className="review-filter-row">
          <label>Vehicle<select value={data.filters.vehicleGuid ?? ''} onChange={e => { const s = [...available].reverse().find(s => s.vehicleGuid === e.target.value); if (s) setAnchor(s.sessionGuid) }}>{!vehicles.length && <option value="">No vehicles yet</option>}{vehicles.map(s => <option key={s.vehicleGuid} value={s.vehicleGuid!}>{s.vehicle}</option>)}</select></label>
          <label>Track / layout<select value={chosenLayout?.sessionGuid ?? ''} onChange={e => setAnchor(e.target.value)}>{!layouts.length && <option value="">No layouts yet</option>}{layouts.map(s => <option key={layoutKey(s)} value={s.sessionGuid}>{s.track} · {s.layout}{s.reverse ? ' · Reverse' : ''}{s.direction ? ` · ${s.direction}` : ''} · {s.account ?? 'Unknown driver'}</option>)}</select></label>
          <label>Surface<select value={data.filters.surface ?? 'unknown'} onChange={e => query({ surface: e.target.value })}><option value="any">Any surface</option>{SURFACES.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Temperature comparison<select aria-label="Temperature comparison" value={temperature === null ? 'all' : 'matched'} onChange={e => query({ temp: e.target.value === 'all' ? null : String(centreSource?.conditions.temperatureC ?? 20) })}><option value="all">All temperatures</option><option value="matched">Within {band}</option></select></label>
          {temperature !== null && <form className="review-temperature-filter" onSubmit={e => { e.preventDefault(); const n = Number(temperatureDraft); if (temperatureDraft.trim() && Number.isFinite(n)) query({ temp: String(f.system === 'imperial' ? (n - 32) * 5 / 9 : n) }) }}><label>Temperature centre ({f.tempUnit})<input aria-label="Progress temperature centre" type="number" required min={f.system === 'imperial' ? -76 : -60} max={f.system === 'imperial' ? 158 : 70} step="0.1" value={temperatureDraft} onChange={e => setTemperatureDraft(e.target.value)} /></label><button className="btn ghost">Apply {band}</button></form>}
          {temperature !== null && <p className="review-temperature-source">Centred on {centreLabel}{!fromSession && anchorSession?.conditions.temperatureC != null ? ` · anchor session ${startLabel(anchorSession.start, false)} recorded ${f.tempFromC(anchorSession.conditions.temperatureC).toFixed(1)}${f.tempUnit}` : ''}</p>}
          </div>
        </details>
        <details className="review-coverage"><summary>{sessions.length} matching sessions{(data.coverage.pending > 0 || data.coverage.downloaded < data.coverage.catalog || data.coverage.failed > 0) && <span className="reference"> · Partial history</span>}<span className="muted"> · Data coverage</span></summary><p className="review-note">{data.coverage.processed}/{data.coverage.downloaded} downloaded sessions processed · {data.coverage.catalog - data.coverage.downloaded} overviews without telemetry{data.coverage.failed ? ` · ${data.coverage.failed} processing failures` : ''}. <NavLink to="/sessions">Manage sessions</NavLink></p></details>
        {measuring ? <PreparingPanel standalone eyebrow="progress" title="Building your progress history"
            detail="Each downloaded session is measured once: lap validity, corner and segment times, and conditions. Trends appear when every session is in."
            progress={{ done: data.coverage.processed, total: data.coverage.downloaded, label: `${data.coverage.processed} of ${data.coverage.downloaded} sessions measured` }}
            startedAt={preparingSince}
            steps={[
              { label: 'Measure downloaded sessions', detail: `${data.coverage.processed} of ${data.coverage.downloaded} done${data.coverage.failed ? ` · ${data.coverage.failed} failed` : ''}`, state: 'active' },
              { label: 'Match comparable sessions', detail: 'Same car, layout and surface; optional temperature window', state: 'waiting' },
              { label: 'Plot trends', detail: 'Pace, corners and segments, consistency', state: 'waiting' },
            ]} /> : !sessions.length ? <div className="review-panel"><h2>No comparable sessions yet</h2><p>Choose a known vehicle, layout and surface (or Any surface), or widen the optional temperature filter. All temperatures includes sessions without a recorded temperature.</p><NavLink to="/review">Review a session and confirm conditions</NavLink></div> : <>
          <section className="review-panel"><div className="review-section-heading"><h2>Lap time progress</h2><span className="muted">Select any point to open its review</span></div>
            <ReviewTrend title="Fast-three pace" secondaryLabel="Best lap" format={msToLap} points={sessions.map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.paceMs, secondary: s.bestLapMs, baseline: ref.get(s.sessionGuid)?.baselineMs, pb: ref.get(s.sessionGuid)?.priorBestMs }))} />
            <details className="review-method"><summary>How comparisons work</summary><p className="muted">Historical references use earlier sessions with the same comparison filters{data.filters.surface === 'any' ? ' on every surface' : ''}{temperature === null ? ', across all temperatures (including unrecorded temperatures)' : `, within ${band} of ${centreLabel}`}. Session means carry equal weight.</p></details>
          </section>
          <ProgressComparison sessions={sessions} scope={JSON.stringify([data.filters.account, data.filters.vehicleGuid, last && layoutKey(last), last?.meanLineGuid, last?.geometryRevision])} />
          <section className="review-panel"><h2>Consistency</h2><p className="muted">Lap standard deviation, across valid laps within 5% of each session’s best.</p><ReviewTrend title="Lap consistency" format={f.time} points={sessions.map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.consistencyMs }))} /></section>
          <details className="review-panel"><summary>Session measurements</summary><div className="review-table-wrap"><table className="tbl"><thead><tr><th>Date</th><th>Fast laps</th><th>Pace</th><th>Best</th><th>Surface</th><th>Temperature</th></tr></thead><tbody>{sessions.map(s => <tr key={s.sessionGuid}><td><NavLink to={`/review/${segment(s.sessionGuid)}`}>{s.start}</NavLink></td><td>{s.fastLapCount}</td><td>{msToLap(s.paceMs)}</td><td>{msToLap(s.bestLapMs)}</td><td>{s.conditions.surface} ({s.conditions.surfaceSource})</td><td>{s.conditions.temperatureC == null ? '—' : `${f.tempFromC(s.conditions.temperatureC).toFixed(1)}${f.tempUnit}`}</td></tr>)}</tbody></table></div></details>
        </>}
      </>}
    </div>
}
