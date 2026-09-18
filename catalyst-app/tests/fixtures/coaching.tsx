// Manual browser regression fixture for saved-report loading. Run with Vite
// rooted at tests/fixtures. All API calls stay in memory; no provider requests.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoachingSession, WorkerEvent } from '../../src/shared/types'
import '../../src/renderer/styles.css'

const listeners = new Set<(event: WorkerEvent) => void>()
let nextReport: CoachingSession
const makeReport = (limit: number | null, id = `report-${limit}`): CoachingSession => ({
  id, created_at: '2026-09-18', session_guids: ['fixture-session'], profile_name: 'Test',
  model_used: 'fixture', title: 'Saved coaching',
  prompt: `# Coaching Brief\n_Generated: fixture_ · _Laps: ${limit ? `Top ${limit} fastest across selected sessions` : 'All'}_`,
  raw_response: '',
  parsed_result: {
    headline: `${limit ? `Top ${limit}` : 'All'} report remains loaded`, consistency_loss_ms: 400,
    strengths: [], tips: [{ section: 'T1', body: 'Brake once, then release smoothly.', annotations: [] }],
    drills: [], annotations: [],
  },
})
;(window as any).catalyst = {
  getUnits: async () => 'imperial',
  getAiSettings: async () => ({ provider: 'anthropic', hasAnthropicApiKey: true }),
  getActiveProfile: async () => 'Test',
  onWorker: (callback: (event: WorkerEvent) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
  getCoachSession: async () => nextReport,
  runCoach: async (opts: { lapLimit: number | null }) => {
    nextReport = makeReport(opts.lapLimit, `fresh-${Date.now()}`)
    setTimeout(() => { for (const callback of listeners) callback({ kind: 'coach', type: 'done', payload: nextReport.id }) }, 50)
  },
  buildAnalysis: async (_guids: string[], _units: string, limit: number | null) => ({
    config: `Fixture · ${limit ?? 'All'} laps`, totalDistM: 1000,
    sessions: [], laps: [], bestLap: null, theoreticalBestMs: null, avgLapMs: null,
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
      {[10, 3, 5, null].map(limit => <button key={limit ?? 'all'} className="btn" onClick={() => {
        setSelected(new Set(['fixture-session'])); setSession(makeReport(limit))
      }}>Load {limit ? `Top ${limit}` : 'All'} report</button>)}
      <button className="btn" onClick={() => setSelected(new Set(['another-session']))}>Change sessions</button>
      <p role="status">Report invalidations: {cleared}</p>
    </div>
    <Analysis selected={selected} setSelected={setSelected} onBack={() => {}}
      activeCoachSession={session}
      onClearCoachSession={() => { setSession(null); setCleared(count => count + 1) }} />
  </UnitsProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)
