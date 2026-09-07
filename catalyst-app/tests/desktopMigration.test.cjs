const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, fork } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')
const { migrateDesktopWorkspace, copyDesktopWorkspace } = require('../dist-main/main/desktopMigration.js')
const { userDirectory } = require('../dist-main/main/serverStorage.js')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-migration-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root, server: path.join(root, 'server'),
    legacy: {
      repoRoot: path.join(root, 'legacy/profiles'), garminDir: path.join(root, 'legacy/garmin'),
      dataDir: path.join(root, 'external-data'), dbPath: path.join(root, 'external-db/custom.duckdb'),
      tracksDir: path.join(root, 'legacy/tracks'), coachingDir: path.join(root, 'legacy/coaching'),
      settingsPath: path.join(root, 'legacy/settings.json'),
    },
  }
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
function runDb(script, dbPath) {
  const modulePath = path.resolve(__dirname, '../dist-main/garmin/loadToDb.js')
  const result = spawnSync(process.execPath, ['-e', `
    const {openDb,initSchema} = require(${JSON.stringify(modulePath)});
    (async () => { const db = await openDb(process.argv[1]); await initSchema(db.con);
      ${script}
      await db.close(); process.exit(0);
    })().catch(e => { console.error(e); process.exit(1) });
  `, dbPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('fresh installs do not create a legacy desktop account', async t => {
  const { server, legacy } = fixture(t)
  assert.equal(await migrateDesktopWorkspace(server, legacy), null)
  assert.equal(fs.existsSync(server), false)
})

test('desktop import preserves DB history, WAL, files and settings without touching the source', { timeout: 20000 }, async t => {
  const { server, legacy } = fixture(t)
  runDb(`
    await db.con.run("CREATE TABLE import_history (value VARCHAR); INSERT INTO import_history VALUES ('checkpoint'); CHECKPOINT;");
    await db.con.run("INSERT INTO import_history VALUES ('wal-only')");
  `, legacy.dbPath)
  const sourceDb = fs.readFileSync(legacy.dbPath)
  assert.ok(fs.existsSync(legacy.dbPath + '.wal'), 'fixture must exercise WAL recovery')
  const sourceWal = fs.readFileSync(legacy.dbPath + '.wal')
  const mappings = [
    [path.join(legacy.dataDir, 'sessions/session-1/raw.json'), 'garmin/data/sessions/session-1/raw.json', '{"session":1}'],
    [path.join(legacy.dataDir, 'mean_lines/track.json'), 'garmin/data/mean_lines/track.json', '{"track":1}'],
    [path.join(legacy.garminDir, '.catalyst_token.json'), 'garmin/.catalyst_token.json', '{"access_token":"fixture-token"}'],
    [path.join(legacy.garminDir, '.garth/token.json'), 'garmin/.garth/token.json', '{"token":"fixture"}'],
    [legacy.settingsPath, 'settings.json', '{"active_profile":"Custom"}'],
    [path.join(legacy.repoRoot, 'Custom/Car.md'), 'Custom/Car.md', 'Edited Garage profile'],
    [path.join(legacy.tracksDir, 'custom.yaml'), 'tracks/custom.yaml', 'name: Custom track'],
    [path.join(legacy.coachingDir, 'report.md'), 'coaching/report.md', 'Coaching history'],
  ]
  for (const [source, , contents] of mappings) write(source, contents)
  const config = { auth: { email: 'fixture@example.test', password: 'legacy-password' }, ai: { openai_api_key: 'fixture-key' }, units: 'metric' }
  write(path.join(legacy.garminDir, 'config.json'), JSON.stringify(config))
  const username = await migrateDesktopWorkspace(server, legacy)
  assert.equal(username, 'Desktop')
  const imported = userDirectory(server, username)
  for (const [source, dest, contents] of mappings) {
    assert.equal(fs.readFileSync(path.join(imported, dest), 'utf8'), contents)
    assert.equal(fs.readFileSync(source, 'utf8'), contents)
  }
  const importedConfig = JSON.parse(fs.readFileSync(path.join(imported, 'garmin/config.json'), 'utf8'))
  assert.deepEqual(importedConfig, { ...config, auth: { email: 'fixture@example.test' } })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacy.garminDir, 'config.json'), 'utf8')), config)
  assert.deepEqual(fs.readFileSync(legacy.dbPath), sourceDb)
  assert.deepEqual(fs.readFileSync(legacy.dbPath + '.wal'), sourceWal)
  assert.equal(runDb(`console.log(JSON.stringify((await db.con.runAndReadAll('SELECT value FROM import_history ORDER BY value')).getRowsJson()));`, path.join(imported, 'garmin/data/catalyst-app.duckdb')), '[["checkpoint"],["wal-only"]]')
  write(path.join(imported, 'Custom/Car.md'), 'Edited after import')
  // Once imported, startup must no longer depend on a usable legacy backup.
  fs.unlinkSync(legacy.dbPath + '.wal')
  write(legacy.dbPath, 'unavailable legacy database')
  assert.equal(await migrateDesktopWorkspace(server, legacy), username)
  assert.equal(fs.readFileSync(path.join(imported, 'Custom/Car.md'), 'utf8'), 'Edited after import')
  assert.equal(fs.readdirSync(path.join(server, 'users')).length, 1)
})

