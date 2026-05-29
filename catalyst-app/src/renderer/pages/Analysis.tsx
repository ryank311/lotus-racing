import { useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { ChartCard } from '../components/ChartCard'
import { LineChart, GGChart, HeatmapGrid, CornerChart } from '../components/Charts'
import { speedSeries, lateralSeries, longGSeries } from '../components/chartSeries'
import { TrackMap } from '../components/TrackMap'
import type { AnalysisData } from '../../garmin/analysisData'

interface Props {
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onBack: () => void
}

export function Analysis({ selected, setSelected, onBack }: Props) {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [splitPct, setSplitPct] = useState(62)
  const [hoverDistanceM, setHoverDistanceM] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setSplitPct(Math.max(30, Math.min(80, pct)))
    }
    const onMouseUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  useEffect(() => {
    if (selected.size === 0) {
      setData(null); setErr(null)
      return
    }
    setLoading(true); setErr(null)
    void (async () => {
      try {
        const d = (await api.buildAnalysis([...selected])) as AnalysisData
        setData(d)
      } catch (e: any) {
        setErr(e.message ?? String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [selected])

  if (selected.size === 0) {
    return (
      <>
        <header className="page-header">
          <div>
            <div className="page-eyebrow">// telemetry</div>
            <div className="page-title">Ana<span className="accent">lysis</span></div>
          </div>
        </header>
        <div className="page-body">
          <div className="analysis-empty">
            <div>
              <div className="hd">No sessions selected</div>
              <div className="sub">Open the Sessions tab, pick one or more rows, then hit Analyze.</div>
              <div style={{ marginTop: 18 }}>
                <button className="btn primary" onClick={onBack}>Go to Sessions</button>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// telemetry · {data?.config?.toLowerCase() ?? '…'}</div>
          <div className="page-title">Ana<span className="accent">lysis</span></div>
        </div>
        <div className="page-meta">
          {selected.size} sessions<br />
          <span className="muted">{data ? `${data.laps.length} driven laps` : 'loading…'}</span>
        </div>
      </header>

      <div
        className="analysis-split"
        ref={containerRef}
        style={{ gridTemplateColumns: `minmax(0, ${splitPct}fr) 6px minmax(0, ${100 - splitPct}fr)` }}
      >
        {/* LEFT PANE — chart content, scrollable */}
        <div className="analysis-left-pane">
          <div className="analysis-left-body">
            {loading && (
              <div className="analysis-empty" style={{ height: 240 }}>
                <div>
                  <div className="spinner" style={{ width: 32, height: 32, borderWidth: 2, margin: '0 auto 18px' }} />
                  <div className="sub">Reading samples · computing splits · building figures</div>
                </div>
              </div>
            )}

            {err && !loading && (
              <div className="card" style={{ padding: 22 }}>
                <div className="card-label" style={{ color: 'var(--red)' }}>Error</div>
                <div className="card-corner-marks"><i /></div>
                <div style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{err}</div>
                <div className="btn-row">
                  <button className="btn ghost" onClick={onBack}>Back to Sessions</button>
                </div>
              </div>
            )}

            {data && !loading && !err && (
              <AnalysisBody data={data} setSelected={setSelected} selected={selected} onHoverDistance={setHoverDistanceM} />
            )}
          </div>
        </div>

        {/* DIVIDER */}
        <div className="analysis-split-divider" onMouseDown={onDividerMouseDown} />

        {/* RIGHT PANE — track map only, full height, no scroll */}
        <div className="analysis-right-pane">
          {data && !loading && !err
            ? <TrackMapPanel data={data} hoverDistanceM={hoverDistanceM} />
            : <div className="analysis-map-placeholder" />
          }
        </div>
      </div>
    </>
  )
}

// ============================================================================

// TrackMapPanel — right pane content, full height, no extra chrome
function TrackMapPanel({ data, hoverDistanceM }: { data: AnalysisData; hoverDistanceM: number | null }) {
  return <TrackMap data={data} height="100%" hoverDistanceM={hoverDistanceM} />
}

function AnalysisBody({ data, selected, setSelected, onHoverDistance }: {
  data: AnalysisData
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onHoverDistance: (d: number | null) => void
}) {
  const sessionsSorted = useMemo(
    () => [...data.sessions].sort((a, b) => (b.start ?? '').localeCompare(a.start ?? '')),
    [data.sessions],
  )

  const dateRange = useMemo(() => {
    const dates = sessionsSorted.map(s => s.start ?? '').filter(Boolean).map(s => s.slice(0, 10)).sort()
    if (!dates.length) return ''
    return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} — ${dates[dates.length - 1]}`
  }, [sessionsSorted])

  const removeSession = (sg: string) => {
    const next = new Set(selected); next.delete(sg); setSelected(next)
  }

  return (
    <>
      {/* SESSION CHIPS */}
      <div className="session-chips">
        {sessionsSorted.map(s => (
          <span key={s.sg} className="chip cyan">
            {(s.start ?? '').slice(0, 16)} · {msToLap(s.bestLapMs)}
            <span className="x" onClick={() => removeSession(s.sg)}>×</span>
          </span>
        ))}
        {dateRange && (
          <span className="chip" style={{ borderColor: 'var(--text-mute)' }}>{dateRange}</span>
        )}
      </div>

      {/* STAT STRIP */}
      <div className="analysis-stat-strip">
        <Stat label="Best lap" value={msToLap(data.bestLap?.durationMs)} sub={data.bestLap ? `${data.bestLap.sgShort}… L${data.bestLap.lapIdx + 1}` : ''} featured />
        <Stat label="Theoretical" value={msToLap(data.theoreticalBestMs)} sub="sum of segment PBs" />
        <Stat label="Average" value={msToLap(data.avgLapMs)} sub={`${data.laps.length} laps`} />
        <Stat label="Sessions" value={String(data.sessions.length)} sub="selected" />
        <Stat label="Track" value={data.config} sub={`${data.totalDistM.toFixed(0)} m`} />
      </div>

      {/* CHARTS */}
      <div className="analysis-charts">
        <ChartCard channel="SPEED" meta={`${data.speedTraces.length} laps · mph`}>
          <LineChart
            series={speedSeries(data)}
            height={420}
            yUnit="mph"
            corners={data.corners}
            segments={data.segments}
            onHoverX={onHoverDistance}
          />
        </ChartCard>

        {data.heatmap && (
          <ChartCard channel="SEGMENT Δ" meta="seconds · best per segment = 0">
            <HeatmapGrid hm={data.heatmap} />
          </ChartCard>
        )}

        <ChartCard channel="G-G" meta={`p95 ≈ ${data.gg.p95_g.toFixed(2)}g`}>
          <GGChart gg={data.gg} height={420} onHoverDistance={onHoverDistance} />
        </ChartCard>

        <ChartCard channel="LATERAL POSITION" meta="0 = inner · 1 = outer · 0.5 = centre">
          <LineChart
            series={lateralSeries(data)}
            height={280}
            yRange={[-0.05, 1.05]}
            corners={data.corners}
            onHoverX={onHoverDistance}
          />
        </ChartCard>

        <ChartCard channel="LONG. G" meta="braking (neg) · acceleration (pos)">
          <LineChart
            series={longGSeries(data)}
            height={300}
            yUnit="g"
            corners={data.corners}
            segments={data.segments}
            zeroLine
            onHoverX={onHoverDistance}
          />
        </ChartCard>

        {data.cornerRows.length > 0 && (
          <ChartCard channel="CORNER STATS" meta="entry · apex · exit">
            <CornerChart data={data} height={480} />
          </ChartCard>
        )}
      </div>
    </>
  )
}

function Stat({ label, value, sub, featured }: { label: string; value: string; sub?: string; featured?: boolean }) {
  return (
    <div className={`analysis-stat ${featured ? 'featured' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

