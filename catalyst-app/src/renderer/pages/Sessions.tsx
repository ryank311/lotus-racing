import { useResource } from '../useResource'
import { InlineLoadStatus, LoadingRows, Skeleton } from '../components/Loading'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useDebouncedQuery, useNavigation, useRoute } from '../navigation'
import { routeUrl, segment } from '../routes'
import { useUnits } from '../units'
import { startLabel } from '../components/reviewTimeline'
import type { DbSessionRow } from '../../shared/types'
import './pages-extras.css'

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

function trackLabel(r: DbSessionRow): string {
  return [r.track_name, r.track_configuration_name].map(s => (s ?? '').trim()).filter(Boolean).join(' · ')
}

// One chip per track layout (mean line); lap times only compare within one.
interface TrackGroup {
  key: string
  label: string
  count: number
}

// The session holding this car's best lap on its layout (same account).
function isLayoutPb(r: DbSessionRow): boolean {
  return r.best_lap_ms != null && r.best_lap_ms > 0 && r.best_lap_ms === r.layout_best_ms
}

function layoutPbGap(r: DbSessionRow): string | null {
  if (r.best_lap_ms == null || r.best_lap_ms <= 0 || r.layout_best_ms == null || isLayoutPb(r)) return null
  return `+${((r.best_lap_ms - r.layout_best_ms) / 1000).toFixed(2)} s`
}

