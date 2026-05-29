import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CarProfile } from '../../shared/types'

export function Garage() {
  const [profiles, setProfiles] = useState<CarProfile[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [files, setFiles] = useState<{ name: string; path: string }[]>([])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const dirty = content !== original

  useEffect(() => {
    void (async () => {
      const [list, act] = await Promise.all([api.listProfiles(), api.getActiveProfile()])
      setProfiles(list)
      setActive(act ?? list[0]?.name ?? null)
    })()
  }, [])

  useEffect(() => {
    if (!active) return
    void (async () => {
      const fs = await api.listProfileFiles(active)
      setFiles(fs)
      if (fs.length) setCurrentPath(fs[0].path)
    })()
  }, [active])

  useEffect(() => {
    if (!currentPath) { setContent(''); setOriginal(''); return }
    void api.readProfileFile(currentPath).then(text => { setContent(text); setOriginal(text) })
  }, [currentPath])

  const onChooseProfile = async (name: string) => {
    if (dirty && !confirm('Discard unsaved edits?')) return
    setActive(name)
    await api.setActiveProfile(name)
  }

  const onSave = async () => {
    if (!active || !currentPath) return
    const filename = currentPath.split('/').pop()!
    await api.writeCarMd(active, filename, content)
    setOriginal(content)
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// fleet</div>
          <div className="page-title">Gar<span className="accent">age</span></div>
        </div>
        <div className="page-meta">
          {profiles.length} profiles<br />
          <span className="muted">active: {active ?? '—'}</span>
        </div>
      </header>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="row-center" style={{ marginBottom: 18, gap: 8, flexWrap: 'wrap' }}>
          <span className="muted text-mono" style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase' }}>Profile:</span>
          {profiles.map(p => (
            <div
              key={p.name}
              className={`radio ${active === p.name ? 'selected' : ''}`}
              style={{ flex: '0 0 auto', padding: '8px 18px' }}
              onClick={() => onChooseProfile(p.name)}
            >{p.name}</div>
          ))}
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn primary" disabled={!dirty} onClick={onSave}>{dirty ? 'Save' : 'Saved'}</button>
        </div>

        <div className="split" style={{ flex: 1, minHeight: 400 }}>
          <div className="list-pane">
            {files.length === 0 && <div className="muted text-mono" style={{ padding: 12, fontSize: 11 }}>no .md files</div>}
            {files.map(f => (
              <div
                key={f.path}
                className={`list-item ${currentPath === f.path ? 'active' : ''}`}
                onClick={() => {
                  if (dirty && !confirm('Discard unsaved edits?')) return
                  setCurrentPath(f.path)
                }}
              >
                <div className="filename">{f.name}</div>
              </div>
            ))}
          </div>

          <div className="viewer-pane">
            <div className="viewer-toolbar">
              <span>{currentPath?.split('/').pop() ?? 'no file'}</span>
              <span className="spacer" />
              <span>{content.length.toLocaleString()} chars · {dirty ? <span style={{ color: 'var(--signal)' }}>unsaved</span> : 'saved'}</span>
            </div>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1,
                background: 'transparent',
                border: 0,
                outline: 'none',
                padding: '20px 26px',
                color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                lineHeight: 1.65,
                resize: 'none',
              }}
            />
          </div>
        </div>
      </div>
    </>
  )
}
