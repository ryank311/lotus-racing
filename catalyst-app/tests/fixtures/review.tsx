/** Deterministic, offline UI states; no driver data or provider requests. */
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { SessionReview } from '../../src/renderer/pages/SessionReview'
import { App } from '../../src/renderer/App'
import { Progress } from '../../src/renderer/pages/Progress'
import { NavigationProvider, useRoute } from '../../src/renderer/navigation'
import { UnitsProvider } from '../../src/renderer/units'
import { aggregateLaps, buildComparison, measureLap } from '../../src/garmin/reviewMetrics'
import type { ReviewAggregate, ReviewCoachResult } from '../../src/shared/review'
import '../../src/renderer/styles.css'

const progressFixture = new URLSearchParams(window.location.search).has('progress')
const appFixture = new URLSearchParams(window.location.search).has('app')
const test = window as any
const savedReports = new Map<string, any>()
let pendingCoach: any
const regions = [{ id: 'corner:T1', name: 'T1 · Illustrative corner', kind: 'corner' as const, startM: 20, endM: 60 }]
if (progressFixture) regions.push({ id: 'corner:T2', name: 'T2 · Hairpin', kind: 'corner', startM: 65, endM: 85 })
// Several sessions per visit, with months off track between visits.
const sessionDates = ['2026-04-18 10:00:00', '2026-04-18 14:00:00', '2026-04-19 11:00:00', '2026-08-29 10:00:00', '2026-08-30 10:00:00', '2026-09-19 10:00:00']
const make = (n: number): ReviewAggregate => {
  const laps = [0, 1, 2, 3].map(index => { const durationMs = 14000 - n * 500 + index * 100; return measureLap({ index, durationMs, type: 'DRIVEN', descriptor: 0,
    samples: Array.from({ length: 101 }, (_, d) => ({ distance: d, time: d * durationMs / 100, speed: 10 + Math.abs(d - 40) / 10 })) }, regions, 100) })
  return { version: 1, revision: `aggregate-${n}`, laps, map: Array.from({ length: 101 }, (_, d) => ({ dist: d, x: Math.cos(d / 100 * 2 * Math.PI) * 100, y: Math.sin(d / 100 * 2 * Math.PI) * 70 })), summary: {
    sessionGuid: `fixture-${n}`, start: sessionDates[n - 1], track: 'Illustrative Raceway', layout: 'Full', vehicle: 'Example car',
    account: 'fixture', vehicleGuid: 'car', configurationId: 1, cartographyId: 1, reverse: false, direction: 'clockwise', meanLineGuid: 'line', geometryRevision: 'g', sourceRevision: 's',
    conditions: { surface: 'dry', temperatureC: 20, originalTemperatureC: 20, surfaceSource: 'estimated', temperatureSource: 'recorded', weather: 'Clear', correctedAt: null },
    qualityNotes: [], ...aggregateLaps(laps, regions),
  } }
}
const all = [1, 2, 3, 4, 5, 6].map(make)
if (progressFixture) {
  all[0].summary.geometryRevision = 'older-definitions'
  all[2].summary.regions[0].entryMps = null
  all.forEach((s, i) => { s.summary.regions[1].entryMps = 12 + i; s.summary.regions[1].consistencyMs = 0 })
}
const reviewListeners = new Set<Function>(), workerListeners = new Set<Function>()
let state = 'ready', reports = 0, runCount = 0
let rerender = () => {}
const result: ReviewCoachResult = { summary: 'Your faster pace repeated across three laps. Keep the exit consistent next session.', strengths: ['T1 traversal time improved across the fast sample.'], regressions: [],
  priorities: [{ ref: 'corner:T1', advice: 'Repeat the exit before changing your approach.', evidence: ['corner:T1'], cue: 'Settle, then build', successMetric: 'Repeat your observed T1 time within 0.10 s on two clear laps.' }], limitations: ['Illustrative offline fixture. No control inputs are measured.'] }
