import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DbSessionRow } from '../../shared/types'
import { msToLap } from '../api'
import { useNavigation, useOverlay } from '../navigation'
import { startLabel } from './reviewTimeline'
import { newestSessionFirst, sessionBenchmarks, sessionCar, sessionPickerGroups, validLapTime, type SessionOrder } from './sessionPickerData'
import './sessionPicker.css'

interface Props {
  sessions: DbSessionRow[]
  selected: string | null | undefined
  sessionUrl: (guid: string) => string
  label?: string
  loading?: boolean
  fallback?: { title: string; detail: string }
}

/** One chooser for Review and Replay, with native modal focus and history dismissal. */
export function SessionPicker({ sessions, selected, sessionUrl, label = 'Session', loading = false, fallback }: Props) {
  const [open, setOpen] = useOverlay('session-picker')
  const trigger = useRef<HTMLButtonElement>(null)
  const { go } = useNavigation()
  const dialogId = useId()
  const current = sessions.find(s => s.session_guid === selected)
  const title = current ? [current.track_configuration_name, current.track_name].filter(Boolean).join(' · ') || 'Unknown layout'
    : fallback?.title ?? (loading ? 'Loading sessions…' : selected ? 'Session unavailable' : 'Choose a session')
  const detail = current ? `${startLabel(current.session_start)} · ${sessionCar(current)}`
    : fallback?.detail ?? 'Browse by layout, date or lap time'
  return <div className="session-picker">
    <span className="session-picker-label">{label}</span>
    <button ref={trigger} type="button" className="session-picker-trigger" aria-label={label} data-session={selected ?? ''}
      aria-describedby={`${dialogId}-current`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      disabled={loading && !sessions.length} onClick={() => setOpen(true)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}>
      <span id={`${dialogId}-current`} className="session-picker-current"><strong>{title}</strong><span>{detail}</span></span>
      {current && validLapTime(current.best_lap_ms) && <span className="session-picker-current-time"><small>Best lap</small><b>{msToLap(current.best_lap_ms)}</b></span>}
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
    </button>
    {open && createPortal(<SessionBrowser id={dialogId} sessions={sessions} selected={selected}
      onClose={() => setOpen(false)} onSelect={guid => go(sessionUrl(guid))}
      restoreFocus={() => trigger.current?.focus({ preventScroll: true })} />, document.body)}
  </div>
}

function SessionBrowser({ id, sessions, selected, onClose, onSelect, restoreFocus }: {
  id: string; sessions: DbSessionRow[]; selected: string | null | undefined
  onClose: () => void; onSelect: (guid: string) => void; restoreFocus: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [order, setOrder] = useState<SessionOrder>('recent')
  const [course, setCourse] = useState('')
  const [car, setCar] = useState('')
  const benchmarks = useMemo(() => sessionBenchmarks(sessions), [sessions])
  const courses = useMemo(() => sessionPickerGroups(sessions, 'recent'), [sessions])
  const cars = useMemo(() => [...new Map(sessions.filter(s => s.vehicle_guid).map(s => [s.vehicle_guid!, sessionCar(s)])).entries()], [sessions])
  const groups = useMemo(() => sessionPickerGroups(sessions, order, search, car).filter(g => !course || g.key === course), [sessions, order, search, car, course])
  const count = groups.reduce((n, g) => n + g.rows.length, 0)
  const newest = useMemo(() => [...sessions].sort(newestSessionFirst)[0]?.session_guid, [sessions])
  const multipleDrivers = new Set(sessions.map(s => s.account).filter(Boolean)).size > 1
  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    // Desktop gets immediate search; on phones focus Close to keep the keyboard tucked away.
    if (window.matchMedia('(min-width: 641px)').matches) searchInput.current?.focus()
    return () => { node.close(); restoreFocus() }
  }, [])
  useEffect(() => { list.current?.scrollTo({ top: 0 }) }, [search, order, course, car])
  const rowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.session-browser-row')]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))
    buttons[next]?.focus()
  }
  const reset = () => { setSearch(''); setCar(''); setCourse('') }
  return <dialog ref={dialog} id={id} className="session-browser" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`}
    onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
    <div className="session-browser-shell">
      <header className="session-browser-head"><div><span className="session-browser-eyebrow">// session library</span><h2 id={`${id}-title`}>Choose a session</h2><p>Your laps, organized by course layout.</p></div>
        <button type="button" autoFocus className="session-browser-close" aria-label="Close session picker" onClick={onClose}>×</button></header>
      <div className="session-browser-controls">
        <div className="session-browser-search"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="m12 12 5 5" /></svg>
          <input ref={searchInput} type="search" aria-label="Search sessions" placeholder="Search track, date, car…" value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('.session-browser-row')?.focus() } }} />
        </div>
        <div className="session-browser-toolbar"><div className="session-browser-sort" role="group" aria-label="Session order">
          <button type="button" aria-pressed={order === 'recent'} onClick={() => setOrder('recent')}>Recent</button>
          <button type="button" aria-pressed={order === 'fastest'} onClick={() => setOrder('fastest')}>Fastest</button>
        </div>{cars.length > 1 && <select aria-label="Filter by car" value={car} onChange={e => setCar(e.target.value)}><option value="">All cars</option>{cars.map(([guid, name]) => <option key={guid} value={guid}>{name}</option>)}</select>}
          <span className="session-browser-count" aria-live="polite">{count} {count === 1 ? 'session' : 'sessions'}</span>
        </div>
        {courses.length > 1 && <div className="session-browser-courses" role="group" aria-label="Filter by layout">
          <button type="button" aria-pressed={!course} onClick={() => setCourse('')}>All layouts</button>
          {courses.map(g => <button key={g.key} type="button" aria-pressed={course === g.key} title={`${g.track} · ${g.layout}`} onClick={() => setCourse(g.key)}>
            {courses.some(other => other.key !== g.key && other.layout === g.layout) ? `${g.track} · ${g.layout}` : g.layout}<span>{g.rows.length}</span>
          </button>)}
        </div>}
      </div>
      <div className="session-browser-list" ref={list} onKeyDown={rowKeys}>
        {!count && <div className="session-browser-empty"><strong>{sessions.length ? 'No matching sessions' : 'No sessions yet'}</strong>
          <p>{sessions.length ? 'Try another date, car or course layout.' : 'Sync your sessions from Overview to get started.'}</p>
          {sessions.length > 0 && <button type="button" onClick={reset}>Clear filters</button>}</div>}
        {groups.map(group => <section className="session-browser-group" key={group.key} aria-label={`${group.track} · ${group.layout}`}>
          <header><div><span>{group.track}</span><h3>{group.layout}</h3></div><span>{order === 'fastest' ? 'Fastest first' : 'Newest first'} · {group.rows.length}</span></header>
          <ul>{group.rows.map(row => {
            const benchmark = benchmarks.get(row.session_guid)!, chosen = row.session_guid === selected
            return <li key={row.session_guid}><button type="button" className={`session-browser-row${chosen ? ' is-current' : ''}`} data-session={row.session_guid}
              aria-current={chosen ? 'true' : undefined} onClick={() => onSelect(row.session_guid)}>
              <span className="session-browser-marker" aria-hidden="true">{chosen ? '✓' : ''}</span>
              <span className="session-browser-description"><span className="session-browser-date">{startLabel(row.session_start)}
                {chosen ? <em className="session-browser-selected">Selected</em> : row.session_guid === newest && <em>Latest</em>}</span>
                <span className="session-browser-meta">{sessionCar(row)}{multipleDrivers && row.account ? ` · ${row.account}` : ''} · {row.lap_count || 0} {(row.lap_count || 0) === 1 ? 'lap' : 'laps'}{row.video_count ? ' · Video' : ''}{!row.details_loaded ? ' · Download on open' : ''}</span>
              </span>
              <span className="session-browser-time"><strong>{validLapTime(row.best_lap_ms) ? msToLap(row.best_lap_ms) : '—'}</strong>
                {benchmark.isPb ? <span className="session-browser-pb">★ Car PB</span> : benchmark.gapMs != null ? <small>+{(benchmark.gapMs / 1000).toFixed(3)} s to PB</small> : <small>{validLapTime(row.best_lap_ms) ? 'Best lap' : 'No lap time'}</small>}
              </span>
            </button></li>
          })}</ul>
        </section>)}
      </div>
      <footer id={`${id}-note`}><span>Best session laps · PBs and gaps use the same driver, car and layout.</span><span>↑ ↓ to move · Enter to open</span></footer>
    </div>
  </dialog>
}
