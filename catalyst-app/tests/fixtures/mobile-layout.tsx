import React, { useState } from 'react'
import { Sessions } from '../../src/renderer/pages/Sessions'
import { createRoot } from 'react-dom/client'
import { Home } from '../../src/renderer/pages/Home'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import { UnitsProvider } from '../../src/renderer/units'
import '../../src/renderer/styles.css'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { NavigationProvider } from '../../src/renderer/navigation'
const noop = () => {}
function Fixture() {
  const [selected, setSelected] = useState(new Set<string>())
  const params = new URLSearchParams(location.search)
  const sessions = params.has('sessions')
  return <UnitsProvider>
    <div className="app-shell">
      <Sidebar active={sessions ? 'sessions' : 'home'} onChange={noop} connected signedIn
        selectionCount={selected.size} email="test@example.com" onSignIn={noop} />
      <div className="main-pane">
        {sessions ? (
          <Sessions refreshTick={0} selected={selected} setSelected={setSelected}
            onAnalyze={noop} activeAccount={null} onEnsureSessions={async () => {}} />
        ) : (
          <Home auth={null} stats={{ sessionCount: 30, lapCount: 200, trackCount: 3,
            sampleCount: 100000, lastSyncAgoHuman: '2 hours ago' } as any}
            busy={null} signedIn onSync={noop} onRequestSignIn={noop} onSessions={noop} />
        )}
        {params.has('busy') && <div className="status-bar busy" style={{ minHeight: 40 }}>Syncing…</div>}
      </div>
    </div>
  </UnitsProvider>
}
createRoot(document.getElementById('root')!).render(<RouterProvider router={createMemoryRouter([
  { path: '*', element: <NavigationProvider><Fixture /></NavigationProvider> },
], { initialEntries: [location.search.includes('sessions') ? '/sessions' : '/overview'] })} />)
