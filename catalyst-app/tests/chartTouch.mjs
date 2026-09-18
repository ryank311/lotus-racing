// Real browser touch input through CDP. Requires Chrome (or CHROME_BIN).
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
let server, chrome, socket, profile
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const root = path.resolve(__dirname, '..')
  server = await createServer({ configFile: false, root: path.join(__dirname, 'fixtures'), plugins: [react()], server: { host: '127.0.0.1', port: 5187, fs: { allow: [root] } } })
  await server.listen()
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-chart-test-'))
  const binary = process.env.CHROME_BIN ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
  chrome = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    chrome.on('error', reject)
    chrome.on('exit', code => reject(new Error(`Chrome exited (${code}): ${output}`)))
    chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]) })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  const errors = []
  socket.onmessage = event => {
    const response = JSON.parse(event.data)
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails.text)
    const request = pending.get(response.id)
    if (request) { pending.delete(response.id); response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => send(method, params, sessionId)
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  const js = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  await cdp('Page.navigate', { url: `${server.resolvedUrls.local[0]}charts.html` })
  for (let i = 0; i < 100 && !(await js('!!document.querySelector("canvas")')); i++) await delay(50)
  assert.equal(await js('document.querySelectorAll("canvas").length'), 6, errors.join('\n'))
  const click = async label => { await js(`document.querySelector('[aria-label="${label}"]').click()`); await delay(100) }
  const rect = async selector => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const touch = async (type, points = []) => { await cdp('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 4, radiusY: 4 })) }); await delay(35) }
  const tap = async (x, y) => { await touch('touchStart', [[1, x, y]]); await touch('touchEnd') }
  for (const title of ['SPEED', 'CUMULATIVE TIME Δ']) {
    const bounds = await js(`(() => {
      const card = document.querySelector('[aria-label="Maximize ${title}"]').closest('.chart-card');
      const header = card.querySelector('.chart-card-header').getBoundingClientRect();
      const options = card.querySelector('.chart-card-options').getBoundingClientRect();
      return { height: header.height, optionsWidth: options.width, headerWidth: header.width, overflow: document.documentElement.scrollWidth > innerWidth };
    })()`)
    assert.ok(bounds.height <= 112 && bounds.optionsWidth === bounds.headerWidth && !bounds.overflow, `${title} has a compact, aligned header: ${JSON.stringify(bounds)}`)
  }
  const header = await rect('.chart-card-header')
  const expand = await rect('[aria-label="Maximize SPEED"]')
  assert.ok(expand.y < header.y + 15 && expand.width <= 44, 'expand stays compact in the first header row')
  assert.equal(await js('getComputedStyle(document.querySelector(".chart-zoom-step")).display'), 'none', 'mobile uses pinch gestures instead of zoom buttons')
  let r = await rect('canvas')
  await tap(r.x + r.width / 2, r.y + 100)
  assert.match(await js('document.querySelector(".chart-tooltip").textContent'), /mph/)
  assert.equal(await js('getComputedStyle(document.querySelector("canvas")).touchAction'), 'pan-y pinch-zoom')
  await touch('touchStart', [[1, r.x + 150, r.y + 180]])
  await touch('touchMove', [[1, r.x + 150, r.y + 80]])
  await touch('touchEnd')
  assert.ok(await js('document.querySelector("main").scrollTop > 0'), 'embedded charts allow page scrolling')
  await click('Maximize SPEED')
  assert.equal(await js('document.querySelectorAll("dialog:modal").length'), 1)
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Close SPEED full screen')
  assert.equal(await js('getComputedStyle(document.querySelector("dialog canvas")).touchAction'), 'none')
  assert.equal(await js('getComputedStyle(document.querySelector("dialog[open] .chart-zoom-step")).display'), 'none')
  r = await rect('dialog[open] canvas')
  assert.ok(r.height > 480 && r.width <= 390, JSON.stringify(r))
  const canvas = 'document.querySelector("dialog[open] canvas")'
  const inspectAt = async fraction => { await delay(310); await tap(r.x + 50 + (r.width - 66) * fraction, r.y + r.height / 2); return js('window.hoverX') }
  const before = await inspectAt(0.25)
  const y = r.y + r.height / 2
  await touch('touchStart', [[1, r.x + 140, y], [2, r.x + 240, y]])
  await touch('touchMove', [[1, r.x + 90, y], [2, r.x + 290, y]])
  await touch('touchEnd')
  const after = await inspectAt(0.25)
  assert.ok(after > before + 70, `pinch zoom changed visible distance: ${before} → ${after}`)
  await touch('touchStart', [[1, r.x + 140, y], [2, r.x + 240, y]])
  await touch('touchMove', [[1, r.x + 170, y], [2, r.x + 270, y]])
  await touch('touchEnd')
  const panned = await inspectAt(0.25)
  assert.ok(panned < after - 20, 'two-finger pan moves the distance window')
  // A canceled pinch cannot leave inspection stuck in gesture mode.
  await touch('touchStart', [[1, r.x + 140, y], [2, r.x + 240, y]])
  await touch('touchCancel')
  assert.ok(Number.isFinite(await inspectAt(0.5)))
  const scrollBeforeClose = await js('document.querySelector("main").scrollTop')
  await click('Close SPEED full screen')
  assert.equal(await js('document.querySelector("main").scrollTop'), scrollBeforeClose, 'closing preserves page position')
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Maximize SPEED')
  await click('Maximize SPEED')
  r = await rect('dialog[open] canvas')
  assert.ok(Math.abs(await inspectAt(0.25) - panned) < 3, 'view survives close and reopen')
  await tap(r.x + 190, r.y + 120)
  await tap(r.x + 190, r.y + 120)
  assert.ok(Math.abs(await inspectAt(0.25) - before) < 3, 'double tap resets zoom')
  // Pointer handlers must retain desktop selection and panning.
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
  const mouse = async (type, x, y, down = false) => {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
    await delay(40)
  }
  await mouse('mouseMoved', r.x + 110, r.y + 180)
  await mouse('mousePressed', r.x + 110, r.y + 180, true)
  await mouse('mouseMoved', r.x + 250, r.y + 180, true)
  await mouse('mouseReleased', r.x + 250, r.y + 180)
  await mouse('mouseMoved', r.x + 50 + (r.width - 66) * 0.25, r.y + 180)
  assert.ok(Math.abs((await js('window.hoverX')) - before) > 30, 'mouse drag still selects a zoom range')
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true })
  await delay(100)
  r = await rect('dialog[open] canvas')
  assert.ok(r.width > 750 && r.height > 100 && r.y + r.height <= 390, JSON.stringify(r))
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(100)
  assert.equal(await js('document.querySelectorAll("dialog[open]").length'), 0)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await click('Maximize G-G')
  r = await rect('dialog[open] canvas')
  const imageBefore = await js(`${canvas}.toDataURL()`)
  await touch('touchStart', [[1, 140, 350], [2, 240, 350]])
  await touch('touchMove', [[1, 90, 350], [2, 290, 350]])
  await touch('touchEnd')
  assert.notEqual(await js(`${canvas}.toDataURL()`), imageBefore, 'G-G plot redraws after pinch')
  await click('Close G-G full screen')
  for (const title of ['CORNER STATS', 'BRAKING', 'CONSISTENCY']) {
    await click(`Maximize ${title}`)
    r = await rect('dialog[open] canvas')
    await tap(r.x + 180, r.y + (r.height + 12) / 2)
    assert.match(await js('document.querySelector("dialog[open] .chart-tooltip").textContent'), /T1/)
    await click(`Close ${title} full screen`)
  }
  await click('Maximize SEGMENT Δ')
  await js('document.querySelectorAll("dialog[open] .heatmap-cell")[1].click()')
  assert.match(await js('document.querySelector("dialog[open] .heatmap-readout").textContent'), /Lap 1 · S2: 26.2/)
  await click('Close SEGMENT Δ full screen')
  await click('Maximize Track map')
  const svg = 'document.querySelector("dialog[open] .track-map > svg")'
  const original = await js(`${svg}.getAttribute('viewBox')`)
  await touch('touchStart', [[1, 140, 350], [2, 240, 350]])
  await touch('touchMove', [[1, 90, 350], [2, 290, 350]])
  await touch('touchEnd')
  assert.ok(Number((await js(`${svg}.getAttribute('viewBox')`)).split(' ')[2]) < Number(original.split(' ')[2]), 'map pinches in world coordinates')
  await click('Close Track map full screen')
  await click('Maximize SPEED')
  r = await rect('dialog[open] canvas')
  await tap(r.x + 180, r.y + 180)
  await click('Clear readout')
  assert.equal(await js('document.querySelectorAll("dialog[open] .chart-tooltip").length'), 0)
  await click('Close SPEED full screen')
  assert.deepEqual(errors, [])
  if (process.env.CHART_SCREENSHOT) {
    await click('Maximize SPEED')
    r = await rect('dialog[open] canvas')
    await tap(r.x + 180, r.y + 180)
    fs.writeFileSync(process.env.CHART_SCREENSHOT, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await click('Close SPEED full screen')
    await click('Maximize CUMULATIVE TIME Δ')
    fs.writeFileSync(process.env.CHART_SCREENSHOT.replace('.png', '-delta.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  console.log('PASS: mobile scrolling, pinned readouts, fullscreen/focus, pinch, pan, cancellation, reset, state preservation, rotation, G-G, corner charts, heatmap and map')
}
const timeout = setTimeout(() => { console.error('Chart browser checks timed out'); chrome?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
