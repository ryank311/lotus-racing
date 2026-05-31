// Electron main entry — creates the window, registers IPC.

import { app, BrowserWindow } from 'electron'
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

app.whenReady().then(async () => {
  seedUserData()

  // Migrate the existing database schema on every startup.
  // All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this is
  // safe to run repeatedly — it's a no-op when the schema is current.
  if (fs.existsSync(DB_PATH)) {
    try {
      const { con } = await openDb(DB_PATH)
      await initSchema(con)
    } catch (e) {
      console.error('[startup] schema migration failed:', e)
    }
  }

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(iconPath) } catch {}
  }
  registerIpc(() => mainWindow)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit on window-close on every platform. Standard macOS convention keeps the
// process alive in the Dock for re-open-on-click; we override that — closing
// the X is the way you quit this app.
app.on('window-all-closed', () => app.quit())
