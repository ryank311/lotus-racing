import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
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
  const [vehicles, setVehicles]   = useState<VehicleSummary[]>([])
  const [profiles, setProfiles]   = useState<CarProfile[]>([])
  const [selected, setSelected]   = useState<string | null>(null) // vehicleGuid
  const [files, setFiles]         = useState<{ name: string; path: string }[]>([])
  const [editPath, setEditPath]   = useState<string | null>(null)
  const [content, setContent]     = useState('')
  const [original, setOriginal]   = useState('')
  const [dropping, setDropping]   = useState(false)
  const [saving, setSaving]       = useState(false)
  const dirty = content !== original

  const load = useCallback(async () => {
    const [v, p] = await Promise.all([api.listVehicles(), api.listProfiles()])
    setVehicles(v)
    setProfiles(p)
  }, [])

  useEffect(() => { void load() }, [load])

  const selectedVehicle = vehicles.find(v => v.vehicleGuid === selected) ?? null

  const refreshFiles = useCallback(async (profileName: string) => {
    const fs = await api.listProfileFiles(profileName)
    setFiles(fs)
  }, [])

  useEffect(() => {
    if (!selectedVehicle?.profile) { setFiles([]); setEditPath(null); return }
    void refreshFiles(selectedVehicle.profile)
  }, [selectedVehicle?.profile, refreshFiles])

  useEffect(() => {
    if (!editPath) { setContent(''); setOriginal(''); return }
    void api.readProfileFile(editPath).then(t => { setContent(t); setOriginal(t) })
  }, [editPath])

  const onSelectVehicle = (guid: string) => {
    if (dirty && !confirm('Discard unsaved edits?')) return
    setSelected(guid)
    setEditPath(null)
    setContent(''); setOriginal('')
  }

  const onSave = async () => {
    if (!editPath || !selectedVehicle?.profile) return
    setSaving(true)
    await api.writeCarMd(selectedVehicle.profile, editPath.split('/').pop()!, content)
    setOriginal(content)
    setSaving(false)
  }

  const onDelete = async (fileName: string) => {
    if (!selectedVehicle?.profile) return
    if (!confirm(`Delete ${fileName}?`)) return
    await api.deleteContextFile(selectedVehicle.profile, fileName)
    if (editPath?.endsWith('/' + fileName)) setEditPath(null)
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
      if (!src) continue
      await api.importContextFile(profileName, src, file.name)
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
          {!selected ? (
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
              dropping={dropping}
              onSelectFile={(p) => {
                if (dirty && !confirm('Discard unsaved edits?')) return
                setEditPath(p)
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
      <div className="garage-vehicle-name">{vehicleLabel(vehicle)}</div>
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

function ProfileDetail({ vehicle, files, editPath, content, dirty, saving, dropping,
  onSelectFile, onDelete, onContentChange, onSave, onDrop, onDragOver, onDragLeave, onCreateProfile,
}: {
  vehicle: VehicleSummary
  files: { name: string; path: string }[]
  editPath: string | null
  content: string
  dirty: boolean
  saving: boolean
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
            <span className="garage-file-name">{f.name}</span>
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
                {dirty && <span style={{ color: 'var(--signal)', marginLeft: 8 }}>unsaved</span>}
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
