import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isRemote } from '../api'
import { NavLink, useNavigation, useRoute, useUnsavedChanges } from '../navigation'
import { fileId, segment } from '../routes'
import type { CarProfile, VehicleSummary } from '../../shared/types'

// ─── helpers ─────────────────────────────────────────────────────────────────

function vehicleLabel(v: VehicleSummary): string {
  const parts = [v.year, v.make, v.model].filter(Boolean)
  return parts.length ? parts.join(' ') : v.vehicleGuid.slice(0, 12)
}

function slugify(s: string): string {
  return s.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32)
}

// ─── Garage page ─────────────────────────────────────────────────────────────

export function Garage() {
  const { id: selected, fileId: selectedFile } = useRoute()
  const { go } = useNavigation()
  const [loading, setLoading] = useState(true)
  const [filesOwner, setFilesOwner] = useState<string | null>(null)
  const filesRequest = useRef(0)
  const [vehicles, setVehicles]   = useState<VehicleSummary[]>([])
  const [profiles, setProfiles]   = useState<CarProfile[]>([])
  const [files, setFiles]         = useState<{ name: string; path: string }[]>([])
  const [content, setContent]     = useState('')
  const [original, setOriginal]   = useState('')
  const [dropping, setDropping]   = useState(false)
  const [saving, setSaving]       = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = content !== original

  const load = useCallback(async () => {
    const [v, p] = await Promise.all([api.listVehicles(), api.listProfiles()])
    setVehicles(v)
    setProfiles(p)
  }, [])

  useEffect(() => { void load().catch(e => setSaveError(String(e))).finally(() => setLoading(false)) }, [load])

  const selectedVehicle = vehicles.find(v => v.vehicleGuid === selected) ?? null
  const editPath = filesOwner === selectedVehicle?.profile ? files.find(f => fileId(f.name) === selectedFile)?.path ?? null : null
  const vehicleUrl = `/garage/${segment(selected ?? '')}`

  const refreshFiles = useCallback(async (profileName: string) => {
    const request = ++filesRequest.current
    const fs = await api.listProfileFiles(profileName)
    if (request !== filesRequest.current) return
    setFiles(fs)
    setFilesOwner(profileName)
  }, [])

  useEffect(() => {
    setFiles([]); setFilesOwner(null)
    if (!selectedVehicle?.profile) return
    void refreshFiles(selectedVehicle.profile).catch(e => setSaveError(String(e)))
    return () => { filesRequest.current++ }
  }, [selectedVehicle?.profile, refreshFiles])

  useEffect(() => {
    if (!editPath) { setContent(''); setOriginal(''); setSaveError(null); return }
    let cancelled = false
    setContent(''); setOriginal('')
    void api.readProfileFile(editPath).then(t => {
      if (cancelled) return
      setContent(t)
      setOriginal(t)
      setSaveError(null)
    }).catch(e => {
      if (cancelled) return
      setSaveError(e instanceof Error ? e.message : String(e))
    })
    return () => { cancelled = true }
  }, [editPath])

  const onSelectVehicle = (guid: string) => {
    go(`/garage/${segment(guid)}`)
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
  useUnsavedChanges(dirty, onSave)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    const unsub = typeof api.onSaveRequest === 'function' ? api.onSaveRequest(() => { void onSave() }) : () => {}
    return () => {
      window.removeEventListener('keydown', onKey)
      unsub()
    }
  }, [onSave])

  const onDelete = async (fileName: string) => {
    if (!selectedVehicle?.profile) return
    if (!confirm(`Delete ${fileName}?`)) return
    await api.deleteContextFile(selectedVehicle.profile, fileName)
    if (editPath?.endsWith('/' + fileName)) {
      setContent(''); setOriginal('')
      go(vehicleUrl, { replace: true })
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
          {vehicles.length} vehicles<br />
          <span className="muted">{profiles.length} profiles</span>
        </div>
      </header>

      <div className="page-body garage-layout">
        {loading && <div data-route-loading role="status">Loading vehicles…</div>}
        {/* ── Vehicle list ── */}
        <div className="garage-vehicles">
          {vehicles.length === 0 && (
            <div className="garage-empty-hint">No vehicles found — sync sessions first.</div>
          )}
          {vehicles.map(v => (
            <VehicleCard
              key={v.vehicleGuid}
              vehicle={v}
              profiles={profiles}
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

        {/* ── Profile detail ── */}
        <div className="garage-detail">
          {selected && !selectedVehicle && !loading ? <div role="alert">Vehicle unavailable. <NavLink to="/garage">All vehicles</NavLink></div> : selectedFile && filesOwner && !editPath ? <div role="alert">Document unavailable. <NavLink to={vehicleUrl}>Vehicle files</NavLink></div> : !selectedVehicle ? (
            <div className="garage-empty-hint" style={{ margin: 'auto' }}>
              Select a vehicle to manage its context files
            </div>
          ) : (
            <ProfileDetail
              vehicle={selectedVehicle!}
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
              onDrop={onDrop}
              onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
              onDragLeave={() => setDropping(false)}
              onCreateProfile={() => ensureProfile(selectedVehicle!)}
            />
          )}
        </div>
      </div>
    </>
  )
}

// ─── VehicleCard ─────────────────────────────────────────────────────────────

function VehicleCard({ vehicle, profiles, selected, onClick, onProfileChange }: {
  vehicle: VehicleSummary
  profiles: CarProfile[]
  selected: boolean
  onClick: () => void
  onProfileChange: (name: string | null) => Promise<void>
}) {
  const [showMap, setShowMap] = useState(false)

  return (
    <div className={`garage-vehicle-card ${selected ? 'selected' : ''}`} onClick={onClick}>
      <NavLink className="garage-vehicle-name" to={`/garage/${segment(vehicle.vehicleGuid)}`} onClick={e => e.stopPropagation()}>{vehicleLabel(vehicle)}</NavLink>
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

      {/* Profile picker */}
      {selected && (
        <div className="garage-profile-map" onClick={e => e.stopPropagation()}>
          <span className="muted text-mono" style={{ fontSize: 9 }}>profile</span>
          <select
            className="garage-profile-select"
            value={vehicle.profile ?? ''}
            onChange={async e => {
              await onProfileChange(e.target.value || null)
              setShowMap(false)
            }}
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
  onSelectFile, onDelete, onContentChange, onSave, onDrop, onDragOver, onDragLeave, onCreateProfile,
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
            or link it to an existing profile using the selector on the left.
          </div>
          <button className="btn ghost" onClick={onCreateProfile}>Create blank profile</button>
        </div>
      </div>
    )
  }

  return (
    <div className="garage-detail-inner">
      {/* File list */}
      <div className="garage-file-list">
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
      </div>

      {/* Editor */}
      <div className="garage-editor">
        {editPath ? (
          <>
            <div className="viewer-toolbar">
              <span className="text-mono" style={{ fontSize: 11 }}>{editPath.split('/').pop()}</span>
              <span className="spacer" />
              <span className="muted text-mono" style={{ fontSize: 10 }}>
                {content.length.toLocaleString()} chars
                {saveError && <span style={{ color: 'var(--signal)', marginLeft: 8 }}>{saveError}</span>}
                {!saveError && dirty && <span style={{ color: 'var(--signal)', marginLeft: 8 }}>unsaved</span>}
              </span>
              <button className="btn primary" disabled={!dirty || saving} onClick={onSave} style={{ marginLeft: 12, padding: '4px 14px' }}>
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </div>
            <textarea
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
