// Import page: Garmin Catalyst videos. The driver picks the device's
// RaceData folder; each recording is matched to its synced session from the
// folder's track, car and clock; the chosen videos upload one at a time.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, humaniseBytes } from '../api'
import { NavLink } from '../navigation'
import { segment } from '../routes'
import { UploadQueue } from './VideoImport'
import { onVideoImported, queueCatalystUploads, useVideoUploads } from '../videoUploads'
import { catalystVideoName, parseCatalystPath, type CatalystPlan, type CatalystPlanFile, type CatalystPlanFolder } from '../../shared/catalystVideo'
import './catalystImport.css'

const DEVICE_FOLDER = '~/Library/CloudStorage/MacDroid-Catalyst/<SD card>/Android/data/com.garmin.racingcoach/files/RaceData'

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const day = (clock: string) => dayLabel.format(new Date(`${clock.slice(0, 10)}T00:00:00Z`))
const fileLabel = (f: CatalystPlanFile) => (f.kind === 'optimal' ? 'Optimal lap' : f.part > 1 ? `Session video, part ${f.part}` : 'Session video')

// What is selectable by default: new videos of recordings that have a session.
function defaults(plan: CatalystPlan, optimal: boolean): Set<string> {
  return new Set(plan.folders.filter(f => f.session).flatMap(f => f.files)
    .filter(f => !f.importedId && (optimal || f.kind === 'session')).map(f => f.key))
}

