import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BriefFile } from '../../shared/types'
import { BriefDialog } from '../components/BriefDialog'
import { renderMarkdown } from '../components/MarkdownLite'

export function Briefs({ refreshTick, onRefresh }: { refreshTick: number; onRefresh: () => void }) {
  const [files, setFiles] = useState<BriefFile[]>([])
  const [current, setCurrent] = useState<BriefFile | null>(null)
  const [body, setBody] = useState('')
  const [dlgOpen, setDlgOpen] = useState(false)

  useEffect(() => {
    void (async () => {
      const list = await api.listBriefs()
      setFiles(list)
      if (list.length && !current) {
        setCurrent(list[0])
      }
    })()
  }, [refreshTick])

  useEffect(() => {
    if (!current) { setBody(''); return }
    void api.readBrief(current.path).then(setBody)
  }, [current])

  const copyToClipboard = async () => {
    if (!body) return
    await navigator.clipboard.writeText(body)
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="page-eyebrow">// llm coaching pack</div>
          <div className="page-title">Brie<span className="accent">fs</span></div>
        </div>
        <div className="page-meta">
          {files.length} files<br />
          <span className="muted">{current ? `${current.sizeKb.toFixed(1)} KB` : '—'}</span>
        </div>
      </header>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="btn-row" style={{ marginTop: 0, marginBottom: 18 }}>
          <button className="btn primary" onClick={() => setDlgOpen(true)}>Generate brief</button>
          <button className="btn ghost" disabled={!current} onClick={copyToClipboard}>Copy markdown</button>
          <button className="btn ghost" disabled={!current} onClick={() => current && api.revealInFinder(current.path)}>Show in Finder</button>
        </div>

        <div className="split" style={{ flex: 1, minHeight: 400 }}>
          <div className="list-pane">
            {files.length === 0 && <div className="muted text-mono" style={{ padding: 12, fontSize: 11 }}>no briefs yet</div>}
            {files.map(f => (
              <div
                key={f.path}
                className={`list-item ${current?.path === f.path ? 'active' : ''}`}
                onClick={() => setCurrent(f)}
              >
                <div className="filename">{f.name}</div>
                <div className="meta">{f.sizeKb.toFixed(1)} KB · {new Date(f.mtime).toLocaleDateString()}</div>
              </div>
            ))}
          </div>

          <div className="viewer-pane">
            <div className="viewer-toolbar">
              <span>{current?.name ?? 'no file'}</span>
              <span className="spacer" />
              <span>{body.length.toLocaleString()} chars</span>
            </div>
            <div className="viewer-body">
              {body ? renderMarkdown(body) : <span className="muted">select a brief</span>}
            </div>
          </div>
        </div>
      </div>

      {dlgOpen && (
        <BriefDialog
          onClose={() => setDlgOpen(false)}
          onGenerated={() => { setDlgOpen(false); onRefresh() }}
        />
      )}
    </>
  )
}
