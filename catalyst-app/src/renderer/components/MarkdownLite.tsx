// Tiny markdown renderer — just enough to show coaching briefs nicely.
// Handles headings, bold, italic, code spans, and renders tables in a
// monospace block. Anything more elaborate would be overkill for the
// brief format we emit ourselves.

import { Fragment, ReactNode } from 'react'

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let key = 0
  while (rest.length) {
    // **bold**
    const bold = rest.match(/^(.*?)\*\*(.+?)\*\*(.*)$/s)
    if (bold) {
      if (bold[1]) out.push(<Fragment key={key++}>{renderCode(bold[1])}</Fragment>)
      out.push(<strong key={key++} style={{ color: 'var(--text)' }}>{bold[2]}</strong>)
      rest = bold[3]
      continue
    }
    out.push(<Fragment key={key++}>{renderCode(rest)}</Fragment>)
    break
  }
  return out
}

function renderCode(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const parts = text.split(/(`[^`]+`)/g)
  parts.forEach((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) {
      out.push(<code key={i} style={{ color: 'var(--cyan)', background: 'rgba(125,211,252,0.06)', padding: '0 4px', borderRadius: 2 }}>{p.slice(1, -1)}</code>)
    } else {
      out.push(<Fragment key={i}>{p}</Fragment>)
    }
  })
  return out
}

export function renderMarkdown(md: string): ReactNode {
  const lines = md.split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      out.push(<div key={key++} className="md-h3">{line.slice(4)}</div>)
      i++
    } else if (line.startsWith('## ')) {
      out.push(<div key={key++} className="md-h2">{line.slice(3)}</div>)
      i++
    } else if (line.startsWith('# ')) {
      out.push(<div key={key++} className="md-h1">{line.slice(2)}</div>)
      i++
    } else if (line.startsWith('|')) {
      // Greedy: collect contiguous table lines, render as preformatted.
      const start = i
      while (i < lines.length && lines[i].startsWith('|')) i++
      const tbl = lines.slice(start, i).join('\n')
      out.push(<pre key={key++} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', background: 'var(--bg-elev)', padding: '12px', borderRadius: 2, border: '1px solid var(--border)', overflowX: 'auto', whiteSpace: 'pre' }}>{tbl}</pre>)
    } else if (line.startsWith('---')) {
      out.push(<hr key={key++} style={{ border: 0, borderTop: '1px solid var(--border)', margin: '20px 0' }} />)
      i++
    } else if (line.trim() === '') {
      out.push(<br key={key++} />)
      i++
    } else {
      out.push(<div key={key++}>{renderInline(line)}</div>)
      i++
    }
  }
  return out
}
