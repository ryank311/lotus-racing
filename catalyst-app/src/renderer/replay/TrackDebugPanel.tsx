// The replay's track debug: a free camera to look the track over, overlays
// of the data that places the car (trackDebug.ts), a live readout of the car
// against them, and spots flagged along the lap with a report to copy (to
// say exactly where the track and the data disagree).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReplayCorner } from '../../shared/replay'
import type { ReplayEngine } from './engine'
import { NO_TRACK_DEBUG, type TrackDebugOptions, type TrackProbe } from './trackDebug'

const OPTIONS_KEY = 'catalyst:replay-track-debug'
const FLAGS_KEY = 'catalyst:replay-track-flags:'
const READ_EVERY_MS = 250

export interface TrackFlag {
  dist: number
  session: string
  lap: string
  at: string
  probe: TrackProbe
}

function readJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback } catch { return fallback }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* optional */ }
}

/** The overlays chosen (remembered on this device) and the spots flagged on this track. */
export function useTrackDebug(engine: ReplayEngine | null, trackKey: string) {
  const [options, setOptionsState] = useState<TrackDebugOptions>(() => readJson(OPTIONS_KEY, NO_TRACK_DEBUG))
  const [flags, setFlags] = useState<TrackFlag[]>([])
  useEffect(() => {
    if (!trackKey) { setFlags([]); return }
    try { setFlags(JSON.parse(localStorage.getItem(FLAGS_KEY + trackKey) ?? '[]') as TrackFlag[]) } catch { setFlags([]) }
  }, [trackKey])
  useEffect(() => { engine?.setTrackDebug(options) }, [engine, options])
  useEffect(() => { engine?.setTrackFlags(flags.map(f => f.dist)) }, [engine, flags])
  const setOptions = useCallback((next: TrackDebugOptions) => { setOptionsState(next); writeJson(OPTIONS_KEY, next) }, [])
  const saveFlags = useCallback((next: TrackFlag[]) => { setFlags(next); if (trackKey) writeJson(FLAGS_KEY + trackKey, next) }, [trackKey])
  const active = options.edges || options.garmin || options.gps || options.path || options.wireframe
  return { options, setOptions, flags, saveFlags, active }
}

const fmt = (m: number, places = 2) => `${m >= 0 ? '+' : '−'}${Math.abs(m).toFixed(places)}`
const side = (m: number) => `${Math.abs(m).toFixed(2)} m ${m >= 0 ? 'left' : 'right'}`

const turnName = (c: ReplayCorner) => (/^t/i.test(c.turn) ? c.turn : `T${c.turn}`)

function cornerAt(corners: ReplayCorner[], dist: number): string | null {
  const inside = corners.find(c => dist >= c.startM && dist <= c.endM)
  if (inside) return `${turnName(inside)}${inside.name ? ` ${inside.name}` : ''}`
  let best: ReplayCorner | null = null
  for (const c of corners) if (!best || Math.abs(c.apexM - dist) < Math.abs(best.apexM - dist)) best = c
  return best && Math.abs(best.apexM - dist) < 200 ? `near ${turnName(best)}` : null
}

function carEdgeClass(m: number): string {
  return m > 1.8 ? 'far' : m > 0 ? 'over' : m > -0.5 ? 'near' : 'inside'
}

/** One spot in words, for the report. */
function describe(flag: TrackFlag, corners: ReplayCorner[]): string {
  const p = flag.probe, corner = cornerAt(corners, p.dist)
  const parts = [`${Math.round(p.dist).toLocaleString()} m${corner ? ` (${corner})` : ''}, ${flag.lap}`]
  if (p.model) {
    parts.push(`car ${side(p.model.offsetM)} of the model's road centre; model road ${p.model.widthM.toFixed(1)} m wide; car's side ${p.model.carEdgeM > 0 ? `${p.model.carEdgeM.toFixed(2)} m past` : `${(-p.model.carEdgeM).toFixed(2)} m inside`} the edge`)
  }
  if (p.garminFromModelM != null) parts.push(`Garmin line ${side(p.garminFromModelM)} of the model's centre`)
  parts.push(`car ${side(p.garminOffsetM)} of Garmin's line`)
  parts.push(`lap shift ${Math.hypot(p.shift.dx, p.shift.dz).toFixed(1)} m (${fmt(p.shift.dx, 1)} E, ${fmt(-p.shift.dz, 1)} N)`)
  return parts.join('; ')
}

