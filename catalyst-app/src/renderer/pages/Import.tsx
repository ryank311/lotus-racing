// Import: Garmin Catalyst and Corvette PDR videos (matched to their Garmin
// sessions automatically), car documents for the AI coach, and the videos
// already on the account.

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { NavLink } from '../navigation'
import { UploadQueue, VideoDropZone, VideoLibrary, VideoPickerButton } from '../components/VideoImport'
import { CatalystImport } from '../components/CatalystImport'
import type { CarProfile } from '../../shared/types'
import './import.css'

function CarDocuments() {
  const [profiles, setProfiles] = useState<CarProfile[] | null>(null)
  const [profile, setProfile] = useState('')
  const [status, setStatus] = useState<Array<{ name: string; ok: boolean; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    void Promise.all([api.listProfiles(), api.getActiveProfile()]).then(([list, active]) => {
      setProfiles(list)
      setProfile(active && list.some(p => p.name === active) ? active : list[0]?.name ?? '')
    }).catch(() => setProfiles([]))
  }, [])
  const upload = async (files: File[]) => {
    if (!profile || !files.length) return
    setBusy(true)
    const results: typeof status = []
    for (const file of files) {
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('Documents must be under 2 MB of text.')
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        await api.importContextFile(profile, '', file.name, btoa(binary))
        results.push({ name: file.name, ok: true, message: `Added to ${profile}` })
      } catch (e) {
        results.push({ name: file.name, ok: false, message: e instanceof Error ? e.message : String(e) })
      }
    }
    setStatus(results)
    setBusy(false)
  }
  if (profiles && !profiles.length) return <p className="muted">Create a car profile in the <NavLink to="/garage">Garage</NavLink> first.</p>
  return <div className="import-docs">
    <div className="import-row">
      <label>Car profile
        <select value={profile} disabled={!profiles} onChange={e => setProfile(e.target.value)}>
          {(profiles ?? []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      </label>
      <button type="button" className="btn ghost" disabled={!profile || busy} onClick={() => input.current?.click()}>{busy ? 'Adding…' : 'Choose documents'}</button>
      <input ref={input} type="file" multiple hidden accept=".md,.markdown,.txt,.csv,.json,text/plain,text/markdown"
        onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void upload(files) }} />
    </div>
    {status.length > 0 && <ul className="import-doc-results">{status.map(s => <li key={s.name} className={s.ok ? 'gain' : 'loss'}>{s.name}: {s.message}</li>)}</ul>}
    <p className="muted small">Setup sheets, alignment specs and notes (Markdown or plain text) are stored with the car and can be sent to the AI coach. Manage them in the <NavLink to="/garage">Garage</NavLink>.</p>
  </div>
}

export function Import() {
  const [skipped, setSkipped] = useState<string[]>([])
  return <>
    <header className="page-header">
      <div>
        <div className="page-eyebrow">// files</div>
        <div className="page-title">Im<span className="accent">port</span></div>
      </div>
    </header>
    <div className="page-body import-page">
      <section className="review-panel import-section">
        <div className="review-section-heading">
          <div><span className="review-eyebrow">Garmin Catalyst</span><h2>Session videos from the device</h2></div>
        </div>
        <CatalystImport />
      </section>

      <section className="review-panel import-section">
        <div className="review-section-heading">
          <div><span className="review-eyebrow">Corvette PDR</span><h2>Videos and car data</h2></div>
        </div>
        <VideoDropZone onSkipped={setSkipped}>
          <p>Choose the <code>PDR_####.mp4</code> files from the PDR’s SD card or USB drive (in <code>DCIM/100PDR02</code>), or drop them here. Each video is matched to the Garmin session it was recorded in, by its clock and then its GPS track, and its throttle, brake, gear, RPM, steering and wheel speeds are stored with that session’s laps.</p>
          <div className="btn-row"><VideoPickerButton onSkipped={setSkipped} /></div>
          <p className="muted small">Large videos upload in pieces and can take a while; keep this tab open until each one says Imported. A video that matches no session yet is kept here so you can match it after syncing.</p>
        </VideoDropZone>
        {skipped.length > 0 && <p className="loss small" role="alert">Skipped (not MP4 videos): {skipped.join(', ')}</p>}
        <UploadQueue only="pdr" />
      </section>

      <section className="review-panel import-section">
        <div className="review-section-heading">
          <div><span className="review-eyebrow">Your videos</span><h2>Imported videos</h2></div>
        </div>
        <VideoLibrary />
      </section>

      <section className="review-panel import-section">
        <div className="review-section-heading">
          <div><span className="review-eyebrow">Other files</span><h2>Car documents for the AI coach</h2></div>
        </div>
        <CarDocuments />
      </section>
    </div>
  </>
}
