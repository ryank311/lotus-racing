/** Desktop-only adapters. The HTTP worker must never import Electron APIs. */
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { registerApiHandlers } from './ipc.js'
import type { DriverDirectory } from './driverDirectory.js'
import { DATA_DIR } from '../garmin/paths.js'
import { MAX_SAMPLE_POINTS, TerrainService } from '../garmin/terrain.js'
import { CarModelLibrary } from '../garmin/carModels.js'
import { TrackModelLibrary } from '../garmin/trackModels.js'

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
  registerReplayIpc()
}

// The 3D replay's terrain, car models and track models. On a server they are shared by
// every driver; the desktop workspace keeps its own in DATA_DIR.
function registerReplayIpc(): void {
  const terrain = new TerrainService(path.join(DATA_DIR, 'terrain'))
  const carModels = new CarModelLibrary(path.join(DATA_DIR, 'car-models'))
  const bytesOf = (value: unknown): Uint8Array => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new Error('Invalid terrain samples')
  }
  // The renderer polls this while a first build downloads from USGS.
  ipcMain.handle('terrain:get', (_e, area: unknown) => {
    const status = terrain.status(area)
    if (status.state === 'failed') throw new Error(`The terrain could not be downloaded from USGS: ${status.error}`)
    return status
  })
  ipcMain.handle('terrain:grid', async (_e, key: string) => {
    const grid = await terrain.grid(String(key))
    return grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength)
  })
  ipcMain.handle('terrain:image', async (_e, key: string) => {
    const file = terrain.imageFile(String(key))
    if (!file) throw new Error('This terrain has no aerial photo.')
    return fs.promises.readFile(file)
  })
  ipcMain.handle('terrain:sample', async (_e, key: string, latLon: unknown) => {
    const bytes = bytesOf(latLon)
    if (bytes.byteLength % 16 || bytes.byteLength > MAX_SAMPLE_POINTS * 16) throw new Error('Invalid terrain samples')
    const heights = await terrain.sample(String(key), new Float64Array(bytes.slice().buffer))
    return heights.buffer.slice(heights.byteOffset, heights.byteOffset + heights.byteLength)
  })
  void carModels.list().catch(error => console.error('[car models] could not read the library:', error))
  ipcMain.handle('carModels:list', () => carModels.list())
  ipcMain.handle('carModels:get', async (_e, id: string) => {
    const file = await carModels.file(id)
    if (!file) throw new Error('Car model not found')
    return fs.promises.readFile(file)
  })
  ipcMain.handle('carModels:importPath', async (_e, sourcePath: string, fileName: string, meta: unknown) => {
    const source = String(sourcePath ?? '')
    if (!source || !/\.glb$/i.test(String(fileName ?? source)) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error('Choose a .glb file.')
    }
    const m = (meta ?? {}) as { name?: unknown; attribution?: unknown; matches?: unknown }
    return carModels.importFile(source, String(fileName ?? path.basename(source)), {
      name: typeof m.name === 'string' ? m.name : '', attribution: typeof m.attribution === 'string' ? m.attribution : null,
      matches: Array.isArray(m.matches) ? m.matches : [],
    })
  })
  ipcMain.handle('carModels:update', (_e, id: string, patch: unknown) => carModels.update(id, patch))
  ipcMain.handle('carModels:assign', (_e, vehicleKey: unknown, modelId: unknown) => carModels.assign(vehicleKey, modelId ?? null))
  ipcMain.handle('carModels:delete', async (_e, id: string) => { await carModels.remove(id) })

  // Track models: folders copied into <data>/track-models by hand.
  const trackModels = new TrackModelLibrary(path.join(DATA_DIR, 'track-models'))
  try { fs.mkdirSync(trackModels.dir, { recursive: true }) } catch (error) { console.error('[track models] could not create the folder:', error) }
  void trackModels.list().catch(error => console.error('[track models] could not read the library:', error))
  ipcMain.handle('trackModels:list', () => trackModels.list())
  ipcMain.handle('trackModels:get', async (_e, id: string, name: string) => {
    const file = await trackModels.file(id, name)
    if (!file) throw new Error('Track model file not found')
    return fs.promises.readFile(file.path)
  })
}
