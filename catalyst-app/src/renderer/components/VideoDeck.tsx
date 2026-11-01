// Lap video: one lap, or two side by side or overlaid, kept at the same
// place on track (by distance) and in step with the page's distance charts.
//
// The first lap ("A") drives: playing it moves the charts' cursor, the map
// marker and the second video; hovering a chart (or the track strip) while
// paused moves both videos there. The track strip below shows the corners,
// the time gap between the two laps and where you are; click a corner to
// play it. Other parts of the page ask for a stretch of track through
// videoBus (a corner in Session Review, a heatmap cell in Analysis).

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { api } from '../api'
import type { CarTrace } from '../../shared/pdr'
import {
  distanceAt, gapSeries, lapElapsedAt, lapStartTime, lapTimeAt, pieceAt, pieceSpan, valueAtDistance, type StitchPiece,
} from './carData'
import { onVideoRange, type VideoRangeRequest } from '../videoBus'
import { PALETTE } from './chartTheme'
import './videoDeck.css'

export interface DeckLap {
  key: string
  // In the pickers: "★ L1 · 2:21.577", "Alex · Sep 22 · L3 · 2:18.104".
  label: string
  // On the video: "L1", "Optimal", "Alex L3".
  short: string
  color: string
  trace: CarTrace
  // A stitched lap (the optimal lap): cut from these laps at each split.
  pieces?: StitchPiece[]
}

export interface DeckCorner { turn: string; name: string; apexM: number; startM: number; endM: number }
// One lap; two side by side; the second over the first, see-through
// (overlay) or cut at a handle you drag across (wipe).
export type DeckMode = 'single' | 'side' | 'overlay' | 'wipe'
const MODES: Array<{ mode: DeckMode; label: string; title: string }> = [
  { mode: 'single', label: 'One', title: 'Only the first lap’s video' },
  { mode: 'side', label: 'Side by side', title: 'The two videos next to each other' },
  { mode: 'overlay', label: 'Overlay', title: 'The second lap over the first, see-through' },
  { mode: 'wipe', label: 'Wipe', title: 'The second lap over the first: drag the handle to show more of either' },
]

const FOLLOW_KEY = 'catalyst.video.followCursor'
const MODE_KEY = 'catalyst.video.mode'
const OPACITY_KEY = 'catalyst.video.overlayOpacity'
const WIPE_KEY = 'catalyst.video.wipe'
const unit = (v: number, fallback: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const read = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* per-viewer convenience only */ } }

// A played stretch starts a little before the corner and ends a little after.
const LEAD_M = 40, TAIL_M = 30
const FRAME_S = 1 / 30

const clock = (s: number | null) => {
  if (s == null || !Number.isFinite(s)) return '—'
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}
const signed = (s: number) => `${s > 0 ? '+' : s < 0 ? '−' : '±'}${Math.abs(s).toFixed(2)} s`

