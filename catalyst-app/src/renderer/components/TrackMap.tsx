// Interactive SVG track map.
//
// Renders a real track shape (filled ribbon between left/right edges) from the
// mean-line geometry, then layers driving data on top:
//   - Centerline reference (dashed)
//   - Sector boundary ticks
//   - Best-lap racing line, stroke coloured by mph (a "speed heatmap")
//   - Comparison laps as faint single-colour traces
//   - Sample markers showing per-point speed/G on hover
//
// Pan = drag; zoom = wheel (anchored on the cursor); double-click = fit-to-track.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisData, RacingLineLap, TrackGeometryPayload } from '../../garmin/analysisData'
import { LAP_PALETTE } from './PlotlyChart'

// Structural subset of AnalysisData that this component actually needs. Both
// the Analysis page (passes its full AnalysisData) and the Tracks editor
// (passes a hand-rolled object with no racing lines) satisfy this shape.
export interface TrackMapInput {
  trackGeometry: TrackGeometryPayload | null
  racingLines: RacingLineLap[]
  sessions: Array<{ sg: string }>
}

// In editing mode, the parent supplies the corner list + a selected turn key
// and gets callbacks when the user clicks on the track (to set the apex of
// the selected corner) or on an existing corner marker (to select it).
export interface TrackMapEditState {
  corners: Array<{
    turn: string
    name?: string
    apex_idx?: number
    dist_idx_start?: number
    dist_idx_end?: number
    direction?: string
  }>
  selectedTurn: string | null
  onPickApex: (apexIdx: number) => void
  onSelectTurn: (turn: string) => void
}

interface Props {
  data: TrackMapInput | AnalysisData
  height?: number | string
  // When set, a white crosshair is drawn on the best-lap racing line at this
  // cumulative distance. Lets the parent sync mouse-hover from other charts
  // (which use distance_m on x) onto the spatial track view.
  hoverDistanceM?: number | null
  // When provided, the map enters editing mode: corner apex markers are drawn
  // prominently, clicks on the track move the *selected* corner's apex, and
  // clicks on a marker change which corner is selected. The racing-line speed
  // heatmap is hidden in this mode to keep the visual focus on corners.
  edit?: TrackMapEditState
}

interface ViewBox { x: number; y: number; w: number; h: number }

const SVG_PADDING = 30        // track-space metres of padding around bbox

// Colour ramp: violet (slow) → cyan → green → yellow → red (fast)
const SPEED_RAMP: Array<[number, string]> = [
  [0.0, '#6a1b9a'],
  [0.2, '#5d3fd3'],
  [0.4, '#4fc3f7'],
  [0.6, '#5dd17f'],
  [0.8, '#f5a623'],
  [1.0, '#ff5e3a'],
]

