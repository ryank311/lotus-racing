// PDR video import: the picker button, the upload queue, and the library of
// videos on the account with their session, sync and actions.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, humaniseBytes } from '../api'
import { NavLink } from '../navigation'
import { routeUrl, segment } from '../routes'
import { startLabel } from './reviewTimeline'
import { cancelVideoUpload, clearFinishedUploads, onVideoImported, queueVideoUploads, useVideoUploads, type VideoUpload } from '../videoUploads'
import type { SessionVideo } from '../../shared/pdr'
import type { DbSessionRow } from '../../shared/types'
import './video.css'

/** Opens the file picker for one or more PDR videos and queues them. */
export function VideoPickerButton({ sessionGuid = null, className = 'btn primary', children = 'Import PDR videos', onSkipped }: {
  sessionGuid?: string | null
  className?: string
  children?: ReactNode
  onSkipped?: (names: string[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" className={className} onClick={() => input.current?.click()}>{children}</button>
    <input ref={input} type="file" accept="video/mp4,.mp4,.MP4,.mov" multiple hidden
      onChange={e => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        const skipped = queueVideoUploads(files, sessionGuid)
        if (skipped.length) onSkipped?.(skipped)
      }} />
  </>
}

/** Accepts videos dropped onto its children. */
export function VideoDropZone({ sessionGuid = null, children, onSkipped }: { sessionGuid?: string | null; children: ReactNode; onSkipped?: (names: string[]) => void }) {
  const [over, setOver] = useState(false)
  return <div className={`video-drop-zone${over ? ' is-over' : ''}`}
    onDragOver={e => { e.preventDefault(); setOver(true) }}
    onDragLeave={() => setOver(false)}
    onDrop={e => {
      e.preventDefault(); setOver(false)
      const skipped = queueVideoUploads(Array.from(e.dataTransfer.files), sessionGuid)
      if (skipped.length) onSkipped?.(skipped)
    }}>
    {children}
  </div>
}

const phaseLabel: Record<VideoUpload['phase'], string> = {
  waiting: 'Waiting', uploading: 'Uploading', matching: 'Finding its session…', done: 'Imported', failed: 'Failed', cancelled: 'Cancelled',
}

/** Uploads in this browser tab, newest last: all, or only PDR or Catalyst ones. */
export function UploadQueue({ compact = false, only }: { compact?: boolean; only?: 'pdr' | 'catalyst' }) {
  const all = useVideoUploads()
  const uploads = only ? all.filter(u => (only === 'catalyst') === !!u.catalystPath) : all
  if (!uploads.length) return null
  const finished = uploads.some(u => u.phase === 'done' || u.phase === 'failed' || u.phase === 'cancelled')
  return <div className={`upload-queue${compact ? ' compact' : ''}`} aria-live="polite">
    {uploads.map(u => {
      const pct = u.size ? Math.round(u.sent / u.size * 100) : 0
      const result = u.result
      const tone = u.phase === 'failed' ? 'loss' : u.phase === 'done' ? (result?.matched ? 'gain' : 'reference') : ''
      return <div key={u.key} className={`upload-row phase-${u.phase}`}>
        <div className="upload-row-head">
          <strong title={u.fileName}>{u.fileName}</strong>
          <span className="muted">{humaniseBytes(u.size)}</span>
          <span className={`upload-phase ${tone}`}>{u.phase === 'uploading' ? `${phaseLabel.uploading} ${pct}%` : u.phase === 'done' && result && !result.matched ? 'Kept · not matched' : phaseLabel[u.phase]}</span>
          {(u.phase === 'waiting' || u.phase === 'uploading') && <button type="button" className="btn ghost small" onClick={() => cancelVideoUpload(u.key)}>Cancel</button>}
        </div>
        {(u.phase === 'uploading' || u.phase === 'matching') && <div className="upload-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${u.phase === 'matching' ? 100 : pct}%` }} className={u.phase === 'matching' ? 'indeterminate' : ''} /></div>}
        {u.phase === 'failed' && <p className="loss small">{u.error}</p>}
        {result && <p className="small">
          {result.message}
          {result.matched && result.video.sessionGuid && <> · <NavLink to={`/review/${segment(result.video.sessionGuid)}`}>Session Review</NavLink> · <NavLink to={routeUrl('/analysis', { session: [result.video.sessionGuid] })}>Analysis</NavLink></>}
        </p>}
      </div>
    })}
    {finished && <button type="button" className="btn ghost small" onClick={() => clearFinishedUploads(only)}>Clear finished</button>}
  </div>
}

const minutes = (s: number) => {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')}`
}

export function alignmentLabel(video: SessionVideo): string {
  if (video.offsetS == null) return 'Not synced'
  const how = video.alignment === 'manual' ? 'adjusted by hand'
    : video.alignment === 'position' ? `GPS match${video.alignmentError != null ? ` ±${video.alignmentError.toFixed(1)} m` : ''}`
    : video.alignment === 'clock' ? 'Catalyst clock'
    : 'speed match'
  return `${how}`
}

/** Nudge a video's sync against the Garmin laps. */
export function VideoSyncControls({ video, onChange }: { video: SessionVideo; onChange: (video: SessionVideo) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (video.offsetS == null) return null
  const nudge = async (value: number | null) => {
    setBusy(true); setError('')
    try { onChange(await api.setVideoOffset(video.id, value)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const offset = video.offsetS
  return <div className="video-sync" title="If the video runs ahead of the charts, move it later; if it lags, move it earlier.">
    <span className="muted small">Sync · {alignmentLabel(video)}</span>
    <div className="video-sync-buttons" role="group" aria-label={`Adjust sync for ${video.fileName}`}>
      {[-0.5, -0.1, 0.1, 0.5].map(step => <button key={step} type="button" className="btn ghost small" disabled={busy}
        onClick={() => void nudge(Math.round((offset - step) * 1000) / 1000)}>{step < 0 ? `Video ${step} s` : `Video +${step} s`}</button>)}
      {video.alignment === 'manual' && <button type="button" className="btn ghost small" disabled={busy} onClick={() => void nudge(null)}>Reset</button>}
    </div>
    {error && <p className="loss small" role="alert">{error}</p>}
  </div>
}

// "Virginia International Raceway" → "VIR"; short names stay as they are.
function shortTrack(name: string | null | undefined): string {
  const words = (name ?? '').split(/\s+/).filter(Boolean)
  return words.length >= 3 ? words.map(w => w[0]).join('').toUpperCase() : words.join(' ')
}

// [1, 2, 3, 6] → "L2–L4, L7"
function lapRanges(laps: number[]): string {
  const sorted = [...laps].sort((a, b) => a - b)
  const runs: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    runs.push(j > i ? `L${sorted[i] + 1}–L${sorted[j] + 1}` : `L${sorted[i] + 1}`)
    i = j
  }
  return runs.join(', ')
}

const SOURCE_TAG: Record<SessionVideo['source'], string> = { pdr: 'PDR', catalyst: 'Catalyst', 'catalyst-optimal': 'Optimal' }

/** Every video on the account, one row each; a row opens to its details and actions. */
export function VideoLibrary() {
  const [videos, setVideos] = useState<SessionVideo[] | null>(null)
  const [sessions, setSessions] = useState<DbSessionRow[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const load = async () => {
    try { setVideos(await api.listVideos()); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => {
    void load()
    void api.listSessions().then(setSessions).catch(() => {})
    return onVideoImported(() => void load())
  }, [])
  const replace = (video: SessionVideo) => setVideos(list => list?.map(v => (v.id === video.id ? video : v)) ?? null)
  const match = async (video: SessionVideo, sessionGuid: string | null) => {
    setBusy(video.id)
    try {
      const result = await api.matchVideo(video.id, sessionGuid)
      setNotes(n => ({ ...n, [video.id]: result.message }))
      await load()
    } catch (e) { setNotes(n => ({ ...n, [video.id]: e instanceof Error ? e.message : String(e) })) } finally { setBusy(null) }
  }
  const remove = async (video: SessionVideo) => {
    if (!window.confirm(`Delete ${video.fileName} and its car data from your account? This cannot be undone.`)) return
    setBusy(video.id)
    try { await api.deleteVideo(video.id); await load() } catch (e) { setNotes(n => ({ ...n, [video.id]: e instanceof Error ? e.message : String(e) })) } finally { setBusy(null) }
  }
  if (error) return <p className="loss" role="alert">{error} <button className="btn ghost small" onClick={() => void load()}>Retry</button></p>
  if (!videos) return <p className="muted">Loading your videos…</p>
  if (!videos.length) return <p className="muted">No videos yet. Imported videos appear here with the session each one was matched to.</p>
  const totalBytes = videos.reduce((n, v) => n + v.sizeBytes, 0)
  const unmatched = videos.filter(v => !v.sessionGuid).length
  return <div className="video-library">
    <p className="muted small">{videos.length} video{videos.length === 1 ? '' : 's'} · {humaniseBytes(totalBytes)}{unmatched ? ` · ${unmatched} not matched` : ''}</p>
    <div className="video-list" role="list">
      {videos.map(video => {
        const s = video.session
        const when = startLabel(s?.start ?? video.recordedAt)
        const where = video.sessionGuid ? [shortTrack(s?.track), s?.layout].filter(Boolean).join(' · ') || 'Unknown track' : 'Not matched'
        const covers = video.source === 'catalyst-optimal' ? 'Optimal lap' : video.laps.length ? lapRanges(video.laps) : video.sessionGuid ? 'No full laps' : ''
        // Sessions on the same day as the recording, for attaching by hand.
        const day = (s?.start ?? video.recordedAt)?.slice(0, 10)
        const sameDay = sessions.filter(row => day && row.session_start?.startsWith(day))
        return <details key={video.id} className={`video-row${video.sessionGuid ? '' : ' unmatched'}`} role="listitem">
          <summary>
            <span className={`video-source source-${video.source}`}>{SOURCE_TAG[video.source] ?? video.source}</span>
            <span className="video-when">{when}</span>
            <span className="video-where" title={video.sessionGuid ? [s?.track, s?.layout].filter(Boolean).join(' · ') : video.matchNote ?? undefined}>{where}</span>
            <span className="video-laps">{covers}</span>
            <span className="video-length">{minutes(video.durationS)}</span>
          </summary>
          <div className="video-row-body">
            <dl className="video-facts">
              <div><dt>File</dt><dd>{video.fileName}{video.sourcePath ? <span className="muted"> · {video.sourcePath}</span> : null}</dd></div>
              <div><dt>Session</dt><dd>{video.sessionGuid ? `${[s?.track, s?.layout].filter(Boolean).join(' · ') || 'Unknown track'} · ${startLabel(s?.start)}` : <span className="reference">Not matched{video.matchNote ? ` — ${video.matchNote}` : ''}</span>}</dd></div>
              <div><dt>Recorded</dt><dd>{video.recordedAt ? startLabel(video.recordedAt) : '—'} · {minutes(video.durationS)} · {humaniseBytes(video.sizeBytes)}{video.height ? ` · ${video.height}p` : ''}</dd></div>
              {video.sessionGuid && video.matchNote && <div><dt>Note</dt><dd className="reference">{video.matchNote}</dd></div>}
            </dl>
            <VideoSyncControls video={video} onChange={replace} />
            <div className="video-row-actions">
              {video.sessionGuid && <NavLink className="btn ghost small" to={`/review/${segment(video.sessionGuid)}`}>Session Review</NavLink>}
              {video.sessionGuid && <NavLink className="btn ghost small" to={routeUrl('/analysis', { session: [video.sessionGuid] })}>Analysis</NavLink>}
              <button type="button" className="btn ghost small" disabled={busy === video.id} onClick={() => void match(video, null)}>{busy === video.id ? 'Working…' : 'Match again'}</button>
              {sameDay.length > 0 && <select className="video-assign" aria-label={`Attach ${video.fileName} to a session`} value="" disabled={busy === video.id}
                onChange={e => { if (e.target.value) void match(video, e.target.value) }}>
                <option value="">{video.sessionGuid ? 'Attach to another session…' : 'Attach to a session…'}</option>
                {sameDay.map(row => <option key={row.session_guid} value={row.session_guid}>{startLabel(row.session_start)} · {[shortTrack(row.track_name), row.track_configuration_name].filter(Boolean).join(' · ')}{row.vehicle_model ? ` · ${row.vehicle_model}` : ''}</option>)}
              </select>}
              <button type="button" className="btn ghost small danger" disabled={busy === video.id} onClick={() => void remove(video)}>Delete</button>
            </div>
            {notes[video.id] && <p className="small" role="status">{notes[video.id]}</p>}
          </div>
        </details>
      })}
    </div>
  </div>
}
