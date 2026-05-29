// Electron main entry — creates the window, registers IPC.

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc.js'
import { loadInitialBounds, trackWindowState } from './windowState.js'

const isDev = process.env.NODE_ENV === 'development'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const { bounds, maximized, fullScreen } = loadInitialBounds()
  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0a0b',
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

app.whenReady().then(() => {
  registerIpc(() => mainWindow)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
