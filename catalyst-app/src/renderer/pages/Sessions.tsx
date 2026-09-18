import { useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import type { DbSessionRow } from '../../shared/types'

interface Props {
  refreshTick: number
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onAnalyze: () => void
  activeAccount: string | null
  onEnsureSessions: (guids: string[]) => Promise<void>
}

// Derive a one-line vehicle label from the DB row. We prefer `model` so the
// chip stays short — make is the secondary tag.
function vehicleLabel(r: DbSessionRow): string {
  const make = (r.vehicle_make ?? '').trim()
  const model = (r.vehicle_model ?? '').trim()
  if (model && make) return `${make[0]}${make.slice(1).toLowerCase()} ${model[0]}${model.slice(1).toLowerCase()}`
  if (model) return model
  if (make) return `${make[0]}${make.slice(1).toLowerCase()}`
  return ''
}

interface VehicleGroup {
  guid: string
  label: string
  count: number
}

type SortKey = 'date' | 'track' | 'config' | 'vehicle' | 'best' | 'laps' | 'weather'
type SortDir = 'asc' | 'desc'

// Per-column field extractors. Returning a (number|string|null) lets us share
// one comparator across all keys — null sorts to the bottom in both directions.
const SORT_EXTRACTORS: Record<SortKey, (r: DbSessionRow) => string | number | null> = {
  date:    r => r.session_start ?? null,
  track:   r => (r.track_name ?? '').toLowerCase() || null,
  config:  r => (r.track_configuration_name ?? '').toLowerCase() || null,
  vehicle: r => vehicleLabel(r).toLowerCase() || null,
  best:    r => r.best_lap_ms ?? null,
  laps:    r => r.lap_count ?? null,
  weather: r => (r.weather_description ?? '').toLowerCase() || null,
}

function compareWith(key: SortKey, dir: SortDir) {
  const extract = SORT_EXTRACTORS[key]
  const mul = dir === 'asc' ? 1 : -1
  return (a: DbSessionRow, b: DbSessionRow): number => {
    const av = extract(a), bv = extract(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1   // nulls always last, regardless of dir
    if (bv == null) return -1
    if (av < bv) return -1 * mul
    if (av > bv) return  1 * mul
    return 0
  }
}

export function Sessions({ refreshTick, selected, setSelected, onAnalyze, activeAccount, onEnsureSessions }: Props) {
  const [rows, setRows] = useState<DbSessionRow[]>([])
  const [hasDb, setHasDb] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [vehicleFilter, setVehicleFilter] = useState<string | null>(null) // vehicle_guid or null
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const inFlight = useRef(new Set<string>())
  const failed = useRef(new Set<string>())
  const [downloading, setDownloading] = useState(new Set<string>())
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  // First click on a new column picks that column's natural default direction;
  // clicking the active column toggles asc/desc.
  const onHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Date / best-lap / laps are more useful descending; text columns ascending.
      setSortDir(key === 'date' || key === 'best' || key === 'laps' ? 'desc' : 'asc')
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const [list, db] = await Promise.all([api.listSessions(activeAccount), api.hasDb()])
        if (!cancelled) { setRows(list); setHasDb(db) }
      } catch (error) {
        if (!cancelled) setDownloadError(String(error))
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [refreshTick, activeAccount])

  useEffect(() => {
    const missing = rows.filter(row => selected.has(row.session_guid) && !row.details_loaded
      && !inFlight.current.has(row.session_guid) && !failed.current.has(row.session_guid))
      .map(row => row.session_guid)
    if (!missing.length) return
    // Batch rapid checkbox clicks into one request, including Select visible.
    const timer = setTimeout(() => {
      missing.forEach(guid => inFlight.current.add(guid))
      setDownloading(new Set(inFlight.current))
      void onEnsureSessions(missing).then(async () => {
        const list = await api.listSessions(activeAccount)
        setRows(list)
      }).catch(error => {
        missing.forEach(guid => failed.current.add(guid))
        setDownloadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        missing.forEach(guid => inFlight.current.delete(guid))
        setDownloading(new Set(inFlight.current))
      })
    }, 200)
    return () => clearTimeout(timer)
  }, [rows, selected, onEnsureSessions, activeAccount, retryTick])

  // One chip per distinct vehicle_guid in the current rows, with a count.
  const vehicleGroups = useMemo<VehicleGroup[]>(() => {
    const by = new Map<string, VehicleGroup>()
    for (const r of rows) {
      if (!r.vehicle_guid) continue
      const g = by.get(r.vehicle_guid)
      if (g) g.count++
      else by.set(r.vehicle_guid, {
        guid: r.vehicle_guid,
        label: vehicleLabel(r) || r.vehicle_guid.slice(0, 8),
        count: 1,
      })
    }
    return [...by.values()].sort((a, b) => b.count - a.count)
  }, [rows])

  const filtered = useMemo(() => {
    let out = rows
    if (vehicleFilter) out = out.filter(r => r.vehicle_guid === vehicleFilter)
    const q = filter.trim().toLowerCase()
    if (q) {
      out = out.filter(r =>
        (r.track_name ?? '').toLowerCase().includes(q) ||
        (r.track_configuration_name ?? '').toLowerCase().includes(q) ||
        (r.session_guid ?? '').toLowerCase().includes(q) ||
        vehicleLabel(r).toLowerCase().includes(q))
    }
    // Sort after filtering so the visible order matches the selected column.
    // Slice() because Array.sort is in-place and `out` may alias `rows`.
    return out.slice().sort(compareWith(sortKey, sortDir))
  }, [rows, filter, vehicleFilter, sortKey, sortDir])

  const allVisibleSelected = filtered.length > 0 && filtered.every(r => selected.has(r.session_guid))

  const toggle = (guid: string) => {
    const next = new Set(selected)
    if (next.has(guid)) next.delete(guid); else next.add(guid)
    setSelected(next)
  }

  const toggleAllVisible = () => {
    const next = new Set(selected)
    if (allVisibleSelected) {
      for (const r of filtered) next.delete(r.session_guid)
    } else {
      for (const r of filtered) next.add(r.session_guid)
    }
    setSelected(next)
  }

  const selectedRows = useMemo(
    () => rows.filter(r => selected.has(r.session_guid)),
    [rows, selected],
  )
  const selectedNeedsDetails = selectedRows.some(row => !row.details_loaded || downloading.has(row.session_guid))

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// archive</div>
          <div className="page-title">Ses<span className="accent">sions</span></div>
        </div>
        <div className="page-meta">
          {filtered.length} of {rows.length}<br />
          <span className="muted">{hasDb ? 'duckdb attached' : 'no db — summary only'}</span>
        </div>
      </header>

      <div className="page-body">
        <p className="muted small">Select sessions to compare laps and get coaching. Older telemetry downloads automatically.</p>
        {downloading.size > 0 && <p className="small" role="status">Downloading details for {downloading.size} session(s)…</p>}
        {downloadError && (
          <div className="session-download-error" role="alert">
            <span>{downloadError}</span>
            <button className="btn ghost" onClick={() => {
              failed.current.clear(); setDownloadError(null); setRetryTick(t => t + 1)
            }}>Retry selected</button>
          </div>
        )}
        {vehicleGroups.length > 1 && (
          <div className="row-center session-vehicle-filters" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="muted text-mono" style={{
              fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', marginRight: 4,
            }}>Vehicle:</span>
            <button
              aria-pressed={vehicleFilter === null}
              className={`chip ${vehicleFilter === null ? 'signal' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setVehicleFilter(null)}
            >
              All · {rows.length}
            </button>
            {vehicleGroups.map(g => (
              <button
                aria-pressed={vehicleFilter === g.guid}
                key={g.guid}
                className={`chip ${vehicleFilter === g.guid ? 'signal' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setVehicleFilter(g.guid === vehicleFilter ? null : g.guid)}
              >
                {g.label} · {g.count}
              </button>
            ))}
          </div>
        )}

        <div className="row-center session-search" style={{ marginBottom: 16, gap: 10 }}>
          <input
            aria-label="Filter sessions"
            placeholder="Search track, vehicle, or session…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '10px 14px',
              color: 'var(--text)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          />
          <button className="btn ghost" style={{ padding: '10px 14px' }} onClick={toggleAllVisible}>
            {allVisibleSelected ? 'Clear visible' : 'Select visible'}
          </button>
        </div>

        <div className="session-mobile-sort">
          <label htmlFor="session-sort">Sort sessions</label>
          <select id="session-sort" value={sortKey} onChange={e => onHeaderClick(e.target.value as SortKey)}>
            <option value="date">Date</option><option value="track">Track</option><option value="config">Configuration</option><option value="vehicle">Vehicle</option><option value="best">Best lap</option><option value="laps">Lap count</option><option value="weather">Weather</option>
          </select>
          <button className="btn ghost" aria-label={`Sort ${sortDir === 'desc' ? 'ascending' : 'descending'}`} onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}>{sortDir === 'desc' ? '↓ Desc' : '↑ Asc'}</button>
        </div>
        <div className="session-cards">
          {loading && <p className="muted" role="status">Loading sessions…</p>}
          {!loading && !filtered.length && <p className="muted">{rows.length ? 'No sessions match your filters.' : 'No sessions yet. Sync from Overview to get started.'}</p>}
          {filtered.map(r => <label key={r.session_guid} className={`session-card ${selected.has(r.session_guid) ? 'is-selected' : ''}`}>
            <div className="session-card-top">
              <span className="session-card-date">{r.session_start ?? 'Date unavailable'}</span>
              <input type="checkbox" checked={selected.has(r.session_guid)} onChange={() => toggle(r.session_guid)} aria-label={`Select ${r.track_name ?? 'session'} ${r.session_start ?? ''}`} />
            </div>
            <strong className="session-card-track">{r.track_name ?? 'Unknown track'}</strong>
            <span className="session-card-config">{r.track_configuration_name || 'Default configuration'}</span>
            <div className="session-card-stats">
              <div><small>Best lap</small><strong>{msToLap(r.best_lap_ms)}</strong></div>
              <div><small>Laps</small><strong>{r.lap_count || '—'}</strong></div>
              <div><small>Vehicle</small><span>{vehicleLabel(r) || '—'}</span></div>
            </div>
            <div className="session-card-footer"><span>{r.weather_description || 'Weather unavailable'}</span><span>{downloading.has(r.session_guid) ? 'Downloading…' : r.details_loaded ? 'Telemetry ready' : 'Tap to download'}</span></div>
          </label>)}
        </div>
        <div className="tbl-wrap sessions-table">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <SortHeader k="date"    sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick}>Date</SortHeader>
                <SortHeader k="track"   sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick}>Track</SortHeader>
                <SortHeader k="config"  sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick}>Config</SortHeader>
                <SortHeader k="vehicle" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick}>Vehicle</SortHeader>
                <SortHeader k="best"    sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} align="right">Best lap</SortHeader>
                <SortHeader k="laps"    sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} align="right">Laps</SortHeader>
                <SortHeader k="weather" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick}>Weather</SortHeader>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="muted">loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="muted">no sessions{!hasDb ? ' — sync first' : ''}</td></tr>
              )}
              {filtered.map(r => {
                const on = selected.has(r.session_guid)
                const veh = vehicleLabel(r)
                return (
                  <tr
                    key={r.session_guid}
                    onClick={() => toggle(r.session_guid)}
                    className={on ? 'row-selected' : ''}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.track_name ?? 'session'} ${r.session_start ?? ''}`}
                        checked={on}
                        onChange={() => toggle(r.session_guid)}
                        onClick={e => e.stopPropagation()}
                        style={{ accentColor: 'var(--signal)' }}
                      />
                    </td>
                    <td className="small">{r.session_start ?? '—'}</td>
                    <td>{r.track_name ?? '—'}
                      {!r.details_loaded && <span className="session-detail-status">
                        {downloading.has(r.session_guid) ? 'Downloading…' : 'Overview only'}
                      </span>}
                    </td>
                    <td className="muted">{r.track_configuration_name || '—'}</td>
                    <td className="small">{veh || <span className="muted">—</span>}</td>
                    <td className="num laptime">{msToLap(r.best_lap_ms)}</td>
                    <td className="num">{r.lap_count || '—'}</td>
                    <td className="muted small">{r.weather_description || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sibling of .page-body (not a child) so it sits at the true viewport
          bottom — sticky inside the scrolling body left a 36px gap under it
          because of the body's bottom padding. */}
      {selected.size > 0 && (
        <div className="selection-bar">
          <div className="pulse" />
          <div>
            <div className="count">{selected.size}</div>
            <div className="count-sub">selected</div>
          </div>
          <div className="selected-laptimes">
            {selectedRows.slice(0, 10).map(r => (
              <span key={r.session_guid} className="chip cyan">
                {(r.session_start ?? '').slice(0, 10)} · {msToLap(r.best_lap_ms)}
                <span className="x" onClick={e => { e.stopPropagation(); toggle(r.session_guid) }}>×</span>
              </span>
            ))}
            {selectedRows.length > 10 && (
              <span className="chip">+{selectedRows.length - 10}</span>
            )}
          </div>
          <button className="btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn primary" onClick={onAnalyze} disabled={selectedNeedsDetails || loading}>
            {selectedNeedsDetails ? 'Waiting for details…' : `Analyze ${selected.size} →`}
          </button>
        </div>
      )}
    </>
  )
}

// Clickable column header with a tiny ▲/▼ glyph showing the active direction.
// `align` lets numeric columns keep their right-aligned values while the label
// + arrow stay together on the right side of the header.
function SortHeader({
  k, sortKey, sortDir, onClick, align = 'left', children,
}: {
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onClick: (k: SortKey) => void
  align?: 'left' | 'right'
  children: React.ReactNode
}) {
  const active = sortKey === k
  const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : ''
  return (
    <th
      onClick={() => onClick(k)}
      className={`sortable ${active ? 'sorted' : ''}`}
      style={{ textAlign: align, cursor: 'pointer', userSelect: 'none' }}
    >
      <span>{children}</span>
      <span className="sort-arrow">{arrow || '·'}</span>
    </th>
  )
}