function lerpColor(c1: string, c2: string, t: number): string {
  const a = c1.match(/[\da-f]{2}/gi)!.map(h => parseInt(h, 16))
  const b = c2.match(/[\da-f]{2}/gi)!.map(h => parseInt(h, 16))
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return `#${m.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function speedColor(t: number): string {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < SPEED_RAMP.length; i++) {
    if (x <= SPEED_RAMP[i][0]) {
      const [t0, c0] = SPEED_RAMP[i - 1]
      const [t1, c1] = SPEED_RAMP[i]
      return lerpColor(c0, c1, (x - t0) / (t1 - t0))
    }
  }
  return SPEED_RAMP[SPEED_RAMP.length - 1][1]
}

// Flip the y-axis once at projection time: SVG +y is down, our geometry is
// north-up. We pass the *raw* metres in and apply -y in the path-builders so
// downstream maths stays in real-world coords.
function pathFromPoints(pts: Array<{ x: number; y: number }>, closed = false): string {
  if (!pts.length) return ''
  let d = `M${pts[0].x.toFixed(2)} ${(-pts[0].y).toFixed(2)}`
  for (let i = 1; i < pts.length; i++) d += `L${pts[i].x.toFixed(2)} ${(-pts[i].y).toFixed(2)}`
  if (closed) d += 'Z'
  return d
}

// Build a filled ribbon polygon for the track surface: left edge forward,
// then right edge in reverse, closed. Renders as a single fill.
function ribbonPath(left: Array<{ x: number; y: number }>, right: Array<{ x: number; y: number }>): string {
  if (!left.length || !right.length) return ''
  let d = `M${left[0].x.toFixed(2)} ${(-left[0].y).toFixed(2)}`
  for (let i = 1; i < left.length; i++) d += `L${left[i].x.toFixed(2)} ${(-left[i].y).toFixed(2)}`
  for (let i = right.length - 1; i >= 0; i--) d += `L${right[i].x.toFixed(2)} ${(-right[i].y).toFixed(2)}`
  d += 'Z'
  return d
}

type TrackMetric = 'speed_mph' | 'lat_g' | 'long_g'

const METRIC_META: Record<TrackMetric, { label: string; unit: string; abs: boolean }> = {
  speed_mph: { label: 'Speed',    unit: 'mph', abs: false },
  lat_g:     { label: 'Lat G',    unit: 'g',   abs: true  },
  long_g:    { label: 'Long G',   unit: 'g',   abs: true  },
}

function getMetricValues(lap: RacingLineLap, metric: TrackMetric): number[] {
  const raw = lap[metric] as number[]
  return METRIC_META[metric].abs ? raw.map(Math.abs) : raw
}

// Nearest index in a sorted dist[] array for a given distance value.
function nearestDistIdx(dist: number[], target: number): number {
  let lo = 0, hi = dist.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (dist[mid] < target) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(dist[lo - 1] - target) < Math.abs(dist[lo] - target)) return lo - 1
  return lo
}

// Per-lap heatmap — many short line segments coloured by the chosen metric.
function HeatmapPath({ lap, values, vmin, vmax }: {
  lap: RacingLineLap; values: number[]; vmin: number; vmax: number
}) {
  const segments = []
  const range = Math.max(1e-6, vmax - vmin)
  for (let i = 1; i < lap.x.length; i++) {
    const t = ((values[i] + values[i - 1]) / 2 - vmin) / range
    segments.push(
      <line
        key={i}
        x1={lap.x[i - 1]} y1={-lap.y[i - 1]}
        x2={lap.x[i]}     y2={-lap.y[i]}
        stroke={speedColor(t)}
        strokeWidth={1.4}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />,
    )
  }
  return <g>{segments}</g>
}

export function TrackMap({ data, height = 560, hoverDistanceM = null, edit }: Props) {
  const { trackGeometry: geom, racingLines } = data
  const svgRef = useRef<SVGSVGElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null)

  const fitBox = useMemo<ViewBox | null>(() => {
    if (!geom) return null
    const b = geom.bbox
    return {
      x: b.minX - SVG_PADDING,
      y: -b.maxY - SVG_PADDING,
      w: (b.maxX - b.minX) + SVG_PADDING * 2,
      h: (b.maxY - b.minY) + SVG_PADDING * 2,
    }
  }, [geom])
  const [vb, setVb] = useState<ViewBox | null>(fitBox)
  useEffect(() => { setVb(fitBox) }, [fitBox])

  // Layer toggles + metric selector
  const [showCenter,      setShowCenter]    = useState(false)
  // Index 0 = best lap; indices 1+ = comparison laps. Best lap selected by default.
  const [selectedLapIdxs, setSelectedLapIdxs] = useState<Set<number>>(new Set([0]))
  const [metric,          setMetric]        = useState<TrackMetric>('speed_mph')

  // Hover state — index into bestLap arrays, plus container-relative position
  const [hoverIdx,    setHoverIdx]    = useState<number | null>(null)
  const [tooltipPos,  setTooltipPos]  = useState<{ x: number; y: number } | null>(null)

  const bestLap = racingLines[0] ?? null

  // Value range for the current metric (used for heatmap colour scale + legend).
  const [vmin, vmax] = useMemo(() => {
    if (!bestLap) return [0, 100]
    const vals = getMetricValues(bestLap, metric)
    let mn = Infinity, mx = -Infinity
    for (const v of vals) {
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    return [mn, mx]
  }, [bestLap, metric])

  // Centerline distance → position lookup for sector ticks.
  const centerByDist = useMemo(() => {
    if (!geom) return [] as Array<{ x: number; y: number; dist: number }>
    return geom.centerline
  }, [geom])

  function pointAtDist(distM: number): { x: number; y: number } | null {
    if (!centerByDist.length) return null
    // Centerline is at 1 m spacing in the proto so we can index directly.
    const i = Math.max(0, Math.min(centerByDist.length - 1, Math.round(distM)))
    return centerByDist[i]
  }

  // ─── Interaction ────────────────────────────────────────────────────────────

  // Returns the rendered sub-rectangle of the SVG element.
  // preserveAspectRatio="xMidYMid meet" fits the viewBox into the element while
  // maintaining aspect ratio, centering it and leaving empty space on two sides.
  // All hit-testing must map into this sub-rectangle, not the full element rect.
  function renderedRect(): { left: number; top: number; w: number; h: number } | null {
    const svg = svgRef.current
    if (!svg || !vb) return null
    const r = svg.getBoundingClientRect()
    const scale = Math.min(r.width / vb.w, r.height / vb.h)
    const rw = vb.w * scale
    const rh = vb.h * scale
    return {
      left: r.left + (r.width - rw) / 2,
      top:  r.top  + (r.height - rh) / 2,
      w: rw,
      h: rh,
    }
  }

  function screenToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const rr = renderedRect()
    if (!rr || !vb) return null
    const fx = (clientX - rr.left) / rr.w
    const fy = (clientY - rr.top)  / rr.h
    return { x: vb.x + fx * vb.w, y: vb.y + fy * vb.h }
  }

  function zoomAt(clientX: number, clientY: number, factor: number) {
    if (!vb) return
    const focus = screenToWorld(clientX, clientY)
    if (!focus) return
    setVb({
      x: focus.x - (focus.x - vb.x) * factor,
      y: focus.y - (focus.y - vb.y) * factor,
      w: vb.w * factor,
      h: vb.h * factor,
    })
  }

  // Wheel needs a non-passive listener to preventDefault, which React's
  // synthetic onWheel doesn't give us. Attach manually so we can opt out
  // (pass-through to page scroll) unless a modifier is held.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      // Trackpad pinch on macOS arrives as wheel + ctrlKey=true. We also
      // accept explicit Cmd/Ctrl-scroll as the desktop-mouse zoom gesture.
      // Without a modifier we let the page scroll naturally.
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const factor = Math.exp(e.deltaY * 0.008)
      zoomAt(e.clientX, e.clientY, factor)
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  }, [vb])

  const zoomCenter = (factor: number) => {
    const svg = svgRef.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor)
  }

  // Track whether the pointer moved meaningfully between down/up — separates
  // a click (snap-to-apex in edit mode) from a drag (pan).
  const moveSinceDownRef = useRef(0)

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!vb) return
    svgRef.current?.setPointerCapture(e.pointerId)
    dragStateRef.current = { x: e.clientX, y: e.clientY, vb }
    moveSinceDownRef.current = 0
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragStateRef.current
    const svg = svgRef.current
    if (svg) {
      if (d) {
        // Pan drag — use rendered sub-rect so 1px drag = 1px pan
        const r = svg.getBoundingClientRect()
        moveSinceDownRef.current = Math.max(
          moveSinceDownRef.current,
          Math.hypot(e.clientX - d.x, e.clientY - d.y),
        )
        const scale = Math.min(r.width / d.vb.w, r.height / d.vb.h)
        const rw = d.vb.w * scale
        const rh = d.vb.h * scale
        const dx = ((e.clientX - d.x) / rw) * d.vb.w
        const dy = ((e.clientY - d.y) / rh) * d.vb.h
        setVb({ x: d.vb.x - dx, y: d.vb.y - dy, w: d.vb.w, h: d.vb.h })
      } else if (bestLap && vb) {
        // Hover detection — find nearest best-lap point in SVG space.
        // SVG space has y-flipped: a world point (x,y) is at SVG (x, -y).
        const w = screenToWorld(e.clientX, e.clientY)
        if (w) {
          let nearI = 0, nearD = Infinity
          for (let i = 0; i < bestLap.x.length; i++) {
            const dx = bestLap.x[i] - w.x
            const dy = -bestLap.y[i] - w.y
            const dist = dx * dx + dy * dy
            if (dist < nearD) { nearD = dist; nearI = i }
          }
          // Only show tooltip if within ~40 CSS pixels of a sample
          const rr = renderedRect()
          const pxPerSvgUnit = rr ? rr.w / vb.w : 1
          const threshold = (40 / pxPerSvgUnit) ** 2
          if (nearD < threshold) {
            setHoverIdx(nearI)
            const cRect = containerRef.current?.getBoundingClientRect()
            if (cRect) setTooltipPos({ x: e.clientX - cRect.left, y: e.clientY - cRect.top })
          } else {
            setHoverIdx(null)
            setTooltipPos(null)
          }
        }
      }
    }
  }

  function onPointerLeave() {
    setHoverIdx(null)
    setTooltipPos(null)
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    svgRef.current?.releasePointerCapture(e.pointerId)
    dragStateRef.current = null
    // In edit mode, a click (no real drag) sets the selected corner's apex.
    if (edit && geom && moveSinceDownRef.current < 4) {
      const w = screenToWorld(e.clientX, e.clientY)
      if (w) {
        // Find nearest centerline point. Our world y was flipped at render
        // time (we negate y in path builders) so flip back here too.
        const target = { x: w.x, y: -w.y }
        let bestI = 0, bestD = Infinity
        for (let i = 0; i < geom.centerline.length; i++) {
          const c = geom.centerline[i]
          const d = (c.x - target.x) ** 2 + (c.y - target.y) ** 2
          if (d < bestD) { bestD = d; bestI = i }
        }
        edit.onPickApex(bestI)
      }
    }
  }
  function fitToTrack() { setVb(fitBox) }

  // Hover crosshair — look up the best-lap sample whose cumulative distance
  // is closest to the hovered chart x value. Best-lap samples are at 5 m
  // spacing in the racing-line payload so the lookup is O(1) by index.
  const crosshair = useMemo(() => {
    if (hoverDistanceM == null || !bestLap || !bestLap.dist.length) return null
    // Binary-search for nearest distance index.
    const arr = bestLap.dist
    let lo = 0, hi = arr.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid] < hoverDistanceM) lo = mid + 1
      else hi = mid
    }
    // lo is the first index whose dist >= hoverDistanceM; check lo-1 too.
    const cand = [lo, Math.max(0, lo - 1)]
    let best = cand[0]
    let bestErr = Math.abs(arr[cand[0]] - hoverDistanceM)
    for (const i of cand.slice(1)) {
      const e = Math.abs(arr[i] - hoverDistanceM)
      if (e < bestErr) { best = i; bestErr = e }
    }
    return {
      x: bestLap.x[best],
      y: bestLap.y[best],
      speed: bestLap.speed_mph[best],
    }
  }, [hoverDistanceM, bestLap])

  if (!geom) {
    return (
      <div className="track-map-empty" style={{ height }}>
        <div className="muted small">
          No track geometry available for the selected sessions
          {data.sessions.length > 0 ? ' (mean_line.pb missing — re-sync to fetch it)' : '.'}
        </div>
      </div>
    )
  }

  return (
    <div className="track-map" ref={containerRef} style={{ height }}>
      <div className="track-map-controls">
        <MetricDropdown metric={metric} onChange={setMetric} />
        <LayerToggle on={showCenter} onChange={setShowCenter}>centerline</LayerToggle>
        {racingLines.length > 0 && (
          <LapPickerDropdown
            laps={racingLines}
            selected={selectedLapIdxs}
            onChange={setSelectedLapIdxs}
          />
        )}
        <span className="spacer" />
        <button className="btn tiny ghost" title="Zoom in"   onClick={() => zoomCenter(0.8)}>+</button>
        <button className="btn tiny ghost" title="Zoom out"  onClick={() => zoomCenter(1.25)}>−</button>
        <button className="btn tiny ghost" title="Fit to track (or double-click)" onClick={fitToTrack}>Fit</button>
      </div>

      <svg
        ref={svgRef}
        viewBox={vb ? `${vb.x} ${vb.y} ${vb.w} ${vb.h}` : undefined}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={fitToTrack}
        style={{
          width: '100%',
          flex: 1,
          minHeight: 0,
          cursor: dragStateRef.current
            ? 'grabbing'
            : edit
              ? 'crosshair'
              : 'grab',
        }}
      >
        {/* L1 — track surface ribbon (always on) */}
        <path
          d={ribbonPath(geom.leftEdge, geom.rightEdge)}
          fill="#1a1a22"
          stroke="#34343d"
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />

        {/* L2 — centerline reference */}
        {showCenter && (
          <path
            d={pathFromPoints(geom.centerline)}
            fill="none"
            stroke="#5e5e68"
            strokeWidth={0.6}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* L3 — sector ticks (always on) */}
        {geom.sectorMarks.map((m, i) => {
          const p = pointAtDist(m.distM)
          if (!p) return null
          // perpendicular direction at this distance
          const prev = pointAtDist(m.distM - 1)
          const next = pointAtDist(m.distM + 1)
          if (!prev || !next) return null
          const tx = next.x - prev.x, ty = next.y - prev.y
          const len = Math.hypot(tx, ty) || 1
          const nx = -ty / len, ny = tx / len
          const L = (geom.widthM / 2) + 3
          const x1 = p.x + nx * L, y1 = p.y + ny * L
          const x2 = p.x - nx * L, y2 = p.y - ny * L
          return (
            <line key={i}
              x1={x1} y1={-y1} x2={x2} y2={-y2}
              stroke={m.type === 'start' ? '#ffd700' : '#5e5e68'}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              opacity={0.7}
            />
          )
        })}

        {/* L4 — selected comparison laps (indices 1+) as solid coloured traces */}
        {racingLines.slice(1).map((lap, i) => selectedLapIdxs.has(i + 1) && (
          <path
            key={`cmp-${lap.sg}-${lap.lapIdx}`}
            d={pathFromPoints(lap.x.map((x, k) => ({ x, y: lap.y[k] })))}
            fill="none"
            stroke={LAP_PALETTE[i % LAP_PALETTE.length]}
            strokeOpacity={0.75}
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* L5 — best lap (index 0) heatmap, shown when selected */}
        {!edit && selectedLapIdxs.has(0) && bestLap && (
          <HeatmapPath lap={bestLap} values={getMetricValues(bestLap, metric)} vmin={vmin} vmax={vmax} />
        )}

        {/* L5z — corner zone of the selected corner. We draw a thick faint
             arc along the centerline between dist_idx_start..dist_idx_end so
             the user can see what window the Analysis charts will treat as
             "this corner" (entry/apex/exit speeds, shaded zone overlay). */}
        {edit && edit.corners.map((c) => {
          if (edit.selectedTurn !== c.turn) return null
          if (c.apex_idx == null) return null
          const lo = c.dist_idx_start ?? Math.max(0, c.apex_idx - 50)
          const hi = c.dist_idx_end ?? Math.min(geom.centerline.length - 1, c.apex_idx + 50)
          const slice = geom.centerline.slice(Math.max(0, Math.round(lo)), Math.min(geom.centerline.length, Math.round(hi) + 1))
          if (slice.length < 2) return null
          return (
            <path
              key={`zone-${c.turn}`}
              d={pathFromPoints(slice)}
              fill="none"
              stroke="#ff5e3a"
              strokeOpacity={0.55}
              strokeWidth={Math.max(4, geom.widthM * 0.9)}
              strokeLinecap="round"
              pointerEvents="none"
            />
          )
        })}

        {/* L5e — corner apex markers (editing mode). Each marker is a numbered
             dot positioned at the centerline point indexed by `apex_idx`. The
             selected corner gets a larger, signal-coloured marker. */}
        {edit && edit.corners.map((c, idx) => {
          if (c.apex_idx == null) return null
          const p = geom.centerline[Math.max(0, Math.min(geom.centerline.length - 1, Math.round(c.apex_idx)))]
          if (!p) return null
          const isSelected = edit.selectedTurn === c.turn
          return (
            <g
              key={`apex-${idx}-${c.turn}`}
              onPointerDown={e => { e.stopPropagation(); edit.onSelectTurn(c.turn) }}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={p.x} cy={-p.y}
                r={isSelected ? 8 : 6}
                fill={isSelected ? '#ff5e3a' : '#ffd700'}
                stroke="#000"
                strokeWidth={0.8}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={p.x} y={-p.y + 2}
                textAnchor="middle"
                fontSize={isSelected ? 9 : 7}
                fontWeight={700}
                fill="#000"
                fontFamily="'JetBrains Mono', monospace"
                pointerEvents="none"
              >
                {c.turn.replace(/^T/, '')}
              </text>
            </g>
          )
        })}

        {/* L6 — chart-hover crosshair (external, from hovering the left-pane charts) */}
        {crosshair && (
          <g pointerEvents="none">
            <circle cx={crosshair.x} cy={-crosshair.y} r={9} fill="none" stroke="#ffffff"
              strokeOpacity={0.25} strokeWidth={4} vectorEffect="non-scaling-stroke" />
            <circle cx={crosshair.x} cy={-crosshair.y} r={5} fill="#ff5e3a" stroke="#ffffff"
              strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        )}

        {/* L7 — direct hover marker (mouse over the track map itself) */}
        {hoverIdx !== null && bestLap && (
          <g pointerEvents="none">
            <circle cx={bestLap.x[hoverIdx]} cy={-bestLap.y[hoverIdx]} r={9} fill="none"
              stroke="#ffffff" strokeOpacity={0.25} strokeWidth={4} vectorEffect="non-scaling-stroke" />
            <circle cx={bestLap.x[hoverIdx]} cy={-bestLap.y[hoverIdx]} r={5} fill="#ff5e3a"
              stroke="#ffffff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>

      <div className="track-map-legend">
        <div className="track-map-legend-bar">
          {SPEED_RAMP.map(([t, c]) => (
            <div key={t} style={{ background: c, flex: 1 }} />
          ))}
        </div>
        <div className="track-map-legend-labels">
          {(() => {
            const { unit, abs } = METRIC_META[metric]
            const fmt = (v: number) => metric === 'speed_mph' ? `${Math.round(v)} ${unit}` : `${v.toFixed(2)}${unit}`
            return <>
              <span>{fmt(vmin)}</span>
              <span>{fmt((vmin + vmax) / 2)}</span>
              <span>{fmt(vmax)}{abs ? ' abs' : ''}</span>
            </>
          })()}
        </div>
        {bestLap && (
          <div className="track-map-legend-best">
            ⭐ {bestLap.sgShort}… L{bestLap.lapIdx + 1}
            {' · '}{(bestLap.durationMs / 1000).toFixed(3)}s
          </div>
        )}
        {crosshair && hoverDistanceM != null && (
          <div className="track-map-legend-hover">
            {Math.round(hoverDistanceM)} m · {crosshair.speed.toFixed(1)} mph
          </div>
        )}
      </div>

      {/* Hover tooltip — shows all metrics for every enabled lap */}
      {hoverIdx !== null && tooltipPos && bestLap && (
        <div
          className="track-map-tooltip"
          style={{ left: tooltipPos.x + 14, top: tooltipPos.y - 10 }}
        >
          <div className="track-map-tooltip-dist">
            {Math.round(bestLap.dist[hoverIdx])} m
          </div>
          {racingLines
            .map((lap, i) => ({ lap, i }))
            .filter(({ i }) => selectedLapIdxs.has(i))
            .map(({ lap, i }) => {
              const distM = bestLap.dist[hoverIdx]
              const idx = i === 0 ? hoverIdx : nearestDistIdx(lap.dist, distM)
              const color = i === 0 ? '#ff5e3a' : LAP_PALETTE[(i - 1) % LAP_PALETTE.length]
              const label = `L${lap.lapIdx + 1}${i === 0 ? ' ★' : ''}`
              const { unit } = METRIC_META[metric]
              const raw = (lap[metric] as number[])[idx]
              const val = raw != null
                ? metric === 'speed_mph' ? `${raw.toFixed(1)} ${unit}` : `${raw.toFixed(2)} ${unit}`
                : '—'
              return (
                <div key={`${lap.sg}-${lap.lapIdx}`} className="track-map-tooltip-row">
                  <span className="track-map-tooltip-label" style={{ color }}>{label}</span>
                  <span>{val}</span>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}

function MetricDropdown({ metric, onChange }: { metric: TrackMetric; onChange: (m: TrackMetric) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="lap-picker" ref={ref}>
      <button
        className="layer-toggle on"
        type="button"
        onClick={() => setOpen(o => !o)}
      >
        <span className="dot" />
        <span>{METRIC_META[metric].label}</span>
        <span className="lap-picker-caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="lap-picker-menu">
          {(Object.keys(METRIC_META) as TrackMetric[]).map(m => (
            <button
              key={m}
              className={`lap-picker-item ${m === metric ? 'on' : ''}`}
              type="button"
              onClick={() => { onChange(m); setOpen(false) }}
            >
              <span className="lap-picker-swatch" style={{ background: '#ff5e3a', opacity: m === metric ? 1 : 0.25 }} />
              <span className="lap-picker-label">{METRIC_META[m].label}</span>
              <span className="lap-picker-check">{m === metric ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LayerToggle({
  on, onChange, children,
}: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      className={`layer-toggle ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
      type="button"
    >
      <span className="dot" />
      <span>{children}</span>
    </button>
  )
}

