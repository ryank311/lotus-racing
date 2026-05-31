import { useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { ChartCard } from '../components/ChartCard'
import { LineChart, GGChart, HeatmapGrid, CornerChart } from '../components/Charts'
import { speedSeries, lateralSeries, longGSeries } from '../components/chartSeries'
import { TrackMap } from '../components/TrackMap'
import type { AnalysisData } from '../../garmin/analysisData'
import type { CoachingSession, CoachingResult, CoachAnnotation } from '../../shared/types'

interface Props {
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onBack: () => void
  activeCoachSession?: CoachingSession | null
  onClearCoachSession?: () => void
  busy?: string | null
  setBusy?: (b: 'sync' | 'load' | 'coach' | null) => void
}

export function Analysis({ selected, setSelected, onBack, activeCoachSession, onClearCoachSession, busy, setBusy }: Props) {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [splitPct, setSplitPct] = useState(62)
  const [hoverDistanceM, setHoverDistanceM] = useState<number | null>(null)
  const [coachResult, setCoachResult] = useState<CoachingResult | null>(null)
  const [coachRunning, setCoachRunning] = useState(false)
  const [focusedRef, setFocusedRef] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // When a coaching session is loaded from the AI Coach tab, apply its result.
  useEffect(() => {
    if (activeCoachSession) {
      setCoachResult(activeCoachSession.parsed_result)
    }
  }, [activeCoachSession])

  const askCoach = async () => {
    if (!data || coachRunning || busy) return
    setCoachRunning(true)
    setBusy?.('coach')
    const profile = await api.getActiveProfile() ?? 'Lotus'
    const unsub = api.onWorker(evt => {
      if (evt.kind !== 'coach') return
      if (evt.type === 'done') {
        unsub()
        setCoachRunning(false)
        setBusy?.(null)
        if (evt.payload) {
          void api.getCoachSession(evt.payload).then(s => {
            if (s) setCoachResult(s.parsed_result)
          })
        }
      }
      if (evt.type === 'error') {
        unsub()
        setCoachRunning(false)
        setBusy?.(null)
      }
    })
    try {
      await api.runCoach({ profile, scope: 'overview', sessionGuids: [...selected] })
    } catch {
      unsub()
      setCoachRunning(false)
      setBusy?.(null)
    }
  }

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

        <button
          className={`btn ${coachResult ? 'ghost' : 'primary'} ask-coach-btn`}
          disabled={!data || !!busy}
          onClick={coachResult ? () => { setCoachResult(null); onClearCoachSession?.() } : askCoach}
        >
          {coachRunning ? 'Coaching…' : coachResult ? '✕ Clear Coach' : '✦ Ask Coach'}
        </button>
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
              <AnalysisBody data={data} setSelected={setSelected} selected={selected} onHoverDistance={setHoverDistanceM} coachResult={coachResult} onFocusRef={setFocusedRef} />
            )}
          </div>
        </div>

        {/* DIVIDER */}
        <div className="analysis-split-divider" onMouseDown={onDividerMouseDown} />

        {/* RIGHT PANE — track map only, full height, no scroll */}
        <div className="analysis-right-pane">
          {data && !loading && !err
            ? <TrackMapPanel data={data} hoverDistanceM={hoverDistanceM} coachAnnotations={coachResult?.annotations} focusCorner={focusedRef} />
            : <div className="analysis-map-placeholder" />
          }
        </div>
      </div>
    </>
  )
}

// ============================================================================

// TrackMapPanel — right pane content, full height, no extra chrome
function TrackMapPanel({ data, hoverDistanceM, coachAnnotations, focusCorner }: {
  data: AnalysisData
  hoverDistanceM: number | null
  coachAnnotations?: CoachAnnotation[]
  focusCorner?: string | null
}) {
  return <TrackMap data={data} height="100%" hoverDistanceM={hoverDistanceM} coachAnnotations={coachAnnotations} focusCorner={focusCorner ?? undefined} />
}

