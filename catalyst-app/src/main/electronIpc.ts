/** Desktop-only adapters. The HTTP worker must never import Electron APIs. */
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { registerApiHandlers } from './ipc.js'
import type { DriverDirectory } from './driverDirectory.js'

// `drivers` is the local server's driver list, so the desktop workspace can
// compare against the server's drivers.
export function registerIpc(getMainWindow: () => BrowserWindow | null, drivers?: () => DriverDirectory | null): void {
  const backend = registerApiHandlers(
    (channel, handler) => ipcMain.handle(channel, handler),
    getMainWindow,
    filePath => shell.showItemInFolder(filePath),
    undefined,
    drivers,
  )
  void backend.startReviews().catch(error => console.error('[review startup]', error))
}
