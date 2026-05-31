// Anthropic tool definition for the coaching report.
// Forced tool use (tool_choice: {type:"tool", name:"submit_coaching_report"}) ensures
// Claude returns guaranteed-valid JSON matching this schema — no regex parsing, no
// type coercion, no `+0.10` invalid-JSON issues.

const annotationSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['corner_tip', 'segment_tip', 'speed_annotation', 'line_deviation'],
    },
    ref: {
      type: 'string',
      description: 'Exactly one corner label (T4) or segment label (S3) — no ranges.',
    },
    body: {
      type: 'string',
      description: '1–2 sentences written to the driver. All speeds in mph.',
    },
    severity: { type: 'integer', enum: [1, 2, 3] },
    actual_apex_mps:  { type: 'number' },
    target_apex_mps:  { type: 'number' },
    actual_entry_mps: { type: 'number' },
    actual_exit_mps:  { type: 'number' },
    deviation_desc:   { type: 'string' },
  },
  required: ['type', 'ref', 'body'],
}

export const COACHING_TOOL = {
  name: 'submit_coaching_report',
  description: 'Submit the structured coaching report. Call this exactly once with the complete analysis.',
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: 'One sentence: biggest opportunity with quantified gap. Max 120 chars.',
      },
      consistency_loss_ms: {
        type: 'integer',
        description: 'theoretical_best_ms − actual_best_ms from the lap table.',
      },
      tips: {
        type: 'array',
        description: '3–6 coaching tips, each tied to a specific corner or segment.',
        items: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'Corner or segment label, e.g. "T7-T9" or "S4".',
            },
            body: {
              type: 'string',
              description: '2–4 sentences in plain English. All speeds in mph. No m/s.',
            },
            annotations: { type: 'array', items: annotationSchema },
          },
          required: ['section', 'body', 'annotations'],
        },
      },
      drills: {
        type: 'array',
        description: '3–5 concrete practice exercises for the next track day.',
        items: { type: 'string' },
      },
      annotations: {
        type: 'array',
        description: 'Flat duplicate of every annotation from every tip — required for map rendering.',
        items: annotationSchema,
      },
      coach_line: {
        type: 'array',
        description: 'Sparse waypoints as delta from driver best-lap lateral position. Omit on straights where the driver\'s line is already correct.',
        items: {
          type: 'object',
          properties: {
            dist_m: {
              type: 'number',
              description: 'Distance from start in metres. Use values from the best-lap trace table.',
            },
            delta: {
              type: 'number',
              description: 'Shift from driver\'s actual lateral_pos at this distance. Positive = toward right edge, negative = toward left. Range −1 to +1.',
              minimum: -1,
              maximum: 1,
            },
            note: {
              type: 'string',
              description: 'Short cue shown on the track map. Max 40 chars.',
            },
          },
          required: ['dist_m', 'delta'],
        },
      },
    },
    required: ['headline', 'consistency_loss_ms', 'tips', 'drills', 'annotations'],
  },
} as const
