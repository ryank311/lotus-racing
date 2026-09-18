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
  const frame = useRef<number | null>(null)
  const pinch = useRef<Pinch | null>(null)
  const transformRef = useRef(transform)
  transformRef.current = transform
  const pos = (e: PointerEvent<T>) => ({ x: e.clientX, y: e.clientY })
  const currentPinch = () => {
    const pair = [...points.current.values()]
    return pair.length === 2 ? pinchBetween(pair[0], pair[1]) : null
  }
  const flushTransform = () => {
    if (frame.current === null) return
    cancelAnimationFrame(frame.current)
    frame.current = null
    const before = pinch.current, after = currentPinch()
    pinch.current = after
    if (before && after) transformRef.current?.(before, after)
  }
  const cancel = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null; pinch.current = null
    points.current.clear(); start.current = null; multi.current = false; lastTap.current = null
  }
  useEffect(() => { cancel(); clear(); return cancel }, [expanded])

  return {
    onPointerDown: (e: PointerEvent<T>) => {
      if (e.pointerType === 'mouse') return
      if (expanded) e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      flushTransform()
      points.current.set(e.pointerId, pos(e))
      pinch.current = currentPinch()
      if (points.current.size === 1) { start.current = pos(e); moved.current = false; multi.current = false }
      else { multi.current = true; lastTap.current = null; clear() }
    },
    onPointerMove: (e: PointerEvent<T>) => {
      if (e.pointerType === 'mouse') { inspect(e); return }
      const previous = points.current.get(e.pointerId)
      if (!previous) return
      points.current.set(e.pointerId, pos(e))
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) moved.current = true
      if (!expanded) return
      if (points.current.size === 2) {
        // Pointer events arrive separately for each finger. Apply their latest
        // positions together so a pan doesn't become two clamped half-pinches.
        if (frame.current === null) frame.current = requestAnimationFrame(flushTransform)
      } else if (points.current.size === 1 && !multi.current) {
        if (pan) { clear(); pan(previous, pos(e)) }
        else inspect(e)
      }
    },
    onPointerUp: (e: PointerEvent<T>) => {
      if (e.pointerType === 'mouse' || !points.current.has(e.pointerId)) return
      // Commit the final movement before changing the active finger pair.
      flushTransform()
      if (!multi.current && !moved.current) {
        const last = lastTap.current
        if (expanded && reset && last && Date.now() - last.time < 300 && Math.hypot(e.clientX - last.point.x, e.clientY - last.point.y) < 24) {
          reset(); clear(); lastTap.current = null
        } else { inspect(e); lastTap.current = { point: pos(e), time: Date.now() } }
      }
      points.current.delete(e.pointerId)
      pinch.current = currentPinch()
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    },
    onPointerCancel: () => { cancel(); clear() },
    onLostPointerCapture: (e: PointerEvent<T>) => { if (points.current.has(e.pointerId)) { cancel(); clear() } },
    onPointerLeave: (e: PointerEvent<T>) => { if (e.pointerType === 'mouse') clear() },
  }
}

export function TouchHint({ spatial = false, zoom = false }: { spatial?: boolean; zoom?: boolean }) {
  const { expanded } = useChartSurface()
  if (!expanded) return null
  return <div className="chart-touch-hint">{spatial ? 'Drag to pan · Tap to inspect' : 'Drag to inspect'}{zoom ? ' · Two fingers to zoom & pan' : ''}</div>
}
