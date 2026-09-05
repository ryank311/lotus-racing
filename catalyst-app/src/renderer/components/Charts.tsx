// Custom canvas chart components — replaces Plotly for all Analysis charts.
// Canvas rendering is ~10× faster than Plotly's SVG for multi-lap line data.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PALETTE, LAP_PALETTE } from './PlotlyChart'
import type { AnalysisData, GGData, HeatmapData } from '../../garmin/analysisData'
import type { TrackCorner, TrackSegment } from '../../garmin/trackYaml'

// ─── shared helpers ──────────────────────────────────────────────────────────

function niceTicks(lo: number, hi: number, target = 5): number[] {
  const span = hi - lo
  if (span <= 0) return [lo]
  const raw = span / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag)
    .find(s => span / s <= target * 1.5) ?? mag * 10
  const ticks: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 0.001; v += step)
    ticks.push(Math.round(v / step) * step)
  return ticks
}

function fmtTick(v: number, step: number) {
  const dec = Math.max(0, -Math.floor(Math.log10(Math.abs(step) || 1)))
  return v.toFixed(dec)
}

function nearestIdx(xs: number[], target: number): number {
  if (!xs.length) return 0
  let lo = 0, hi = xs.length - 1
  while (lo < hi) { const m = (lo + hi) >>> 1; xs[m] < target ? lo = m + 1 : hi = m }
  if (lo > 0 && Math.abs(xs[lo - 1] - target) < Math.abs(xs[lo] - target)) return lo - 1
  return lo
}

// Same speed ramp as TrackMap
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [106, 27, 154]], [0.2, [93, 63, 211]], [0.4, [79, 195, 247]],
  [0.6, [93, 209, 127]], [0.8, [245, 166, 35]], [1.0, [255, 94, 58]],
]
function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i]
      const f = (x - t0) / (t1 - t0)
      return `rgb(${Math.round(c0[0]+(c1[0]-c0[0])*f)},${Math.round(c0[1]+(c1[1]-c0[1])*f)},${Math.round(c0[2]+(c1[2]-c0[2])*f)})`
    }
  }
  return `rgb(${RAMP[RAMP.length-1][1].join(',')})`
}

function setupCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (!w || !h) return null
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { w, h }
}

// ─── shared tooltip ──────────────────────────────────────────────────────────

interface Tip {
  px: number; py: number
  header?: string
  rows: Array<{ label: string; value: string; color: string }>
}

