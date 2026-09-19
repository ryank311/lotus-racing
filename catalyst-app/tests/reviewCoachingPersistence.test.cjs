const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('session coaching survives database owner restart and retains each generated report', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-review-coaching-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'driver.duckdb')
  const reports = [1, 2].map(generation => {
    const result = { summary: `Session advice ${generation}`, strengths: ['Repeatable corner time'], regressions: [],
      priorities: [{ ref: 'corner:T1', advice: 'Repeat the exit', evidence: ['corner:T1'], cue: 'Build smoothly', successMetric: 'Two laps within 0.10 s of the observed corner time' }], limitations: ['No measured brake input'] }
    return { id: `report-${generation}`, created_at: `2026-09-19T10:00:0${generation}.000Z`, session_guids: ['reviewed-session'],
      profile_name: 'Car', model_used: 'fixture-model', title: result.summary, prompt: `Saved evidence prompt ${generation}`,
      raw_response: JSON.stringify(result), parsed_result: null, review_result: result,
      review_context: { sessionGuid: 'reviewed-session', revision: `revision-${generation}`, provider: 'openai', units: 'imperial',
        evidence: { 'corner:T1': 'Current 4.20 s; baseline 4.40 s; change -0.20 s' } } }
  })
  // Each invocation owns and then exits its own native DuckDB process. The
  // second invocation cannot accidentally read a cached in-memory report.
  const child = `
    const fs = require('node:fs');
    const db = require(${JSON.stringify(path.resolve(__dirname, '../dist-main/garmin/loadToDb.js'))});
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    (async () => {
      const output = await db.withDb(async con => {
        await db.initSchema(con);
        if (input.reports) {
          for (const report of input.reports) await db.insertCoachingSession(con, report);
          return { saved: input.reports.length };
        }
        return { history: await db.listCoachingSessions(con), original: await db.getCoachingSession(con, 'report-1') };
      }, input.dbPath);
      process.stdout.write(JSON.stringify(output));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  function run(input) {
    const result = spawnSync(process.execPath, ['-e', child], { input: JSON.stringify({ dbPath, ...input }), encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.deepEqual(run({ reports }), { saved: 2 })
  const reopened = run({})
  assert.deepEqual(reopened.history.map(report => report.id), ['report-2', 'report-1'], 'regeneration retains earlier advice')
  for (const [index, saved] of [reopened.original, reopened.history[0]].entries()) {
    for (const field of ['session_guids', 'profile_name', 'model_used', 'prompt', 'raw_response', 'review_context', 'review_result']) {
      assert.deepEqual(saved[field], reports[index][field], `${field} survives restart`)
    }
  }
})
