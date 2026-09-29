import { useResource } from '../useResource'
import { InlineLoadStatus, LoadingRows } from '../components/Loading'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { reportAnalysisUrl, segment } from '../routes'
import { api } from '../api'
import { CoachProgress } from '../components/CoachProgress'
import { ReviewCoachContent } from '../components/ReviewCharts'
import type { CoachingResult, CoachingSession, CoachSetupRec, FocusVerdict } from '../../shared/types'
import { replaceSessionIds, sanitizeCoachingResult, type SessionAliasMap } from '../../shared/sessionIdentity'
import { coachingLapFilter, DEFAULT_LAP_FILTER, LAP_FILTERS, lapFilterLabel, type LapFilter } from '../../shared/coachingScope'
import './pages-extras.css'

function fallbackSessionAliases(session: CoachingSession): SessionAliasMap {
  return Object.fromEntries(
    session.session_guids.map((guid, index) => [guid, `Selected session ${index + 1}`]),
  )
}

interface Props {
  refreshTick: number
  selected: Set<string>
  busy: string | null
  setBusy: (b: 'sync' | 'load' | 'coach' | null) => void
}

export function AICoach({ refreshTick, selected, busy, setBusy }: Props) {
  const { id } = useRoute()
  const { go } = useNavigation()
  const history = useResource(() => api.listCoachSessions(), '', refreshTick)
  const sessions = history.data ?? []
  const loadSessions = history.reload
  const [current, setCurrent] = useState<CoachingSession | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [runLog, setRunLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [lapFilter, setLapFilter] = useState<LapFilter>(DEFAULT_LAP_FILTER)
  const [detailLoading, setDetailLoading] = useState(!!id)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [detailError, setDetailError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setCurrent(null); setDetailError(null); setDetailLoading(!!id)
    if (id) void api.getCoachSession(id).then(report => {
      if (cancelled) return
      if (!report) setDetailError('This coaching report is unavailable.')
      else setCurrent(report)
    }).catch(e => { if (!cancelled) setDetailError(String(e)) }).finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [id, refreshTick, detailAttempt])


  const runCoach = async () => {
    if (busy || selected.size === 0) return

    const settings = await api.getAiSettings()
    const provider = settings.provider ?? (settings.model?.startsWith('gpt-') ? 'openai' : 'anthropic')
    const hasKey = provider === 'openai' ? !!settings.hasOpenAiApiKey : !!settings.hasAnthropicApiKey
    if (!hasKey) {
      setErr(`No ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key configured. Add it under AI Coach on the Overview page.`)
      return
    }
    setRunning(true)
    setBusy('coach')
    setRunLog([])
    setErr(null)

    // Empty lets the server resolve the profile linked to the sessions' car.
    const profile = (await api.getActiveProfile()) ?? ''

    const unsub = api.onWorker(evt => {
      if (evt.kind !== 'coach') return
      if (evt.type === 'log' && evt.payload) {
        setRunLog(prev => [...prev.slice(-200), evt.payload!])
      }
      if (evt.type === 'done') {
        unsub()
        setRunning(false)
        setBusy(null)
        // Completion updates the list; only a user action changes routes.
        void loadSessions()
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
        lapFilter,
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
    if (current?.id === s.id) go('/coach', { replace: true })
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
          <InlineLoadStatus label="coaching history" pending={history.pending} error={history.error} hasData={history.data !== undefined} onRetry={loadSessions} />
          {history.data !== undefined && <>{sessions.length} {sessions.length === 1 ? 'report' : 'reports'}<br /></>}
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
          <select className="analysis-lap-select" aria-label="Laps the coach analyses"
            value={lapFilter} disabled={!!busy} onChange={e => setLapFilter(e.target.value as LapFilter)}>
            {LAP_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
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

        {(running || busy === 'coach') && <CoachProgress />}

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

        <div className="split coach-history" style={{ flex: 1, minHeight: 400 }}>
          {/* Session list */}
          <div className="list-pane" aria-busy={history.pending}>
            {history.initialLoading && <LoadingRows />}
            {history.data !== undefined && sessions.length === 0 && (
              <div className="muted text-mono" style={{ padding: '14px 12px', fontSize: 11 }}>
                No coaching sessions yet.
              </div>
            )}
            {sessions.map(s => (
              <NavLink to={`/coach/${segment(s.id)}`}
                key={s.id}
                className={`list-item ${current?.id === s.id ? 'active' : ''}`}
              >
                <div className="filename" style={{ lineHeight: 1.3, marginBottom: 3 }}>
                  {replaceSessionIds(s.title, fallbackSessionAliases(s))}
                </div>
                <div className="meta">
                  {s.profile_name} · {s.model_used} · {s.created_at.slice(0, 10)}
                </div>
              </NavLink>
            ))}
          </div>

          {/* Session detail */}
          <div className="viewer-pane" style={{ padding: 0 }}>
            {detailLoading ? <div data-route-loading><InlineLoadStatus pending label="report" /><LoadingRows count={3} /></div> : detailError ? <div role="alert">{detailError} <button className="btn ghost" onClick={() => setDetailAttempt(n => n + 1)}>Retry report</button> <NavLink to="/coach">All reports</NavLink></div> : current
              ? <SessionViewer session={current} onDelete={deleteSession} />
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

function SessionViewer({ session, onDelete }: {
  session: CoachingSession
  onDelete: (s: CoachingSession) => void
}) {
  const [showRaw, setShowRaw] = useState(false)
  const aliases = useMemo(() => fallbackSessionAliases(session), [session])
  const r = useMemo(
    () => session.parsed_result ? sanitizeCoachingResult(session.parsed_result, aliases) : null,
    [session.parsed_result, aliases],
  )
  const safeRawResponse = useMemo(
    () => replaceSessionIds(session.raw_response, aliases),
    [session.raw_response, aliases],
  )

  if (session.review_context) return <div className="coach-session-viewer review-page" style={{ overflowY: 'auto', padding: 24 }}>
    <div className="review-section-heading"><h2>Session Review coaching</h2><NavLink className="btn primary" to={reportAnalysisUrl(session)}>Open session review</NavLink></div>
    <p className="muted">{session.created_at} · {session.model_used} · {session.review_context.units} units. This report preserves the measurements used when it was generated.</p>
    {session.review_result ? <ReviewCoachContent result={session.review_result} evidence={session.review_context.evidence} /> : <p role="alert">{session.review_context.error ?? 'Report unavailable'}</p>}
    <details><summary>Saved prompt and response</summary><pre className="review-raw">{session.prompt}{'\n\n'}{safeRawResponse}</pre></details>
    <button className="btn ghost" onClick={() => onDelete(session)}>Delete report</button>
  </div>

  return (
    <div className="coach-session-viewer" style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
      {/* Header */}
      <div className="coach-session-header" style={{ marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
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
          <NavLink className="btn primary" style={{ padding: '5px 14px', fontSize: 11 }} to={reportAnalysisUrl(session)}>
            Load in Analysis
          </NavLink>
          <button className="btn ghost" style={{ padding: '5px 10px', fontSize: 11 }}
            onClick={() => onDelete(session)}>
            Delete
          </button>
        </div>
      </div>

      {r?.version === 2 && <LastFocusReview result={r} />}

      {r?.strengths && r.strengths.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 className="coach-section-title">Keep doing</h3>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
            {r.strengths.map((item, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55 }}>✓ {item}</div>)}
          </div>
        </div>
      )}

      {r?.version === 2 && <FocusTips result={r} />}

      {/* Tips */}
      {r?.version !== 2 && r?.tips && r.tips.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 className="coach-section-title">Tips</h3>
          {r.tips.map((tip, i) => (
            <div key={i} style={{
              background: 'var(--panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 8,
            }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--signal)',
                letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6,
              }}>
                {tip.section}{tip.priority ? ` · P${tip.priority}` : ''}{tip.estimated_gain_ms != null ? ` · ~${(tip.estimated_gain_ms / 1000).toFixed(2)}s` : ''}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)' }}>
                {tip.body}
              </div>
            </div>
          ))}
        </div>
      )}

      {r && (r.version === 2 || (r.setup?.length ?? 0) > 0) && <SetupRecommendations setup={r.setup ?? []} />}

      {r?.next_session_plan && r.next_session_plan.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 className="coach-section-title">Next session plan</h3>
          {r.next_session_plan.map((step, i) => (
            <div key={i} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px', marginBottom: 7 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--cyan)' }}>{step.run}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5, marginTop: 4 }}>{step.focus}</div>
              <div style={{ fontSize: 10, color: 'var(--text-mute)', marginTop: 5 }}>Verify: {step.success_metric}</div>
            </div>
          ))}
        </div>
      )}

      {/* Drills */}
      {r?.drills && r.drills.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 className="coach-section-title">Drills</h3>
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
        {' · '}{lapFilterLabel(coachingLapFilter(session))}
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
          {safeRawResponse}
        </pre>
      )}
    </div>
  )
}

