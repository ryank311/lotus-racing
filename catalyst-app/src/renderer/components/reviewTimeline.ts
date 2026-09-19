const DAY_MS = 86_400_000
const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function calendarDate(value: string): Date | null {
  const day = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? date : null
}

/** Session order is the scale; calendar dates label it without reserving idle months. */
export function reviewTimeline(dates: string[], availableWidth: number) {
  const days = dates.map(calendarDate)
  const groups: Array<{ start: number; end: number; label: string; year: string }> = []
  const breaks: Array<{ before: number; days: number | null; label: string }> = []
  for (let i = 0; i < days.length; i++) {
    const current = days[i], previous = days[i - 1]
    const gap = current && previous ? (current.getTime() - previous.getTime()) / DAY_MS : null
    // Nearby dates form a visit, including Friday–Sunday. Missing dates never imply a known gap.
    if (!i || gap === null || gap > 3 || gap < 0) {
      groups.push({ start: i, end: i, label: '', year: '' })
      if (i) breaks.push({ before: i, days: gap !== null && gap > 3 ? gap : null,
        label: gap !== null && gap > 3 ? gap < 14 ? `${gap} d` : `${gap % 7 ? '≈' : ''}${Math.round(gap / 7)} wk` : '' })
    } else groups[groups.length - 1].end = i
  }
  for (const group of groups) {
    const first = days[group.start], last = days[group.end]
    if (!first || !last) { group.label = 'Date unknown'; continue }
    const sameDay = first.getTime() === last.getTime()
    const sameMonth = first.getUTCMonth() === last.getUTCMonth() && first.getUTCFullYear() === last.getUTCFullYear()
    group.label = sameDay ? dateLabel.format(first) : `${dateLabel.format(first)}–${sameMonth ? last.getUTCDate() : dateLabel.format(last)}`
    group.year = first.getUTCFullYear() === last.getUTCFullYear() ? String(first.getUTCFullYear()) : `${first.getUTCFullYear()}–${last.getUTCFullYear()}`
  }
  const left = 88, right = 48, breakWidth = 48
  // Preserve individually selectable points on a phone; only the plot scrolls when necessary.
  const width = Math.max(availableWidth, 300, left + right + Math.max(0, dates.length - 1) * 24 + breaks.length * breakWidth)
  const step = dates.length > 1 ? (width - left - right - breaks.length * breakWidth) / (dates.length - 1) : 0
  const positions = dates.map((_, i) => dates.length === 1 ? (left + width - right) / 2 : left + i * step + breaks.filter(b => b.before <= i).length * breakWidth)
  return { width, positions, groups, breaks: breaks.map(b => ({ ...b, x: (positions[b.before - 1] + positions[b.before]) / 2 })) }
}
