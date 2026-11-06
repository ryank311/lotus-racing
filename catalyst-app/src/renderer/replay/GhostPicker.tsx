// The ghost lap chooser: the session picker's look, compact. A one-line
// trigger (the same height as the lap select) opens a dropdown anchored
// under it (a bottom sheet on phones) with two lists:
//
// - My laps: this session's other laps, then the fastest laps of other
//   sessions, each with its gap to the lap being watched.
// - Another driver: a driver on this server (with telemetry, not you), then
//   one of their sessions on this course (the session library's rows,
//   compact), then one of its laps (their best first in view). Their lap is
//   raced in their own car (Replay.tsx), read through the server like
//   Analysis's driver comparison.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api, msToLap } from '../api'
import { useOverlay } from '../navigation'
import { SessionRow } from '../components/SessionPicker'
import { newestSessionFirst, sessionBenchmarks, sessionCar, sessionCourse, validLapTime } from '../components/sessionPickerData'
import { startLabel } from '../components/reviewTimeline'
import { driverGhostParam, type ReplayDriverLapRef, type ReplayLapInfo } from '../../shared/replay'
import { driverKey, type DriverAccount } from '../../shared/comparison'
import { sameCourse, type TrackLayoutIdentity } from '../../shared/trackLayout'
import type { DbSessionRow } from '../../shared/types'
import '../components/sessionPicker.css'
import './ghostPicker.css'

export interface GhostGroup { group: string; laps: ReplayLapInfo[] }

/** Another driver's lap as the ghost: from the URL, with what is known once it loads. */
export interface RivalChoice extends ReplayDriverLapRef {
  /** Their lap's label ("Oct 30 10:00 · L3") and time, once loaded. */
  label: string | null
  durationMs: number
  /** Their car, "Chevrolet Corvette". */
  car: string | null
  /** Why it could not be loaded. */
  error: string | null
}

/** The course the ghost must be on (the scene's), for matching another driver's sessions. */
export interface GhostCourse { identity: TrackLayoutIdentity; label: string }

const valueOf = (lap: ReplayLapInfo) => `${lap.sessionGuid}:${lap.lap}`
const lapName = (lap: Pick<ReplayLapInfo, 'lap'>) => (lap.lap === 'optimal' ? '◆ Optimal' : `L${(lap.lap as number) + 1}`)
// Other sessions' labels read "Oct 30 10:34 · L3": the date part.
const dateOf = (lap: Pick<ReplayLapInfo, 'label'>) => lap.label.split(' · ').slice(0, -1).join(' · ') || lap.label
const rivalTitle = (r: RivalChoice) => `${r.driver} · ${r.label ? `${dateOf({ label: r.label })} · ` : ''}L${r.lap + 1}`

/** The ghost's time against the lap being watched: negative, the ghost is faster. */
function Gap({ ghost, current }: { ghost: { durationMs: number }; current: ReplayLapInfo | null }) {
  if (!current || !ghost.durationMs || !current.durationMs) return null
  const s = (ghost.durationMs - current.durationMs) / 1000
  const text = Math.abs(s) < 0.0005 ? '±0.000' : `${s < 0 ? '−' : '+'}${Math.abs(s).toFixed(3)}`
  return <span className={`ghost-gap ${s < 0 ? 'faster' : 'slower'}`} title={s < 0 ? 'Faster than this lap' : 'Slower than this lap'}>{text}</span>
}

