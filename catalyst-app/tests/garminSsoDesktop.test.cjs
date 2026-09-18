const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const windows = []
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.webContents = new EventEmitter()
    this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler }
    windows.push(this)
  }
  isDestroyed() { return !!this.destroyed }
  close() { this.destroyed = true; this.emit('closed') }
  focus() { this.focused = true }
  async loadURL(url) { this.url = url }
}
const load = Module._load
Module._load = function(name, ...args) {
  if (name === 'electron') return { BrowserWindow: FakeWindow }
  return load.call(this, name, ...args)
}
const { loginViaBrowser } = require('../dist-main/main/auth.js')
Module._load = load
const client = require('../dist-main/garmin/catalystClient.js')

test('desktop captures a frame redirect once and exchanges for the exact service URL', async () => {
  const calls = []
  client.exchangeTicketForToken = async (...args) => { calls.push(args); return { accessToken: 'fixture', expiresIn: 123 } }
  const pending = loginViaBrowser()
  const win = windows.at(-1)
  assert.equal(win.options.webPreferences.sandbox, true)
  assert.equal(win.options.webPreferences.nodeIntegration, false)
  assert.ok(!win.options.webPreferences.partition.startsWith('persist:'))
  const service = new URL(win.url).searchParams.get('service')
  let prevented = 0
  win.webContents.emit('will-frame-navigate', { url: service + '?ticket=ST-test', preventDefault() { prevented++ } })
  win.webContents.emit('will-redirect', { preventDefault() { prevented++ } }, service + '?ticket=ST-test')
  assert.deepEqual(await pending, { accessToken: 'fixture', expiresIn: 123 })
  assert.deepEqual(calls, [['ST-test', service]])
  assert.equal(prevented, 2)
  assert.equal(win.isDestroyed(), true)
})

test('desktop cancellation releases the window and allows retry; duplicate starts focus it', async () => {
  const pending = loginViaBrowser()
  const win = windows.at(-1)
  await assert.rejects(loginViaBrowser(), /already open/)
  assert.equal(win.focused, true)
  win.close()
  await assert.rejects(pending, /cancelled/)
  const retry = loginViaBrowser()
  windows.at(-1).webContents.emit('did-fail-load', {}, -105, 'failure', 'https://sso.garmin.com', true)
  await assert.rejects(retry, /could not load/)
  assert.equal(windows.at(-1).isDestroyed(), true)
})

test('desktop ignores unrelated tickets and surfaces a safe exchange error', async () => {
  client.exchangeTicketForToken = async () => { throw new Error('ST-secret access_token') }
  const pending = loginViaBrowser()
  const win = windows.at(-1)
  win.webContents.emit('will-frame-navigate', { url: 'https://evil.test/?ticket=ST-forged', preventDefault() { assert.fail('not a callback') } })
  assert.equal(win.isDestroyed(), false)
  const service = new URL(win.url).searchParams.get('service')
  win.webContents.emit('will-frame-navigate', { url: service + '?ticket=ST-real', preventDefault() {} })
  await assert.rejects(pending, error => /could not exchange/.test(error.message) && !/ST-secret|access_token/.test(error.message))
})
