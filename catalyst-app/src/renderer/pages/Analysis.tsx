import { PreparingPanel } from '../components/Preparing'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { ChartCard } from '../components/ChartCard'
import { LineChart, GGChart, HeatmapGrid, CornerChart, CornerBrakingChart, CornerConsistencyChart } from '../components/Charts'
import { speedSeries, speedDeltaSeries, timeDeltaSeries, optimalTimeDeltaSeries, garminOptimalTimeDeltaSeries, longGSeries, lapName } from '../components/chartSeries'
import { TrackMap } from '../components/TrackMap'
import { ConditionsPanel } from '../components/ConditionsPanel'
import { useUnits } from '../units'
import { useNavigation, useRoute } from '../navigation'
import { humanSessionLabel, sanitizeCoachingResult } from '../../shared/sessionIdentity'
import { coachingLapFilter, DEFAULT_LAP_FILTER, isLapFilter, LAP_FILTERS, lapFilterLabel, lapFilterPhrase, type LapFilter } from '../../shared/coachingScope'
import { CoachProgress } from '../components/CoachProgress'
import type { AnalysisData } from '../../garmin/analysisData'
import type { CoachingSession, CoachingResult, CoachAnnotation, CoachLineWaypoint, CoachSetupRec, FocusVerdict } from '../../shared/types'
import type { CoachLinePoint } from '../../garmin/analysisData'
import './analysis-extras.css'

interface Props {
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onBack: () => void
  activeCoachSession?: CoachingSession | null
  onClearCoachSession?: () => void
  busy?: string | null
  setBusy?: (b: 'sync' | 'load' | 'coach' | null) => void
}

