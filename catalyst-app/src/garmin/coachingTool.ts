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
    actual_apex_mph:  { type: 'number', description: 'Driver apex speed in mph (read directly from the per-corner / best-lap tables — already mph).' },
    target_apex_mph:  { type: 'number', description: 'Recommended apex speed in mph.' },
    actual_entry_mph: { type: 'number', description: 'Driver corner-entry speed in mph.' },
    actual_exit_mph:  { type: 'number', description: 'Driver corner-exit speed in mph.' },
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
      setup: {
        type: 'array',
        description:
          'Car setup / configuration recommendations grounded in the telemetry (tyre pressure, ' +
          'alignment, suspension, ride height, brakes, aero, differential, etc.). ONLY include a ' +
          'recommendation when the data supports it — understeer/oversteer signatures in lateral G ' +
          'and line, locking under braking, inconsistent grip across sessions/temperatures, etc. ' +
          'Return an empty array if the data does not justify any setup change. Do not pad.',
        items: {
          type: 'object',
          properties: {
            area: {
              type: 'string',
              description: 'Setup area, e.g. "Tire pressure", "Alignment", "Suspension", "Ride height", "Brakes", "Aero", "Differential".',
            },
            change: {
              type: 'string',
              description: 'The concrete adjustment, written to the driver. 1–2 sentences. Include direction and rough magnitude where possible (e.g. "drop front cold pressures ~2 psi").',
            },
            rationale: {
              type: 'string',
              description: 'Why this follows from the data — cite the corners, segments, laps, or conditions that motivate it. All speeds in mph.',
            },
            confidence: {
              type: 'integer',
              enum: [1, 2, 3],
              description: '1 = speculative (weak signal), 2 = likely, 3 = strong evidence in the data.',
            },
          },
          required: ['area', 'change', 'rationale'],
        },
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
