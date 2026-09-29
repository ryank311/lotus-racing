/** Desktop-only adapters. The HTTP worker must never import Electron APIs. */
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { registerApiHandlers } from './ipc.js'

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  const backend = registerApiHandlers(
    (channel, handler) => ipcMain.handle(channel, handler),
    getMainWindow,
    filePath => shell.showItemInFolder(filePath),
  )
  void backend.startReviews().catch(error => console.error('[review startup]', error))
}