const CONFIDENCE_LABEL = { 1: 'low', 2: 'medium', 3: 'high' } as const
const VERDICT_LABEL: Record<FocusVerdict, string> = {
  met: 'Met', improved: 'Improved', no_change: 'No change', worse: 'Worse', not_measured: 'Not measured',
}

function verdictTone(verdict: string): string {
  if (verdict === 'met' || verdict === 'improved') return 'good'
  if (verdict === 'worse') return 'bad'
  return ''
}

function Evidence({ items }: { items?: string[] }) {
  const lines = (items ?? []).filter(Boolean)
  if (!lines.length) return null
  return (
    <details className="coach-evidence">
      <summary>Evidence ({lines.length})</summary>
      <ul>{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </details>
  )
}

// Measured results for the focus set by the previous report on this layout.
function LastFocusReview({ result }: { result: CoachingResult }) {
  const reviews = result.previous_focus_review ?? []
  if (!reviews.length) return null
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 className="coach-section-title">Last focus</h3>
      {reviews.map(review => {
        const m = review.measured
        const verdict = m?.verdict ?? review.verdict
        return (
          <div key={review.focusId} className="coach-card">
            <div className="coach-review-head">
              <span className={`coach-verdict ${verdictTone(verdict)}`}>
                {VERDICT_LABEL[verdict as FocusVerdict] ?? verdict.replace(/_/g, ' ')}
              </span>
              {m && <span className="coach-card-kicker">{m.complexName} · {m.metricLabel}</span>}
            </div>
            {m?.cue && <div className="coach-cue">{m.cue}</div>}
            {m && (
              <div className="coach-metric">
                {m.display.baseline} → {m.display.current} <span className="muted">(target {m.display.target})</span>
                {m.laps > 0 && <span className="muted"> · {m.laps} {m.laps === 1 ? 'lap' : 'laps'}</span>}
              </div>
            )}
            {review.comment && <div className="coach-body" style={{ marginTop: 6 }}>{review.comment}</div>}
          </div>
        )
      })}
    </div>
  )
}

