const assert = require('node:assert/strict')
const { test } = require('node:test')
const { coachingLapFilter } = require('../dist-main/shared/coachingScope.js')
const { parseCoachResponse } = require('../dist-main/garmin/coachParser.js')

for (const count of [3, 5, 10]) {
  test(`saved Top ${count} coaching restores its original analysis filter`, () => {
    const prompt = `# Coaching Brief — Full Course (overview)\n_Generated: 2026-09-18_  ·  _Sessions: 6_  ·  _Laps: Top ${count} fastest across selected sessions_\n_Date range: fixture_`
    assert.equal(coachingLapFilter({ prompt }), `top${count}`)
  })
}
test('All and legacy reports default to all, ignoring incidental Top 10 mentions', () => {
  assert.equal(coachingLapFilter({ prompt: '# Coaching Brief\n_Generated: fixture_ · _Laps: All_\n## Top 10 fastest laps' }), 'all')
  assert.equal(coachingLapFilter({ prompt: 'legacy prompt' }), 'all')
})
test('structured report survives Unicode and retains tips and track annotations', () => {
  const input = {
    headline: 'Brake–coast–re-brake costs ~0.4 s',
    tips: [{ section: 'T1', body: 'Brake once.', annotations: [{ type: 'corner_tip', ref: 'T1', body: 'Carry speed.' }] }],
    annotations: [{ type: 'corner_tip', ref: 'T1', body: 'Carry speed.' }],
  }
  const parsed = parseCoachResponse(JSON.stringify(input))
  assert.equal(parsed.headline, input.headline)
  assert.equal(parsed.tips.length, 1)
  assert.equal(parsed.annotations.length, 1)
  assert.equal(parseCoachResponse('The report is coming soon.'), null)
})
