import { useEffect, useRef, type PointerEvent } from 'react'
import { useChartSurface } from './ChartSurface'
import { pinchBetween, type Pinch, type TouchPoint } from './chartGestures'

export function useChartTouch<T extends Element>({ inspect, clear, transform, pan, reset }: {
  inspect: (event: PointerEvent<T>) => void
  clear: () => void
  transform?: (before: Pinch, after: Pinch) => void
  pan?: (before: TouchPoint, after: TouchPoint) => void
  reset?: () => void
}) {
  const { expanded } = useChartSurface()
  const points = useRef(new Map<number, TouchPoint>())
  const start = useRef<TouchPoint | null>(null)
  const moved = useRef(false)
  const multi = useRef(false)
  const lastTap = useRef<{ point: TouchPoint; time: number } | null>(null)
  const pos = (e: PointerEvent<T>) => ({ x: e.clientX, y: e.clientY })
  const cancel = () => { points.current.clear(); start.current = null; multi.current = false; lastTap.current = null }
  useEffect(() => { cancel(); clear() }, [expanded])

  return {
    onPointerDown: (e: PointerEvent<T>) => {
      if (e.pointerType === 'mouse') return
      if (expanded) e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      points.current.set(e.pointerId, pos(e))
      if (points.current.size === 1) { start.current = pos(e); moved.current = false; multi.current = false }
      else { multi.current = true; lastTap.current = null; clear() }
    },
    onPointerMove: (e: PointerEvent<T>) => {
      if (e.pointerType === 'mouse') { inspect(e); return }
      const previous = points.current.get(e.pointerId)
      if (!previous) return
      const before = [...points.current.values()]
      points.current.set(e.pointerId, pos(e))
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) moved.current = true
      if (!expanded) return
      if (points.current.size === 2) {
        const after = [...points.current.values()]
        transform?.(pinchBetween(before[0], before[1]), pinchBetween(after[0], after[1]))
      } else if (points.current.size === 1 && !multi.current) {
        if (pan) { clear(); pan(previous, pos(e)) }
        else inspect(e)
      }
    },
    onPointerUp: (e: PointerEvent<T>) => {
      if (e.pointerType === 'mouse' || !points.current.has(e.pointerId)) return
      if (!multi.current && !moved.current) {
        const last = lastTap.current
        if (expanded && reset && last && Date.now() - last.time < 300 && Math.hypot(e.clientX - last.point.x, e.clientY - last.point.y) < 24) {
          reset(); clear(); lastTap.current = null
        } else { inspect(e); lastTap.current = { point: pos(e), time: Date.now() } }
      }
      points.current.delete(e.pointerId)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    },
    onPointerCancel: () => { cancel(); clear() },
    onLostPointerCapture: (e: PointerEvent<T>) => { if (points.current.has(e.pointerId)) { cancel(); clear() } },
    onPointerLeave: (e: PointerEvent<T>) => { if (e.pointerType === 'mouse') clear() },
  }
}

export function TouchHint({ spatial = false, zoom = false }: { spatial?: boolean; zoom?: boolean }) {
  const { expanded } = useChartSurface()
  return <div className="chart-touch-hint">{expanded
    ? `${spatial ? 'Drag to pan · Tap to inspect' : 'Tap or drag to inspect'}${zoom ? ' · Two fingers to pan / pinch to zoom · Double-tap to reset' : ''}`
    : 'Tap to inspect · Expand for touch controls'}</div>
}