test('existing names are not overwritten and completed imports are not repeated', async t => {
  const { server, legacy } = fixture(t)
  const occupied = userDirectory(server, 'desktop')
  write(path.join(occupied, 'account.json'), '{"username":"desktop"}')
  write(path.join(occupied, 'sentinel'), 'Existing user data')
  write(legacy.settingsPath, '{"active_profile":"Custom"}')
  assert.equal(await migrateDesktopWorkspace(server, legacy), 'Desktop 2')
  fs.unlinkSync(legacy.settingsPath)
  assert.equal(await migrateDesktopWorkspace(server, legacy), 'Desktop 2')
  assert.equal(fs.readFileSync(path.join(occupied, 'sentinel'), 'utf8'), 'Existing user data')
})

test('failed imports do not publish partial accounts and can be retried', async t => {
  const { server, legacy } = fixture(t)
  write(legacy.settingsPath, '{}')
  write(path.join(legacy.repoRoot, 'Custom/Car.md'), 'Preserve me')
  write(path.join(legacy.garminDir, 'config.json'), 'invalid JSON')
  await assert.rejects(migrateDesktopWorkspace(server, legacy))
  assert.deepEqual(fs.readdirSync(path.join(server, 'users')), [])
  assert.deepEqual(fs.readdirSync(server), ['users'])
  write(path.join(legacy.garminDir, 'config.json'), '{}')
  assert.equal(await migrateDesktopWorkspace(server, legacy), 'Desktop')
})

test('a server directory nested inside a source folder is rejected before recursive copying', t => {
  const { legacy } = fixture(t)
  write(path.join(legacy.dataDir, 'sessions/raw.json'), '{}')
  const server = path.join(legacy.dataDir, 'server')
  assert.throws(() => copyDesktopWorkspace(server, legacy), /outside the legacy folders/)
  assert.deepEqual(fs.readdirSync(path.join(server, 'users')), [])
})

test('migration refuses an active writer and succeeds once its database lock is released', { timeout: 15000 }, async t => {
  const { root, server, legacy } = fixture(t)
  const writerScript = path.join(root, 'writer.cjs')
  write(writerScript, `
    const {openDb,initSchema} = require(${JSON.stringify(path.resolve(__dirname, '../dist-main/garmin/loadToDb.js'))});
    process.on('message', () => {});
    (async () => {
      const db = await openDb(process.argv[2]);
      await initSchema(db.con);
      process.send({ ready: true });
    })().catch(e => { console.error(e); process.exit(1) });
  `)
  const writer = fork(writerScript, [legacy.dbPath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(writer, 'exit')
  t.after(async () => { writer.kill(); await exited })
  await once(writer, 'message')
  await assert.rejects(migrateDesktopWorkspace(server, legacy), /lock/i)
  assert.equal(fs.existsSync(server), false)
  writer.kill()
  await exited
  assert.equal(await migrateDesktopWorkspace(server, legacy), 'Desktop')
})
