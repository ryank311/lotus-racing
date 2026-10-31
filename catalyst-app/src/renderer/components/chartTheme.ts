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
