import { useEffect, useState } from 'react'
import { api } from '../api'

export function CoachProgress() {
  const [label, setLabel] = useState('Preparing coaching analysis…')
  useEffect(() => api.onWorker(event => {
    if (event.kind === 'coach' && event.type === 'progress' && event.progress?.label) {
      setLabel(event.progress.label)
    }
  }), [])
  return <div className="coach-progress" role="status" aria-live="polite" aria-atomic="true">
    <div className="spinner" aria-hidden="true" />
    <div><strong>{label}</strong><span>Coaching will appear when the report is complete. Detailed analysis can take several minutes.</span></div>
  </div>
}
