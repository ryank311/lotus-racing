// The replay's overlays, drawn in HTML over the canvas: lap timer and gap to
// the ghost, speed and the car's inputs, a g-meter, and the onboard video
// kept in step with the 3D car.
//
// Nothing here renders per frame: each part subscribes to the engine once and
// writes its changing numbers straight into the DOM (frameWriter), and React
// renders it again only when its structure changes (a compared car appears,
// another lap, the video). Aria labels and titles follow a few times a second
// while the lap plays, at once while it is paused.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { speedFromMps, speedUnitLabel, type UnitSystem } from '../../shared/units'
import type { ReplayEngine, FrameState } from './engine'
import { REPLAY_DEBUG } from './debug'
import { replayProfile } from './budget'
import { PipSync } from './pipSync'
import type { LapPath } from './lapPath'

/** Publishes the replay's frames: the engine, or a view of it. */
export interface FrameSource {
  subscribe(listener: (state: FrameState) => void): () => void
}

/**
 * A value derived from the replay's frames, rendering again only when it
 * changes (playing or paused, say), not every frame. `select` must be stable
 * (a module-level function).
 */
export function useFrameValue<T>(source: FrameSource | null, select: (state: FrameState) => T, initial: T): T {
  const [value, setValue] = useState<T>(initial)
  // Before paint, so the first frame shows the engine's value, not `initial`.
  useLayoutEffect(() => {
    if (!source) return
    let last: { value: T } | null = null
    return source.subscribe(state => {
      const next = select(state)
      if (last && Object.is(last.value, next)) return
      last = { value: next }
      setValue(() => next)
    })
  }, [source, select])
  return value
}

/**
 * Writes to the DOM from a frame subscription, outside React: each text,
 * style, attribute or class only when it differs from what this writer last
 * set there. A new writer (a new subscription) writes everything once.
 */
export function frameWriter() {
  const written = new WeakMap<Element, Map<string, string>>()
  const changed = (el: Element, key: string, value: string) => {
    let seen = written.get(el)
    if (!seen) written.set(el, seen = new Map())
    if (seen.get(key) === value) return false
    seen.set(key, value)
    return true
  }
  return {
    text(el: Element | null, value: string) { if (el && changed(el, '#text', value)) el.textContent = value },
    style(el: HTMLElement | SVGElement | null, property: string, value: string) { if (el && changed(el, property, value)) el.style.setProperty(property, value) },
    attr(el: Element | null, name: string, value: string) { if (el && changed(el, `@${name}`, value)) el.setAttribute(name, value) },
    toggle(el: Element | null, name: string, on: boolean) { if (el && changed(el, `.${name}`, on ? '1' : '')) el.classList.toggle(name, on) },
  }
}

/** While the lap plays, aria values and titles change at most this often (ms); paused, at once. */
const LABEL_EVERY_MS = 250

/** Whether this frame's aria values and titles are due (one per subscription). */
export function labelClock(): (state: FrameState) => boolean {
  let at = -Infinity
  return state => {
    const now = performance.now()
    if (state.playing && now - at < LABEL_EVERY_MS) return false
    at = now
    return true
  }
}

/** m:ss.s for the running clock, m:ss.sss for lap times. */
export function clock(ms: number, places = 1): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60), s = total - m * 60
  return `${m}:${s.toFixed(places).padStart(places ? 3 + places : 2, '0')}`
}

