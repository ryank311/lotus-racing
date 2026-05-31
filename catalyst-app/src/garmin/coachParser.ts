// Parses a raw LLM response into a structured CoachingResult.
// Extracts the last ```json ... ``` block and validates it permissively —
// malformed entries are skipped rather than failing the whole parse.

import type { CoachingResult, CoachAnnotation, CoachAnnotationType, CoachLineWaypoint } from '../shared/types.js'

const VALID_ANNOTATION_TYPES = new Set<CoachAnnotationType>([
  'corner_tip', 'segment_tip', 'speed_annotation', 'line_deviation',
])

export function parseCoachResponse(raw: string): CoachingResult | null {
  // Find the last ```json ... ``` block in the response.
  const matches = [...raw.matchAll(/```json\s*([\s\S]*?)```/gm)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  let obj: unknown
  try { obj = JSON.parse(last[1].trim()) } catch { return null }
  return validate(obj)
}

function validate(o: unknown): CoachingResult | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.headline !== 'string') return null
  const consistency_loss_ms = typeof r.consistency_loss_ms === 'number' && !isNaN(r.consistency_loss_ms)
    ? Math.round(r.consistency_loss_ms)
    : 0
  const tips = Array.isArray(r.tips)
    ? r.tips
        .filter(t => t && typeof t.section === 'string' && typeof t.body === 'string')
        .map((t: any) => ({
          section: t.section as string,
          body: t.body as string,
          annotations: Array.isArray(t.annotations)
            ? (t.annotations as unknown[]).map(coerceAnnotation).filter((a): a is CoachAnnotation => a !== null)
            : [],
        }))
    : []
  const annotations = Array.isArray(r.annotations)
    ? r.annotations.map(coerceAnnotation).filter((a): a is CoachAnnotation => a !== null)
    : []
  const drills = Array.isArray(r.drills)
    ? r.drills.filter((d): d is string => typeof d === 'string')
    : []
  const coach_line = Array.isArray(r.coach_line)
    ? (r.coach_line as unknown[]).flatMap((w): CoachLineWaypoint[] => {
        if (typeof w !== 'object' || w === null) return []
        const wp = w as Record<string, unknown>
        if (typeof wp.dist_m !== 'number' || typeof wp.lateral_pos !== 'number') return []
        const lateral_pos = Math.max(0, Math.min(1, wp.lateral_pos))
        return [{ dist_m: wp.dist_m, lateral_pos, note: typeof wp.note === 'string' ? wp.note : undefined }]
      })
    : undefined
  return { headline: r.headline, consistency_loss_ms, tips, drills, annotations, coach_line }
}

function coerceAnnotation(a: unknown): CoachAnnotation | null {
  if (typeof a !== 'object' || a === null) return null
  const x = a as Record<string, unknown>
  if (!VALID_ANNOTATION_TYPES.has(x.type as CoachAnnotationType)) return null
  if (typeof x.ref !== 'string' || typeof x.body !== 'string') return null
  return {
    type: x.type as CoachAnnotationType,
    ref: x.ref,
    body: x.body,
    actual_apex_dist_m:       num(x.actual_apex_dist_m),
    recommended_apex_dist_m:  num(x.recommended_apex_dist_m),
    actual_entry_mps:         num(x.actual_entry_mps),
    actual_apex_mps:          num(x.actual_apex_mps),
    actual_exit_mps:          num(x.actual_exit_mps),
    target_apex_mps:          num(x.target_apex_mps),
    deviation_desc: typeof x.deviation_desc === 'string' ? x.deviation_desc : undefined,
    severity: ([1, 2, 3] as const).includes(x.severity as 1 | 2 | 3)
      ? (x.severity as 1 | 2 | 3)
      : undefined,
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && !isNaN(v) ? v : undefined
}
