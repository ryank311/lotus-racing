// The Garage's 3D model panel for one car: which model of the shared
// library the replay draws for it (or none: the placeholder shape), a 3D
// viewer of it fitted exactly as the replay fits it, the fit itself (yaw,
// length, position, the driver's eye and the Garmin camera), and the
// library: upload, rename, credit and delete. The viewer (three.js) loads
// only when this panel opens.

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, humaniseBytes } from '../api'
import {
  CAR_PRESETS, carModelFor, glbCredits, glbJsonLength, MAX_CAR_MODEL_BYTES, presetFor, presetKeysIn,
  type CarModel, type CarModelFit,
} from '../../shared/replay'
import { fullFit, type FullFit } from '../components/carFit'
import type { CarView } from '../components/CarModelViewer'

const CarModelViewer = lazy(() => import('../components/CarModelViewer'))

type Vec3 = [number, number, number]
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const byName = (a: CarModel, b: CarModel) => a.name.localeCompare(b.name)

export function CarModelPanel({ vehicleKey: key, vehicleName, models, onModels, onFitPending }: {
  /** "LOTUS EXIGE": the key models are matched by; null when Garmin has no make or model. */
  vehicleKey: string | null
  vehicleName: string
  models: CarModel[]
  onModels: (next: CarModel[] | ((list: CarModel[]) => CarModel[])) => void
  /** An unsaved fit's save (for the page's unsaved-changes guard), or null. */
  onFitPending: (save: (() => Promise<boolean>) | null) => void
}) {
  const current = carModelFor(models, key)
  const preset = useMemo(() => presetFor(key), [key])
  const presetIsCar = !!key && (!!CAR_PRESETS[key] || presetKeysIn(key).length > 0)
  const [view, setView] = useState<CarView>('orbit')
  const [markers, setMarkers] = useState(true)
  const [draft, setDraft] = useState<{ id: string; fit: CarModelFit } | null>(null)
  const fitDraft = draft && draft.id === current?.id ? draft.fit : null
  const fit = fitDraft ?? current?.fit ?? null
  const [choosing, setChoosing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => { setStatus(''); setError(null) }, [key])

  const saveFit = useCallback(async (): Promise<boolean> => {
    if (!draft) return true
    setStatus('Saving the fit…')
    setError(null)
    try {
      const saved = await api.updateCarModel(draft.id, { fit: draft.fit })
      onModels(list => list.map(m => (m.id === saved.id ? saved : m)))
      setDraft(null)
      setStatus('Fit saved')
      return true
    } catch (e) {
      setStatus('')
      setError(`Could not save the fit: ${message(e)}`)
      return false
    }
  }, [draft, onModels])
  useEffect(() => { onFitPending(fitDraft ? saveFit : null) }, [fitDraft, saveFit, onFitPending])
  useEffect(() => () => onFitPending(null), [onFitPending])

  // Choosing makes it THE model for this car (and no other model's).
  const choose = async (id: string | null) => {
    if (!key || choosing) return
    if (fitDraft && !window.confirm('Discard the unsaved fit?')) return
    setDraft(null)
    setChoosing(id ?? 'none')
    setError(null)
    setStatus('')
    try { onModels(await api.assignCarModel(key, id)) } catch (e) { setError(`Could not change the model: ${message(e)}`) } finally { setChoosing(null) }
  }

  const edit = (change: (fit: FullFit) => CarModelFit) => {
    if (!current || !fit) return
    setStatus('')
    setDraft({ id: current.id, fit: change(fullFit(fit, preset)) })
  }
  // A model's own car (its title names it) gives its default fit: a model's yaw is its own.
  const modelPreset = current ? presetFor(presetKeysIn(current.name)[0] ?? key) : preset
  const lookThrough = (target: CarView) => setView(view === target ? 'orbit' : target)

  if (!key) {
    return <div className="garage-car3d">
      <p className="garage-car3d-note">Garmin has no make or model for this car, so it cannot be given a 3D model. The replay draws the placeholder shape.</p>
    </div>
  }

  const chosen = choosing ?? current?.id ?? 'none'
  const full = fit ? fullFit(fit, preset) : null
  return <div className="garage-car3d">
    <div className="garage-car3d-viewer">
      <Suspense fallback={<div className="garage-car3d-loading" role="status">Loading the 3D viewer…</div>}>
        <CarModelViewer model={current} preset={preset} presetIsCar={presetIsCar} fit={fit}
          view={view} onView={setView} markers={markers} onMarkers={setMarkers} />
      </Suspense>
    </div>

    <div className="garage-car3d-controls">
      <section className="garage-car3d-section" aria-labelledby="garage-model-choice">
        <div className="garage-car3d-title" id="garage-model-choice">Model in the replay</div>
        <p className="garage-car3d-note">Used for every {key} on this server.</p>
        <div className="garage-model-options" role="radiogroup" aria-labelledby="garage-model-choice" aria-busy={!!choosing}>
          <ModelOption name="carModel" value="none" checked={chosen === 'none'} disabled={!!choosing} onChoose={() => void choose(null)}
            title="None (placeholder shape)" meta={`A plain shape at the ${preset.name}’s size`} />
          {models.map(model => <LibraryModel key={model.id} model={model} vehicleKey={key} checked={chosen === model.id} disabled={!!choosing}
            onChoose={() => void choose(model.id)} onModels={onModels} onError={setError} />)}
        </div>
        <UploadModel vehicleKey={key} onModels={onModels} onError={setError} />
      </section>

      {current && full ? <section className="garage-car3d-section garage-fit" aria-labelledby="garage-fit-title">
        <div className="garage-fit-head">
          <span className="garage-car3d-title" id="garage-fit-title">Fit in the car</span>
          {fitDraft && <span className="garage-fit-dirty">Unsaved</span>}
        </div>
        <div className="garage-fit-row">
          <span>Nose points</span>
          <div className="garage-fit-seg" role="group" aria-label="Nose points">
            {[0, 90, 180, 270].map(yaw => <button key={yaw} type="button" className={full.yawDeg === yaw ? 'on' : ''} aria-pressed={full.yawDeg === yaw}
              onClick={() => edit(f => ({ ...f, yawDeg: yaw }))}>{yaw}°</button>)}
          </div>
        </div>
        <NumberField label="Length" unit="m" value={full.lengthM} step={0.01} min={1} max={12} decimals={2} onChange={v => edit(f => ({ ...f, lengthM: v }))} />
        <FitGroup title="Position">
          <Vec3Fields label={['Left', 'Up', 'Forward']} value={full.offsetM} range={200} onChange={offsetM => edit(f => ({ ...f, offsetM }))} />
        </FitGroup>
        <FitGroup title="Driver’s eye" marker="eye" looking={view === 'eye'} onLook={() => lookThrough('eye')}>
          <Vec3Fields label={['Left', 'Height', 'Forward']} value={full.eyeM} range={300} onChange={eyeM => edit(f => ({ ...f, eyeM }))} />
        </FitGroup>
        <FitGroup title="Garmin camera" marker="garmin" looking={view === 'garmin'} onLook={() => lookThrough('garmin')}>
          <Vec3Fields label={['Left', 'Height', 'Forward']} value={full.dashcamM} range={300} onChange={dashcamM => edit(f => ({ ...f, dashcamM }))} />
          <NumberField label="Tilt up" unit="°" value={-full.dashcamPitchDeg} step={0.5} min={-45} max={45} decimals={1} onChange={v => edit(f => ({ ...f, dashcamPitchDeg: -v }))} />
          <NumberField label="Lens" unit="°" value={full.dashcamFovDeg} step={1} min={40} max={170} decimals={0} onChange={v => edit(f => ({ ...f, dashcamFovDeg: v }))} />
        </FitGroup>
        <div className="garage-fit-actions">
          <button type="button" className="btn primary tiny" disabled={!fitDraft} onClick={() => void saveFit()}>Save fit</button>
          <button type="button" className="btn ghost tiny" disabled={!fitDraft} onClick={() => { setDraft(null); setStatus('') }}>Undo</button>
          <button type="button" className="btn ghost tiny" title="The fit this car’s models start from" onClick={() => edit(() => structuredClone(modelPreset.fit))}>{modelPreset.name} default</button>
        </div>
        <p className="garage-car3d-note">Left is the driver’s left; forward is towards the nose. Changes show in the viewer at once and reach the replay when saved.</p>
      </section> : <section className="garage-car3d-section">
        <p className="garage-car3d-note">The replay draws a plain shape at the {preset.name}’s real size ({preset.lengthM.toFixed(2)} × {preset.widthM.toFixed(2)} × {preset.heightM.toFixed(2)} m). Choose or upload a model of the car to fit it.</p>
      </section>}

      {error && <p className="garage-car3d-error" role="alert">{error}</p>}
      {status && <p className="garage-car3d-status" role="status">{status}</p>}
    </div>
  </div>
}

