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
import type { AnalysisData, RacingLineLap } from '../../garmin/analysisData'

interface Props {
  data: AnalysisData
  height?: number
  // When set, a white crosshair is drawn on the best-lap racing line at this
  // cumulative distance. Lets the parent sync mouse-hover from other charts
  // (which use distance_m on x) onto the spatial track view.
  hoverDistanceM?: number | null
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

// Best-lap "speed heatmap" — many short line segments, each coloured by the
// average speed at that segment. Using <polyline>s with per-segment colour
// is the simplest cross-browser way to fake a gradient stroke.
function SpeedHeatmapPath({ lap, smin, smax }: { lap: RacingLineLap; smin: number; smax: number }) {
  const segments = []
  const range = Math.max(1, smax - smin)
  for (let i = 1; i < lap.x.length; i++) {
    const t = ((lap.speed_mph[i] + lap.speed_mph[i - 1]) / 2 - smin) / range
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

export function TrackMap({ data, height = 560, hoverDistanceM = null }: Props) {
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

  // Layer toggles
  const [showRibbon,    setShowRibbon]    = useState(true)
  const [showCenter,    setShowCenter]    = useState(false)
  const [showSectors,   setShowSectors]   = useState(true)
  const [showRacing,    setShowRacing]    = useState(true)
  const [showCompare,   setShowCompare]   = useState(false)

  const bestLap = racingLines[0] ?? null
  const compareLaps = racingLines.slice(1)

  // Speed range — drives the heatmap colour scale.
  const [smin, smax] = useMemo(() => {
    if (!bestLap) return [0, 100]
    let mn = Infinity, mx = -Infinity
    for (const v of bestLap.speed_mph) {
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    return [mn, mx]
  }, [bestLap])

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
  function screenToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const svg = svgRef.current
    if (!svg || !vb) return null
    const rect = svg.getBoundingClientRect()
    const fx = (clientX - rect.left) / rect.width
    const fy = (clientY - rect.top) / rect.height
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
      const factor = Math.exp(e.deltaY * 0.0025)
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

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!vb) return
    svgRef.current?.setPointerCapture(e.pointerId)
    dragStateRef.current = { x: e.clientX, y: e.clientY, vb }
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragStateRef.current
    const svg = svgRef.current
    if (!d || !svg) return
    const rect = svg.getBoundingClientRect()
    const dx = ((e.clientX - d.x) / rect.width) * d.vb.w
    const dy = ((e.clientY - d.y) / rect.height) * d.vb.h
    setVb({ x: d.vb.x - dx, y: d.vb.y - dy, w: d.vb.w, h: d.vb.h })
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    svgRef.current?.releasePointerCapture(e.pointerId)
    dragStateRef.current = null
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
        <LayerToggle on={showRibbon}  onChange={setShowRibbon}>track</LayerToggle>
        <LayerToggle on={showCenter}  onChange={setShowCenter}>centerline</LayerToggle>
        <LayerToggle on={showSectors} onChange={setShowSectors}>sectors</LayerToggle>
        <LayerToggle on={showRacing}  onChange={setShowRacing}>racing line</LayerToggle>
        <LayerToggle on={showCompare} onChange={setShowCompare}>compare laps</LayerToggle>
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
        onDoubleClick={fitToTrack}
        style={{ width: '100%', height: 'calc(100% - 44px)', cursor: dragStateRef.current ? 'grabbing' : 'grab' }}
      >
        {/* L1 — track surface ribbon */}
        {showRibbon && (
          <path
            d={ribbonPath(geom.leftEdge, geom.rightEdge)}
            fill="#1a1a22"
            stroke="#34343d"
            strokeWidth={0.6}
            vectorEffect="non-scaling-stroke"
          />
        )}

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

        {/* L3 — sector ticks (small ⊥ marks at each sector start) */}
        {showSectors && geom.sectorMarks.map((m, i) => {
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

        {/* L4 — comparison laps (faint single colour, drawn below the best) */}
        {showCompare && compareLaps.map((lap, i) => (
          <path
            key={`cmp-${lap.sg}-${lap.lapIdx}`}
            d={pathFromPoints(lap.x.map((x, k) => ({ x, y: lap.y[k] })))}
            fill="none"
            stroke="#7dd3fc"
            strokeOpacity={Math.max(0.15, 0.45 - i * 0.04)}
            strokeWidth={1.0}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* L5 — best-lap racing line, speed-heatmap stroke */}
        {showRacing && bestLap && (
          <SpeedHeatmapPath lap={bestLap} smin={smin} smax={smax} />
        )}

        {/* L6 — chart-hover crosshair: white pulse on the racing line at the
             cumulative distance the user is hovering on the time-series charts. */}
        {crosshair && (
          <g pointerEvents="none">
            <circle
              cx={crosshair.x} cy={-crosshair.y}
              r={6}
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.35}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={crosshair.x} cy={-crosshair.y}
              r={3}
              fill="#ffffff"
              stroke="#000"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
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
          <span>{Math.round(smin)} mph</span>
          <span>{Math.round((smin + smax) / 2)} mph</span>
          <span>{Math.round(smax)} mph</span>
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