const G = 9.80665
const hasCompared = (state: FrameState) => state.compared != null

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
  const feed = useMemo(() => comparedFeed(engine), [engine])
  const compared = useFrameValue(engine, hasCompared, false)
  const [videoShown, setVideoShown] = useVideoShown()
  const hide = useCallback(() => setVideoShown(false), [setVideoShown])
  // Yours and, racing another driver, theirs beside it.
  const pair = showVideo && !!rival && !!ghost?.hasVideo
  const videos = pair ? (lap.hasVideo ? 2 : 1) : showVideo && lap.hasVideo ? 1 : 0
  const inputs = lap.hasChannel('throttle') || lap.hasChannel('brake')
  const showGap = !!ghost, showRival = !!rival && compared
  const time = useRef<HTMLElement>(null), duration = useRef<HTMLSpanElement>(null)
  const gap = useRef<HTMLSpanElement>(null), gapTime = useRef<HTMLSpanElement>(null)
  const rivalSpeed = useRef<HTMLElement>(null), fps = useRef<HTMLSpanElement>(null), speed = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const write = frameWriter()
    return engine.subscribe(state => {
      write.text(time.current, clock(state.timeMs, 1))
      write.text(duration.current, `of ${clock(state.durationMs, 3)}`)
      const g = state.gapMs
      write.text(gapTime.current, g == null ? '—' : `${g > 0 ? '+' : '−'}${Math.abs(g / 1000).toFixed(2)}`)
      write.toggle(gap.current, 'behind', g != null && g > 0)
      write.toggle(gap.current, 'ahead', g != null && g <= 0)
      const other = state.compared?.pose
      write.text(rivalSpeed.current, other ? String(Math.round(speedFromMps(other.speedMps ?? 0, units))) : '—')
      if (REPLAY_DEBUG) write.text(fps.current, `${state.fps.toFixed(0)} fps`)
      write.text(speed.current, String(Math.round(speedFromMps(state.pose.speedMps ?? 0, units))))
    })
  }, [engine, units, showGap, showRival])
  return <div className="replay-hud">
    <div className="replay-hud-timer">
      <span className="replay-hud-label">{lap.lap.label}</span>
      <strong ref={time} />
      <span className="replay-hud-sub" ref={duration} />
      {ghost && <span ref={gap} className="replay-hud-gap" title={`Time gap to the ghost at this point of the lap (${ghostLabel ?? 'ghost'})`}>
        <span ref={gapTime} /><small>{rival && <i className="replay-hud-dot" style={{ background: rival.color }} />}vs {ghostLabel ?? 'ghost'}</small>
      </span>}
      {rival && showRival && <span className="replay-hud-rival" title={`${rival.name}’s speed now`}>
        <i className="replay-hud-dot" style={{ background: rival.color }} />{rival.name}
        <b ref={rivalSpeed} /> {speedUnitLabel(units)}
      </span>}
      {REPLAY_DEBUG && <span className="replay-hud-fps" ref={fps} />}
    </div>
    <div className="replay-hud-instruments">
      <div className="replay-hud-speed"><strong ref={speed} /><span>{speedUnitLabel(units)}</span></div>
      {inputs && <CarInputs engine={engine} lap={lap} />}
      <GMeter engine={engine} />
    </div>
    {videos > 0 && !videoShown && <button type="button" className="replay-video-tab" onClick={() => setVideoShown(true)}
      aria-label={videos > 1 ? 'Show the onboard videos' : 'Show the onboard video'} title={videos > 1 ? 'Show the onboard videos' : 'Show the onboard video'}>
      <VideoIcon />{videos > 1 && <b>{videos}</b>}
    </button>}
    {videoShown && (pair && rival && ghost
      ? <div className="replay-pips">
        {lap.hasVideo && <PipVideo engine={engine} lap={lap} onHide={hide} hideLabel="Hide the videos" />}
        <div className="replay-pip-rival" data-driver={rival.name} style={{ ['--rival' as string]: rival.color }}><PipVideo engine={feed} lap={ghost} onHide={hide} hideLabel="Hide the videos" /></div>
      </div>
      : showVideo && lap.hasVideo && <PipVideo engine={engine} lap={lap} onHide={hide} hideLabel="Hide the video" />)}
  </div>
}

const VIDEO_KEY = 'catalyst:replay-video'

/**
 * Whether the onboard videos show, remembered on this device. Hidden, they
 * fold into a small button at the top right and their players go (paused,
 * nothing more downloaded or decoded).
 */
function useVideoShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => { try { return localStorage.getItem(VIDEO_KEY) !== 'hidden' } catch { return true } })
  const set = useCallback((next: boolean) => {
    setShown(next)
    try { localStorage.setItem(VIDEO_KEY, next ? 'shown' : 'hidden') } catch { /* optional */ }
  }, [])
  return [shown, set]
}

function VideoIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="6" width="13" height="12" rx="2" /><path d="M15.5 10.5 21 7.5v9l-5.5-3" />
  </svg>
}

/**
 * The compared car's frames for its own video: its pose on its own clock
 * (yours plus the offset), playing only while it is on its lap.
 */
function comparedFeed(engine: ReplayEngine): FrameSource {
  return {
    subscribe: listener => engine.subscribe(state => {
      const c = state.compared
      const pose = c?.pose ?? { ...state.pose, dist: Infinity }
      listener({ ...state, pose, playing: state.playing && !!c?.pose && c.timeMs > 0 && c.timeMs < c.durationMs })
    }),
  }
}

