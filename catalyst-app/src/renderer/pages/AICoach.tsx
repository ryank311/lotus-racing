import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CoachingSession, CoachAnnotation } from '../../shared/types'

interface Props {
  refreshTick: number
  selected: Set<string>
  busy: string | null
  setBusy: (b: 'sync' | 'load' | 'coach' | null) => void
  onLoadSession: (session: CoachingSession) => void
}

export function AICoach({ refreshTick, selected, busy, setBusy, onLoadSession }: Props) {
  const [sessions, setSessions] = useState<CoachingSession[]>([])
  const [current, setCurrent] = useState<CoachingSession | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [runLog, setRunLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  const loadSessions = async () => {
    try {
      const list = await api.listCoachSessions()
      setSessions(list)
    } catch { /* DB might not exist yet */ }
  }

  useEffect(() => { void loadSessions() }, [refreshTick])

  const runCoach = async () => {
    if (busy || selected.size === 0) return
    setRunning(true)
    setBusy('coach')
    setRunLog([])
    setErr(null)

    // Get the active profile from the app settings
    const profile = await api.getActiveProfile() ?? 'Lotus'

    const unsub = api.onWorker(evt => {
      if (evt.kind !== 'coach') return
      if (evt.type === 'log' && evt.payload) {
        setRunLog(prev => [...prev.slice(-200), evt.payload!])
      }
      if (evt.type === 'done') {
        unsub()
        setRunning(false)
        setBusy(null)
        const sessionId = evt.payload
        void loadSessions().then(async () => {
          if (sessionId) {
            const s = await api.getCoachSession(sessionId)
            if (s) setCurrent(s)
          }
        })
      }
      if (evt.type === 'error') {
        unsub()
        setRunning(false)
        setBusy(null)
        setErr(evt.payload ?? 'Unknown error')
      }
    })

    try {
      await api.runCoach({
        profile,
        scope: 'overview',
        sessionGuids: [...selected],
      })
    } catch (e: any) {
      unsub()
      setRunning(false)
      setBusy(null)
      setErr(e.message ?? String(e))
    }
  }

  const deleteSession = async (s: CoachingSession) => {
    if (!confirm(`Delete "${s.title}"?`)) return
    await api.deleteCoachSession(s.id)
    if (current?.id === s.id) setCurrent(null)
    await loadSessions()
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// ai · structured coaching</div>
          <div className="page-title">AI <span className="accent">Coach</span></div>
        </div>
        <div className="page-meta">
          {sessions.length} sessions<br />
          <span className="muted">{selected.size} selected</span>
        </div>
      </header>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="btn-row" style={{ marginTop: 0, marginBottom: 18, alignItems: 'center' }}>
          <button
            className="btn primary"
            disabled={!!busy || selected.size === 0}
            onClick={runCoach}
          >
            {running ? 'Coaching…' : `Ask Coach${selected.size > 0 ? ` (${selected.size} sessions)` : ''}`}
          </button>
          {selected.size === 0 && (
            <span className="muted text-mono" style={{ fontSize: 10, marginLeft: 8 }}>
              Select sessions on the Sessions tab first
            </span>
          )}
          {err && (
            <span style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 11, marginLeft: 12 }}>
              {err}
            </span>
          )}
        </div>

        {/* Live log — always visible while running so hangs are diagnosable */}
        {running && (
          <div style={{
            background: 'var(--bg-elev)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 18,
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mute)',
            maxHeight: 180, overflowY: 'auto',
          }}>
            {runLog.length === 0
              ? <span style={{ opacity: 0.5 }}>Starting…</span>
              : runLog.slice(-60).map((l, i) => (
                  <div key={i} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{l}</div>
                ))
            }
          </div>
        )}

        <div className="split" style={{ flex: 1, minHeight: 400 }}>
          {/* Session list */}
          <div className="list-pane">
            {sessions.length === 0 && (
              <div className="muted text-mono" style={{ padding: '14px 12px', fontSize: 11 }}>
                No coaching sessions yet.
              </div>
            )}
            {sessions.map(s => (
              <div
                key={s.id}
                className={`list-item ${current?.id === s.id ? 'active' : ''}`}
                onClick={() => setCurrent(s)}
              >
                <div className="filename" style={{ lineHeight: 1.3, marginBottom: 3 }}>{s.title}</div>
                <div className="meta">
                  {s.profile_name} · {s.model_used} · {s.created_at.slice(0, 10)}
                </div>
              </div>
            ))}
          </div>

          {/* Session detail */}
          <div className="viewer-pane" style={{ padding: 0 }}>
            {current
              ? <SessionViewer session={current} onLoad={onLoadSession} onDelete={deleteSession} />
              : <div className="muted" style={{ padding: 28, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  Select a coaching session to view it.
                </div>
            }
          </div>
        </div>
      </div>
    </>
  )
}

