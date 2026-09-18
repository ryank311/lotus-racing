export interface TouchPoint { x: number; y: number }
export interface Pinch { center: TouchPoint; distance: number }

export function pinchBetween(a: TouchPoint, b: TouchPoint): Pinch {
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(12, Math.hypot(a.x - b.x, a.y - b.y)) }
}

export function clampRange(range: [number, number], extent: [number, number]): [number, number] {
  const total = extent[1] - extent[0]
  if (!(total > 0)) return extent
  const span = Math.max(total / 100, Math.min(total, range[1] - range[0]))
  const lo = Math.max(extent[0], Math.min(extent[1] - span, range[0]))
  return [lo, lo + span]
}

// Keep the data under the fingers anchored as their midpoint moves.
export function pinchRange(range: [number, number], extent: [number, number], before: Pinch, after: Pinch, left: number, width: number): [number, number] {
  const span = range[1] - range[0]
  const nextSpan = Math.max((extent[1] - extent[0]) / 100, Math.min(extent[1] - extent[0], span * before.distance / after.distance))
  const anchor = range[0] + (before.center.x - left) / width * span
  const lo = anchor - (after.center.x - left) / width * nextSpan
  return clampRange([lo, lo + nextSpan], extent)
}