export function CatalystImport() {
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<Map<string, File> | null>(null)
  const [plan, setPlan] = useState<CatalystPlan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [optimal, setOptimal] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const uploads = useVideoUploads()
  const filesRef = useRef(files)
  filesRef.current = files

  // React has no prop for folder pickers.
  useEffect(() => { input.current?.setAttribute('webkitdirectory', ''); input.current?.setAttribute('directory', '') }, [])

  const replan = async (found: Map<string, File>, fresh: boolean) => {
    const next = await api.planCatalystImport([...found].map(([key, file]) => ({ path: key, size: file.size })))
    setPlan(next)
    setSelected(current => {
      if (fresh) return defaults(next, optimal)
      // Keep the driver's choice, minus what has been imported since.
      const done = new Set(next.folders.flatMap(f => f.files).filter(f => f.importedId).map(f => f.key))
      return new Set([...current].filter(key => !done.has(key)))
    })
  }

  // Imported videos show as imported.
  useEffect(() => onVideoImported(() => {
    const found = filesRef.current
    if (found) void replan(found, false).catch(() => {})
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (list: File[]) => {
    setError('')
    const found = new Map<string, File>()
    for (const file of list) {
      const parsed = parseCatalystPath(file.webkitRelativePath || file.name)
      if (parsed && !found.has(parsed.key)) found.set(parsed.key, file)
    }
    if (!found.size) {
      setFiles(null); setPlan(null)
      setError(list.length
        ? 'No Catalyst videos in that folder. Choose RaceData (inside Android/data/com.garmin.racingcoach/files on the Catalyst’s SD card).'
        : 'That folder is empty.')
      return
    }
    setBusy(true)
    try { setFiles(found); await replan(found, true) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const progress = useMemo(() => new Map(uploads.filter(u => u.catalystPath).map(u => [u.catalystPath!, u])), [uploads])
  const all = plan?.folders.flatMap(f => f.files) ?? []
  const picked = all.filter(f => selected.has(f.key))
  const pickedBytes = picked.reduce((n, f) => n + f.size, 0)
  const matched = plan?.folders.filter(f => f.session).length ?? 0
  const importedCount = all.filter(f => f.importedId).length
  const queued = (f: CatalystPlanFile) => {
    const u = progress.get(f.key)
    return !!u && (u.phase === 'waiting' || u.phase === 'uploading' || u.phase === 'matching')
  }

  const toggle = (key: string, on: boolean) => setSelected(s => { const next = new Set(s); if (on) next.add(key); else next.delete(key); return next })
  const setOptimalAndSelection = (on: boolean) => {
    setOptimal(on)
    if (!plan) return
    setSelected(s => {
      const next = new Set(s)
      for (const f of plan.folders.filter(x => x.session).flatMap(x => x.files)) {
        if (f.kind !== 'optimal' || f.importedId) continue
        if (on) next.add(f.key); else next.delete(f.key)
      }
      return next
    })
  }

  const start = () => {
    if (!plan || !files) return
    const bySession = new Map(plan.folders.map(f => [f.folder, f]))
    queueCatalystUploads(picked.filter(f => !queued(f)).flatMap(f => {
      const file = files.get(f.key), p = parseCatalystPath(f.key)
      if (!file || !p) return []
      return [{ file, label: catalystVideoName(p), sessionGuid: bySession.get(p.folder)?.session?.guid ?? null, catalystPath: f.key }]
    }))
    setSelected(new Set())
  }

  // Recordings by day, newest first.
  const days = useMemo(() => {
    const out: Array<{ day: string; folders: CatalystPlanFolder[] }> = []
    for (const folder of plan?.folders ?? []) {
      const d = folder.recordedAt.slice(0, 10)
      if (out[out.length - 1]?.day !== d) out.push({ day: d, folders: [] })
      out[out.length - 1].folders.push(folder)
    }
    return out
  }, [plan])

  return <div className="catalyst-import">
    <p className="muted">Connect the Catalyst to this computer with USB, open it in MacDroid, and choose its <code>RaceData</code> folder. Each recording is matched to the Garmin session it belongs to, by track, car and start time, and its video plays beside that session’s laps in Session Review and Analysis.</p>
    <div className="btn-row">
      <button type="button" className="btn primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading folder…' : files ? 'Choose another folder' : 'Choose RaceData folder'}</button>
      <input ref={input} type="file" multiple hidden onChange={e => { const list = Array.from(e.target.files ?? []); e.target.value = ''; void choose(list) }} />
    </div>
    <details className="catalyst-help">
      <summary className="small">Where is RaceData?</summary>
      <p className="small">With MacDroid connected it is at <code>{DEVICE_FOLDER}</code>. In the folder picker press <kbd>⇧⌘G</kbd> and paste that path, choosing the SD card’s name (for example <code>Transcend SD card</code>). Your browser asks to confirm before listing the files; nothing is uploaded until you import. Only <code>video_N.mp4</code> and <code>optimal_lap_video.mp4</code> files in session folders are used.</p>
    </details>
    {error && <p className="loss small" role="alert">{error}</p>}

    {plan && <>
      <p className="small catalyst-summary">
        {plan.folders.length} recording{plan.folders.length === 1 ? '' : 's'} · {matched} matched to your sessions · {importedCount} video{importedCount === 1 ? '' : 's'} already imported
        {plan.folders.length > matched && <> · <span className="reference">{plan.folders.length - matched} without a synced session</span></>}
      </p>
      <div className="catalyst-toolbar">
        <label className="small"><input type="checkbox" checked={optimal} onChange={e => setOptimalAndSelection(e.target.checked)} /> Include Garmin’s optimal-lap videos</label>
        <button type="button" className="btn ghost small" onClick={() => setSelected(defaults(plan, optimal))}>Select all new</button>
        <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>Select none</button>
      </div>
      <div className="catalyst-days">
        {days.map(group => <section key={group.day} className="catalyst-day">
          <h3>{day(group.day)}</h3>
          {group.folders.map(folder => <article key={folder.folder} className={`catalyst-folder${folder.session ? '' : ' unmatched'}`}>
            <div className="catalyst-folder-head">
              <strong className="mono">{folder.recordedAt.slice(11, 16)}</strong>
              <span className="muted small">{folder.track} · {folder.car}</span>
            </div>
            {folder.session
              ? <p className="small catalyst-session">Session {folder.session.start.slice(11, 16)}{folder.session.layout ? ` · ${folder.session.layout}` : ''} · <NavLink to={`/review/${segment(folder.session.guid)}`}>Session Review</NavLink></p>
              : <p className="small reference catalyst-session">{folder.note} Its videos can still be imported and attached to a session later.</p>}
            <ul className="catalyst-files">
              {folder.files.map(f => {
                const u = progress.get(f.key)
                const status = f.importedId
                  ? <span className="gain">Imported{f.importedSession && folder.session && f.importedSession !== folder.session.guid ? ' (to another session)' : ''}</span>
                  : u?.phase === 'uploading' ? <span>Uploading {u.size ? Math.round(u.sent / u.size * 100) : 0}%</span>
                  : u?.phase === 'waiting' ? <span className="muted">Queued</span>
                  : u?.phase === 'matching' ? <span>Attaching…</span>
                  : u?.phase === 'failed' ? <span className="loss" title={u.error}>Failed</span>
                  : null
                return <li key={f.key}>
                  <label>
                    <input type="checkbox" disabled={!!f.importedId || queued(f)} checked={selected.has(f.key)} onChange={e => toggle(f.key, e.target.checked)} />
                    {fileLabel(f)} <span className="muted">· {humaniseBytes(f.size)}</span>
                  </label>
                  {status}
                </li>
              })}
            </ul>
          </article>)}
        </section>)}
      </div>
      <div className="catalyst-footer">
        <button type="button" className="btn primary" disabled={!picked.length} onClick={start}>
          {picked.length ? `Import ${picked.length} video${picked.length === 1 ? '' : 's'} · ${humaniseBytes(pickedBytes)}` : 'Import'}
        </button>
        <span className="muted small">Videos upload one at a time; a session video is 1–2 GB. Keep this tab open until each says Imported.</span>
      </div>
    </>}
    <UploadQueue only="catalyst" />
  </div>
}