function CarInputs({ engine, lap }: { engine: ReplayEngine; lap: LapPath }) {
  const hasRpm = lap.hasChannel('rpm'), hasSteering = lap.hasChannel('steering')
  const maxRpm = useMemo(() => {
    const all = (lap.car?.rpm ?? []).filter((v): v is number => v != null)
    return Math.max(7000, Math.ceil(Math.max(0, ...all) / 1000) * 1000)
  }, [lap])
  const gear = useRef<HTMLElement>(null), rpmFill = useRef<HTMLElement>(null), rpmText = useRef<HTMLSpanElement>(null)
  const throttle = useRef<HTMLDivElement>(null), brake = useRef<HTMLDivElement>(null)
  const wheel = useRef<SVGSVGElement>(null), wheelTurn = useRef<SVGGElement>(null)
  useLayoutEffect(() => {
    const write = frameWriter(), labelsDue = labelClock()
    // A bar's fill is scaled from full height (replay.css); its title gives the value.
    const bar = (el: HTMLDivElement | null, value: number | null, label: string, labels: boolean) => {
      write.style(el?.firstElementChild as HTMLElement | null, 'transform', `scaleY(${(Math.min(100, Math.max(0, value ?? 0)) / 100).toFixed(4)})`)
      if (labels) write.attr(el, 'title', `${label} ${value == null ? '—' : Math.round(value) + '%'}`)
    }
    return engine.subscribe(state => {
      const dist = state.pose.dist ?? 0
      const labels = labelsDue(state)
      const g = lap.channel('gear', dist)
      write.text(gear.current, g == null ? '–' : g <= 0 ? 'N' : String(Math.round(g)))
      if (hasRpm) {
        const rpm = lap.channel('rpm', dist)
        write.style(rpmFill.current, 'transform', `scaleX(${Math.min(1, Math.max(0, (rpm ?? 0) / maxRpm)).toFixed(4)})`)
        write.text(rpmText.current, `${rpm == null ? '—' : Math.round(rpm / 10) * 10} rpm`)
      }
      bar(throttle.current, lap.channel('throttle', dist), 'Throttle', labels)
      bar(brake.current, lap.channel('brake', dist), 'Brake', labels)
      if (hasSteering) {
        const steering = lap.channel('steering', dist)
        write.attr(wheelTurn.current, 'transform', `rotate(${(steering ?? 0).toFixed(1)})`)
        if (labels) write.attr(wheel.current, 'aria-label', `Steering ${steering == null ? 'unknown' : Math.round(steering) + '°'}`)
      }
    })
  }, [engine, lap, maxRpm, hasRpm, hasSteering])
  return <div className="replay-hud-inputs">
    <div className="replay-hud-gear"><strong ref={gear} /><span>gear</span></div>
    {hasRpm && <div className="replay-hud-rpm">
      <div className="replay-rpm-track"><i ref={rpmFill} /></div>
      <span ref={rpmText} />
    </div>}
    <div className="replay-bar throttle" ref={throttle}><i /><span>T</span></div>
    <div className="replay-bar brake" ref={brake}><i /><span>B</span></div>
    {hasSteering && <svg className="replay-hud-wheel" viewBox="-20 -20 40 40" ref={wheel}>
      <g ref={wheelTurn}>
        <circle r="16" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="M-16 0H16M0 0V16" stroke="currentColor" strokeWidth="3" />
        <rect x="-1.5" y="-19" width="3" height="5" fill="var(--signal)" />
      </g>
    </svg>}
  </div>
}

