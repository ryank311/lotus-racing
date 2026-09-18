import React, { Profiler, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { App } from '../../src/renderer/App'
import { NavigationProvider, useRoute } from '../../src/renderer/navigation'
import { UnitsProvider } from '../../src/renderer/units'
import '../../src/renderer/styles.css'

const test = window as any
function DelayedPage() {
  const [ready, setReady] = useState(!test.delayContent)
  useEffect(() => { test.releaseContent = () => setReady(true) }, [])
  return <><h1 className="page-title">Scroll test</h1>
    <div className="page-body">
      {!ready ? <div data-route-loading>Loading…</div> : <div style={{ height: 3000 }}>
        <button id="focus-target">Remember focus</button>
      </div>}
    </div></>
}
function NavigationFixture() {
  const { location } = useRoute()
  return <main className="main-pane" style={{ height: 450 }}><DelayedPage key={location.key} /></main>
}
const navigationOnly = new URLSearchParams(window.location.search).has('navigation')
const router = createMemoryRouter([{
  path: '*',
  element: <NavigationProvider><UnitsProvider><Profiler id="app" onRender={() => test.commits++}>
    {navigationOnly ? <NavigationFixture /> : <App />}
  </Profiler></UnitsProvider></NavigationProvider>,
}], { initialEntries: [{ pathname: '/overview', key: navigationOnly ? 'navigation-test' : 'app-test' }] })
test.router = router
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
