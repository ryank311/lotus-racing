import type { WorkerProgress } from '../shared/types'

export interface LogEntry {
  id: number
  ts: number
  level: 'log' | 'warn' | 'error' | 'info'
  source: 'main' | 'worker'
  message: string
}

// Only mounted viewers subscribe. A burst of backend events produces at most
// one notification per 100ms, without scheduling any work while nobody listens.
function batchedNotifications() {
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { clearTimeout(timer); timer = undefined }
      }
    },
    notify: () => {
      if (!listeners.size || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        listeners.forEach(listener => listener())
      }, 100)
    },
  }
}

export function createActivityStore() {
  const logNotifications = batchedNotifications()
  let entries: LogEntry[] = []
  let logSnapshot: LogEntry[] | undefined
  let nextId = 0
  function addLogEntry(level: LogEntry['level'], source: LogEntry['source'], message: string) {
    entries.push({ id: nextId++, ts: Date.now(), level, source, message })
    if (entries.length > 5000) entries = entries.slice(-4000)
    logSnapshot = undefined
    logNotifications.notify()
  }
  const logStore = {
    subscribe: logNotifications.subscribe,
    getSnapshot: () => logSnapshot ??= entries.slice(),
  }

  const statusNotifications = batchedNotifications()
  let status: { logLine: string; logLines: string[]; progress: WorkerProgress | null } = {
    logLine: '', logLines: [], progress: null,
  }
  const statusStore = {
    subscribe: statusNotifications.subscribe,
    getSnapshot: () => status,
    setLogLine: (logLine: string) => {
      status = { ...status, logLine }
      statusNotifications.notify()
    },
    appendLine: (line: string) => {
      status = { ...status, logLines: [...status.logLines.slice(-499), line] }
      statusNotifications.notify()
    },
    setProgress: (progress: WorkerProgress | null) => {
      status = { ...status, progress }
      statusNotifications.notify()
    },
  }
  return { addLogEntry, logStore, statusStore }
}

export type ActivityStore = ReturnType<typeof createActivityStore>
