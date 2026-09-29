// Manual browser regression fixture for saved-report loading. Run with Vite
// rooted at tests/fixtures. All API calls stay in memory; no provider requests.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { NavigationProvider, useNavigation } from '../../src/renderer/navigation'
import type { CoachingSession, WorkerEvent } from '../../src/shared/types'
import { lapFilterLabel, type LapFilter } from '../../src/shared/coachingScope'
import '../../src/renderer/styles.css'

const listeners = new Set<(event: WorkerEvent) => void>()
let nextReport: CoachingSession
const emit = (event: WorkerEvent) => { for (const callback of listeners) callback(event) }
const makeReport = (filter: LapFilter, id = `report-${filter}`): CoachingSession => ({
  id, created_at: '2026-09-18', session_guids: ['fixture-session'], profile_name: 'Test',
  model_used: 'fixture', title: 'Saved coaching',
  prompt: `# Coaching Brief\n_Generated: fixture_`,
  raw_response: '',
  parsed_result: {
    context: { lapFilter: filter },
    headline: `${lapFilterLabel(filter)} report remains loaded`, consistency_loss_ms: 400,
    strengths: [], tips: [{ section: 'T1', body: 'Brake once, then release smoothly.', annotations: [] }],
    drills: [], annotations: [],
  },
})
;(window as any).catalyst = {
  getUnits: async () => 'imperial',
  listSessions: async () => [{ session_guid: 'fixture-session', details_loaded: true }, { session_guid: 'another-session', details_loaded: true }],
  getAiSettings: async () => ({ provider: 'anthropic', hasAnthropicApiKey: true }),
  getActiveProfile: async () => 'Test',
  onWorker: (callback: (event: WorkerEvent) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
  getCoachSession: async () => nextReport,
  runCoach: async (opts: { lapFilter: LapFilter }) => {
    nextReport = makeReport(opts.lapFilter, `fresh-${Date.now()}`)
    if (!new URLSearchParams(window.location.search).has('progress')) {
      setTimeout(() => emit({ kind: 'coach', type: 'done', payload: nextReport.id }), 50)
    }
  },
  buildAnalysis: async (_guids: string[], _units: string, filter: LapFilter) => ({
    config: `Fixture · ${lapFilterLabel(filter)}`, totalDistM: 1000,
    sessions: [], laps: [], bestLap: null, theoreticalBestMs: null, avgLapMs: null, avgLapCount: 0,
    garminOptimalMs: null, garminOptimalTimeDeltaTraces: [], excludedLapCount: 0,
    segments: [], corners: [], speedTraces: [], lateralTraces: [], longgTraces: [],
    timeDeltaTraces: [], optimalTimeDeltaTraces: [], cornerBrakingRows: [], cornerRows: [],
    gg: { lat_g: [], long_g: [], speed_mph: [], dist: [], p95_g: 0, circle: { x: [], y: [] } },
    trackMap: { x: [], y: [] }, trackGeometry: null, racingLines: [], heatmap: null,
    coachLine: null, speedUnit: 'mph',
  }),
}
const { Analysis } = await import('../../src/renderer/pages/Analysis')
const { UnitsProvider } = await import('../../src/renderer/units')
function Fixture() {
  const { query } = useNavigation()
  const [selected, setSelected] = useState(new Set(['fixture-session']))
  const [session, setSession] = useState<CoachingSession | null>(null)
  const [cleared, setCleared] = useState(0)
  // App also loads completed reports via props after the Analysis listener.
  useEffect(() => {
    const callback = (event: WorkerEvent) => {
      if (event.type === 'done') setTimeout(() => setSession(nextReport), 0)
    }
    listeners.add(callback)
    return () => { listeners.delete(callback) }
  }, [])
  return <UnitsProvider>
    <div style={{ padding: 12 }}>
      {(['top10', 'top3', 'session-best', 'top3-session'] as LapFilter[]).map(filter => <button key={filter} className="btn" onClick={() => {
        query({ laps: filter }); setSelected(new Set(['fixture-session'])); setSession(makeReport(filter))
      }}>Load {lapFilterLabel(filter)} report</button>)}
      <button className="btn" onClick={() => setSelected(new Set(['another-session']))}>Change sessions</button>
      {new URLSearchParams(window.location.search).has('progress') && <>
        <button className="btn" onClick={() => emit({ kind: 'coach', type: 'progress', progress: { current: 2, total: 3, label: 'Model is thinking · 24s elapsed' } })}>Simulate thinking</button>
        <button className="btn" onClick={() => emit({ kind: 'coach', type: 'progress', progress: { current: 2, total: 3, label: 'Receiving coaching report · 42s elapsed · 1,240 report chars received' } })}>Simulate report stream</button>
        <button className="btn" onClick={() => emit({ kind: 'coach', type: 'done', payload: nextReport?.id })}>Complete report</button>
      </>}
      <p role="status">Report invalidations: {cleared}</p>
    </div>
    <Analysis selected={selected} setSelected={setSelected} onBack={() => {}}
      activeCoachSession={session}
      onClearCoachSession={() => { setSession(null); setCleared(count => count + 1) }} />
  </UnitsProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={createMemoryRouter([
  { path: '*', element: <NavigationProvider><Fixture /></NavigationProvider> },
], { initialEntries: ['/analysis'] })} /></React.StrictMode>)