function LapTime({ row }: { row: DbSessionRow }) {
  const gap = layoutPbGap(row)
  return <>
    {msToLap(row.best_lap_ms)}
    {isLayoutPb(row) && <span className="session-pb" role="img" title="Layout PB for this car" aria-label="Layout PB for this car">★</span>}
    {gap && <span className="session-pb-gap" title="Gap to this car's best lap on this layout">{gap}</span>}
  </>
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

// The phone layout sorts from one dropdown; directions are part of the choice.
const SORT_CHOICES: Array<{ key: SortKey; dir: SortDir; label: string }> = [
  { key: 'date', dir: 'desc', label: 'Newest first' },
  { key: 'date', dir: 'asc', label: 'Oldest first' },
  { key: 'best', dir: 'asc', label: 'Fastest lap first' },
  { key: 'laps', dir: 'desc', label: 'Most laps first' },
  { key: 'track', dir: 'asc', label: 'Track A–Z' },
  { key: 'vehicle', dir: 'asc', label: 'Car A–Z' },
]

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
  const { params } = useRoute()
  const { query } = useNavigation()
  const sessionsResource = useResource(() => api.listSessions(activeAccount), activeAccount ?? '', refreshTick)
  const dbResource = useResource(() => api.hasDb(), '', refreshTick)
  const rows = sessionsResource.data ?? []
  const setRows = sessionsResource.setData
  const hasDb = dbResource.data
  const loading = sessionsResource.initialLoading
  const [filter, setFilter] = useDebouncedQuery('q', params.get('q') ?? '')
  const vehicleFilter = params.get('vehicle')
  const setVehicleFilter = (value: string | null) => query({ vehicle: value })
  const trackFilter = params.get('track')
  const setTrackFilter = (value: string | null) => query({ track: value })
  const { tempFromC, tempUnit } = useUnits()
  const temperature = (r: DbSessionRow) => r.temperature_c == null ? null : `${Math.round(tempFromC(r.temperature_c))}${tempUnit}`
  const sortKey = (params.get('sort') ?? 'date') as SortKey
  const sortDir: SortDir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const setSortDir = (fn: (old: SortDir) => SortDir) => query({ dir: fn(sortDir) })
  const inFlight = useRef(new Set<string>())
  const failed = useRef(new Set<string>())
  const [downloading, setDownloading] = useState(new Set<string>())
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // First click on a new column picks that column's natural default direction
  // (newest, most laps, fastest lap first); clicking the active column toggles.
  const onHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      query({ sort: key, dir: key === 'date' || key === 'laps' ? 'desc' : 'asc' })
    }
  }


  const downloadSelected = () => {
    const missing = rows.filter(row => selected.has(row.session_guid) && !row.details_loaded
      && !inFlight.current.has(row.session_guid) && !failed.current.has(row.session_guid))
      .map(row => row.session_guid)
    if (!missing.length) return
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
  }

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

  const trackGroups = useMemo<TrackGroup[]>(() => {
    const by = new Map<string, TrackGroup>()
    for (const r of rows) {
      if (!r.layout_key) continue
      const g = by.get(r.layout_key)
      if (g) g.count++
      else by.set(r.layout_key, { key: r.layout_key, label: trackLabel(r) || 'Unknown track', count: 1 })
    }
    const groups = [...by.values()]
    // Two mean lines can share a name; a short key suffix keeps them apart.
    const named = new Map<string, number>()
    for (const g of groups) named.set(g.label, (named.get(g.label) ?? 0) + 1)
    for (const g of groups) if (named.get(g.label)! > 1) g.label += ` (${g.key.slice(0, 6)})`
    return groups.sort((a, b) => b.count - a.count)
  }, [rows])

  const filtered = useMemo(() => {
    let out = rows
    if (vehicleFilter) out = out.filter(r => r.vehicle_guid === vehicleFilter)
    if (trackFilter) out = out.filter(r => r.layout_key === trackFilter)
    const q = filter.trim().toLowerCase()
    if (q) {
      out = out.filter(r =>
        (r.track_name ?? '').toLowerCase().includes(q) ||
        (r.track_configuration_name ?? '').toLowerCase().includes(q) ||
        (r.session_guid ?? '').toLowerCase().includes(q) ||
        (r.session_start ?? '').includes(q) ||
        startLabel(r.session_start).toLowerCase().includes(q) ||
        vehicleLabel(r).toLowerCase().includes(q))
    }
    // Sort after filtering so the visible order matches the selected column.
    // Slice() because Array.sort is in-place and `out` may alias `rows`.
    return out.slice().sort(compareWith(sortKey, sortDir))
  }, [rows, filter, vehicleFilter, trackFilter, sortKey, sortDir])

  const allVisibleSelected = filtered.length > 0 && filtered.every(r => selected.has(r.session_guid))
  const filtersActive = !!(vehicleFilter || trackFilter || filter.trim())
  const sortValue = `${sortKey}:${sortDir}`
  const thisYear = String(new Date().getFullYear())

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
  // Laps only compare within one layout and one car; the coach rejects the rest.
  const mixedSelection = useMemo(() => {
    const layouts = new Set(selectedRows.map(r => r.layout_key).filter(Boolean))
    const vehicles = new Set(selectedRows.map(r => r.vehicle_guid).filter(Boolean))
    return layouts.size > 1 || vehicles.size > 1
  }, [selectedRows])

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// archive</div>
          <div className="page-title">Ses<span className="accent">sions</span></div>
        </div>
        <div className="page-meta">
          <InlineLoadStatus label="sessions" pending={sessionsResource.pending} error={sessionsResource.error} hasData={sessionsResource.data !== undefined} onRetry={sessionsResource.reload} />
          {hasDb === false && <span className="muted">No database · summaries only</span>}
          {dbResource.error && <InlineLoadStatus label="database status" pending={dbResource.pending} error={dbResource.error} onRetry={dbResource.reload} />}
        </div>
      </header>

      <div className="page-body sessions-body" data-route-loading={loading || undefined}>
        <div className="session-toolbar">
          <div className="session-search">
            <input type="search" aria-label="Filter sessions" placeholder="Search track, car or date…"
              value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
          <div className="session-filters">
            <select aria-label="Track" disabled={loading} value={trackFilter ?? ''} onChange={e => setTrackFilter(e.target.value || null)}>
              <option value="">All tracks</option>
              {trackGroups.map(g => <option key={g.key} value={g.key}>{g.label} · {g.count}</option>)}
            </select>
            {(vehicleGroups.length > 1 || vehicleFilter) && <select aria-label="Car" value={vehicleFilter ?? ''} onChange={e => setVehicleFilter(e.target.value || null)}>
              <option value="">All cars</option>
              {vehicleGroups.map(g => <option key={g.guid} value={g.guid}>{g.label} · {g.count}</option>)}
            </select>}
            <select className="session-sort" aria-label="Sort sessions" value={sortValue} onChange={e => { const [sort, dir] = e.target.value.split(':'); query({ sort, dir }) }}>
              {!SORT_CHOICES.some(c => `${c.key}:${c.dir}` === sortValue) && <option value={sortValue}>Sorted by {sortKey} {sortDir === 'asc' ? '↑' : '↓'}</option>}
              {SORT_CHOICES.map(c => <option key={`${c.key}:${c.dir}`} value={`${c.key}:${c.dir}`}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div className="session-results">
          <span>{sessionsResource.data === undefined ? 'Loading sessions…' : filtered.length === rows.length ? `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}` : `${filtered.length} of ${rows.length} sessions`}</span>
          {filtersActive && <button type="button" className="session-link" onClick={() => { setFilter(''); query({ track: null, vehicle: null }) }}>Clear filters</button>}
          {filtered.length > 0 && <button type="button" className="session-link session-select-all" onClick={toggleAllVisible}>
            {allVisibleSelected ? 'Clear selection' : `Select all ${filtered.length}`}
          </button>}
        </div>
        {selected.size > 0 && rows.some(r => selected.has(r.session_guid) && !r.details_loaded) && <button className="btn primary session-download" disabled={downloading.size > 0} onClick={downloadSelected}>Download selected telemetry</button>}
        {sessionsResource.data !== undefined && [...selected].some(id => !rows.some(r => r.session_guid === id)) && <p role="alert">Some selected sessions are unavailable. Clear the selection to choose available sessions.</p>}
        {downloading.size > 0 && <p className="small" role="status">Downloading details for {downloading.size} session(s)…</p>}
        {downloadError && (
          <div className="session-download-error" role="alert">
            <span>{downloadError}</span>
            <button className="btn ghost" onClick={() => {
              failed.current.clear(); setDownloadError(null); downloadSelected()
            }}>Retry selected</button>
          </div>
        )}

        <div className="session-cards" aria-busy={sessionsResource.pending}>
          {loading && <LoadingRows />}
          {sessionsResource.data !== undefined && !filtered.length && <p className="muted">{rows.length ? 'No sessions match your filters.' : 'No sessions yet. Sync from Overview to get started.'}</p>}
          {filtered.map(r => <label key={r.session_guid} className={`session-card ${selected.has(r.session_guid) ? 'is-selected' : ''}`}>
            <input type="checkbox" className="session-card-check" checked={selected.has(r.session_guid)} onChange={() => toggle(r.session_guid)} aria-label={`Select ${r.track_name ?? 'session'} ${r.session_start ?? ''}`} />
            <span className="session-card-main">
              <strong className="session-card-track">{r.track_name ?? 'Unknown track'}</strong>
              <span className="session-card-sub">{[r.track_configuration_name || 'Default configuration', vehicleLabel(r)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="session-card-time">
              <strong><LapTime row={r} /></strong>
              <small>{r.lap_count ? `${r.lap_count} ${r.lap_count === 1 ? 'lap' : 'laps'}` : 'No laps'}</small>
            </span>
            <span className="session-card-foot">
              <span className="session-card-when">
                {[startLabel(r.session_start, !r.session_start?.startsWith(thisYear)), r.weather_description, temperature(r)].filter(Boolean).join(' · ')}
                {(!r.details_loaded || downloading.has(r.session_guid)) && <em>{downloading.has(r.session_guid) ? 'Downloading…' : 'Overview only'}</em>}
              </span>
              <NavLink className="session-card-review" to={`/review/${segment(r.session_guid)}`} onClick={e => e.stopPropagation()}>Review →</NavLink>
            </span>
          </label>)}
        </div>
        <div className="tbl-wrap sessions-table" aria-busy={sessionsResource.pending}>
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
                <th style={{ textAlign: 'right' }}>Temp</th>
                <SortHeader k="weather" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick}>Weather</SortHeader>
                <th><span className="loading-sr-only">Review</span></th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }, (_, row) => <tr key={row} className="loading-table-row" aria-hidden="true">{Array.from({ length: 10 }, (_, cell) => <td key={cell}><Skeleton /></td>)}</tr>)}
              {sessionsResource.data !== undefined && filtered.length === 0 && (
                <tr><td colSpan={10} className="muted">{rows.length ? 'No sessions match your filters.' : 'No sessions yet. Sync from Overview to get started.'}</td></tr>
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
                    <td className="num laptime"><LapTime row={r} /></td>
                    <td className="num">{r.lap_count || '—'}</td>
                    <td className="num">{temperature(r) ?? '—'}</td>
                    <td className="muted small">{r.weather_description || '—'}</td>
                    <td className="session-review-cell"><NavLink className="session-review-link" to={`/review/${segment(r.session_guid)}`} onClick={e => e.stopPropagation()}>Review →</NavLink></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Outside the scroll area; reserves space below the session list. */}
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
          {mixedSelection && <p className="selection-warning" role="status">Pick sessions from one track layout and one car to compare laps</p>}
          <button className="btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
          {selectedNeedsDetails || mixedSelection || sessionsResource.data === undefined || [...selected].some(id => !rows.some(r => r.session_guid === id))
            ? <button className="btn primary" disabled>{selectedNeedsDetails ? 'Download details first' : mixedSelection ? 'Mixed selection' : 'Sessions unavailable'}</button>
            : <NavLink className="btn primary" to={routeUrl('/analysis', { session: [...selected] })}>Analyze {selected.size} →</NavLink>}
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
