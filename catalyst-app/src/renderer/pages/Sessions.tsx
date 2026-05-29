import { useEffect, useState } from 'react'
import { api, msToLap } from '../api'
import type { DbSessionRow } from '../../shared/types'

export function Sessions({ refreshTick }: { refreshTick: number }) {
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

  const filtered = filter.trim().length
    ? rows.filter(r =>
        (r.track_name ?? '').toLowerCase().includes(filter.toLowerCase()) ||
        (r.track_configuration_name ?? '').toLowerCase().includes(filter.toLowerCase()) ||
        (r.session_guid ?? '').toLowerCase().includes(filter.toLowerCase()))
    : rows

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
        <div className="row-center" style={{ marginBottom: 16 }}>
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
        </div>

        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
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
                <tr><td colSpan={8} className="muted">loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="muted">no sessions{!hasDb ? ' — sync first' : ''}</td></tr>
              )}
              {filtered.map(r => (
                <tr key={r.session_guid}>
                  <td className="small">{r.session_start ?? '—'}</td>
                  <td>{r.track_name ?? '—'}</td>
                  <td className="muted">{r.track_configuration_name || '—'}</td>
                  <td className="num laptime">{msToLap(r.best_lap_ms)}</td>
                  <td className="num">{r.lap_count || '—'}</td>
                  <td className="num">{r.sample_count ? r.sample_count.toLocaleString() : '—'}</td>
                  <td className="muted small">{r.weather_description || '—'}</td>
                  <td className="small muted">{r.session_guid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
