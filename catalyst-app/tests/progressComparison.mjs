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
  server = await createServer({ configFile: false, root: path.join(__dirname, 'fixtures'), plugins: [react()], server: { host: '127.0.0.1', port: 5189, fs: { allow: [root] } } })
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true })
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  const js = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  await cdp('Page.navigate', { url: `${server.resolvedUrls.local[0]}review.html?progress` })
  for (let i = 0; i < 100 && !(await js('!!document.querySelector(".progress-plot-legend button")')); i++) await delay(50)
  assert.equal(await js('document.querySelectorAll(".progress-plot-legend button").length'), 2)
  assert.match(await js('document.querySelector(".progress-count").textContent'), /5 sessions · 2 plots/)
  const click = async label => { await js(`document.querySelector('[aria-label="${label}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`); await delay(80) }
  const bounds = async selector => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  let r = await bounds('.progress-chart')
  assert.ok(r.width > 850 && r.height >= 390, JSON.stringify(r))
  await js('document.querySelector(".progress-choose").click()')
  await click('T1 · Illustrative corner · Entry speed')
  await click('T2 · Hairpin · Entry speed')
  assert.equal(await js('document.querySelectorAll(".progress-plot-legend button").length'), 4)
  assert.equal(await js('document.querySelector(".progress-controls .review-tabs button").disabled'), true)
  assert.match(await js('document.querySelector(".progress-scale-note").textContent'), /Mixed units/)
  await click('Inspect session 2, 2026-04-19 11:00:00')
  assert.match(await js('document.querySelectorAll(".progress-readout-values strong")[2].textContent'), /—/)
  assert.equal(await js('document.querySelector(".progress-readout a").getAttribute("href")'), '/review/fixture-3')
  await click('Hide T1 · Illustrative corner · Traversal time')
  await click('Hide T2 · Hairpin · Traversal time')
  assert.equal(await js('document.querySelector(".progress-controls .review-tabs button").disabled'), false)
  assert.match(await js('document.querySelector(".progress-scale-note").textContent'), /same units/)
  // Exercise the date input through React's native input event path.
  const setDate = async (label, value) => {
    await js(`(() => { const input = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await delay(80)
  }
  await js('document.querySelectorAll(".progress-controls > button")[1].click()')
  await setDate('Comparison from date', '2026-08-01')
  assert.match(await js('document.querySelector(".progress-count").textContent'), /3 sessions/)
  await click('Maximize Corner / segment progress')
  assert.equal(await js('document.querySelectorAll("dialog:modal").length'), 1)
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Close Corner / segment progress full screen')
  assert.equal(await js('document.querySelectorAll("dialog .progress-plot-legend button").length'), 4)
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(100)
  assert.equal(await js('document.querySelectorAll("dialog:modal").length'), 0)
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Maximize Corner / segment progress')
  await setDate('Comparison from date', '2027-01-01')
  assert.match(await js('document.querySelector(".progress-empty").textContent'), /No sessions/)
  await setDate('Comparison from date', '')
  await click('Show T1 · Illustrative corner · Traversal time')
  await click('Show T2 · Hairpin · Traversal time')
  await js('document.querySelector(".progress-choose").click()')
  await js('[...document.querySelectorAll("button")].find(b => b.textContent === "Done").click()')
  // Tablet screenshot and real touch inspection.
  await js('document.querySelector(".progress-comparison").scrollIntoView()')
  r = await bounds('.progress-inspect')
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + 12, y: r.y + 40, radiusX: 4, radiusY: 4 }] })
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await delay(100)
  assert.equal(await js('document.querySelector(".progress-readout select").value'), 'fixture-2')
  if (process.env.PROGRESS_SCREENSHOT) fs.writeFileSync(process.env.PROGRESS_SCREENSHOT, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  for (const [width, height] of [[768, 1024], [390, 844]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
    await delay(100)
    assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false, `no page overflow at ${width}`)
    assert.ok((await bounds('.progress-chart')).height >= 390)
    await click('Maximize Corner / segment progress')
    assert.equal(await js('document.querySelectorAll("dialog:modal").length'), 1)
    assert.equal(await js('document.querySelector("dialog .progress-comparison").scrollWidth > document.querySelector("dialog .progress-comparison").clientWidth'), false)
    await click('Close Corner / segment progress full screen')
  }
  // Plot choices survive a reload; zero baselines never draw invalid SVG data.
  await cdp('Page.reload')
  await delay(200)
  for (let i = 0; i < 100 && !(await js('!!document.querySelector(".progress-plot-legend button")')); i++) await delay(50)
  assert.equal(await js('document.querySelectorAll(".progress-plot-legend button").length'), 4)
  await js('document.querySelector(".progress-choose").click()')
  await js('[...document.querySelectorAll("button")].find(b => b.textContent === "Clear plots").click()')
  await delay(80)
  assert.match(await js('document.querySelector(".progress-empty").textContent'), /Choose plots/)
  await click('T2 · Hairpin · Consistency')
  await js('[...document.querySelectorAll("button")].find(b => b.textContent === "Change %").click()')
  await delay(80)
  assert.match(await js('document.querySelector(".progress-empty").textContent'), /No plottable measurements/)
  assert.match(await js('document.querySelector(".progress-readout").textContent'), /0.00 s/)
  assert.deepEqual(errors, [])
  console.log('PASS: multiple regions and metrics, mixed scales, geometry exclusion, gaps, date filtering, touch inspection, fullscreen/focus, tablet/mobile layout, persistence and zero baselines')
}
const timeout = setTimeout(() => { console.error('Progress browser checks timed out'); chrome?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
