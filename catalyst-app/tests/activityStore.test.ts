import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActivityStore } from '../src/renderer/activityStore'

test('log history stays bounded and previously rendered snapshots stay immutable', () => {
  const store = createActivityStore()
  store.addLogEntry('info', 'main', 'first')
  const previous = store.logStore.getSnapshot()
  for (let i = 1; i <= 6000; i++) store.addLogEntry('log', 'worker', String(i))
  const latest = store.logStore.getSnapshot()
  assert.equal(previous.length, 1)
  assert.equal(previous[0].message, 'first')
  assert.ok(latest.length <= 5000)
  assert.equal(latest.at(-1)?.message, '6000')
  assert.equal(new Set(latest.map(entry => entry.id)).size, latest.length)
  assert.equal(store.logStore.getSnapshot(), latest)
})

test('workspace instances never share logs or progress', () => {
  const first = createActivityStore(), second = createActivityStore()
  first.addLogEntry('warn', 'main', 'private workspace log')
  first.statusStore.appendLine('private worker log')
  first.statusStore.setProgress({ current: 1, total: 2 })
  assert.deepEqual(second.logStore.getSnapshot(), [])
  assert.deepEqual(second.statusStore.getSnapshot(), { logLine: '', logLines: [], progress: null })
})

test('a viewer opening after a burst gets the latest status with bounded history', () => {
  const { statusStore } = createActivityStore()
  for (let i = 0; i < 1000; i++) {
    statusStore.appendLine(String(i))
    statusStore.setLogLine(String(i))
    statusStore.setProgress({ current: i, total: 1000 })
  }
  assert.equal(statusStore.getSnapshot().logLine, '999')
  assert.equal(statusStore.getSnapshot().logLines.length, 500)
  assert.equal(statusStore.getSnapshot().progress?.current, 999)
})
