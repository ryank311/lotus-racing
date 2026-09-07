const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')

test('the real Electron RunAsNode worker works without the Electron npm module', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-packaged-worker-test-'))
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CATALYST_INSTANCE_DIR: root, CATALYST_TEMPLATE_ROOT: root }
  delete env.CATALYST_BUNDLED_RESOURCES
  const worker = fork(path.join(__dirname, '../dist-main/main/userWorker.js'), [], {
    execPath: require('electron'),
    execArgv: ['--require', path.join(__dirname, 'fixtures/no-electron.cjs')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env,
  })
  let stderr = ''
  worker.stderr.on('data', data => { stderr += data })
  const exited = once(worker, 'exit')
  t.after(async () => { worker.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }) })
  function messageWhere(predicate) {
    return new Promise((resolve, reject) => {
      const onMessage = message => {
        if (predicate(message)) { cleanup(); resolve(message) }
      }
      const onExit = () => { cleanup(); reject(new Error(stderr || 'Worker exited before reply')) }
      const cleanup = () => { worker.off('message', onMessage); worker.off('exit', onExit) }
      worker.on('message', onMessage); worker.once('exit', onExit)
    })
  }
  const ready = await messageWhere(message => ['ready', 'fatal'].includes(message.type))
  assert.equal(ready.type, 'ready', ready.error)
  let id = 0
  async function rpc(channel, ...args) {
    const requestId = ++id
    const reply = messageWhere(message => message.type === 'rpc-result' && message.requestId === requestId)
    worker.send({ type: 'rpc', requestId, channel, args })
    return reply
  }
  assert.equal((await rpc('profiles:writeCarMd', 'Car', 'Car.md', 'Packaged native DB test')).ok, true)
  assert.equal((await rpc('profiles:readCarMd', 'Car')).result, 'Packaged native DB test')
  assert.equal((await rpc('tracks:get', '../invalid')).ok, false)
  assert.equal((await rpc('units:get')).result, 'imperial')
  // Disconnecting the parent must also release the worker's database lock.
  worker.disconnect()
  await exited
  assert.equal(worker.exitCode, 0)
})
