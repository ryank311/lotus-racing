// Import page: Garmin Catalyst videos. The driver picks the device's
// RaceData folder; each recording is matched to its synced session from the
// folder's track, car and clock. Recordings are chosen a day at a time (or
// one by one inside a day) and upload one file at a time.
//
// Only the session recordings (video_N.mp4) are offered: Garmin's
// optimal-lap render is rebuilt from your own laps in Session Review.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, humaniseBytes } from '../api'
import { NavLink } from '../navigation'
import { segment } from '../routes'
import { cancelVideoUpload, onVideoImported, queueCatalystUploads, useVideoUploads, type VideoUpload } from '../videoUploads'
import { catalystVideoName, parseCatalystPath, type CatalystPlan, type CatalystPlanFile, type CatalystPlanFolder } from '../../shared/catalystVideo'
import './catalystImport.css'

const DEVICE_FOLDER = '~/Library/CloudStorage/MacDroid-Catalyst/<SD card>/Android/data/com.garmin.racingcoach/files/RaceData'

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const yearLabel = (day: string) => day.slice(0, 4)
const dayName = (day: string) => dayLabel.format(new Date(`${day}T00:00:00Z`))
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const active = (u: VideoUpload | undefined) => !!u && (u.phase === 'waiting' || u.phase === 'uploading' || u.phase === 'matching')

type RecordingState = 'new' | 'imported' | 'no-session' | 'queued' | 'uploading' | 'failed'

interface Recording {
  folder: CatalystPlanFolder
  // The session video, in parts (video_1, video_2…).
  parts: CatalystPlanFile[]
  // Bytes still to upload (all parts not yet imported).
  bytes: number
  state: RecordingState
  // Upload progress over the recording's remaining parts, 0–1.
  progress: number | null
  error: string | null
}

interface Day { day: string; where: string; recordings: Recording[] }

function recordingState(folder: CatalystPlanFolder, parts: CatalystPlanFile[], uploads: Map<string, VideoUpload>): Pick<Recording, 'state' | 'progress' | 'error'> {
  const pending = parts.filter(p => !p.importedId)
  if (!pending.length) return { state: 'imported', progress: null, error: null }
  const ups = pending.map(p => uploads.get(p.key))
  if (ups.some(active)) {
    const total = pending.reduce((n, p) => n + p.size, 0)
    const sent = pending.reduce((n, p, i) => n + (ups[i]?.phase === 'done' ? p.size : ups[i]?.sent ?? 0), 0)
    return { state: ups.some(u => u?.phase === 'uploading' || u?.phase === 'matching') ? 'uploading' : 'queued', progress: total ? sent / total : 0, error: null }
  }
  const failed = ups.find(u => u?.phase === 'failed')
  if (failed) return { state: 'failed', progress: null, error: failed.error ?? 'The upload failed.' }
  return { state: folder.session ? 'new' : 'no-session', progress: null, error: null }
}

const selectable = (r: Recording) => r.state === 'new' || r.state === 'failed'

/** A checkbox that can show "some". */
function TriCheckbox({ checked, some, disabled, label, onChange }: { checked: boolean; some: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = some && !checked }, [some, checked])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
}

function StateChip({ r }: { r: Recording }) {
  switch (r.state) {
    case 'imported': return <span className="cat-chip done">Imported</span>
    case 'uploading': return <span className="cat-chip busy">{Math.round((r.progress ?? 0) * 100)}%</span>
    case 'queued': return <span className="cat-chip">Queued</span>
    case 'failed': return <span className="cat-chip bad" title={r.error ?? undefined}>Failed</span>
    case 'no-session': return <span className="cat-chip muted" title={r.folder.note ?? undefined}>No session</span>
    default: return <span className="cat-chip new">New</span>
  }
}

