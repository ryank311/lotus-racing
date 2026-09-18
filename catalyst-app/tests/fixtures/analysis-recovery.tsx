import React from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { Analysis } from '../../src/renderer/pages/Analysis'
import { NavigationProvider } from '../../src/renderer/navigation'
import { UnitsProvider } from '../../src/renderer/units'
import '../../src/renderer/styles.css'

const selected = new Set(['test'])
const noop = () => {}
const router = createMemoryRouter([{
  path: '*',
  element: <NavigationProvider><UnitsProvider>
    <div className="app-shell"><main className="main-pane">
      <Analysis selected={selected} setSelected={noop} onBack={noop} />
    </main></div>
  </UnitsProvider></NavigationProvider>,
}], { initialEntries: ['/analysis?session=test&view=map'] })
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
