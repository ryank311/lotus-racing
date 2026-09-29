// Coaching report tool. The schema is built per coaching packet so complex,
// metric, lap and evidence IDs are enums the model cannot invent. It is
// strict-compatible: every object is closed, every property required, and no
// numeric or array-length constraints (caps are enforced when parsing).
// The harness adapts it to Anthropic Messages or OpenAI Responses.

import type { CoachPacket } from './coachPacket.js'
import { FOCUS_PHASES } from './coachPacket.js'

export const COACHING_TOOL_NAME = 'submit_coaching_report'

const str = (description: string) => ({ type: 'string', description })
const closed = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const oneOf = (values: string[], description: string) => (values.length
  ? { type: 'string', enum: values, description }
  : { type: 'string', description })

export function buildCoachingTool(packet: CoachPacket | null) {
  const evidenceIds = packet ? Object.keys(packet.evidence) : []
  const complexIds = packet ? packet.complexes.map(c => c.id) : []
  const metricIds = packet ? packet.successMetrics : []
  const lapIds = packet ? packet.laps.map(l => l.id) : []
  const focusIds = packet?.previousFocus.length ? packet.previousFocus.map(f => f.item.id) : ['none']
  const evidence = { type: 'array', items: oneOf(evidenceIds, 'An evidence ID from the packet.'), description: 'Evidence IDs that support this item.' }
  return {
    name: COACHING_TOOL_NAME,
    description: 'Submit the finished coaching report. Call this exactly once with the complete analysis.',
    input_schema: closed({
      summary: str('Two sentences at most: what limits repeatable lap time now, and the single most valuable change.'),
      previous_focus_review: {
        type: 'array',
        description: 'One entry per previous focus item in the packet, judged from its measured result. Empty when the packet has none.',
        items: closed({
          focus_id: oneOf(focusIds, 'The previous focus item ID.'),
          verdict: { type: 'string', enum: ['worked', 'partly', 'no_change', 'worse', 'not_attempted', 'unclear'] },
          comment: str('One or two sentences: what the measurement shows and whether to keep this focus.'),
        }),
      },
      focus: {
        type: 'array',
        description: 'One to three changes for the next session, most valuable first. Fewer is better when the evidence is thin.',
        items: closed({
          complex: oneOf(complexIds, 'The corner complex this change applies to.'),
          phase: { type: 'string', enum: [...FOCUS_PHASES] },
          change: str('What to do differently, in driving terms, one or two sentences.'),
          why: str('The mechanism: how the measured difference costs time. Inputs are inferred from speed and g, so say "suggests" for pedal or steering claims.'),
          cue: str('A short in-car cue, under 60 characters.'),
          evidence: evidence,
          reference_lap: oneOf(lapIds, 'The lap that shows how: usually the best pass through this complex.'),
          metric: oneOf(metricIds, 'The measurement that shows the change worked: <complex>.<metric>.'),
          target: { type: 'string', enum: ['halfway', 'best'], description: 'halfway: close half the gap between the median and the best pass (default). best: match the best pass.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        }),
      },
      keep_doing: {
        type: 'array',
        description: 'Up to three habits to protect, each backed by evidence.',
        items: closed({ text: str('One sentence.'), evidence }),
      },
      run_plan: {
        type: 'array',
        description: 'Two to four runs for the next event: baseline, practice one focus at a time, then consolidate.',
        items: closed({
          run: str('Label, e.g. "Run 1 — settle in".'),
          focus: { type: 'string', enum: ['1', '2', '3', 'none'], description: 'Which focus item this run practises.' },
          instruction: str('What to do on this run.'),
          check: str('What to look at afterwards.'),
        }),
      },
      setup: {
        type: 'array',
        description: 'Usually empty. Only a change backed by a balance problem repeated on most representative laps; one change at a time.',
        items: closed({
          area: str('For example tire pressure, alignment, dampers.'),
          change: str('The adjustment, with direction and rough size.'),
          rationale: str('Why the data points to it.'),
          evidence,
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        }),
      },
      data_gaps: { type: 'array', items: str('A limitation that blocks or weakens a conclusion.'), description: 'Empty when nothing material.' },
    }),
  }
}

// Generic schema (no packet) for tests and legacy callers.
export const COACHING_TOOL = buildCoachingTool(null)