const coverage = () => ({ catalog: 6, downloaded: 6, processed: state === 'partial' ? 4 : 6, pending: state === 'partial' ? 2 : 0, failed: 0 })
const snapshot = (id: string) => ({ ...buildComparison(all.find(s => s.summary.sessionGuid === id) ?? all[5], all.map(s => s.summary), coverage()), revision: 'current' })
const notify = () => reviewListeners.forEach(fn => fn({ sessionGuid: 'fixture-6', state: 'ready' }))
test.finishCoach = () => {
  const guid = pendingCoach.sessionGuids[0], id = `fixture-report-${runCount}`
  const report = { id, session_guids: [guid], created_at: '2026-09-06', model_used: 'Offline fixture',
    review_context: { sessionGuid: guid, revision: 'current', units: 'imperial', evidence: {} },
    review_result: { ...result, summary: `Completed coaching ${runCount} for ${guid}` } }
  savedReports.set(guid, report)
  workerListeners.forEach(fn => fn({ kind: 'coach', type: 'done', payload: id }))
}
;(window as any).reviewFixture = (method: string, args: any[]) => {
  if (method === 'getAuthState') return Promise.resolve({ tokenValid: false })
  if (method === 'getSyncStats') return Promise.resolve({ sessionCount: 6 })
  if (method === 'onLog') return () => {}
  if (method === 'getCoachSession') {
    const report = [...savedReports.values()].find(r => r.id === args[0]) ?? null
    return test.holdReport ? new Promise(resolve => { test.releaseReport = () => resolve(report) }) : Promise.resolve(report)
  }
  if (method === 'onReviewStatus' || method === 'onWorker') { const set = method === 'onWorker' ? workerListeners : reviewListeners; set.add(args[0]); return () => set.delete(args[0]) }
  if (method === 'getUnits') return Promise.resolve('imperial')
  if (method === 'getActiveProfile') return Promise.resolve('Example')
  if (method === 'listSessions') return Promise.resolve([...all].reverse().map(s => ({ session_guid: s.summary.sessionGuid, session_start: s.summary.start, track_name: 'Illustrative Raceway', track_configuration_name: 'Full', vehicle_model: 'Example' })))
  if (method === 'getSessionReview') {
    if (state === 'network-error') return Promise.reject(new Error('Illustrative network failure'))
    if (['processing', 'needs-download', 'failed'].includes(state)) return Promise.resolve({ state, error: state === 'failed' ? 'Illustrative processing failure' : null, snapshot: null, coaching: null, coachingStale: false })
    let s = snapshot(args[0])
    if (appFixture) {
      const report = savedReports.get(args[0])
      return Promise.resolve({ state: 'ready', snapshot: s, error: null, coachingStale: false, coaching: report ? {
        id: report.id, sessionGuid: args[0], revision: 'current', createdAt: report.created_at, model: report.model_used,
        units: 'imperial', result: report.review_result, evidence: {}, error: null,
      } : null })
    }
    if (state === 'unknown') {
      const current: ReviewAggregate = { ...s.current, summary: { ...s.current.summary, conditions: { ...s.current.summary.conditions, surface: 'unknown' } } }
      s = { ...buildComparison(current, all.map(a => a.summary), coverage()), revision: 'current' }
    }
    return Promise.resolve({ state: 'ready', snapshot: s, error: null, coachingStale: state === 'stale', coaching: reports || state === 'stale' ? {
      id: 'fixture-report', sessionGuid: args[0], revision: state === 'stale' ? 'old' : 'current', createdAt: '2026-09-06', model: 'Offline fixture', units: 'imperial', result,
      evidence: { 'corner:T1': 'Illustrative T1 comparison: current 4.44 s, baseline 5.04 s.' }, error: null,
    } : null })
  }
  if (method === 'ensureSessionReview') { if (args[1] || state === 'network-error') { state = 'ready'; notify() }; return Promise.resolve() }
  if (method === 'getProgress') return Promise.resolve({ filters: { vehicleGuid: 'car', account: 'fixture', cartographyId: 1, configurationId: 1, reverse: false, direction: 'clockwise', surface: 'dry', temperatureC: 20 }, available: all.map(s => s.summary), sessions: all.map(s => s.summary), references: [], coverage: coverage() })
  if (method === 'runCoach') {
    runCount++
    if (appFixture) { pendingCoach = args[0]; workerListeners.forEach(fn => fn({ kind: 'coach', type: 'progress', progress: { current: 0, total: 3, label: 'Coaching…' } })) }
    else { reports++; rerender(); workerListeners.forEach(fn => fn({ kind: 'coach', type: 'done', payload: 'fixture-report' })) }
    return Promise.resolve({ sessionId: null })
  }
  return Promise.resolve()
}
function Fixture() {
  const route = useRoute(), [tick, setTick] = useState(0)
  rerender = () => setTick(n => n + 1)
  return <><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8, background: '#202024' }} aria-label="Fixture controls">
    <strong>ILLUSTRATIVE QA</strong>{['ready', 'processing', 'needs-download', 'failed', 'network-error', 'partial', 'unknown', 'stale'].map(s => <button key={s} onClick={() => { state = s; setTick(n => n + 1); notify() }}>{s}</button>)}<output>Coach calls: {runCount}</output>
  </div><div className="app-shell" style={{ height: 'calc(100dvh - 80px)', gridTemplateColumns: 'minmax(0, 1fr)' }}><main className="main-pane">{route.page === 'progress' ? <Progress /> : <SessionReview refreshTick={tick} busy={null} />}</main></div></>
}
const router = createMemoryRouter([{ path: '*', element: <NavigationProvider><UnitsProvider>{appFixture ? <App /> : <Fixture />}</UnitsProvider></NavigationProvider> }], { initialEntries: [progressFixture ? '/progress' : '/review/fixture-6'] })
test.router = router
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
