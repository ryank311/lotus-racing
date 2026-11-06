// The replay's coaching (coachOverlay.ts draws it in 3D): its data and settings,
// the toggles in "On the track", the list of coaching points (each jumps the
// replay to a few seconds before it) and the callout over the view when the
// car reaches one.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import { NavLink } from '../navigation'
import { segment } from '../routes'
import { useResource } from '../useResource'
import type { ReplayCoaching, ReplayCoachPoint } from '../../shared/replayCoaching'
import type { UnitSystem } from '../../shared/units'
import type { ReplayEngine, ReplayWorld } from './engine'
import type { LapPath } from './lapPath'
import { CoachingOverlay, MARK_COLOR, TONE_COLOR, compareMarks, lapKey, placedPoints, type CoachingLayers } from './coachOverlay'
import { clock } from './Hud'
import './coaching.css'

export interface CoachingSettings extends CoachingLayers {
  /** Coaching at all (the master toggle). */
  on: boolean
  /** The callout over the view at each point. */
  callouts: boolean
}

const STORE_KEY = 'catalyst:replay-coaching'
const DEFAULTS: CoachingSettings = { on: true, labels: true, marks: true, zones: true, line: true, callouts: true }
// The callout shows from this far before a point's stretch to a little past it.
const CALLOUT_LEAD_M = 90
const CALLOUT_TAIL_M = 25
// The list's jump lands this long before the point.
const SEEK_LEAD_MS = 3000

function readSettings(): CoachingSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<CoachingSettings>
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof stored[key as keyof CoachingSettings] === 'boolean' ? stored[key as keyof CoachingSettings] : value])) as unknown as CoachingSettings
  } catch { return { ...DEFAULTS } }
}

export interface ReplayCoachingState {
  data: ReplayCoaching | null
  pending: boolean
  error: string | null
  /** There is coaching to show: at least one point (a line alone is not coaching). */
  hasData: boolean
  settings: CoachingSettings
  update: (patch: Partial<CoachingSettings>) => void
}

/**
 * The session's coaching and its 3D overlay: built once per world and data,
 * re-marked for each lap, redrawn when "Align to track" moves the lap, and
 * removed on unmount.
 */
export function useReplayCoaching(engine: ReplayEngine | null, world: ReplayWorld | null, sessionGuid: string | null, units: UnitSystem, lap: LapPath | null): ReplayCoachingState {
  const resource = useResource(() => (sessionGuid ? api.getReplayCoaching(sessionGuid) : Promise.resolve(null)), sessionGuid ?? '')
  const data = resource.data && resource.data.sessionGuid === sessionGuid ? resource.data : null
  const hasData = !!data && data.points.length > 0
  const [settings, setSettings] = useState<CoachingSettings>(readSettings)
  const update = (patch: Partial<CoachingSettings>) => setSettings(previous => {
    const next = { ...previous, ...patch }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* optional */ }
    return next
  })

  const [overlay, setOverlay] = useState<CoachingOverlay | null>(null)
  useEffect(() => {
    if (!engine || !world || !data || !hasData) return
    const built = new CoachingOverlay(world, data, units)
    engine.scene.add(built.group)
    setOverlay(built)
    const off = engine.onAlignment(() => { built.refreshPlacement(); engine.invalidate() })
    return () => { off(); built.dispose(); setOverlay(null); engine.invalidate() }
  }, [engine, world, data, hasData, units])
  useEffect(() => { if (overlay) { overlay.setLap(lap); engine?.invalidate() } }, [overlay, lap, engine])
  // Notes and boards follow the car along the track (a uniform; nothing allocated per frame).
  useEffect(() => (overlay && engine ? engine.subscribe(state => overlay.setCarDist(state.pose.dist)) : undefined), [overlay, engine])
  useEffect(() => {
    if (!overlay) return
    overlay.group.visible = settings.on
    overlay.setLayers(settings)
    engine?.invalidate()
  }, [overlay, settings, engine])

  return { data, pending: resource.pending, error: resource.error, hasData, settings, update }
}

/** The point whose stretch the car is in (or about to enter), by distance. */
function activePoint(points: ReturnType<typeof placedPoints>, dist: number): ReplayCoachPoint | null {
  for (const p of points) if (dist >= p.startM - CALLOUT_LEAD_M && dist <= p.endM + CALLOUT_TAIL_M) return p
  return null
}