function ChartTooltip({ tip, cw }: { tip: Tip; cw: number }) {
  return (
    <div
      className="chart-tooltip"
      style={{
        position: 'absolute',
        top: Math.max(4, tip.py - 10),
        pointerEvents: 'none',
        zIndex: 20,
        ...(tip.px > cw * 0.55
          ? { right: cw - tip.px + 14 }
          : { left: tip.px + 14 }),
      }}
    >
      {tip.header && <div className="chart-tooltip-header">{tip.header}</div>}
      {tip.rows.map((r, i) => (
        <div key={i} className="chart-tooltip-row">
          <span style={{ color: r.color }}>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

// ─── LineChart ───────────────────────────────────────────────────────────────
// Supports click-drag to zoom a range, drag-to-pan when zoomed, reset button.

export interface LineSeries {
  id: string; label: string
  xs: number[]; ys: number[]
  color: string; width: number; opacity: number
}

interface LineChartProps {
  series: LineSeries[]
  height: number
  yUnit?: string
  yRange?: [number, number]
  corners?: TrackCorner[]
  segments?: TrackSegment[]
  zeroLine?: boolean
  onHoverX?: (x: number | null) => void
}

const LP = { l: 50, r: 16, t: 24, b: 36 } as const

export function LineChart({ series, height, yUnit = '', yRange, corners, segments, zeroLine, onHoverX }: LineChartProps) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const rafRef     = useRef(0)
  const hoverXRef  = useRef<number | null>(null)
  // live zoom/pan while dragging — avoids React re-renders during drag
  const liveZoomRef = useRef<[number, number] | null>(null)
  // committed zoom triggers a re-render + draw re-creation
  const [xZoom, setXZoom] = useState<[number, number] | null>(null)
  const [tooltip, setTooltip] = useState<Tip | null>(null)

  // drag state
  const dragRef = useRef<{
    mode: 'select' | 'pan'
    startPx: number
    // for pan: the zoom range at drag start
    panBase?: [number, number]
    // for select: pixel of the other end (updated on move)
    selEnd?: number
  } | null>(null)

  // bounds ref so event handlers get current transform without stale closures
  const boundsRef = useRef<{
    xMin: number; xMax: number; xSpan: number
    yMin: number; yMax: number
    plotW: number; plotH: number
    toX: (v: number) => number
    toY: (v: number) => number
    fromPx: (px: number) => number  // pixel x → data x
  } | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dims = setupCanvas(canvas, ctx)
    if (!dims) return
    const { w, h } = dims

    // Determine x range (live pan > committed zoom > data extent)
    let xMin = Infinity, xMax = -Infinity
    for (const s of series) for (const v of s.xs) { if (v < xMin) xMin = v; if (v > xMax) xMax = v }
    if (!isFinite(xMin)) return

    const zoom = liveZoomRef.current ?? xZoom
    if (zoom) { [xMin, xMax] = zoom }

    // y range — if zoomed, clamp to visible data
    let yMin = Infinity, yMax = -Infinity
    if (yRange) { yMin = yRange[0]; yMax = yRange[1] }
    else {
      for (const s of series)
        for (let i = 0; i < s.xs.length; i++) {
          if (s.xs[i] < xMin - 1 || s.xs[i] > xMax + 1) continue
          if (s.ys[i] < yMin) yMin = s.ys[i]; if (s.ys[i] > yMax) yMax = s.ys[i]
        }
      if (!isFinite(yMin)) { yMin = 0; yMax = 100 }
      const p = (yMax - yMin) * 0.06; yMin -= p; yMax += p
    }

    const plotW = w - LP.l - LP.r
    const plotH = h - LP.t - LP.b
    const xSpan = xMax - xMin || 1
    const ySpan = yMax - yMin || 1
    const toX = (v: number) => LP.l + (v - xMin) / xSpan * plotW
    const toY = (v: number) => LP.t + (1 - (v - yMin) / ySpan) * plotH
    const fromPx = (px: number) => xMin + (px - LP.l) / plotW * xSpan
    boundsRef.current = { xMin, xMax, xSpan, yMin, yMax, plotW, plotH, toX, toY, fromPx }

    ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, w, h)

    // Y grid + labels
    ctx.font = '10px "JetBrains Mono", monospace'
    const yTicks = niceTicks(yMin, yMax)
    const yStep = yTicks.length > 1 ? Math.abs(yTicks[1] - yTicks[0]) : 1
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (const t of yTicks) {
      const py = toY(t)
      if (py < LP.t - 1 || py > LP.t + plotH + 1) continue
      ctx.strokeStyle = PALETTE.border; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(LP.l, py); ctx.lineTo(LP.l + plotW, py); ctx.stroke()
      ctx.fillStyle = PALETTE.textMute; ctx.fillText(fmtTick(t, yStep), LP.l - 5, py)
    }

    // X labels
    const xTicks = niceTicks(xMin, xMax, Math.max(4, Math.floor(plotW / 90)))
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = PALETTE.textMute
    for (const t of xTicks) {
      const px = toX(t)
      if (px < LP.l || px > LP.l + plotW) continue
      ctx.fillText(String(Math.round(t)), px, LP.t + plotH + 5)
    }

    ctx.save()
    ctx.beginPath(); ctx.rect(LP.l, LP.t, plotW, plotH); ctx.clip()

    // Segments
    if (segments) {
      ctx.strokeStyle = '#222229'; ctx.lineWidth = 1
      for (const seg of segments) {
        const px = toX(seg.start_dist_m)
        ctx.beginPath(); ctx.moveTo(px, LP.t); ctx.lineTo(px, LP.t + plotH); ctx.stroke()
      }
    }

    // Corner zones
    if (corners) {
      ctx.fillStyle = 'rgba(125,211,252,0.04)'
      for (const c of corners) {
        if (c.dist_idx_start == null || c.dist_idx_end == null) continue
        const x0 = toX(c.dist_idx_start), x1 = toX(c.dist_idx_end)
        ctx.fillRect(x0, LP.t, x1 - x0, plotH)
      }
      ctx.strokeStyle = PALETTE.border; ctx.lineWidth = 1; ctx.setLineDash([3, 5])
      for (const c of corners) {
        if (c.dist_idx_start == null) continue
        const px = toX(c.dist_idx_start)
        ctx.beginPath(); ctx.moveTo(px, LP.t); ctx.lineTo(px, LP.t + plotH); ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Zero line
    if (zeroLine && yMin <= 0 && yMax >= 0) {
      ctx.strokeStyle = PALETTE.borderStrong; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(LP.l, toY(0)); ctx.lineTo(LP.l + plotW, toY(0)); ctx.stroke()
    }

    // Series
    for (const s of series) {
      if (!s.xs.length) continue
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width
      ctx.globalAlpha = s.opacity; ctx.lineJoin = 'round'
      ctx.beginPath()
      let first = true
      for (let i = 0; i < s.xs.length; i++) {
        if (s.xs[i] < xMin - xSpan * 0.01 || s.xs[i] > xMax + xSpan * 0.01) { first = true; continue }
        const px = toX(s.xs[i]), py = toY(s.ys[i])
        first ? (ctx.moveTo(px, py), first = false) : ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Hover crosshair + dots
    if (hoverXRef.current !== null) {
      const hpx = toX(hoverXRef.current)
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(hpx, LP.t); ctx.lineTo(hpx, LP.t + plotH); ctx.stroke()
      for (const s of series) {
        if (!s.xs.length) continue
        const idx = nearestIdx(s.xs, hoverXRef.current!)
        ctx.fillStyle = s.color; ctx.globalAlpha = Math.min(1, s.opacity + 0.3)
        ctx.beginPath(); ctx.arc(toX(s.xs[idx]), toY(s.ys[idx]), 3.5, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // Drag selection rectangle
    if (dragRef.current?.mode === 'select' && dragRef.current.selEnd != null) {
      const x0 = Math.min(dragRef.current.startPx, dragRef.current.selEnd)
      const x1 = Math.max(dragRef.current.startPx, dragRef.current.selEnd)
      ctx.fillStyle = 'rgba(125,211,252,0.07)'
      ctx.fillRect(x0, LP.t, x1 - x0, plotH)
      ctx.strokeStyle = PALETTE.cyan; ctx.lineWidth = 1; ctx.setLineDash([3, 4])
      ctx.strokeRect(x0, LP.t, x1 - x0, plotH)
      ctx.setLineDash([])
    }

    ctx.restore()

    // Corner labels above plot
    if (corners) {
      ctx.font = '9px "JetBrains Mono", monospace'; ctx.fillStyle = PALETTE.textMute
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      for (const c of corners) {
        if (c.dist_idx_start == null || c.dist_idx_end == null) continue
        const px = toX((c.dist_idx_start + c.dist_idx_end) / 2)
        if (px < LP.l || px > LP.l + plotW) continue
        ctx.fillText(c.turn, px, LP.t - 2)
      }
    }

    // Axes
    ctx.strokeStyle = PALETTE.borderStrong; ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(LP.l, LP.t); ctx.lineTo(LP.l, LP.t + plotH); ctx.lineTo(LP.l + plotW, LP.t + plotH)
    ctx.stroke()
  }, [series, yRange, corners, segments, zeroLine, xZoom])

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(() => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(draw) })
    const el = canvasRef.current; if (el) ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current) }
  }, [draw])

  const schedRedraw = () => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(draw) }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const b = boundsRef.current; if (!b) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    if (mx < LP.l || mx > LP.l + b.plotW) return
    e.preventDefault()
    const zoom = liveZoomRef.current ?? xZoom
    if (zoom) {
      dragRef.current = { mode: 'pan', startPx: mx, panBase: [...zoom] as [number, number] }
    } else {
      dragRef.current = { mode: 'select', startPx: mx, selEnd: mx }
    }
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const b = boundsRef.current; if (!b || !series.length) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top

    if (dragRef.current) {
      const d = dragRef.current
      if (d.mode === 'pan' && d.panBase) {
        const [z0, z1] = d.panBase
        const deltaPx = mx - d.startPx
        const deltaData = -deltaPx / b.plotW * (z1 - z0)
        liveZoomRef.current = [z0 + deltaData, z1 + deltaData]
        schedRedraw()
      } else if (d.mode === 'select') {
        const clamp = Math.max(LP.l, Math.min(LP.l + b.plotW, mx))
        d.selEnd = clamp
        schedRedraw()
      }
      return
    }

    if (mx < LP.l || mx > LP.l + b.plotW) {
      if (hoverXRef.current !== null) { hoverXRef.current = null; onHoverX?.(null); setTooltip(null); schedRedraw() }
      return
    }

    const dx = b.fromPx(mx)
    hoverXRef.current = dx; onHoverX?.(dx)

    const dec = yUnit === 'g' ? 2 : 1
    const rows = series.map(s => ({
      label: s.label,
      value: `${s.ys[nearestIdx(s.xs, dx)].toFixed(dec)}${yUnit ? ' ' + yUnit : ''}`,
      color: s.color,
    }))
    setTooltip({ px: mx, py: my, header: `${Math.round(dx)} m`, rows })
    schedRedraw()
  }

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dragRef.current; if (!d) return
    const b = boundsRef.current
    if (d.mode === 'pan' && liveZoomRef.current) {
      setXZoom(liveZoomRef.current)
      liveZoomRef.current = null
    } else if (d.mode === 'select' && d.selEnd != null && b) {
      const dist = Math.abs(d.selEnd - d.startPx)
      if (dist > 8) {
        const lo = Math.min(d.startPx, d.selEnd), hi = Math.max(d.startPx, d.selEnd)
        setXZoom([b.fromPx(lo), b.fromPx(hi)])
      }
    }
    dragRef.current = null
    schedRedraw()
  }

  const onMouseLeave = () => {
    dragRef.current = null; liveZoomRef.current = null
    if (hoverXRef.current !== null) { hoverXRef.current = null; onHoverX?.(null) }
    setTooltip(null); schedRedraw()
  }

  const resetZoom = () => { setXZoom(null); liveZoomRef.current = null; schedRedraw() }

  const cw = wrapRef.current?.clientWidth ?? 600

  return (
    <div ref={wrapRef} style={{ position: 'relative', userSelect: 'none' }}>
      {xZoom && (
        <button
          className="btn tiny ghost"
          onClick={resetZoom}
          style={{ position: 'absolute', top: 4, right: LP.r + 2, zIndex: 10, fontSize: 9, padding: '2px 7px' }}
        >
          Reset zoom
        </button>
      )}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: 'block', cursor: dragRef.current?.mode === 'pan' ? 'grabbing' : xZoom ? 'grab' : 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      />
      {tooltip && !dragRef.current && <ChartTooltip tip={tooltip} cw={cw} />}
    </div>
  )
}

