// The replay's overlays, drawn in HTML over the canvas: lap timer and gap to
// the ghost, speed and the car's inputs, a g-meter, and the onboard video
// kept in step with the 3D car.

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { speedFromMps, speedUnitLabel, type UnitSystem } from '../../shared/units'
import type { ReplayEngine, FrameState } from './engine'
import { REPLAY_DEBUG } from './debug'
import type { LapPath } from './lapPath'

export function useFrame(engine: ReplayEngine | null): FrameState | null {
  const [state, setState] = useState<FrameState | null>(null)
  useEffect(() => engine?.subscribe(setState), [engine])
  return state
}

/** m:ss.s for the running clock, m:ss.sss for lap times. */
export function clock(ms: number, places = 1): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60), s = total - m * 60
  return `${m}:${s.toFixed(places).padStart(places ? 3 + places : 2, '0')}`
}

const G = 9.80665

export function ReplayHud({ engine, lap, ghost, ghostLabel, units, showVideo }: {
  engine: ReplayEngine
  lap: LapPath
  ghost: LapPath | null
  ghostLabel: string | null
  units: UnitSystem
  showVideo: boolean
}) {
  const state = useFrame(engine)
  if (!state) return null
  const dist = state.pose.dist ?? 0
  const gap = state.gapMs
  const inputs = lap.hasChannel('throttle') || lap.hasChannel('brake')
  return <div className="replay-hud">
    <div className="replay-hud-timer">
      <span className="replay-hud-label">{lap.lap.label}</span>
      <strong>{clock(state.timeMs, 1)}</strong>
      <span className="replay-hud-sub">of {clock(state.durationMs, 3)}</span>
      {ghost && <span className={`replay-hud-gap ${gap == null ? '' : gap > 0 ? 'behind' : 'ahead'}`} title={`Time gap to the ghost at this point of the lap (${ghostLabel ?? 'ghost'})`}>
        {gap == null ? '—' : `${gap > 0 ? '+' : '−'}${Math.abs(gap / 1000).toFixed(2)}`}<small>vs {ghostLabel ?? 'ghost'}</small>
      </span>}
      {REPLAY_DEBUG && <span className="replay-hud-fps">{state.fps.toFixed(0)} fps</span>}
    </div>
    <div className="replay-hud-instruments">
      <div className="replay-hud-speed"><strong>{Math.round(speedFromMps(state.pose.speedMps ?? 0, units))}</strong><span>{speedUnitLabel(units)}</span></div>
      {inputs && <CarInputs lap={lap} dist={dist} />}
      <GMeter state={state} />
    </div>
    {showVideo && lap.hasVideo && <PipVideo engine={engine} lap={lap} />}
  </div>
}

