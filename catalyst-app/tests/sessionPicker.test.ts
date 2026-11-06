import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DbSessionRow } from '../src/shared/types'
import { sessionBenchmarks, sessionCourseKey, sessionPickerGroups } from '../src/renderer/components/sessionPickerData'

const row = (id: string, ms: number | null, extra: Partial<DbSessionRow> = {}): DbSessionRow => ({
  session_guid: id, session_start: '2026-10-30 10:00:00', track_name: 'Virginia International Raceway',
  track_configuration_name: 'Full Course', track_configuration_id: 72, layout_key: 'full-line',
  details_loaded: true, best_lap_ms: ms, lap_count: 5, sample_count: 100, weather_description: 'Clear',
  account: 'driver', vehicle_guid: 'lotus', vehicle_make: 'Lotus', vehicle_model: 'Elise', vehicle_year: 2006, vehicle_type: 'car', ...extra,
})
const sessions = [
  row('latest', 137000, { session_start: '2026-11-01 14:30:00' }), row('pb', 135000),
  row('grand', 164000, { track_configuration_name: 'Grand West Course', track_configuration_id: 99 }),
  row('vette', 129000, { vehicle_guid: 'vette', vehicle_make: 'Chevrolet', vehicle_model: 'Corvette' }),
  row('other-driver', 130000, { account: 'friend' }), row('no-time', null),
]
test('layout sections remain distinct; fastest sorts inside each course and puts missing times last', () => {
  const groups = sessionPickerGroups(sessions, 'fastest')
  assert.deepEqual(groups.map(g => g.layout), ['Full Course', 'Grand West Course'])
  assert.equal(groups[0].rows[0].session_guid, 'vette')
  assert.equal(groups[0].rows.at(-1)!.session_guid, 'no-time')
  assert.equal(sessionPickerGroups(sessions, 'recent')[0].rows[0].session_guid, 'latest')
  assert.notEqual(sessionCourseKey(sessions[0]), sessionCourseKey(sessions[2]), 'configuration wins over a reused map ID')
})
test('PBs and gaps belong to the driver, car and layout and survive filtering', () => {
  const benchmarks = sessionBenchmarks(sessions)
  assert.deepEqual(benchmarks.get('latest'), { isPb: false, gapMs: 2000 })
  for (const id of ['pb', 'grand', 'vette', 'other-driver']) assert.equal(benchmarks.get(id)!.isPb, true)
  const filtered = sessionPickerGroups(sessions, 'fastest', 'Nov 1 2026', 'lotus')[0].rows
  assert.deepEqual(filtered.map(s => s.session_guid), ['latest'])
  assert.equal(benchmarks.get(filtered[0].session_guid)!.isPb, false)
})
test('search combines dates, car and course; car and layout filters do not mutate the catalogue', () => {
  const original = sessions.map(s => s.session_guid)
  assert.deepEqual(sessionPickerGroups(sessions, 'recent', 'virginia grand')[0].rows.map(s => s.session_guid), ['grand'])
  assert.equal(sessionPickerGroups(sessions, 'recent', 'Full Corvette', 'lotus').length, 0)
  assert.deepEqual(sessions.map(s => s.session_guid), original)
})
test('unidentified cars, layouts and invalid lap times never receive a PB badge', () => {
  const unknown = [row('car', 130000, { vehicle_guid: null }), row('layout', 130000, {
    track_configuration_id: null, layout_key: null, track_name: null, track_configuration_name: null,
  }), ...[0, -1, NaN, Infinity, null].map((ms, i) => row(`invalid-${i}`, ms))]
  for (const benchmark of sessionBenchmarks(unknown).values()) assert.deepEqual(benchmark, { gapMs: null, isPb: false })
  assert.notEqual(sessionCourseKey(row('a', 1, { track_configuration_id: null, layout_key: null })),
    sessionCourseKey(row('b', 1, { track_configuration_id: null, layout_key: null, track_name: 'Another track' })))
})
test('an archived PB outside the selectable list still supplies the correct gap; tied PBs are marked', () => {
  const benchmarks = sessionBenchmarks([row('slow', 136000, { layout_best_ms: 134000 }), row('tie-a', 134000), row('tie-b', 134000)])
  assert.equal(benchmarks.get('slow')!.gapMs, 2000)
  assert.equal(benchmarks.get('tie-a')!.isPb, true)
  assert.equal(benchmarks.get('tie-b')!.isPb, true)
})
