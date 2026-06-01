import { useEffect, useRef, useState } from 'react'

export interface LogEntry {
  id: number
  ts: number
  level: 'log' | 'warn' | 'error' | 'info'
  source: 'main' | 'worker'
  message: string
}

function levelColor(level: LogEntry['level']): string {
  switch (level) {
    case 'error': return 'var(--red)'
    case 'warn':  return 'var(--amber, #f5a623)'
    case 'info':  return 'var(--cyan)'
    default:      return 'var(--text)'
  }
}

function levelTag(level: LogEntry['level']): string {
  return level.toUpperCase().padEnd(5)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

export function Logs({ entries }: { entries: LogEntry[] }) {
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(['log', 'warn', 'error', 'info']))
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [entries.length, autoScroll])

  const q = filter.trim().toLowerCase()
  const visible = entries.filter(e =>
    levelFilter.has(e.level) &&
    (!q || e.message.toLowerCase().includes(q))
  )

  const toggleLevel = (l: string) => {
    setLevelFilter(prev => {
      const next = new Set(prev)
      next.has(l) ? next.delete(l) : next.add(l)
      return next
    })
  }

  const copyAll = () => {
    const text = visible.map(e =>
      `[${fmtTime(e.ts)}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}`
    ).join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  return (
    <div className="logs-page">
      <div className="logs-toolbar">
        <div className="logs-title">
          <span className="logs-title-icon">◉</span>
          DEBUG LOGS
          <span className="logs-count">{visible.length}</span>
        </div>

        <div className="logs-filters">
          {(['log', 'warn', 'error', 'info'] as const).map(l => (
            <button
              key={l}
              className={`logs-level-btn ${levelFilter.has(l) ? 'on' : ''}`}
              style={{ '--level-color': levelColor(l) } as React.CSSProperties}
              onClick={() => toggleLevel(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>

        <input
          className="logs-search"
          placeholder="filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />

        <div className="logs-actions">
          <button
            className={`logs-action-btn ${autoScroll ? 'on' : ''}`}
            onClick={() => setAutoScroll(v => !v)}
            title="Auto-scroll to bottom"
          >
            ↓ tail
          </button>
          <button className="logs-action-btn" onClick={copyAll} title="Copy all visible">
            copy
          </button>
        </div>
      </div>

      <div className="logs-list" ref={listRef} onScroll={onScroll}>
        {visible.length === 0 && (
          <div className="logs-empty">No log entries yet.</div>
        )}
        {visible.map(e => (
          <div key={e.id} className="log-row" data-level={e.level}>
            <span className="log-ts">{fmtTime(e.ts)}</span>
            <span className="log-level" style={{ color: levelColor(e.level) }}>{levelTag(e.level)}</span>
            <span className="log-source">{e.source === 'main' ? 'MAIN ' : 'WORK '}</span>
            <span className="log-msg">{e.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
