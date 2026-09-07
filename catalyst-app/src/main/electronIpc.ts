/** Desktop-only adapters. The HTTP worker must never import Electron APIs. */
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { registerApiHandlers } from './ipc.js'
import { loginViaBrowser } from './auth.js'

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  registerApiHandlers(
    (channel, handler) => ipcMain.handle(channel, handler),
    getMainWindow,
    filePath => shell.showItemInFolder(filePath),
    () => loginViaBrowser(getMainWindow() ?? undefined),
  )
}
