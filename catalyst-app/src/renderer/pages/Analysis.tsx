// Analysis page — selected sessions in, full Plotly dashboard out.
// Every chart wrapped in an instrument-card. Theme matches the rest of the app.

import { useEffect, useMemo, useState } from 'react'
import { api, msToLap } from '../api'
import { ChartCard } from '../components/ChartCard'
import {
  PlotlyChart, PALETTE, LAP_PALETTE, lapColor,
  cornerShapes, cornerAnnotations, segmentLines,
} from '../components/PlotlyChart'
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

      <div className="page-body">
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

        {data && !loading && !err && <AnalysisBody data={data} setSelected={setSelected} selected={selected} />}
      </div>
    </>
  )
}

// ============================================================================

function AnalysisBody({ data, selected, setSelected }: {
  data: AnalysisData
  selected: Set<string>
  setSelected: (s: Set<string>) => void
}) {
  const sessionsSorted = useMemo(
    () => [...data.sessions].sort((a, b) => (b.start ?? '').localeCompare(a.start ?? '')),
    [data.sessions],
  )

  // Shared crosshair — distance_m hovered on any of the time-series charts
  // with a distance x-axis. TrackMap renders a white dot at that point on
  // the best-lap racing line so the user can correlate any chart row to
  // the exact spatial location on the track.
  const [hoverDistanceM, setHoverDistanceM] = useState<number | null>(null)

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

      {/* 2-column layout: scrolling chart column + sticky track map.
          Track map stays pinned as the chart column scrolls, and the white
          crosshair on it tracks whichever chart you're hovering on. */}
      <div className="analysis-layout">
        <div className="analysis-charts">
          {/* SPEED */}
          <ChartCard
            channel="CH·01 SPEED"
            meta={`${data.speedTraces.length} laps · mph`}
          >
            <PlotlyChart
              height={460}
              data={speedFigure(data).data}
              layout={speedFigure(data).layout}
              onHoverDistance={setHoverDistanceM}
            />
          </ChartCard>

          {/* HEATMAP */}
          {data.heatmap && (
            <ChartCard
              channel="CH·02 SEGMENT Δ"
              meta="seconds · best per segment = 0"
            >
              <PlotlyChart
                height={Math.max(360, data.heatmap.rows.length * 22 + 80)}
                data={heatmapFigure(data).data}
                layout={heatmapFigure(data).layout}
              />
            </ChartCard>
          )}

          {/* G-G */}
          <ChartCard channel="CH·03 G-G" meta={`p95 ≈ ${data.gg.p95_g.toFixed(2)}g`}>
            <PlotlyChart
              height={460}
              data={ggFigure(data).data}
              layout={ggFigure(data).layout}
            />
          </ChartCard>

          {/* LATERAL POSITION */}
          <ChartCard
            channel="CH·05 LATERAL POSITION"
            meta="0 = inner · 1 = outer · 0.5 = centre"
          >
            <PlotlyChart
              height={300}
              data={lateralFigure(data).data}
              layout={lateralFigure(data).layout}
              onHoverDistance={setHoverDistanceM}
            />
          </ChartCard>

          {/* LONGITUDINAL G */}
          <ChartCard
            channel="CH·06 LONG. G"
            meta="braking (neg) · acceleration (pos)"
          >
            <PlotlyChart
              height={320}
              data={longgFigure(data).data}
              layout={longgFigure(data).layout}
              onHoverDistance={setHoverDistanceM}
            />
          </ChartCard>

          {/* CORNERS */}
          {data.cornerRows.length > 0 && (
            <ChartCard
              channel="CH·07 CORNER STATS"
              meta="entry · apex · exit"
            >
              <PlotlyChart
                height={560}
                data={cornersFigure(data).data}
                layout={cornersFigure(data).layout}
              />
            </ChartCard>
          )}
        </div>

        <aside className="analysis-trackmap-sticky">
          <ChartCard
            channel="CH·04 TRACK MAP"
            meta="racing line · drag to pan · ⌘+scroll to zoom"
          >
            <TrackMap data={data} height={620} hoverDistanceM={hoverDistanceM} />
          </ChartCard>
        </aside>
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

// ============================================================================
// Plotly figure builders. Each returns { data, layout } scoped to this dataset.
// ============================================================================

function speedFigure(d: AnalysisData) {
  const data = d.speedTraces.map((t, i) => ({
    x: t.dist, y: t.speed_mph,
    name: `${t.isBest ? '★ ' : ''}${t.sgShort}… L${t.lapIdx + 1} ${msToLap(t.durationMs)}`,
    type: 'scatter', mode: 'lines',
    line: { color: lapColor(i, t.isBest), width: t.isBest ? 3 : 1.4 },
    opacity: t.isBest ? 1 : 0.6,
    hovertemplate: '%{y:.1f} mph @ %{x}m<extra></extra>',
  })) as any[]
  return {
    data,
    layout: {
      xaxis: { title: 'Distance (m)' },
      yaxis: { title: 'Speed (mph)' },
      shapes: [...cornerShapes(d.corners), ...segmentLines(d.segments)],
      annotations: cornerAnnotations(d.corners),
      hovermode: 'x unified',
    } as any,
  }
}

function heatmapFigure(d: AnalysisData) {
  const hm = d.heatmap!
  const zmax = Math.max(hm.zmax, 0.1)
  // Compact cell labels — just the delta. Color already encodes magnitude;
  // hover shows the full split. The PB row gets the absolute time instead.
  const cellText = hm.text.map((row, ri) =>
    row.map((t, ci) => {
      if (t === '—') return ''
      const z = hm.z[ri][ci]
      if (z == null) return ''
      const isPb = ri === hm.z.length - 1
      if (isPb) return t.replace(' PB', '')
      return z === 0 ? 'PB' : `+${z.toFixed(2)}`
    }),
  )
  return {
    data: ([{
      type: 'heatmap',
      x: hm.cols, y: hm.rows, z: hm.z, text: hm.text,
      customdata: cellText,
      hovertemplate: '%{text}<extra>%{y}</extra>',
      texttemplate: '%{customdata}',
      textfont: { size: 10, color: '#fff', family: '"JetBrains Mono", monospace' },
      xgap: 1, ygap: 1,
      colorscale: [
        [0,    PALETTE.green],
        [0.1,  PALETTE.teal],
        [0.25, PALETTE.amber],
        [0.6,  PALETTE.signal],
        [1,    PALETTE.red],
      ],
      zmin: 0, zmax,
      showscale: true,
      colorbar: {
        title: { text: 'Δ PB (s)', font: { color: PALETTE.text, family: '"JetBrains Mono", monospace', size: 10 } } as any,
        tickfont: { color: PALETTE.textDim, family: '"JetBrains Mono", monospace', size: 10 },
        thickness: 10, len: 0.85,
      },
    }] as any),
    layout: {
      xaxis: { title: '', side: 'top' },
      yaxis: { autorange: 'reversed' },
      hovermode: 'closest',
      margin: { l: 240, r: 80, t: 30, b: 20 },
    } as any,
  }
}

function ggFigure(d: AnalysisData) {
  return {
    data: [
      {
        type: 'scatter',
        x: d.gg.lat_g, y: d.gg.long_g,
        mode: 'markers',
        marker: {
          color: d.gg.speed_mph,
          colorscale: [
            [0,    PALETTE.cyan],
            [0.5,  PALETTE.amber],
            [1,    PALETTE.signal],
          ],
          size: 3, opacity: 0.5,
          colorbar: {
            title: { text: 'mph', font: { color: PALETTE.text, family: '"JetBrains Mono", monospace', size: 10 } } as any,
            tickfont: { color: PALETTE.textDim, family: '"JetBrains Mono", monospace', size: 10 },
            thickness: 10, len: 0.8,
          },
        },
        hovertemplate: 'Lat %{x:.2f}g  Long %{y:.2f}g<extra></extra>',
        name: '',
      },
      {
        type: 'scatter',
        x: d.gg.circle.x, y: d.gg.circle.y,
        mode: 'lines',
        line: { color: PALETTE.signal, width: 1.5, dash: 'dash' },
        opacity: 0.6,
        name: `p95 ≈ ${d.gg.p95_g.toFixed(2)}g`,
        hoverinfo: 'skip',
      },
    ] as any[],
    layout: {
      xaxis: { title: 'Lateral G  (← left | right →)', zeroline: true, zerolinecolor: PALETTE.borderStrong, scaleanchor: 'y' },
      yaxis: { title: 'Longitudinal G  (brake ↓ | accel ↑)', zeroline: true, zerolinecolor: PALETTE.borderStrong },
      shapes: [
        { type: 'line', x0: 0, x1: 0, y0: -2.2, y1: 2.2, line: { color: PALETTE.borderStrong, width: 1 } },
        { type: 'line', x0: -2.2, x1: 2.2, y0: 0, y1: 0, line: { color: PALETTE.borderStrong, width: 1 } },
      ] as any,
      hovermode: 'closest',
      showlegend: false,
    } as any,
  }
}

function trackMapFigure(d: AnalysisData) {
  const lats = d.trackMap.lat, lons = d.trackMap.lon
  const latSpan = lats.length ? Math.max(...lats) - Math.min(...lats) : 1
  const lonSpan = lons.length ? Math.max(...lons) - Math.min(...lons) : 1
  // approximate lon→lat aspect at the track latitude
  const meanLat = lats.length ? (Math.max(...lats) + Math.min(...lats)) / 2 : 0
  const lonShrink = Math.cos((meanLat * Math.PI) / 180)
  const aspect = lonSpan > 0 ? (latSpan / lonSpan) / lonShrink : 1

  return {
    data: [{
      type: 'scatter',
      x: lons, y: lats,
      mode: 'markers',
      marker: {
        color: d.trackMap.speed_mph,
        colorscale: [
          [0,    PALETTE.cyan],
          [0.5,  PALETTE.amber],
          [1,    PALETTE.signal],
        ],
        size: 4,
        showscale: true,
        colorbar: {
          title: { text: 'mph', font: { color: PALETTE.text, family: '"JetBrains Mono", monospace', size: 10 } } as any,
          tickfont: { color: PALETTE.textDim, family: '"JetBrains Mono", monospace', size: 10 },
          thickness: 10, len: 0.8,
        },
      },
      hovertemplate: '%{marker.color:.0f} mph<extra></extra>',
      name: '',
    }] as any[],
    layout: {
      xaxis: { title: 'Longitude', scaleanchor: 'y', scaleratio: aspect, showgrid: false, zeroline: false, showticklabels: false },
      yaxis: { title: 'Latitude', showgrid: false, zeroline: false, showticklabels: false },
      hovermode: 'closest',
      showlegend: false,
      margin: { l: 16, r: 80, t: 30, b: 16 },
    } as any,
  }
}

function lateralFigure(d: AnalysisData) {
  const data = d.lateralTraces.map((t, i) => ({
    x: t.dist, y: t.pos,
    name: `${t.isBest ? '★ ' : ''}${t.sgShort}… L${t.lapIdx + 1}`,
    type: 'scatter', mode: 'lines',
    line: { color: lapColor(i, t.isBest), width: t.isBest ? 2.5 : 1.2 },
    opacity: t.isBest ? 1 : 0.5,
    hovertemplate: 'pos %{y:.3f} @ %{x}m<extra></extra>',
  })) as any[]
  return {
    data,
    layout: {
      xaxis: { title: 'Distance (m)' },
      yaxis: { title: 'Lateral pos', range: [-0.05, 1.05] },
      shapes: cornerShapes(d.corners),
      annotations: cornerAnnotations(d.corners, 1.05),
      hovermode: 'x unified',
      margin: { l: 56, r: 16, t: 18, b: 44 },
    } as any,
  }
}

function longgFigure(d: AnalysisData) {
  const data = d.longgTraces.map((t, i) => ({
    x: t.dist, y: t.long_g,
    name: `${t.isBest ? '★ ' : ''}${t.sgShort}… L${t.lapIdx + 1}`,
    type: 'scatter', mode: 'lines',
    line: { color: lapColor(i, t.isBest), width: t.isBest ? 2.5 : 1.2 },
    opacity: t.isBest ? 1 : 0.5,
    hovertemplate: '%{y:.2f}g @ %{x}m<extra></extra>',
  })) as any[]
  return {
    data,
    layout: {
      xaxis: { title: 'Distance (m)' },
      yaxis: { title: 'Long. G' },
      shapes: [
        ...cornerShapes(d.corners),
        ...segmentLines(d.segments),
        { type: 'line', x0: 0, x1: d.totalDistM || 5500, y0: 0, y1: 0, line: { color: PALETTE.borderStrong, width: 1 } } as any,
      ],
      annotations: cornerAnnotations(d.corners, 1.05),
      hovermode: 'x unified',
      margin: { l: 56, r: 16, t: 18, b: 44 },
    } as any,
  }
}

function cornersFigure(d: AnalysisData) {
  const rows = d.cornerRows
  const turnOrder = d.corners.map(c => c.turn).filter(t => rows.some(r => r.turn === t))

  const build = (metric: 'entry_mph' | 'apex_mph' | 'exit_mph', color: string, sym: string) => {
    const norm = rows.filter(r => !r.isBest)
    const best = rows.filter(r => r.isBest)
    return [
      {
        type: 'scatter',
        x: norm.map(r => r.turn),
        y: norm.map(r => r[metric]),
        mode: 'markers',
        marker: { color, size: 6, opacity: 0.55, symbol: sym as any },
        text: norm.map(r => r.lapLbl),
        name: metric.split('_')[0],
        hovertemplate: `%{y:.1f} mph — %{text}<extra>${metric.split('_')[0]}</extra>`,
        legendgroup: metric,
      },
      ...(best.length ? [{
        type: 'scatter',
        x: best.map(r => r.turn),
        y: best.map(r => r[metric]),
        mode: 'markers',
        marker: { color: PALETTE.signal, size: 14, opacity: 1, symbol: 'star' as any, line: { color: '#000', width: 1 } },
        text: best.map(r => r.lapLbl),
        name: `${metric.split('_')[0]} ★`,
        hovertemplate: `★ %{y:.1f} mph — %{text}<extra></extra>`,
        legendgroup: metric,
      }] : []),
    ]
  }

  return {
    data: [
      ...build('entry_mph', PALETTE.cyan, 'circle'),
      ...build('apex_mph', PALETTE.signal, 'diamond'),
      ...build('exit_mph', PALETTE.green, 'square'),
    ] as any[],
    layout: {
      xaxis: { title: 'Corner', categoryorder: 'array', categoryarray: turnOrder },
      yaxis: { title: 'Speed (mph)' },
      hovermode: 'closest',
      margin: { l: 56, r: 16, t: 18, b: 56 },
    } as any,
  }
}
