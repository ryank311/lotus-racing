// The replay's overlays, drawn in HTML over the canvas: lap timer and gap to
// the ghost, speed and the car's inputs, a g-meter, and the onboard video
// kept in step with the 3D car.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { speedFromMps, speedUnitLabel, type UnitSystem } from '../../shared/units'
import type { ReplayEngine, FrameState } from './engine'
import { REPLAY_DEBUG } from './debug'
import { replayProfile } from './budget'
import { PipSync } from './pipSync'
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

export function ReplayHud({ engine, lap, ghost, ghostLabel, units, showVideo, rival = null }: {
  engine: ReplayEngine
  lap: LapPath
  ghost: LapPath | null
  ghostLabel: string | null
  units: UnitSystem
  showVideo: boolean
  /** Another driver's lap is the ghost: their name and colour (their speed shows, and their video beside yours). */
  rival?: { name: string; color: string } | null
}) {
  const state = useFrame(engine)
  const feed = useMemo(() => comparedFeed(engine), [engine])
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
        {gap == null ? '—' : `${gap > 0 ? '+' : '−'}${Math.abs(gap / 1000).toFixed(2)}`}<small>{rival && <i className="replay-hud-dot" style={{ background: rival.color }} />}vs {ghostLabel ?? 'ghost'}</small>
      </span>}
      {rival && state.compared && <span className="replay-hud-rival" title={`${rival.name}’s speed now`}>
        <i className="replay-hud-dot" style={{ background: rival.color }} />{rival.name}
        <b>{state.compared.pose ? Math.round(speedFromMps(state.compared.pose.speedMps ?? 0, units)) : '—'}</b> {speedUnitLabel(units)}
      </span>}
      {REPLAY_DEBUG && <span className="replay-hud-fps">{state.fps.toFixed(0)} fps</span>}
    </div>
    <div className="replay-hud-instruments">
      <div className="replay-hud-speed"><strong>{Math.round(speedFromMps(state.pose.speedMps ?? 0, units))}</strong><span>{speedUnitLabel(units)}</span></div>
      {inputs && <CarInputs lap={lap} dist={dist} />}
      <GMeter state={state} />
    </div>
    {showVideo && rival && ghost?.hasVideo
      ? <div className="replay-pips">
        {lap.hasVideo && <PipVideo engine={engine} lap={lap} />}
        <div className="replay-pip-rival" data-driver={rival.name} style={{ ['--rival' as string]: rival.color }}><PipVideo engine={feed} lap={ghost} /></div>
      </div>
      : showVideo && lap.hasVideo && <PipVideo engine={engine} lap={lap} />}
  </div>
}

/**
 * The compared car's frames for its own video: its pose on its own clock
 * (yours plus the offset), playing only while it is on its lap.
 */
function comparedFeed(engine: ReplayEngine): ReplayEngine {
  const subscribe = (listener: (state: FrameState) => void) => engine.subscribe(state => {
    const c = state.compared
    const pose = c?.pose ?? { ...state.pose, dist: Infinity }
    listener({ ...state, pose, playing: state.playing && !!c?.pose && c.timeMs > 0 && c.timeMs < c.durationMs })
  })
  return { subscribe } as unknown as ReplayEngine
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

// The onboard video, picture in picture, held at the 3D car's distance
// (pipSync.ts: nudged in rate on desktop and Android, steady with rare seeks
// on iPhone and iPad).
function PipVideo({ engine, lap }: { engine: ReplayEngine; lap: LapPath }) {
  const video = useRef<HTMLVideoElement>(null)
  const [large, setLarge] = useState(false)
  const [covered, setCovered] = useState(true)
  // The browser would not start it without a tap (iOS Low Power Mode, a browser's autoplay setting).
  const [refused, setRefused] = useState(false)
  const refusedRef = useRef(false)
  const car = lap.car!
  const src = api.videoUrl(car.videoId, car.driver)
  const steady = replayProfile().webkitMobile
  useEffect(() => {
    const el = video.current
    if (!el) return
    // Inline and silent: iOS plays a video without a tap only when it is muted.
    el.muted = el.defaultMuted = true
    el.setAttribute('muted', '')
    const sync = new PipSync(steady)
    let lastCovered = true
    let latest: FrameState | null = null
    let starting = false, retryAt = 0
    const play = () => {
      const now = performance.now()
      // After a refusal, only inside a tap (a click on Play reaches here synchronously).
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
      if (starting || now < retryAt || (refusedRef.current && !activation?.isActive)) return
      starting = true
      el.play().then(() => {
        starting = false
        if (refusedRef.current) { refusedRef.current = false; setRefused(false) }
      }, (error: unknown) => {
        starting = false
        retryAt = performance.now() + 1000
        if ((error as { name?: string })?.name === 'NotAllowedError' && !refusedRef.current) { refusedRef.current = true; setRefused(true) }
      })
    }
    const apply = (state: FrameState) => {
      latest = state
      const target = lap.videoTime(state.pose.dist)
      const isCovered = target != null
      if (isCovered !== lastCovered) { lastCovered = isCovered; setCovered(isCovered) }
      if (target == null) { if (!el.paused) el.pause(); return }
      if (state.playing) { if (el.paused) play() } else if (!el.paused) el.pause()
      const plan = sync.plan(state, target, el, performance.now())
      if (plan.seekTo != null) { sync.seeking(performance.now()); el.currentTime = plan.seekTo }
      if (plan.rate != null && plan.rate !== el.playbackRate) el.playbackRate = plan.rate
    }
    // A seek that finishes after the replay stopped publishing catches up here.
    const onSeeked = () => { sync.seeked(performance.now(), !!latest?.playing); if (latest) apply(latest) }
    const resync = () => { if (latest) apply(latest) }
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('loadedmetadata', resync)
    el.addEventListener('canplay', resync)
    const unsubscribe = engine.subscribe(apply)
    return () => {
      unsubscribe()
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('loadedmetadata', resync)
      el.removeEventListener('canplay', resync)
    }
  }, [engine, lap, steady])
  // A tap on the video starts it where the browser refused to.
  const tapToPlay = () => { if (refusedRef.current) void video.current?.play().then(() => { refusedRef.current = false; setRefused(false) }, () => {}) }
  return <div className={`replay-pip ${large ? 'large' : ''} ${covered ? '' : 'uncovered'}`}>
    <video ref={video} src={src} muted playsInline preload={steady ? 'metadata' : 'auto'} disablePictureInPicture onClick={tapToPlay} />
    <div className="replay-pip-bar">
      <span>{!covered ? 'Video does not cover this point' : refused ? 'Tap the video to play it' : 'Onboard video'}</span>
      <button type="button" onClick={() => setLarge(v => !v)} aria-label={large ? 'Smaller video' : 'Larger video'} title={large ? 'Smaller video' : 'Larger video'}>{large ? '⤡' : '⤢'}</button>
    </div>
  </div>
}
