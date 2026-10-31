// Shared identity for comparisons and saved coaching context. Missing map IDs
// must never make two otherwise unrelated courses compare equal.
export interface TrackLayoutIdentity {
  meanLineGuid?: string | null
  configurationId?: number | null
  trackLabel?: string | null
}

export function trackLayoutKey(layout: TrackLayoutIdentity): string | null {
  if (layout.meanLineGuid?.trim()) return `line:${layout.meanLineGuid.trim()}`
  if (layout.configurationId != null) return `config:${layout.configurationId}`
  const parts = layout.trackLabel?.split('·').map(part => part.trim().toLowerCase())
  // A facility name alone (or "Full Course" alone) does not identify a course.
  return parts?.length === 2 && parts.every(Boolean) ? `name:${JSON.stringify(parts)}` : null
}

export function sameTrackLayout(a: TrackLayoutIdentity, b: TrackLayoutIdentity): boolean {
  if (a.configurationId != null && b.configurationId != null && a.configurationId !== b.configurationId) return false
  const key = trackLayoutKey(a)
  return key !== null && key === trackLayoutKey(b)
}
