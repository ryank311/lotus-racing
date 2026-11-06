// "Compare against other drivers" — pick another driver, then their sessions
// on your layout, in a list modelled on the Sessions page. Applying writes
// the choice to the Analysis URL (`compare=<driver>:<session>`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { startLabel } from './reviewTimeline'
import { driverColor } from './chartSeries'
import { useUnits } from '../units'
import { compareParams, driverKey, MAX_COMPARE_DRIVERS, MAX_COMPARE_SESSIONS, parseCompareParams, type ComparisonRequest, type DriverAccount } from '../../shared/comparison'
import type { DbSessionRow } from '../../shared/types'
import { sameCourse, trackLayoutKey } from '../../shared/trackLayout'
import { sessionCourse } from './sessionPickerData'
import './compare.css'

type SortKey = 'date' | 'best'

interface SessionsState { rows?: DbSessionRow[]; error?: string }

function vehicleLabel(r: DbSessionRow): string {
  const title = (s: string | null) => (s ?? '').trim().toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase())
  return [title(r.vehicle_make), title(r.vehicle_model)].filter(Boolean).join(' ')
}

function trackLabel(r: Pick<DbSessionRow, 'track_name' | 'track_configuration_name'>): string {
  return [r.track_name, r.track_configuration_name].map(s => (s ?? '').trim()).filter(Boolean).join(' · ') || 'Unknown layout'
}

const courseOf = sessionCourse

// The URL sorts compare values, which fixes each driver's colour. Order the
// draft the same way so the picker shows the colours the charts will use.
function canonical(requests: ComparisonRequest[]): ComparisonRequest[] {
  return parseCompareParams(compareParams(requests.filter(r => r.sessionGuids.length)).sort())
}

