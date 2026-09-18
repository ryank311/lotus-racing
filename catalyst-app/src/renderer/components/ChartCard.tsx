// Instrument-card wrapper. The header stays in document flow so wrapped
// labels and controls always reserve space above the chart.

import { ReactNode } from 'react'
import { ChartSurface, ChartExpandButton, ChartActionSlot } from './ChartSurface'

export function ChartCard({
  channel, title, meta, controls, children,
}: {
  channel: string
  title?: string
  meta?: ReactNode
  controls?: ReactNode
  children: ReactNode
}) {
  return (
    <ChartSurface title={channel}>
    <div className="chart-card chart-card-interactive">
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header">
        <div className="chart-card-heading">
        <span className="channel-tag">
          {channel}
          {title && <span style={{ color: 'var(--text-dim)', letterSpacing: '0.12em', marginLeft: 10 }}>{title}</span>}
        </span>
        {meta && <div className="meta">{meta}</div>}
        </div>
        <div className="chart-card-actions"><ChartActionSlot /><ChartExpandButton title={channel} /></div>
        {controls && <div className="chart-card-options">{controls}</div>}
      </div>
      <div className="chart-card-body">{children}</div>
    </div>
    </ChartSurface>
  )
}