/** The active point's id, re-rendering only when it changes. */
function useActivePoint(engine: ReplayEngine | null, points: ReturnType<typeof placedPoints>): ReplayCoachPoint | null {
  const [active, setActive] = useState<ReplayCoachPoint | null>(null)
  useEffect(() => {
    if (!engine || !points.length) { setActive(null); return }
    let current: ReplayCoachPoint | null = null
    return engine.subscribe(state => {
      const next = state.pose.dist == null ? null : activePoint(points, state.pose.dist)
      if (next !== current) { current = next; setActive(next) }
    })
  }, [engine, points])
  return active
}

// ─── "On the track": the toggles ────────────────────────────────────────────

export function CoachingToggles({ coaching }: { coaching: ReplayCoachingState }) {
  const { data, hasData, settings, update, pending, error } = coaching
  const lines = data?.lines ?? []
  const placed = placedPoints(data)
  if (!hasData) {
    if (pending) return null
    return <p className="muted small replay-coach-none">{error ? `Coaching unavailable: ${error}` : <>No coaching for this session yet. {data && <NavLink to={`/review/${segment(data.sessionGuid)}`}>Ask the coach in Session Review</NavLink>}</>}</p>
  }
  const layer = (key: keyof CoachingSettings, label: ReactNode, title?: string) =>
    <label className="replay-check" title={title}><input type="checkbox" checked={settings[key]} onChange={e => update({ [key]: e.target.checked })} />{label}</label>
  return <div className="replay-coach-toggles">
    <label className="replay-check" title="What the coach and your laps say about each corner, on the track">
      <input type="checkbox" checked={settings.on} onChange={e => update({ on: e.target.checked })} />Coaching{placed.length ? ` · ${placed.length} ${placed.length === 1 ? 'corner' : 'corners'}` : ''}</label>
    {settings.on && <div className="replay-coach-layers">
      {placed.length > 0 && layer('labels', <><i className="replay-coach-key note" />Corner notes</>, 'A note over each coached corner')}
      {placed.some(p => p.reference || p.targets.length) && layer('marks', <><i className="replay-swatch" style={{ background: MARK_COLOR.best }} /><i className="replay-swatch" style={{ background: MARK_COLOR.you }} />Brake, minimum and throttle points</>,
        'Stripes and boards: where your best pass through the corner braked, reached its minimum speed and picked up the throttle (cyan, green), and where this lap braked (orange)')}
      {placed.length > 0 && layer('zones', <><i className="replay-swatch" style={{ background: TONE_COLOR.loss }} />Coached stretches</>, 'Each coached corner lit along the road’s edges, in its note’s colour')}
      {lines.length > 0 && layer('line', <>{lines.map(l => <i key={l.id} className="replay-swatch dashed" style={{ color: l.id === 'coach' ? MARK_COLOR.coachLine : MARK_COLOR.line }} />)}{lines.map((l, i) => (i ? l.label.toLowerCase() : l.label)).join(' and ')}</>, lines.map(l => l.detail).join(' '))}
      {placed.length > 0 && layer('callouts', 'Callouts as you reach them', 'A card over the view as the car reaches each coached corner')}
    </div>}
  </div>
}

// ─── The callout over the view ──────────────────────────────────────────────

export function CoachingCallout({ coaching, engine, lap }: { coaching: ReplayCoachingState; engine: ReplayEngine; lap: LapPath }) {
  const points = useMemo(() => placedPoints(coaching.data), [coaching.data])
  const active = useActivePoint(coaching.settings.on && coaching.settings.callouts ? engine : null, points)
  if (!active || !coaching.data) return null
  return <div className={`replay-coach-callout tone-${active.tone}`} role="status" aria-live="polite">
    <PointSummary point={active} lap={lap} units={coaching.data.units} compact />
  </div>
}

