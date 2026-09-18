// Instrument-card wrapper. The header stays in document flow so wrapped
// labels and controls always reserve space above the chart.

import { ReactNode } from 'react'
import { ChartSurface, ChartExpandButton } from './ChartSurface'

export function ChartCard({
  channel, title, meta, children,
}: {
  channel: string
  title?: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <ChartSurface title={channel}>
    <div className="chart-card">
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header">
        <span className="channel-tag">
          {channel}
          {title && <span style={{ color: 'var(--text-dim)', letterSpacing: '0.12em', marginLeft: 10 }}>{title}</span>}
        </span>
        {meta && <div className="meta">{meta}</div>}
        <ChartExpandButton title={channel} />
      </div>
      <div className="chart-card-body">{children}</div>
    </div>
    </ChartSurface>
  )
}