function ModelOption({ name, value, title, meta, checked, disabled, onChoose, children }: {
  name: string; value: string; title: string; meta: string; checked: boolean; disabled: boolean; onChoose: () => void; children?: React.ReactNode
}) {
  return <div className={`garage-model-option ${checked ? 'on' : ''}`}>
    <label>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChoose} />
      <span className="garage-model-option-text">
        <span className="garage-model-option-name">{title}</span>
        <span className="garage-model-option-meta">{meta}</span>
      </span>
    </label>
    {children}
  </div>
}

// One model of the library: choose it, or open it to rename, credit or delete.
function LibraryModel({ model, vehicleKey, checked, disabled, onChoose, onModels, onError }: {
  model: CarModel; vehicleKey: string; checked: boolean; disabled: boolean
  onChoose: () => void
  onModels: (next: CarModel[] | ((list: CarModel[]) => CarModel[])) => void
  onError: (error: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const others = model.matches.filter(k => k !== vehicleKey)
  const meta = [humaniseBytes(model.sizeBytes), others.length ? `${checked ? 'also ' : ''}for ${others.join(', ')}` : null].filter(Boolean).join(' · ')

  const change = async (patch: Partial<Pick<CarModel, 'name' | 'attribution'>>) => {
    setBusy(true)
    onError(null)
    try {
      const updated = await api.updateCarModel(model.id, patch)
      onModels(list => list.map(m => (m.id === updated.id ? updated : m)).sort(byName))
    } catch (e) { onError(message(e)) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!window.confirm(`Delete the 3D model “${model.name}” for every driver?`)) return
    setBusy(true)
    onError(null)
    try {
      await api.deleteCarModel(model.id)
      onModels(list => list.filter(m => m.id !== model.id))
    } catch (e) { onError(message(e)); setBusy(false) }
  }

  return <ModelOption name="carModel" value={model.id} title={model.name} meta={meta} checked={checked} disabled={disabled || busy} onChoose={onChoose}>
    <button type="button" className="garage-model-edit" aria-expanded={open} aria-label={`Edit ${model.name}`} onClick={() => setOpen(o => !o)}>{open ? 'Done' : 'Edit'}</button>
    {open && <div className="garage-model-editor" aria-busy={busy}>
      <label className="garage-model-field">
        <span>Name</span>
        <input defaultValue={model.name} key={`${model.id}:${model.name}`} disabled={busy}
          onBlur={e => { const name = e.target.value.trim(); if (name && name !== model.name) void change({ name }) }} />
      </label>
      <details className="garage-model-credit-details">
        <summary>Credit (kept with the model, not shown)</summary>
        <textarea rows={2} defaultValue={model.attribution ?? ''} key={`${model.id}:${model.attribution ?? ''}`} disabled={busy} aria-label="Credit"
          onBlur={e => { const attribution = e.target.value.trim() || null; if (attribution !== model.attribution) void change({ attribution }) }} />
      </details>
      <div className="garage-model-meta">{model.fileName}{model.matches.length ? ` · used for ${model.matches.join(', ')}` : ' · not used for a car'}</div>
      <div className="garage-model-actions">
        <button type="button" className="btn tiny ghost garage-model-delete" disabled={busy} onClick={() => void remove()}>Delete for every driver</button>
      </div>
    </div>}
  </ModelOption>
}

// Upload a .glb; by default it becomes this car's model straight away.
function UploadModel({ vehicleKey, onModels, onError }: {
  vehicleKey: string
  onModels: (next: CarModel[] | ((list: CarModel[]) => CarModel[])) => void
  onError: (error: string | null) => void
}) {
  const [draft, setDraft] = useState<{ file: File; name: string; attribution: string; use: boolean } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // Name and credit come from the file's asset.extras (Sketchfab writes
  // title, author, licence and source there).
  const pick = async (file: File | undefined) => {
    onError(null)
    if (!file) return
    if (!/\.glb$/i.test(file.name)) { onError('Choose a .glb file (glTF binary).'); return }
    if (file.size > MAX_CAR_MODEL_BYTES) { onError(`That model is larger than ${MAX_CAR_MODEL_BYTES / 1024 ** 2} MB.`); return }
    const length = glbJsonLength(new Uint8Array(await file.slice(0, 20).arrayBuffer()))
    if (length == null) { onError('That file is not a glTF 2 binary (.glb).'); return }
    let credits: { name: string | null; attribution: string | null } = { name: null, attribution: null }
    try { credits = glbCredits(JSON.parse(await file.slice(20, 20 + length).text())) } catch { /* the server checks it */ }
    setDraft({ file, name: credits.name ?? file.name.replace(/\.glb$/i, '').replace(/_+/g, ' '), attribution: credits.attribution ?? '', use: true })
  }

  const upload = async () => {
    if (!draft) return
    onError(null)
    setProgress(0)
    try {
      const model = await api.uploadCarModel(draft.file, {
        name: draft.name.trim(), attribution: draft.attribution.trim() || null, matches: draft.use ? [vehicleKey] : [],
      }, (sent, total) => setProgress(total ? sent / total : 1))
      onModels(list => [...list.filter(m => m.id !== model.id), model].sort(byName))
      setDraft(null)
      // Make it the only model for this car.
      if (draft.use) onModels(await api.assignCarModel(vehicleKey, model.id))
    } catch (e) {
      onError(message(e))
    } finally {
      setProgress(null)
    }
  }

  return <>
    {draft ? <div className="garage-model-upload">
      <label className="garage-model-field">
        <span>Name</span>
        <input value={draft.name} disabled={progress != null} onChange={e => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <details className="garage-model-credit-details">
        <summary>Credit (kept with the model, not shown)</summary>
        <textarea rows={2} value={draft.attribution} disabled={progress != null} aria-label="Credit" placeholder="“Title” by author (licence)"
          onChange={e => setDraft({ ...draft, attribution: e.target.value })} />
      </details>
      <label className="garage-model-use">
        <input type="checkbox" checked={draft.use} disabled={progress != null} onChange={e => setDraft({ ...draft, use: e.target.checked })} />
        Use it for {vehicleKey}
      </label>
      <div className="garage-model-meta">{draft.file.name} · {humaniseBytes(draft.file.size)}</div>
      {progress != null && <div className="garage-model-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>}
      <div className="garage-model-actions">
        <button type="button" className="btn tiny ghost" disabled={progress != null} onClick={() => setDraft(null)}>Cancel</button>
        <button type="button" className="btn tiny primary" disabled={progress != null || !draft.name.trim()} onClick={() => void upload()}>
          {progress != null ? `Uploading ${Math.round(progress * 100)}%` : 'Upload'}
        </button>
      </div>
    </div> : <button type="button" className="garage-model-add" onClick={() => input.current?.click()}
      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void pick(e.dataTransfer.files[0]) }}>
      + Upload a model (.glb)
    </button>}
    <input ref={input} type="file" accept=".glb,model/gltf-binary" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = '' }} />
  </>
}