export function GhostPicker({ groups, ghost, rival, current, sessionGuid, course, onSelect, disabled = false }: {
  groups: GhostGroup[]
  ghost: ReplayLapInfo | null
  /** Another driver's lap, when that is the ghost. */
  rival: RivalChoice | null
  /** The lap being watched (for the gaps). */
  current: ReplayLapInfo | null
  /** The replayed session: its laps show without their date. */
  sessionGuid: string | null
  course: GhostCourse | null
  /** 'none', "<session>:<lap>", or "driver:<name>:<session>:<lap>". */
  onSelect: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useOverlay('ghost-picker')
  const trigger = useRef<HTMLButtonElement>(null)
  // Another driver's lists load once per page (they rarely change while you watch).
  const cache = useRef(new Map<string, Promise<unknown>>())
  const id = useId()
  const own = ghost?.sessionGuid === sessionGuid
  const title = rival ? rivalTitle(rival) : !ghost ? 'No ghost' : own ? `${lapName(ghost)}` : `${dateOf(ghost)} · ${lapName(ghost)}`
  const chosen = rival ? driverGhostParam(rival) : ghost ? valueOf(ghost) : 'none'
  return <div className="ghost-picker">
    <span className="ghost-picker-label">Ghost</span>
    <button ref={trigger} type="button" className={`ghost-picker-trigger${ghost || rival ? '' : ' none'}${rival ? ' rival' : ''}${rival?.error ? ' failed' : ''}`}
      aria-label={`Ghost: ${title}${rival?.car ? `, ${rival.car}` : ''}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      title={rival?.error ?? undefined}
      onClick={() => setOpen(true)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}>
      <i className="ghost-swatch" aria-hidden="true" />
      <span className="ghost-picker-title">{title}{rival?.car && <small> · {rival.car}</small>}</span>
      {rival?.error && <span className="ghost-picker-warn" aria-hidden="true">!</span>}
      {!rival && ghost && ghost.durationMs > 0 && <span className="ghost-picker-time">{msToLap(ghost.durationMs)}</span>}
      {rival && rival.durationMs > 0 && <span className="ghost-picker-time">{msToLap(rival.durationMs)}</span>}
      {!rival && ghost && <Gap ghost={ghost} current={current} />}
      {rival && <Gap ghost={rival} current={current} />}
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
    </button>
    {open && createPortal(<GhostList id={id} groups={groups} chosen={chosen} rival={rival} current={current} sessionGuid={sessionGuid} course={course}
      anchor={trigger} cache={cache.current}
      // Choosing replaces the history entry the list opened on (as the
      // session picker does), which closes it; stepping back first would race.
      onClose={() => setOpen(false)} onSelect={value => (value === chosen ? setOpen(false) : onSelect(value))}
      restoreFocus={() => trigger.current?.focus({ preventScroll: true })} />, document.body)}
  </div>
}

type Mode = 'mine' | 'driver'

function GhostList({ id, groups, chosen, rival, current, sessionGuid, course, anchor, cache, onClose, onSelect, restoreFocus }: {
  id: string; groups: GhostGroup[]; chosen: string; rival: RivalChoice | null; current: ReplayLapInfo | null; sessionGuid: string | null
  course: GhostCourse | null; anchor: { current: HTMLElement | null }; cache: Map<string, Promise<unknown>>
  onClose: () => void; onSelect: (value: string) => void; restoreFocus: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const [mode, setMode] = useState<Mode>(rival ? 'driver' : 'mine')

  // Anchored under the trigger on wide screens (above it when there is more room there).
  useLayoutEffect(() => {
    const fit = () => {
      const el = anchor.current
      if (!el || !window.matchMedia('(min-width: 641px)').matches) { setPlace(null); return }
      const r = el.getBoundingClientRect(), gap = 6, margin = 12
      const width = Math.min(Math.max(r.width, 420), window.innerWidth - 2 * margin)
      const left = Math.min(Math.max(margin, r.left), window.innerWidth - width - margin)
      const below = window.innerHeight - r.bottom - gap - margin, above = r.top - gap - margin
      const down = below >= 360 || below >= above
      const maxHeight = Math.min(520, down ? below : above)
      setPlace({ top: down ? r.bottom + gap : r.top - gap - maxHeight, left, width, maxHeight })
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => { window.removeEventListener('resize', fit); window.removeEventListener('scroll', fit, true) }
  }, [anchor])

  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    return () => { node.close(); restoreFocus() }
  }, [])

  const rowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.ghost-row:not(:disabled), .session-browser-row:not(:disabled)')]
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next]?.focus()
  }

  const row = (value: string, content: ReactNode, right: ReactNode, extra = '') =>
    <li key={value}><button type="button" className={`ghost-row${value === chosen ? ' is-current' : ''}${extra}`} aria-current={value === chosen ? 'true' : undefined}
      onClick={() => onSelect(value)}>
      <span className="ghost-row-marker" aria-hidden="true">{value === chosen ? '✓' : ''}</span>
      {content}
      {right}
    </button></li>

  return <dialog ref={dialog} id={id} className={`ghost-list${place ? ' anchored' : ''}`} aria-label="Choose a ghost lap"
    style={place ? { top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight } : undefined}
    onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
    <div className={`ghost-list-shell mode-${mode}`}>
      <header className="ghost-list-head">
        <span>Ghost lap</span>
        {current && current.durationMs > 0 && <small>vs {lapName(current)} · {msToLap(current.durationMs)}</small>}
        <button type="button" className="ghost-list-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="ghost-list-modes" role="tablist" aria-label="Whose laps">
        <button type="button" role="tab" aria-selected={mode === 'mine'} onClick={() => setMode('mine')}>My laps</button>
        <button type="button" role="tab" aria-selected={mode === 'driver'} onClick={() => setMode('driver')}><i className="ghost-swatch rival" aria-hidden="true" />Another driver</button>
      </div>
      <div className="ghost-list-body" ref={body} onKeyDown={rowKeys}>
        {mode === 'mine' ? <MyLaps groups={groups} chosen={chosen} current={current} sessionGuid={sessionGuid} row={row} />
          : <DriverLaps rival={rival} chosen={chosen} current={current} course={course} cache={cache} row={row} />}
      </div>
    </div>
  </dialog>
}

type RowFn = (value: string, content: ReactNode, right: ReactNode, extra?: string) => ReactNode

function useFocusOnShow(key: string) {
  // The chosen row (else the marked one, else the first) takes focus when a list appears.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target = el.querySelector<HTMLButtonElement>('[aria-current="true"]:not(:disabled)') ?? el.querySelector<HTMLButtonElement>('.is-best:not(:disabled)')
      ?? el.querySelector<HTMLButtonElement>('.ghost-row:not(:disabled), .session-browser-row:not(:disabled)')
    target?.focus({ preventScroll: false })
  }, [key])
  return ref
}

function MyLaps({ groups, chosen, current, sessionGuid, row }: { groups: GhostGroup[]; chosen: string; current: ReplayLapInfo | null; sessionGuid: string | null; row: RowFn }) {
  const ref = useFocusOnShow('mine')
  return <div ref={ref}>
    <ul>{row('none', <span className="ghost-row-name"><b>No ghost</b></span>, null, ' none')}</ul>
    {groups.map(g => <section key={g.group} aria-label={g.group}>
      <h3>{g.group}<span>{g.laps.length}</span></h3>
      <ul>{g.laps.map(lap => row(valueOf(lap),
        <span className="ghost-row-name">
          <b>{lap.sessionGuid === sessionGuid ? lapName(lap) : dateOf(lap)}</b>
          <span className="ghost-row-meta">
            {lap.sessionGuid !== sessionGuid && <em>{lapName(lap)}</em>}
            {lap.isBest && <em className="best">★ Best</em>}
            {lap.hasVideo && <em>Video</em>}
          </span>
        </span>,
        <span className="ghost-row-time"><b>{lap.durationMs > 0 ? msToLap(lap.durationMs) : '—'}</b><Gap ghost={lap} current={current} /></span>))}
      </ul>
    </section>)}
    {chosen.startsWith('driver:') && <p className="ghost-list-note">Racing another driver now: choose one of your laps to race yourself instead.</p>}
  </div>
}

// One list of another driver's, loaded once per page (cached by key); null key: nothing to load.
function useDriverData<T>(cache: Map<string, Promise<unknown>>, key: string | null, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string }>({ key: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!key) return
    let cancelled = false
    let promise = cache.get(key) as Promise<T> | undefined
    if (!promise) {
      promise = load()
      cache.set(key, promise)
      promise.catch(() => cache.delete(key))
    }
    setState(s => (s.key === key && s.data ? s : { key }))
    promise.then(data => { if (!cancelled) setState({ key, data }) },
      error => { if (!cancelled) setState({ key, error: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])
  const current = state.key === key ? state : { key }
  return { data: current.data, error: current.error, loading: !!key && !current.data && !current.error, retry: () => setAttempt(n => n + 1) }
}

function DriverLaps({ rival, chosen, current, course, cache, row }: {
  rival: RivalChoice | null; chosen: string; current: ReplayLapInfo | null; course: GhostCourse | null
  cache: Map<string, Promise<unknown>>; row: RowFn
}) {
  const [driver, setDriver] = useState<string | null>(rival?.driver ?? null)
  const [session, setSession] = useState<string | null>(rival?.sessionGuid ?? null)
  const [order, setOrder] = useState<'recent' | 'fastest'>('recent')
  const drivers = useDriverData<DriverAccount[]>(cache, 'drivers', () => api.listDrivers())
  const sessions = useDriverData<DbSessionRow[]>(cache, driver ? `sessions:${driverKey(driver)}` : null, () => api.listDriverSessions(driver!))
  const laps = useDriverData<ReplayLapInfo[]>(cache, driver && session ? `laps:${driverKey(driver)}:${session}` : null, () => api.listDriverLaps(driver!, session!))
  const step = !driver ? 'drivers' : !session ? 'sessions' : 'laps'
  const ref = useFocusOnShow(`${step}:${driver}:${session}:${!!drivers.data}:${!!sessions.data}:${!!laps.data}`)

  const all = sessions.data ?? []
  const onCourse = useMemo(() => all.filter(r => !course || sameCourse(course.identity, sessionCourse(r))), [all, course])
  const benchmarks = useMemo(() => sessionBenchmarks(all), [all])
  const ordered = useMemo(() => [...onCourse].sort(order === 'fastest'
    ? (a, b) => (validLapTime(a.best_lap_ms) ? a.best_lap_ms : Infinity) - (validLapTime(b.best_lap_ms) ? b.best_lap_ms : Infinity) || newestSessionFirst(a, b)
    : newestSessionFirst), [onCourse, order])
  const sessionRow = all.find(r => r.session_guid === session) ?? null
  const where = course?.label || 'this course'

  const failure = (error: string, retry: () => void) => <p className="ghost-list-empty" role="alert">{error} <button type="button" className="ghost-link" onClick={retry}>Try again</button></p>
  const crumbs = <nav className="ghost-crumbs" aria-label="Back">
    <button type="button" disabled={step === 'drivers'} onClick={() => { setDriver(null); setSession(null) }}>Drivers</button>
    {driver && <><span aria-hidden="true">›</span><button type="button" disabled={step === 'sessions'} onClick={() => setSession(null)}>{driver}</button></>}
    {driver && session && <><span aria-hidden="true">›</span><span className="ghost-crumb-here">{sessionRow ? startLabel(sessionRow.session_start) : 'Session'}</span></>}
  </nav>

  return <div ref={ref} className="ghost-driver"
    onKeyDown={e => { if (e.key === 'Backspace' && step !== 'drivers') { e.preventDefault(); if (step === 'laps') setSession(null); else setDriver(null) } }}>
    {crumbs}
    {step === 'drivers' && <>
      <p className="ghost-list-hint">Race another driver’s lap on {where}: their own car on your track, their line in their colour.</p>
      {drivers.error && failure(drivers.error, drivers.retry)}
      {drivers.loading && <p className="ghost-list-empty">Loading drivers…</p>}
      {drivers.data?.length === 0 && <p className="ghost-list-empty">No other drivers on this server yet. A driver appears here once they sign in with their own name and sync telemetry.</p>}
      <ul>{drivers.data?.map(d => <li key={d.username}><button type="button" className={`ghost-row driver${rival && driverKey(rival.driver) === driverKey(d.username) ? ' is-current' : ''}`}
        disabled={!d.hasTelemetry} aria-current={rival && driverKey(rival.driver) === driverKey(d.username) ? 'true' : undefined}
        onClick={() => { setDriver(d.username); setSession(null) }}>
        <span className="ghost-row-marker" aria-hidden="true">{rival && driverKey(rival.driver) === driverKey(d.username) ? '✓' : ''}</span>
        <span className="ghost-row-name"><b>{d.username}</b><span className="ghost-row-meta">{!d.hasTelemetry && <em>No telemetry yet</em>}</span></span>
        <span className="ghost-row-go" aria-hidden="true">›</span>
      </button></li>)}</ul>
    </>}
    {step === 'sessions' && <>
      <div className="ghost-list-toolbar">
        <span>{sessions.data ? `${onCourse.length} on ${where}` : sessions.error ? 'Sessions unavailable' : 'Loading sessions…'}</span>
        <div className="session-browser-sort" role="group" aria-label="Session order">
          <button type="button" aria-pressed={order === 'recent'} onClick={() => setOrder('recent')}>Recent</button>
          <button type="button" aria-pressed={order === 'fastest'} onClick={() => setOrder('fastest')}>Fastest</button>
        </div>
      </div>
      {sessions.error && failure(sessions.error, sessions.retry)}
      {sessions.data && !ordered.length && <p className="ghost-list-empty">{all.length
        ? `${driver} has no sessions on ${where} (${all.length} on other layouts). Choose another driver.` : `${driver} has no sessions yet.`}</p>}
      <ul className="ghost-sessions">{ordered.map(r => <li key={r.session_guid}><SessionRow row={r} benchmark={benchmarks.get(r.session_guid)} compact
        chosen={!!rival && driverKey(rival.driver) === driverKey(driver!) && rival.sessionGuid === r.session_guid}
        disabled={!r.details_loaded ? 'Telemetry not downloaded' : !r.lap_count ? 'No laps' : null}
        onSelect={() => setSession(r.session_guid)} /></li>)}</ul>
    </>}
    {step === 'laps' && <>
      {sessionRow && <p className="ghost-list-hint">{driver} · {sessionCar(sessionRow)} · {[sessionRow.track_name, sessionRow.track_configuration_name].filter(Boolean).join(' · ')}</p>}
      {laps.error && failure(laps.error, laps.retry)}
      {laps.loading && <p className="ghost-list-empty">Loading laps…</p>}
      {laps.data && !laps.data.length && <p className="ghost-list-empty">No valid laps in this session. Choose another.</p>}
      <ul>{laps.data?.map(lap => row(driverGhostParam({ driver: driver!, sessionGuid: session!, lap: lap.lap as number }),
        <span className="ghost-row-name">
          <b>{lapName(lap)}</b>
          <span className="ghost-row-meta">
            {lap.isBest && <em className="best">★ Their best</em>}
            {lap.hasVideo && <em>Video</em>}
          </span>
        </span>,
        <span className="ghost-row-time"><b>{msToLap(lap.durationMs)}</b><Gap ghost={lap} current={current} /></span>, lap.isBest ? ' is-best' : ''))}</ul>
    </>}
    {chosen.startsWith('driver:') && step === 'drivers' && <ul className="ghost-off">{row('none', <span className="ghost-row-name"><b>Stop racing {rival?.driver ?? 'them'}</b></span>, null, ' none')}</ul>}
  </div>
}