// Order-independent identity for a set of session guids — lets us tell whether
// the current selection still matches what coaching was generated for.
function guidKey(guids: Iterable<string>): string {
  return [...guids].sort().join(',')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// The sessions and lap filter a loaded coach report was generated for.
interface CoachScope { guids: string[]; filter: LapFilter }

export function Analysis({ selected, setSelected, onBack, activeCoachSession, onClearCoachSession, busy, setBusy }: Props) {
  const { params } = useRoute()
  const { query } = useNavigation()
  const { system } = useUnits()
  const [data, setData] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(selected.size > 0)
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now())
  const [err, setErr] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const mobileView = params.get('view') === 'map' ? 'map' : 'charts'
  const setMobileView = (view: 'charts' | 'map') => query({ view })
  const [splitPct, setSplitPct] = useState(62)
  const [hoverDistanceM, setHoverDistanceM] = useState<number | null>(null)
  const [coachResult, setCoachResult] = useState<CoachingResult | null>(null)
  // What the loaded report was generated for. Changing the sessions or lap
  // filter afterwards keeps the report on screen with a stale banner rather
  // than silently discarding it.
  const [coachScope, setCoachScope] = useState<CoachScope | null>(null)
  const [coachRunning, setCoachRunning] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const lapParam = params.get('laps')
  const lapFilter: LapFilter = isLapFilter(lapParam) && lapParam !== 'all' ? lapParam : DEFAULT_LAP_FILTER
  const setLapFilter = (laps: LapFilter) => query({ laps, report: null })
  const focusParam = params.get('focus')
  const [coachMenuOpen, setCoachMenuOpen] = useState(false)
  const [focusedRef, setFocusedRef] = useState<string | null>(null)
  const [hoveredRef, setHoveredRef] = useState<string | null>(null)
  const [focusedAnnotation, setFocusedAnnotation] = useState<CoachAnnotation | null | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const loadedCoachId = useRef<string | null>(null)
  const appliedFocus = useRef<string | null>(null)

  const resetMapFocus = () => {
    setFocusedRef(null)
    setHoveredRef(null)
    setFocusedAnnotation(undefined)
  }

  // Load a saved report (opened from AI Coach or a report link) with the
  // scope it was generated for.
  useEffect(() => {
    if (!activeCoachSession) { loadedCoachId.current = null; return }
    if (loadedCoachId.current === activeCoachSession.id) return
    loadedCoachId.current = activeCoachSession.id
    setCoachResult(activeCoachSession.parsed_result)
    setCoachScope({ guids: activeCoachSession.session_guids, filter: coachingLapFilter(activeCoachSession) })
    resetMapFocus()
  }, [activeCoachSession])

  const clearCoach = () => {
    setCoachResult(null)
    setCoachScope(null)
    resetMapFocus()
    onClearCoachSession?.()
  }

  // ?focus=T11 (e.g. from Session Review or Progress): once telemetry has
  // loaded, focus that corner or segment exactly like "View on map".
  useEffect(() => {
    if (!data || !focusParam || appliedFocus.current === focusParam) return
    appliedFocus.current = focusParam
    setFocusedRef(focusParam)
    setMobileView('map')
  }, [data, focusParam])  // eslint-disable-line react-hooks/exhaustive-deps

  const askCoach = async (coachFilter: LapFilter = lapFilter) => {
    if (!data || coachRunning || busy) return

    // Coaching requires a remote API key — surface a clear modal instead of a
    // silent failure when it isn't configured.
    const settings = await api.getAiSettings()
    const provider = settings.provider ?? (settings.model?.startsWith('gpt-') ? 'openai' : 'anthropic')
    const hasKey = provider === 'openai' ? !!settings.hasOpenAiApiKey : !!settings.hasAnthropicApiKey
    if (!hasKey) {
      const label = provider === 'openai' ? 'OpenAI' : 'Anthropic'
      setCoachError(`No ${label} API key configured. Open the Overview page and add it under "AI Coach" before running coaching analysis.`)
      return
    }

    setCoachRunning(true)
    setBusy?.('coach')
    // The set submitted to the coach — the result will correspond to exactly this.
    const submitted = [...selected]
    // Coaching a different lap filter from the menu: show those laps too, so
    // the report does not arrive already out of step with the charts.
    if (coachFilter !== lapFilter) setLapFilter(coachFilter)
    // The server resolves the car's profile from the vehicle when this is empty.
    const profile = (await api.getActiveProfile()) ?? ''
    const unsub = api.onWorker(evt => {
      if (evt.kind !== 'coach') return
      if (evt.type === 'done') {
        unsub()
        setCoachRunning(false)
        setBusy?.(null)
        if (evt.payload) {
          void api.getCoachSession(evt.payload).then(s => {
            if (s) {
              setCoachResult(s.parsed_result)
              setCoachScope({ guids: submitted, filter: coachFilter })
              resetMapFocus()
            }
          })
        }
      }
      if (evt.type === 'error') {
        unsub()
        setCoachRunning(false)
        setBusy?.(null)
        setCoachError(evt.payload || 'Coaching failed. Check the logs for details.')
      }
    })
    try {
      await api.runCoach({ profile, scope: 'overview', sessionGuids: submitted, lapFilter: coachFilter })
    } catch (e: any) {
      unsub()
      setCoachRunning(false)
      setBusy?.(null)
      setCoachError(e?.message ?? 'Coaching failed to start.')
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
    let cancelled = false
    if (selected.size === 0) {
      setData(null); setErr(null); setLoading(false)
      return
    }
    setLoading(true); setErr(null); setData(null); setLoadStartedAt(Date.now())
    // A tunnel can stall without rejecting fetch. Stop waiting after two
    // minutes, and ignore any late result after cancellation or a retry.
    const fail = (message: string) => {
      cancelled = true
      clearTimeout(timeout)
      setErr(message)
      setLoading(false)
    }
    const timeout = setTimeout(() => fail('Analysis took too long to load. Check your connection and try again.'), 120_000)
    void (async () => {
      try {
        const sessions = await api.listSessions(null)
        if (cancelled) return
        const requested = sessions.filter(s => selected.has(s.session_guid))
        if (requested.length !== selected.size) throw new Error('Some sessions are unavailable. Return to Sessions to update your selection.')
        if (requested.some(s => !s.details_loaded)) throw new Error('Telemetry is missing. Return to Sessions and download the selected telemetry.')
        const d = (await api.buildAnalysis([...selected], system, lapFilter)) as AnalysisData
        if (!d) throw new Error('The server returned no analysis. Please try again.')
        if (!cancelled) setData(d)
      } catch (e: any) {
        if (!cancelled) setErr(e.message ?? String(e))
      } finally {
        clearTimeout(timeout)
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true; clearTimeout(timeout) }
  }, [selected, system, lapFilter, loadAttempt])

  const displayCoachResult = useMemo(() => {
    if (!coachResult) return null
    const sessions = [...(data?.sessions ?? [])]
      .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))
    const aliases = Object.fromEntries(
      sessions.map((session, index) => [session.sg, humanSessionLabel(session.start, index)]),
    )
    return sanitizeCoachingResult(coachResult, aliases)
  }, [coachResult, data?.sessions])

  // The report stays visible when the selection moves away from what it was
  // generated for; say so plainly and offer to clear or re-run it.
  const staleNotice = (() => {
    if (!coachResult || !coachScope) return null
    const sameSessions = guidKey(coachScope.guids) === guidKey(selected)
    if (sameSessions && coachScope.filter === lapFilter) return null
    const now = `${lapFilterPhrase(lapFilter)} of ${plural(selected.size, sameSessions || coachScope.guids.length !== selected.size ? 'session' : 'different session')}`
    return (
      <div className="coach-stale-banner" role="status">
        <div>
          <strong>Coach report is out of date for these charts</strong>
          <span>
            This report was generated for {lapFilterPhrase(coachScope.filter)} of {plural(coachScope.guids.length, 'session')}; the charts now show {now}.
          </span>
        </div>
        <div className="coach-stale-actions">
          <button type="button" className="btn ghost" onClick={clearCoach}>Clear report</button>
          <button type="button" className="btn primary" disabled={!data || coachRunning || !!busy} onClick={() => void askCoach(lapFilter)}>
            {coachRunning ? 'Coaching…' : 'Re-run coach'}
          </button>
        </div>
      </div>
    )
  })()

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
      <header className="analysis-toolbar">
        <div className="analysis-context">
          <strong title={data?.config}>{data?.config || 'Analysis'}</strong>
          <span>{selected.size} session{selected.size === 1 ? '' : 's'} · {loading ? 'Loading…' : data ? plural(data.laps.length, 'lap') : 'Telemetry'}</span>
        </div>

        <div className="analysis-mobile-tabs" role="group" aria-label="Analysis view">
          <button aria-pressed={mobileView === 'charts'} onClick={() => setMobileView('charts')}>Charts</button>
          <button aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}>Map</button>
        </div>

        <select className="analysis-lap-select" aria-label="Laps included in analysis"
          title="Which valid laps the charts and the coach use"
          value={lapFilter} disabled={loading} onChange={e => setLapFilter(e.target.value as LapFilter)}>
          {LAP_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>

        <div className="ask-coach-split">
          <button
            className={`btn ask-coach-btn${coachResult ? ' clearing' : ''}${coachRunning ? ' is-running' : ''}`}
            disabled={!data || !!busy}
            onClick={coachResult ? clearCoach : () => void askCoach(lapFilter)}
          >
            {coachRunning ? 'Coaching…' : coachResult ? '✕ Clear Coach' : '✦ Ask Coach'}
          </button>
          {!coachResult && (
            <button type="button" className="ask-coach-caret" aria-label="Choose laps for coaching"
              aria-expanded={coachMenuOpen} disabled={!data || !!busy}
              onClick={() => setCoachMenuOpen(open => !open)}>▾</button>
          )}
          {coachMenuOpen && !coachResult && (
            <div className="ask-coach-menu">
              <div className="ask-coach-menu-label">Coach using</div>
              <button type="button" onClick={() => { setCoachMenuOpen(false); void askCoach(lapFilter) }}>
                Current filter · {lapFilterLabel(lapFilter)}
              </button>
              {LAP_FILTERS.map(item => (
                <button key={item.value} type="button" onClick={() => { setCoachMenuOpen(false); void askCoach(item.value) }}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {(coachRunning || busy === 'coach') && <CoachProgress />}

      {loading ? <div className="analysis-preparing">
        <PreparingPanel
          standalone
          eyebrow="analysis"
          title="Preparing analysis"
          detail={`${plural(selected.size, 'session')} · ${lapFilterLabel(lapFilter)}`}
          startedAt={loadStartedAt}
          status="Crunching telemetry…"
          stepsLabel="Being prepared"
          steps={[
            { label: 'Valid laps', detail: 'Garmin-flagged and excluded laps are left out', state: 'todo' },
            { label: 'Splits and braking', detail: 'Timestamped splits, braking points, corner minimums', state: 'todo' },
            { label: 'Lap comparisons', detail: 'Deltas to your fastest, theoretical and Garmin optimal laps', state: 'todo' },
          ]}
        />
      </div> : <div
        className={`analysis-split mobile-view-${err ? 'charts' : mobileView}`}
        ref={containerRef}
        style={{ gridTemplateColumns: `minmax(0, ${splitPct}fr) 6px minmax(0, ${100 - splitPct}fr)` }}
      >
        {/* LEFT PANE — chart content, scrollable */}
        <div className="analysis-left-pane">
          <div className="analysis-left-body">
            {err && (
              <div className="card" role="alert" style={{ padding: 22 }}>
                <div className="card-label" style={{ color: 'var(--red)' }}>Error</div>
                <div className="card-corner-marks"><i /></div>
                <div style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{err}</div>
                <div className="btn-row">
                  <button className="btn primary" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry analysis</button>
                  <button className="btn ghost" onClick={onBack}>Back to Sessions</button>
                </div>
              </div>
            )}

            {data && !err && (
              <AnalysisBody data={data} setSelected={setSelected} selected={selected} hoverDistanceM={hoverDistanceM} onHoverDistance={setHoverDistanceM} coachResult={displayCoachResult} coachNotice={staleNotice} onFocusRef={ref => { setFocusedRef(ref); if (ref) setMobileView('map') }} onHoverRef={setHoveredRef} onFocusAnnotation={setFocusedAnnotation} />
            )}
          </div>
        </div>

        {/* DIVIDER */}
        <div className="analysis-split-divider" onMouseDown={onDividerMouseDown} />

        {/* RIGHT PANE — track map only, full height, no scroll */}
        <div className="analysis-right-pane">
          {data && !err
            ? <TrackMapPanel data={data} hoverDistanceM={hoverDistanceM} coachAnnotations={displayCoachResult?.annotations} focusCorner={focusedRef} hoverRef={hoveredRef} focusAnnotation={focusedAnnotation} coachResult={displayCoachResult} />
            : <div className="analysis-map-placeholder" />
          }
        </div>
      </div>}

      {coachError && (
        <CoachErrorModal message={coachError} onDismiss={() => setCoachError(null)} />
      )}
    </>
  )
}

function CoachErrorModal({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="card-corner-marks"><i /></div>
        <div className="modal-eyebrow">// coach unavailable</div>
        <div className="modal-title">Can't run coaching</div>
        <div className="modal-body">{message}</div>
        <div className="modal-actions">
          <button className="btn primary" onClick={onDismiss}>Got it</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================

// Convert sparse AI waypoints [{dist_m, lateral_pos}] to XY using track geometry.
// Look up the best lap's lateral_pos at a given distance by linear interpolation.
function bestLapLatAt(dist: number, distArr: number[], posArr: number[]): number {
  if (!distArr.length) return 0.5
  if (dist <= distArr[0]) return posArr[0]
  if (dist >= distArr[distArr.length - 1]) return posArr[posArr.length - 1]
  let lo = 0, hi = distArr.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1
    if (distArr[mid] <= dist) lo = mid; else hi = mid
  }
  const t = (dist - distArr[lo]) / (distArr[hi] - distArr[lo])
  return posArr[lo] + (posArr[hi] - posArr[lo]) * t
}

// Convert sparse AI delta-from-best-lap waypoints into a dense XY polyline that
// follows track curvature. Each waypoint's delta is added to the driver's actual
// lateral_pos at that distance; between waypoints the delta is linearly interpolated.
// Where no waypoints are specified the delta is 0 (coach line = driver's line).
function waypointsToXY(
  waypoints: CoachLineWaypoint[],
  geom: import('../../garmin/analysisData').TrackGeometryPayload,
  bestLatDist: number[],
  bestLatPos: number[],
): CoachLinePoint[] {
  if (!waypoints.length) return []
  const STRIDE = 5
  const maxIdx = geom.centerline.length - 1
  const sorted = [...waypoints].sort((a, b) => a.dist_m - b.dist_m)

  function edgeLerp(dist: number, lateralPos: number): CoachLinePoint | null {
    const idx = Math.max(0, Math.min(maxIdx, Math.round(dist)))
    const left = geom.leftEdge[idx], right = geom.rightEdge[idx]
    if (!left || !right) return null
    const t = Math.max(0, Math.min(1, lateralPos))
    return { dist, x: left.x + (right.x - left.x) * t, y: left.y + (right.y - left.y) * t }
  }

  // Build interpolated delta at any distance: 0 outside waypoint range, lerped between them.
  function deltaAt(d: number): number {
    if (d <= sorted[0].dist_m) return sorted[0].delta
    if (d >= sorted[sorted.length - 1].dist_m) return sorted[sorted.length - 1].delta
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1]
      if (d >= a.dist_m && d <= b.dist_m) {
        const t = (d - a.dist_m) / (b.dist_m - a.dist_m)
        return a.delta + (b.delta - a.delta) * t
      }
    }
    return 0
  }

  const startDist = sorted[0].dist_m
  const endDist = sorted[sorted.length - 1].dist_m
  const result: CoachLinePoint[] = []
  for (let d = startDist; d <= endDist; d += STRIDE) {
    const baseLat = bestLapLatAt(d, bestLatDist, bestLatPos)
    const coachLat = baseLat + deltaAt(d)
    const pt = edgeLerp(d, coachLat)
    if (pt) result.push(pt)
  }
  return result
}

// TrackMapPanel — right pane content, full height, no extra chrome. The
// stitched optimal line is always offered (map toggle); the AI waypoint line
// exists only on old (v1) reports that carry coach_line.
function TrackMapPanel({ data, hoverDistanceM, coachAnnotations, focusCorner, hoverRef, focusAnnotation, coachResult }: {
  data: AnalysisData
  hoverDistanceM: number | null
  coachAnnotations?: CoachAnnotation[]
  focusCorner?: string | null
  hoverRef?: string | null
  focusAnnotation?: CoachAnnotation | null
  coachResult?: CoachingResult | null
}) {
  const aiCoachLine = useMemo(() => {
    if (!coachResult?.coach_line?.length || !data.trackGeometry) return null
    const bestTrace = data.lateralTraces.find(
      t => t.sg === data.bestLap?.sg && t.lapIdx === data.bestLap?.lapIdx
    ) ?? data.lateralTraces[0]
    const bestLatDist = bestTrace?.dist ?? []
    const bestLatPos  = bestTrace?.pos  ?? []
    return waypointsToXY(coachResult.coach_line, data.trackGeometry, bestLatDist, bestLatPos)
  }, [coachResult?.coach_line, data.trackGeometry, data.lateralTraces, data.bestLap])

  return (
    <TrackMap
      data={data}
      height="100%"
      hoverDistanceM={hoverDistanceM}
      coachAnnotations={coachAnnotations}
      focusCorner={focusCorner ?? undefined}
      hoverRef={hoverRef ?? undefined}
      focusAnnotation={focusAnnotation}
      coachLine={data.coachLine ?? null}
      aiCoachLine={coachResult ? aiCoachLine : null}
    />
  )
}

function AnalysisBody({ data, selected, setSelected, hoverDistanceM, onHoverDistance, coachResult, coachNotice, onFocusRef, onHoverRef, onFocusAnnotation }: {
  data: AnalysisData
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  hoverDistanceM: number | null
  onHoverDistance: (d: number | null) => void
  coachResult?: CoachingResult | null
  coachNotice?: React.ReactNode
  onFocusRef?: (ref: string) => void
  onHoverRef?: (ref: string | null) => void
  onFocusAnnotation?: (a: CoachAnnotation | null) => void
}) {
  const [speedMode, setSpeedMode] = useState<'absolute' | 'delta'>('absolute')
  const [timeDeltaMode, setTimeDeltaMode] = useState<'fastest' | 'optimal' | 'garmin'>('fastest')
  const hasGarminDelta = (data.garminOptimalTimeDeltaTraces?.length ?? 0) > 0
  const deltaMode = timeDeltaMode === 'garmin' && !hasGarminDelta ? 'fastest' : timeDeltaMode
  // One zoom window shared by the distance charts (speed, time Δ, long G).
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  // Hover updates the linked map through this parent. Keep the chart's data
  // identity stable so inspecting a point does not reset its zoom window.
  const speedPlotSeries = useMemo(() => speedMode === 'delta' ? speedDeltaSeries(data) : speedSeries(data), [data, speedMode])
  const timePlotSeries = useMemo(() => deltaMode === 'garmin' ? garminOptimalTimeDeltaSeries(data)
    : deltaMode === 'optimal' ? optimalTimeDeltaSeries(data) : timeDeltaSeries(data), [data, deltaMode])
  const longPlotSeries = useMemo(() => longGSeries(data), [data])
  const hasIgnoredSplits = useMemo(() => !!data.heatmap?.z.some(row => row.some(v => v != null && v < 0)), [data.heatmap])
  const excludedLaps = data.excludedLapCount ?? 0
  const avgLapCount = data.avgLapCount ?? data.laps.length
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
      <details className="analysis-session-details">
        <summary>Session details <span>{dateRange}</span></summary>
        <p className="muted small">{data.config} · {data.totalDistM.toFixed(0)} m · {data.sessions.length} session{data.sessions.length === 1 ? '' : 's'}</p>
        <div className="session-chips">
        {sessionsSorted.map(s => (
          <span key={s.sg} className="chip cyan">
            {(s.start ?? '').slice(0, 16)} · {msToLap(s.bestLapMs)}
            <button className="x" aria-label={`Remove session ${s.start ?? s.sg}`} onClick={() => removeSession(s.sg)}>×</button>
          </span>
        ))}
        </div>
      </details>

      {/* STAT STRIP */}
      <div className="analysis-stat-strip-container">
      <div className={`analysis-stat-strip${data.garminOptimalMs != null ? ' four-up' : ''}`}>
        <Stat label="Best lap" value={msToLap(data.bestLap?.durationMs)} sub={data.bestLap ? lapName(data.bestLap) : undefined} featured />
        <Stat label="Theoretical" value={msToLap(data.theoreticalBestMs)} sub="Segment bests" />
        {data.garminOptimalMs != null && (
          <Stat label="Garmin optimal" value={msToLap(data.garminOptimalMs)} sub="From the device" />
        )}
        <Stat label="Average" value={msToLap(data.avgLapMs)} sub={plural(avgLapCount, 'representative lap')} />
      </div>
      {excludedLaps > 0 && (
        <p className="analysis-excluded-note" title="Laps Garmin flagged invalid, or that you excluded on Session Review, are left out of every chart.">
          {plural(excludedLaps, 'flagged or excluded lap')} hidden
        </p>
      )}
      </div>

      {/* COACH NOTES */}
      {coachNotice}
      {coachResult && <CoachNotesPanel result={coachResult} onFocusRef={onFocusRef} onHoverRef={onHoverRef} onFocusAnnotation={onFocusAnnotation} />}

      {/* RECOMMENDED PRACTICE */}
      {coachResult && coachResult.drills.length > 0 && (
        <RecommendedPracticePanel drills={coachResult.drills} />
      )}

      {coachResult && (coachResult.next_session_plan?.length ?? 0) > 0 && (
        <NextSessionPlanPanel plan={coachResult.next_session_plan!} />
      )}

      {/* CAR SETUP */}
      {coachResult && <CarSetupPanel setup={coachResult.setup} />}

      {/* CHARTS */}
      <div className="analysis-charts">
        <ChartCard
          channel="SPEED"
          meta={`${data.speedTraces.length} laps · ${data.speedUnit}`}
          controls={(
            <div className="chart-mode-toggle" role="group" aria-label="Speed chart display">
              <button type="button" className={speedMode === 'absolute' ? 'active' : ''}
                aria-pressed={speedMode === 'absolute'} onClick={() => setSpeedMode('absolute')}>Speed</button>
              <button type="button" className={speedMode === 'delta' ? 'active' : ''}
                aria-pressed={speedMode === 'delta'} onClick={() => setSpeedMode('delta')}>Δ vs fastest</button>
            </div>
          )}
        >
          <LineChart
            series={speedPlotSeries}
            height={420}
            yUnit={data.speedUnit}
            corners={data.corners}
            segments={data.segments}
            zeroLine={speedMode === 'delta'}
            onHoverX={onHoverDistance}
            hoverX={hoverDistanceM}
            xRange={xRange}
            onXRangeChange={setXRange}
          />
        </ChartCard>

        {data.heatmap && (
          <ChartCard channel="SEGMENT Δ" meta={`seconds · best per segment = 0${hasIgnoredSplits ? ' · hatched = ignored (implausibly fast)' : ''}`}>
            <HeatmapGrid hm={data.heatmap} onHoverSegment={onHoverRef} />
          </ChartCard>
        )}

        <ChartCard channel="G-G" meta={`p95 ≈ ${data.gg.p95_g.toFixed(2)}g`}>
          <GGChart gg={data.gg} height={420} onHoverDistance={onHoverDistance} speedUnit={data.speedUnit} />
        </ChartCard>

        <ChartCard
          channel="CUMULATIVE TIME Δ"
          meta="Seconds · negative = ahead"
          controls={(
            <div className="chart-mode-toggle" role="group" aria-label="Cumulative time delta reference">
              <button type="button" className={deltaMode === 'fastest' ? 'active' : ''}
                aria-pressed={deltaMode === 'fastest'} onClick={() => setTimeDeltaMode('fastest')}>Vs fastest lap</button>
              <button type="button" className={deltaMode === 'optimal' ? 'active' : ''}
                aria-pressed={deltaMode === 'optimal'} onClick={() => setTimeDeltaMode('optimal')}
                title="Theoretical best: your best time in every segment">Vs theoretical best</button>
              {hasGarminDelta && (
                <button type="button" className={deltaMode === 'garmin' ? 'active' : ''}
                  aria-pressed={deltaMode === 'garmin'} onClick={() => setTimeDeltaMode('garmin')}
                  title="The optimal lap the Catalyst device recorded">Vs Garmin optimal</button>
              )}
            </div>
          )}
        >
          <LineChart
            series={timePlotSeries}
            height={320}
            yUnit="s"
            corners={data.corners}
            segments={data.segments}
            zeroLine
            onHoverX={onHoverDistance}
            hoverX={hoverDistanceM}
            xRange={xRange}
            onXRangeChange={setXRange}
          />
        </ChartCard>

        <ChartCard channel="LONG. G" meta="braking (neg) · acceleration (pos)">
          <LineChart
            series={longPlotSeries}
            height={300}
            yUnit="g"
            corners={data.corners}
            segments={data.segments}
            zeroLine
            onHoverX={onHoverDistance}
            hoverX={hoverDistanceM}
            xRange={xRange}
            onXRangeChange={setXRange}
          />
        </ChartCard>

        {(data.cornerBrakingRows?.length ?? 0) > 0 && (
          <ChartCard channel="BRAKING TECHNIQUE" meta="onset → release · distance relative to apex">
            <CornerBrakingChart data={data} height={480} onHoverCorner={onHoverRef} />
          </ChartCard>
        )}

        {data.cornerRows.length > 0 && (
          <ChartCard channel="CORNER CONSISTENCY" meta="V-min range ÷ average · lower is better">
            <CornerConsistencyChart
              data={data}
              height={480}
              speedUnit={data.speedUnit}
              onHoverCorner={onHoverRef}
            />
          </ChartCard>
        )}

        {data.cornerRows.length > 0 && (
          <ChartCard channel="CORNER STATS" meta="brake-point speed · V-min · +100 m">
            <CornerChart data={data} height={480} speedUnit={data.speedUnit} onHoverCorner={onHoverRef} />
          </ChartCard>
        )}
      </div>

      {/* CONDITIONS — weather summary, correlated to pace. Sits at the very
          bottom: a fastest-vs-slowest readout with an expander for the rest. */}
      <ConditionsPanel sessions={data.sessions} />
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

function CoachNotesPanel({ result, onFocusRef, onHoverRef, onFocusAnnotation }: {
  result: CoachingResult
  onFocusRef?: (ref: string) => void
  onHoverRef?: (ref: string | null) => void
  onFocusAnnotation?: (a: CoachAnnotation | null) => void
}) {
  const [open, setOpen] = useState(true)
  const prioritizedTips = useMemo(
    () => [...result.tips].sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4)),
    [result.tips],
  )

  const confidenceLabel = (confidence: 1 | 2 | 3 | undefined): string | null => {
    if (confidence === 3) return 'High confidence'
    if (confidence === 2) return 'Medium confidence'
    if (confidence === 1) return 'Low confidence'
    return null
  }

  // Version-2 tips carry their map ref (T11 / S3). Older tips only have it in
  // the section label, which may be a range like "T7-T9".
  const refForTip = (tip: CoachingResult['tips'][0]): string | null => {
    if (tip.ref) return tip.ref
    const m = tip.section.match(/^([TS]\d+[a-z]?(?:-[TS]?\d+[a-z]?)*)/i)
    if (m) return m[1]
    if (tip.annotations.length > 0) return tip.annotations[0].ref
    return null
  }

  return (
    <div className="chart-card coach-card coach-notes-card">
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="channel-tag">COACH NOTES</span>
        <span className="meta">{open ? '▲ collapse' : '▼ expand'}</span>
      </div>

      {open && (
        <div className="coach-notes-body">
          {result.headline && (
            <section className="coach-summary">
              <div className="coach-summary-copy">
                <div className="coach-section-kicker">Biggest opportunity</div>
                <div className="coach-headline">{result.headline}</div>
              </div>
              {result.consistency_loss_ms > 0 && (
                <div className="coach-gap-metric">
                  <span>{result.version === 2 ? 'Best lap vs ideal' : 'Consistency gap'}</span>
                  <strong>+{(result.consistency_loss_ms / 1000).toFixed(3)}s</strong>
                  <small>measured opportunity</small>
                </div>
              )}
            </section>
          )}

          {(result.previous_focus_review?.length ?? 0) > 0 && (
            <LastFocusSection items={result.previous_focus_review!} onFocusRef={onFocusRef} onHoverRef={onHoverRef} onFocusAnnotation={onFocusAnnotation} />
          )}

          {(result.strengths?.length ?? 0) > 0 && (
            <section className="coach-strengths">
              <div className="coach-section-heading">
                <span>Keep doing</span>
                <small>{result.strengths!.length} strengths to preserve</small>
              </div>
              <div className="coach-strength-grid">
                {result.strengths!.map((strength, i) => (
                  <div className="coach-strength" key={i}>
                    <span className="coach-strength-check">✓</span>
                    <span>{strength}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {prioritizedTips.length > 0 && (
            <section className="coach-recommendations">
              <div className="coach-section-heading">
                <span>Priority coaching</span>
                <small>Work from the top down · one change at a time</small>
              </div>
              <div className="coach-tip-list">
              {prioritizedTips.map((tip, i) => {
                const ref = refForTip(tip)
                const clickable = !!ref && !!onFocusRef
                // For a segment section (S6), highlight the whole segment — not a
                // corner-level callout inside it. Synthesize a segment annotation
                // so the focused ref matches the section. Otherwise pin the tip's
                // first (corner) annotation, which carries richer speed data.
                const isSegmentRef = !!ref && /^S\d+$/i.test(ref)
                const focusAnn: CoachAnnotation | null = isSegmentRef
                  ? { type: 'segment_tip', ref: ref!, body: tip.body, severity: tip.annotations[0]?.severity }
                  : tip.annotations[0] ?? null
                return (
                  <div
                    key={i}
                    className={`coach-tip coach-tip-priority-${tip.priority ?? 3}`}
                    onMouseEnter={() => clickable && onHoverRef?.(ref!)}
                    onMouseLeave={() => onHoverRef?.(null)}
                  >
                    <div className="coach-tip-header">
                      <div className="coach-tip-rank">{String(i + 1).padStart(2, '0')}</div>
                      <div className="coach-tip-title">
                        <span>{tip.section}{tip.ref && !tip.section.includes(tip.ref) ? ` · ${tip.ref}` : ''}</span>
                        <small>{tip.priority ? `Priority ${tip.priority}` : 'Coaching opportunity'}</small>
                      </div>
                      <div className="coach-tip-metrics">
                        {tip.estimated_gain_ms != null && (
                          <span className="coach-gain">~{(tip.estimated_gain_ms / 1000).toFixed(2)}s gain</span>
                        )}
                        {confidenceLabel(tip.confidence) && (
                          <span className="coach-confidence">{confidenceLabel(tip.confidence)}</span>
                        )}
                      </div>
                      {clickable && (
                        <button className="coach-map-link" type="button" onClick={() => {
                          onFocusRef!(ref!)
                          onFocusAnnotation?.(focusAnn)
                        }}>View on map ↗</button>
                      )}
                    </div>
                    <div className="coach-tip-body">{tip.body}</div>
                    {(tip.evidence?.length ?? 0) > 0 && (
                      <details className="coach-evidence">
                        <summary>Evidence · {tip.evidence!.length} observation{tip.evidence!.length === 1 ? '' : 's'}</summary>
                        <div className="coach-evidence-list">
                          {tip.evidence!.map((item, j) => <div key={j}><span>↳</span>{item}</div>)}
                        </div>
                      </details>
                    )}
                    {(tip.cue || tip.success_metric) && (
                      <div className="coach-tip-actions">
                        {tip.cue && <div className="coach-action coach-action-cue"><span>In-car cue</span><strong>{tip.cue}</strong></div>}
                        {tip.success_metric && <div className="coach-action coach-action-verify"><span>{result.version === 2 ? 'Success metric' : 'Verify in Catalyst'}</span><strong>{tip.success_metric}</strong></div>}
                      </div>
                    )}
                  </div>
                )
              })}
              </div>
            </section>
          )}
          {(result.data_quality_notes?.length ?? 0) > 0 && (
            <details className="coach-caveats">
              <summary>Data caveats · {result.data_quality_notes!.length}</summary>
              <div>{result.data_quality_notes!.join(' · ')}</div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

// LAST FOCUS — how last session's focus items fared. The app measures each
// one from telemetry (baseline → current against the target); the model adds
// a short comment. The chip shows the measured verdict when there is one.
const VERDICT_LABEL: Record<FocusVerdict, string> = {
  met: 'Target met', improved: 'Improved', no_change: 'No change', worse: 'Worse', not_measured: 'Not measured',
}
function verdictTone(verdict: string): 'good' | 'bad' | 'neutral' {
  if (verdict === 'met' || verdict === 'improved') return 'good'
  if (verdict === 'worse') return 'bad'
  return 'neutral'
}

function LastFocusSection({ items, onFocusRef, onHoverRef, onFocusAnnotation }: {
  items: NonNullable<CoachingResult['previous_focus_review']>
  onFocusRef?: (ref: string) => void
  onHoverRef?: (ref: string | null) => void
  onFocusAnnotation?: (a: CoachAnnotation | null) => void
}) {
  return (
    <section className="coach-last-focus">
      <div className="coach-section-heading">
        <span>Last focus</span>
        <small>Measured from these laps · baseline → now (target)</small>
      </div>
      <div className="coach-last-focus-list">
        {items.map(item => {
          const measured = item.measured
          const verdict = measured?.verdict ?? item.verdict
          const title = measured?.cue || measured?.complexName || 'Previous focus'
          const ref = measured?.ref || null
          const place = measured?.cue ? measured.complexName : ''
          const subtitle = [place, ref && !`${title} ${place}`.includes(ref) ? ref : ''].filter(Boolean).join(' · ')
          return (
            <div key={item.focusId} className="coach-last-focus-item"
              onMouseEnter={() => ref && onHoverRef?.(ref)}
              onMouseLeave={() => onHoverRef?.(null)}>
              <div className="coach-last-focus-head">
                <div className="coach-last-focus-title">
                  <strong>{title}</strong>
                  {subtitle && <small>{subtitle}</small>}
                </div>
                <span className={`coach-verdict coach-verdict-${verdictTone(verdict)}`}>
                  {VERDICT_LABEL[verdict as FocusVerdict] ?? verdict.replace(/_/g, ' ')}
                </span>
                {ref && onFocusRef && (
                  <button className="coach-map-link" type="button" onClick={() => { onFocusRef(ref); onFocusAnnotation?.(null) }}>
                    View on map ↗
                  </button>
                )}
              </div>
              {measured && (
                <div className="coach-last-focus-metric">
                  <span>{measured.metricLabel}</span>
                  <strong>{measured.display.baseline} → {measured.display.current}</strong>
                  <small>target {measured.display.target}{measured.laps > 0 ? ` · ${plural(measured.laps, 'lap')}` : ''}</small>
                </div>
              )}
              {item.comment && <div className="coach-last-focus-comment">{item.comment}</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function NextSessionPlanPanel({ plan }: { plan: NonNullable<CoachingResult['next_session_plan']> }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="chart-card coach-card" style={{ marginBottom: 18 }}>
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(value => !value)}>
        <span className="channel-tag">Next Session Plan</span>
        <span className="meta">{open ? '▲ collapse' : '▼ expand'}</span>
      </div>
      {open && (
        <div style={{ padding: '28px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plan.map((step, index) => (
            <div key={index} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '11px 13px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{step.run}</div>
              <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{step.focus}</div>
              {step.success_metric && <div style={{ marginTop: 6, fontSize: 9.5, color: 'var(--text-mute)', lineHeight: 1.45 }}><b>VERIFY</b> · {step.success_metric}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RecommendedPracticePanel({ drills }: { drills: string[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="chart-card coach-card" style={{ marginBottom: 18 }}>
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
                fontSize: 22, lineHeight: 1, color: 'var(--cyan)',
                opacity: 0.4, flexShrink: 0, width: 28, textAlign: 'right',
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

// CAR SETUP — mechanical/configuration recommendations the telemetry supports.
// Deliberately allows an empty state: if the coach found no setup signature,
// we say so rather than inventing advice — without implying the setup is right.
function CarSetupPanel({ setup }: { setup?: CoachSetupRec[] }) {
  const [open, setOpen] = useState(true)
  const recs = setup ?? []
  const CONF_LABEL = ['', 'speculative', 'likely', 'strong evidence']

  return (
    <div className="chart-card coach-card car-setup-card" style={{ marginBottom: 18 }}>
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="channel-tag">Car Setup</span>
        <span className="meta">{recs.length ? `${recs.length} rec${recs.length > 1 ? 's' : ''} · ` : ''}{open ? '▲ collapse' : '▼ expand'}</span>
      </div>

      {open && (
        <div style={{ padding: '28px 16px 16px' }}>
          {recs.length === 0 ? (
            <div className="car-setup-empty">
              No setup change recommended — these laps don't show a repeated balance
              problem. That's not proof the setup is optimal.
            </div>
          ) : (
            <div className="car-setup-list">
              {recs.map((r, i) => {
                const conf = r.confidence ?? 0
                return (
                  <div key={i} className="car-setup-rec">
                    <div className="car-setup-rec-head">
                      <span className="car-setup-area">
                        <WrenchIcon /> {r.area}
                      </span>
                      {conf > 0 && (
                        <span className="car-setup-conf" title={`confidence: ${CONF_LABEL[conf]}`}>
                          {[1, 2, 3].map(n => (
                            <span key={n} className={`car-setup-pip ${n <= conf ? 'on' : ''}`} />
                          ))}
                          <span className="car-setup-conf-label">{CONF_LABEL[conf]}</span>
                        </span>
                      )}
                    </div>
                    <div className="car-setup-change">{r.change}</div>
                    <div className="car-setup-rationale">{r.rationale}</div>
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

function WrenchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.3l-6 6a1.5 1.5 0 0 0 2.1 2.1l6-6a4 4 0 0 0 5.3-5.4l-2.4 2.4-2.1-2.1 2.5-2.3z" />
    </svg>
  )
}
