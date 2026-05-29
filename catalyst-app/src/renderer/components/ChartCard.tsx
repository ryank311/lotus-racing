// Instrument-card wrapper for charts. Floating channel tag on top-left,
// meta on top-right, corner tick marks all four corners. Children render
// inside the body.

import { ReactNode } from 'react'

export function ChartCard({
  channel, title, meta, children,
}: {
  channel: string
  title?: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="chart-card">
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header">
        <span className="channel-tag">
          {channel}
          {title && <span style={{ color: 'var(--text-dim)', letterSpacing: '0.12em', marginLeft: 10 }}>{title}</span>}
        </span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      <div className="chart-card-body">{children}</div>
    </div>
  )
}
