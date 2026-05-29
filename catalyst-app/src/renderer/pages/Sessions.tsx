import { useEffect, useMemo, useState } from 'react'
import { api, msToLap } from '../api'
import type { DbSessionRow } from '../../shared/types'

interface Props {
  refreshTick: number
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onAnalyze: () => void
}

export function Sessions({ refreshTick, selected, setSelected, onAnalyze }: Props) {
  const [rows, setRows] = useState<DbSessionRow[]>([])
  const [hasDb, setHasDb] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const [list, db] = await Promise.all([api.listSessions(), api.hasDb()])
      setRows(list)
      setHasDb(db)
      setLoading(false)
    })()
  }, [refreshTick])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      (r.track_name ?? '').toLowerCase().includes(q) ||
      (r.track_configuration_name ?? '').toLowerCase().includes(q) ||
      (r.session_guid ?? '').toLowerCase().includes(q))
  }, [rows, filter])

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

  // Build a tiny chip list from the selected rows, ordered by session_start desc.
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
        <div className="row-center" style={{ marginBottom: 16, gap: 10 }}>
          <input
            placeholder="filter by track, config, or guid…"
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
                <th style={{ textAlign: 'right' }}>Best lap</th>
                <th style={{ textAlign: 'right' }}>Laps</th>
                <th style={{ textAlign: 'right' }}>Samples</th>
                <th>Weather</th>
                <th>Session GUID</th>
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
                    <td className="num laptime">{msToLap(r.best_lap_ms)}</td>
                    <td className="num">{r.lap_count || '—'}</td>
                    <td className="num">{r.sample_count ? r.sample_count.toLocaleString() : '—'}</td>
                    <td className="muted small">{r.weather_description || '—'}</td>
                    <td className="small muted">{r.session_guid}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

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
      </div>
    </>
  )
}
