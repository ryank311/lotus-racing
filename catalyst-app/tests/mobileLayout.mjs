// Desktop Firefox viewport regression checks via WebDriver BiDi.
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
    const result = await send('script.evaluate', { expression: `JSON.stringify(${expression})`, target: { context }, awaitPromise: true })
    if (result.type === 'exception') throw new Error(JSON.stringify(result))
    return JSON.parse(result.result.value)
  }
  for (const route of ['', '?sessions', '?sessions&busy']) {
    await send('browsingContext.navigate', {context, url: `${server.resolvedUrls.local[0]}mobile-layout.html${route}`, wait: 'complete'})
    const ready = route ? '.session-card input' : '#ai-api-key'
    for (let i = 0; i < 100 && !(await js(`!!document.querySelector('${ready}')`)); i++) await delay(50)
    assert.ok(await js(`!!document.querySelector('${ready}')`), 'page content loaded')
    if (route) await js(`document.querySelector('.session-card input').click() ?? true`)
    for (const [width,height] of [[390,844],[390,650],[375,667],[320,568],[844,390],[1280,800]]) {
      await send('browsingContext.setViewport', {context, viewport: {width,height}})
      await delay(300)
      const layout = await js(`(() => {
        const body = document.querySelector('.page-body');
        const headerTop = document.querySelector('.page-header').getBoundingClientRect().top;
        body.scrollTop = body.scrollHeight;
        const rect = el => { const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,scrollHeight:el.scrollHeight,scrollTop:el.scrollTop} };
        return {headerTop, viewport:innerHeight, shell:rect(document.querySelector('.app-shell')),pane:rect(document.querySelector('.main-pane')),body:rect(body),header:rect(document.querySelector('.page-header')),last:rect(document.querySelector('.selection-bar') || document.querySelector('.home-settings-grid').lastElementChild)};
      })()`)
      assert.ok(layout.pane.bottom <= height + 1, `main pane fits ${width} × ${height}`)
      assert.equal(layout.pane.scrollTop, 0, 'main pane must not scroll')
      assert.ok(layout.header.top >= 0, 'header remains on screen')
      assert.equal(layout.header.top, layout.headerTop, 'scrolling content does not move the header')
      assert.ok(layout.last.bottom <= height + 1, 'last card or Analyze bar is visible')
      if (route) {
        assert.ok(layout.body.bottom <= layout.last.top + 1, 'Analyze bar reserves space below the list')
        // Desktop status overlays retain their existing behavior; mobile status
        // and selection footers must both reserve space and remain operable.
        if (width <= 800 || !route.includes('busy')) {
          assert.ok(await js(`(() => { const b = document.querySelector('.selection-bar .primary'); const r = b.getBoundingClientRect(); return !b.disabled && r.top >= 0 && r.bottom <= innerHeight + 1 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b })()`), 'Analyze button is enabled and hit-testable')
        }
      }
      console.log('PASS', route || 'overview', width, height)
    }
  }
}
const timeout = setTimeout(() => { console.error('Layout browser checks timed out'); firefox?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (firefox && firefox.exitCode === null) { firefox.kill(); await new Promise(resolve => firefox.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
