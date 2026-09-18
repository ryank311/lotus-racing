import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, browser, socket, profile
const timeout = setTimeout(() => { browser?.kill(); console.error('Navigation checks timed out'); process.exit(1) }, 90000)
try {
  server = await createServer({ configFile: false, root: path.join(root, 'tests/fixtures'), plugins: [react(), {
    name: 'navigation-fixture', configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.headers.accept?.includes('text/html')) req.url = '/navigation.html'
        next()
      })
    },
  }], server: { host: '127.0.0.1', port: 5193, fs: { allow: [root] } } })
  await server.listen()
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-navigation-'))
  browser = spawn(process.env.CHROME_BIN ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'), ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    browser.on('error', reject)
    browser.stderr.on('data', chunk => { const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]) })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map(), errors = []
  socket.onmessage = event => {
    const response = JSON.parse(event.data)
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails.exception?.description ?? response.params.exceptionDetails.text)
    const request = pending.get(response.id)
    if (request) { pending.delete(response.id); response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params, sessionId })) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => send(method, params, sessionId)
  await cdp('Runtime.enable'); await cdp('Page.enable')
  const js = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(50) } throw new Error(`Timed out: ${expression}\n${await js('document.body.innerText')}`) }
  const click = async selector => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(100) }
  const load = async route => { await cdp('Page.navigate', { url: server.resolvedUrls.local[0].replace(/\/$/, '') + route }); await wait('!!document.querySelector(".page-title")') }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await load('/sessions')
  await wait('document.querySelectorAll(".sessions-table tbody tr").length === 35')
  const initialHistory = await js('history.length')
  await click('.sessions-table tbody input')
  assert.match(await js('location.search'), /selected=/)
  assert.equal(await js('history.length'), initialHistory, 'selection replaces history')
  await js('document.querySelector(".page-body").scrollTop = 500')
  await delay(100)
  await click('.selection-bar .primary')
  await wait('location.pathname === "/analysis"')
  await js('history.back()')
  await wait('location.pathname === "/sessions" && !!document.querySelector(".selection-bar")')
  await wait('document.querySelector(".page-body").scrollTop >= 499')
  assert.ok(await js('!!document.querySelector(".sessions-table input:checked")'))
  await js('history.forward()'); await wait('location.pathname === "/analysis"')
  console.log('PASS Sessions selection, Analyze, Back/Forward, scroll restoration')
  await load('/coach/report-1')
  await wait('!!document.querySelector(".list-item.active")')
  assert.equal(await js('getComputedStyle(document.querySelector(".list-item")).display'), 'block')
  for (const selector of ['.nav-item', '.list-item', '.viewer-pane .btn.primary']) assert.equal(await js(`getComputedStyle(document.querySelector('${selector}')).textDecorationLine`), 'none', 'links retain original appearance')
  fs.writeFileSync('/tmp/catalyst-routing-coach.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await click('.viewer-pane .btn.primary')
  await wait('location.pathname === "/analysis"')
  assert.match(await js('location.search'), /laps=top3/)
  await load('/garage/v1/files/4361722e6d64')
  await wait('!!document.querySelector("textarea") && document.querySelector("textarea").value === "Original vehicle notes"')
  await js(`(() => { const el=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Edited notes'); el.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await click('.nav-item[href="/overview"]')
  await wait('!!document.querySelector("#unsaved-title")')
  assert.equal(await js('location.pathname'), '/garage/v1/files/4361722e6d64')
  await click('.modal-actions .btn.ghost')
  assert.equal(await js('document.querySelector("textarea").value'), 'Edited notes')
  await click('.nav-item[href="/overview"]')
  await click('.modal-actions .btn.primary')
  await wait('location.pathname === "/overview"')
  await js('history.back()')
  await wait('!!document.querySelector("textarea") && document.querySelector("textarea").value === "Edited notes"')
  console.log('PASS report deep links, link styles, editor Save/Cancel and Back')
  await load('/garage/missing'); await wait('document.body.innerText.includes("Vehicle unavailable")')
  await load('/tracks/missing'); await wait('document.body.innerText.includes("layout is unavailable")')
  await load('/coach/missing'); await wait('document.body.innerText.includes("report is unavailable")')
  await load('/unknown'); await wait('document.body.textContent.includes("Page not found")')
  await load('/overview'); await js('window.completeCoach()'); await delay(200)
  assert.equal(await js('location.pathname'), '/overview', 'background completion does not navigate')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await click('[aria-label="Open navigation"]')
  await wait('document.querySelector(".sidebar").classList.contains("is-open")')
  await js('history.back()')
  await wait('!document.querySelector(".sidebar").classList.contains("is-open")')
  assert.equal(await js('location.pathname'), '/overview')
  await click('[aria-label="Open navigation"]')
  await click('.nav-item[href="/tracks"]')
  await wait('location.pathname === "/tracks"')
  await js('history.back()'); await wait('location.pathname === "/overview"')
  assert.ok(await js('!document.querySelector(".sidebar").classList.contains("is-open")'), 'no dead overlay entry')
  // Trigger a real Vite hot update without editing the source file.
  const module = server.moduleGraph.getModuleById(path.join(root, 'src/renderer/navigation.tsx'))
  assert.ok(module)
  await server.reloadModule(module)
  await delay(1000)
  assert.ok(await js('!!document.querySelector(".page-title") && !document.body.innerText.includes("NavigationProvider required")'))
  assert.deepEqual(errors, [])
  console.log('PASS unavailable routes, background completion, mobile overlay history, hot reload')
} finally {
  clearTimeout(timeout); socket?.close()
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
