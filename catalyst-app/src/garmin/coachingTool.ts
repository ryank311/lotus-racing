// Provider-neutral tool definition for the coaching report. The harness adapts
// this schema to Anthropic Messages or OpenAI Responses at the API boundary.

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
      description: '1–2 sentences written to the driver. Use the display unit specified in the prompt.',
    },
    severity: { type: 'integer', enum: [1, 2, 3] },
    actual_vmin_mph:  { type: 'number', description: 'Measured minimum speed in this corner in mph. Include when V-min is relevant to this coaching opportunity.' },
    target_vmin_mph:  { type: 'number', description: 'Recommended minimum corner speed in mph.' },
    actual_vmin_dist_m: { type: 'number', description: 'Exact distance_m sample where the measured corner V-min occurred.' },
    actual_apex_mph:  { type: 'number', description: 'Legacy apex-speed field. Prefer actual_vmin_mph for minimum corner velocity.' },
    target_apex_mph:  { type: 'number', description: 'Legacy target apex-speed field. Prefer target_vmin_mph.' },
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
        description: 'Actual best lap milliseconds minus theoretical-best milliseconds. Must be non-negative.',
      },
      strengths: {
        type: 'array',
        description: '2–4 specific things the driver already does well, each backed by a lap/corner/segment measurement.',
        items: { type: 'string' },
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
              description: '2–4 sentences in plain English. Use the display unit specified in the prompt. No m/s.',
            },
            priority: {
              type: 'integer', enum: [1, 2, 3],
              description: '1 = highest-priority opportunity, 3 = lower priority.',
            },
            estimated_gain_ms: {
              type: 'integer',
              description: 'Conservative recoverable lap-time estimate for this item, in milliseconds. Omit when unsupported.',
            },
            confidence: {
              type: 'integer', enum: [1, 2, 3],
              description: '1 = weak/proxy evidence, 2 = repeated correlation, 3 = directly supported across multiple comparable laps.',
            },
            evidence: {
              type: 'array',
              description: '1–3 compact measurements that support the tip, with session short ID, lap, and corner/segment.',
              items: { type: 'string' },
            },
            cue: {
              type: 'string',
              description: 'A short in-car cue the driver can remember. Max 80 chars.',
            },
            success_metric: {
              type: 'string',
              description: 'A measurable Catalyst result that shows the change worked.',
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
      next_session_plan: {
        type: 'array',
        description: 'A progressive 2–4 run plan for the next event. Change one major variable at a time.',
        items: {
          type: 'object',
          properties: {
            run: { type: 'string', description: 'Run/stint label, e.g. "Run 1 — baseline".' },
            focus: { type: 'string', description: 'One primary focus and how to execute it.' },
            success_metric: { type: 'string', description: 'What to verify in Catalyst after the run.' },
          },
          required: ['run', 'focus', 'success_metric'],
        },
      },
      data_quality_notes: {
        type: 'array',
        description: 'Only material limitations that reduce confidence or prevent a conclusion. Empty when none.',
        items: { type: 'string' },
      },
      setup: {
        type: 'array',
        description:
          'Car setup / configuration recommendations grounded in the telemetry (tyre pressure, ' +
          'alignment, suspension, ride height, brakes, aero, differential, etc.). ONLY include a ' +
          'recommendation when the data supports it — repeatable balance signatures in lateral G ' +
          'and line, or consistent grip changes across comparable sessions/temperatures. ' +
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
              description: 'Why this follows from the data — cite the corners, segments, laps, or conditions that motivate it. Use the prompt display unit.',
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
    required: ['headline', 'consistency_loss_ms', 'strengths', 'tips', 'drills', 'next_session_plan', 'data_quality_notes', 'annotations'],
  },
} as const
