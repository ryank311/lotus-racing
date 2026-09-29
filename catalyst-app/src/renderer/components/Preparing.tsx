// "Preparing" presentation for pages that crunch telemetry before they can
// show anything meaningful (Analysis, Session Review, Progress).
//
// Honest by design: a step is only marked done or active when the app knows
// it is; the bar is determinate only when real counts exist, otherwise it is
// a plain "working" sweep. No placeholder charts: the panel takes the place
// of the content that is coming, and real content never moves when it lands.

import { useEffect, useState, type ReactNode } from 'react'
import './preparing.css'

export type PreparingStepState = 'done' | 'active' | 'waiting' | 'todo'
export interface PreparingStep { label: string; detail?: string; state: PreparingStepState }

export function PreparingPanel({ eyebrow, title, detail, steps, progress, startedAt, stepsLabel, status = 'Working…', standalone = false, delayMs = 0 }: {
  eyebrow: string
  status?: string
  title: string
  detail?: ReactNode
  steps: PreparingStep[]
  // Real counts only; omit for an indeterminate bar.
  progress?: { done: number; total: number; label: string } | null
  startedAt?: number
  stepsLabel?: string
  // The page's only content while it loads (no results around it).
  standalone?: boolean
  // Quick loads finish before the panel appears instead of flashing it.
  delayMs?: number
}) {
  const elapsed = useElapsed(startedAt)
  const shown = useShownAfter(delayMs)
  const fraction = progress && progress.total > 0 ? Math.min(1, Math.max(0, progress.done / progress.total)) : null
  if (!shown) return <div className="preparing-hold" aria-busy="true" data-route-loading />
  return <section className={`preparing${standalone ? ' is-standalone' : ''}`} role="status" aria-live="polite" aria-busy="true" data-route-loading>
    <div className="preparing-head">
      <span className="preparing-eyebrow">// {eyebrow}</span>
      <h2 className="preparing-title">{title}</h2>
      {detail && <p className="preparing-detail">{detail}</p>}
    </div>
    <div className={`preparing-bar${fraction == null ? ' is-indeterminate' : ''}`} aria-hidden="true">
      <i style={fraction == null ? undefined : { width: `${Math.max(2, fraction * 100)}%` }} />
    </div>
    <div className="preparing-meta">
      <span>{progress ? progress.label : status}</span>
      {elapsed >= 3 && <span>{formatElapsed(elapsed)}</span>}
    </div>
    {steps.length > 0 && <>
      {stepsLabel && <div className="preparing-steps-label">{stepsLabel}</div>}
      <ol className="preparing-steps">
        {steps.map(step => <li key={step.label} className={`is-${step.state}`}>
          <span className="preparing-dot" aria-hidden="true">{step.state === 'done' ? '✓' : ''}</span>
          <span className="preparing-step-text">
            <strong>{step.label}<span className="loading-sr-only"> — {stepStateLabel(step.state)}</span></strong>
            {step.detail && <small>{step.detail}</small>}
          </span>
        </li>)}
      </ol>
    </>}
  </section>
}

function stepStateLabel(state: PreparingStepState): string {
  return state === 'done' ? 'done' : state === 'active' ? 'in progress' : state === 'waiting' ? 'waiting' : 'included'
}

function formatElapsed(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
}

function useElapsed(startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

function useShownAfter(delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (delayMs <= 0) return
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs])
  return delayMs <= 0 || elapsed
}