export function VideoDeck({ laps, primary, onPrimary, compare, onCompare, hoverDistanceM, onHoverDistance, corners, totalM, speedUnit, defaultMode, wide, onToggleWide, className = '' }: {
  laps: DeckLap[]
  primary: string | null
  onPrimary: (key: string) => void
  compare: string | null
  onCompare: (key: string | null) => void
  hoverDistanceM: number | null
  onHoverDistance: (distM: number | null) => void
  corners: DeckCorner[]
  totalM: number
  speedUnit: string
  // Side by side or overlaid when a comparison is first chosen.
  defaultMode?: DeckMode
  // Analysis: the player can sit beside the map or across the page.
  wide?: boolean
  onToggleWide?: () => void
  className?: string
}) {
  const a = laps.find(l => l.key === primary) ?? laps[0]
  const chosenB = compare ? laps.find(l => l.key === compare && l.key !== a?.key) ?? null : null
  // Two laps in one colour (two of yours in a comparison) are told apart.
  const b = chosenB && a && chosenB.color === a.color ? { ...chosenB, color: a.color === PALETTE.cyan ? PALETTE.purple : PALETTE.cyan } : chosenB
  const [modeChoice, setModeChoice] = useState<DeckMode>(() => (read(MODE_KEY, defaultMode ?? 'side') as DeckMode))
  const mode: DeckMode = b ? modeChoice : 'single'
  const [opacity, setOpacity] = useState(() => Math.min(0.9, Math.max(0.1, Number(read(OPACITY_KEY, '0.5')) || 0.5)))
  // Wipe: where the cut is, 0 (all second lap) to 1 (all first lap).
  const [wipe, setWipe] = useState(() => unit(Number(read(WIPE_KEY, '0.5')), 0.5))
  const stageRef = useRef<HTMLDivElement>(null)
  const wiping = useRef(false)
  const moveWipe = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0) setWipe(unit((clientX - rect.left) / rect.width, 0.5))
  }
  const [follow, setFollow] = useState(() => read(FOLLOW_KEY, '1') !== '0')
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [muted, setMuted] = useState(true)
  const [pos, setPos] = useState<number | null>(null)
  const [badge, setBadge] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ a?: string; b?: string }>({})

  const rootRef = useRef<HTMLDivElement>(null)
  const videoA = useRef<HTMLVideoElement>(null)
  const videoB = useRef<HTMLVideoElement>(null)
  const aRef = useRef(a), bRef = useRef(b), lapsRef = useRef(laps)
  aRef.current = a; bRef.current = b; lapsRef.current = laps
  // Opens where the charts are (the player moves between panes in Analysis).
  const posRef = useRef<number | null>(hoverDistanceM)
  // The distance this player last reported, so its own cursor updates do
  // not seek it again.
  const emitted = useRef<number | null>(null)
  // Stitched lap: the piece being played.
  const piece = useRef(0)
  // Playing a stretch: where to stop.
  const range = useRef<{ endM: number } | null>(null)
  // A request for another lap waits until that lap's video is ready.
  const pending = useRef<VideoRangeRequest | null>(null)

  const srcA = a ? api.videoUrl(a.trace.videoId, a.trace.driver) : undefined
  const srcB = b ? api.videoUrl(b.trace.videoId, b.trace.driver) : undefined

  const place = useCallback((distM: number) => {
    posRef.current = distM
    setPos(distM)
    const va = videoA.current, lapA = aRef.current
    if (va && lapA) {
      const t = lapTimeAt(lapA, distM)
      if (lapA.pieces) piece.current = pieceAt(lapA.pieces, distM)
      if (t != null && va.readyState >= 1 && Math.abs(va.currentTime - t) > 0.02) va.currentTime = t
    }
    const vb = videoB.current, lapB = bRef.current
    if (vb && lapB) {
      const t = lapTimeAt(lapB, distM)
      if (t != null && vb.readyState >= 1 && Math.abs(vb.currentTime - t) > 0.02) vb.currentTime = t
    }
  }, [])

  const startRange = useCallback((request: VideoRangeRequest) => {
    const lapA = aRef.current
    if (!lapA) return
    const first = lapA.trace.dist[0] ?? 0
    place(Math.max(first, request.startM - LEAD_M))
    range.current = { endM: request.endM + TAIL_M }
    setBadge(request.label ?? null)
    rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (request.play) void videoA.current?.play().catch(() => {})
  }, [place])

  // A newly chosen first lap: the same place on track, or its start.
  useEffect(() => {
    const va = videoA.current
    if (!va || !a) return
    setErrors(e => ({ ...e, a: undefined }))
    const go = () => {
      if (pending.current) { const request = pending.current; pending.current = null; startRange(request); return }
      const here = posRef.current
      const t = here != null ? lapTimeAt(a, here) : null
      if (here != null && t != null) place(here)
      else {
        piece.current = 0
        const start = lapStartTime(a)
        if (start != null) va.currentTime = start
        const d0 = a.trace.dist[0] ?? 0
        posRef.current = d0; setPos(d0)
      }
    }
    if (va.readyState >= 1) go()
    else { va.addEventListener('loadedmetadata', go, { once: true }); return () => va.removeEventListener('loadedmetadata', go) }
  }, [a?.key, srcA])  // eslint-disable-line react-hooks/exhaustive-deps

  // A newly chosen second lap joins at the same place.
  useEffect(() => {
    const vb = videoB.current
    if (!vb || !b) return
    setErrors(e => ({ ...e, b: undefined }))
    const go = () => {
      const t = lapTimeAt(b, posRef.current ?? b.trace.dist[0] ?? 0)
      if (t != null) vb.currentTime = t
      if (videoA.current && !videoA.current.paused) void vb.play().catch(() => {})
    }
    if (vb.readyState >= 1) go()
    else { vb.addEventListener('loadedmetadata', go, { once: true }); return () => vb.removeEventListener('loadedmetadata', go) }
  }, [b?.key, srcB])  // eslint-disable-line react-hooks/exhaustive-deps

  // Other parts of the page asking for a stretch of track.
  useEffect(() => onVideoRange(request => {
    const target = request.lapKey ? lapsRef.current.find(l => l.key === request.lapKey) : null
    if (target && target.key !== aRef.current?.key) { pending.current = request; onPrimary(target.key); return }
    startRange(request.lapKey && !target ? { ...request, label: `${request.label ?? 'That lap'} has no video · showing ${aRef.current?.short}` } : request)
  }), [onPrimary, startRange])

  // While playing, the first video drives everything.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const follow = (distM: number, rateA: number) => {
      const vb = videoB.current, lapB = bRef.current, lapA = aRef.current
      if (!vb || !lapB || !lapA || vb.readyState < 1) return
      const target = lapTimeAt(lapB, distM)
      if (target == null) { if (!vb.paused) vb.pause(); return }
      if (vb.paused) void vb.play().catch(() => {})
      const error = target - vb.currentTime
      if (Math.abs(error) > 0.35) { vb.currentTime = target; vb.playbackRate = rateA; return }
      // At the same place the slower car's video must run slower.
      const sa = valueAtDistance(lapA.trace, 'speed', distM), sb = valueAtDistance(lapB.trace, 'speed', distM)
      const ratio = sa && sb && sa > 5 && sb > 5 ? sa / sb : 1
      vb.playbackRate = Math.min(4, Math.max(0.25, rateA * ratio + error * 1.5))
    }
    const tick = () => {
      const va = videoA.current, lapA = aRef.current
      if (va && lapA) {
        const t = va.currentTime
        let d: number | null = null
        if (lapA.pieces) {
          // Stitched: follow the piece; at its end, cut to the next one.
          const pieces = lapA.pieces
          const p = pieces[piece.current] ?? pieces[0]
          const span = pieceSpan(p)
          const at = distanceAt(p.trace, t)
          if (span && t >= span[1] - 0.02 && t <= span[1] + 1) {
            const next = pieces[piece.current + 1]
            if (!next) { va.pause(); range.current = null }
            else {
              piece.current += 1
              const nextSpan = pieceSpan(next)
              if (nextSpan && next.trace !== p.trace) va.currentTime = nextSpan[0]
            }
          } else if (at != null && at >= p.startM - 1 && at < p.endM) d = at
          else {
            const found = pieces.findIndex(q => { const s = pieceSpan(q); return !!s && t >= s[0] && t < s[1] })
            if (found >= 0) piece.current = found
          }
        } else {
          d = distanceAt(lapA.trace, t)
          if (d == null) {
            // Past the lap: on to the next lap in the same video.
            const next = lapsRef.current.find(o => !o.pieces && o.trace.videoId === lapA.trace.videoId && o.trace.driver === lapA.trace.driver && distanceAt(o.trace, t) != null)
            if (next && next.key !== lapA.key) onPrimary(next.key)
          }
        }
        if (d != null) {
          if (range.current && d >= range.current.endM) { va.pause(); range.current = null }
          emitted.current = d
          posRef.current = d
          setPos(d)
          onHoverDistance(d)
          follow(d, va.playbackRate)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, onHoverDistance, onPrimary])

  // Paused: a chart cursor moves the videos there.
  useEffect(() => {
    if (playing || !follow || hoverDistanceM == null || hoverDistanceM === emitted.current) return
    const frame = requestAnimationFrame(() => place(hoverDistanceM))
    return () => cancelAnimationFrame(frame)
  }, [hoverDistanceM, playing, follow, place])

  useEffect(() => { if (videoA.current) videoA.current.playbackRate = rate }, [rate, srcA])

  // Readouts for the HUD and the strip.
  const d = pos
  const corner = d == null ? null : corners.find(c => d >= c.startM && d <= c.endM) ?? null
  const elapsedA = a && d != null ? lapElapsedAt(a, d) : null
  const elapsedB = b && d != null ? lapElapsedAt(b, d) : null
  const gap = elapsedA != null && elapsedB != null ? elapsedB - elapsedA : null
  const speedA = a && d != null ? valueAtDistance(a.trace, 'speed', d) : null
  const speedB = b && d != null ? valueAtDistance(b.trace, 'speed', d) : null
  const gaps = useMemo(() => (a && b ? gapSeries(a, b) : null), [a, b])

  const toggle = () => {
    const va = videoA.current
    if (!va) return
    if (va.paused) { range.current = null; setBadge(null); void va.play().catch(() => {}) } else va.pause()
  }
  const step = (seconds: number) => {
    const va = videoA.current
    if (!va) return
    va.pause()
    va.currentTime = Math.max(0, va.currentTime + seconds)
    const lapA = aRef.current
    const at = lapA && !lapA.pieces ? distanceAt(lapA.trace, va.currentTime) : null
    if (at != null) { place(at); onHoverDistance(at) }
  }
  const jumpCorner = (dir: 1 | -1) => {
    const here = posRef.current ?? 0
    const sorted = [...corners].sort((x, y) => x.startM - y.startM)
    const next = dir > 0 ? sorted.find(c => c.startM > here + 5) : [...sorted].reverse().find(c => c.startM < here - 5)
    if (!next) return
    videoA.current?.pause()
    place(Math.max(0, next.startM - LEAD_M))
    onHoverDistance(next.apexM)
  }
  const playCorner = (c: DeckCorner) => startRange({ startM: c.startM, endM: c.endM, label: `${c.turn}${c.name ? ` · ${c.name}` : ''}`, play: true })
  const scrub = (distM: number) => { videoA.current?.pause(); place(distM); onHoverDistance(distM) }
  const fullscreen = () => {
    const el = rootRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.().catch(() => {})
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('select, input, button')) return
    if (e.key === ' ') { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 1 : FRAME_S) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -1 : -FRAME_S) }
    else if (e.key === ']') jumpCorner(1)
    else if (e.key === '[') jumpCorner(-1)
  }

  if (!a) return null
  const chooseMode = (m: DeckMode) => { setModeChoice(m); write(MODE_KEY, m) }

  return <div ref={rootRef} className={`deck mode-${mode}${wide ? ' is-wide' : ''} ${className}`} tabIndex={-1} onKeyDown={onKey}
    aria-label="Lap video. Space plays or pauses; arrow keys step a frame (Shift: a second); [ and ] jump between corners.">
    <div className="deck-bar">
      <label className="deck-pick" style={{ ['--lap' as string]: a.color }}>
        <span className="sr-only">Lap shown</span>
        <select value={a.key} onChange={e => onPrimary(e.target.value)}>
          {laps.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select>
      </label>
      <span className="deck-vs">vs</span>
      <label className={`deck-pick${b ? '' : ' empty'}`} style={{ ['--lap' as string]: b?.color ?? 'var(--border-strong)' }}>
        <span className="sr-only">Compare with</span>
        <select value={b?.key ?? ''} onChange={e => onCompare(e.target.value || null)}>
          <option value="">No comparison</option>
          {laps.filter(l => l.key !== a.key).map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select>
      </label>
      {b && <div className="deck-modes" role="group" aria-label="How to show the two laps">
        {MODES.map(m => <button key={m.mode} type="button" title={m.title} className={modeChoice === m.mode ? 'active' : ''} aria-pressed={modeChoice === m.mode} onClick={() => chooseMode(m.mode)}>
          {m.label}
        </button>)}
      </div>}
      {b && <button type="button" className="deck-icon" title="Swap the two laps" aria-label="Swap the two laps" onClick={() => { const next = a.key; onPrimary(b.key); onCompare(next) }}>⇄</button>}
      {onToggleWide && <button type="button" className="deck-icon" title={wide ? 'Back beside the map' : 'Across the page'} aria-label={wide ? 'Put the video beside the map' : 'Put the video across the page'} onClick={onToggleWide}>{wide ? '⇥' : '⤢'}</button>}
    </div>

    <div className="deck-stage" ref={stageRef}>
      <div className="deck-screen a" style={{ ['--lap' as string]: a.color }}>
        <video ref={videoA} key={srcA} src={srcA} playsInline preload="metadata" muted={muted}
          onPlay={() => { setPlaying(true); if (videoB.current && bRef.current) void videoB.current.play().catch(() => {}) }}
          onPause={() => { setPlaying(false); videoB.current?.pause() }}
          onEnded={() => setPlaying(false)}
          onClick={toggle}
          onError={() => setErrors(e => ({ ...e, a: 'This video could not be loaded. It may have been deleted, or this browser cannot play it.' }))} />
        <Hud lap={a} speed={speedA} speedUnit={speedUnit} elapsed={elapsedA} />
        {errors.a && <div className="deck-error" role="alert">{errors.a}</div>}
      </div>
      {b && <div className="deck-screen b" style={{ ['--lap' as string]: b.color }} hidden={mode === 'single'}>
        <video ref={videoB} key={srcB} src={srcB} playsInline preload="metadata" muted onClick={toggle}
          style={mode === 'overlay' ? { opacity } : mode === 'wipe' ? { clipPath: `inset(0 0 0 ${(wipe * 100).toFixed(2)}%)` } : undefined}
          onError={() => setErrors(e => ({ ...e, b: `${b.short}’s video could not be loaded.` }))} />
        <Hud lap={b} speed={speedB} speedUnit={speedUnit} elapsed={elapsedB} gap={gap} against={a.short} />
        {errors.b && <div className="deck-error" role="alert">{errors.b}</div>}
      </div>}
      {(corner || badge) && <div className="deck-corner" aria-live="polite">{badge ?? `${corner!.turn}${corner!.name ? ` · ${corner!.name}` : ''}`}</div>}
      {!playing && <button type="button" className="deck-bigplay" aria-label="Play" onClick={toggle}>▶</button>}
      {b && mode === 'wipe' && <div className="deck-wipe" style={{ left: `${wipe * 100}%` }}
        role="slider" tabIndex={0} aria-label={`Wipe between ${a.short} (left) and ${b.short} (right)`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(wipe * 100)}
        onPointerDown={e => { e.preventDefault(); wiping.current = true; e.currentTarget.setPointerCapture(e.pointerId); moveWipe(e.clientX) }}
        onPointerMove={e => { if (wiping.current) moveWipe(e.clientX) }}
        onPointerUp={() => { wiping.current = false; setWipe(w => { write(WIPE_KEY, String(w)); return w }) }}
        onKeyDown={e => {
          const step = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0
          if (!step) return
          e.preventDefault(); e.stopPropagation()
          setWipe(w => { const v = unit(w + step, 0.5); write(WIPE_KEY, String(v)); return v })
        }}>
        <span className="deck-wipe-knob" aria-hidden="true">⟷</span>
      </div>}
      {b && mode === 'overlay' && <label className="deck-blend" title={`How much of ${b.short} shows over ${a.short}`}>
        <span><i style={{ background: a.color }} />{a.short}</span>
        <input type="range" min={10} max={90} step={5} value={Math.round(opacity * 100)}
          onChange={e => { const v = Number(e.target.value) / 100; setOpacity(v); write(OPACITY_KEY, String(v)) }} />
        <span>{b.short}<i style={{ background: b.color }} /></span>
      </label>}
    </div>

    <TrackStrip totalM={totalM} corners={corners} pos={d} gaps={gaps} colors={[a.color, b?.color ?? a.color]} names={[a.short, b?.short ?? '']}
      onScrub={scrub} onCorner={playCorner} />

    <div className="deck-controls">
      <button type="button" className="deck-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
      <div className="deck-steps" role="group" aria-label="Step through the video">
        <button type="button" onClick={() => jumpCorner(-1)} title="Previous corner ([)">⏮</button>
        <button type="button" onClick={() => step(-1)} title="Back a second (Shift ←)">−1s</button>
        <button type="button" onClick={() => step(-FRAME_S)} title="Back a frame (←)">‹</button>
        <button type="button" onClick={() => step(FRAME_S)} title="Forward a frame (→)">›</button>
        <button type="button" onClick={() => step(1)} title="Forward a second (Shift →)">+1s</button>
        <button type="button" onClick={() => jumpCorner(1)} title="Next corner (])">⏭</button>
      </div>
      <span className="deck-readout">
        <b>{clock(elapsedA)}</b> in lap · {d == null ? '—' : `${Math.round(d)} m`}
        {gap != null && <> · <span style={{ color: b!.color }}>{b!.short}</span> {signed(gap)}</>}
      </span>
      <div className="deck-tools">
        <select aria-label="Playback speed" value={rate} onChange={e => setRate(Number(e.target.value))}>
          {[0.25, 0.5, 1].map(r => <option key={r} value={r}>{r}×</option>)}
        </select>
        <button type="button" className="deck-icon" onClick={() => setMuted(m => !m)} aria-pressed={!muted} title={muted ? 'Sound on' : 'Sound off'}>{muted ? '🔇' : '🔊'}</button>
        <label className="deck-follow" title="When paused, hovering a chart moves the video there">
          <input type="checkbox" checked={follow} onChange={() => setFollow(v => { write(FOLLOW_KEY, v ? '0' : '1'); return !v })} /> Follow charts
        </label>
        <button type="button" className="deck-icon" onClick={fullscreen} title="Full screen" aria-label="Full screen">⛶</button>
      </div>
    </div>
  </div>
}

function Hud({ lap, speed, speedUnit, elapsed, gap, against }: { lap: DeckLap; speed: number | null; speedUnit: string; elapsed: number | null; gap?: number | null; against?: string }) {
  return <div className="deck-hud">
    <span className="deck-hud-lap"><i />{lap.short}</span>
    <span className="deck-hud-speed">{speed == null ? '—' : Math.round(speed)}<small>{speedUnit}</small></span>
    <span className="deck-hud-time">{clock(elapsed)}</span>
    {gap != null && <span className={`deck-hud-gap ${gap > 0.005 ? 'behind' : gap < -0.005 ? 'ahead' : ''}`} title={`Time behind ${against} at this point`}>{signed(gap)}</span>}
  </div>
}

/**
 * The lap as a strip: corners (click one to play it), the time gap between
 * the two laps (above the line: the second lap is behind) and where the
 * video is. Click or drag to move there.
 */
function TrackStrip({ totalM, corners, pos, gaps, colors, names, onScrub, onCorner }: {
  totalM: number
  corners: DeckCorner[]
  pos: number | null
  gaps: { xs: number[]; ys: number[] } | null
  colors: [string, string]
  names: [string, string]
  onScrub: (distM: number) => void
  onCorner: (corner: DeckCorner) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState<number | null>(null)
  const dragging = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(120, entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const total = totalM > 0 ? totalM : Math.max(1, ...corners.map(c => c.endM), ...(gaps?.xs ?? [1]))
  const x = (m: number) => (m / total) * width
  const toM = (e: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(total, ((e.clientX - rect.left) / rect.width) * total))
  }
  const sorted = useMemo(() => [...corners].sort((p, q) => p.apexM - q.apexM), [corners])
  // Labels that fit: at least 22 px apart.
  const labelled = useMemo(() => {
    let last = -Infinity
    return sorted.filter(c => { const cx = (c.apexM / total) * width; if (cx - last < 22) return false; last = cx; return true })
  }, [sorted, total, width])

  const GAP_Y = 22, GAP_H = 15, BAR_Y = 42
  let gapPath: { ahead: string; behind: string; max: number } | null = null
  if (gaps && gaps.xs.length > 1) {
    const max = Math.max(0.2, ...gaps.ys.map(Math.abs))
    const y = (v: number) => GAP_Y - (v / max) * GAP_H
    const area = (sign: 1 | -1) => `M${x(gaps.xs[0])},${GAP_Y} ` + gaps.xs.map((m, i) => `L${x(m).toFixed(1)},${y(sign > 0 ? Math.max(0, gaps.ys[i]) : Math.min(0, gaps.ys[i])).toFixed(1)}`).join(' ') + ` L${x(gaps.xs[gaps.xs.length - 1])},${GAP_Y} Z`
    gapPath = { behind: area(1), ahead: area(-1), max }
  }
  const hoverCorner = hover == null ? null : corners.find(c => hover >= c.startM && hover <= c.endM)

  return <div className="deck-strip" ref={ref}
    onPointerDown={e => { if ((e.target as Element).closest('.strip-corner-hit')) return; dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onScrub(toM(e)) }}
    onPointerMove={e => { const m = toM(e); setHover(m); if (dragging.current) onScrub(m) }}
    onPointerUp={() => { dragging.current = false }}
    onPointerLeave={() => { setHover(null) }}>
    <svg width={width} height={56} role="img" aria-label="The lap: corners, time gap and position">
      {gapPath && <g className="strip-gap">
        <line x1={0} x2={width} y1={GAP_Y} y2={GAP_Y} />
        <path d={gapPath.behind} style={{ fill: colors[0] }} />
        <path d={gapPath.ahead} style={{ fill: colors[1] }} />
      </g>}
      <rect className="strip-track" x={0} y={BAR_Y} width={width} height={8} rx={2} />
      {sorted.map(c => <g key={c.turn} className="strip-corner">
        <rect x={x(c.startM)} y={BAR_Y - 2} width={Math.max(2, x(c.endM) - x(c.startM))} height={12} rx={2} />
      </g>)}
      {labelled.map(c => <g key={`l-${c.turn}`} className="strip-corner-hit" onClick={() => onCorner(c)}>
        <title>{`Play ${c.turn}${c.name ? ` · ${c.name}` : ''}`}</title>
        <rect x={x(c.apexM) - 11} y={0} width={22} height={14} fill="transparent" />
        <text x={x(c.apexM)} y={10} textAnchor="middle">{c.turn.replace(/^T/, '')}</text>
      </g>)}
      {pos != null && <g className="strip-needle"><line x1={x(pos)} x2={x(pos)} y1={13} y2={56} /><circle cx={x(pos)} cy={BAR_Y + 4} r={4} /></g>}
      {hover != null && <line className="strip-hover" x1={x(hover)} x2={x(hover)} y1={13} y2={56} />}
    </svg>
    <div className="deck-strip-meta">
      {hover != null ? <span>{Math.round(hover)} m{hoverCorner ? ` · ${hoverCorner.turn}${hoverCorner.name ? ` ${hoverCorner.name}` : ''}` : ''}</span>
        : <span className="muted">Click a corner number to play it · click or drag to move</span>}
      {gapPath && <span className="muted">gap: <i style={{ background: colors[0] }} /> {names[0]} ahead · <i style={{ background: colors[1] }} /> {names[1]} ahead</span>}
    </div>
  </div>
}
