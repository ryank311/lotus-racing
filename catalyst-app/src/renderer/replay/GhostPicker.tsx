// The ghost lap chooser: the session picker's look, compact. A one-line
// trigger (the same height as the lap select) opens a dropdown anchored
// under it (a bottom sheet on phones) of dense rows: this session's other
// laps, then the fastest laps of other sessions, each with its gap to the
// lap being watched.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { msToLap } from '../api'
import { useOverlay } from '../navigation'
import type { ReplayLapInfo } from '../../shared/replay'
import './ghostPicker.css'

export interface GhostGroup { group: string; laps: ReplayLapInfo[] }

const valueOf = (lap: ReplayLapInfo) => `${lap.sessionGuid}:${lap.lap}`
const lapName = (lap: ReplayLapInfo) => (lap.lap === 'optimal' ? '◆ Optimal' : `L${(lap.lap as number) + 1}`)
// Other sessions' labels read "Oct 30 10:34 · L3": the date part.
const dateOf = (lap: ReplayLapInfo) => lap.label.split(' · ').slice(0, -1).join(' · ') || lap.label

/** The ghost's time against the lap being watched: negative, the ghost is faster. */
function Gap({ ghost, current }: { ghost: ReplayLapInfo; current: ReplayLapInfo | null }) {
  if (!current || !ghost.durationMs || !current.durationMs) return null
  const s = (ghost.durationMs - current.durationMs) / 1000
  const text = Math.abs(s) < 0.0005 ? '±0.000' : `${s < 0 ? '−' : '+'}${Math.abs(s).toFixed(3)}`
  return <span className={`ghost-gap ${s < 0 ? 'faster' : 'slower'}`} title={s < 0 ? 'Faster than this lap' : 'Slower than this lap'}>{text}</span>
}

export function GhostPicker({ groups, ghost, current, sessionGuid, onSelect, disabled = false }: {
  groups: GhostGroup[]
  ghost: ReplayLapInfo | null
  /** The lap being watched (for the gaps). */
  current: ReplayLapInfo | null
  /** The replayed session: its laps show without their date. */
  sessionGuid: string | null
  /** 'none', or "<session>:<lap>". */
  onSelect: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useOverlay('ghost-picker')
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const own = ghost?.sessionGuid === sessionGuid
  const title = !ghost ? 'No ghost' : own ? `${lapName(ghost)}` : `${dateOf(ghost)} · ${lapName(ghost)}`
  return <div className="ghost-picker">
    <span className="ghost-picker-label">Ghost</span>
    <button ref={trigger} type="button" className={`ghost-picker-trigger${ghost ? '' : ' none'}`} aria-label={`Ghost: ${title}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => setOpen(true)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}>
      <i className="ghost-swatch" aria-hidden="true" />
      <span className="ghost-picker-title">{title}</span>
      {ghost && ghost.durationMs > 0 && <span className="ghost-picker-time">{msToLap(ghost.durationMs)}</span>}
      {ghost && <Gap ghost={ghost} current={current} />}
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
    </button>
    {open && createPortal(<GhostList id={id} groups={groups} ghost={ghost} current={current} sessionGuid={sessionGuid} anchor={trigger}
      // Choosing replaces the history entry the list opened on (as the
      // session picker does), which closes it; stepping back first would race.
      onClose={() => setOpen(false)} onSelect={value => (value === (ghost ? `${ghost.sessionGuid}:${ghost.lap}` : 'none') ? setOpen(false) : onSelect(value))}
      restoreFocus={() => trigger.current?.focus({ preventScroll: true })} />, document.body)}
  </div>
}

function GhostList({ id, groups, ghost, current, sessionGuid, anchor, onClose, onSelect, restoreFocus }: {
  id: string; groups: GhostGroup[]; ghost: ReplayLapInfo | null; current: ReplayLapInfo | null; sessionGuid: string | null
  anchor: { current: HTMLElement | null }; onClose: () => void; onSelect: (value: string) => void; restoreFocus: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const chosen = ghost ? valueOf(ghost) : 'none'

  // Anchored under the trigger on wide screens (above it when there is more room there).
  useLayoutEffect(() => {
    const fit = () => {
      const el = anchor.current
      if (!el || !window.matchMedia('(min-width: 641px)').matches) { setPlace(null); return }
      const r = el.getBoundingClientRect(), gap = 6, margin = 12
      const width = Math.min(Math.max(r.width, 380), window.innerWidth - 2 * margin)
      const left = Math.min(Math.max(margin, r.left), window.innerWidth - width - margin)
      const below = window.innerHeight - r.bottom - gap - margin, above = r.top - gap - margin
      const down = below >= 320 || below >= above
      const maxHeight = Math.min(460, down ? below : above)
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
    node.querySelector<HTMLButtonElement>('.ghost-row[aria-current="true"]')?.focus({ preventScroll: false })
    return () => { node.close(); restoreFocus() }
  }, [])

  const rowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.ghost-row')]
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next]?.focus()
  }

  const row = (value: string, body: React.ReactNode, right: React.ReactNode, extra = '') =>
    <li key={value}><button type="button" className={`ghost-row${value === chosen ? ' is-current' : ''}${extra}`} aria-current={value === chosen ? 'true' : undefined}
      onClick={() => onSelect(value)}>
      <span className="ghost-row-marker" aria-hidden="true">{value === chosen ? '✓' : ''}</span>
      {body}
      {right}
    </button></li>

  return <dialog ref={dialog} id={id} className={`ghost-list${place ? ' anchored' : ''}`} aria-label="Choose a ghost lap"
    style={place ? { top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight } : undefined}
    onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
    <div className="ghost-list-shell">
      <header className="ghost-list-head">
        <span>Ghost lap</span>
        {current && current.durationMs > 0 && <small>vs {lapName(current)} · {msToLap(current.durationMs)}</small>}
        <button type="button" className="ghost-list-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="ghost-list-body" onKeyDown={rowKeys}>
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
      </div>
    </div>
  </dialog>
}
