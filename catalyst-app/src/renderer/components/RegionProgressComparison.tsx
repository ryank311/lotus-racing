import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { REVIEW_METRICS, type ReviewSummary } from '../../shared/review'
import { NavLink } from '../navigation'
import { segment } from '../routes'
import { metricLabels, useReviewFormat } from '../pages/SessionReview'
import { ChartExpandButton, ChartSurface } from './ChartSurface'
import { reviewTimeline } from './reviewTimeline'
import { comparisonValues, metricFamily, plotKey, type ProgressPlot } from './progressComparisonData'

const colors = ['#7dd3fc', '#ff825e', '#c4a1ff', '#f6ce64', '#5cddbd', '#f99dce', '#a8c978', '#afbfff']
const dashes = ['', '8 4', '2 4', '10 3 2 3']
const title = 'Corner / segment progress'

export function ProgressComparison({ sessions, scope }: { sessions: ReviewSummary[]; scope: string }) {
  return <ChartSurface title={title}><ComparisonWorkspace key={scope} sessions={sessions} scope={scope} /></ChartSurface>
}

function ComparisonWorkspace({ sessions, scope }: { sessions: ReviewSummary[]; scope: string }) {
  const f = useReviewFormat(), latest = sessions.at(-1)
  const regions = latest?.regions ?? []
  const storageKey = `catalyst:progress-plots:${scope}`
  const [plots, setPlots] = useState<ProgressPlot[]>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      if (Array.isArray(saved)) return saved.filter((p): p is ProgressPlot => p && typeof p.regionId === 'string' && REVIEW_METRICS.includes(p.metric) && regions.some(r => r.id === p.regionId))
    } catch { /* Storage is optional. */ }
    return regions.slice(0, 2).map(r => ({ regionId: r.id, metric: 'timeMs' }))
  })
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(plots)) } catch { /* Storage is optional. */ } }, [storageKey, plots])
  const [hidden, setHidden] = useState<string[]>([])
  const [scale, setScale] = useState<'actual' | 'relative'>('actual')
  const [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false), [datesOpen, setDatesOpen] = useState(false), [helpOpen, setHelpOpen] = useState(false)
  const controlId = useId()
  const [selected, setSelected] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const compatible = sessions.filter(s => s.meanLineGuid && s.meanLineGuid === latest?.meanLineGuid && s.geometryRevision === latest?.geometryRevision)
  const filtered = compatible.filter(s => (!from || !!s.start && s.start.slice(0, 10) >= from) && (!to || !!s.start && s.start.slice(0, 10) <= to))
  const active = plots.filter(p => regions.some(r => r.id === p.regionId))
  const visible = active.filter(p => !hidden.includes(plotKey(p)))
  const mixed = new Set(visible.map(p => metricFamily(p.metric))).size > 1
  const relative = scale === 'relative' || mixed
  const series = visible.map(p => {
    const index = active.findIndex(a => plotKey(a) === plotKey(p))
    return { ...p, key: plotKey(p), label: `${regions.find(r => r.id === p.regionId)?.name} · ${metricLabels[p.metric]}`, color: colors[index % colors.length], dash: dashes[Math.floor(index / colors.length) % dashes.length], ...comparisonValues(filtered, p, relative) }
  })
  const all = series.flatMap(s => s.values).filter((v): v is number => v !== null)
  const low = Math.min(...all, ...(relative ? [0] : [])), high = Math.max(...all, ...(relative ? [0] : []))
  const pad = all.length ? Math.max((high - low) * .12, Math.abs(high) * .005, .01) : 1
  const min = all.length ? low - pad : 0, span = all.length ? high - low + pad * 2 : 1
  const timeline = reviewTimeline(filtered.map(s => s.start ?? ''), width)
  const height = 390, top = 30, bottom = 310
  const y = (value: number) => bottom - (value - min) / span * (bottom - top)
  const axis = (value: number) => relative ? `${value > 0 ? '+' : ''}${value.toFixed(1)}%` : f.format(visible[0]?.metric ?? 'timeMs', value)
  const inspectedIndex = Math.max(0, filtered.findIndex(s => s.sessionGuid === selected))
  const inspected = filtered[inspectedIndex]
  const togglePlot = (plot: ProgressPlot) => {
    const key = plotKey(plot)
    setPlots(previous => previous.some(p => plotKey(p) === key) ? previous.filter(p => plotKey(p) !== key) : [...previous, plot])
    setHidden(previous => previous.filter(k => k !== key))
  }
  return <section className="review-panel progress-comparison">
    <div className="review-section-heading progress-heading"><h2>{title}</h2><span className="progress-count">{filtered.length} sessions · {visible.length} plots</span><ChartExpandButton title={title} /></div>
    <div className="progress-controls">
      <button type="button" className="progress-control progress-choose" aria-expanded={pickerOpen} aria-controls={`${controlId}-plots`} onClick={() => setPickerOpen(v => !v)}>Choose plots <span>{active.length}</span></button>
      <div className="review-tabs" role="group" aria-label="Comparison scale"><button type="button" className={!relative ? 'active' : ''} aria-pressed={!relative} disabled={mixed} title={mixed ? 'Mixed units require percentage change' : 'Use a shared axis in the original units'} onClick={() => setScale('actual')}>Actual values</button><button type="button" className={relative ? 'active' : ''} aria-pressed={relative} onClick={() => setScale('relative')}>Change %</button></div>
      <button type="button" className="progress-control" aria-expanded={datesOpen} aria-controls={`${controlId}-dates`} onClick={() => setDatesOpen(v => !v)}>{from || to ? `${from || 'Start'} → ${to || 'Latest'}` : 'All dates'} <span aria-hidden="true">▾</span></button>
      <button type="button" className="progress-control progress-help" aria-label="About comparison scales" aria-expanded={helpOpen} aria-controls={`${controlId}-help`} onClick={() => setHelpOpen(v => !v)}>ⓘ{mixed && <span>Mixed units</span>}</button>
    </div>
    <div className="progress-picker" id={`${controlId}-plots`} hidden={!pickerOpen}><div className="review-section-heading"><label>Find a region<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Corner or segment name" /></label><button className="btn ghost" disabled={!active.length} onClick={() => { setPlots([]); setHidden([]) }}>Clear plots</button></div><p className="muted">Select any cell to add or remove a plot. Tap a legend label to temporarily hide it.</p><div className="progress-matrix-wrap" tabIndex={0} role="region" aria-label="Choose region and metric plots"><table className="progress-matrix"><thead><tr><th scope="col">Region</th>{REVIEW_METRICS.map(metric => <th scope="col" key={metric}>{metricLabels[metric]}</th>)}</tr></thead><tbody>{regions.filter(r => r.name.toLowerCase().includes(search.toLowerCase())).map(region => <tr key={region.id}><th scope="row">{region.name}<small>{region.kind}</small></th>{REVIEW_METRICS.map(metric => {
      const plot = { regionId: region.id, metric }, index = active.findIndex(p => plotKey(p) === plotKey(plot)), chosen = index >= 0
      return <td key={metric}><button type="button" aria-label={`${region.name} · ${metricLabels[metric]}`} aria-pressed={chosen} style={chosen ? { '--plot-color': colors[index % colors.length] } as CSSProperties : undefined} onClick={() => togglePlot(plot)}>{chosen ? '✓' : '+'}</button></td>
    })}</tr>)}</tbody></table></div>{!regions.some(r => r.name.toLowerCase().includes(search.toLowerCase())) && <p className="muted">No matching regions.</p>}</div>
    <div className="progress-date-filters" id={`${controlId}-dates`} hidden={!datesOpen}>
      <label>From<input type="date" aria-label="Comparison from date" value={from} max={to || undefined} onChange={e => { setFrom(e.target.value); setSelected(null) }} /></label>
      <label>Through<input type="date" aria-label="Comparison through date" value={to} min={from || undefined} onChange={e => { setTo(e.target.value); setSelected(null) }} /></label>
      {(from || to) && <button className="btn ghost" onClick={() => { setFrom(''); setTo('') }}>Reset dates</button>}
      <button className="btn ghost" onClick={() => setDatesOpen(false)}>Done</button>
    </div>
    <p className="progress-scale-note progress-help-text" id={`${controlId}-help`} hidden={!helpOpen}>{relative ? `${mixed ? 'Mixed units use percentage change. ' : ''}Each plot starts at its first measured value in this date range. Negative = lower, positive = higher; speed changes are neutral.` : 'Plots with the same units share an axis. Add metrics with different units to compare percentage change.'}</p>
    <div className="progress-plot-legend" aria-label="Selected plots">{active.map((plot, index) => {
      const key = plotKey(plot), label = `${regions.find(r => r.id === plot.regionId)?.name} · ${metricLabels[plot.metric]}`, shown = !hidden.includes(key)
      return <button key={key} type="button" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${label}`} style={{ '--plot-color': colors[index % colors.length] } as CSSProperties} onClick={() => setHidden(previous => shown ? [...previous, key] : previous.filter(k => k !== key))}><svg width="24" height="8" aria-hidden="true"><line x1="0" x2="24" y1="4" y2="4" stroke="currentColor" strokeWidth="3" strokeDasharray={dashes[Math.floor(index / colors.length) % dashes.length]} /></svg>{label}</button>
    })}</div>
    <div ref={container} className="progress-chart">
      {!filtered.length || !all.length ? <div className="progress-empty" role="status"><strong>{!filtered.length ? 'No sessions in this comparison' : !visible.length ? 'Choose plots to start comparing' : 'No plottable measurements'}</strong><p>{!filtered.length ? 'Try a wider date range. Regional history requires matching track geometry.' : !visible.length ? 'Use Choose plots above, or show a hidden plot.' : 'Missing values leave gaps. Percentage change is unavailable when a plot starts at zero; try actual values with matching units.'}</p></div> : <div className="review-trend-scroll" role="region" aria-label="Regional comparison timeline" tabIndex={0}>
        <svg width={timeline.width} height={height} viewBox={`0 0 ${timeline.width} ${height}`} role="group" aria-label="Overlaid regional progress plots">
          {timeline.groups.map((g, i) => <rect key={g.start} x={timeline.positions[g.start] - 10} y={top} width={timeline.positions[g.end] - timeline.positions[g.start] + 20} height={bottom - top} fill="var(--text-dim)" opacity={i % 2 ? .05 : .025} />)}
          {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1="88" x2={timeline.width - 48} y1={y(min + span * t)} y2={y(min + span * t)} stroke="var(--border)" /><text x="78" y={y(min + span * t) + 4} textAnchor="end">{axis(min + span * t)}</text></g>)}
          {relative && <line x1="88" x2={timeline.width - 48} y1={y(0)} y2={y(0)} stroke="var(--text-dim)" strokeDasharray="4 5" />}
          {timeline.breaks.map(gap => <g key={gap.before}><line x1={gap.x} x2={gap.x} y1={top} y2={bottom} stroke="var(--border-strong)" strokeDasharray="3 5" /><text x={gap.x} y="18" textAnchor="middle">{gap.label}</text></g>)}
          {series.map(s => {
            let previous = false
            const path = s.values.map((v, i) => { if (v === null) { previous = false; return '' }; const command = previous ? 'L' : 'M'; previous = true; return `${command}${timeline.positions[i]},${y(v)}` }).join(' ')
            return <g key={s.key} aria-label={s.label}><path d={path} fill="none" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} />{s.values.map((v, i) => v === null ? null : <circle key={i} cx={timeline.positions[i]} cy={y(v)} r={i === inspectedIndex ? 5 : 3.5} fill={s.color} />)}</g>
          })}
          <line x1={timeline.positions[inspectedIndex]} x2={timeline.positions[inspectedIndex]} y1={top} y2={bottom} stroke="var(--text-dim)" opacity=".5" />
          {filtered.map((session, i) => <rect key={session.sessionGuid} x={timeline.positions[i] - 12} y={top} width="24" height={bottom - top} fill="transparent" role="button" tabIndex={0} aria-label={`Inspect session ${i + 1}, ${session.start ?? 'date unknown'}`} aria-pressed={i === inspectedIndex} className="progress-inspect" onClick={() => setSelected(session.sessionGuid)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(session.sessionGuid) } }} />)}
          {timeline.groups.map(group => <g key={group.start}><path d={`M${timeline.positions[group.start]},320 v5 H${timeline.positions[group.end]} v-5`} fill="none" stroke="var(--border-strong)" /><text x={(timeline.positions[group.start] + timeline.positions[group.end]) / 2} y="348" textAnchor="middle">{group.label}</text><text x={(timeline.positions[group.start] + timeline.positions[group.end]) / 2} y="366" textAnchor="middle">{group.year}</text></g>)}
        </svg>
      </div>}
    </div>
    <div className="review-time-axis-note"><span>Sessions in date order · time gaps compressed · tap a session to inspect</span>{timeline.width > width && <span>Scroll chart to see all sessions ↔</span>}</div>
    {inspected && series.length > 0 && <div className="progress-readout" aria-live="polite"><div className="review-section-heading"><label>Inspect session<select value={inspected.sessionGuid} onChange={e => setSelected(e.target.value)}>{filtered.map((s, i) => <option key={s.sessionGuid} value={s.sessionGuid}>{i + 1} · {s.start ?? 'Date unknown'}</option>)}</select></label><NavLink to={`/review/${segment(inspected.sessionGuid)}`}>Open session review →</NavLink></div><div className="progress-readout-values">{series.map(s => <div key={s.key} style={{ borderColor: s.color }}><span>{s.label}</span><strong>{s.raw[inspectedIndex] === null ? '—' : f.format(s.metric, s.raw[inspectedIndex]!)}</strong>{relative && <small>{s.values[inspectedIndex] === null ? 'Change unavailable' : `${axis(s.values[inspectedIndex]!)} change`} · baseline {s.baseline === null ? 'unavailable' : `${f.format(s.metric, s.baseline)} (${filtered[s.baselineIndex]?.start ?? 'date unknown'})`}</small>}</div>)}</div></div>}

    <p className="progress-scale-note">{compatible.length} of {sessions.length} matching sessions share the latest session’s meanline and corner/segment definitions. Missing measurements leave gaps.</p>
  </section>
}
