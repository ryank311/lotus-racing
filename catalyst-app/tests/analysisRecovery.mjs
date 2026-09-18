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
  await send('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 } })
  await send('browsingContext.navigate', { context, url: `${server.resolvedUrls.local[0]}analysis-recovery.html`, wait: 'complete' })
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return
      await delay(50)
    }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText'))
  }
  const retry = async mode => {
    const before = await js('window.analysisCalls')
    await js(`(() => { window.analysisMode = ${JSON.stringify(mode)}; [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry analysis').click(); return true })()`)
    await waitFor(`window.analysisCalls === ${before + 1}`)
  }
  const expectError = async text => {
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes(${JSON.stringify(text)})`)
    assert.equal(await js("!!document.querySelector('.spinner')"), false, 'spinner stops on failure')
    assert.ok(await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry analysis'); const r = b.getBoundingClientRect(); return r.width > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b })()`), 'retry is visible and usable on mobile even with Map selected')
  }
  await expectError('incomplete or invalid')
  console.log('PASS truncated JSON ends loading and exposes Retry')
  await retry('http'); await expectError('502')
  await retry('network'); await expectError('Network connection lost')
  await retry('empty'); await expectError('no analysis')
  console.log('PASS HTTP, network, and empty-result errors')
  await retry('hold')
  await js('window.expireAnalysis() ?? true')
  await expectError('too long')
  console.log('PASS stalled response times out')
  await retry('hold')
  await js(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Stop waiting').click(); return true })()`)
  await expectError('Stopped waiting')
  console.log('PASS stop waiting allows retry')
  await retry('success')
  await waitFor(`document.querySelector('.analysis-context strong')?.textContent === 'Recovered analysis' && !!document.querySelector('.analysis-stat-strip')`)
  assert.equal(await js('!!document.querySelector("[role=alert]")'), false)
  await js('(() => { window.heldResponses.forEach(resolve => resolve()); return true })()')
  await delay(100)
  assert.equal(await js("document.querySelector('.analysis-context strong').textContent"), 'Recovered analysis', 'late responses cannot overwrite retry result')
  console.log('PASS retry renders a >400 KB result and ignores stale responses')
}
const timeout = setTimeout(() => { console.error('Analysis recovery browser checks timed out'); firefox?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (firefox && firefox.exitCode === null) { firefox.kill(); await new Promise(resolve => firefox.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