// A friction circle oriented like Analysis's G-G chart: the force the driver
// feels, so braking is up and lateral g plots negated (as there).
function GMeter({ engine }: { engine: ReplayEngine }) {
  const svg = useRef<SVGSVGElement>(null), trail = useRef<SVGPolylineElement>(null)
  const dot = useRef<SVGCircleElement>(null), total = useRef<HTMLSpanElement>(null)
  const R = 40, scale = R / 1.5
  useLayoutEffect(() => {
    const write = frameWriter(), labelsDue = labelClock()
    const list: Array<{ t: number; x: number; y: number }> = []
    return engine.subscribe(state => {
      const ax = (state.pose.accelX ?? 0) / G, ay = (state.pose.accelY ?? 0) / G
      const last = list[list.length - 1]
      if (last && (state.timeMs < last.t || state.timeMs - last.t > 600)) list.length = 0
      if (!last || state.timeMs !== last.t) list.push({ t: state.timeMs, x: ay, y: ax })
      while (list.length && list[0].t < state.timeMs - 1500) list.shift()
      write.attr(trail.current, 'points', list.map(p => `${(-p.x * scale).toFixed(1)},${(p.y * scale).toFixed(1)}`).join(' '))
      write.attr(dot.current, 'transform', `translate(${(-ay * scale).toFixed(2)} ${(ax * scale).toFixed(2)})`)
      const g = `${Math.hypot(ax, ay).toFixed(2)} g`
      write.text(total.current, g)
      if (labelsDue(state)) write.attr(svg.current, 'aria-label', g)
    })
  }, [engine, scale])
  return <div className="replay-hud-g">
    <svg viewBox="-46 -46 92 92" ref={svg}>
      {[0.5, 1, 1.5].map(g => <circle key={g} r={g * scale} className={g === 1 ? 'ring one' : 'ring'} />)}
      <path d="M-44 0H44M0 -44V44" className="axis" />
      <polyline ref={trail} className="trail" />
      <circle ref={dot} r="3.6" className="dot" />
    </svg>
    <span ref={total} />
  </div>
}

// The onboard video, picture in picture, held at the 3D car's distance
// (pipSync.ts: nudged in rate on desktop and Android, steady with rare seeks
// on iPhone and iPad).
function PipVideo({ engine, lap, onHide, hideLabel }: { engine: FrameSource; lap: LapPath; onHide: () => void; hideLabel: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [large, setLarge] = useState(false)
  const [covered, setCovered] = useState(true)
  // The browser would not start it without a tap (iOS Low Power Mode, a browser's autoplay setting).
  const [refused, setRefused] = useState(false)
  const refusedRef = useRef(false)
  const car = lap.car!
  const src = api.videoUrl(car.videoId, car.driver)
  const steady = replayProfile().webkitMobile
  // Unmounted, the element lets its media go (a video kept by the browser
  // holds its decoder and buffered data). Development's StrictMode remounts:
  // the source goes back (before the sync below starts it).
  useEffect(() => {
    const el = video.current
    if (!el) return
    if (!el.getAttribute('src')) el.setAttribute('src', src)
    return () => { el.pause(); el.removeAttribute('src'); el.load() }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
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
      // A hidden page's video waits; visibilitychange brings it back in step.
      if (state.playing && !document.hidden) { if (el.paused) play() } else if (!el.paused) el.pause()
      const plan = sync.plan(state, target, el, performance.now())
      if (plan.seekTo != null) { sync.seeking(performance.now()); el.currentTime = plan.seekTo }
      if (plan.rate != null && plan.rate !== el.playbackRate) el.playbackRate = plan.rate
    }
    // A seek that finishes after the replay stopped publishing catches up here.
    const onSeeked = () => { sync.seeked(performance.now(), !!latest?.playing); if (latest) apply(latest) }
    const resync = () => { if (latest) apply(latest) }
    const onVisibility = () => { if (document.hidden) el.pause(); else resync() }
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('loadedmetadata', resync)
    el.addEventListener('canplay', resync)
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = engine.subscribe(apply)
    return () => {
      unsubscribe()
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('loadedmetadata', resync)
      el.removeEventListener('canplay', resync)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [engine, lap, steady])
  // A tap on the video starts it where the browser refused to.
  const tapToPlay = () => { if (refusedRef.current) void video.current?.play().then(() => { refusedRef.current = false; setRefused(false) }, () => {}) }
  return <div className={`replay-pip ${large ? 'large' : ''} ${covered ? '' : 'uncovered'}`}>
    <video ref={video} src={src} muted playsInline preload={steady ? 'metadata' : 'auto'} disablePictureInPicture onClick={tapToPlay} />
    <div className="replay-pip-bar">
      <span>{!covered ? 'Video does not cover this point' : refused ? 'Tap the video to play it' : 'Onboard video'}</span>
      <span className="replay-pip-actions">
        <button type="button" onClick={() => setLarge(v => !v)} aria-label={large ? 'Smaller video' : 'Larger video'} title={large ? 'Smaller video' : 'Larger video'}>{large ? '⤡' : '⤢'}</button>
        <button type="button" onClick={onHide} aria-label={hideLabel} title={hideLabel}>–</button>
      </span>
    </div>
  </div>
}
