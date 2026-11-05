// Shared canvas chart and track-map colors. Keep this module dependency-free.

export const PALETTE = {
  bg:         '#16161a',
  bgPlot:     '#0f0f12',
  text:       '#e8e8ea',
  textDim:    '#a0a0a8',
  textMute:   '#5e5e68',
  border:     '#25252c',
  borderStrong: '#34343d',

  signal:     '#ff5e3a',
  cyan:       '#7dd3fc',
  amber:      '#f5a623',
  green:      '#5dd17f',
  red:        '#ff4757',
  purple:     '#d8b4fe',
  pink:       '#fda4af',
  teal:       '#5eead4',
}

// Non-best laps cycle through this curated palette. Best lap is signal-orange.
export const LAP_PALETTE = [
  PALETTE.cyan, PALETTE.teal, PALETTE.amber, PALETTE.green,
  PALETTE.purple, PALETTE.pink, '#94a3b8', '#fbbf24',
  '#a5b4fc', '#86efac', '#fde68a', '#fca5a5',
]

// Compared drivers, in order (you stay signal-orange). Chosen to stay apart
// from each other and from orange on the dark plot background.
export const DRIVER_PALETTE = [PALETTE.cyan, PALETTE.purple, PALETTE.green, PALETTE.amber]

// 0 = you; 1+ = compared drivers in order.
export function driverColor(index: number): string {
  return index <= 0 ? PALETTE.signal : DRIVER_PALETTE[(index - 1) % DRIVER_PALETTE.length]
}

// Colour ramp: violet (slow) → cyan → green → yellow → red (fast)
export const SPEED_RAMP: Array<[number, string]> = [
  [0.0, '#6a1b9a'],
  [0.2, '#5d3fd3'],
  [0.4, '#4fc3f7'],
  [0.6, '#5dd17f'],
  [0.8, '#f5a623'],
  [1.0, '#ff5e3a'],
]

export function lerpColor(c1: string, c2: string, t: number): string {
  const a = c1.match(/[\da-f]{2}/gi)!.map(h => parseInt(h, 16))
  const b = c2.match(/[\da-f]{2}/gi)!.map(h => parseInt(h, 16))
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return `#${m.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// t: 0 = slowest, 1 = fastest.
export function speedColor(t: number): string {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < SPEED_RAMP.length; i++) {
    if (x <= SPEED_RAMP[i][0]) {
      const [t0, c0] = SPEED_RAMP[i - 1]
      const [t1, c1] = SPEED_RAMP[i]
      return lerpColor(c0, c1, (x - t0) / (t1 - t0))
    }
  }
  return SPEED_RAMP[SPEED_RAMP.length - 1][1]
}