export function TrackDebugPanel({ engine, debug, fly, onFly, corners, place, session, lapLabel }: {
  engine: ReplayEngine
  debug: ReturnType<typeof useTrackDebug>
  fly: boolean
  onFly: (on: boolean) => void
  corners: ReplayCorner[]
  /** "VIR · Full Course", for the report. */
  place: string
  session: string
  lapLabel: string
}) {
  const { options, setOptions, flags, saveFlags } = debug
  const [copied, setCopied] = useState(false)
  const set = (key: keyof TrackDebugOptions) => (event: React.ChangeEvent<HTMLInputElement>) => setOptions({ ...options, [key]: event.target.checked })
  const flag = useCallback(() => {
    const probe = engine.trackProbe()
    if (!probe) return
    saveFlags([...flags, { dist: probe.dist, session, lap: lapLabel, at: new Date().toISOString(), probe }].sort((a, b) => a.dist - b.dist))
  }, [engine, flags, saveFlags, session, lapLabel])
  // M flags the spot the car is at.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'm' && event.key !== 'M')) return
      if (event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable="true"]')) return
      flag()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flag])
  const report = useMemo(() => [
    `Track debug: ${place}, ${flags.length} spot${flags.length === 1 ? '' : 's'} (offsets across the road, as driven)`,
    ...flags.map((f, i) => `${i + 1}. ${describe(f, corners)} [session ${f.session}]`),
  ].join('\n'), [flags, corners, place])
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* no clipboard */ }
  }
  return <details className="replay-panel replay-debug" open={fly || debug.active || flags.length > 0 || undefined}>
    <summary className="review-eyebrow">Track debug</summary>
    <label className="replay-check"><input type="checkbox" checked={fly} onChange={e => onFly(e.target.checked)} />Fly camera <kbd>N</kbd></label>
    <label className="replay-check"><input type="checkbox" checked={options.edges} onChange={set('edges')} /><i className="replay-debug-swatch" style={{ background: '#ffd400' }} />Track model: road edges, centre and width every 20 m</label>
    <label className="replay-check"><input type="checkbox" checked={options.garmin} onChange={set('garmin')} /><i className="replay-debug-swatch" style={{ background: '#22d3ee' }} />Garmin’s centre line</label>
    <label className="replay-check"><input type="checkbox" checked={options.gps} onChange={set('gps')} /><i className="replay-debug-swatch" style={{ background: '#ff5a5a' }} />GPS as recorded (before the shift)</label>
    <label className="replay-check"><input type="checkbox" checked={options.path} onChange={set('path')} /><i className="replay-debug-swatch path" />Car path, by the car’s side against the model’s edge</label>
    {options.path && <p className="muted small replay-debug-legend">
      <span className="inside">inside</span> · <span className="near">within 0.5 m</span> · <span className="over">over the edge</span> · <span className="far">a car’s width off</span>
    </p>}
    <label className="replay-check"><input type="checkbox" checked={options.wireframe} onChange={set('wireframe')} />Track model as wireframe</label>
    <div className="replay-debug-actions">
      <button type="button" className="btn ghost small" onClick={flag} title="Mark where your car is now (M)">Flag this spot <kbd>M</kbd></button>
      {flags.length > 0 && <button type="button" className="btn ghost small" onClick={copy}>{copied ? 'Copied' : 'Copy report'}</button>}
      {flags.length > 0 && <button type="button" className="btn ghost small" onClick={() => saveFlags([])}>Clear</button>}
    </div>
    {flags.length > 0 && <ol className="replay-debug-flags">
      {flags.map((f, i) => <li key={`${f.at}-${i}`}>
        <button type="button" className="link" onClick={() => { const t = engine.lapTimeAt(f.dist); if (t != null) engine.seek(t) }} title="Go to this spot">{describe(f, corners)}</button>
        <button type="button" className="replay-debug-remove" aria-label="Remove this spot" onClick={() => saveFlags(flags.filter(other => other !== f))}>×</button>
      </li>)}
    </ol>}
    <p className="muted small">Flags are kept on this device for this track. Copy the report to send the exact spots.</p>
  </details>
}

/** On the view: the car against the data now, and the fly camera's keys. */
export function TrackDebugReadout({ engine, active, fly }: { engine: ReplayEngine; active: boolean; fly: boolean }) {
  const [probe, setProbe] = useState<TrackProbe | null>(null)
  useEffect(() => {
    if (!active) { setProbe(null); return }
    let last = -Infinity
    setProbe(engine.trackProbe())
    return engine.subscribe(state => {
      const now = performance.now()
      if (state.playing && now - last < READ_EVERY_MS) return
      last = now
      setProbe(engine.trackProbe())
    })
  }, [engine, active])
  if (!active && !fly) return null
  return <div className="replay-debug-readout" role="status">
    {active && probe && <div>
      <b>{Math.round(probe.dist).toLocaleString()} m</b>
      {probe.model
        ? <> · model road {probe.model.widthM.toFixed(1)} m · car {fmt(probe.model.offsetM)} m from its centre · side <span className={carEdgeClass(probe.model.carEdgeM)}>{probe.model.carEdgeM > 0 ? `${probe.model.carEdgeM.toFixed(2)} m over` : `${(-probe.model.carEdgeM).toFixed(2)} m in`}</span></>
        : <> · no track model edges here</>}
      {probe.garminFromModelM != null && <> · Garmin line {fmt(probe.garminFromModelM)} m</>}
      <> · shift {Math.hypot(probe.shift.dx, probe.shift.dz).toFixed(1)} m</>
    </div>}
    {fly && <div className="replay-debug-keys">Fly: W A S D move · E / Q up and down · Shift faster, Alt slower · wheel sets the speed · click the view to look (Esc frees the mouse) · N leaves</div>}
  </div>
}
