import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

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
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
