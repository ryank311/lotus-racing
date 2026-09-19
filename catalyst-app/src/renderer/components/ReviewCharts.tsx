import { useNavigation } from '../navigation'
import { useEffect, useRef, useState } from 'react'
import { segment } from '../routes'
import type { ReviewAggregate, ReviewMetric, ReviewRegionComparison, ReviewCoachResult, ReviewLap } from '../../shared/review'
import { msToLap } from '../api'
import { reviewTimeline } from './reviewTimeline'

export function ReviewMarkers({ current, baseline, format }: { current: number | null; baseline: number | null; format: (v: number) => string }) {
  if (current == null || baseline == null) return null
  const low = Math.min(current, baseline), spread = Math.max(Math.abs(current - baseline), .001)
  const position = (v: number) => 15 + (v - low) / spread * 70
  return <div className="review-markers" role="img" aria-label={`Current ${format(current)}; baseline ${format(baseline)}`}>
    <i title={`Baseline ${format(baseline)}`} className="baseline" style={{ left: `${position(baseline)}%` }} />
    <i title={`Current ${format(current)}`} className="current" style={{ left: `${position(current)}%` }} />
  </div>
}

export function ReviewLapScatter({ laps }: { laps: ReviewLap[] }) {
  const values = laps.map(l => l.durationMs).filter(v => Number.isFinite(v) && v > 0)
  if (!values.length) return <p>No lap times available.</p>
  const min = Math.min(...values), range = Math.max(Math.max(...values) - min, 1000)
  const width = Math.max(330, laps.length * 40 + 90), y = (v: number) => 165 - (v - min) / range * 125
  return <div className="review-lap-scatter"><svg viewBox={`0 0 ${width} 210`} style={{ minWidth: width }} role="group" aria-label="Lap time scatter. Orange marks selected fast laps.">
    {[min, min + range].map(v => <g key={v}><text x="72" y={y(v) + 4} textAnchor="end">{msToLap(v)}</text><line x1="80" x2={width - 10} y1={y(v)} y2={y(v)} stroke="var(--border)" /></g>)}
    {laps.map((l, i) => <g key={l.index}><title>{`Lap ${l.index + 1}: ${msToLap(l.durationMs)}. ${l.reasons.join(', ') || (l.selected ? 'Fast sample' : 'Eligible')}`}</title>
      {Number.isFinite(l.durationMs) && l.durationMs > 0 && <circle cx={100 + i * 40} cy={y(l.durationMs)} r="5" fill={l.selected ? 'var(--signal)' : l.eligible ? 'var(--cyan)' : 'var(--text-mute)'} />}
      <text x={100 + i * 40} y="194" textAnchor="middle">L{l.index + 1}</text>
    </g>)}
  </svg></div>
}

