// Persist the main BrowserWindow's position/size/maximized state across
// launches. Saves to a JSON file in Electron's user-data dir so users get
// their preferred layout back on reopen.
//
// Why not localStorage? localStorage lives in the renderer; main owns the
// window and gets the native resize/move/maximize events directly without
// IPC. A flat JSON sidecar is simpler and avoids races with renderer load.

import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Rectangle, screen } from 'electron'

interface SavedState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
  fullScreen?: boolean
}

const DEFAULT_STATE: SavedState = { width: 1280, height: 820 }
// Debounce writes; resize/move fire ~60Hz while dragging.
const SAVE_DEBOUNCE_MS = 400

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readState(): SavedState {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SavedState>
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return DEFAULT_STATE
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return DEFAULT_STATE
  }
}

// A saved (x, y) may point at a monitor that's no longer connected — fall back
// to centred on the primary display so the window doesn't open offscreen.
function visibleBounds(s: SavedState): Rectangle {
  const w = Math.max(640, s.width)
  const h = Math.max(480, s.height)
  if (s.x == null || s.y == null) {
    const primary = screen.getPrimaryDisplay().workArea
    return {
      x: Math.round(primary.x + (primary.width - w) / 2),
      y: Math.round(primary.y + (primary.height - h) / 2),
      width: w, height: h,
    }
  }
  // Verify the saved rect overlaps any current display.
  const bounds = { x: s.x, y: s.y, width: w, height: h }
  const anyOverlap = screen.getAllDisplays().some(d => {
    const a = d.workArea
    return !(bounds.x + bounds.width  < a.x ||
             bounds.x > a.x + a.width ||
             bounds.y + bounds.height < a.y ||
             bounds.y > a.y + a.height)
  })
  if (anyOverlap) return bounds
  const primary = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(primary.x + (primary.width - w) / 2),
    y: Math.round(primary.y + (primary.height - h) / 2),
    width: w, height: h,
  }
}

export function loadInitialBounds(): {
  bounds: Rectangle
  maximized: boolean
  fullScreen: boolean
} {
  const s = readState()
  return {
    bounds: visibleBounds(s),
    maximized: !!s.maximized,
    fullScreen: !!s.fullScreen,
  }
}

export function trackWindowState(win: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | null = null

  const schedule = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS)
  }

  const persist = () => {
    saveTimer = null
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const fullScreen = win.isFullScreen()
    // Use the normal-state bounds when maximized/fullscreen so we restore to
    // a sane size if the user un-maximizes after launch.
    const b = (maximized || fullScreen) ? win.getNormalBounds() : win.getBounds()
    const state: SavedState = {
      x: b.x, y: b.y, width: b.width, height: b.height, maximized, fullScreen,
    }
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
      fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
    } catch {
      // best-effort — losing window state is not worth crashing for
    }
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('enter-full-screen', schedule)
  win.on('leave-full-screen', schedule)
  // Flush on close to capture the final state.
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    persist()
  })
}