export function ComparePicker({ ownRows, ownGuids, value, lapFilterLabel, onApply, onClose }: {
  // Your selected sessions (layout, car and best lap for context).
  ownRows: DbSessionRow[]
  ownGuids: Set<string>
  value: ComparisonRequest[]
  lapFilterLabel: string
  onApply: (next: ComparisonRequest[]) => void
  onClose: () => void
}) {
  const { tempFromC, tempUnit } = useUnits()
  const [drivers, setDrivers] = useState<DriverAccount[] | null>(null)
  const [driversError, setDriversError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ComparisonRequest[]>(() => value.map(r => ({ ...r, sessionGuids: [...r.sessionGuids] })))
  const [active, setActive] = useState<string | null>(value[0]?.driver ?? null)
  const [sessions, setSessions] = useState<Record<string, SessionsState>>({})
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('date')
  const [allLayouts, setAllLayouts] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Unidentifiable (no course ID, mean line or full name): show everything.
  const ownCourse = useMemo(() => {
    const course = ownRows[0] ? courseOf(ownRows[0]) : null
    return course && trackLayoutKey(course) ? course : null
  }, [ownRows])
  const onOwnCourse = useCallback((r: DbSessionRow) => !ownCourse || sameCourse(ownCourse, courseOf(r)), [ownCourse])
  const ownTrack = ownRows[0] ? trackLabel(ownRows[0]) : 'your layout'
  const ownBest = useMemo(() => {
    const times = ownRows.map(r => r.best_lap_ms).filter((ms): ms is number => ms != null && ms > 0)
    return times.length ? Math.min(...times) : null
  }, [ownRows])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setDriversError(null)
    api.listDrivers().then(list => {
      if (cancelled) return
      setDrivers(list)
      setActive(current => current ?? list.find(d => d.hasTelemetry)?.username ?? list[0]?.username ?? null)
    }, error => { if (!cancelled) setDriversError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [attempt])

  // Each driver's sessions load once per picker opening.
  useEffect(() => {
    if (!active || sessions[driverKey(active)]?.rows) return
    let cancelled = false
    const key = driverKey(active)
    setSessions(s => ({ ...s, [key]: {} }))
    api.listDriverSessions(active).then(
      rows => { if (!cancelled) setSessions(s => ({ ...s, [key]: { rows } })) },
      error => { if (!cancelled) setSessions(s => ({ ...s, [key]: { error: error instanceof Error ? error.message : String(error) } })) },
    )
    return () => { cancelled = true }
  }, [active, attempt])  // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = canonical(draft)
  const colorOf = (name: string) => {
    const i = ordered.findIndex(r => driverKey(r.driver) === driverKey(name))
    return i < 0 ? null : driverColor(i + 1)
  }
  const picked = (name: string) => draft.find(r => driverKey(r.driver) === driverKey(name))?.sessionGuids ?? []
  const totalPicked = ordered.reduce((n, r) => n + r.sessionGuids.length, 0)
  const driversFull = ordered.length >= MAX_COMPARE_DRIVERS

  const state = active ? sessions[driverKey(active)] : undefined
  const rows = state?.rows ?? []
  const activePicks = active ? picked(active) : []
  const activeVehicle = rows.find(r => activePicks.includes(r.session_guid))?.vehicle_guid ?? null

  // Why a session cannot be compared, if it cannot.
  const blocked = (r: DbSessionRow): string | null => {
    if (ownGuids.has(r.session_guid)) return 'Already in your analysis'
    const elsewhere = draft.find(x => driverKey(x.driver) !== driverKey(active!) && x.sessionGuids.includes(r.session_guid))
    if (elsewhere) return `Picked for ${elsewhere.driver}`
    if (!onOwnCourse(r)) return 'Different layout'
    if (!r.details_loaded) return 'Telemetry not downloaded'
    if (!activePicks.includes(r.session_guid)) {
      if (activeVehicle && r.vehicle_guid && r.vehicle_guid !== activeVehicle) return 'One car per driver'
      if (activePicks.length >= MAX_COMPARE_SESSIONS) return `Up to ${MAX_COMPARE_SESSIONS} sessions`
      if (!activePicks.length && driversFull) return `Up to ${MAX_COMPARE_DRIVERS} drivers`
    }
    return null
  }

  const sameLayoutCount = rows.filter(onOwnCourse).length
  const visible = useMemo(() => {
    let out = rows
    if (!allLayouts) out = out.filter(onOwnCourse)
    const q = query.trim().toLowerCase()
    if (q) out = out.filter(r => [trackLabel(r), vehicleLabel(r), r.session_start ?? '', startLabel(r.session_start), r.weather_description ?? '']
      .some(text => text.toLowerCase().includes(q)))
    const time = (r: DbSessionRow) => (r.best_lap_ms && r.best_lap_ms > 0 ? r.best_lap_ms : Infinity)
    return [...out].sort(sort === 'best'
      ? (a, b) => time(a) - time(b)
      : (a, b) => (b.session_start ?? '').localeCompare(a.session_start ?? ''))
  }, [rows, onOwnCourse, allLayouts, query, sort])

  const toggle = (r: DbSessionRow) => {
    if (!active || (blocked(r) && !activePicks.includes(r.session_guid))) return
    setDraft(current => {
      const others = current.filter(x => driverKey(x.driver) !== driverKey(active))
      const mine = current.find(x => driverKey(x.driver) === driverKey(active))?.sessionGuids ?? []
      const next = mine.includes(r.session_guid) ? mine.filter(g => g !== r.session_guid) : [...mine, r.session_guid]
      return next.length ? [...others, { driver: active, sessionGuids: next }] : others
    })
  }

  const removeDriver = (name: string) => setDraft(current => current.filter(x => driverKey(x.driver) !== driverKey(name)))
  const thisYear = String(new Date().getFullYear())

  return (
    <div className="modal-overlay compare-overlay" onClick={onClose}>
      <div className="compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-title" tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="card-corner-marks" aria-hidden="true"><i /></div>
        <header className="compare-head">
          <div>
            <div className="modal-eyebrow">// compare</div>
            <h2 id="compare-title" className="modal-title">Compare against other drivers</h2>
            <p className="compare-sub">Their sessions on <strong>{ownTrack}</strong>, overlaid on your charts and map. Their laps use your lap filter ({lapFilterLabel}).</p>
          </div>
          <button type="button" className="compare-close" aria-label="Close" onClick={onClose}>×</button>
        </header>

        <div className="compare-main">
          <nav className="compare-drivers" aria-label="Drivers">
            <div className="compare-label">Drivers</div>
            {driversError && <div className="compare-empty" role="alert">{driversError} <button type="button" className="compare-link" onClick={() => setAttempt(a => a + 1)}>Retry</button></div>}
            {!drivers && !driversError && <div className="compare-empty">Loading drivers…</div>}
            {drivers?.length === 0 && (
              <div className="compare-empty">No other drivers on this server yet. A driver appears here once they sign in with their own name and sync telemetry.</div>
            )}
            {drivers?.map(d => {
              const count = picked(d.username).length
              const color = colorOf(d.username)
              return (
                <button key={d.username} type="button" disabled={!d.hasTelemetry}
                  className={`compare-driver${active && driverKey(active) === driverKey(d.username) ? ' is-active' : ''}`}
                  aria-current={active && driverKey(active) === driverKey(d.username) ? 'true' : undefined}
                  onClick={() => { setActive(d.username); setQuery('') }}>
                  <i className="driver-dot" style={{ background: color ?? 'transparent', borderColor: color ?? 'var(--border-strong)' }} />
                  <span>
                    <strong>{d.username}</strong>
                    <small>{d.hasTelemetry ? count ? `${count} selected` : 'Choose sessions' : 'No telemetry yet'}</small>
                  </span>
                </button>
              )
            })}
          </nav>

          <section className="compare-sessions" aria-label={active ? `${active}'s sessions` : 'Sessions'}>
            {active && <>
              <div className="compare-toolbar">
                <div className="compare-search">
                  <input type="search" aria-label={`Filter ${active}'s sessions`} placeholder="Search date, car or conditions…"
                    value={query} onChange={e => setQuery(e.target.value)} />
                </div>
                <div className="compare-filters">
                  <select aria-label="Sort sessions" value={sort} onChange={e => setSort(e.target.value as SortKey)}>
                    <option value="date">Newest first</option>
                    <option value="best">Fastest lap first</option>
                  </select>
                </div>
              </div>
              <div className="compare-results">
                <span>{state?.rows ? `${sameLayoutCount} of ${rows.length} on this layout` : state?.error ? 'Sessions unavailable' : 'Loading sessions…'}</span>
                {ownCourse && rows.length > sameLayoutCount && (
                  <button type="button" className="compare-link" onClick={() => setAllLayouts(v => !v)}>
                    {allLayouts ? 'Hide other layouts' : `Show ${rows.length - sameLayoutCount} on other layouts`}
                  </button>
                )}
              </div>
              {state?.error && <div className="compare-empty" role="alert">{state.error} <button type="button" className="compare-link" onClick={() => {
                setSessions(s => { const next = { ...s }; delete next[driverKey(active)]; return next }); setAttempt(a => a + 1)
              }}>Retry</button></div>}
              <div className="compare-list" aria-busy={!state?.rows && !state?.error}>
                {state?.rows && !visible.length && (
                  <p className="compare-empty">{rows.length ? (sameLayoutCount ? 'No sessions match your search.' : `${active} has no sessions on ${ownTrack}.`) : `${active} has no sessions yet.`}</p>
                )}
                {visible.map(r => {
                  const on = activePicks.includes(r.session_guid)
                  const reason = blocked(r)
                  const gapMs = ownBest != null && r.best_lap_ms && r.best_lap_ms > 0 ? r.best_lap_ms - ownBest : null
                  return (
                    <label key={r.session_guid} className={`compare-session${on ? ' is-selected' : ''}${reason && !on ? ' is-blocked' : ''}`}
                      style={on ? { ['--driver' as string]: colorOf(active) ?? 'var(--signal)' } : undefined}>
                      <input type="checkbox" checked={on} disabled={!!reason && !on} onChange={() => toggle(r)}
                        aria-label={`Compare ${active}'s session ${startLabel(r.session_start)}`} />
                      <span className="compare-session-main">
                        <strong>{startLabel(r.session_start, !r.session_start?.startsWith(thisYear))}</strong>
                        <small>{[allLayouts || !ownCourse ? trackLabel(r) : r.track_configuration_name || null, vehicleLabel(r) || null].filter(Boolean).join(' · ')}</small>
                      </span>
                      <span className="compare-session-time">
                        <strong>{msToLap(r.best_lap_ms)}</strong>
                        {gapMs != null && <small className={gapMs < 0 ? 'is-ahead' : 'is-behind'}>
                          {Math.abs(gapMs) < 1 ? 'same as your best' : `${(Math.abs(gapMs) / 1000).toFixed(2)} s ${gapMs < 0 ? 'faster' : 'slower'} than you`}
                        </small>}
                      </span>
                      <span className="compare-session-meta">
                        {[r.lap_count ? `${r.lap_count} ${r.lap_count === 1 ? 'lap' : 'laps'}` : 'No laps', r.weather_description || null,
                          r.temperature_c == null ? null : `${Math.round(tempFromC(r.temperature_c))}${tempUnit}`].filter(Boolean).join(' · ')}
                        {reason && !on && <em>{reason}</em>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </>}
          </section>
        </div>

        <footer className="compare-foot">
          <div className="compare-picked">
            {ordered.length === 0
              ? <span className="muted small">Pick sessions from one or more drivers.</span>
              : ordered.map(r => (
                <span key={r.driver} className="chip compare-chip" style={{ borderColor: colorOf(r.driver)!, color: colorOf(r.driver)! }}>
                  {r.driver} · {r.sessionGuids.length} session{r.sessionGuids.length === 1 ? '' : 's'}
                  <button type="button" className="x" aria-label={`Remove ${r.driver}`} onClick={() => removeDriver(r.driver)}>×</button>
                </span>
              ))}
          </div>
          <div className="compare-actions">
            {value.length > 0 && <button type="button" className="btn ghost" onClick={() => onApply([])}>Stop comparing</button>}
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={!ordered.length} onClick={() => onApply(ordered)}>
              {ordered.length ? `Compare ${totalPicked} session${totalPicked === 1 ? '' : 's'}` : 'Compare'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