// ─── GGChart ─────────────────────────────────────────────────────────────────

export function GGChart({ gg, height, onHoverDistance, speedUnit = 'mph' }: { gg: GGData; height: number; onHoverDistance?: (d: number | null) => void; speedUnit?: string }) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const rafRef      = useRef(0)
  const wrapRef     = useRef<HTMLDivElement>(null)
  const hoverIdxRef = useRef<number | null>(null)
  const [tooltip, setTooltip] = useState<Tip | null>(null)
  // When inverted = false (default): lat G negated (left = positive) to match
  // traction circle convention. Toggle to show raw sensor orientation.
  const [inverted, setInverted] = useState(false)

  const geoRef = useRef<{
    cx: number; cy: number; sc: number
    ox: number; oy: number; plotW: number; plotH: number
    sLat: number; sLong: number
    inner: number  // kept for legacy compat
  } | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dims = setupCanvas(canvas, ctx); if (!dims) return
    const { w, h } = dims

    ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, w, h)

    const gMax = gg.p95_g * 1.35
    // Asymmetric padding so the plot fills the full canvas.
    // Scale is determined by the tighter dimension; the wider dimension just
    // shows more of the axis range — the circle stays circular.
    const padL = 38, padR = 16, padT = 20, padB = 28
    const plotW = w - padL - padR, plotH = h - padT - padB
    const sc = Math.min(plotW / 2, plotH / 2) / gMax
    const cx = padL + plotW / 2, cy = padT + plotH / 2
    // Axis ranges differ per dimension so the plot fills available space
    const xRange = plotW / 2 / sc   // max G value shown on x
    const yRange = plotH / 2 / sc

    const sLat  = inverted ? 1 : -1
    const sLong = inverted ? -1 : 1
    const toX = (v: number) => cx + sLat  * v * sc
    const toY = (v: number) => cy + sLong * v * sc
    geoRef.current = { cx, cy, sc, ox: padL, oy: padT, plotW, plotH, inner: Math.min(plotW, plotH), sLat, sLong }

    // Grid — ticks across the full axis range (may differ x vs y)
    ctx.font = '9px "JetBrains Mono", monospace'
    const xTicks = niceTicks(-xRange, xRange, 6).filter(t => t !== 0)
    const yTicks = niceTicks(-yRange, yRange, 6).filter(t => t !== 0)
    const xStep = xTicks.length > 1 ? Math.abs(xTicks[1] - xTicks[0]) : 1
    const yStep = yTicks.length > 1 ? Math.abs(yTicks[1] - yTicks[0]) : 1

    ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip()

    for (const t of yTicks) {
      const py = toY(t)
      ctx.strokeStyle = PALETTE.border; ctx.lineWidth = 1; ctx.globalAlpha = 0.6
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke()
      ctx.globalAlpha = 1
    }
    for (const t of xTicks) {
      const px = toX(t)
      ctx.strokeStyle = PALETTE.border; ctx.lineWidth = 1; ctx.globalAlpha = 0.6
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Axes
    ctx.strokeStyle = PALETTE.borderStrong; ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padL, cy); ctx.lineTo(padL + plotW, cy)
    ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH)
    ctx.stroke()

    // p95 circle
    ctx.strokeStyle = PALETTE.signal; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.55
    ctx.beginPath(); ctx.arc(cx, cy, gg.p95_g * sc, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([]); ctx.globalAlpha = 1

    const smin = Math.min(...gg.speed_mph), smax = Math.max(...gg.speed_mph)
    const srng = smax - smin || 1
    const hi = hoverIdxRef.current

    // All points (dimmed when something is hovered)
    const basAlpha = hi !== null ? 0.18 : 0.35
    for (let i = 0; i < gg.lat_g.length; i += 3) {
      ctx.fillStyle = rampColor((gg.speed_mph[i] - smin) / srng)
      ctx.globalAlpha = basAlpha
      ctx.beginPath(); ctx.arc(toX(gg.lat_g[i]), toY(gg.long_g[i]), 1.5, 0, Math.PI * 2); ctx.fill()
    }

    // Highlighted point
    if (hi !== null) {
      const px = toX(gg.lat_g[hi]), py = toY(gg.long_g[hi])
      const color = rampColor((gg.speed_mph[hi] - smin) / srng)
      // Glow ring
      ctx.globalAlpha = 0.3
      ctx.fillStyle = color
      ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.fill()
      // Solid dot
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill()
      // White border
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke()
    }

    ctx.restore(); ctx.globalAlpha = 1

    // Axis tick labels (outside clip)
    ctx.font = '9px "JetBrains Mono", monospace'; ctx.fillStyle = PALETTE.textMute
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (const t of yTicks) {
      const py = toY(t)
      if (py < padT || py > padT + plotH) continue
      ctx.fillText(fmtTick(t, yStep), padL - 4, py)
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    for (const t of xTicks) {
      const px = toX(t)
      if (px < padL || px > padL + plotW) continue
      ctx.fillText(fmtTick(t, xStep), px, padT + plotH + 4)
    }

    // Labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText('← LATERAL G →', cx, padT + plotH + 18)
    ctx.textBaseline = 'bottom'
    ctx.fillText(`p95 ≈ ${gg.p95_g.toFixed(2)}g`, cx, padT - 2)
  }, [gg, inverted])

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(() => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(draw) })
    const el = canvasRef.current; if (el) ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current) }
  }, [draw])

  const schedRedraw = () => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(draw) }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const geo = geoRef.current; if (!geo) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const { cx, cy, sc, ox, oy, plotW, plotH, sLat, sLong } = geo
    if (mx < ox || mx > ox + plotW || my < oy || my > oy + plotH) {
      hoverIdxRef.current = null; setTooltip(null); schedRedraw(); return
    }
    // Convert cursor to data space (account for sign multipliers)
    const latG  = (mx - cx) / sc / sLat
    const longG = (my - cy) / sc / sLong
    let nearI = 0, nearD = Infinity
    for (let i = 0; i < gg.lat_g.length; i++) {
      const d = (gg.lat_g[i] - latG) ** 2 + (gg.long_g[i] - longG) ** 2
      if (d < nearD) { nearD = d; nearI = i }
    }
    hoverIdxRef.current = nearI
    onHoverDistance?.(gg.dist?.[nearI] ?? null)
    schedRedraw()
    setTooltip({
      px: mx, py: my,
      rows: [
        { label: 'Lat G',  value: `${gg.lat_g[nearI].toFixed(2)}g`,        color: PALETTE.cyan     },
        { label: 'Long G', value: `${gg.long_g[nearI].toFixed(2)}g`,       color: PALETTE.signal   },
        { label: 'Speed',  value: `${Math.round(gg.speed_mph[nearI])} ${speedUnit}`, color: PALETTE.textMute },
      ],
    })
  }

  const onMouseLeave = () => {
    hoverIdxRef.current = null; onHoverDistance?.(null); setTooltip(null); schedRedraw()
  }

  const cw = wrapRef.current?.clientWidth ?? 600

  return (
    <div ref={wrapRef} style={{ position: 'relative', userSelect: 'none' }}>
      <button
        className={`btn tiny ghost`}
        onClick={() => setInverted(v => !v)}
        style={{ position: 'absolute', top: 4, right: 4, zIndex: 10, fontSize: 9, padding: '2px 7px',
          color: inverted ? 'var(--signal)' : undefined,
          borderColor: inverted ? 'var(--signal)' : undefined,
        }}
      >
        {inverted ? 'inverted' : 'invert'}
      </button>
      <canvas ref={canvasRef}
        style={{ width: '100%', height, display: 'block', cursor: 'crosshair' }}
        onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} />
      {tooltip && <ChartTooltip tip={tooltip} cw={cw} />}
    </div>
  )
}