function SessionViewer({ session, onLoad, onDelete }: {
  session: CoachingSession
  onLoad: (s: CoachingSession) => void
  onDelete: (s: CoachingSession) => void
}) {
  const [showRaw, setShowRaw] = useState(false)
  const r = session.parsed_result

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          {r?.headline && (
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--signal)',
              marginBottom: 6, lineHeight: 1.4,
            }}>
              {r.headline}
            </div>
          )}
          {r?.consistency_loss_ms != null && r.consistency_loss_ms > 0 && (
            <div style={{
              display: 'inline-block',
              background: 'var(--signal-soft)', border: '1px solid var(--signal)',
              borderRadius: 2, padding: '2px 8px',
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--signal)',
              letterSpacing: '0.1em',
            }}>
              +{(r.consistency_loss_ms / 1000).toFixed(3)}s consistency gap
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn primary" style={{ padding: '5px 14px', fontSize: 11 }}
            onClick={() => onLoad(session)}>
            Load in Analysis
          </button>
          <button className="btn ghost" style={{ padding: '5px 10px', fontSize: 11 }}
            onClick={() => onDelete(session)}>
            Delete
          </button>
        </div>
      </div>

      {/* Tips */}
      {r?.tips && r.tips.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="card-label" style={{ marginBottom: 10 }}>Tips</div>
          {r.tips.map((tip, i) => (
            <div key={i} style={{
              background: 'var(--panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 8,
            }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--signal)',
                letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6,
              }}>
                {tip.section}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', marginBottom: 8 }}>
                {tip.body}
              </div>
              {tip.annotations.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {tip.annotations.map((a, j) => (
                    <AnnotationPill key={j} annotation={a} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Drills */}
      {r?.drills && r.drills.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="card-label" style={{ marginBottom: 10 }}>Drills</div>
          <div style={{
            background: 'var(--panel)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '12px 14px',
          }}>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {r.drills.map((d, i) => (
                <li key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)', marginBottom: 4 }}>
                  {d}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {/* Metadata */}
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mute)',
        letterSpacing: '0.1em', marginBottom: 12,
      }}>
        {session.profile_name} · {session.model_used} · {session.session_guids.length} session(s)
        {' · '}{session.created_at.slice(0, 16).replace('T', ' ')}
      </div>

      {/* Raw response */}
      <button
        className="btn ghost"
        style={{ fontSize: 10, padding: '3px 10px', marginBottom: 8 }}
        onClick={() => setShowRaw(v => !v)}
      >
        {showRaw ? 'Hide' : 'Show'} raw response
      </button>
      {showRaw && (
        <pre style={{
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '12px 14px',
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-mute)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
          maxHeight: 400, overflowY: 'auto',
        }}>
          {session.raw_response}
        </pre>
      )}
    </div>
  )
}

function severityColor(s: 1 | 2 | 3 | undefined) {
  if (s === 3) return 'var(--signal)'
  if (s === 2) return 'var(--amber)'
  return 'var(--cyan)'
}

function AnnotationPill({ annotation: a }: { annotation: CoachAnnotation }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'var(--bg-elev)', border: `1px solid ${severityColor(a.severity)}`,
      borderRadius: 2, padding: '2px 7px',
      fontFamily: 'var(--font-mono)', fontSize: 9, color: severityColor(a.severity),
      letterSpacing: '0.1em',
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: severityColor(a.severity),
        display: 'inline-block', flexShrink: 0,
      }} />
      {a.ref} — {a.body.slice(0, 80)}{a.body.length > 80 ? '…' : ''}
    </span>
  )
}
