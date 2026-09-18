const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-garage-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

// A fresh process per phase checks durable state and bypasses in-memory seed caches.
function run(root, source) {
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const garage = require('./dist-main/garmin/garageStore.js');
    const db = require('./dist-main/garmin/loadToDb.js');
    const paths = require('./dist-main/garmin/paths.js');
    const prompts = require('./dist-main/garmin/promptPack.js');
    (async () => { ${source} })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, CATALYST_INSTANCE_DIR: root },
    timeout: 20000,
    stdio: 'pipe',
  })
}

test('Garage seeds once, saves only to the workspace DB, and survives restart and telemetry reload', t => {
  const root = workspace(t)
  const car = path.join(root, 'Lotus/Car.md')
  const guide = path.join(root, 'Lotus/Driver.md')
  const settings = path.join(root, 'settings.json')
  fs.mkdirSync(path.dirname(car))
  fs.writeFileSync(car, '# Seed car')
  fs.writeFileSync(guide, '# Seed driver')
  const seedSettings = JSON.stringify({ active_profile: 'Lotus', vehicle_profile_map: { vehicle: 'Lotus' } })
  fs.writeFileSync(settings, seedSettings)
  fs.chmodSync(car, 0o444)
  fs.chmodSync(guide, 0o444)
  fs.chmodSync(path.dirname(car), 0o555)

  run(root, `
    await Promise.all([garage.ensureGarageSeeded(), garage.listGarageProfiles()]);
    assert.equal(await garage.readGarageFile(path.join(paths.REPO_ROOT, 'Lotus/Car.md')), '# Seed car');
    assert.equal(await garage.getGarageActiveProfile(), 'Lotus');
    assert.deepEqual(await garage.resolveGarageVehicleProfile('vehicle', null), { profile: 'Lotus', explicit: true });
    await garage.writeGarageFile('Lotus', 'Car.md', '# Saved car');
    await garage.deleteGarageFile('Lotus', 'Driver.md');
    await garage.ensureGarageProfile('Custom', 'vehicle');
    await garage.writeGarageFile('Custom', 'Car.md', '# Database-only car');
    await garage.writeGarageFile('Custom', 'Driver.md', '# Database-only driver');
    await garage.setGarageActiveProfile('Custom');
    await garage.setGarageVehicleProfile('temporary', 'Custom');
    await garage.setGarageVehicleProfile('temporary', null);
  `)
  assert.equal(fs.readFileSync(car, 'utf8'), '# Seed car')
  assert.equal(fs.readFileSync(guide, 'utf8'), '# Seed driver')
  assert.equal(fs.readFileSync(settings, 'utf8'), seedSettings)
  assert.equal(fs.existsSync(path.join(root, 'Custom')), false)
  // Remove all seed documents: prompt generation and restarts must need only DB records.
  fs.chmodSync(path.dirname(car), 0o755)
  fs.rmSync(path.dirname(car), { recursive: true })

  const verify = `
    assert.equal(await garage.readGarageFile(path.join(paths.REPO_ROOT, 'Lotus/Car.md')), '# Saved car');
    assert.deepEqual((await garage.listGarageFiles('Lotus')).map(file => file.name), ['Car.md']);
    assert.equal(await garage.getGarageActiveProfile(), 'Custom');
    assert.deepEqual(await garage.resolveGarageVehicleProfile('vehicle', null), { profile: 'Custom', explicit: true });
    assert.deepEqual(await garage.resolveGarageVehicleProfile('temporary', null), { profile: null, explicit: false });
    assert.equal(fs.existsSync(path.join(paths.REPO_ROOT, 'Lotus')), false);
    assert.equal(fs.existsSync(path.join(paths.REPO_ROOT, 'Custom')), false);
  `
  run(root, verify + `
    await db.withDb(async con => {
      await con.run("INSERT INTO sessions (session_guid, session_start, vehicle_guid) VALUES ('session', '2026-09-18', 'vehicle')");
      await con.run("INSERT INTO laps (session_guid, lap_index, duration_ms) VALUES ('session', 0, 60000)");
      await db.insertCoachingSession(con, {
        id: 'saved-coaching', created_at: '2026-09-18', session_guids: ['session'],
        profile_name: 'Custom', model_used: 'test', title: 'Saved coaching',
        prompt: 'prompt', raw_response: 'response', parsed_result: null,
      });
    });
    const coach = await prompts.runCoach({ sessionGuids: ['session'], profile: 'Lotus', scope: 'overview' });
    assert.equal(coach.profile, 'Custom');
    assert.match(coach.prompt, /### Database-only car/);
    assert.match(coach.prompt, /### Database-only driver/);
    assert.doesNotMatch(coach.prompt, /Seed car|Seed driver/);
    const brief = await prompts.runBrief({ mode: 'all', includeGuides: true });
    assert.match(fs.readFileSync(brief.outPath, 'utf8'), /### Database-only car/);
    assert.match(fs.readFileSync(brief.outPath, 'utf8'), /### Database-only driver/);
    await db.loadAll(() => {});
    await db.withDb(async con => {
      assert.equal((await con.runAndReadAll('SELECT COUNT(*) FROM sessions')).getRowsJson()[0][0], '0');
      assert.equal((await db.listCoachingSessions(con))[0].id, 'saved-coaching');
    });
  ` + verify)
  run(root, verify)
})

test('an initially empty Garage does not import Markdown added after initialization', t => {
  const root = workspace(t)
  run(root, 'assert.deepEqual(await garage.listGarageProfiles(), []);')
  fs.mkdirSync(path.join(root, 'Late'))
  fs.writeFileSync(path.join(root, 'Late/Car.md'), 'Late seed')
  run(root, 'assert.deepEqual(await garage.listGarageProfiles(), []);')
})

test('existing database profiles take precedence over legacy seed files during upgrade', t => {
  const root = workspace(t)
  fs.mkdirSync(path.join(root, 'Lotus'))
  fs.writeFileSync(path.join(root, 'Lotus/Car.md'), 'Stale seed')
  run(root, `
    await db.withDb(async con => {
      await db.initSchema(con);
      await con.run("INSERT INTO garage_profiles (name) VALUES ('Lotus')");
      await con.run("INSERT INTO garage_files (profile_name, file_name, content) VALUES ('Lotus', 'Car.md', 'Existing edit')");
    });
    assert.equal(await garage.readGarageFile(path.join(paths.REPO_ROOT, 'Lotus/Car.md')), 'Existing edit');
  `)
  assert.equal(fs.readFileSync(path.join(root, 'Lotus/Car.md'), 'utf8'), 'Stale seed')
})
