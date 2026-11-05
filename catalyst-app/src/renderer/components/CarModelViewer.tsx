// The Garage's 3D model viewer (three.js, loaded with this module only: the
// Garage imports it lazily). Shows a vehicle's model fitted as the replay
// draws it, or the replay's placeholder shape, with the driver's eye and
// the Garmin camera marked; it can look through either one.

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CarModelFit, CarPreset } from '../../shared/replay'
import { parseGlb } from '../replay/car'
import { CarStudio, type StudioView } from './carStudio'
import './carModelViewer.css'

export type CarView = StudioView

const VIEWS: Array<[CarView, string]> = [['orbit', 'Orbit'], ['eye', 'Driver’s eye'], ['garmin', 'Garmin camera']]

// The last few models' bytes, so switching between them does not refetch.
const bytes = new Map<string, Promise<ArrayBuffer>>()
function modelBytes(id: string): Promise<ArrayBuffer> {
  let pending = bytes.get(id)
  if (!pending) {
    pending = api.getCarModel(id)
    pending.catch(() => bytes.delete(id))
    bytes.set(id, pending)
    while (bytes.size > 3) bytes.delete(bytes.keys().next().value!)
  }
  return pending
}

const metres = (s: { lengthM: number; widthM: number; heightM: number }) => `${s.lengthM.toFixed(2)} × ${s.widthM.toFixed(2)} × ${s.heightM.toFixed(2)} m`

export interface CarModelViewerProps {
  /** The model to show; null shows the placeholder shape. */
  model: { id: string; name: string } | null
  /** The vehicle's preset: the placeholder's size and the fallback eye and camera. */
  preset: CarPreset
  /** The preset is this car's own (its real size is worth comparing). */
  presetIsCar: boolean
  /** The fit to preview (a draft or the saved one). */
  fit: CarModelFit | null
  view: CarView
  onView: (view: CarView) => void
  markers: boolean
  onMarkers: (visible: boolean) => void
}

export default function CarModelViewer({ model, preset, presetIsCar, fit, view, onView, markers, onMarkers }: CarModelViewerProps) {
  const host = useRef<HTMLDivElement>(null)
  const [studio, setStudio] = useState<CarStudio | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [size, setSize] = useState<{ lengthM: number; widthM: number; heightM: number } | null>(null)
  const latestFit = useRef(fit)
  latestFit.current = fit

  useEffect(() => {
    let created: CarStudio
    try { created = new CarStudio(host.current!) } catch (error) {
      setFailure(`3D graphics are unavailable in this browser (${error instanceof Error ? error.message : String(error)}).`)
      return
    }
    created.onSize = setSize
    setStudio(created)
    return () => { created.dispose(); setStudio(null) }
  }, [])

  // A new model (or vehicle) reloads; a new fit refits in place, below.
  const modelId = model?.id ?? null
  useEffect(() => {
    if (!studio) return
    setLoadError(null)
    if (!model) { studio.setCar(null, null, preset); setLoading(null); return }
    let cancelled = false
    setLoading(model.name)
    void (async () => {
      const root = await parseGlb(await modelBytes(model.id))
      if (cancelled) return
      studio.setCar(root, latestFit.current, preset, model.id)
      setLoading(null)
    })().catch(error => {
      if (cancelled) return
      studio.setCar(null, null, preset)
      setLoading(null)
      setLoadError(`${model.name} could not be loaded (${error instanceof Error ? error.message : String(error)}); showing the placeholder.`)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio, modelId, preset])

  const fitKey = fit ? JSON.stringify(fit) : ''
  useEffect(() => { studio?.setFit(latestFit.current, modelId) }, [studio, fitKey, modelId])
  useEffect(() => { studio?.setView(view) }, [studio, view])
  useEffect(() => { studio?.setMarkers(markers) }, [studio, markers])

  const hint = view === 'orbit'
    ? 'Drag to orbit · wheel or pinch to zoom · double-click resets'
    : 'Drag to look around · double-click looks ahead again'
  return <div className="car-viewer" data-view={view}>
    <div className="car-viewer-toolbar">
      <div className="car-viewer-views" role="group" aria-label="View">
        {VIEWS.map(([value, label]) => <button key={value} type="button" className={view === value ? 'on' : ''} aria-pressed={view === value} onClick={() => onView(value)}>{label}</button>)}
      </div>
      <label className="car-viewer-markers"><input type="checkbox" checked={markers} onChange={e => onMarkers(e.target.checked)} />Markers</label>
    </div>
    <div className="car-viewer-stage" ref={host}>
      {loading && <div className="car-viewer-status" role="status"><span className="car-viewer-spinner" aria-hidden="true" />Loading {loading}…</div>}
      {failure && <div className="car-viewer-status error" role="alert">{failure}</div>}
      {studio && <button type="button" className="car-viewer-reset" onClick={() => studio.resetView()} title="Back to the default view (double-click)">Reset</button>}
    </div>
    <p className="car-viewer-hint">
      <span>{hint}</span>
      {view === 'garmin' ? <span>Garmin lens, framed 16:9 like its video</span>
        : size && <span>{metres(size)}{presetIsCar && model ? ` · real car ${metres(preset)}` : ''}</span>}
    </p>
    {loadError && <p className="car-viewer-error" role="alert">{loadError}</p>}
  </div>
}
