import { useEffect, useState, type ReactNode } from 'react'

export function Skeleton({ variant = 'text' }: { variant?: 'text' | 'value' | 'field' }) {
  return <span className={`loading-skeleton loading-skeleton-${variant}`} aria-hidden="true" />
}

export function InlineLoadStatus({ pending, error, hasData = false, label, onRetry }: {
  pending: boolean
  error?: string | null
  hasData?: boolean
  label: string
  onRetry?: () => void
}) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!pending) return
    const timer = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(timer)
  }, [pending])
  return <span className={`inline-load-status${error && !pending ? ' inline-load-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    {pending ? <><span className="inline-load-mark" aria-hidden="true" />{hasData ? 'Updating' : slow ? 'Still loading' : 'Loading'} {label}…</> : error ? <>
      <span>Couldn’t {hasData ? 'update' : 'load'} {label}.{hasData ? ' Showing saved values.' : ''}</span>
      {onRetry && <button className="btn ghost inline-load-retry" onClick={onRetry}>Retry</button>}
    </> : null}
  </span>
}

export function StatValue({ loading, children }: { loading: boolean; children: ReactNode }) {
  return <div className="stat-value loading-value-slot">{loading ? <><Skeleton variant="value" /><span className="loading-sr-only">Loading</span></> : children}</div>
}

export function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="loading-rows" aria-hidden="true">{Array.from({ length: count }, (_, i) => <div className="loading-row" key={i}><Skeleton /><Skeleton /></div>)}</div>
}

export function ChartPlaceholder({ title }: { title: string }) {
  return <section className="loading-chart" aria-busy="true" data-route-loading><h2>{title}</h2><div aria-hidden="true" className="loading-chart-frame" /></section>
}

export function PageLoading({ title = 'Page', error, onRetry }: { title?: string; error?: string | null; onRetry?: () => void }) {
  return <><header className="page-header"><h1 className="page-title">{title}</h1></header><div className="page-body" data-route-loading={!error || undefined}>
    <InlineLoadStatus label={title.toLowerCase()} pending={!error} error={error} onRetry={onRetry} />
  </div></>
}
