// Session picker interactions and responsive layout in Chrome (or CHROME_BIN).
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
  server = await createServer({ configFile: false, root: path.join(__dirname, 'fixtures'), plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } })
  await server.listen()
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-session-picker-'))
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
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(50) }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText'))
  }
  const open = async suffix => {
    await cdp('Page.navigate', { url: `${server.resolvedUrls.local[0]}session-picker.html${suffix}` })
    await waitFor('!!document.querySelector(".session-picker-trigger")')
  }
  const browse = async () => {
    await js('document.querySelector(".session-picker-trigger").click()')
    await waitFor('!!document.querySelector("dialog:modal")')
  }
  const click = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(60) }
  const search = async value => {
    await js(`(() => { const input = document.querySelector('[aria-label="Search sessions"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await delay(60)
  }
  const key = async key => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key }); await delay(60) }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false })
  await open(''); await browse()
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Search sessions')
  assert.equal(await js('document.querySelectorAll(".session-browser-group").length'), 2)
  await click('.session-browser-sort button:last-child')
  assert.equal(await js('document.querySelector(".session-browser-row").dataset.session'), 'full-vette')
  await js(`(() => { const s = document.querySelector('[aria-label="Filter by car"]'); s.value = 'lotus'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await waitFor('document.querySelector(".session-browser-row").dataset.session === "full-pb"')
  assert.equal(await js('document.querySelector(".session-browser-row").textContent.includes("Car PB")'), true)
  await search('Oct 31 14:30')
  assert.equal(await js('document.querySelectorAll(".session-browser-row").length'), 1)
  assert.equal(await js('document.querySelector(".session-browser-row").textContent.includes("+3.577 s to PB")'), true)
  assert.equal(await js('!!document.querySelector(".session-browser-row .session-browser-pb")'), false)
  await search('no-such-session')
  assert.equal(await js('document.querySelector(".session-browser-empty strong").textContent'), 'No matching sessions')
  await click('.session-browser-empty button')
  await waitFor('document.querySelectorAll(".session-browser-row").length === 7')
  await click('.session-browser-courses button:last-child')
  assert.equal(await js('document.querySelectorAll(".session-browser-group").length'), 1)
  assert.equal(await js('document.querySelector(".session-browser-group h3").textContent'), 'Grand West Course')
  await click('.session-browser-courses button:first-child')
  await js('document.querySelector(".session-browser-search input").focus()')
  await key('ArrowDown')
  assert.equal(await js('document.activeElement.dataset.session'), 'full-vette')
  await key('ArrowDown')
  assert.equal(await js('document.activeElement.dataset.session'), 'full-pb')
  await key('Escape')
  await waitFor('!document.querySelector("dialog:modal")')
  assert.equal(await js('document.activeElement.className'), 'session-picker-trigger')
  await browse(); await js('window.pickerRouter.navigate(-1)')
  await waitFor('!document.querySelector("dialog")')
  assert.equal(await js('window.pickerRouter.state.location.pathname'), '/review/latest')
  await browse(); await click('.session-browser-row[data-session="grand-pb"]')
  await waitFor('!document.querySelector("dialog") && window.pickerRouter.state.location.pathname === "/review/grand-pb"')
  assert.match(await js('document.querySelector(".session-picker-trigger").textContent'), /Grand West Course/)
  await open('?replay'); await browse(); await click('.session-browser-row[data-session="full-pb"]')
  await waitFor('!document.querySelector("dialog") && window.pickerRouter.state.location.pathname === "/replay/full-pb"')
  assert.equal(await js('window.pickerRouter.state.location.search'), '?view=driver')
  await browse()
  const desktop = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(os.tmpdir(), 'catalyst-session-picker-desktop.png'), Buffer.from(desktop.data, 'base64'))
  await key('Escape'); await waitFor('!document.querySelector("dialog")')
  for (const width of [390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
    await browse()
    assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Close session picker', 'mobile does not open the keyboard automatically')
    assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false, `no page overflow at ${width}`)
    assert.equal(await js('document.querySelector(".session-browser-shell").scrollWidth > document.querySelector(".session-browser-shell").clientWidth'), false, `no dialog overflow at ${width}`)
    assert.equal(await js('document.querySelector(".session-browser-row").getBoundingClientRect().height >= 44'), true)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(os.tmpdir(), `catalyst-session-picker-${width}.png`), Buffer.from(shot.data, 'base64'))
    await click('.session-browser-close'); await waitFor('!document.querySelector("dialog")')
  }
  // Exercise the real Review page as well as the focused picker fixture.
  await cdp('Page.navigate', { url: `${server.resolvedUrls.local[0]}review.html?app` })
  await waitFor('document.querySelector(".session-picker-trigger")?.dataset.session === "fixture-6"')
  await browse(); await click('.session-browser-row[data-session="fixture-5"]')
  await waitFor('!document.querySelector("dialog") && document.querySelector(".session-picker-trigger")?.dataset.session === "fixture-5" && !!document.querySelector(".review-stat-grid")')
  assert.equal(await js('window.router.state.location.pathname'), '/review/fixture-5')
  assert.deepEqual(errors, [])
  console.log('PASS: layout groups, fastest order, car/search filters, honest PBs, empty state, keyboard, focus return, Back, Review/Replay navigation and 320/390px layout')
}

const timeout = setTimeout(() => { console.error('Session picker browser checks timed out'); chrome?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