function daySummary(recordings: Recording[]): { text: string; tone: string } {
  const count = (s: RecordingState) => recordings.filter(r => r.state === s).length
  const moving = count('uploading') + count('queued')
  if (moving) return { text: `Uploading · ${recordings.filter(r => r.state === 'imported').length}/${recordings.length} done`, tone: 'busy' }
  const parts: string[] = []
  const fresh = count('new'), done = count('imported'), failed = count('failed'), none = count('no-session')
  if (done === recordings.length) return { text: 'All imported', tone: 'done' }
  if (fresh) parts.push(`${fresh} new`)
  if (failed) parts.push(`${failed} failed`)
  if (done) parts.push(`${done} imported`)
  if (none) parts.push(`${none} without session`)
  return { text: parts.join(' · '), tone: failed ? 'bad' : fresh ? 'new' : 'muted' }
}

export function CatalystImport() {
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<Map<string, File> | null>(null)
  const [plan, setPlan] = useState<CatalystPlan | null>(null)
  // Selected recordings, by folder.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const allUploads = useVideoUploads()
  const filesRef = useRef(files)
  filesRef.current = files

  // React has no prop for folder pickers.
  useEffect(() => { input.current?.setAttribute('webkitdirectory', ''); input.current?.setAttribute('directory', '') }, [])

  const uploads = useMemo(() => new Map(allUploads.filter(u => u.catalystPath).map(u => [u.catalystPath!, u])), [allUploads])

  const days = useMemo<Day[]>(() => {
    const out: Day[] = []
    for (const folder of plan?.folders ?? []) {
      const parts = folder.files.filter(f => f.kind === 'session').sort((a, b) => a.part - b.part)
      if (!parts.length) continue
      const recording: Recording = { folder, parts, bytes: parts.filter(p => !p.importedId).reduce((n, p) => n + p.size, 0), ...recordingState(folder, parts, uploads) }
      const day = folder.recordedAt.slice(0, 10)
      if (out[out.length - 1]?.day !== day) out.push({ day, where: '', recordings: [] })
      out[out.length - 1].recordings.push(recording)
    }
    // Track and car once in the header when every recording shares them;
    // each day then names its layouts (Full Course, North Course…).
    const places = new Set(out.flatMap(d => d.recordings.map(r => `${r.folder.track} · ${r.folder.car}`)))
    for (const d of out) {
      d.recordings.sort((a, b) => a.folder.recordedAt.localeCompare(b.folder.recordedAt))
      const layouts = [...new Set(d.recordings.map(r => r.folder.session?.layout).filter((l): l is string => !!l))]
      const place = [...new Set(d.recordings.map(r => places.size > 1 ? `${r.folder.track} · ${r.folder.car}` : ''))].filter(Boolean)
      d.where = [...place, layouts.join(', ')].filter(Boolean).join(' · ')
    }
    return out
  }, [plan, uploads])
  const recordings = useMemo(() => days.flatMap(d => d.recordings), [days])
  const sharedPlace = useMemo(() => {
    const places = new Set(recordings.map(r => `${r.folder.track} · ${r.folder.car}`))
    return places.size === 1 ? [...places][0] : null
  }, [recordings])
  const newOnes = () => new Set(recordings.filter(r => r.state === 'new').map(r => r.folder.folder))

  const replan = async (found: Map<string, File>) => setPlan(await api.planCatalystImport([...found].map(([key, file]) => ({ path: key, size: file.size }))))

  // Imported videos show as imported.
  useEffect(() => onVideoImported(() => {
    const found = filesRef.current
    if (found) void replan(found).catch(() => {})
  }), [])

  // A fresh folder starts with every new recording selected; imported or
  // queued ones drop out of the selection.
  const firstPlan = useRef(true)
  useEffect(() => {
    if (!plan) return
    if (firstPlan.current) { firstPlan.current = false; setSelected(newOnes()); return }
    setSelected(s => new Set([...s].filter(f => recordings.some(r => r.folder.folder === f && selectable(r)))))
  }, [plan])  // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (list: File[]) => {
    setError('')
    const found = new Map<string, File>()
    for (const file of list) {
      const parsed = parseCatalystPath(file.webkitRelativePath || file.name)
      if (parsed?.kind === 'session' && !found.has(parsed.key)) found.set(parsed.key, file)
    }
    if (!found.size) {
      setFiles(null); setPlan(null)
      setError(list.length
        ? 'No Catalyst recordings in that folder. Choose RaceData (inside Android/data/com.garmin.racingcoach/files on the Catalyst’s SD card).'
        : 'That folder is empty.')
      return
    }
    setBusy(true)
    try { firstPlan.current = true; setOpen(new Set()); setFiles(found); await replan(found) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const setMany = (folders: string[], on: boolean) => setSelected(s => {
    const next = new Set(s)
    for (const f of folders) if (on) next.add(f); else next.delete(f)
    return next
  })
  const toggleOpen = (day: string) => setOpen(s => { const next = new Set(s); if (next.has(day)) next.delete(day); else next.add(day); return next })

  const picked = recordings.filter(r => selected.has(r.folder.folder) && selectable(r))
  const pickedBytes = picked.reduce((n, r) => n + r.bytes, 0)
  const start = () => {
    if (!files) return
    queueCatalystUploads(picked.flatMap(r => r.parts.filter(p => !p.importedId).flatMap(p => {
      const file = files.get(p.key), parsed = parseCatalystPath(p.key)
      return file && parsed ? [{ file, label: catalystVideoName(parsed), sessionGuid: r.folder.session?.guid ?? null, catalystPath: p.key }] : []
    })))
    setSelected(new Set())
  }

  // Overall upload progress for the footer.
  const moving = recordings.filter(r => r.state === 'uploading' || r.state === 'queued')
  const movingBytes = moving.reduce((n, r) => n + r.bytes, 0)
  const movingSent = moving.reduce((n, r) => n + r.bytes * (r.progress ?? 0), 0)
  const stop = () => { for (const u of allUploads) if (u.catalystPath && active(u) && u.phase !== 'matching') cancelVideoUpload(u.key) }

  const counts = {
    total: recordings.length,
    matched: recordings.filter(r => r.folder.session).length,
    imported: recordings.filter(r => r.state === 'imported').length,
  }

  return <div className="catalyst-import">
    <p className="muted">Connect the Catalyst over USB, open it in MacDroid, and choose its <code>RaceData</code> folder. Each recording is matched to the Garmin session it belongs to, by track, car and start time, and plays beside that session’s laps in Session Review and Analysis.</p>
    <div className="btn-row">
      <button type="button" className={files ? 'btn ghost' : 'btn primary'} disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading folder…' : files ? 'Choose another folder' : 'Choose RaceData folder'}</button>
      <input ref={input} type="file" multiple hidden onChange={e => { const list = Array.from(e.target.files ?? []); e.target.value = ''; void choose(list) }} />
    </div>
    {!files && <details className="catalyst-help">
      <summary className="small">Where is RaceData?</summary>
      <p className="small">With MacDroid connected it is at <code>{DEVICE_FOLDER}</code>. In the folder picker press <kbd>⇧⌘G</kbd> and paste that path, using the SD card’s name (for example <code>Transcend SD card</code>). Your browser asks to confirm before listing the files; nothing uploads until you import.</p>
    </details>}
    {error && <p className="loss small" role="alert">{error}</p>}

    {plan && recordings.length > 0 && <div className="cat-picker">
      <div className="cat-picker-head">
        <span className="small">
          <b>{plural(counts.total, 'recording')}</b> on {plural(days.length, 'day')}{sharedPlace ? <span className="muted"> · {sharedPlace}</span> : null}
          <br /><span className="muted">{counts.matched} matched to your sessions · {counts.imported} imported</span>
        </span>
        <span className="cat-picker-actions">
          <button type="button" className="btn ghost small" onClick={() => setSelected(newOnes())}>Select all new</button>
          <button type="button" className="btn ghost small" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
        </span>
      </div>

      <ul className="cat-days">
        {days.map(d => {
          const choosable = d.recordings.filter(selectable)
          const on = choosable.filter(r => selected.has(r.folder.folder))
          const isOpen = open.has(d.day)
          const summary = daySummary(d.recordings)
          const bytes = d.recordings.reduce((n, r) => n + (r.state === 'imported' ? r.parts.reduce((m, p) => m + p.size, 0) : r.bytes), 0)
          return <li key={d.day} className={`cat-day${isOpen ? ' open' : ''}`}>
            <div className="cat-day-row">
              <TriCheckbox label={`Import ${dayName(d.day)}`} disabled={!choosable.length}
                checked={choosable.length > 0 && on.length === choosable.length} some={on.length > 0}
                onChange={value => setMany(choosable.map(r => r.folder.folder), value)} />
              <button type="button" className="cat-day-toggle" aria-expanded={isOpen} onClick={() => toggleOpen(d.day)}>
                <span className="cat-day-date">{dayName(d.day)} <span className="muted">{yearLabel(d.day)}</span></span>
                <span className="cat-day-where muted">{d.where}</span>
                <span className="cat-day-count">{plural(d.recordings.length, 'session')}</span>
                <span className="cat-day-size muted">{humaniseBytes(bytes)}</span>
                <span className={`cat-day-status ${summary.tone}`}>{summary.text}</span>
                <span className="cat-chevron" aria-hidden="true">›</span>
              </button>
            </div>
            {isOpen && <ul className="cat-sessions">
              {d.recordings.map(r => {
                const s = r.folder.session
                return <li key={r.folder.folder} className={`cat-session state-${r.state}`}>
                  <input type="checkbox" aria-label={`Import the ${(s?.start ?? r.folder.recordedAt).slice(11, 16)} session`} disabled={!selectable(r)}
                    checked={selectable(r) && selected.has(r.folder.folder)} onChange={e => setMany([r.folder.folder], e.target.checked)} />
                  <span className="cat-session-time">{(s?.start ?? r.folder.recordedAt).slice(11, 16)}</span>
                  <span className="cat-session-match">
                    {s ? <>{s.layout ?? 'Session'} · <NavLink to={`/review/${segment(s.guid)}`}>Review</NavLink></>
                      : <span className="muted" title={r.folder.note ?? undefined}>{r.folder.note ?? 'No synced session'}</span>}
                    {r.parts.length > 1 && <span className="muted"> · {r.parts.length} parts</span>}
                  </span>
                  <span className="cat-session-size muted">{humaniseBytes(r.parts.reduce((n, p) => n + p.size, 0))}</span>
                  <StateChip r={r} />
                  {r.state === 'uploading' && <span className="cat-bar" aria-hidden="true"><i style={{ width: `${Math.round((r.progress ?? 0) * 100)}%` }} /></span>}
                </li>
              })}
            </ul>}
          </li>
        })}
      </ul>

      <div className="cat-footer">
        {moving.length > 0
          ? <>
            <div className="cat-footer-progress">
              <span className="small">Uploading {plural(moving.length, 'session')} · {humaniseBytes(Math.max(0, movingBytes - movingSent))} left</span>
              <span className="cat-bar wide" role="progressbar" aria-valuenow={Math.round(movingSent / Math.max(1, movingBytes) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${Math.round(movingSent / Math.max(1, movingBytes) * 100)}%` }} />
              </span>
            </div>
            <button type="button" className="btn ghost small" onClick={stop}>Stop</button>
          </>
          : <span className="muted small">{picked.length ? 'Keep this tab open while videos upload.' : 'Tick days, or open a day to choose sessions.'}</span>}
        <button type="button" className="btn primary" disabled={!picked.length} onClick={start}>
          {picked.length ? `${moving.length ? 'Add' : 'Import'} ${plural(picked.length, 'session')} · ${humaniseBytes(pickedBytes)}` : 'Import'}
        </button>
      </div>
    </div>}
  </div>
}
