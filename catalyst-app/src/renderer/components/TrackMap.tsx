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
// Pan = drag; zoom = wheel (anchored on the cursor); double-click = zoom in on cursor; Fit button = fit-to-track.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisData, RacingLineLap, TrackGeometryPayload, CoachLinePoint } from '../../garmin/analysisData'
import type { CoachAnnotation } from '../../shared/types'
import { useUnits } from '../units'
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
  hoverDistanceM?: number | null
  edit?: TrackMapEditState
  coachAnnotations?: CoachAnnotation[]
  focusCorner?: string      // turn ID to animate-zoom to (e.g. "T7", "S6")
  hoverRef?: string         // turn/segment ID being hovered in coach notes (shows zone, no zoom)
  focusAnnotation?: CoachAnnotation | null  // annotation to pin in HUD when tip is clicked
  coachLine?: CoachLinePoint[] | null      // computed optimal line from data
  aiCoachLine?: CoachLinePoint[] | null   // AI-recommended line (from coach JSON)
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
// Expand a ref that may be a range ("T7-T9") into individual refs ["T7","T8","T9"].
// Single refs ("T7", "S3") are returned as a one-element array.
function expandRef(ref: string): string[] {
  const range = ref.match(/^([TS])(\d+)[a-z]?-[TS]?(\d+)[a-z]?$/i)
  if (range) {
    const prefix = range[1].toUpperCase()
    const start = parseInt(range[2], 10)
    const end   = parseInt(range[3], 10)
    if (end > start && end - start < 20) {
      return Array.from({ length: end - start + 1 }, (_, i) => `${prefix}${start + i}`)
    }
  }
  return [ref]
}

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

