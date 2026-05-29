import { useEffect, useMemo, useState } from 'react'
import { api, msToLap } from '../api'
import type { DbSessionRow } from '../../shared/types'

interface Props {
  refreshTick: number
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onAnalyze: () => void
  activeAccount: string | null
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

export function Sessions({ refreshTick, selected, setSelected, onAnalyze, activeAccount }: Props) {
  const [rows, setRows] = useState<DbSessionRow[]>([])
  const [hasDb, setHasDb] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [vehicleFilter, setVehicleFilter] = useState<string | null>(null) // vehicle_guid or null

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const [list, db] = await Promise.all([api.listSessions(activeAccount), api.hasDb()])
      setRows(list)
      setHasDb(db)
      setLoading(false)
    })()
  }, [refreshTick, activeAccount])

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
    return out
  }, [rows, filter, vehicleFilter])

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
        {vehicleGroups.length > 1 && (
          <div className="row-center" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="muted text-mono" style={{
              fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', marginRight: 4,
            }}>Vehicle:</span>
            <span
              className={`chip ${vehicleFilter === null ? 'signal' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setVehicleFilter(null)}
            >
              All · {rows.length}
            </span>
            {vehicleGroups.map(g => (
              <span
                key={g.guid}
                className={`chip ${vehicleFilter === g.guid ? 'signal' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setVehicleFilter(g.guid === vehicleFilter ? null : g.guid)}
              >
                {g.label} · {g.count}
              </span>
            ))}
          </div>
        )}

        <div className="row-center" style={{ marginBottom: 16, gap: 10 }}>
          <input
            placeholder="filter by track, config, vehicle, or guid…"
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

        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>Date</th>
                <th>Track</th>
                <th>Config</th>
                <th>Vehicle</th>
                <th style={{ textAlign: 'right' }}>Best lap</th>
                <th style={{ textAlign: 'right' }}>Laps</th>
                <th style={{ textAlign: 'right' }}>Samples</th>
                <th>Weather</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="muted">loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={9} className="muted">no sessions{!hasDb ? ' — sync first' : ''}</td></tr>
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
                        checked={on}
                        onChange={() => toggle(r.session_guid)}
                        onClick={e => e.stopPropagation()}
                        style={{ accentColor: 'var(--signal)' }}
                      />
                    </td>
                    <td className="small">{r.session_start ?? '—'}</td>
                    <td>{r.track_name ?? '—'}</td>
                    <td className="muted">{r.track_configuration_name || '—'}</td>
                    <td className="small">{veh || <span className="muted">—</span>}</td>
                    <td className="num laptime">{msToLap(r.best_lap_ms)}</td>
                    <td className="num">{r.lap_count || '—'}</td>
                    <td className="num">{r.sample_count ? r.sample_count.toLocaleString() : '—'}</td>
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
          <button className="btn primary" onClick={onAnalyze}>
            Analyze {selected.size} →
          </button>
        </div>
      )}
    </>
  )
}
