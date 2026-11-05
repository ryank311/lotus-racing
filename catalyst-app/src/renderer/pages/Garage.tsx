import { useResource } from '../useResource'
import { InlineLoadStatus, LoadingRows } from '../components/Loading'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, humaniseBytes, isRemote } from '../api'
import { NavLink, useNavigation, useRoute, useUnsavedChanges } from '../navigation'
import { fileId, routeUrl, segment } from '../routes'
import type { AiContextFile, CarProfile, VehicleSummary } from '../../shared/types'
import { carModelFor, vehicleKey, type CarModel } from '../../shared/replay'
import { CarModelPanel } from './GarageCarModel'
import './pages-extras.css'
import './garage-models.css'

// ─── helpers ─────────────────────────────────────────────────────────────────

function vehicleLabel(v: VehicleSummary): string {
  const parts = [v.year, v.make, v.model].filter(Boolean)
  return parts.length ? parts.join(' ') : v.vehicleGuid.slice(0, 12)
}

function slugify(s: string): string {
  return s.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32)
}

// The unsaved-changes guard: a document is left by changing page or car; a
// fit also by switching to the car's files (the same path, another query).
const pathScope = (url: string) => url.split('?')[0]
const urlScope = (url: string) => url

// ─── Garage page ─────────────────────────────────────────────────────────────

