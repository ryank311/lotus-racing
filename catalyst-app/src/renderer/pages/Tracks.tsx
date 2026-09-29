import { useResource } from '../useResource'
import { InlineLoadStatus, LoadingRows, ChartPlaceholder } from '../components/Loading'
// Tracks editor — list every (track, configuration) we have data for, and
// let the user click on the SVG track map to set / correct the apex point of
// each named corner. Saves back to tracks/*.yaml so briefs and the Analysis
// page pick up the cleaned-up corners on their next run.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { NavLink, useNavigation, useRoute, useUnsavedChanges } from '../navigation'
import { routeUrl, segment } from '../routes'
import { TrackMap } from '../components/TrackMap'
import type { TrackComplexesResponse, TrackComplexPayload, TrackListEntry } from '../../shared/types'
import './pages-extras.css'

interface EditableCorner {
  _key: number  // stable React key — never changes after creation
  turn: string
  name?: string
  direction?: string
  character?: string
  apex_idx?: number
  // Zone bounds default to apex ± 50 m on save; users can override here.
  dist_idx_start?: number
  dist_idx_end?: number
  apex_radius_m?: number
}

let _cornerKey = 0

// Separate component so we can hold local input state while the user types,
// only committing (and collision-checking) on blur or Enter. Without this,
// typing "T12" through the intermediate "T1" silently rejects the keystroke
// because T1 already exists.
function TurnInput({ value, onCommit, onFocus }: { value: string; onCommit: (v: string) => void; onFocus?: () => void }) {
  const [local, setLocal] = useState(value)
  useEffect(() => { setLocal(value) }, [value])
  return (
    <input
      className="tracks-corner-turn"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={() => onCommit(local)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      onFocus={onFocus}
      onClick={e => e.stopPropagation()}
    />
  )
}

// What we render under "zone ±" — uses the current bounds if set, else the
// default that the server will fill in at save time. Kept symmetric (single
// half-width) because asymmetric corner shaping is rarely needed and the UI
// is much simpler with one number.
function zoneHalfWidth(c: EditableCorner, defaultHalf = 50): number {
  if (c.apex_idx == null) return defaultHalf
  if (c.dist_idx_start == null && c.dist_idx_end == null) return defaultHalf
  const lo = c.dist_idx_start ?? (c.apex_idx - defaultHalf)
  const hi = c.dist_idx_end   ?? (c.apex_idx + defaultHalf)
  return Math.max(1, Math.round((hi - lo) / 2))
}

interface LoadedTrack {
  geometry: any   // typed loosely — the structural fields TrackMap consumes
  yamlPath: string
  yamlExists: boolean
  corners: EditableCorner[]
}

interface TrackPreview {
  centerline: Array<{ x: number; y: number }>
  bbox: { minX: number; maxX: number; minY: number; maxY: number }
}

function TrackSilhouette({ preview }: { preview?: TrackPreview }) {
  if (!preview?.centerline.length) return <span className="tracks-preview-empty">—</span>
  const { minX, maxX, minY, maxY } = preview.bbox
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08
  const points = preview.centerline
    .filter((_, index) => index % 8 === 0 || index === preview.centerline.length - 1)
    .map(point => `${point.x},${-point.y}`)
    .join(' ')
  return (
    <svg
      className="tracks-preview"
      viewBox={`${minX - pad} ${-maxY - pad} ${Math.max(1, maxX - minX + pad * 2)} ${Math.max(1, maxY - minY + pad * 2)}`}
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  )
}

// ── corner complexes ─────────────────────────────────────────────────────────

const COMPLEX_SOURCE: Record<TrackComplexesResponse['source'], string> = {
  track: 'From the track file',
  derived: 'Derived from the fastest valid lap',
  segments: 'Garmin segments (fallback until the layout has corners and a valid lap)',
}

// Blocking problems: every complex runs forwards, in lap order, on the lap.
// Lap distance runs a little past the mean line, so allow some slack at the end.
function complexErrors(complexes: TrackComplexPayload[], totalM: number): string[] {
  const errors: string[] = []
  const maxM = totalM > 0 ? totalM + Math.max(50, totalM * 0.03) : Infinity
  complexes.forEach((c, i) => {
    const label = c.name.trim() || `Complex ${i + 1}`
    if (!Number.isFinite(c.startM) || !Number.isFinite(c.endM)) { errors.push(`${label}: enter a start and end distance.`); return }
    if (c.startM >= c.endM) errors.push(`${label}: start must be before end.`)
    if (c.startM < 0 || c.endM > maxM) errors.push(`${label}: must lie within 0–${Math.round(totalM)} m.`)
    const prev = complexes[i - 1]
    if (prev && Number.isFinite(prev.endM) && c.startM < prev.endM) errors.push(`${label}: starts before the previous complex ends.`)
  })
  return errors
}

function useTrackComplexes(meanLineGuid: string | null) {
  const [saved, setSaved] = useState<TrackComplexesResponse | null>(null)
  const [draft, setDraft] = useState<TrackComplexPayload[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const current = useRef(meanLineGuid)
  current.current = meanLineGuid

  const apply = (response: TrackComplexesResponse) => {
    setSaved(response)
    setDraft(response.complexes)
  }

  useEffect(() => {
    let cancelled = false
    setSaved(null); setDraft([]); setLoadError(null); setMessage(null)
    if (!meanLineGuid) { setLoading(false); return }
    setLoading(true)
    api.getTrackComplexes(meanLineGuid)
      .then(response => { if (!cancelled) apply(response) })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [meanLineGuid, attempt])

  const dirty = saved != null && JSON.stringify(draft) !== JSON.stringify(saved.complexes)

  // Keep the lap tiled: moving a boundary moves the neighbour that shared it.
  const update = (index: number, patch: Partial<TrackComplexPayload>) => {
    setDraft(list => list.map((c, i) => {
      if (i === index) return { ...c, ...patch }
      if (patch.startM !== undefined && i === index - 1 && Object.is(c.endM, list[index].startM)) return { ...c, endM: patch.startM }
      if (patch.endM !== undefined && i === index + 1 && Object.is(c.startM, list[index].endM)) return { ...c, startM: patch.endM }
      return c
    }))
  }

  const run = async (action: () => Promise<TrackComplexesResponse>, done: (response: TrackComplexesResponse) => string) => {
    const guid = current.current
    setBusy(true)
    setMessage(null)
    try {
      const response = await action()
      if (current.current !== guid) return false
      apply(response)
      setMessage({ text: done(response) })
      return true
    } catch (e) {
      if (current.current === guid) setMessage({ text: e instanceof Error ? e.message : String(e), error: true })
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async (totalM: number) => {
    const guid = current.current
    if (!guid) return false
    const errors = complexErrors(draft, totalM)
    if (errors.length) { setMessage({ text: 'Fix the complex ranges before saving.', error: true }); return false }
    return run(
      () => api.saveTrackComplexes(guid, draft.map(c => ({ ...c, name: c.name.trim(), startM: Math.round(c.startM), endM: Math.round(c.endM) }))),
      response => `Saved ${response.complexes.length} complexes`,
    )
  }

  const regenerate = async () => {
    const guid = current.current
    if (!guid) return false
    return run(
      () => api.regenerateTrackComplexes(guid),
      response => response.source === 'segments'
        ? 'No usable braking data on the fastest lap; showing Garmin segments'
        : `Regenerated ${response.complexes.length} complexes from the fastest lap`,
    )
  }

  return {
    saved, draft, loading, loadError, message, busy, dirty,
    update, save, regenerate,
    revert: () => { if (saved) setDraft(saved.complexes); setMessage(null) },
    reload: () => setAttempt(n => n + 1),
  }
}

function ComplexesPanel({ state, totalM, cornersDirty }: {
  state: ReturnType<typeof useTrackComplexes>
  totalM: number
  cornersDirty: boolean
}) {
  const { saved, draft, loading, loadError, message, busy, dirty } = state
  const [confirming, setConfirming] = useState(false)
  const errors = useMemo(() => complexErrors(draft, totalM), [draft, totalM])
  const gaps = draft.slice(1).filter((c, i) => Number.isFinite(c.startM) && c.startM > draft[i].endM).length
  const hasTrackFile = !!saved?.yamlPath
  const numberValue = (n: number) => (Number.isFinite(n) ? n : '')
  const parse = (value: string) => (value.trim() === '' ? NaN : Number(value))

  return (
    <section className="tracks-complexes" aria-label="Corner complexes" aria-busy={loading || busy}>
      <div className="tracks-complexes-header">
        <span className="tracks-complexes-title">Corner complexes</span>
        {saved && <span className="muted small">{COMPLEX_SOURCE[saved.source]} · {saved.complexes.length} complexes</span>}
      </div>
      <p className="tracks-complexes-note">
        A complex runs from one braking zone to the next. The AI coach and focus targets measure time and phases per complex;
        changing boundaries does not move old focus targets, which keep measuring on the boundaries saved with them.
      </p>

      {loading && <><InlineLoadStatus pending label="corner complexes" /><LoadingRows count={3} /></>}
      {loadError && <p role="alert">{loadError} <button className="btn tiny ghost" onClick={state.reload}>Retry</button></p>}

      {saved && !loading && (
        <>
          {draft.length === 0 ? (
            <div className="muted small">No complexes yet. Save corners for this layout, then regenerate from the fastest lap.</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl tracks-complexes-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th style={{ textAlign: 'right' }}>Start m</th>
                    <th style={{ textAlign: 'right' }}>End m</th>
                    <th style={{ textAlign: 'right' }}>Length</th>
                    <th>Corners</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((c, i) => (
                    <tr key={c.id + i}>
                      <td className="small">{i + 1}</td>
                      <td>
                        <input className="tracks-corner-name" aria-label={`Complex ${i + 1} name`} value={c.name}
                          onChange={e => state.update(i, { name: e.target.value })} disabled={busy || !hasTrackFile} />
                      </td>
                      <td>
                        <input className="tracks-corner-zone tracks-complexes-num" type="number" min={0} step={10}
                          aria-label={`Complex ${i + 1} start (m)`} value={numberValue(c.startM)}
                          onChange={e => state.update(i, { startM: parse(e.target.value) })} disabled={busy || !hasTrackFile} />
                      </td>
                      <td>
                        <input className="tracks-corner-zone tracks-complexes-num" type="number" min={0} step={10}
                          aria-label={`Complex ${i + 1} end (m)`} value={numberValue(c.endM)}
                          onChange={e => state.update(i, { endM: parse(e.target.value) })} disabled={busy || !hasTrackFile} />
                      </td>
                      <td className="num muted">{Number.isFinite(c.endM - c.startM) ? `${Math.round(c.endM - c.startM)} m` : '—'}</td>
                      <td className="small">{c.corners.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {errors.length > 0 && <ul className="tracks-complexes-errors" role="alert">{errors.map(e => <li key={e}>{e}</li>)}</ul>}
          {errors.length === 0 && gaps > 0 && (
            <p className="tracks-complexes-note">{gaps} {gaps === 1 ? 'gap' : 'gaps'} between complexes: time spent there is not measured.</p>
          )}
          {!hasTrackFile && <p className="tracks-complexes-note">Save this layout's corners first; complexes are stored in its track file.</p>}

          {confirming && (
            <div className="tracks-complexes-confirm" role="group" aria-label="Confirm regenerating complexes">
              <span>
                Replace the complexes with boundaries derived from this layout's fastest valid lap?
                {dirty && ' Unsaved edits will be lost.'}
                {cornersDirty && ' It uses the saved corners, so save corner changes first.'}
              </span>
              <button className="btn tiny primary" disabled={busy} onClick={async () => { setConfirming(false); await state.regenerate() }}>Regenerate</button>
              <button className="btn tiny ghost" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          )}

          <div className="tracks-complexes-actions">
            <button className="btn primary" disabled={!dirty || busy || errors.length > 0 || !hasTrackFile} onClick={() => void state.save(totalM)}>
              {busy ? 'Working…' : dirty ? 'Save complexes' : 'Saved'}
            </button>
            <button className="btn ghost" disabled={!dirty || busy} onClick={state.revert}>Revert</button>
            <button className="btn ghost" disabled={busy || !hasTrackFile || confirming} onClick={() => setConfirming(true)}>
              Regenerate from fastest lap
            </button>
            {message && <span className={`small ${message.error ? 'tracks-complexes-error' : 'muted'}`} role={message.error ? 'alert' : 'status'}>{message.text}</span>}
          </div>
        </>
      )}
    </section>
  )
}

export function Tracks() {
  const { id: selectedGuid, params } = useRoute()
  const { go, query } = useNavigation()
  const selectedTrackName = params.get('track')
  const selectedTurn = params.get('turn')
  const setSelectedTurn = (turn: string | null) => query({ turn })
  const setSelectedGuid = (guid: string | null) => go(guid ? `/tracks/${segment(guid)}` : '/tracks')
  const [error, setError] = useState<string | null>(null)
  const listResource = useResource(() => api.listTracks())
  const list = listResource.data ?? []
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [trackPreviews, setTrackPreviews] = useState<Record<string, TrackPreview>>({})
  const [loaded, setLoaded] = useState<LoadedTrack | null>(null)
  const [loading, setLoading] = useState(false)
  const [corners, setCorners] = useState<EditableCorner[]>([])
  const [dirty, setDirty] = useState(false)
  const [savingMsg, setSavingMsg] = useState<string | null>(null)
  const complexes = useTrackComplexes(loaded && selectedGuid ? selectedGuid : null)

  // ── data loading ──────────────────────────────────────────────────────────

  const trackGroups = useMemo(() => {
    const groups = new Map<string, TrackListEntry[]>()
    for (const entry of list) {
      const current = groups.get(entry.trackName) ?? []
      current.push(entry)
      groups.set(entry.trackName, current)
    }
    return [...groups.entries()].map(([trackName, layouts]) => ({ trackName, layouts }))
  }, [list])

  useEffect(() => {
    let cancelled = false
    void Promise.all(trackGroups.map(async group => {
      const representative = group.layouts.find(layout => layout.meanLineExists && layout.meanLineGuid)
      if (!representative?.meanLineGuid) return null
      const detail = await api.getTrack(representative.meanLineGuid) as LoadedTrack | null
      if (!detail?.geometry) return null
      return [group.trackName, {
        centerline: detail.geometry.centerline,
        bbox: detail.geometry.bbox,
      }] as const
    })).then(results => {
      if (cancelled) return
      setTrackPreviews(Object.fromEntries(results.filter((item): item is NonNullable<typeof item> => item != null)))
    }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [trackGroups])

  useEffect(() => {
    let cancelled = false
    setLoaded(null); setError(null); setDirty(false)
    if (!selectedGuid) { setLoading(false); return }
    void (async () => {
      setLoading(true)
      try {
        const detail = await api.getTrack(selectedGuid) as LoadedTrack | null
        if (cancelled) return
        setLoaded(detail)
        if (!detail) setError('This track layout is unavailable.')
        setCorners(((detail?.corners ?? []) as EditableCorner[]).map(c => ({ ...c, _key: _cornerKey++ })))
        setDirty(false)
        setSavingMsg(null)
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedGuid, detailAttempt])

  // ── derived ───────────────────────────────────────────────────────────────
  const trackMapInput = useMemo(() => {
    if (!loaded) return null
    return {
      trackGeometry: loaded.geometry,
      racingLines: [],
      sessions: [{ sg: 'edit' }],
    }
  }, [loaded])

  const sortedCorners = useMemo(
    () => [...corners].sort((a, b) => (a.apex_idx ?? 0) - (b.apex_idx ?? 0)),
    [corners],
  )

  const activeEntry = list.find(t => t.meanLineGuid === selectedGuid) ?? null
  const activeTrackName = activeEntry?.trackName ?? selectedTrackName ?? trackGroups[0]?.trackName ?? null
  const activeLayouts = trackGroups.find(group => group.trackName === activeTrackName)?.layouts ?? []

  const selectTrack = (trackName: string) => {
    const layouts = trackGroups.find(group => group.trackName === trackName)?.layouts ?? []
    const first = layouts.find(layout => layout.meanLineExists && layout.meanLineGuid) ?? layouts[0]
    go(first?.meanLineGuid ? `/tracks/${segment(first.meanLineGuid)}` : routeUrl('/tracks', { track: trackName }))
  }

  // ── corner mutations ──────────────────────────────────────────────────────
  const updateCorner = (turn: string, patch: Partial<EditableCorner>) => {
    setCorners(curr => curr.map(c => (c.turn === turn ? { ...c, ...patch } : c)))
    setDirty(true)
  }

  const onPickApex = (apexIdx: number) => {
    if (!selectedTurn) return
    const cur = corners.find(c => c.turn === selectedTurn)
    if (!cur) return
    // Preserve the existing zone half-width by re-centring it on the new apex,
    // so picking a different apex point also moves the (entry…exit) window.
    // First-time apex placement gets the default 50 m half-width on save.
    const patch: Partial<EditableCorner> = { apex_idx: apexIdx }
    if (cur.dist_idx_start != null && cur.dist_idx_end != null && cur.apex_idx != null) {
      const half = Math.max(1, Math.round((cur.dist_idx_end - cur.dist_idx_start) / 2))
      patch.dist_idx_start = Math.max(0, apexIdx - half)
      patch.dist_idx_end = apexIdx + half
    }
    updateCorner(selectedTurn, patch)
  }

  const addCorner = () => {
    const existing = new Set(corners.map(c => c.turn))
    let n = 1
    while (existing.has(`T${n}`)) n++
    const newTurn = `T${n}`
    const next: EditableCorner = { _key: _cornerKey++, turn: newTurn, name: '' }
    setCorners([...corners, next])
    setSelectedTurn(newTurn)
    setDirty(true)
  }

  const deleteCorner = (turn: string) => {
    setCorners(corners.filter(c => c.turn !== turn))
    if (selectedTurn === turn) setSelectedTurn(null)
    setDirty(true)
  }

  const renameCorner = (oldTurn: string, newTurn: string) => {
    if (!newTurn.trim() || newTurn === oldTurn) return
    if (corners.some(c => c.turn === newTurn)) return // collision
    setCorners(corners.map(c => (c.turn === oldTurn ? { ...c, turn: newTurn } : c)))
    if (selectedTurn === oldTurn) setSelectedTurn(newTurn)
    setDirty(true)
  }

  const save = async () => {
    if (!loaded || !selectedGuid) return false
    setSavingMsg('saving…')
    try {
      const res = await api.saveTrackCorners({
        yamlPath: loaded.yamlPath,
        meanLineGuid: selectedGuid,
        corners: corners.filter(c => c.apex_idx != null) as any[],
      })
      setSavingMsg(`saved ${res.cornerCount} corners`)
      setDirty(false)
      // refresh list to update yamlExists / cornerCount badges
      void listResource.reload()
      // A new track file lets complexes be derived and saved.
      if (!complexes.dirty) complexes.reload()
      setTimeout(() => setSavingMsg(null), 2500)
      return true
    } catch (e: any) {
      setSavingMsg(`error: ${e.message ?? e}`)
      return false
    }
  }
  const totalM = Number(loaded?.geometry?.totalDistM) || 0
  const saveAll = async () => {
    if (dirty && !(await save())) return false
    if (complexes.dirty && !(await complexes.save(totalM))) return false
    return true
  }
  useUnsavedChanges(dirty || complexes.dirty, saveAll)

  const revert = async () => {
    if (!selectedGuid) return
    const detail = await api.getTrack(selectedGuid) as LoadedTrack | null
    setLoaded(detail)
    setCorners(((detail?.corners ?? []) as EditableCorner[]).map(c => ({ ...c, _key: _cornerKey++ })))
    setDirty(false)
    setSavingMsg(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    const unsub = typeof api.onSaveRequest === 'function' ? api.onSaveRequest(() => { if (dirty) void save() }) : () => {}
    return () => {
      window.removeEventListener('keydown', onKey)
      unsub()
    }
  }, [loaded, selectedGuid, corners, dirty])

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// track configuration</div>
          <div className="page-title">Tra<span className="accent">cks</span></div>
        </div>
        <div className="page-meta">
          <InlineLoadStatus label="tracks" pending={listResource.pending} error={listResource.error} hasData={listResource.data !== undefined} onRetry={listResource.reload} />
          {listResource.data !== undefined && <>{trackGroups.length} {trackGroups.length === 1 ? 'track' : 'tracks'} · {list.length} layouts<br /></>}
          <span className="muted">
            {activeEntry ? `${activeEntry.trackName} · ${activeEntry.configName}` : '—'}
          </span>
        </div>
      </header>

      <div className="page-body tracks-body" data-route-loading={listResource.initialLoading || loading || undefined}>
        {error && <p role="alert">{error} <button className="btn ghost" onClick={() => setDetailAttempt(n => n + 1)}>Retry track</button> <NavLink to="/tracks">All tracks</NavLink></p>}
        {/* Track and layout pickers */}
        <section className="tracks-selector" aria-label="Track and layout selector" aria-busy={listResource.pending}>
          {listResource.initialLoading && <LoadingRows />}
          {listResource.data !== undefined && list.length === 0 && (
            <div className="muted small">No track data yet — sync some sessions first.</div>
          )}
          {trackGroups.length > 0 && (
            <>
              <div className="tracks-selector-label">Circuit</div>
              <div className="tracks-circuit-picker">
                {trackGroups.map(group => {
                  const active = activeTrackName === group.trackName
                  const sessionCount = group.layouts.reduce((sum, layout) => sum + layout.sessionCount, 0)
                  return (
                    <NavLink key={group.trackName} to={routeUrl('/tracks', { track: group.trackName })} className={`tracks-circuit-card ${active ? 'active' : ''}`}
                      aria-current={active ? 'true' : undefined}>
                      <TrackSilhouette preview={trackPreviews[group.trackName]} />
                      <span className="tracks-circuit-copy">
                        <strong>{group.trackName}</strong>
                        <small>{group.layouts.length} {group.layouts.length === 1 ? 'layout' : 'layouts'} · {sessionCount} sessions</small>
                      </span>
                    </NavLink>
                  )
                })}
              </div>

              <div className="tracks-layout-row">
                <div className="tracks-selector-label">Layout</div>
                <div className="tracks-picker">
                  {activeLayouts.map(t => (
                    <NavLink to={t.meanLineGuid ? `/tracks/${segment(t.meanLineGuid)}` : routeUrl('/tracks', { track: t.trackName })}
                      key={`${t.meanLineGuid ?? 'noguid'}-${t.configName}`}
                      className={`chip ${selectedGuid === t.meanLineGuid ? 'signal' : ''}`}
                      aria-disabled={!t.meanLineExists}
                      onClick={e => { if (!t.meanLineExists) e.preventDefault() }}
                      title={t.meanLineExists ? '' : 'mean_line.pb missing — re-sync to fetch it'}
                      style={{ cursor: t.meanLineExists ? 'pointer' : 'not-allowed' }}
                    >
                      {t.configName || '(unnamed layout)'}
                      <span className="muted" style={{ marginLeft: 6, fontSize: 9 }}>
                        · {t.sessionCount}s
                        {t.yamlExists ? ` · ${t.cornerCount} corners` : ' · no yaml'}
                      </span>
                    </NavLink>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>

        {loading && <div data-route-loading><InlineLoadStatus pending label="track geometry" /><ChartPlaceholder title="Track map" /></div>}

        {!loading && loaded && trackMapInput && (
          <div className="tracks-editor">
            <div className="tracks-map">
              <TrackMap
                data={trackMapInput as any}
                height={620}
                edit={{
                  corners: sortedCorners as any[],
                  selectedTurn,
                  onPickApex,
                  onSelectTurn: setSelectedTurn,
                }}
              />
              <div className="tracks-map-hint">
                {selectedTurn
                  ? <>Selected <strong style={{ color: 'var(--signal)' }}>{selectedTurn}</strong> — click the map to set its apex.</>
                  : <>Pick a corner on the right (or add one) to start placing its apex.</>}
              </div>
            </div>

            <aside className="tracks-sidebar">
              <div className="tracks-sidebar-header">
                <span>Corners</span>
                <span className="spacer" />
                <button className="btn tiny ghost" onClick={addCorner}>+ Add</button>
              </div>

              <div className="tracks-corner-list">
                {sortedCorners.length === 0 && (
                  <div className="muted small" style={{ padding: 12 }}>
                    No corners yet. Click <em>+ Add</em>, then click on the track to set the apex.
                  </div>
                )}
                {sortedCorners.map(c => {
                  const active = selectedTurn === c.turn
                  return (
                    <div
                      key={c._key}
                      className={`tracks-corner-row ${active ? 'active' : ''}`}
                      onClick={() => setSelectedTurn(c.turn)}
                    >
                      <TurnInput
                        value={c.turn}
                        onCommit={newTurn => renameCorner(c.turn, newTurn)}
                        onFocus={() => setSelectedTurn(c.turn)}
                      />
                      <input
                        className="tracks-corner-name"
                        placeholder="name (e.g. Horse Shoe)"
                        value={c.name ?? ''}
                        onChange={e => updateCorner(c.turn, { name: e.target.value })}
                        onFocus={() => setSelectedTurn(c.turn)}
                        onClick={e => e.stopPropagation()}
                      />
                      <select
                        className="tracks-corner-dir"
                        value={c.direction ?? ''}
                        onChange={e => updateCorner(c.turn, { direction: e.target.value || undefined })}
                        onFocus={() => setSelectedTurn(c.turn)}
                        onClick={e => e.stopPropagation()}
                      >
                        <option value="">—</option>
                        <option value="left">L</option>
                        <option value="right">R</option>
                      </select>
                      <span className="tracks-corner-apex">
                        {c.apex_idx != null ? `${c.apex_idx} m` : <span className="muted">no apex</span>}
                      </span>
                      <input
                        className="tracks-corner-zone"
                        type="number"
                        min={5} max={400} step={5}
                        title="Zone half-width (m) — entry/apex/exit window used by the Analysis charts and briefs"
                        value={zoneHalfWidth(c)}
                        onChange={e => {
                          const half = Math.max(1, parseInt(e.target.value, 10) || 0)
                          if (c.apex_idx == null) return
                          updateCorner(c.turn, {
                            dist_idx_start: Math.max(0, c.apex_idx - half),
                            dist_idx_end: c.apex_idx + half,
                          })
                        }}
                        onFocus={() => setSelectedTurn(c.turn)}
                        onClick={e => e.stopPropagation()}
                      />
                      <button
                        className="btn tiny ghost"
                        onClick={e => { e.stopPropagation(); deleteCorner(c.turn) }}
                        title="Delete corner"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>

              <div className="tracks-sidebar-footer">
                <button
                  className="btn primary"
                  onClick={save}
                  disabled={!dirty}
                  title={loaded.yamlPath}
                >
                  {dirty ? 'Save changes' : 'Saved'}
                </button>
                <button className="btn ghost" onClick={revert} disabled={!dirty}>
                  Revert
                </button>
                <span className="muted small" style={{ marginLeft: 'auto' }}>
                  {savingMsg ?? (loaded.yamlExists
                    ? `→ ${loaded.yamlPath.split('/').slice(-1)[0]}`
                    : 'new file will be created')}
                </span>
              </div>
            </aside>
          </div>
        )}

        {!loading && loaded && selectedGuid && (
          <ComplexesPanel state={complexes} totalM={totalM} cornersDirty={dirty} />
        )}
      </div>
    </>
  )
}