function CarInputs({ lap, dist }: { lap: LapPath; dist: number }) {
  const throttle = lap.channel('throttle', dist), brake = lap.channel('brake', dist)
  const gear = lap.channel('gear', dist), rpm = lap.channel('rpm', dist), steering = lap.channel('steering', dist)
  const maxRpm = useRef(0)
  if (!maxRpm.current) {
    const all = (lap.car?.rpm ?? []).filter((v): v is number => v != null)
    maxRpm.current = Math.max(7000, Math.ceil(Math.max(0, ...all) / 1000) * 1000)
  }
  const bar = (value: number | null, kind: string, label: string) =>
    <div className={`replay-bar ${kind}`} title={`${label} ${value == null ? '—' : Math.round(value) + '%'}`}>
      <i style={{ height: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
      <span>{label[0]}</span>
    </div>
  return <div className="replay-hud-inputs">
    <div className="replay-hud-gear"><strong>{gear == null ? '–' : gear <= 0 ? 'N' : Math.round(gear)}</strong><span>gear</span></div>
    {lap.hasChannel('rpm') && <div className="replay-hud-rpm">
      <div className="replay-rpm-track"><i style={{ width: `${Math.min(100, (rpm ?? 0) / maxRpm.current * 100)}%` }} /></div>
      <span>{rpm == null ? '—' : Math.round(rpm / 10) * 10} rpm</span>
    </div>}
    {bar(throttle, 'throttle', 'Throttle')}
    {bar(brake, 'brake', 'Brake')}
    {lap.hasChannel('steering') && <svg className="replay-hud-wheel" viewBox="-20 -20 40 40" aria-label={`Steering ${steering == null ? 'unknown' : Math.round(steering) + '°'}`}>
      <g transform={`rotate(${steering ?? 0})`}>
        <circle r="16" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="M-16 0H16M0 0V16" stroke="currentColor" strokeWidth="3" />
        <rect x="-1.5" y="-19" width="3" height="5" fill="var(--signal)" />
      </g>
    </svg>}
  </div>
}

// A friction circle oriented like Analysis's G-G chart: the force the driver
// feels, so braking is up and lateral g plots negated (as there).
function GMeter({ state }: { state: FrameState }) {
  const trail = useRef<Array<{ t: number; x: number; y: number }>>([])
  const ax = (state.pose.accelX ?? 0) / G, ay = (state.pose.accelY ?? 0) / G
  const list = trail.current
  const last = list[list.length - 1]
  if (last && (state.timeMs < last.t || state.timeMs - last.t > 600)) list.length = 0
  if (!last || state.timeMs !== last.t) list.push({ t: state.timeMs, x: ay, y: ax })
  while (list.length && list[0].t < state.timeMs - 1500) list.shift()
  const R = 40, scale = R / 1.5
  const points = list.map(p => `${(-p.x * scale).toFixed(1)},${(p.y * scale).toFixed(1)}`).join(' ')
  const total = Math.hypot(ax, ay)
  return <div className="replay-hud-g">
    <svg viewBox="-46 -46 92 92" aria-label={`${total.toFixed(2)} g`}>
      {[0.5, 1, 1.5].map(g => <circle key={g} r={g * scale} className={g === 1 ? 'ring one' : 'ring'} />)}
      <path d="M-44 0H44M0 -44V44" className="axis" />
      <polyline points={points} className="trail" />
      <circle cx={-ay * scale} cy={ax * scale} r="3.6" className="dot" />
    </svg>
    <span>{total.toFixed(2)} g</span>
  </div>
}

// The onboard video, picture in picture, held at the 3D car's distance.
function PipVideo({ engine, lap }: { engine: ReplayEngine; lap: LapPath }) {
  const video = useRef<HTMLVideoElement>(null)
  const [large, setLarge] = useState(false)
  const [covered, setCovered] = useState(true)
  const car = lap.car!
  const src = api.videoUrl(car.videoId, car.driver)
  useEffect(() => {
    const el = video.current
    let lastCovered = true
    let latest: FrameState | null = null
    const sync = (state: FrameState) => {
      latest = state
      if (!el) return
      const target = lap.videoTime(state.pose.dist)
      const isCovered = target != null
      if (isCovered !== lastCovered) { lastCovered = isCovered; setCovered(isCovered) }
      if (target == null) { if (!el.paused) el.pause(); return }
      if (el.readyState < 1 || el.seeking) return
      const drift = el.currentTime - target
      if (state.playing) {
        if (el.paused) void el.play().catch(() => { /* autoplay refused: stays paused, seeks below */ })
        // Small drift: run a little fast or slow to close it (a seek stalls
        // the picture for a moment); large drift: seek.
        if (Math.abs(drift) > 0.6) { el.currentTime = target + 0.08 * state.rate; el.playbackRate = state.rate }
        else el.playbackRate = state.rate * Math.min(1.25, Math.max(0.8, 1 - drift * 0.9))
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(drift) > 0.02) el.currentTime = target
      }
    }
    // A seek that finishes after the replay stopped publishing catches up here.
    const resync = () => { if (latest) sync(latest) }
    el?.addEventListener('seeked', resync)
    el?.addEventListener('loadedmetadata', resync)
    const unsubscribe = engine.subscribe(sync)
    return () => {
      unsubscribe()
      el?.removeEventListener('seeked', resync)
      el?.removeEventListener('loadedmetadata', resync)
    }
  }, [engine, lap])
  return <div className={`replay-pip ${large ? 'large' : ''} ${covered ? '' : 'uncovered'}`}>
    <video ref={video} src={src} muted playsInline preload="auto" />
    <div className="replay-pip-bar">
      <span>{covered ? 'Onboard video' : 'Video does not cover this point'}</span>
      <button type="button" onClick={() => setLarge(v => !v)} aria-label={large ? 'Smaller video' : 'Larger video'} title={large ? 'Smaller video' : 'Larger video'}>{large ? '⤡' : '⤢'}</button>
    </div>
  </div>
}
