// Parses a raw LLM response into a structured CoachingResult.
// Extracts the last ```json ... ``` block and validates it permissively —
// malformed entries are skipped rather than failing the whole parse.

import type { CoachingResult, CoachAnnotation, CoachAnnotationType, CoachLineWaypoint, CoachSetupRec, FocusItem } from '../shared/types.js'
import type { CoachPacket } from './coachPacket.js'
import { focusFromChoice } from './coachPacket.js'

const VALID_ANNOTATION_TYPES = new Set<CoachAnnotationType>([
  'corner_tip', 'segment_tip', 'speed_annotation', 'line_deviation',
])

function cleanJson(s: string): string {
  // Strip explicit leading `+` from numeric values — LLMs sometimes write
  // `+0.15` which is valid JS but invalid JSON.
  return s.replace(/([,:\[{]\s*)\+(\d)/g, '$1$2')
}

export function parseCoachResponse(raw: string): CoachingResult | null {
  const trimmed = raw.trim()

  // Tool use path: the harness returns the raw JSON object directly (no code fences).
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(cleanJson(trimmed))
      return validate(obj)
    } catch { /* fall through to code-fence path */ }
  }

  // Text path: find the last ```json ... ``` block in the response.
  const matches = [...raw.matchAll(/```json\s*([\s\S]*?)```/gm)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  try {
    const obj = JSON.parse(cleanJson(last[1].trim()))
    return validate(obj)
  } catch { return null }
}

function validate(o: unknown): CoachingResult | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.headline !== 'string') return null
  const consistency_loss_ms = typeof r.consistency_loss_ms === 'number' && !isNaN(r.consistency_loss_ms)
    ? Math.max(0, Math.round(r.consistency_loss_ms))
    : 0
  const strengths = stringArray(r.strengths)
  const tips = Array.isArray(r.tips)
    ? r.tips
        .filter(t => t && typeof t.section === 'string' && typeof t.body === 'string')
        .map((t: any) => ({
          section: t.section as string,
          body: t.body as string,
          priority: ordinal(t.priority),
          estimated_gain_ms: typeof t.estimated_gain_ms === 'number' && !isNaN(t.estimated_gain_ms)
            ? Math.max(0, Math.round(t.estimated_gain_ms))
            : undefined,
          confidence: ordinal(t.confidence),
          evidence: stringArray(t.evidence),
          cue: typeof t.cue === 'string' ? t.cue : undefined,
          success_metric: typeof t.success_metric === 'string' ? t.success_metric : undefined,
          annotations: Array.isArray(t.annotations)
            ? (t.annotations as unknown[]).map(coerceAnnotation).filter((a): a is CoachAnnotation => a !== null)
            : [],
        }))
    : []
  const annotations = Array.isArray(r.annotations)
    ? r.annotations.map(coerceAnnotation).filter((a): a is CoachAnnotation => a !== null)
    : []
  const drills = stringArray(r.drills)
  const next_session_plan = Array.isArray(r.next_session_plan)
    ? (r.next_session_plan as unknown[]).flatMap((step) => {
        if (typeof step !== 'object' || step === null) return []
        const x = step as Record<string, unknown>
        if (typeof x.run !== 'string' || typeof x.focus !== 'string' || typeof x.success_metric !== 'string') return []
        return [{ run: x.run, focus: x.focus, success_metric: x.success_metric }]
      })
    : undefined
  const data_quality_notes = stringArray(r.data_quality_notes)
  const coach_line = Array.isArray(r.coach_line)
    ? (r.coach_line as unknown[]).flatMap((w): CoachLineWaypoint[] => {
        if (typeof w !== 'object' || w === null) return []
        const wp = w as Record<string, unknown>
        if (typeof wp.dist_m !== 'number' || typeof wp.delta !== 'number') return []
        const delta = Math.max(-1, Math.min(1, wp.delta))
        return [{ dist_m: wp.dist_m, delta, note: typeof wp.note === 'string' ? wp.note : undefined }]
      })
    : undefined
  const setup = Array.isArray(r.setup)
    ? (r.setup as unknown[]).flatMap((s): CoachSetupRec[] => {
        if (typeof s !== 'object' || s === null) return []
        const x = s as Record<string, unknown>
        if (typeof x.area !== 'string' || typeof x.change !== 'string' || typeof x.rationale !== 'string') return []
        return [{
          area: x.area,
          change: x.change,
          rationale: x.rationale,
          confidence: ([1, 2, 3] as const).includes(x.confidence as 1 | 2 | 3)
            ? (x.confidence as 1 | 2 | 3)
            : undefined,
        }]
      })
    : undefined
  return {
    headline: r.headline, consistency_loss_ms, strengths, tips, drills,
    next_session_plan, data_quality_notes, annotations, coach_line, setup,
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function ordinal(value: unknown): 1 | 2 | 3 | undefined {
  return ([1, 2, 3] as const).includes(value as 1 | 2 | 3) ? value as 1 | 2 | 3 : undefined
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
    // Prefer mph fields; fall back to legacy m/s if a model still emits them.
    actual_entry_mph:         num(x.actual_entry_mph) ?? mphFromMps(x.actual_entry_mps),
    actual_vmin_mph:          num(x.actual_vmin_mph),
    target_vmin_mph:          num(x.target_vmin_mph),
    actual_vmin_dist_m:       num(x.actual_vmin_dist_m),
    actual_apex_mph:          num(x.actual_apex_mph)  ?? mphFromMps(x.actual_apex_mps),
    actual_exit_mph:          num(x.actual_exit_mph)  ?? mphFromMps(x.actual_exit_mps),
    target_apex_mph:          num(x.target_apex_mph)  ?? mphFromMps(x.target_apex_mps),
    deviation_desc: typeof x.deviation_desc === 'string' ? x.deviation_desc : undefined,
    severity: ([1, 2, 3] as const).includes(x.severity as 1 | 2 | 3)
      ? (x.severity as 1 | 2 | 3)
      : undefined,
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && !isNaN(v) ? v : undefined
}

// Legacy fallback: convert an m/s value to mph if present.
function mphFromMps(v: unknown): number | undefined {
  const n = num(v)
  return n == null ? undefined : n * 2.23694
}

// ─── Version 2: reports built on the evidence packet ─────────────────────────

const CONFIDENCE: Record<string, 1 | 2 | 3> = { low: 1, medium: 2, high: 3 }

function parseJsonObject(raw: string): Record<string, any> | null {
  const trimmed = raw.trim()
  const candidates = [trimmed, ...[...raw.matchAll(/```json\s*([\s\S]*?)```/gm)].map(m => m[1].trim()).reverse()]
  for (const text of candidates) {
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(cleanJson(text))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch { /* try the next candidate */ }
  }
  return null
}

// Turn the model's choices into a stored report. Every number comes from the
// packet; the model's text is kept as written. Unknown IDs are dropped.
export function parseCoachingReport(raw: string, packet: CoachPacket, reportId: string): CoachingResult | null {
  const r = parseJsonObject(raw)
  if (!r || typeof r.summary !== 'string' || !r.summary.trim()) return null
  const known = (ids: unknown): string[] => stringArray(ids).filter(id => id in packet.evidence)
  const resolve = (ids: string[]) => ids.map(id => packet.evidence[id])

  const focus: FocusItem[] = []
  for (const choice of Array.isArray(r.focus) ? r.focus.slice(0, 3) : []) {
    if (!choice || typeof choice !== 'object' || typeof choice.change !== 'string') continue
    const item = focusFromChoice(packet, {
      complex: String(choice.complex ?? ''), metric: String(choice.metric ?? ''), target: String(choice.target ?? 'halfway'),
      phase: String(choice.phase ?? ''), change: choice.change, why: String(choice.why ?? ''), cue: String(choice.cue ?? ''),
      reference_lap: String(choice.reference_lap ?? ''), confidence: String(choice.confidence ?? 'medium'), evidence: known(choice.evidence),
    }, `${reportId.slice(0, 8)}-${focus.length + 1}`)
    if (item) focus.push(item)
  }

  const tips: CoachingResult['tips'] = focus.map((item, i) => {
    const stat = packet.stats[item.complexId]?.time
    const gain = stat?.median != null && stat.best != null ? Math.max(0, Math.round(stat.median - stat.best)) : undefined
    const complex = packet.complexes.find(c => c.id === item.complexId)
    const vmin = packet.stats[item.complexId]?.vmin
    const annotation: CoachAnnotation = {
      type: complex?.corners.length ? 'corner_tip' : 'segment_tip', ref: item.ref, body: item.cue || item.change,
      severity: i === 0 ? 3 : 2,
      actual_vmin_mph: vmin?.median != null ? vmin.median * 2.23694 : undefined,
      target_vmin_mph: vmin?.bestExec != null ? vmin.bestExec * 2.23694 : undefined,
    }
    return {
      section: item.complexName,
      ref: item.ref,
      body: [item.change, item.why].filter(Boolean).join(' '),
      priority: (Math.min(i + 1, 3)) as 1 | 2 | 3,
      estimated_gain_ms: gain,
      confidence: CONFIDENCE[item.confidence],
      evidence: resolve(item.evidence),
      cue: item.cue || undefined,
      success_metric: `${item.metricLabel}: ${item.display.target} (now ${item.display.baseline}; your best pass ${item.display.best})${item.referenceLap ? ` · reference ${item.referenceLap}` : ''}`,
      annotations: [annotation],
    }
  })

  const byFocus = new Map(packet.previousFocus.map(p => [p.item.id, p.check]))
  const previous = (Array.isArray(r.previous_focus_review) ? r.previous_focus_review : [])
    .filter((x: any) => x && byFocus.has(x.focus_id))
    .map((x: any) => ({ focusId: String(x.focus_id), verdict: String(x.verdict ?? 'unclear'), comment: String(x.comment ?? ''), measured: byFocus.get(x.focus_id) }))
  // Keep measured results even when the model skipped them.
  for (const [focusId, check] of byFocus) {
    if (!previous.some((p: { focusId: string }) => p.focusId === focusId)) previous.push({ focusId, verdict: check.verdict, comment: '', measured: check })
  }

  const setup: CoachSetupRec[] = (Array.isArray(r.setup) ? r.setup : []).flatMap((x: any) => {
    if (!x || typeof x.area !== 'string' || typeof x.change !== 'string') return []
    return [{ area: x.area, change: x.change, rationale: String(x.rationale ?? ''), confidence: CONFIDENCE[String(x.confidence)], evidence: resolve(known(x.evidence)) }]
  })

  const plan = (Array.isArray(r.run_plan) ? r.run_plan : []).flatMap((x: any) => {
    if (!x || typeof x.instruction !== 'string') return []
    const item = /^[123]$/.test(String(x.focus)) ? focus[Number(x.focus) - 1] : undefined
    return [{ run: String(x.run ?? 'Run'), focus: item ? `${x.instruction} (Focus: ${item.cue || item.complexName})` : x.instruction, success_metric: String(x.check ?? '') }]
  })

  const bestMs = packet.bestLap?.durationMs ?? null
  return {
    version: 2,
    headline: r.summary.trim(),
    consistency_loss_ms: bestMs != null && packet.idealMs != null ? Math.max(0, Math.round(bestMs - packet.idealMs)) : 0,
    ideal_lap_ms: packet.idealMs,
    strengths: (Array.isArray(r.keep_doing) ? r.keep_doing : []).slice(0, 4).flatMap((x: any) => {
      if (!x || typeof x.text !== 'string') return []
      const ev = resolve(known(x.evidence))
      return [ev.length ? `${x.text} (${ev[0].replace(/\.$/, '')})` : x.text]
    }),
    tips,
    focus,
    previous_focus_review: previous,
    drills: [],
    next_session_plan: plan,
    data_quality_notes: stringArray(r.data_gaps),
    annotations: tips.flatMap(t => t.annotations),
    setup,
    evidence: packet.evidence,
    context: packet.context,
  }
}