export interface TrendPoint { id: string; date: string; value: number | null; secondary?: number | null; baseline?: number | null; pb?: number | null }
export function ReviewTrend({ points, format, title, secondaryLabel, onSelect }: {
  points: TrendPoint[]; format: (n: number) => string; title: string; secondaryLabel?: string; onSelect?: (id: string) => void
}) {
  const { go } = useNavigation()
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const all = points.flatMap(p => [p.value, p.secondary, p.baseline, p.pb]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!all.length) return <div ref={container}><p className="muted">No measurements available for this trend.</p></div>
  const low = Math.min(...all), high = Math.max(...all), pad = Math.max((high - low) * .15, 0.1)
  const min = low - pad, span = high - low + pad * 2
  const timeline = reviewTimeline(points.map(p => p.date), width)
  const x = (i: number) => timeline.positions[i]
  const y = (v: number) => 185 - (v - min) / span * 155
  const line = (key: 'value' | 'secondary' | 'baseline' | 'pb') => {
    let previous = false
    return points.map((p, i) => { const v = p[key]; if (v == null || !Number.isFinite(v)) { previous = false; return '' }; const command = previous ? 'L' : 'M'; previous = true; return `${command}${x(i)},${y(v)}` }).join(' ')
  }
  const open = (id: string) => onSelect ? onSelect(id) : go(`/review/${segment(id)}`)
  return <div ref={container} className="review-trend">
    <div className="review-trend-scroll" role="region" aria-label={`${title} session timeline`} tabIndex={timeline.width > width ? 0 : undefined}>
      <svg viewBox={`0 0 ${timeline.width} 250`} style={{ minWidth: timeline.width }} role="group" aria-label={title}>
        {timeline.groups.map((group, i) => <rect key={group.start} x={x(group.start) - 9} y="25" width={x(group.end) - x(group.start) + 18} height="165" fill="var(--text-dim)" opacity={i % 2 ? .045 : .025} />)}
        {[0, .5, 1].map(f => <g key={f}><line x1="85" x2={timeline.width - 30} y1={y(min + span * f)} y2={y(min + span * f)} stroke="var(--border)" /><text x="78" y={y(min + span * f) + 4} textAnchor="end">{format(min + span * f)}</text></g>)}
        {timeline.breaks.map(gap => <g key={gap.before} className="review-time-break">
          <title>{gap.days === null ? 'Date unavailable' : `${gap.days} days between session dates; gap compressed`}</title>
          <line x1={gap.x} x2={gap.x} y1="27" y2="190" stroke="var(--border-strong)" strokeDasharray="3 5" />
          <text x={gap.x} y="17" textAnchor="middle">{gap.label}</text>
          <path d={`M${gap.x - 6},199 l4,-8 m2,8 l4,-8`} fill="none" stroke="var(--text-dim)" />
        </g>)}
        <path d={line('baseline')} fill="none" stroke="var(--text-dim)" strokeDasharray="6 4" strokeWidth="2" />
        <path d={line('pb')} fill="none" stroke="var(--green)" strokeDasharray="2 5" strokeWidth="2" />
        <path d={line('secondary')} fill="none" stroke="var(--cyan)" strokeWidth="2" />
        <path d={line('value')} fill="none" stroke="var(--signal)" strokeWidth="2.5" />
        {points.map((p, i) => p.value == null ? null : <g key={p.id} role="link" tabIndex={0} aria-label={`${p.date}: ${format(p.value)}. Open session review`}
          onClick={() => open(p.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p.id) } }} className="review-trend-point">
          <title>{p.date}: {format(p.value)}</title><circle cx={x(i)} cy={y(p.value)} r="13" fill="transparent" /><circle cx={x(i)} cy={y(p.value)} r="4" fill="var(--signal)" />
        </g>)}
        {timeline.groups.map(group => <g key={group.start} className="review-date-range">
          <path d={`M${x(group.start)},195 v5 H${x(group.end)} v-5`} fill="none" stroke="var(--border-strong)" />
          <text x={(x(group.start) + x(group.end)) / 2} y="217" textAnchor="middle">{group.label}</text>
          <text x={(x(group.start) + x(group.end)) / 2} y="234" textAnchor="middle">{group.year}</text>
        </g>)}
      </svg>
    </div>
    <div className="review-time-axis-note"><span>Sessions in date order · time gaps compressed</span>{timeline.width > width && <span>Scroll to see all sessions ↔</span>}</div>
    <div className="review-legend"><span>● {title}</span>{secondaryLabel && <span className="reference">● {secondaryLabel}</span>}{points.some(p => p.baseline != null) && <span>┄ Prior five-session mean</span>}{points.some(p => p.pb != null) && <span className="gain">┄ Prior matched PB</span>}</div>
  </div>
}