export function TrackMap({ data, height = 560, hoverDistanceM = null, edit, coachAnnotations, focusCorner, hoverRef, focusAnnotation, coachLine, aiCoachLine }: Props) {
  const { trackGeometry: geom, racingLines } = data
  // Speed values in `data` are already in the active display unit; this labels them.
  const speedUnit = (data as AnalysisData).speedUnit ?? 'mph'
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
  const [showGMeter,      setShowGMeter]    = useState(true)
  const [showCoachLine,   setShowCoachLine] = useState(true)
  // Index 0 = best lap; indices 1+ = comparison laps. Best lap selected by default.
  const [selectedLapIdxs, setSelectedLapIdxs] = useState<Set<number>>(new Set([0]))
  const [metric,          setMetric]        = useState<TrackMetric>('speed_mph')

  // Hover state — index into bestLap arrays, plus container-relative position
  const [hoverIdx,    setHoverIdx]    = useState<number | null>(null)
  const [activeAnnotation, setActiveAnnotation] = useState<CoachAnnotation | null>(null)
  const [tooltipPos,  setTooltipPos]  = useState<{ x: number; y: number } | null>(null)
  const [zoneHover,   setZoneHover]   = useState<{ annotation: CoachAnnotation; x: number; y: number } | null>(null)

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
    const arr = bestLap.dist
    let lo = 0, hi = arr.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid] < hoverDistanceM) lo = mid + 1
      else hi = mid
    }
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
      lat_g: bestLap.lat_g[best],
      long_g: bestLap.long_g[best],
    }
  }, [hoverDistanceM, bestLap])

  // G-meter values — prefer direct map hover, fall back to chart crosshair
  const gMeterValues = useMemo(() => {
    if (hoverIdx !== null && bestLap)
      return { lat_g: bestLap.lat_g[hoverIdx], long_g: bestLap.long_g[hoverIdx] }
    if (crosshair)
      return { lat_g: crosshair.lat_g, long_g: crosshair.long_g }
    return null
  }, [hoverIdx, crosshair, bestLap])

  // G scale — round up to nearest 0.5g above max magnitude
  const gMax = useMemo(() => {
    if (!bestLap) return 2
    let max = 0
    for (let i = 0; i < bestLap.lat_g.length; i++) {
      const g = Math.hypot(bestLap.lat_g[i], bestLap.long_g[i])
      if (g > max) max = g
    }
    return Math.max(1.5, Math.ceil(max / 0.5) * 0.5)
  }, [bestLap])

  // Build SVG event handlers for a zone highlight path — sets/clears the hover tooltip.
  const zoneHandlers = (annotation: CoachAnnotation) => ({
    onMouseEnter: (e: React.MouseEvent<SVGPathElement>) => {
      const cRect = containerRef.current?.getBoundingClientRect()
      if (cRect) setZoneHover({ annotation, x: e.clientX - cRect.left, y: e.clientY - cRect.top })
    },
    onMouseMove: (e: React.MouseEvent<SVGPathElement>) => {
      const cRect = containerRef.current?.getBoundingClientRect()
      if (cRect) setZoneHover(prev => prev ? { ...prev, x: e.clientX - cRect.left, y: e.clientY - cRect.top } : prev)
    },
    onMouseLeave: () => setZoneHover(null),
  })

  // Fade turn labels when zoomed in — at 2x+ zoom they clutter the view.
  const labelOpacity = useMemo(() => {
    if (!fitBox || !vb) return 1
    const zoomFactor = fitBox.w / vb.w
    return Math.max(0, Math.min(1, (3 - zoomFactor) / 1.2))
  }, [fitBox, vb])

  // L8 — coach annotation markers: resolve corner and segment refs to centerline positions.
  const coachMarkers = useMemo(() => {
    if (!coachAnnotations?.length || !geom) return []
    const dataCorners: Array<{ turn: string; apex_idx: number; dist_idx_start?: number; dist_idx_end?: number }>
      = (data as AnalysisData).corners ?? []
    const dataSegments: Array<{ id: number; start_dist_m: number; end_dist_m: number }>
      = (data as AnalysisData).segments ?? []

    // Deduplicate by ref — the flat annotations array repeats refs across tips.
    // Keep the highest-severity entry per ref so the marker color is meaningful.
    const seen = new Map<string, typeof coachAnnotations[0]>()
    for (const a of coachAnnotations) {
      const existing = seen.get(a.ref)
      if (!existing || (a.severity ?? 0) > (existing.severity ?? 0)) seen.set(a.ref, a)
    }

    return [...seen.values()].flatMap(a => {
      if (a.type === 'segment_tip') {
        // Segment marker: zone highlight along the full segment, label at midpoint.
        const segId = parseInt(a.ref.replace(/^S/i, ''), 10)
        const seg = dataSegments.find(s => s.id === segId)
        if (!seg) return []
        const midDist = (seg.start_dist_m + seg.end_dist_m) / 2
        const midPt = geom.centerline[Math.max(0, Math.min(geom.centerline.length - 1, Math.round(midDist)))]
        if (!midPt) return []
        return [{ x: midPt.x, y: midPt.y, annotation: a, kind: 'segment' as const,
          distStart: seg.start_dist_m, distEnd: seg.end_dist_m }]
      }

      // Corner tip: apex marker + optional recommended apex.
      const corner = dataCorners.find(c => c.turn === a.ref)
      if (!corner || corner.apex_idx == null) return []
      const apexPt = geom.centerline[Math.max(0, Math.min(geom.centerline.length - 1, Math.round(corner.apex_idx)))]
      if (!apexPt) return []
      const items: Array<{ x: number; y: number; annotation: CoachAnnotation; kind: 'actual' | 'recommended' | 'segment'; distStart?: number; distEnd?: number }> = []
      items.push({ x: apexPt.x, y: apexPt.y, annotation: a, kind: 'actual',
        distStart: corner.dist_idx_start, distEnd: corner.dist_idx_end })
      if (a.recommended_apex_dist_m != null) {
        const recIdx = Math.max(0, Math.min(geom.centerline.length - 1, Math.round(a.recommended_apex_dist_m)))
        const recPt = geom.centerline[recIdx]
        if (recPt) items.push({ x: recPt.x, y: recPt.y, annotation: a, kind: 'recommended' })
      }
      return items
    })
  }, [coachAnnotations, geom, data])

  // Smooth zoom-to-corner-or-segment when focusCorner changes.
  const focusAnimRef = useRef<number>(0)
  useEffect(() => {
    if (!focusCorner || !geom) return

    let centerPt: { x: number; y: number } | null = null
    let ZOOM_R = Math.max(150, (geom.bbox.maxX - geom.bbox.minX) * 0.18)

    if (/^S\d+$/i.test(focusCorner)) {
      // Segment ref — zoom to the midpoint of the segment and fit its length.
      const dataSegments: Array<{ id: number; start_dist_m: number; end_dist_m: number }> =
        (data as AnalysisData).segments ?? []
      const segId = parseInt(focusCorner.slice(1), 10)
      const seg = dataSegments.find(s => s.id === segId)
      if (!seg) return
      const midDist = (seg.start_dist_m + seg.end_dist_m) / 2
      centerPt = geom.centerline[Math.max(0, Math.min(geom.centerline.length - 1, Math.round(midDist)))]
      // Pad the zoom radius to show the whole segment with a bit of margin.
      ZOOM_R = Math.max(150, (seg.end_dist_m - seg.start_dist_m) / 2 + 80)
    } else {
      // Corner ref — may be a range like "T7-T9"; zoom to fit all referenced apexes.
      const dataCorners: Array<{ turn: string; apex_idx: number }> = (data as AnalysisData).corners ?? []
      const refs = expandRef(focusCorner)
      const pts = refs.flatMap(r => {
        const c = dataCorners.find(dc => dc.turn === r)
        if (!c || c.apex_idx == null) return []
        const pt = geom.centerline[Math.max(0, Math.min(geom.centerline.length - 1, Math.round(c.apex_idx)))]
        return pt ? [pt] : []
      })
      if (!pts.length) return
      if (pts.length === 1) {
        centerPt = pts[0]
      } else {
        // Fit bounding box of all apexes with padding.
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
        const minX = Math.min(...xs), maxX = Math.max(...xs)
        const minY = Math.min(...ys), maxY = Math.max(...ys)
        centerPt = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
        ZOOM_R = Math.max(150, Math.max(maxX - minX, maxY - minY) / 2 + 80)
      }
    }

    if (!centerPt) return
    const target: ViewBox = {
      x: centerPt.x - ZOOM_R,
      y: -centerPt.y - ZOOM_R,
      w: ZOOM_R * 2,
      h: ZOOM_R * 2,
    }

    cancelAnimationFrame(focusAnimRef.current)
    const DURATION = 550
    const startTime = performance.now()

    setVb(prev => {
      const from = prev ?? target
      const step = (now: number) => {
        const raw = Math.min(1, (now - startTime) / DURATION)
        const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2
        setVb({
          x: from.x + (target.x - from.x) * t,
          y: from.y + (target.y - from.y) * t,
          w: from.w + (target.w - from.w) * t,
          h: from.h + (target.h - from.h) * t,
        })
        if (raw < 1) focusAnimRef.current = requestAnimationFrame(step)
      }
      focusAnimRef.current = requestAnimationFrame(step)
      return from
    })

  }, [focusCorner, geom])  // eslint-disable-line react-hooks/exhaustive-deps

  // Pin the tip's annotation in the HUD when a coach note is clicked.
  useEffect(() => {
    if (focusAnnotation !== undefined) setActiveAnnotation(focusAnnotation ?? null)
  }, [focusAnnotation])

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
        <LayerToggle on={showGMeter} onChange={setShowGMeter}>g-meter</LayerToggle>
        {(coachLine || aiCoachLine) && (
          <LayerToggle on={showCoachLine} onChange={setShowCoachLine}>coach line</LayerToggle>
        )}
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
        <button className="btn tiny ghost" title="Fit to track" onClick={fitToTrack}>Fit</button>
      </div>

      <svg
        ref={svgRef}
        viewBox={vb ? `${vb.x} ${vb.y} ${vb.w} ${vb.h}` : undefined}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={(e) => zoomAt(e.clientX, e.clientY, 0.45)}
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

        {/* L5c — coach's line (data-derived optimal from per-segment PBs) */}
        {showCoachLine && coachLine && coachLine.length > 1 && (
          <path
            d={pathFromPoints(coachLine.map(p => ({ x: p.x, y: p.y })))}
            fill="none"
            stroke="#7dd3fc"
            strokeOpacity={0.7}
            strokeWidth={1.8}
            strokeDasharray="6 3"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}

        {/* L5d — AI coach line (sparse waypoints interpolated) */}
        {showCoachLine && aiCoachLine && aiCoachLine.length > 1 && (
          <path
            d={pathFromPoints(aiCoachLine.map(p => ({ x: p.x, y: p.y })))}
            fill="none"
            stroke="#c4b5fd"
            strokeOpacity={0.8}
            strokeWidth={1.8}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
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

        {/* L7b — active-segment zone: full-segment highlight driven by the focused/
            active ref. Sourced from track segments directly so the whole segment
            lights up even when its coach callouts are corner-level and there's no
            per-segment marker. */}
        {(() => {
          const ref = activeAnnotation?.ref ?? hoverRef ?? focusCorner ?? null
          if (!ref || !/^S\d+$/i.test(ref)) return null
          const dataSegments: Array<{ id: number; start_dist_m: number; end_dist_m: number }> =
            (data as AnalysisData).segments ?? []
          const seg = dataSegments.find(s => s.id === parseInt(ref.slice(1), 10))
          if (!seg) return null
          // Skip if a per-segment marker already draws this zone (avoids doubling opacity).
          if (coachMarkers.some(m => m.kind === 'segment' && m.annotation.ref === ref)) return null
          const lo = Math.max(0, Math.round(seg.start_dist_m))
          const hi = Math.min(geom.centerline.length - 1, Math.round(seg.end_dist_m))
          const slice = geom.centerline.slice(lo, hi + 1)
          if (slice.length < 2) return null
          const d = slice.map((p, si) => `${si === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`).join(' ')
          return (
            <path d={d} fill="none" stroke="#22d3ee" strokeOpacity={0.22}
              strokeWidth={geom.widthM} strokeLinecap="round" pointerEvents="none" />
          )
        })()}

        {/* L8 — coach annotation markers */}
        {(() => {
          const activeRef = activeAnnotation?.ref ?? hoverRef ?? focusCorner ?? null
          const activeRefs = activeRef ? new Set(expandRef(activeRef)) : null
          const hasSelection = activeRefs !== null
          return coachMarkers.map((m, i) => {
            const a = m.annotation
            const color = a.severity === 3 ? '#ff5e3a' : a.severity === 2 ? '#f5a623' : '#7dd3fc'
            const isSelected = activeRefs ? activeRefs.has(a.ref) : false
            const markerOpacity = hasSelection ? (isSelected ? 1 : 0.25) : 1

            if (m.kind === 'recommended') {
              return (
                <g key={`rec-${i}`} pointerEvents="none" opacity={markerOpacity}>
                  <circle cx={m.x} cy={-m.y} r={10}
                    fill="none" stroke="#ffffff" strokeWidth={1.5} strokeDasharray="3 2"
                    strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
                </g>
              )
            }

            // Segment tip — zone highlight along the full segment + label at midpoint.
            if (m.kind === 'segment') {
              const zoneSlice = (() => {
                if (m.distStart == null || m.distEnd == null) return null
                const lo = Math.max(0, Math.round(m.distStart))
                const hi = Math.min(geom.centerline.length - 1, Math.round(m.distEnd))
                return geom.centerline.slice(lo, hi + 1)
              })()
              return (
                <g key={`seg-${i}`}
                  style={{ cursor: 'pointer' }}
                  opacity={markerOpacity}
                  onClick={(e) => { e.stopPropagation(); setActiveAnnotation(prev => prev?.ref === a.ref ? null : a) }}
                >
                  {isSelected && zoneSlice && zoneSlice.length >= 2 && (() => {
                    const zd = zoneSlice.map((p, si) => `${si === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`).join(' ')
                    return (
                      <path d={zd} fill="none" stroke="#22d3ee"
                        strokeOpacity={0.25} strokeWidth={geom.widthM} strokeLinecap="round"
                        style={{ cursor: 'default' }}
                        {...zoneHandlers(a)} />
                    )
                  })()}
                  <g opacity={labelOpacity} {...zoneHandlers(a)}>
                    <circle cx={m.x} cy={-m.y}
                      r={isSelected ? 13 : 11}
                      fill="#22d3ee" fillOpacity={isSelected ? 0.35 : 0.15}
                      stroke="#22d3ee" strokeWidth={isSelected ? 2 : 1.5}
                      vectorEffect="non-scaling-stroke" />
                    <text x={m.x} y={-m.y + 3} textAnchor="middle"
                      fontSize={isSelected ? 8 : 7} fontWeight={700}
                      fill={isSelected ? '#fff' : '#22d3ee'}
                      fontFamily="'JetBrains Mono', monospace" pointerEvents="none">
                      {a.ref}
                    </text>
                  </g>
                </g>
              )
            }

            // Corner tip marker.
            return (
              <g key={`ann-${i}`}
                style={{ cursor: 'pointer' }}
                opacity={markerOpacity}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveAnnotation(prev => prev?.ref === a.ref ? null : a)
                }}
              >
                {/* Corner zone highlight — only for active annotation, full track width */}
                {isSelected && m.distStart != null && m.distEnd != null && (() => {
                  const lo = Math.max(0, Math.round(m.distStart))
                  const hi = Math.min(geom.centerline.length - 1, Math.round(m.distEnd))
                  const slice = geom.centerline.slice(lo, hi + 1)
                  if (slice.length < 2) return null
                  const d = slice.map((p, si) => `${si === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`).join(' ')
                  return (
                    <path d={d} fill="none" stroke="#22d3ee"
                      strokeOpacity={0.25} strokeWidth={geom.widthM} strokeLinecap="round"
                      style={{ cursor: 'default' }}
                      {...zoneHandlers(a)} />
                  )
                })()}
                {/* Turn number indicator — fades when zoomed in; inherits zone hover so dot shows tooltip too */}
                <g opacity={labelOpacity} {...zoneHandlers(a)}>
                  {/* Severity ring (color = severity-coded) */}
                  <circle cx={m.x} cy={-m.y}
                    r={isSelected ? 15 : 13}
                    fill="none" stroke={color}
                    strokeOpacity={isSelected ? 0.8 : 0.5}
                    strokeWidth={isSelected ? 2 : 1.5}
                    vectorEffect="non-scaling-stroke" />
                  {/* Cyan badge */}
                  <circle cx={m.x} cy={-m.y}
                    r={isSelected ? 11 : 9}
                    fill="#22d3ee" fillOpacity={isSelected ? 0.35 : 0.15}
                    stroke="#22d3ee" strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke" />
                  {isSelected && (
                    <circle cx={m.x} cy={-m.y} r={19}
                      fill="none" stroke="#22d3ee" strokeWidth={1} strokeOpacity={0.3}
                      strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
                  )}
                  <text x={m.x} y={-m.y + 3} textAnchor="middle"
                    fontSize={isSelected ? 8 : 7} fontWeight={700}
                    fill={isSelected ? '#fff' : '#22d3ee'}
                    fontFamily="'JetBrains Mono', monospace" pointerEvents="none">
                    {a.ref}
                  </text>
                </g>
              </g>
            )
          })
        })()}
      </svg>

      <div className="track-map-legend">
        <div className="track-map-legend-bar">
          {SPEED_RAMP.map(([t, c]) => (
            <div key={t} style={{ background: c, flex: 1 }} />
          ))}
        </div>
        <div className="track-map-legend-labels">
          {(() => {
            const { unit: rawUnit, abs } = METRIC_META[metric]
            const unit = metric === 'speed_mph' ? speedUnit : rawUnit
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
            ⭐ L{bestLap.lapIdx + 1} · {msToLapTime(bestLap.durationMs)}
          </div>
        )}
        {crosshair && hoverDistanceM != null && (
          <div className="track-map-legend-hover">
            {Math.round(hoverDistanceM)} m · {crosshair.speed.toFixed(1)} {speedUnit}
          </div>
        )}
        {showCoachLine && coachLine && (
          <div className="track-map-legend-best" style={{ color: '#7dd3fc' }}>
            ── coach line (data)
          </div>
        )}
        {showCoachLine && aiCoachLine && (
          <div className="track-map-legend-best" style={{ color: '#c4b5fd' }}>
            ── coach line (AI)
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
              const unit = metric === 'speed_mph' ? speedUnit : METRIC_META[metric].unit
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

      {showGMeter && bestLap && (
        <GMeter latG={gMeterValues?.lat_g ?? null} longG={gMeterValues?.long_g ?? null} gMax={gMax} />
      )}

      {/* Coach Intel HUD — fixed bottom-left panel, replaces both floating tooltips */}
      {(activeAnnotation ?? zoneHover?.annotation) && (
        <CoachIntelPanel
          annotation={(activeAnnotation ?? zoneHover!.annotation)}
          pinned={!!activeAnnotation}
          onDismiss={() => setActiveAnnotation(null)}
        />
      )}
    </div>
  )
}

// ─── Coach Intel HUD panel ───────────────────────────────────────────────────

function CoachIntelPanel({
  annotation, pinned, onDismiss,
}: {
  annotation: CoachAnnotation
  pinned: boolean
  onDismiss: () => void
}) {
  const { speedFromMph, speedUnit } = useUnits()
  const color = annotation.severity === 3 ? 'var(--signal)' : annotation.severity === 2 ? '#f5a623' : 'var(--cyan)'
  // Coach speeds are stored in mph. Legacy sessions stored m/s in *_mps —
  // back-convert those, then convert mph → the active display unit.
  const actualMphVal = annotation.actual_apex_mph ?? (annotation.actual_apex_mps != null ? annotation.actual_apex_mps * 2.237 : undefined)
  const targetMphVal = annotation.target_apex_mph ?? (annotation.target_apex_mps != null ? annotation.target_apex_mps * 2.237 : undefined)
  const hasSpeed = actualMphVal != null && targetMphVal != null
  const actualDisp = hasSpeed ? speedFromMph(actualMphVal!) : null
  const targetDisp = hasSpeed ? speedFromMph(targetMphVal!) : null
  const actualMph = actualDisp != null ? actualDisp.toFixed(1) : null
  const targetMph = targetDisp != null ? targetDisp.toFixed(1) : null
  const deltaMph  = actualDisp != null && targetDisp != null ? (targetDisp - actualDisp) : null

  return (
    <div className="coach-intel-panel" style={{ '--intel-color': color } as React.CSSProperties}>
      <div className="coach-intel-ref">{annotation.ref}</div>
      <div className="coach-intel-divider" />
      <div className="coach-intel-body">{annotation.body}</div>

      {hasSpeed && (
        <div className="coach-intel-speeds">
          <div className="coach-intel-speed-block">
            <span className="coach-intel-speed-label">actual</span>
            <span className="coach-intel-speed-value">{actualMph}</span>
            <span className="coach-intel-speed-unit">{speedUnit}</span>
          </div>
          <div className="coach-intel-speed-arrow" style={{ color }}>
            {deltaMph! > 0 ? '▲' : '▼'}{Math.abs(deltaMph!).toFixed(1)}
          </div>
          <div className="coach-intel-speed-block">
            <span className="coach-intel-speed-label">target</span>
            <span className="coach-intel-speed-value" style={{ color }}>{targetMph}</span>
            <span className="coach-intel-speed-unit">{speedUnit}</span>
          </div>
        </div>
      )}

      <div className="coach-intel-actions">
        {!pinned
          ? <span className="coach-intel-hint">click to pin</span>
          : <button className="coach-intel-close" onClick={onDismiss}>×</button>
        }
      </div>
    </div>
  )
}

// ─── G-Meter overlay ─────────────────────────────────────────────────────────

function GMeter({ latG, longG, gMax }: { latG: number | null; longG: number | null; gMax: number }) {
  const SIZE = 100
  const R = 40
  const cx = SIZE / 2, cy = SIZE / 2
  const scale = R / gMax

  // dot position: negate lat so right-hand turns appear on the right (traction circle convention)
  // long: positive accel → bottom, negative brake → top (cy + longG * scale)
  const dotX = latG !== null ? cx - latG * scale : null
  const dotY = longG !== null ? cy + longG * scale : null

  return (
    <div className="track-map-gmeter">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ display: 'block' }}>
        {/* outer ring */}
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="#34343d" strokeWidth={1} />
        {/* inner ring at 50% */}
        <circle cx={cx} cy={cy} r={R * 0.5} fill="none" stroke="#25252c" strokeWidth={0.5} strokeDasharray="2 2" />
        {/* cross-hairs */}
        <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="#25252c" strokeWidth={0.5} />
        <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="#25252c" strokeWidth={0.5} />
        {/* scale labels */}
        <text x={cx + 2} y={cy - R * 0.5 + 4} fontSize="7" fill="#3a3a45" fontFamily='"JetBrains Mono",monospace' textAnchor="start">
          {(gMax * 0.5).toFixed(1)}
        </text>
        <text x={cx + 2} y={cy - R + 4} fontSize="7" fill="#3a3a45" fontFamily='"JetBrains Mono",monospace' textAnchor="start">
          {gMax.toFixed(1)}
        </text>
        {/* dot */}
        {dotX !== null && dotY !== null && (
          <g>
            <circle cx={dotX} cy={dotY} r={9} fill="#ff5e3a" fillOpacity={0.18} />
            <circle cx={dotX} cy={dotY} r={4.5} fill="#ff5e3a" />
            <circle cx={dotX} cy={dotY} r={4.5} fill="none" stroke="#fff" strokeWidth={1.2} strokeOpacity={0.8} />
          </g>
        )}
      </svg>
      <div className="track-map-gmeter-values">
        <span style={{ color: latG !== null ? 'var(--cyan)' : 'var(--text-mute)' }}>
          {latG !== null ? `${latG > 0 ? '+' : ''}${latG.toFixed(2)}` : '—'}
        </span>
        <span>lat</span>
        <span style={{ color: longG !== null ? 'var(--signal)' : 'var(--text-mute)' }}>
          {longG !== null ? `${longG > 0 ? '+' : ''}${longG.toFixed(2)}` : '—'}
        </span>
        <span>lng</span>
      </div>
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
