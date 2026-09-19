import { useState, useSyncExternalStore } from 'react'
import type { ActivityStore } from '../activityStore'

export function StatusBar({ store, busy, signedIn, tokenDaysRemaining }: {
  store: ActivityStore['statusStore']
  busy: 'sync' | 'load' | 'coach' | null
  signedIn: boolean
  tokenDaysRemaining: number
}) {
  // Hidden status bars do not need to subscribe to background activity.
  return busy ? <ActiveStatusBar store={store} coaching={busy === 'coach'} signedIn={signedIn} tokenDaysRemaining={tokenDaysRemaining} /> : null
}

function ActiveStatusBar({ store, coaching, signedIn, tokenDaysRemaining }: { store: ActivityStore['statusStore']; coaching: boolean; signedIn: boolean; tokenDaysRemaining: number }) {
  const { logLine, logLines, progress } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [logsExpanded, setLogsExpanded] = useState(false)
  return (
    <div
      className="status-bar busy"
      style={{ cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: 0 }}
      onClick={() => setLogsExpanded(e => !e)}
    >
      {/* Collapsed row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', minHeight: 40 }}>
        <div className="spinner" />
        {progress && progress.total > 0 ? (
          <div className="sync-progress" style={{ flex: 1 }}>
            <div className="sync-progress-row">
              {!coaching && <span className="sync-progress-counter">{progress.current}/{progress.total}</span>}
              <span className="sync-progress-log">
                {(progress.label || logLine).replace(/^\[\d+\/\d+\]\s*/, '')}
              </span>
              {progress.fileName && (
                <span className="sync-progress-file">→ {progress.fileName}</span>
              )}
              {!coaching && <span className="sync-progress-pct">
                {Math.round((progress.current / progress.total) * 100)}%
              </span>}
            </div>
            {!coaching && <div className="sync-progress-track">
              <div className="sync-progress-fill" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>}
          </div>
        ) : (
          <div className="log" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {logLine || 'working…'}
          </div>
        )}
        <div className="tag" style={{ flexShrink: 0 }}>
          {signedIn ? `TOKEN · ${tokenDaysRemaining}D` : 'NO TOKEN'}
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-mute)', flexShrink: 0 }}>
          {logsExpanded ? '▼ logs' : '▲ logs'}
        </span>
      </div>

      {/* Expanded log panel */}
      {logsExpanded && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg)',
            maxHeight: 260,
            overflowY: 'auto',
            padding: '8px 16px',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            lineHeight: 1.5,
          }}
        >
          {logLines.length === 0
            ? <span style={{ opacity: 0.4 }}>No log output yet.</span>
            : logLines.map((l, i) => (
                <div key={i} style={{
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  color: l.startsWith('✗') ? 'var(--red)'
                       : l.startsWith('✓') ? 'var(--green)'
                       : l.startsWith('[stderr]') ? 'var(--amber)'
                       : l.startsWith('[harness]') || l.startsWith('[diag]') || l.startsWith('[fallback]') ? 'var(--cyan)'
                       : 'var(--text-mute)',
                }}>{l}</div>
              ))
          }
        </div>
      )}
    </div>
  )
}