export function Garage() {
  const { id: selected, fileId: selectedFile, params } = useRoute()
  const { go } = useNavigation()
  const fleet = useResource(async () => {
    const [vehicles, profiles] = await Promise.all([api.listVehicles(), api.listProfiles()])
    return { vehicles, profiles }
  })
  const loading = fleet.initialLoading
  const vehicles = fleet.data?.vehicles ?? []
  const profiles = fleet.data?.profiles ?? []
  const load = fleet.reload
  // The replay's car models, shared by every driver on the server.
  const models = useResource(() => api.listCarModels())
  const setModels = models.setData
  const onModels = useCallback((next: CarModel[] | ((list: CarModel[]) => CarModel[])) => {
    setModels(list => (typeof next === 'function' ? next(list ?? []) : next))
  }, [setModels])
  // A selected car shows its 3D model (?tab=model, the default) or its context files.
  const tab = selectedFile || params.get('tab') === 'files' ? 'files' : 'model'
  const [fitSave, setFitSave] = useState<(() => Promise<boolean>) | null>(null)
  const onFitPending = useCallback((save: (() => Promise<boolean>) | null) => setFitSave(() => save), [])
  const [filesOwner, setFilesOwner] = useState<string | null>(null)
  const filesRequest = useRef(0)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileAttempt, setFileAttempt] = useState(0)
  const [files, setFiles]         = useState<{ name: string; path: string }[]>([])
  const [content, setContent]     = useState('')
  const [original, setOriginal]   = useState('')
  const [dropping, setDropping]   = useState(false)
  const [saving, setSaving]       = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = content !== original


  const selectedVehicle = vehicles.find(v => v.vehicleGuid === selected) ?? null
  const editPath = filesOwner === selectedVehicle?.profile ? files.find(f => fileId(f.name) === selectedFile)?.path ?? null : null
  const vehicleUrl = `/garage/${segment(selected ?? '')}`
  const filesUrl = routeUrl(vehicleUrl, { tab: 'files' })

  // ?vehicle=<make model> (the replay's "Change in Garage"): that car, when the driver has one.
  const wantedKey = selected ? null : params.get('vehicle')
  const wanted = wantedKey ? vehicles.find(v => vehicleKey(v.make, v.model) === vehicleKey(wantedKey, null)) ?? null : null
  useEffect(() => {
    if (wanted) go(`/garage/${segment(wanted.vehicleGuid)}`, { replace: true })
  }, [wanted, go])

  const refreshFiles = useCallback(async (profileName: string) => {
    const request = ++filesRequest.current
    setFilesError(null)
    try {
      const fs = await api.listProfileFiles(profileName)
      if (request !== filesRequest.current) return
      setFiles(fs)
      setFilesOwner(profileName)
    } catch (error) {
      if (request === filesRequest.current) setFilesError(String(error))
    }
  }, [])

  useEffect(() => {
    setFiles([]); setFilesOwner(null); setFilesError(null)
    if (!selectedVehicle?.profile) return
    void refreshFiles(selectedVehicle.profile).catch(e => setSaveError(String(e)))
    return () => { filesRequest.current++ }
  }, [selectedVehicle?.profile, refreshFiles])

  useEffect(() => {
    if (!editPath) { setContent(''); setOriginal(''); setSaveError(null); setFileLoading(false); setFileError(null); return }
    let cancelled = false
    setContent(''); setOriginal(''); setFileLoading(true); setFileError(null)
    void api.readProfileFile(editPath).then(t => {
      if (cancelled) return
      setContent(t)
      setOriginal(t)
      setSaveError(null)
    }).catch(e => {
      if (cancelled) return
      setFileError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (!cancelled) setFileLoading(false) })
    return () => { cancelled = true }
  }, [editPath, fileAttempt])

  // Another car opens on the same tab.
  const carUrl = (guid: string) => routeUrl(`/garage/${segment(guid)}`, { tab: tab === 'files' ? 'files' : null })
  const onSelectVehicle = (guid: string) => {
    go(carUrl(guid))
  }

  const onSave = useCallback(async () => {
    if (!editPath || !selectedVehicle?.profile) return false
    if (content === original) return true
    setSaving(true)
    setSaveError(null)
    try {
      await api.writeCarMd(selectedVehicle.profile, editPath, content)
      setOriginal(content)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSaveError(msg)
      console.error('[garage] save failed', e)
      return false
    } finally {
      setSaving(false)
    }
  }, [editPath, selectedVehicle?.profile, content, original])
  // An open document, or an unsaved fit in the 3D model panel.
  const saveAll = useCallback(async () => (fitSave ? await fitSave() : true) && (dirty ? await onSave() : true), [fitSave, dirty, onSave])
  useUnsavedChanges(dirty || !!fitSave, saveAll, fitSave ? urlScope : pathScope)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveAll()
      }
    }
    window.addEventListener('keydown', onKey)
    const unsub = typeof api.onSaveRequest === 'function' ? api.onSaveRequest(() => { void saveAll() }) : () => {}
    return () => {
      window.removeEventListener('keydown', onKey)
      unsub()
    }
  }, [saveAll])

  const onDelete = async (fileName: string) => {
    if (!selectedVehicle?.profile) return
    if (!confirm(`Delete ${fileName}?`)) return
    await api.deleteContextFile(selectedVehicle.profile, fileName)
    if (editPath?.endsWith('/' + fileName)) {
      setContent(''); setOriginal('')
      go(filesUrl, { replace: true })
    }
    await refreshFiles(selectedVehicle.profile)
  }

  const ensureProfile = async (v: VehicleSummary): Promise<string | null> => {
    const name = v.make ? slugify(v.make) : slugify(vehicleLabel(v))
    const profile = await api.ensureProfile(name, v.vehicleGuid)
    await load()
    return profile.name
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    if (!selectedVehicle) return

    let profileName = selectedVehicle.profile
    if (!profileName) profileName = await ensureProfile(selectedVehicle)
    if (!profileName) return

    const dropped = Array.from(e.dataTransfer.files)
    for (const file of dropped) {
      const src = (file as any).path as string
      if (src && !isRemote) {
        await api.importContextFile(profileName, src, file.name)
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        await api.importContextFile(profileName, '', file.name, btoa(binary))
      }
    }
    await refreshFiles(profileName)
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// fleet</div>
          <div className="page-title">Gar<span className="accent">age</span></div>
        </div>
        <div className="page-meta">
          <InlineLoadStatus label="garage" pending={fleet.pending} error={fleet.error} hasData={!!fleet.data} onRetry={load} />
          {fleet.data && <>{vehicles.length} vehicles<br /><span className="muted">{profiles.length} profiles</span></>}
        </div>
      </header>

      <div className="page-body garage-layout" data-route-loading={loading || fileLoading || undefined} data-stage={selectedFile ? 'editor' : selected ? tab : 'vehicles'}>
        <div className="garage-mobile-navigation">
          {selectedFile && editPath && selectedVehicle ? (
            <span className="text-mono">{vehicleLabel(selectedVehicle)}</span>
          ) : selectedFile ? (
            <NavLink className="btn ghost" to={filesUrl}>Close editor</NavLink>
          ) : selected ? (
            <NavLink className="btn ghost" to="/garage">← Change car</NavLink>
          ) : <span className="muted text-mono">Choose a car</span>}
          {selected && <span className="muted text-mono">{selectedFile ? 'Edit file' : tab === 'files' ? 'Choose a file' : '3D model'}</span>}
        </div>
        {/* ── Vehicle list ── */}
        <div className="garage-vehicles" aria-busy={fleet.pending}>
          {loading && <LoadingRows />}
          {fleet.data && vehicles.length === 0 && (
            <div className="garage-empty-hint">No vehicles found — sync sessions first.</div>
          )}
          {vehicles.map(v => (
            <VehicleCard
              key={v.vehicleGuid}
              vehicle={v}
              to={carUrl(v.vehicleGuid)}
              profiles={profiles}
              model={models.data ? carModelFor(models.data, vehicleKey(v.make, v.model)) ?? 'none' : null}
              selected={v.vehicleGuid === selected}
              onClick={() => onSelectVehicle(v.vehicleGuid)}
              onProfileChange={async (profileName) => {
                await api.setVehicleProfile(v.vehicleGuid, profileName)
                await load()
                if (v.vehicleGuid === selected) await refreshFiles(profileName ?? '')
              }}
            />
          ))}
        </div>

        {/* ── The selected car: its 3D model or its context files ── */}
        <div className="garage-detail">
          {!fleet.data ? null : selected && !selectedVehicle && !loading ? <div role="alert">Vehicle unavailable. <NavLink to="/garage">All vehicles</NavLink></div> : !selectedVehicle ? (
            <div className="garage-empty-hint" style={{ margin: 'auto' }}>
              {wantedKey && !wanted ? <>No {wantedKey} has sessions in your garage.</> : <>Select a vehicle to choose its 3D model and manage its context files</>}
            </div>
          ) : (
            <div className="garage-car-detail">
              <nav className="garage-tabs" aria-label={vehicleLabel(selectedVehicle)}>
                <span className="garage-tabs-car">{vehicleLabel(selectedVehicle)}</span>
                <NavLink to={vehicleUrl} className={tab === 'model' ? 'on' : ''} aria-current={tab === 'model' ? 'page' : undefined}>3D model</NavLink>
                <NavLink to={filesUrl} className={tab === 'files' ? 'on' : ''} aria-current={tab === 'files' ? 'page' : undefined}>Context files</NavLink>
              </nav>
              {tab === 'model' ? (models.data ? (
                <CarModelPanel
                  key={selectedVehicle.vehicleGuid}
                  vehicleKey={vehicleKey(selectedVehicle.make, selectedVehicle.model)}
                  vehicleName={vehicleLabel(selectedVehicle)}
                  models={models.data}
                  onModels={onModels}
                  onFitPending={onFitPending}
                />
              ) : <><InlineLoadStatus label="3D models" pending={models.pending} error={models.error} onRetry={() => void models.reload()} />{!models.error && <LoadingRows count={3} />}</>
              ) : selectedVehicle.profile && filesOwner !== selectedVehicle.profile ? <><InlineLoadStatus label="context files" pending={!filesError} error={filesError} onRetry={() => void refreshFiles(selectedVehicle.profile!)} />{!filesError && <LoadingRows />}</> : selectedFile && editPath && (fileLoading || fileError) ? <><InlineLoadStatus label="document" pending={fileLoading} error={fileError} onRetry={() => setFileAttempt(n => n + 1)} />{fileLoading && <LoadingRows count={3} />}</> : selectedFile && filesOwner && !editPath ? <div role="alert">Document unavailable. <NavLink to={filesUrl}>Vehicle files</NavLink></div> : (
                <ProfileDetail
                  vehicle={selectedVehicle}
                  files={files}
                  editPath={editPath}
                  content={content}
                  dirty={dirty}
                  saving={saving}
                  saveError={saveError}
                  dropping={dropping}
                  onSelectFile={(p) => {
                    const file = files.find(f => f.path === p)
                    if (file) go(`${vehicleUrl}/files/${fileId(file.name)}`)
                  }}
                  onDelete={onDelete}
                  onContentChange={setContent}
                  onSave={onSave}
                  onClose={() => go(filesUrl)}
                  onDrop={onDrop}
                  onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
                  onDragLeave={() => setDropping(false)}
                  onCreateProfile={() => ensureProfile(selectedVehicle)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── VehicleCard ─────────────────────────────────────────────────────────────

function VehicleCard({ vehicle, to, profiles, model, selected, onClick, onProfileChange }: {
  vehicle: VehicleSummary
  to: string
  profiles: CarProfile[]
  /** The replay's model for it ('none': the placeholder shape); null while loading. */
  model: CarModel | 'none' | null
  selected: boolean
  onClick: () => void
  onProfileChange: (name: string | null) => Promise<void>
}) {
  return (
    <div className={`garage-vehicle-card ${selected ? 'selected' : ''}`} onClick={onClick}>
      <NavLink className="garage-vehicle-name" to={to} onClick={e => e.stopPropagation()}>{vehicleLabel(vehicle)}</NavLink>
      <div className="garage-vehicle-meta">
        <span className="muted text-mono" style={{ fontSize: 10 }}>
          {vehicle.sessionCount} session{vehicle.sessionCount !== 1 ? 's' : ''}
        </span>
        {vehicle.profile ? (
          <span className="chip cyan" style={{ padding: '2px 8px', fontSize: 9 }}>
            {vehicle.profile}
          </span>
        ) : (
          <span className="chip" style={{ padding: '2px 8px', fontSize: 9, borderColor: 'var(--border-strong)', color: 'var(--text-mute)' }}>
            no profile
          </span>
        )}
      </div>
      {model && (
        <div className="garage-vehicle-model" title={model === 'none' ? 'The replay draws a placeholder shape' : model.name}>
          3D · {model === 'none' ? 'placeholder shape' : model.name}
        </div>
      )}

      {/* Profile picker */}
      {selected && (
        <div className="garage-profile-map" onClick={e => e.stopPropagation()}>
          <span className="muted text-mono" style={{ fontSize: 9 }}>profile</span>
          <select
            className="garage-profile-select"
            value={vehicle.profile ?? ''}
            onChange={e => { void onProfileChange(e.target.value || null) }}
          >
            <option value="">— unlinked —</option>
            {profiles.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

// ─── ProfileDetail ────────────────────────────────────────────────────────────

function ProfileDetail({ vehicle, files, editPath, content, dirty, saving, saveError, dropping,
  onSelectFile, onDelete, onContentChange, onSave, onClose, onDrop, onDragOver, onDragLeave, onCreateProfile,
}: {
  vehicle: VehicleSummary
  files: { name: string; path: string }[]
  editPath: string | null
  content: string
  dirty: boolean
  saving: boolean
  saveError: string | null
  dropping: boolean
  onSelectFile: (p: string) => void
  onDelete: (name: string) => void
  onContentChange: (s: string) => void
  onSave: () => void
  onClose: () => void
  onDrop: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onCreateProfile: () => void
}) {
  const dropRef = useRef<HTMLDivElement>(null)

  if (!vehicle.profile) {
    return (
      <div
        className={`garage-drop-zone ${dropping ? 'active' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        ref={dropRef}
      >
        <div className="garage-drop-hint">
          <div className="hd" style={{ marginBottom: 8 }}>No profile linked</div>
          <div className="sub" style={{ marginBottom: 18 }}>
            Drop a file here to create a profile for this vehicle,<br />
            or link it to an existing profile using the car's profile selector.
          </div>
          <button className="btn ghost" onClick={onCreateProfile}>Create blank profile</button>
        </div>
      </div>
    )
  }

  return (
    <div className="garage-detail-inner">
      {/* File list */}
      <div className="garage-file-list with-ai-context">
        <div className="garage-file-list-header">
          <span className="text-mono muted" style={{ fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
            {vehicle.profile} / context files
          </span>
          <span className="muted text-mono" style={{ fontSize: 9 }}>
            {files.length} file{files.length !== 1 ? 's' : ''}
          </span>
        </div>

        {files.map(f => (
          <div
            key={f.path}
            className={`garage-file-item ${editPath === f.path ? 'active' : ''}`}
            onClick={() => onSelectFile(f.path)}
          >
            <NavLink className="garage-file-name" to={`/garage/${segment(vehicle.vehicleGuid)}/files/${fileId(f.name)}`} onClick={e => e.stopPropagation()}>{f.name}</NavLink>
            {f.name.toLowerCase() !== 'car.md' && (
              <button
                className="garage-file-delete"
                onClick={e => { e.stopPropagation(); onDelete(f.name) }}
                title="Delete file"
              >×</button>
            )}
          </div>
        ))}

        {/* Drop zone */}
        <div
          className={`garage-drop-zone inline ${dropping ? 'active' : ''}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          <span>{dropping ? 'Drop to add' : '+ Drop files to add context'}</span>
        </div>

        <AiContextFiles profile={vehicle.profile} filesKey={files.map(f => f.name).join('\n')} />
      </div>

      {/* Editor */}
      <div className="garage-editor">
        {editPath ? (
          <>
            <div className="viewer-toolbar garage-editor-toolbar">
              <span className="text-mono garage-editor-filename" style={{ fontSize: 11 }}>{editPath.split('/').pop()}</span>
              <span className="spacer" />
              <span className="muted text-mono garage-editor-status" style={{ fontSize: 10 }}>
                {content.length.toLocaleString()} chars
                {saveError && <span style={{ color: 'var(--signal)', marginLeft: 8 }}>{saveError}</span>}
                {!saveError && dirty && <span style={{ color: 'var(--signal)', marginLeft: 8 }}>unsaved</span>}
              </span>
              <button className="btn primary" disabled={!dirty || saving} onClick={onSave} style={{ marginLeft: 12, padding: '4px 14px' }}>
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
              <button className="btn ghost" disabled={saving} onClick={onClose}>Close</button>
            </div>
            <textarea
              aria-label={`Edit ${editPath.split('/').pop()}`}
              value={content}
              onChange={e => onContentChange(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1, background: 'transparent', border: 0, outline: 'none',
                padding: '20px 26px', color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)', fontSize: 12.5,
                lineHeight: 1.65, resize: 'none',
              }}
            />
          </>
        ) : (
          <div className="garage-editor-placeholder">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  )
}

// ─── AiContextFiles ──────────────────────────────────────────────────────────

// Which of the profile's Markdown documents the AI coach reads.
function AiContextFiles({ profile, filesKey }: { profile: string; filesKey: string }) {
  const [list, setList] = useState<AiContextFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const request = useRef(0)

  const reload = useCallback(async () => {
    const id = ++request.current
    try {
      const next = await api.listAiContextFiles(profile)
      if (id === request.current) { setList(next); setError(null) }
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [profile])

  // Reload when documents are added or removed (filesKey changes).
  useEffect(() => {
    setList(null)
    void reload()
    return () => { request.current++ }
  }, [reload, filesKey])

  const update = async (name: string, included: boolean | null) => {
    setPending(name)
    setError(null)
    try {
      await api.setAiContextFile(profile, name, included)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="garage-ai-context" aria-label="AI coach context">
      <div className="garage-ai-context-title">AI coach context</div>
      <p className="garage-ai-context-note">
        By default the coach reads Car.md, driver/coach notes and goals, and the guide for the layout being coached.
        Other documents stay out unless ticked. Research and sources sections are stripped before sending.
      </p>
      {error && (
        <div className="garage-ai-context-error" role="alert">
          {error} <button className="btn tiny ghost" onClick={() => void reload()}>Reload</button>
        </div>
      )}
      {!list && !error && <LoadingRows count={2} />}
      {list?.length === 0 && <div className="muted small">No Markdown documents.</div>}
      {list?.map(file => (
        <div key={file.name} className="garage-ai-context-row">
          <span className="garage-ai-context-name">{file.name}</span>
          <label>
            <input
              type="checkbox"
              checked={file.included}
              disabled={pending !== null}
              onChange={e => void update(file.name, e.target.checked)}
            />
            Sent to AI coach
          </label>
          <span className="garage-ai-context-meta">{humaniseBytes(file.bytes)}</span>
          {file.included === file.defaultIncluded ? (
            <span className="garage-ai-context-meta">default</span>
          ) : (
            <button
              className="btn tiny ghost"
              disabled={pending !== null}
              title={`Default: ${file.defaultIncluded ? 'sent' : 'not sent'}`}
              onClick={() => void update(file.name, null)}
            >Reset</button>
          )}
        </div>
      ))}
    </section>
  )
}
