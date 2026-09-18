import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../navigation'

const SurfaceContext = createContext({ expanded: false, toggle: () => {}, toolsHost: null as HTMLDivElement | null, setToolsHost: (_node: HTMLDivElement | null) => {} })
export const useChartSurface = () => useContext(SurfaceContext)

// Move a stable portal host into the top-layer dialog, preserving chart state.
// A viewport dialog also works on phones that cannot fullscreen arbitrary elements.
export function ChartSurface({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const [expanded, setExpanded] = useOverlay(`chart:${title}`)
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null)
  const [host] = useState(() => document.createElement('div'))
  const slot = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    host.className = 'chart-surface-content'
    if (expanded) {
      previousFocus.current = host.querySelector<HTMLElement>('[data-chart-expand]') ?? document.activeElement as HTMLElement
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

  return <SurfaceContext.Provider value={{ expanded, toggle: () => setExpanded(v => !v), toolsHost, setToolsHost }}>
    <div className={`chart-surface-slot ${className}`} ref={slot} />
    <dialog ref={dialog} className="chart-fullscreen" aria-label={`${title} full screen`}
      onCancel={e => { e.preventDefault(); setExpanded(false) }} />
    {createPortal(children, host)}
  </SurfaceContext.Provider>
}

export function ChartActionSlot() {
  const { setToolsHost } = useChartSurface()
  return <div className="chart-action-slot" ref={setToolsHost} />
}

export function ChartActions({ children }: { children: ReactNode }) {
  const { toolsHost } = useChartSurface()
  return toolsHost ? createPortal(children, toolsHost) : null
}

export function ChartExpandButton({ title }: { title: string }) {
  const { expanded, toggle } = useChartSurface()
  return <button type="button" className="btn ghost chart-expand" data-chart-expand
    aria-label={expanded ? `Close ${title} full screen` : `Maximize ${title}`}
    title={expanded ? 'Close full screen' : 'Expand chart'}
    aria-expanded={expanded} onClick={toggle}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={expanded ? 'M6 6l12 12M18 6L6 18' : 'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6'} />
    </svg>
  </button>
}
