import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UnitsProvider } from './units'
import { ServerGate } from './components/ServerGate'
import './styles.css'
import { createBrowserRouter, createHashRouter, RouterProvider } from 'react-router-dom'
import { NavigationProvider } from './navigation'

// Transient dialogs must not reopen after refresh.
if (history.state?.usr?.overlay) history.replaceState({ ...history.state, usr: { ...history.state.usr, overlay: undefined } }, '')
const router = (location.protocol === 'file:' ? createHashRouter : createBrowserRouter)([
  { path: '*', Component: RoutedApplication, errorElement: <RouteFailure /> },
])

function RoutedApplication() {
  return <NavigationProvider><ServerGate><UnitsProvider><App /></UnitsProvider></ServerGate></NavigationProvider>
}

function RouteFailure() {
  return <main className="server-login-page"><div className="server-login-card">
    <h1>Unable to load this page</h1><p>Reload to recover your current view.</p>
    <button className="btn primary" onClick={() => location.reload()}>Reload page</button>
  </div></main>
}

// Surface async errors that React's error boundaries can't catch
// (promise rejections, setTimeout throws, IPC errors with no .catch).
// Without these the app silently dies; with them we get a console trail
// and the user can choose to reload.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
})
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.error ?? e.message)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="app root">
      <RouterProvider router={router} />
    </ErrorBoundary>
  </React.StrictMode>,
)
