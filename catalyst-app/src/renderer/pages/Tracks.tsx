// Tracks editor — list every (track, configuration) we have data for, and
// let the user click on the SVG track map to set / correct the apex point of
// each named corner. Saves back to tracks/*.yaml so briefs and the Analysis
// page pick up the cleaned-up corners on their next run.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { TrackMap } from '../components/TrackMap'
import type { TrackListEntry } from '../../shared/types'

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

export function Tracks() {
  const [list, setList] = useState<TrackListEntry[]>([])
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedTrack | null>(null)
  const [loading, setLoading] = useState(false)
  const [corners, setCorners] = useState<EditableCorner[]>([])
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [savingMsg, setSavingMsg] = useState<string | null>(null)

  // ── data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const tracks = await api.listTracks()
      setList(tracks)
      if (!selectedGuid && tracks.length) {
        const first = tracks.find(t => t.meanLineExists) ?? tracks[0]
        if (first.meanLineGuid) setSelectedGuid(first.meanLineGuid)
      }
    })()
  }, [])

  useEffect(() => {
    if (!selectedGuid) return
    void (async () => {
      setLoading(true)
      try {
        const detail = await api.getTrack(selectedGuid) as LoadedTrack | null
        setLoaded(detail)
        setCorners(((detail?.corners ?? []) as EditableCorner[]).map(c => ({ ...c, _key: _cornerKey++ })))
        setSelectedTurn((detail?.corners?.[0] as EditableCorner | undefined)?.turn ?? null)
        setDirty(false)
        setSavingMsg(null)
      } finally {
        setLoading(false)
      }
    })()
  }, [selectedGuid])

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
    if (!loaded || !selectedGuid) return
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
      void api.listTracks().then(setList)
      setTimeout(() => setSavingMsg(null), 2500)
    } catch (e: any) {
      setSavingMsg(`error: ${e.message ?? e}`)
    }
  }

  const revert = async () => {
    if (!selectedGuid) return
    const detail = await api.getTrack(selectedGuid) as LoadedTrack | null
    setLoaded(detail)
    setCorners(((detail?.corners ?? []) as EditableCorner[]).map(c => ({ ...c, _key: _cornerKey++ })))
    setDirty(false)
    setSavingMsg(null)
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// track configuration</div>
          <div className="page-title">Tra<span className="accent">cks</span></div>
        </div>
        <div className="page-meta">
          {list.length} configurations<br />
          <span className="muted">
            {activeEntry ? `${activeEntry.trackName} · ${activeEntry.configName}` : '—'}
          </span>
        </div>
      </header>

      <div className="page-body tracks-body">
        {/* Track picker */}
        <div className="tracks-picker">
          {list.length === 0 && (
            <div className="muted small">No track data yet — sync some sessions first.</div>
          )}
          {list.map(t => (
            <button
              key={`${t.meanLineGuid ?? 'noguid'}-${t.configName}`}
              className={`chip ${selectedGuid === t.meanLineGuid ? 'signal' : ''}`}
              disabled={!t.meanLineExists}
              onClick={() => t.meanLineGuid && setSelectedGuid(t.meanLineGuid)}
              title={t.meanLineExists ? '' : 'mean_line.pb missing — re-sync to fetch it'}
              style={{ cursor: t.meanLineExists ? 'pointer' : 'not-allowed' }}
            >
              {t.configName || '(unnamed config)'}
              <span className="muted" style={{ marginLeft: 6, fontSize: 9 }}>
                · {t.sessionCount}s
                {t.yamlExists ? ` · ${t.cornerCount} corners` : ' · no yaml'}
              </span>
            </button>
          ))}
        </div>

        {loading && <div className="muted small" style={{ padding: 16 }}>Loading track geometry…</div>}

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
      </div>
    </>
  )
}
