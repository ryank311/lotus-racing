import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CarProfile, BriefOptions } from '../../shared/types'

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

  useEffect(() => {
    void (async () => {
      const [list, active] = await Promise.all([api.listProfiles(), api.getActiveProfile()])
      setProfiles(list)
      setProfile(active ?? list[0]?.name ?? '')
    })()
  }, [])

  const onGenerate = async () => {
    setBusy(true); setErr(null)
    try {
      await api.generateBrief({
        profile, scope, mode, lastN,
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

  return (
    <div className="dialog-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog">
        <button className="dialog-close" onClick={onClose}>×</button>
        <div className="dialog-header">
          <div className="dialog-title">New brief</div>
          <span className="tag signal">{scope.toUpperCase()}</span>
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

          {mode === 'selected' && (
            <div className="field-help">Selected-mode picker not yet implemented in dialog — use CLI for now, or pick "last N".</div>
          )}

          <div className="row-center" style={{ gap: 18, marginTop: 8 }}>
            <label className="cb"><input type="checkbox" checked={csv} onChange={e => setCsv(e.target.checked)} /> CSV pack</label>
            <label className="cb"><input type="checkbox" checked={includeGuides} onChange={e => setIncludeGuides(e.target.checked)} /> Inline guides</label>
          </div>

          {err && <div style={{ marginTop: 14, color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{err}</div>}
        </div>
        <div className="dialog-footer">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={onGenerate} disabled={busy || !profile}>{busy ? 'Generating…' : 'Generate'}</button>
        </div>
      </div>
    </div>
  )
}