export function ReviewMap({ data, regions, selected, onSelect }: { data: ReviewAggregate; regions: ReviewRegionComparison[]; selected: string; onSelect: (id: string) => void }) {
  if (data.map.length < 2) return <p className="muted">Track geometry unavailable.</p>
  const xs = data.map.map(p => p.x), ys = data.map.map(p => p.y)
  const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX, height = Math.max(...ys) - minY
  const pad = Math.max(width, height) * .09, view = [minX - pad, minY - pad, width + 2 * pad, height + 2 * pad].join(' ')
  const scale = Math.max(width, height), stroke = scale / 140
  return <svg className="review-map" viewBox={view} role="group" aria-label="Track time changes. Select a highlighted region for details.">
    <polyline points={data.map.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} />
    {regions.map(({ region, metrics }) => {
      const pts = data.map.filter(p => p.dist >= region.startM && p.dist <= region.endM)
      const delta = metrics.timeMs.delta, color = delta == null ? 'var(--text-mute)' : delta < 0 ? 'var(--green)' : delta > 0 ? 'var(--red)' : 'var(--cyan)'
      return <g key={region.id} role="button" tabIndex={0} aria-label={`${region.name}, ${delta == null ? 'no baseline' : `${(delta / 1000).toFixed(2)} seconds change`}`} onClick={() => onSelect(region.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(region.id) } }}>
        <title>{region.name}</title><polyline points={pts.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="transparent" strokeWidth={stroke * 4} />
        <polyline points={pts.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={color} strokeWidth={stroke * (selected === region.id ? 2 : 1)} opacity={selected === region.id ? 1 : .75} />
      </g>
    })}
  </svg>
}

export function ReviewDeltaBars({ rows, metric, selected, onSelect, format }: {
  rows: ReviewRegionComparison[]; metric: ReviewMetric; selected: string; onSelect: (id: string) => void; format: (v: number) => string
}) {
  const extent = Math.max(...rows.map(r => Math.abs(r.metrics[metric].delta ?? 0)), .001)
  const timed = metric === 'timeMs'
  return <div className="review-delta-bars" role="list" aria-label="Region changes versus recent baseline">
    <div className="review-bar-caption">{timed ? '← Faster · baseline · Slower →' : '← Lower · baseline · Higher →'}</div>
    {rows.map(r => {
      const d = r.metrics[metric].delta, className = timed && d !== null ? d < 0 ? 'gain' : d > 0 ? 'loss' : 'reference' : 'reference'
      return <button type="button" key={r.region.id} className={`review-bar-row ${selected === r.region.id ? 'selected' : ''}`} aria-pressed={selected === r.region.id} onClick={() => onSelect(r.region.id)}>
        <span>{r.region.name}</span><span className="review-bar-track"><i className={className} style={{ left: `${d !== null && d < 0 ? 50 - Math.abs(d) / extent * 48 : 50}%`, width: `${d == null ? 0 : Math.abs(d) / extent * 48}%` }} /></span>
        <strong className={className}>{d === null ? '—' : `${d > 0 ? '+' : ''}${format(d)}`}</strong>
      </button>
    })}
  </div>
}

export function ReviewCoachContent({ result, evidence = {} }: { result: ReviewCoachResult; evidence?: Record<string, string> }) {
  return <div className="review-coach-content"><p className="review-coach-summary">{result.summary}</p>
    {result.strengths.length > 0 && <div><h3>What improved</h3><ul>{result.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
    {result.regressions.length > 0 && <div><h3>Where to focus</h3><ul>{result.regressions.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
    {result.priorities.map((p, i) => <article className="review-priority" key={i}><span className="review-eyebrow">Next session · priority {i + 1}</span><h3>{p.advice}</h3>
      <blockquote>{p.cue}</blockquote><p><strong>Success looks like:</strong> {p.successMetric}</p><details><summary>Measured evidence</summary><ul>{p.evidence.map(id => <li key={id}>{evidence[id] ?? id}</li>)}</ul></details>
    </article>)}
    {result.limitations.length > 0 && <details><summary>Data limitations</summary><ul>{result.limitations.map((s, i) => <li key={i}>{s}</li>)}</ul></details>}
  </div>
}