// Version 2 tips mirror the focus items one to one, with the measured target.
function FocusTips({ result }: { result: CoachingResult }) {
  if (!result.tips.length) return null
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 className="coach-section-title">Focus</h3>
      {result.tips.map((tip, i) => {
        const focus = result.focus?.[i]
        const meta = [
          tip.estimated_gain_ms != null && tip.estimated_gain_ms > 0 ? `~${(tip.estimated_gain_ms / 1000).toFixed(2)} s available` : null,
          tip.confidence ? `${CONFIDENCE_LABEL[tip.confidence]} confidence` : focus ? `${focus.confidence} confidence` : null,
        ].filter(Boolean)
        return (
          <div key={i} className="coach-card">
            <div className="coach-card-kicker">{tip.section}{tip.priority ? ` · P${tip.priority}` : ''}</div>
            {tip.cue && <div className="coach-cue">“{tip.cue}”</div>}
            <div className="coach-body">{tip.body}</div>
            {tip.success_metric && <div className="coach-metric">Success: {tip.success_metric}</div>}
            {meta.length > 0 && <div className="coach-meta">{meta.join(' · ')}</div>}
            <Evidence items={tip.evidence} />
          </div>
        )
      })}
    </div>
  )
}

function SetupRecommendations({ setup }: { setup: CoachSetupRec[] }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 className="coach-section-title">Car setup</h3>
      {setup.length === 0 && <div className="coach-card coach-body">No setup change recommended.</div>}
      {setup.map((rec, i) => (
        <div key={i} className="coach-card">
          <div className="coach-card-kicker">{rec.area}</div>
          <div className="coach-cue">{rec.change}</div>
          {rec.rationale && <div className="coach-body">{rec.rationale}</div>}
          {rec.confidence && <div className="coach-meta">{CONFIDENCE_LABEL[rec.confidence]} confidence</div>}
          <Evidence items={rec.evidence} />
        </div>
      ))}
    </div>
  )
}
