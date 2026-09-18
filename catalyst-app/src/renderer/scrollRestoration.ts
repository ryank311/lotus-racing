type Snapshot = { positions: Record<string, [number, number]>; focus?: string }
const snapshots = new Map<string, Snapshot>()
const storageKey = 'catalyst:scroll'
const paneSelector = '.page-body, .analysis-charts, .analysis-map, .viewer-pane, .garage-detail, .garage-editor, .logs-list, .coach-session-viewer, .tracks-corner-list'

export function clearScrollSnapshots() {
  snapshots.clear()
  try { sessionStorage.removeItem(storageKey) } catch { /* optional */ }
}

export function restoreScrollPosition(key: string, action: string) {
  let saved = snapshots.get(key)
  if (!saved) try { saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')[key] } catch { /* optional */ }
  let restoring = action === 'POP' && !!saved
  let current: Snapshot = { positions: { ...saved?.positions }, focus: saved?.focus }
  let elements: HTMLElement[] = []
  let dirty = false
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let observer: MutationObserver | undefined
  let waiting = true
  const scope = document.querySelector('.main-pane') ?? document.getElementById('root')!
  const findPanes = () => { elements = Array.from(document.querySelectorAll<HTMLElement>(paneSelector)) }
  const persist = () => {
    clearTimeout(persistTimer)
    persistTimer = undefined
    // A workspace switch may have cleared the snapshots since this was queued.
    if (!dirty || !snapshots.has(key)) return
    dirty = false
    try { sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(snapshots))) } catch { /* optional */ }
  }
  const remember = () => {
    snapshots.delete(key)
    snapshots.set(key, current)
    if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value!)
    dirty = true
    clearTimeout(persistTimer)
    persistTimer = setTimeout(persist, 200)
  }
  const stopRestoring = () => {
    restoring = false
    waiting = false
    observer?.disconnect()
    clearTimeout(restoreTimer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const captureScroll = (event: Event) => {
    if (restoring || !(event.target instanceof HTMLElement)) return
    const el = event.target
    let index = elements.indexOf(el)
    if (index < 0) {
      if (!el.matches(paneSelector)) return
      findPanes() // A pane was mounted after initial restoration completed.
      index = elements.indexOf(el)
    }
    if (index < 0) return
    // The scrolling pane is the only DOM node read in the normal event path.
    current = { ...current, positions: { ...current.positions, [index]: [el.scrollLeft, el.scrollTop] } }
    remember()
  }
  const captureFocus = () => {
    if (restoring) return
    const active = document.activeElement
    current = { ...current, focus: active?.id ? '#' + CSS.escape(active.id) : active?.getAttribute('aria-label') ? `[aria-label=${JSON.stringify(active.getAttribute('aria-label'))}]` : undefined }
    remember()
  }
  const resetPanes = new WeakSet<HTMLElement>()
  let focused = false
  const restore = () => {
    frame = undefined
    if (!waiting) return
    findPanes()
    if (!elements.length || scope.querySelector('[data-route-loading]')) return
    if (restoring && saved) {
      let complete = Object.keys(saved.positions).every(index => !!elements[Number(index)])
      elements.forEach((el, i) => {
        const pos = saved!.positions[i]
        if (!pos) return
        el.scrollLeft = pos[0]; el.scrollTop = pos[1]
        // Async content can initially clamp a saved position. Retry only until
        // the requested position is reachable, or the user takes control.
        if (Math.abs(el.scrollLeft - pos[0]) > 1 || Math.abs(el.scrollTop - pos[1]) > 1) complete = false
      })
      if (saved.focus && !focused) {
        const target = document.querySelector<HTMLElement>(saved.focus)
        if (target) { target.focus({ preventScroll: true }); focused = true }
        else complete = false
      }
      if (!complete) return
    } else if (action !== 'REPLACE') {
      elements.forEach(el => {
        if (!resetPanes.has(el)) { el.scrollTop = 0; el.scrollLeft = 0; resetPanes.add(el) }
      })
      const title = document.querySelector<HTMLElement>('.page-title, h1')
      if (title && !focused) { title.tabIndex = -1; title.focus({ preventScroll: true }); focused = true }
    }
    stopRestoring()
  }
  restore()
  if (waiting) {
    observer = new MutationObserver(() => {
      if (frame === undefined) frame = requestAnimationFrame(restore)
    })
    observer.observe(scope, { childList: true, subtree: true })
    restoreTimer = setTimeout(stopRestoring, 5000)
  }
  document.addEventListener('scroll', captureScroll, { capture: true, passive: true })
  document.addEventListener('focusin', captureFocus)
  document.addEventListener('pointerdown', stopRestoring, { once: true, passive: true })
  document.addEventListener('wheel', stopRestoring, { once: true, passive: true })
  document.addEventListener('keydown', stopRestoring, { once: true })
  window.addEventListener('pagehide', persist)
  return () => {
    stopRestoring()
    persist()
    document.removeEventListener('scroll', captureScroll, true)
    document.removeEventListener('focusin', captureFocus)
    document.removeEventListener('pointerdown', stopRestoring)
    document.removeEventListener('wheel', stopRestoring)
    document.removeEventListener('keydown', stopRestoring)
    window.removeEventListener('pagehide', persist)
  }
}
