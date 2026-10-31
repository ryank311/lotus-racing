const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-track-library-'))
process.env.CATALYST_INSTANCE_DIR = root
const { releaseSharedInstance } = require('../dist-main/garmin/loadToDb.js')
const { localTrackLibrary } = require('../dist-main/garmin/trackLibrary.js')

const corner = (turn, apex) => ({ turn, name: turn, apex_idx: apex, dist_idx_start: apex - 20, dist_idx_end: apex + 20 })
const layout = (line, corners, complexes = []) => ({
  trackName: 'VIR', configName: 'Full Course', referenceLineGuid: line, referenceLine: null, totalDistM: 5255,
  segments: [], corners, complexes, complexesOrigin: complexes.length ? 'edited' : null,
})
const turns = l => l?.corners.map(c => c.turn)

test('the library keeps the layout with the most driver data per course', async t => {
  t.after(() => { releaseSharedInstance(); fs.rmSync(root, { recursive: true, force: true }) })
  const library = localTrackLibrary(path.join(root, 'shared.duckdb'))
  const vir = { configurationId: 72, trackName: 'VIR', configName: 'Full Course' }

  await t.test('an empty layout is never imported', async () => {
    assert.equal(await library.importLayout(vir, layout('ryan-line', []), 'workspace'), false)
    assert.equal(await library.find(vir), null)
  })

  await t.test('a seed fills an empty course, and only an empty one', async () => {
    assert.equal(await library.importLayout(vir, layout('ryan-line', [corner('S1', 100)]), 'seed'), true)
    assert.equal(await library.importLayout(vir, layout('ryan-line', [corner('S1', 100), corner('S2', 200)]), 'seed'), false)
    assert.deepEqual(turns(await library.find(vir)), ['S1'])
  })

  await t.test('a workspace layout replaces a seed, then only a layout with less data', async () => {
    assert.equal(await library.importLayout(vir, layout('mitch-line', [corner('M1', 300)]), 'workspace'), true, 'any real data beats a seed')
    assert.equal(await library.importLayout(vir, layout('ryan-line', [corner('T1', 500), corner('T2', 800)], [{ startM: 400, endM: 600, name: 'Hairpin' }]), 'workspace'), true)
    assert.equal(await library.importLayout(vir, layout('mitch-line', [corner('M1', 300)]), 'workspace'), false, 'less data never wins')
    assert.equal(await library.importLayout(vir, layout('other-line', [corner('X1', 100), corner('X2', 200)]), 'workspace'), false, 'a tie keeps the first')
    const stored = await library.find(vir)
    assert.deepEqual([turns(stored), stored.referenceLineGuid, stored.complexes.length, stored.source], [['T1', 'T2'], 'ryan-line', 1, 'workspace'])
  })

  await t.test('an edit made in the app is never replaced by an import', async () => {
    const stored = await library.find(vir)
    await library.saveCorners(vir, { ...layout('ryan-line', []), referenceLineGuid: 'ryan-line' }, [...stored.corners, corner('T3', 1000)])
    assert.equal(await library.importLayout(vir, layout('mitch-line', [1, 2, 3, 4, 5].map(i => corner(`M${i}`, i * 100))), 'workspace'), false)
    assert.deepEqual(turns(await library.find(vir)), ['T1', 'T2', 'T3'])
  })

  await t.test('saves must be measured on the stored layout’s reference line', async () => {
    await assert.rejects(library.saveCorners(vir, { ...layout('mitch-line', []) }, [corner('T1', 510)]), /changed by another driver/)
    await assert.rejects(library.saveComplexes(vir, 'mitch-line', [], 'derived'), /changed by another driver/)
  })

  await t.test('courses match by Garmin ID, by name until an ID is known', async () => {
    const north = { configurationId: null, trackName: 'VIR', configName: 'North Course' }
    assert.equal(await library.importLayout(north, layout('n-line', [corner('N1', 100)]), 'seed'), true)
    const byId = await library.find({ configurationId: 97, trackName: 'vir', configName: 'north course' })
    assert.deepEqual([turns(byId), byId.configurationId], [['N1'], 97], 'found by name and given the ID')
    assert.equal(await library.find({ configurationId: 98, trackName: 'VIR', configName: 'North Course' }), null, 'a different ID is another course')
    assert.deepEqual(turns(await library.find({ configurationId: 72, trackName: null, configName: null })), ['T1', 'T2', 'T3'])
    assert.equal(await library.find({ configurationId: null, trackName: 'VIR', configName: null }), null, 'a facility name alone is no course')
  })

  await t.test('a reference line is stored once, with the layouts that use it', async () => {
    const line = { guid: 'ryan-line', totalM: 10, dist: [0, 5, 10], lat: [37, 37.00005, 37.0001], lon: [-79, -79, -79] }
    await library.attachReferenceLine(line)
    await library.attachReferenceLine({ ...line, totalM: 99 })
    assert.deepEqual(await library.referenceLine('ryan-line'), line)
    const summary = (await library.list()).find(l => l.configurationId === 72)
    assert.deepEqual([summary.referenceLineGuid, summary.hasReferenceLine, summary.cornerCount], ['ryan-line', true, 3])
  })
})
