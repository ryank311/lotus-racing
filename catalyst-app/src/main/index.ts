// Electron main entry — creates the window, registers IPC.

import { app, BrowserWindow, Menu } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc.js'
import { loadInitialBounds, trackWindowState } from './windowState.js'
import { seedUserData } from '../garmin/paths.js'
import { openDb, initSchema } from '../garmin/loadToDb.js'
import { DB_PATH } from '../garmin/paths.js'
import fs from 'node:fs'

const isDev = process.env.NODE_ENV === 'development'

const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'build', iconFile)
  : path.join(__dirname, '..', '..', 'build', iconFile)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const { bounds, maximized, fullScreen } = loadInitialBounds()
  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0a0b',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (maximized) mainWindow.maximize()
  if (fullScreen) mainWindow.setFullScreen(true)

  trackWindowState(mainWindow)

  // Right-click editing menu — Electron shows none by default, so inputs (e.g.
  // the API key field) had no Cut/Copy/Paste. Build one for editable targets
  // and for any selected text.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const { isEditable, editFlags, selectionText } = params
    if (!isEditable && !selectionText) return
    const template: Electron.MenuItemConstructorOptions[] = isEditable
      ? [
          { role: 'undo', enabled: editFlags.canUndo },
          { role: 'redo', enabled: editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste },
          { role: 'selectAll' },
        ]
      : [{ role: 'copy', enabled: editFlags.canCopy }, { role: 'selectAll' }]
    Menu.buildFromTemplate(template).popup({ window: mainWindow! })
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173/')
    if (process.env.CATALYST_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Forward main-process console output to the renderer log panel.
// Queues messages that arrive before the renderer is ready, then flushes them.
function hookConsoleToRenderer(getWin: () => BrowserWindow | null) {
  const origLog   = console.log.bind(console)
  const origWarn  = console.warn.bind(console)
  const origError = console.error.bind(console)

  let rendererReady = false
  const queue: Array<{ level: string; message: string; ts: number }> = []

  const flush = () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    for (const msg of queue) win.webContents.send('app:log', msg)
    queue.length = 0
  }

  const send = (level: string, args: unknown[]) => {
    const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    const entry = { level, message, ts: Date.now() }
    if (rendererReady) {
      const win = getWin()
      if (win && !win.isDestroyed()) win.webContents.send('app:log', entry)
    } else {
      queue.push(entry)
    }
  }

  // Mark ready and flush the queue once the renderer's DOM is loaded.
  const onReady = () => {
    rendererReady = true
    flush()
    // Brief startup breadcrumb so the log panel is never completely empty.
    send('info', [`[catalyst] main process ready · platform=${process.platform} · pid=${process.pid}`])
    send('info', [`[catalyst] DB_PATH=${DB_PATH}`])
    send('info', [`[catalyst] DB exists: ${fs.existsSync(DB_PATH)}`])
  }

  // Attach the did-finish-load listener whenever the window is (re)created.
  const watchWindow = () => {
    const win = getWin()
    if (!win) return
    win.webContents.once('did-finish-load', onReady)
  }
  // Poll briefly in case the window is created after this call.
  const t = setInterval(() => { if (getWin()) { watchWindow(); clearInterval(t) } }, 50)

  console.log   = (...a) => { origLog(...a);   send('log',   a) }
  console.warn  = (...a) => { origWarn(...a);  send('warn',  a) }
  console.error = (...a) => { origError(...a); send('error', a) }
}

app.whenReady().then(async () => {
  seedUserData()

  // Migrate the existing database schema on every startup.
  // All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this is
  // safe to run repeatedly — it's a no-op when the schema is current.
  if (fs.existsSync(DB_PATH)) {
    try {
      const db = await openDb(DB_PATH)
      await initSchema(db.con)
      await db.close()
    } catch (e) {
      console.error('[startup] schema migration failed:', e)
    }
  }

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(iconPath) } catch {}
  }
  registerIpc(() => mainWindow)
  createWindow()
  hookConsoleToRenderer(() => mainWindow)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit on window-close on every platform. Standard macOS convention keeps the
// process alive in the Dock for re-open-on-click; we override that — closing
// the X is the way you quit this app.
app.on('window-all-closed', () => app.quit())
