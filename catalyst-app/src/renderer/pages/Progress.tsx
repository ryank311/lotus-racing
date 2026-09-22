import { useCallback, useEffect, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { segment } from '../routes'
import { SURFACES, type ProgressResponse, type ReviewSummary, type Surface } from '../../shared/review'
import { ReviewTrend } from '../components/ReviewCharts'
import { ProgressComparison } from '../components/RegionProgressComparison'
import { useReviewFormat } from './SessionReview'

const layoutKey = (s: ReviewSummary) => JSON.stringify([s.account, s.cartographyId, s.configurationId, s.reverse, s.direction])
export function Progress() {
  const { params } = useRoute(), { query } = useNavigation(), f = useReviewFormat()
  const anchor = params.get('anchor'), surface = params.get('surface'), temperature = params.get('temp')
  const [data, setData] = useState<ProgressResponse | null>(null), [error, setError] = useState('')
  const [temperatureDraft, setTemperatureDraft] = useState('')
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const seq = ++sequence.current
    try {
      const result = await api.getProgress({ ...(anchor ? { anchorSessionGuid: anchor } : {}), ...(surface ? { surface: surface as Surface } : {}), ...(temperature !== null ? { temperatureC: Number(temperature) } : {}) })
      if (seq === sequence.current) { setData(result); setError('') }
    } catch (e) { if (seq === sequence.current) setError(e instanceof Error ? e.message : String(e)) }
  }, [anchor, surface, temperature])
  useEffect(() => { setData(null); void load(); return () => { sequence.current++ } }, [load])
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
  return <><header className="page-header"><div><h1 className="page-title">Progress</h1><p className="muted">Your pace, in comparable conditions.</p></div><NavLink to="/review" className="btn ghost">Review a session →</NavLink></header>
    <div className="page-body review-page">
      {error && <div className="review-error" role="alert">{error}<button className="btn ghost" onClick={() => void load()}>Retry progress</button></div>}
      {!data && !error && <p role="status">Loading progress…</p>}
      {data && <>
        <div className="review-filter-row review-panel">
          <label>Vehicle<select value={data.filters.vehicleGuid ?? ''} onChange={e => { const s = [...available].reverse().find(s => s.vehicleGuid === e.target.value); if (s) setAnchor(s.sessionGuid) }}>{!vehicles.length && <option value="">No vehicles yet</option>}{vehicles.map(s => <option key={s.vehicleGuid} value={s.vehicleGuid!}>{s.vehicle}</option>)}</select></label>
          <label>Track / layout<select value={chosenLayout?.sessionGuid ?? ''} onChange={e => setAnchor(e.target.value)}>{!layouts.length && <option value="">No layouts yet</option>}{layouts.map(s => <option key={layoutKey(s)} value={s.sessionGuid}>{s.track} · {s.layout}{s.reverse ? ' · Reverse' : ''}{s.direction ? ` · ${s.direction}` : ''} · {s.account ?? 'Unknown driver'}</option>)}</select></label>
          <label>Surface<select value={data.filters.surface ?? 'unknown'} onChange={e => query({ surface: e.target.value })}>{SURFACES.map(s => <option key={s}>{s}</option>)}</select></label>
          <form className="review-temperature-filter" onSubmit={e => { e.preventDefault(); const n = Number(temperatureDraft); if (temperatureDraft.trim() && Number.isFinite(n)) query({ temp: String(f.system === 'imperial' ? (n - 32) * 5 / 9 : n) }) }}><label>Temperature centre ({f.tempUnit})<input aria-label="Progress temperature centre" type="number" step="0.1" value={temperatureDraft} onChange={e => setTemperatureDraft(e.target.value)} /></label><button className="btn ghost">Apply ±{f.system === 'imperial' ? '9°F' : '5°C'}</button></form>
        </div>
        <p className="review-note">{sessions.length} matching sessions · {data.coverage.processed}/{data.coverage.downloaded} downloaded sessions processed · {data.coverage.catalog - data.coverage.downloaded} overviews without telemetry{data.coverage.failed ? ` · ${data.coverage.failed} processing failures` : ''}. <NavLink to="/sessions">Manage sessions</NavLink></p>
        {!sessions.length ? <div className="review-panel"><h2>{data.coverage.pending ? 'Building your progress history' : 'No comparable sessions yet'}</h2><p>Choose a known vehicle, layout, surface and temperature. Unknown conditions stay outside the comparison group.</p><NavLink to="/review">Review a session and confirm conditions</NavLink></div> : <>
          <section className="review-panel"><div className="review-section-heading"><h2>Lap time progress</h2><span className="muted">Select any point to open its review</span></div>
            <ReviewTrend title="Fast-three pace" secondaryLabel="Best lap" format={msToLap} points={sessions.map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.paceMs, secondary: s.bestLapMs, baseline: ref.get(s.sessionGuid)?.baselineMs, pb: ref.get(s.sessionGuid)?.priorBestMs }))} />
            <p className="muted">Each historical reference uses only earlier matching sessions within ±5°C of that point. Session means carry equal weight.</p>
          </section>
          <ProgressComparison sessions={sessions} scope={JSON.stringify([data.filters.account, data.filters.vehicleGuid, last && layoutKey(last), last?.meanLineGuid, last?.geometryRevision])} />
          <section className="review-panel"><h2>Consistency</h2><p className="muted">Lap standard deviation, across valid laps within 5% of each session’s best.</p><ReviewTrend title="Lap consistency" format={f.time} points={sessions.map(s => ({ id: s.sessionGuid, date: s.start ?? '', value: s.consistencyMs }))} /></section>
          <details className="review-panel"><summary>Session measurements</summary><div className="review-table-wrap"><table className="tbl"><thead><tr><th>Date</th><th>Fast laps</th><th>Pace</th><th>Best</th><th>Surface</th><th>Temperature</th></tr></thead><tbody>{sessions.map(s => <tr key={s.sessionGuid}><td><NavLink to={`/review/${segment(s.sessionGuid)}`}>{s.start}</NavLink></td><td>{s.fastLapCount}</td><td>{msToLap(s.paceMs)}</td><td>{msToLap(s.bestLapMs)}</td><td>{s.conditions.surface} ({s.conditions.surfaceSource})</td><td>{s.conditions.temperatureC == null ? '—' : `${f.tempFromC(s.conditions.temperatureC).toFixed(1)}${f.tempUnit}`}</td></tr>)}</tbody></table></div></details>
        </>}
      </>}
    </div></>
}
