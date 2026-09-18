// Scrolling and background activity regression checks via WebDriver BiDi.
// Requires Firefox (or FIREFOX_BIN); actual Android toolbar behavior needs device QA.
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
let server, firefox, socket, profile
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const root = path.resolve(__dirname, '..')
  server = await createServer({ configFile: false, root: path.join(__dirname, 'fixtures'), plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } })
  await server.listen()
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-layout-test-'))
  const binary = process.env.FIREFOX_BIN ?? (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox')
  firefox = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    firefox.on('error', reject)
    firefox.on('exit', code => reject(new Error(`Firefox exited (${code}): ${output}`)))
    firefox.stderr.on('data', chunk => { output += chunk; const match = output.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1] + '/session') })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  socket.onmessage = event => {
    const response = JSON.parse(event.data)
    const request = pending.get(response.id)
    if (request) { pending.delete(response.id); response.type === 'error' ? request.reject(new Error(JSON.stringify(response))) : request.resolve(response.result) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  await send('session.new', { capabilities: {} })
  const { context } = await send('browsingContext.create', { type: 'tab' })
  const js = async expression => {
    const result = await send('script.evaluate', { expression: `JSON.stringify((${expression}) ?? null)`, target: { context }, awaitPromise: true })
    if (result.type === 'exception') throw new Error(JSON.stringify(result))
    return JSON.parse(result.result.value)
  }

  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return
      await delay(50)
    }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText'))
  }
  const open = async query => {
    await send('browsingContext.navigate', { context, url: `${server.resolvedUrls.local[0]}scroll-performance.html${query}`, wait: 'complete' })
    await waitFor('!!document.querySelector(".page-body") && !!window.router')
    await delay(350)
  }
  const scroll = async top => js(`(() => { const pane = document.querySelector('.page-body'); pane.scrollTop = ${top}; pane.dispatchEvent(new Event('scroll')); return pane.scrollTop })()`)
  await send('browsingContext.setViewport', { context, viewport: { width: 390, height: 450 } })
  await open('')
  await waitFor('!!document.querySelector(".home-settings-grid select")')

  const openMenu = async () => {
    await js('document.querySelector(".mobile-menu-button").click()')
    await waitFor('document.querySelector(".sidebar").classList.contains("is-open") && window.router.state.location.state?.overlay === "navigation"')
  }
  const closedMenu = async () => {
    await waitFor('!document.querySelector(".sidebar").classList.contains("is-open") && !window.router.state.location.state?.overlay')
    await delay(220)
    assert.equal(await js('getComputedStyle(document.querySelector(".sidebar")).visibility'), 'hidden')
    assert.equal(await js('document.querySelector(".main-pane").hasAttribute("inert")'), false)
  }
  await openMenu()
  assert.match(await js('getComputedStyle(document.querySelector(".sidebar")).transitionProperty'), /transform/)
  assert.match(await js('getComputedStyle(document.querySelector(".sidebar")).transitionDuration'), /0\.18s/)
  assert.equal(await js('getComputedStyle(document.querySelector(".mobile-nav-backdrop")).backdropFilter'), 'none')
  assert.equal(await js('document.querySelector(".main-pane").hasAttribute("inert")'), true)
  await delay(220)
  assert.equal(await js('Math.round(document.querySelector(".sidebar").getBoundingClientRect().x)'), 0)
  await js('window.router.navigate(-1)')
  await closedMenu()
  assert.equal(await js('document.activeElement.className'), 'mobile-menu-button')
  await openMenu()
  await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await closedMenu()
  await openMenu()
  await js('document.querySelector(".mobile-nav-backdrop").click()')
  await closedMenu()
  // A rapid second tap must not reopen the drawer when history catches up.
  await js('document.querySelector(".mobile-menu-button").click()')
  await waitFor('document.querySelector(".sidebar").classList.contains("is-open")')
  await js('document.querySelector(".mobile-nav-close").click()')
  await closedMenu()
  await openMenu()
  await js('document.querySelector(".sidebar-log-btn").click()')
  await waitFor('!!document.querySelector(".logs-list")')
  await closedMenu()
  assert.equal(await js('window.router.state.location.pathname'), '/logs')
  await js('window.router.navigate(-1)')
  await waitFor('!!document.querySelector(".home-settings-grid select")')
  await delay(300)
  console.log('PASS menu slide/fade, Back, Escape, backdrop, rapid close, and navigation')
  // Neither backend diagnostics nor worker log messages should re-render Overview.
  await js('window.commits = 0')
  await js(`(() => { for (let i = 0; i < 1000; i++) {
    window.emitLog({ level: 'info', message: 'background-' + i });
    window.emitWorker({ type: 'log', kind: 'sync', payload: 'worker-' + i });
  } return true })()`)
  await delay(150)
  assert.equal(await js('window.commits'), 0, 'background logs cause no React commits on idle Overview')
  console.log('PASS 2,000 background log messages cause zero Overview commits')
  await js('(() => { window.storageWrites = 0; window.paneScans = 0; return true })()')
  for (let i = 0; i < 15; i++) { await scroll(5 + i * 5); await delay(20) }
  assert.equal(await js('window.storageWrites'), 0, 'no storage writes during continuous scrolling')
  assert.equal(await js('window.paneScans'), 0, 'no pane scans during continuous scrolling')
  await delay(300)
  assert.equal(await js('window.storageWrites'), 1, 'persist once after scrolling settles')
  console.log('PASS Overview scrolling performs no storage writes or pane scans until settled')
  await js("window.router.navigate('/logs')")
  await waitFor('document.querySelectorAll(".log-row").length === 2000')
  await js("window.emitLog({ level: 'warn', message: 'visible-log-update' })")
  await waitFor('document.querySelector(".logs-list").textContent.includes("visible-log-update")')
  console.log('PASS Logs retains background history and updates while visible')
  await js("window.router.navigate('/overview')")
  await waitFor('!!document.querySelector(".home-settings-grid select")')
  await js("window.emitWorker({ type: 'progress', kind: 'sync', progress: { current: 1, total: 1000 } })")
  await waitFor('!!document.querySelector(".status-bar.busy")')
  await delay(150)
  await js('window.commits = 0')
  await js(`(() => { for (let i = 2; i <= 1000; i++) window.emitWorker({ type: 'progress', kind: 'sync', progress: { current: i, total: 1000 } }); return true })()`)
  await waitFor('document.querySelector(".sync-progress-counter")?.textContent === "1000/1000"')
  assert.ok(await js('window.commits <= 3'), 'progress burst is batched')
  await js("window.emitWorker({ type: 'done', kind: 'sync' })")
  await waitFor('!document.querySelector(".status-bar")')
  console.log('PASS progress bursts are batched and completed work removes the status bar')

  await open('?navigation=1')
  await js('document.querySelector("#focus-target").focus()')
  assert.equal(await scroll(800), 800)
  // Navigate before the debounce expires; Back must still restore the latest position.
  await js("window.router.navigate('/sessions')")
  await waitFor('document.querySelector(".page-body").scrollTop === 0')
  await scroll(400)
  await js('(() => { window.delayContent = true; window.router.navigate(-1); return true })()')
  await waitFor('!!document.querySelector("[data-route-loading]")')
  await js('window.releaseContent()')
  await waitFor('document.querySelector(".page-body").scrollTop === 800')
  assert.equal(await js('document.activeElement.id'), 'focus-target')
  await js('(() => { window.delayContent = false; window.router.navigate(1); return true })()')
  await waitFor('document.querySelector(".page-body").scrollTop === 400')
  console.log('PASS Back/Forward restores positions and focus, including delayed content')
  // A new route needs no ongoing whole-page observer after it becomes ready.
  await js("window.router.navigate('/garage')")
  await waitFor('document.querySelector(".page-body").scrollTop === 0')
  await js('(() => { window.paneScans = 0; document.querySelector(".page-body").append(document.createElement("span")); return true })()')
  await delay(80)
  assert.equal(await js('window.paneScans'), 0, 'completed restoration disconnects mutation observer')
  await scroll(600)
  await js("window.router.navigate('/sessions')")
  await js('(() => { window.delayContent = true; window.router.navigate(-1); return true })()')
  await waitFor('!!document.querySelector("[data-route-loading]")')
  await js('(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); window.releaseContent(); return true })()')
  await delay(100)
  assert.equal(await js('document.querySelector(".page-body").scrollTop'), 0, 'keyboard input cancels pending restoration')
  await scroll(250)
  await js('(() => { window.storageWrites = 0; window.dispatchEvent(new Event("pagehide")); return true })()')
  assert.equal(await js('window.storageWrites'), 1, 'pagehide flushes pending position')
  console.log('PASS restoration stops when ready or interrupted; pagehide saves pending position')
}
const timeout = setTimeout(() => { console.error('Scroll performance browser checks timed out'); firefox?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (firefox && firefox.exitCode === null) { firefox.kill(); await new Promise(resolve => firefox.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
