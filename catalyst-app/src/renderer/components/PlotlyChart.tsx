// Thin React wrapper around Plotly.js — owns a div ref + handles
// theme/resize/cleanup. All chart components in pages/Analysis.tsx render
// their own figures and pass them in via `data` and `layout`.

import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'

export interface PlotlyChartProps {
  data: Plotly.Data[]
  layout?: Partial<Plotly.Layout>
  height?: number
  config?: Partial<Plotly.Config>
  // Fires for charts whose x-axis is distance_m, so other panels (the track
  // map) can sync a crosshair to the hovered point. Callback receives the
  // hovered x value, or null when the pointer leaves the chart.
  onHoverDistance?: (distanceM: number | null) => void
}

export function PlotlyChart({ data, layout, height = 420, config, onHoverDistance }: PlotlyChartProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Keep the latest callback in a ref so we don't have to re-init Plotly when
  // the handler identity changes (which happens every parent render).
  const hoverCbRef = useRef(onHoverDistance)
  useEffect(() => { hoverCbRef.current = onHoverDistance }, [onHoverDistance])

  useEffect(() => {
    if (!ref.current) return
    const cfg: Partial<Plotly.Config> = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud', 'lasso2d', 'select2d', 'autoScale2d'],
      toImageButtonOptions: { format: 'png', scale: 2 },
      ...config,
    }
    const el = ref.current
    Plotly.newPlot(el, data, { ...themeLayout(), ...layout }, cfg).then(() => {
      // Plotly's typed events are loose — cast through unknown.
      ;(el as any).on('plotly_hover', (e: any) => {
        const cb = hoverCbRef.current
        if (!cb || !e?.points?.length) return
        const x = e.points[0].x
        if (typeof x === 'number') cb(x)
      })
      ;(el as any).on('plotly_unhover', () => {
        hoverCbRef.current?.(null)
      })
    })
    return () => {
      if (el) Plotly.purge(el)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout])

  return <div ref={ref} style={{ width: '100%', height }} />
}

// =============================================================================
// THEME — heavy Plotly override so charts feel native to the app aesthetic.
// =============================================================================

export const PALETTE = {
  bg:         '#16161a',
  bgPlot:     '#0f0f12',
  text:       '#e8e8ea',
  textDim:    '#a0a0a8',
  textMute:   '#5e5e68',
  border:     '#25252c',
  borderStrong: '#34343d',

  signal:     '#ff5e3a',
  cyan:       '#7dd3fc',
  amber:      '#f5a623',
  green:      '#5dd17f',
  red:        '#ff4757',
  purple:     '#d8b4fe',
  pink:       '#fda4af',
  teal:       '#5eead4',
}

// Non-best laps cycle through this curated palette. Best lap is signal-orange.
export const LAP_PALETTE = [
  PALETTE.cyan, PALETTE.teal, PALETTE.amber, PALETTE.green,
  PALETTE.purple, PALETTE.pink, '#94a3b8', '#fbbf24',
  '#a5b4fc', '#86efac', '#fde68a', '#fca5a5',
]

export function lapColor(i: number, isBest: boolean): string {
  return isBest ? PALETTE.signal : LAP_PALETTE[i % LAP_PALETTE.length]
}

export function themeLayout(): Partial<Plotly.Layout> {
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor: PALETTE.bgPlot,
    font: {
      family: '"Manrope", system-ui, sans-serif',
      size: 11,
      color: PALETTE.text,
    },
    margin: { l: 56, r: 16, t: 16, b: 44 },
    hovermode: 'x unified',
    hoverlabel: {
      bgcolor: PALETTE.bg,
      bordercolor: PALETTE.signal,
      font: {
        family: '"JetBrains Mono", monospace',
        size: 11,
        color: PALETTE.text,
      },
    },
    xaxis: {
      color: PALETTE.textDim,
      gridcolor: PALETTE.border,
      linecolor: PALETTE.borderStrong,
      zerolinecolor: PALETTE.borderStrong,
      tickfont: { family: '"JetBrains Mono", monospace', size: 10, color: PALETTE.textDim },
    } as any,
    yaxis: {
      color: PALETTE.textDim,
      gridcolor: PALETTE.border,
      linecolor: PALETTE.borderStrong,
      zerolinecolor: PALETTE.borderStrong,
      tickfont: { family: '"JetBrains Mono", monospace', size: 10, color: PALETTE.textDim },
    } as any,
    legend: {
      bgcolor: 'rgba(20,20,24,0.85)',
      bordercolor: PALETTE.border,
      borderwidth: 1,
      font: {
        family: '"JetBrains Mono", monospace',
        size: 10,
        color: PALETTE.text,
      },
      x: 1, xanchor: 'right',
      y: 1, yanchor: 'top',
    },
  }
}

// Corner-zone shaded rectangles for charts whose x-axis is distance.
export function cornerShapes(corners: Array<{ dist_idx_start?: number; dist_idx_end?: number }>): Plotly.Shape[] {
  return corners
    .filter(c => c.dist_idx_start != null && c.dist_idx_end != null)
    .map(c => ({
      type: 'rect',
      layer: 'below',
      x0: c.dist_idx_start as number,
      x1: c.dist_idx_end as number,
      y0: 0, y1: 1, yref: 'paper',
      fillcolor: 'rgba(125,211,252,0.06)',
      line: { width: 0 },
    })) as Plotly.Shape[]
}

export function cornerAnnotations(
  corners: Array<{ turn: string; dist_idx_start?: number; dist_idx_end?: number }>,
  y = 1.03,
): Partial<Plotly.Annotations>[] {
  return corners
    .filter(c => c.dist_idx_start != null && c.dist_idx_end != null)
    .map(c => ({
      x: ((c.dist_idx_start as number) + (c.dist_idx_end as number)) / 2,
      y, yref: 'paper',
      text: c.turn,
      showarrow: false,
      font: { size: 9, color: PALETTE.textMute, family: '"JetBrains Mono", monospace' },
      xanchor: 'center',
    }))
}

export function segmentLines(segments: Array<{ start_dist_m: number }>): Plotly.Shape[] {
  return segments.map(s => ({
    type: 'line',
    layer: 'above',
    x0: s.start_dist_m, x1: s.start_dist_m,
    y0: 0, y1: 1, yref: 'paper',
    line: { color: 'rgba(255,94,58,0.18)', width: 1, dash: 'dot' },
  })) as Plotly.Shape[]
}
