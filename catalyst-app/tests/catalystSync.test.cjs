const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Catalyst videos imported at offset 0 (before the folder clock was used)
// are re-synced on startup, keeping nudges made by hand.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-sync-'))
process.env.CATALYST_INSTANCE_DIR = root
const { initSchema, withDb, releaseSharedInstance } = require('../dist-main/garmin/loadToDb.js')
const { DB_PATH } = require('../dist-main/garmin/paths.js')
const { attachPlainVideo, getSessionVideo, setVideoOffset } = require('../dist-main/garmin/videoStore.js')
const { syncCatalystVideoOffsets } = require('../dist-main/garmin/catalystVideos.js')
const { catalystVideoOffset } = require('../dist-main/shared/catalystVideo.js')
const { LAYOUT, lapRows, seed } = require('./fixtures/compareFixture.cjs')

const db = fn => withDb(fn, DB_PATH)
const SESSION = { sg: 'lotus-am', start: '2026-10-30 08:32:37', laps: [1.0, 1.05] }
const lapsS = SESSION.laps.reduce((n, scale) => n + lapRows(scale).durationMs / 1000, 0)
const keyFor = time => `KING/${LAYOUT.track}/LOTUS EXIGE 2008/20261030/${time}/video_1.mp4`

test('the video offset is the session start after the folder clock, plus the camera start', () => {
  assert.equal(catalystVideoOffset('2026-09-22 09:25:38', '2026-09-22 09:28:07'), 149.4)
  assert.equal(catalystVideoOffset('2026-09-21 08:55:30', '2026-09-21 08:58:33'), 183.4)
  assert.equal(catalystVideoOffset('2026-10-30 08:32:20', '2026-10-30 10:00:45'), null, 'too far apart to be one session')
})

test('videos imported at offset 0 move to their recording clock on startup', async t => {
  t.after(() => { releaseSharedInstance(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  await db(initSchema)
  await db(con => seed(con, [SESSION]))
  const plain = (id, time) => ({
    videoId: id, fileName: `Catalyst ${time}`, sizeBytes: 1, durationS: 30 + lapsS + 20, recordedAt: `2026-10-30 ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}`,
    device: 'Garmin Catalyst', width: 1920, height: 1080, source: 'catalyst', sourcePath: keyFor(time),
  })
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
  // As the first release imported them: offset 0; B was then nudged by hand.
  await db(con => attachPlainVideo(con, plain(A, '083220'), { sessionGuid: 'lotus-am', offsetS: 0, note: null }))
  await db(con => attachPlainVideo(con, plain(B, '083230'), { sessionGuid: 'lotus-am', offsetS: 0, note: null }))
  await db(con => setVideoOffset(con, B, 0.7))

  assert.equal(await db(con => syncCatalystVideoOffsets(con)), 2)
  const a = await db(con => getSessionVideo(con, A)), b = await db(con => getSessionVideo(con, B))
  assert.equal(a.offsetS, 17.4)
  assert.equal(a.alignment, 'clock')
  assert.deepEqual(a.laps, [0, 1], 'laps recomputed for the new offset')
  assert.equal(b.offsetS, 7.4 + 0.7, 'the hand nudge is kept')
  assert.equal(b.alignment, 'manual')
  assert.equal(await db(con => syncCatalystVideoOffsets(con)), 0, 'a second run changes nothing')
  // Reset goes back to the new matched offset, not to 0.
  assert.equal((await db(con => setVideoOffset(con, B, null))).offsetS, 7.4)
})