/** A point's corner, headline, the coach's words and this lap against the best pass. */
function PointSummary({ point, lap, units, compact = false }: { point: ReplayCoachPoint; lap: LapPath | null; units: UnitSystem; compact?: boolean }) {
  const key = lapKey(lap)
  const mine = key != null ? point.laps[key] : undefined
  const best = point.reference
  const isBest = !!best && key === String(best.lap)
  const vs = compareMarks(mine, best, units)
  const parts = isBest ? [] : [vs.time, vs.brake && `brake ${vs.brake}`, vs.vmin && `min ${vs.vmin}`, vs.throttle && `throttle ${vs.throttle}`].filter(Boolean)
  const lead = point.notes[0]
  const coach = point.notes.find(n => n.source === 'coach')
  const vsLine = best && mine && (isBest
    ? <p className="replay-coach-vs">This lap is your best pass here ({best.label}).</p>
    : parts.length > 0 && <p className="replay-coach-vs">This lap vs {best.label}: {parts.join(' · ')}</p>)
  if (compact) return <>
    <div className="replay-coach-title"><b>{point.title}</b></div>
    <strong className="replay-coach-headline">{point.headline}</strong>
    <p>{(coach ?? lead).text}</p>
    {vsLine}
  </>
  // In the list: the lead note, this lap against the best pass, the rest on demand.
  const rest = point.notes.slice(1)
  return <>
    <div className="replay-coach-title"><b>{point.title}</b><small>{SOURCE_NAMES[lead.source]}</small></div>
    <strong className="replay-coach-headline">{point.headline}</strong>
    <p className="replay-coach-text">{lead.text}</p>
    {vsLine}
    {rest.length > 0 && <details className="replay-coach-more" onClick={event => event.stopPropagation()}>
      <summary>{rest.map(n => SOURCE_NAMES[n.source]).join(' · ')}</summary>
      {rest.map((n, i) => <p key={i} className={`replay-coach-note source-${n.source}`}><span>{SOURCE_NAMES[n.source]}</span><b>{n.headline}. </b>{n.text}</p>)}
    </details>}
  </>
}

const SOURCE_NAMES: Record<ReplayCoachPoint['notes'][number]['source'], string> = { coach: 'Coach', focus: 'Focus', review: 'Review', laps: 'Your laps' }

// ─── The list ───────────────────────────────────────────────────────────────

export function CoachingPanel({ coaching, engine, lap, sessionGuid }: { coaching: ReplayCoachingState; engine: ReplayEngine | null; lap: LapPath | null; sessionGuid: string }) {
  const { data, hasData } = coaching
  const points = useMemo(() => placedPoints(data), [data])
  const active = useActivePoint(engine, points)
  const general = data?.points.filter(p => p.atM == null) ?? []
  const review = `/review/${segment(sessionGuid)}`
  const hasCoach = data?.sources.some(s => s.source === 'coach')
  // Nothing to list (or still loading): "On the track" says so.
  if (!hasData || !data) return null
  return <section className="replay-panel replay-coaching">
    <div className="replay-coaching-head">
      <span className="review-eyebrow">Coaching</span>
      <NavLink to={review} className="small">Session Review →</NavLink>
    </div>
    <p className="muted small">{data.sources.map(s => s.reportId && s.source === 'coach' ? <span key={s.label}><NavLink to={`/coach/${segment(s.reportId)}`}>{s.label}</NavLink>{s.stale ? ' (older review)' : ''}. </span> : <span key={s.label}>{s.label}. </span>)}
      {!hasCoach && <>No AI coaching yet: <NavLink to={review}>ask the coach</NavLink>.</>}</p>
    {general.map(p => <div key={p.id} className={`replay-coach-item general tone-${p.tone}`}><PointSummary point={p} lap={lap} units={data.units} /></div>)}
    <ol className="replay-coach-list">
      {points.map(p => {
        const at = lap?.timeAtDist(p.startM)
        const jump = () => { if (engine && at != null) engine.seek(Math.max(0, at - SEEK_LEAD_MS)) }
        // The whole row jumps on a click; the time button is the keyboard's way.
        return <li key={p.id} className={`replay-coach-item tone-${p.tone}${active?.id === p.id ? ' active' : ''}${at == null ? '' : ' seekable'}`} onClick={jump}>
          <button type="button" className="replay-coach-time" disabled={!engine || at == null} onClick={event => { event.stopPropagation(); jump() }}
            aria-label={`Watch ${p.title} from a few seconds before`} title={at == null ? 'This lap does not reach this corner' : 'Jump the replay to a few seconds before this corner'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>{at == null ? '—' : clock(Math.max(0, at - SEEK_LEAD_MS), 0)}
          </button>
          <div className="replay-coach-body"><PointSummary point={p} lap={lap} units={data.units} /></div>
        </li>
      })}
    </ol>
  </section>
}