function FitGroup({ title, marker, looking, onLook, children }: {
  title: string; marker?: 'eye' | 'garmin'; looking?: boolean; onLook?: () => void; children: React.ReactNode
}) {
  return <div className="garage-fit-group" role="group" aria-label={title}>
    <div className="garage-fit-group-head">
      {marker && <i className={`garage-fit-marker ${marker}`} aria-hidden="true" />}
      <span>{title}</span>
      {onLook && <button type="button" className={`garage-fit-look ${looking ? 'on' : ''}`} aria-pressed={looking} onClick={onLook}>{looking ? 'Back to orbit' : 'Look through'}</button>}
    </div>
    {children}
  </div>
}

// [left, up, forward] in centimetres.
function Vec3Fields({ label, value, range, onChange }: { label: [string, string, string]; value: Vec3; range: number; onChange: (value: Vec3) => void }) {
  return <>{label.map((name, axis) => <NumberField key={name} label={name} unit="cm" value={value[axis] * 100} step={1} min={-range} max={range} decimals={0}
    onChange={cm => { const next = [...value] as Vec3; next[axis] = Math.round(cm * 10) / 1000; onChange(next) }} />)}</>
}

function NumberField({ label, unit, value, step, min, max, decimals, onChange }: {
  label: string; unit: string; value: number; step: number; min: number; max: number; decimals: number; onChange: (value: number) => void
}) {
  const id = useId()
  const [text, setText] = useState<string | null>(null)
  const round = (v: number) => Math.round(v / step) * step
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Number(round(v).toFixed(Math.max(decimals, 3))))))
  return <div className="garage-fit-row">
    <label htmlFor={id}>{label}</label>
    <div className="garage-fit-stepper">
      <button type="button" aria-label={`${label} −${step}${unit}`} onClick={() => { setText(null); set(value - step) }}>−</button>
      <input id={id} inputMode="decimal" value={text ?? value.toFixed(decimals)}
        onChange={e => {
          setText(e.target.value)
          const v = Number(e.target.value.replace(',', '.'))
          if (e.target.value.trim() && Number.isFinite(v) && v >= min && v <= max) onChange(v)
        }}
        onBlur={() => setText(null)} />
      <span className="garage-fit-unit">{unit}</span>
      <button type="button" aria-label={`${label} +${step}${unit}`} onClick={() => { setText(null); set(value + step) }}>+</button>
    </div>
  </div>
}
