const assert = require('node:assert/strict')
const { test } = require('node:test')
const { coachingLapFilter, selectLaps, isLapFilter } = require('../dist-main/shared/coachingScope.js')
const { parseCoachResponse } = require('../dist-main/garmin/coachParser.js')

for (const count of [3, 5, 10]) {
  test(`saved Top ${count} coaching restores its original analysis filter`, () => {
    const prompt = `# Coaching Brief — Full Course (overview)\n_Generated: 2026-09-18_  ·  _Sessions: 6_  ·  _Laps: Top ${count} fastest across selected sessions_\n_Date range: fixture_`
    assert.equal(coachingLapFilter({ prompt }), `top${count}`)
  })
}
test('version 2 reports restore the filter saved in their context', () => {
  assert.equal(coachingLapFilter({ prompt: 'system prompt', parsed_result: { context: { lapFilter: 'top5' } } }), 'top5')
})
test('All and legacy reports default to all, ignoring incidental Top 10 mentions', () => {
  assert.equal(coachingLapFilter({ prompt: '# Coaching Brief\n_Generated: fixture_ · _Laps: All_\n## Top 10 fastest laps' }), 'all')
  assert.equal(coachingLapFilter({ prompt: 'legacy prompt' }), 'all')
})
const lap = (sg, lapIndex, durationMs) => ({ sg, lapIndex, durationMs })
// Session A is quick; B has one quick lap and an out-lap; C is slow.
const LAPS = [
  lap('A', 0, 150000), lap('A', 1, 131000), lap('A', 2, 131500), lap('A', 3, 132000), lap('A', 4, 140000),
  lap('B', 0, 160000), lap('B', 1, 131200), lap('B', 2, 133000),
  lap('C', 0, 136000), lap('C', 1, 135000),
]
const keys = laps => laps.map(l => `${l.sg}${l.lapIndex}`).join(' ')
test('Top N overall keeps the N fastest laps across every session', () => {
  assert.equal(keys(selectLaps(LAPS, 'top3')), 'A1 A2 B1')
  assert.equal(keys(selectLaps(LAPS, 'top5')), 'A1 A2 A3 B1 B2')
  assert.equal(selectLaps(LAPS, 'top10').length, 10)
})
test('session bests and Top 3 per session keep every session', () => {
  assert.equal(keys(selectLaps(LAPS, 'session-best')), 'A1 B1 C1')
  assert.equal(keys(selectLaps(LAPS, 'top3-session')), 'A1 A2 A3 B0 B1 B2 C0 C1')
})
test('legacy all keeps every lap; unknown values are not filters', () => {
  assert.equal(selectLaps(LAPS, 'all').length, LAPS.length)
  assert.equal(isLapFilter('top3-session'), true)
  assert.equal(isLapFilter('top20'), false)
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
