import { useEffect, useMemo, useState } from 'react'
import { api, msToLap } from '../api'
import type { CarProfile, BriefOptions, DbSessionRow } from '../../shared/types'

export function BriefDialog({ onClose, onGenerated }: { onClose: () => void; onGenerated?: () => void }) {
  const [profiles, setProfiles] = useState<CarProfile[]>([])
  const [profile, setProfile] = useState<string>('')
  const [scope, setScope] = useState<BriefOptions['scope']>('overview')
  const [mode, setMode] = useState<BriefOptions['mode']>('last')
  const [lastN, setLastN] = useState(5)
  const [csv, setCsv] = useState(false)
  const [includeGuides, setIncludeGuides] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Session picker state (only used in mode === 'selected', but we load
  // up front so switching modes is instant).
  const [sessions, setSessions] = useState<DbSessionRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void (async () => {
      const [list, active, sess] = await Promise.all([
        api.listProfiles(),
        api.getActiveProfile(),
        api.listSessions(),
      ])
      setProfiles(list)
      setProfile(active ?? list[0]?.name ?? '')
      setSessions(sess)
    })()
  }, [])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(r =>
      (r.track_name ?? '').toLowerCase().includes(q) ||
      (r.track_configuration_name ?? '').toLowerCase().includes(q) ||
      (r.session_start ?? '').toLowerCase().includes(q) ||
      r.session_guid.toLowerCase().includes(q))
  }, [sessions, filter])

  const toggle = (guid: string) => {
    const next = new Set(selected)
    if (next.has(guid)) next.delete(guid); else next.add(guid)
    setSelected(next)
  }

  const toggleAllVisible = () => {
    const allChosen = filtered.every(s => selected.has(s.session_guid))
    const next = new Set(selected)
    for (const s of filtered) {
      if (allChosen) next.delete(s.session_guid)
      else next.add(s.session_guid)
    }
    setSelected(next)
  }

  const onGenerate = async () => {
    if (mode === 'selected' && selected.size === 0) {
      setErr('Pick at least one session, or switch session-set mode.')
      return
    }
    setBusy(true); setErr(null)
    try {
      await api.generateBrief({
        profile, scope, mode, lastN,
        sessionGuids: mode === 'selected' ? [...selected] : undefined,
        csv, includeGuides,
      })
      onGenerated?.()
      onClose()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const isSelectedMode = mode === 'selected'
  const allVisibleSelected = filtered.length > 0 && filtered.every(s => selected.has(s.session_guid))

  return (
    <div className="dialog-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="dialog"
        style={{ width: isSelectedMode ? 'min(900px, 95vw)' : undefined }}
      >
        <button className="dialog-close" onClick={onClose}>×</button>
        <div className="dialog-header">
          <div className="dialog-title">New brief</div>
          <span className="tag signal">{scope.toUpperCase()}</span>
          {isSelectedMode && (
            <span className="tag cyan" style={{ marginLeft: 'auto' }}>
              {selected.size} SELECTED
            </span>
          )}
        </div>

        <div className="dialog-body">
          <div className="field">
            <div className="field-label">Profile (car)</div>
            <select value={profile} onChange={e => setProfile(e.target.value)}>
              {profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>

          <div className="field">
            <div className="field-label">Scope</div>
            <div className="radio-group">
              {(['overview', 'compare', 'corner'] as const).map(s => (
                <div key={s} className={`radio ${scope === s ? 'selected' : ''}`} onClick={() => setScope(s)}>{s}</div>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="field-label">Session set</div>
            <div className="radio-group">
              {(['last', 'all', 'selected'] as const).map(m => (
                <div key={m} className={`radio ${mode === m ? 'selected' : ''}`} onClick={() => setMode(m)}>{m}</div>
              ))}
            </div>
          </div>

          {mode === 'last' && (
            <div className="field">
              <div className="field-label">Last N</div>
              <select value={lastN} onChange={e => setLastN(parseInt(e.target.value, 10))}>
                {[3, 5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          {isSelectedMode && (
            <div className="field">
              <div className="row-center" style={{ marginBottom: 8, gap: 8 }}>
                <input
                  placeholder="filter by date, track, or guid…"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    padding: '8px 12px',
                    color: 'var(--text)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                  }}
                />
                <button className="btn ghost" style={{ padding: '8px 12px' }} onClick={toggleAllVisible}>
                  {allVisibleSelected ? 'Clear visible' : 'Select visible'}
                </button>
                {selected.size > 0 && (
                  <button className="btn ghost" style={{ padding: '8px 12px' }} onClick={() => setSelected(new Set())}>
                    Reset
                  </button>
                )}
              </div>

              <div
                className="tbl-wrap"
                style={{ maxHeight: 320, overflow: 'auto' }}
              >
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}></th>
                      <th>Date</th>
                      <th>Config</th>
                      <th style={{ textAlign: 'right' }}>Best</th>
                      <th style={{ textAlign: 'right' }}>Laps</th>
                      <th>Weather</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={6} className="muted">no sessions match</td></tr>
                    )}
                    {filtered.map(s => {
                      const isOn = selected.has(s.session_guid)
                      return (
                        <tr
                          key={s.session_guid}
                          onClick={() => toggle(s.session_guid)}
                          style={{
                            cursor: 'pointer',
                            background: isOn ? 'rgba(255,94,58,0.06)' : undefined,
                          }}
                        >
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={isOn}
                              onChange={() => toggle(s.session_guid)}
                              onClick={e => e.stopPropagation()}
                              style={{ accentColor: 'var(--signal)' }}
                            />
                          </td>
                          <td className="small">{s.session_start ?? '—'}</td>
                          <td className="muted">{s.track_configuration_name || '—'}</td>
                          <td className="num laptime">{msToLap(s.best_lap_ms)}</td>
                          <td className="num">{s.lap_count || '—'}</td>
                          <td className="muted small">{s.weather_description || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="row-center" style={{ gap: 18, marginTop: 8 }}>
            <label className="cb"><input type="checkbox" checked={csv} onChange={e => setCsv(e.target.checked)} /> CSV pack</label>
            <label className="cb"><input type="checkbox" checked={includeGuides} onChange={e => setIncludeGuides(e.target.checked)} /> Inline guides</label>
          </div>

          {err && <div style={{ marginTop: 14, color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{err}</div>}
        </div>

        <div className="dialog-footer">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn primary"
            onClick={onGenerate}
            disabled={busy || !profile || (isSelectedMode && selected.size === 0)}
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
