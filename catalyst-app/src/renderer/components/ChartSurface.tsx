import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const SurfaceContext = createContext({ expanded: false, toggle: () => {} })
export const useChartSurface = () => useContext(SurfaceContext)

// Move a stable portal host into the top-layer dialog, preserving chart state.
// A viewport dialog also works on phones that cannot fullscreen arbitrary elements.
export function ChartSurface({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [host] = useState(() => document.createElement('div'))
  const slot = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    host.className = 'chart-surface-content'
    if (expanded) {
      previousFocus.current = document.activeElement as HTMLElement
      slot.current!.style.height = `${slot.current!.getBoundingClientRect().height}px`
      dialog.current!.append(host)
      dialog.current!.showModal()
      host.querySelector<HTMLElement>('[data-chart-expand]')?.focus()
      const overflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = overflow }
    }
    dialog.current!.close()
    slot.current!.append(host)
    slot.current!.style.height = ''
    previousFocus.current?.focus({ preventScroll: true })
  }, [expanded, host])

  useLayoutEffect(() => () => { host.remove() }, [host])

  return <SurfaceContext.Provider value={{ expanded, toggle: () => setExpanded(v => !v) }}>
    <div className={`chart-surface-slot ${className}`} ref={slot} />
    <dialog ref={dialog} className="chart-fullscreen" aria-label={`${title} full screen`}
      onCancel={e => { e.preventDefault(); setExpanded(false) }} />
    {createPortal(children, host)}
  </SurfaceContext.Provider>
}

export function ChartExpandButton({ title }: { title: string }) {
  const { expanded, toggle } = useChartSurface()
  return <button type="button" className="btn ghost chart-expand" data-chart-expand
    aria-label={expanded ? `Close ${title} full screen` : `Maximize ${title}`}
    aria-expanded={expanded} onClick={toggle}>
    <span aria-hidden="true">{expanded ? '↙' : '⛶'}</span> {expanded ? 'Close' : 'Expand'}
  </button>
}
