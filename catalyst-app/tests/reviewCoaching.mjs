// Session-review coaching completion regressions via WebDriver BiDi.
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
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-review-coaching-test-'))
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
  await send('browsingContext.navigate', { context, url: `${server.resolvedUrls.local[0]}review.html?app`, wait: 'complete' })
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return
      await delay(50)
    }
    throw new Error('Timed out: ' + expression + '\n' + await js('document.body.innerText'))
  }
  const coach = async () => {
    await waitFor(`document.querySelector('.review-coach button')?.disabled === false`)
    await js(`document.querySelector('.review-coach button').click()`)
    await waitFor(`document.querySelector('.review-coach button')?.textContent === 'Coaching…'`)
  }
  const reportVisible = (n, guid) => `document.querySelector('.review-coach')?.textContent.includes('Completed coaching ${n} for ${guid}')`
  await coach()
  await js('window.finishCoach()')
  await waitFor(reportVisible(1, 'fixture-6'))
  await delay(150)
  assert.equal(await js("window.router.state.location.pathname"), '/review/fixture-6')
  assert.equal(await js("!!document.querySelector('.coach-toast')"), false, 'the open review loads coaching without a notification')
  console.log('PASS coaching appears in the open review without navigation or a toast')

  await coach()
  await js("window.router.navigate('/review/fixture-5')")
  await waitFor(`document.querySelector('[aria-label="Review session"]')?.value === 'fixture-5' && document.querySelector('.review-coach button')?.disabled === true`)
  await js('window.finishCoach()')
  await waitFor(`!!document.querySelector('.coach-toast')`)
  assert.equal(await js(reportVisible(2, 'fixture-6')), false, 'another session never receives the completed report')
  assert.equal(await js('window.router.state.location.pathname'), '/review/fixture-5', 'completion does not take over navigation')
  await js("document.querySelector('.coach-toast-view').click()")
  await waitFor(reportVisible(2, 'fixture-6'))
  assert.equal(await js('window.router.state.location.pathname'), '/review/fixture-6', 'notification opens the originating review directly')
  console.log('PASS switching sessions preserves navigation; View opens the originating review with results')

  await coach()
  await js("window.router.navigate('/progress')")
  await waitFor(`window.router.state.location.pathname === '/progress' && !document.querySelector('.review-coach')`)
  await js('window.finishCoach()')
  await waitFor(`!!document.querySelector('.coach-toast')`)
  await js("document.querySelector('.coach-toast-view').click()")
  await waitFor(reportVisible(3, 'fixture-6'))
  console.log('PASS leaving the page still gets a notification that opens the completed review')

  await coach()
  await js('(() => { window.holdReport = true; window.finishCoach() })()')
  await waitFor(`typeof window.releaseReport === 'function'`)
  await js("window.router.navigate('/review/fixture-5')")
  await waitFor(`document.querySelector('[aria-label="Review session"]')?.value === 'fixture-5'`)
  await js('window.releaseReport()')
  await waitFor(`!!document.querySelector('.coach-toast')`)
  assert.equal(await js('window.router.state.location.pathname'), '/review/fixture-5')
  console.log('PASS notification uses the current route after an asynchronous report lookup')
}
const timeout = setTimeout(() => { console.error('Review coaching browser checks timed out'); firefox?.kill(); process.exit(1) }, 60000)
try { await main() } catch (error) { console.error(error); process.exitCode = 1 }
finally {
  clearTimeout(timeout)
  socket?.close()
  if (firefox && firefox.exitCode === null) { firefox.kill(); await new Promise(resolve => firefox.once('exit', resolve)) }
  await server?.close()
  if (profile) fs.rmSync(profile, { recursive: true, force: true })
}