// ─── HeatmapGrid ─────────────────────────────────────────────────────────────

function cellColor(val: number | null, zmax: number): string {
  if (val === null) return 'transparent'
  if (val === 0) return 'rgba(93,209,127,0.2)'
  const t = Math.min(1, val / (zmax || 1))
  const r = Math.round(93 + (255 - 93) * t)
  const g = Math.round(209 + (94  - 209) * t)
  const b = Math.round(127 + (58  - 127) * t)
  return `rgba(${r},${g},${b},${0.12 + t * 0.32})`
}

export function HeatmapGrid({ hm }: { hm: HeatmapData }) {
  return (
    <div style={{ overflowX: 'auto', padding: '4px 0' }}>
      <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 10, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ minWidth: 120, textAlign: 'left', padding: '3px 8px', color: 'var(--text-mute)', fontWeight: 400, letterSpacing: '0.1em' }} />
            {hm.cols.map(c => (
              <th key={c} style={{ padding: '3px 4px', color: 'var(--text-mute)', fontWeight: 400, letterSpacing: '0.1em', minWidth: 54, textAlign: 'center' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hm.rows.map((row, ri) => (
            <tr key={row}>
              <td style={{ padding: '2px 8px', color: 'var(--text-dim)', fontSize: 9, letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                {row}
              </td>
              {hm.cols.map((col, ci) => {
                const val = hm.z[ri][ci]
                const rawText = hm.text[ri][ci]
                const isPb = ri === hm.z.length - 1
                const display = val == null || rawText === '—' ? ''
                  : isPb ? rawText.replace(' PB', '')
                  : val === 0 ? 'PB' : `+${val.toFixed(2)}`
                // Tooltip: show full text + column label
                const tipText = rawText && rawText !== '—' ? `${col}: ${rawText}` : undefined
                return (
                  <td key={ci} title={tipText} style={{
                    padding: '3px 4px',
                    background: cellColor(val, hm.zmax),
                    textAlign: 'center',
                    color: val === 0 ? 'var(--green)' : 'var(--text-dim)',
                    fontWeight: val === 0 ? 700 : 400,
                    letterSpacing: '0.04em',
                    border: '1px solid rgba(255,255,255,0.03)',
                    cursor: tipText ? 'default' : undefined,
                  }}>
                    {display}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── CornerChart ─────────────────────────────────────────────────────────────

const CP = { l: 92, r: 18, t: 42, b: 30 } as const

interface CornerHitInfo {
  py: number
  rowHeight: number
  turn: string
  name: string
  best: AnalysisData['cornerRows'][number]
  vminLow: number
  vminHigh: number
}

export function CornerChart({ data, height, speedUnit = 'mph' }: { data: AnalysisData; height: number; speedUnit?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const hitRowsRef = useRef<CornerHitInfo[]>([])
  const [tooltip, setTooltip] = useState<Tip | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dims = setupCanvas(canvas, ctx); if (!dims) return
    const { w, h } = dims

    ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, w, h)

    const { cornerRows, corners } = data
    const turnOrder = corners.map(c => c.turn).filter(t => cornerRows.some(r => r.turn === t))
    if (!turnOrder.length) return

    const plotW = w - CP.l - CP.r, plotH = h - CP.t - CP.b
    const n = turnOrder.length

    let yMin = Infinity, yMax = -Infinity
    for (const r of cornerRows)
      for (const v of [r.entry_mph, r.apex_mph, r.exit_mph]) { if (v < yMin) yMin = v; if (v > yMax) yMax = v }
    const yp = (yMax - yMin) * 0.08; yMin -= yp; yMax += yp
    const ySpan = yMax - yMin || 1

    const toX = (v: number) => CP.l + (v - yMin) / ySpan * plotW
    const rowHeight = plotH / n
    const rowY = (i: number) => CP.t + (i + 0.5) * rowHeight
    const SERIES = [
      { key: 'entry_mph' as const, color: PALETTE.cyan, label: 'Entry', dy: -4 },
      { key: 'apex_mph' as const, color: PALETTE.signal, label: 'V-min', dy: 0 },
      { key: 'exit_mph' as const, color: PALETTE.green, label: 'Exit', dy: 4 },
    ]

    // Vertical speed grid makes each corner a compact horizontal speed profile.
    ctx.font = '8px "JetBrains Mono", monospace'
    const speedTicks = niceTicks(yMin, yMax, 6)
    const tickStep = speedTicks.length > 1 ? Math.abs(speedTicks[1] - speedTicks[0]) : 1
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    for (const tick of speedTicks) {
      const px = toX(tick)
      if (px < CP.l || px > CP.l + plotW) continue
      ctx.strokeStyle = PALETTE.border; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(px, CP.t); ctx.lineTo(px, CP.t + plotH); ctx.stroke()
      ctx.fillStyle = PALETTE.textMute
      ctx.fillText(fmtTick(tick, tickStep), px, CP.t + plotH + 6)
    }

    const hits: CornerHitInfo[] = []
    for (let i = 0; i < turnOrder.length; i++) {
      const turn = turnOrder[i]
      const rows = cornerRows.filter(r => r.turn === turn)
      if (!rows.length) continue
      const best = rows.find(r => r.isBest) ?? rows[0]
      const py = rowY(i)

      // Alternating rows and a fixed corner label make the dense chart scannable.
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.018)'
        ctx.fillRect(0, py - rowHeight / 2, w, rowHeight)
      }
      ctx.fillStyle = PALETTE.textDim
      ctx.font = '8px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const cornerName = best.name ? ` ${best.name}` : ''
      ctx.fillText(`${turn}${cornerName}`.slice(0, 15), 8, py)

      // The muted whiskers show the full selected-lap range for each metric;
      // the saturated dots are the overall fastest lap's actual values.
      for (const series of SERIES) {
        const values = rows.map(r => r[series.key])
        const lo = Math.min(...values), hi = Math.max(...values)
        const sy = py + series.dy
        ctx.strokeStyle = series.color; ctx.globalAlpha = 0.25; ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(toX(lo), sy); ctx.lineTo(toX(hi), sy); ctx.stroke()
        ctx.globalAlpha = 1
        ctx.fillStyle = series.color
        ctx.beginPath(); ctx.arc(toX(best[series.key]), sy, series.key === 'apex_mph' ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill()
        if (series.key === 'apex_mph') {
          ctx.strokeStyle = '#fff'; ctx.globalAlpha = 0.65; ctx.lineWidth = 1
          ctx.beginPath(); ctx.arc(toX(best[series.key]), sy, 6.5, 0, Math.PI * 2); ctx.stroke()
          ctx.globalAlpha = 1
        }
      }

      const vmins = rows.map(r => r.apex_mph)
      hits.push({ py, rowHeight, turn, name: best.name, best, vminLow: Math.min(...vmins), vminHigh: Math.max(...vmins) })
    }
    hitRowsRef.current = hits

    // Legend and chart-reading cue.
    ctx.font = '9px "JetBrains Mono", monospace'; let lx = CP.l
    for (const { color, label } of SERIES) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx + 4, 14, 3.5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = PALETTE.textDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(label, lx + 12, 14); lx += 58
    }
    ctx.fillStyle = PALETTE.textMute; ctx.font = '8px "JetBrains Mono", monospace'
    ctx.fillText('DOT = FASTEST LAP  ·  LINE = ALL-LAP RANGE', CP.l, 29)
    ctx.textAlign = 'right'
    ctx.fillText(speedUnit.toUpperCase(), CP.l + plotW, 29)

    ctx.strokeStyle = PALETTE.borderStrong; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(CP.l, CP.t); ctx.lineTo(CP.l, CP.t + plotH); ctx.stroke()
  }, [data, speedUnit])

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(() => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(draw) })
    const el = canvasRef.current; if (el) ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current) }
  }, [draw])

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const nearRow = hitRowsRef.current.find(row => Math.abs(row.py - my) <= row.rowHeight / 2)
    if (!nearRow) { setTooltip(null); return }
    const best = nearRow.best
    const spread = nearRow.vminHigh - nearRow.vminLow
    setTooltip({
      px: mx, py: my,
      header: `${nearRow.turn}${nearRow.name ? ` · ${nearRow.name}` : ''}  ${best.lapLbl} ★`,
      rows: [
        { label: 'Entry', value: `${best.entry_mph.toFixed(1)} ${speedUnit}`, color: PALETTE.cyan },
        { label: 'V-min', value: `${best.apex_mph.toFixed(1)} ${speedUnit}`, color: PALETTE.signal },
        { label: 'Exit', value: `${best.exit_mph.toFixed(1)} ${speedUnit}`, color: PALETTE.green },
        { label: 'V-min range', value: `${nearRow.vminLow.toFixed(1)}–${nearRow.vminHigh.toFixed(1)} ${speedUnit} (Δ${spread.toFixed(1)})`, color: PALETTE.textMute },
      ],
    })
  }

  const cw = wrapRef.current?.clientWidth ?? 600

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block', cursor: 'crosshair' }}
        onMouseMove={onMouseMove} onMouseLeave={() => setTooltip(null)} />
      {tooltip && <ChartTooltip tip={tooltip} cw={cw} />}
    </div>
  )
}

// ─── CornerConsistencyChart ─────────────────────────────────────────────────

const CCP = { l: 100, r: 42, t: 34, b: 28 } as const

interface ConsistencyHit {
  py: number
  rowHeight: number
  turn: string
  name: string
  laps: number
  avg: number
  stdDev: number
  low: number
  high: number
  spreadPct: number
  locationLow: number
  locationHigh: number
}

function consistencyColor(t: number): string {
  if (t < 0.5) return `rgb(${Math.round(93 + 303 * t)},${Math.round(209 - 86 * t)},${Math.round(127 - 184 * t)})`
  const u = (t - 0.5) * 2
  return `rgb(${Math.round(245 + 10 * u)},${Math.round(166 - 72 * u)},${Math.round(35 + 23 * u)})`
}

export function CornerConsistencyChart({
  data, height, speedUnit = 'mph', onHoverCorner,
}: {
  data: AnalysisData
  height: number
  speedUnit?: string
  onHoverCorner?: (turn: string | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const hitsRef = useRef<ConsistencyHit[]>([])
  const hoveredTurnRef = useRef<string | null>(null)
  const [tooltip, setTooltip] = useState<Tip | null>(null)
  const [lapFilter, setLapFilter] = useState<'all' | 'top3' | 'top5'>('all')

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dims = setupCanvas(canvas, ctx); if (!dims) return
    const { w, h } = dims
    ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, w, h)

    const limit = lapFilter === 'top3' ? 3 : lapFilter === 'top5' ? 5 : null
    const includedLaps = limit == null ? null : new Set(
      [...data.laps]
        .filter(lap => lap.durationMs > 0)
        .sort((a, b) => a.durationMs - b.durationMs)
        .slice(0, limit)
        .map(lap => `${lap.sg}:${lap.lapIdx}`),
    )
    const stats = data.corners.flatMap(corner => {
      const rows = data.cornerRows.filter(r =>
        r.turn === corner.turn && (!includedLaps || includedLaps.has(`${r.sg}:${r.lapIdx}`)))
      if (!rows.length) return []
      const values = rows.map(r => r.apex_mph)
      const avg = values.reduce((sum, value) => sum + value, 0) / values.length
      const stdDev = Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length)
      const locations = rows.map(r => r.vmin_dist_m).filter(Number.isFinite)
      const spreadPct = avg > 0 ? (Math.max(...values) - Math.min(...values)) / avg * 100 : 0
      return [{
        turn: corner.turn,
        name: corner.name ?? '',
        laps: rows.length,
        avg,
        stdDev,
        low: Math.min(...values),
        high: Math.max(...values),
        spreadPct,
        locationLow: locations.length ? Math.min(...locations) : 0,
        locationHigh: locations.length ? Math.max(...locations) : 0,
      }]
    }).sort((a, b) => b.spreadPct - a.spreadPct)
    if (!stats.length) return

    const plotW = w - CCP.l - CCP.r
    const plotH = h - CCP.t - CCP.b
    const maxSpreadPct = Math.max(...stats.map(s => s.spreadPct), 0.1)
    const toX = (spreadPct: number) => CCP.l + spreadPct / maxSpreadPct * plotW
    const rowHeight = plotH / stats.length
    const hits: ConsistencyHit[] = []

    // Spread axis.
    const ticks = niceTicks(0, maxSpreadPct, 5)
    const tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : 1
    ctx.font = '8px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    for (const tick of ticks) {
      const px = toX(tick)
      ctx.strokeStyle = PALETTE.border; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(px, CCP.t); ctx.lineTo(px, CCP.t + plotH); ctx.stroke()
      ctx.fillStyle = PALETTE.textMute; ctx.fillText(fmtTick(tick, tickStep), px, CCP.t + plotH + 5)
    }
    ctx.fillStyle = PALETTE.textMute; ctx.textAlign = 'right'
    ctx.fillText(`V-MIN RANGE / AVG · % · ${limit ? `TOP ${limit}` : 'ALL LAPS'}`, CCP.l + plotW, 17)

    stats.forEach((stat, i) => {
      const py = CCP.t + (i + 0.5) * rowHeight
      const severity = stat.spreadPct / maxSpreadPct
      const color = consistencyColor(severity)
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.018)'
        ctx.fillRect(0, py - rowHeight / 2, w, rowHeight)
      }
      ctx.fillStyle = PALETTE.textDim; ctx.font = '8px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(`${stat.turn}${stat.name ? ` ${stat.name}` : ''}`.slice(0, 16), 8, py)

      ctx.fillStyle = color; ctx.globalAlpha = 0.78
      ctx.fillRect(CCP.l, py - Math.max(2, rowHeight * 0.22), Math.max(2, toX(stat.spreadPct) - CCP.l), Math.max(4, rowHeight * 0.44))
      ctx.globalAlpha = 1
      ctx.fillStyle = PALETTE.textDim; ctx.textAlign = 'left'
      ctx.fillText(`${stat.spreadPct.toFixed(1)}%`, Math.min(toX(stat.spreadPct) + 5, w - CCP.r + 8), py)
      hits.push({ py, rowHeight, ...stat })
    })
    hitsRef.current = hits

    ctx.strokeStyle = PALETTE.borderStrong; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(CCP.l, CCP.t); ctx.lineTo(CCP.l, CCP.t + plotH); ctx.lineTo(CCP.l + plotW, CCP.t + plotH); ctx.stroke()
  }, [data, speedUnit, lapFilter])

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(() => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(draw) })
    const el = canvasRef.current; if (el) ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current) }
  }, [draw])

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const hit = hitsRef.current.find(row => Math.abs(row.py - my) <= row.rowHeight / 2)
    const turn = hit?.turn ?? null
    if (turn !== hoveredTurnRef.current) {
      hoveredTurnRef.current = turn
      onHoverCorner?.(turn)
    }
    if (!hit) { setTooltip(null); return }
    const rawSpread = hit.high - hit.low
    const stdDevPct = hit.avg > 0 ? hit.stdDev / hit.avg * 100 : 0
    setTooltip({
      px: mx, py: my,
      header: `${hit.turn}${hit.name ? ` · ${hit.name}` : ''}  ${hit.laps} laps`,
      rows: [
        { label: 'Normalized spread', value: `${hit.spreadPct.toFixed(1)}%`, color: PALETTE.signal },
        { label: 'Avg V-min', value: `${hit.avg.toFixed(1)} ${speedUnit}`, color: PALETTE.signal },
        { label: 'Raw spread', value: `${rawSpread.toFixed(1)} ${speedUnit}`, color: PALETTE.cyan },
        { label: 'Std dev', value: `${hit.stdDev.toFixed(2)} ${speedUnit} (${stdDevPct.toFixed(1)}%)`, color: PALETTE.cyan },
        { label: 'V-min range', value: `${hit.low.toFixed(1)}–${hit.high.toFixed(1)} ${speedUnit}`, color: PALETTE.green },
        { label: 'Location range', value: `${Math.round(hit.locationLow)}–${Math.round(hit.locationHigh)} m`, color: PALETTE.textMute },
      ],
    })
  }

  const clearHover = () => {
    hoveredTurnRef.current = null
    onHoverCorner?.(null)
    setTooltip(null)
  }
  const cw = wrapRef.current?.clientWidth ?? 600
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div className="corner-consistency-filter" role="group" aria-label="Laps included in corner consistency">
        {([['all', 'All'], ['top3', 'Top 3'], ['top5', 'Top 5']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={lapFilter === value ? 'active' : ''}
            aria-pressed={lapFilter === value}
            onClick={() => setLapFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block', cursor: 'crosshair' }}
        onMouseMove={onMouseMove} onMouseLeave={clearHover} />
      {tooltip && <ChartTooltip tip={tooltip} cw={cw} />}
    </div>
  )
}

// Series builders moved to ./chartSeries.ts so Fast Refresh can hot-reload
// the components in this file without falling back to a full page reload.