function msToLapTime(ms: number): string {
  const m = Math.floor(ms / 60000)
  const s = ((ms % 60000) / 1000).toFixed(3)
  return `${m}:${s.padStart(7, '0')}`
}

function LapPickerDropdown({ laps, selected, onChange }: {
  laps: RacingLineLap[]
  selected: Set<number>
  onChange: (s: Set<number>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggle = (i: number) => {
    const next = new Set(selected)
    next.has(i) ? next.delete(i) : next.add(i)
    onChange(next)
  }

  const anyOn = selected.size > 0

  return (
    <div className="lap-picker" ref={ref}>
      <button
        className={`layer-toggle ${anyOn ? 'on' : ''}`}
        type="button"
        onClick={() => setOpen(o => !o)}
      >
        <span className="dot" />
        <span>compare laps{anyOn ? ` (${selected.size})` : ''}</span>
        <span className="lap-picker-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="lap-picker-menu">
          {laps.map((lap, i) => {
            const on = selected.has(i)
            const color = LAP_PALETTE[i % LAP_PALETTE.length]
            return (
              <button
                key={`${lap.sg}-${lap.lapIdx}`}
                className={`lap-picker-item ${on ? 'on' : ''}`}
                type="button"
                onClick={() => toggle(i)}
              >
                <span className="lap-picker-swatch" style={{ background: color, opacity: on ? 1 : 0.3 }} />
                <span className="lap-picker-label">
                  L{lap.lapIdx + 1}
                  <span className="lap-picker-time">{msToLapTime(lap.durationMs)}</span>
                </span>
                <span className="lap-picker-check">{on ? '✓' : ''}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