function AnalysisBody({ data, selected, setSelected, onHoverDistance, coachResult, onFocusRef }: {
  data: AnalysisData
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onHoverDistance: (d: number | null) => void
  coachResult?: CoachingResult | null
  onFocusRef?: (ref: string) => void
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

      {/* COACH NOTES */}
      {coachResult && <CoachNotesPanel result={coachResult} onFocusRef={onFocusRef} />}

      {/* RECOMMENDED PRACTICE */}
      {coachResult && coachResult.drills.length > 0 && (
        <RecommendedPracticePanel drills={coachResult.drills} />
      )}

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

function CoachNotesPanel({ result, onFocusRef }: {
  result: CoachingResult
  onFocusRef?: (ref: string) => void
}) {
  const [open, setOpen] = useState(true)

  // Extract the first ref from a tip's annotations or section label
  const refForTip = (tip: CoachingResult['tips'][0]): string | null => {
    if (tip.annotations.length > 0) return tip.annotations[0].ref
    // Parse first token like "T7", "T7-T9", "S6" from section
    const m = tip.section.match(/^([TS]\d+[a-z]?)/i)
    return m ? m[1] : null
  }

  return (
    <div className="chart-card" style={{ marginBottom: 18 }}>
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="channel-tag">COACH NOTES</span>
        <span className="meta">{open ? '▲ collapse' : '▼ expand'}</span>
      </div>

      {open && (
        <div style={{ padding: '28px 16px 16px' }}>
          {/* Headline + gap chip on one row */}
          {result.headline && (
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--signal)',
                lineHeight: 1.5, marginBottom: 8,
              }}>
                {result.headline}
              </div>
              {result.consistency_loss_ms > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  background: 'var(--signal-soft)', border: '1px solid var(--signal)',
                  borderRadius: 2, padding: '2px 8px',
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--signal)',
                  letterSpacing: '0.1em',
                }}>
                  +{(result.consistency_loss_ms / 1000).toFixed(3)}s gap
                </span>
              )}
            </div>
          )}

          {/* Tip cards — clickable to zoom track map */}
          {result.tips.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {result.tips.map((tip, i) => {
                const ref = refForTip(tip)
                const clickable = !!ref && !!onFocusRef
                return (
                  <div
                    key={i}
                    onClick={clickable ? () => onFocusRef!(ref!) : undefined}
                    style={{
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      padding: '10px 12px',
                      cursor: clickable ? 'pointer' : 'default',
                      transition: 'border-color 0.12s, background 0.12s',
                    }}
                    onMouseEnter={e => {
                      if (!clickable) return
                      ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--signal)'
                      ;(e.currentTarget as HTMLDivElement).style.background = 'var(--signal-soft)'
                    }}
                    onMouseLeave={e => {
                      ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
                      ;(e.currentTarget as HTMLDivElement).style.background = 'var(--bg-elev)'
                    }}
                  >
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5,
                    }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--signal)',
                        letterSpacing: '0.14em', textTransform: 'uppercase',
                      }}>
                        {tip.section}
                      </span>
                      {clickable && (
                        <span style={{
                          fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-mute)',
                          letterSpacing: '0.1em',
                        }}>
                          ↗ zoom to map
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-dim)' }}>
                      {tip.body}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RecommendedPracticePanel({ drills }: { drills: string[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="chart-card" style={{ marginBottom: 18 }}>
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="channel-tag">Recommended Practice</span>
        <span className="meta">{open ? '▲ collapse' : '▼ expand'}</span>
      </div>

      {open && (
        <div style={{ padding: '28px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {drills.map((drill, i) => (
            <div key={i} style={{
              display: 'flex', gap: 14, alignItems: 'flex-start',
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '12px 14px',
            }}>
              <span style={{
                fontFamily: 'var(--font-display)', fontWeight: 800,
                fontSize: 22, lineHeight: 1, color: 'var(--signal)',
                opacity: 0.35, flexShrink: 0, width: 28, textAlign: 'right',
                userSelect: 'none',
              }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <div style={{
                fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-dim)',
                paddingTop: 2,
              }}>
                {drill}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

