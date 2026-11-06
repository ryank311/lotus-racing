import React from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { SessionPicker } from '../../src/renderer/components/SessionPicker'
import { NavigationProvider, useRoute } from '../../src/renderer/navigation'
import { routeUrl } from '../../src/renderer/routes'
import type { DbSessionRow } from '../../src/shared/types'
import '../../src/renderer/styles.css'
import '../../src/renderer/replay/replay.css'

const session = (id: string, day: string, ms: number | null, extra: Partial<DbSessionRow> = {}): DbSessionRow => ({
  session_guid: id, session_start: day, track_name: 'Virginia International Raceway',
  track_configuration_name: 'Full Course', track_configuration_id: 72, layout_key: 'full',
  details_loaded: true, best_lap_ms: ms, lap_count: 6, sample_count: 600, weather_description: 'Clear',
  account: 'driver', vehicle_guid: 'lotus', vehicle_make: 'Lotus', vehicle_model: 'Elise', vehicle_year: 2006, vehicle_type: 'car', ...extra,
})
const rows = [
  session('latest', '2026-10-31 14:30:00', 137842, { video_count: 1 }),
  session('full-pb', '2026-10-31 11:15:00', 134265, { video_count: 1 }),
  session('full-older', '2026-10-30 09:20:00', 135917),
  session('full-vette', '2026-10-30 14:20:00', 129406, { vehicle_guid: 'vette', vehicle_make: 'Chevrolet', vehicle_model: 'Corvette' }),
  session('grand-pb', '2026-10-30 16:45:00', 162583, { track_configuration_name: 'Grand West Course', track_configuration_id: 99, layout_key: 'grand' }),
  session('grand-slow', '2026-10-30 10:00:00', 164248, { track_configuration_name: 'Grand West Course', track_configuration_id: 99, layout_key: 'grand', video_count: 1 }),
  session('no-time', '2026-09-20 12:10:00', null, { lap_count: 0, details_loaded: false }),
]
function Fixture() {
  const { id, page, params } = useRoute()
  return <main style={{ maxWidth: 1100, margin: 'auto', padding: 24 }} className={page === 'replay' ? 'replay-page' : 'review-page'}>
    <header className="page-header"><div><div className="page-eyebrow">// {page === 'replay' ? 'lap replay' : 'post-session'}</div><h1 className="page-title">{page === 'replay' ? '3D Replay' : 'Session Review'}</h1></div></header>
    <SessionPicker sessions={rows} selected={id} label={page === 'replay' ? 'Replay session' : 'Review session'}
      sessionUrl={guid => routeUrl(`/${page}/${guid}`, page === 'replay' ? { view: params.get('view') } : {})} />
    <p className="muted">Offline session-picker fixture · no driver data or backend requests.</p>
  </main>
}
const router = createMemoryRouter([{ path: '*', element: <NavigationProvider><Fixture /></NavigationProvider> }], {
  initialEntries: [new URLSearchParams(location.search).has('replay') ? '/replay/latest?view=driver&lap=3' : '/review/latest'],
})
;(window as any).pickerRouter = router
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
