// PDR video for one lap, kept in step with the distance charts: playing moves
// the charts' cursor (and the map marker); hovering a chart while paused
// moves the video to that spot.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { CarTrace } from '../../shared/pdr'
import { distanceAt, videoSpan, videoTimeAt } from './carData'
import './video.css'

export interface LapVideoOption { key: string; label: string; trace: CarTrace }

const FOLLOW_KEY = 'catalyst.video.followCursor'
function readFollow(): boolean {
  try { return localStorage.getItem(FOLLOW_KEY) !== '0' } catch { return true }
}

export function LapVideo({ options, selected, onSelect, hoverDistanceM, onHoverDistance, className = '' }: {
  options: LapVideoOption[]
  selected: string | null
  onSelect: (key: string) => void
  hoverDistanceM: number | null
  onHoverDistance: (distM: number | null) => void
  className?: string
}) {
  const option = options.find(o => o.key === selected) ?? options[0]
  const videoRef = useRef<HTMLVideoElement>(null)
  const optionRef = useRef(option)
  optionRef.current = option
  const optionsRef = useRef(options)
  optionsRef.current = options
  // The distance this player last reported, so its own cursor updates do
  // not seek it again.
  const emitted = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(readFollow)
  const [into, setInto] = useState<number | null>(null)
  const src = option ? api.videoUrl(option.trace.videoId) : undefined
  // A different video file mounts a new, paused player.
  useEffect(() => { setPlaying(false); setError(null) }, [src])

  // A newly chosen lap starts at its beginning unless the video is already on it.
  useEffect(() => {
    const video = videoRef.current, span = option && videoSpan(option.trace)
    if (!video || !span) return
    const place = () => { if (video.currentTime < span[0] || video.currentTime > span[1]) video.currentTime = span[0] }
    if (video.readyState >= 1) place()
    else { video.addEventListener('loadedmetadata', place, { once: true }); return () => video.removeEventListener('loadedmetadata', place) }
  }, [option?.key, src])  // eslint-disable-line react-hooks/exhaustive-deps

  // While playing, the video drives the cursor; at the end of a lap it moves
  // on to the next lap in the same video.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const video = videoRef.current, current = optionRef.current
      if (video && current) {
        const t = video.currentTime
        const d = distanceAt(current.trace, t)
        if (d != null) {
          emitted.current = d
          onHoverDistance(d)
          const span = videoSpan(current.trace)
          setInto(span ? t - span[0] : null)
        } else {
          const next = optionsRef.current.find(o => o.trace.videoId === current.trace.videoId && distanceAt(o.trace, t) != null)
          if (next && next.key !== current.key) onSelect(next.key)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, onHoverDistance, onSelect])

  // Paused: a chart cursor moves the video there.
  useEffect(() => {
    const video = videoRef.current
    if (!video || playing || !follow || !option || hoverDistanceM == null || hoverDistanceM === emitted.current) return
    const t = videoTimeAt(option.trace, hoverDistanceM)
    if (t == null) return
    const frame = requestAnimationFrame(() => {
      if (Math.abs(video.currentTime - t) > 0.02) video.currentTime = t
      const span = videoSpan(option.trace)
      setInto(span ? t - span[0] : null)
    })
    return () => cancelAnimationFrame(frame)
  }, [hoverDistanceM, playing, follow, option])

  const toggleFollow = () => {
    setFollow(value => {
      try { localStorage.setItem(FOLLOW_KEY, value ? '0' : '1') } catch { /* per-viewer convenience only */ }
      return !value
    })
  }
  const step = (seconds: number) => { const video = videoRef.current; if (video) video.currentTime = Math.max(0, video.currentTime + seconds) }
  const intoLabel = useMemo(() => {
    if (into == null || !Number.isFinite(into)) return null
    const m = Math.floor(into / 60)
    return `${m}:${(into - m * 60).toFixed(1).padStart(4, '0')} in lap`
  }, [into])

  if (!option) return null
  return (
    <div className={`lap-video ${className}`}>
      <div className="lap-video-bar">
        <span className="channel-tag">VIDEO</span>
        <select aria-label="Lap shown in the video" value={option.key} onChange={e => onSelect(e.target.value)}>
          {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <span className="lap-video-into">{intoLabel}</span>
        <label className="lap-video-follow" title="When paused, hovering a chart moves the video to that spot">
          <input type="checkbox" checked={follow} onChange={toggleFollow} /> Follow cursor
        </label>
      </div>
      <div className="lap-video-frame">
        {error ? <div className="lap-video-error" role="alert">{error}</div> : null}
        <video
          ref={videoRef}
          key={src}
          src={src}
          controls
          playsInline
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setError('This video could not be loaded. It may have been deleted, or this browser cannot play it.')}
          onLoadedData={() => setError(null)}
        />
      </div>
      <div className="lap-video-steps" role="group" aria-label="Step through the video">
        <button type="button" onClick={() => step(-1)}>−1 s</button>
        <button type="button" onClick={() => step(-1 / 30)}>−1 frame</button>
        <button type="button" onClick={() => step(1 / 30)}>+1 frame</button>
        <button type="button" onClick={() => step(1)}>+1 s</button>
      </div>
    </div>
  )
}
