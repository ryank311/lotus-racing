# Session Review and Progress

After syncing, choose **Review latest session** on Overview, **Review** on a session row, or **Session Review** in navigation. `/review/:sessionGuid` is a shareable in-app location. `/progress` opens longer-term history, defaulting to the last reviewed session's cohort. Existing shortcuts 1–6 retain their destinations; 7 opens Review and 8 opens Progress.

The charts and controls are React components with accessible SVG charts. The generated design images are illustrative references, not runtime UI. See [design images and reproduction prompts](session-review-design/README.md).

History charts use session order with evenly spaced sessions within each visit. Nearby session dates (up to three days apart) share a date-range label; longer gaps get a fixed-width break annotated with elapsed days or weeks. Months away from the track do not stretch the axis. Years remain visible, and each selectable point retains its full session timestamp. Dense histories scroll within the chart on smaller screens.

## Tracked metrics

| Metric | Population / calculation | Display |
| --- | --- | --- |
| Fast-three pace | Mean of the three fastest eligible laps, or the available eligible laps | Recent baseline delta, evidence label, previous reference, prior matched best mean, history |
| Best lap | Fastest eligible lap | Recent mean of session bests, previous-session best, prior matched PB |
| Corner / segment time | Interpolated elapsed-time difference at region boundaries, averaged across selected laps | Ranked signed bars, track highlights, contributing measurements, history |
| V-min | Minimum speed on the interpolated corner trace; mean of per-lap minima and their distance locations | Neutral speed delta, current/reference markers, location in metres, history |
| Entry / exit speed | Distance-weighted mean over the first / last five metres of the region | Neutral comparison with recent and previous means |
| Top speed | Mean per-lap maximum over selected laps | Neutral recent/previous comparison; highest observed maximum across **all eligible laps**, with lap and distance |
| Consistency | Sample standard deviation of lap or region times across eligible laps within 5% of the eligible session best | Explicit population, lap scatter, regional comparisons and history; unavailable with fewer than two measurements |

Storage and API values use milliseconds, metres, m/s and Celsius. Speed and ambient temperature follow the application's unit preference. Distances along the meanline remain metres.

## Eligibility and matching

- Only positive-duration `DRIVEN` laps with complete telemetry qualify. Garmin descriptor flags divergent (`0x02`), invalid (`0x04`), paused (`0x08`) and bad GPS (`0x10`) exclude a lap. The repository's normal bit (`0x01`) remains eligible.
- The telemetry validator requires monotonic elapsed timestamps, endpoints within two metres of the meanline, a start timestamp within 100 ms, a finish within 1,000 ms of lap duration, and no distance gaps larger than 25 m. Anchoring an endpoint must not reverse timing. Missing speed measurements cannot silently produce a minimum or maximum.
- Manual exclusions and optional reasons are persistent and reversible. Garmin-invalid laps remain invalid when a manual exclusion is removed.
- The identity key includes account, vehicle GUID, track cartography ID, configuration ID and direction/reverse. Missing required identity disables historical comparisons. Labels are never used as a substitute for stable identity.
- Matching requires an earlier session, the same surface and ambient temperature within ±5°C, inclusive. No weather normalization or fallback to wider cohorts occurs.
- Clear/cloudy/fair weather estimates dry; explicit rain/showers estimate wet. Mist, fog, drizzle, storms, snow and unrecognized descriptions remain unknown. Corrections preserve the original weather, temperature and correction timestamp.
- The primary reference is the equally weighted mean of the latest five matching session means. Older matching sessions remain available for progress and PB references. Future sessions cannot change a historical review's comparison. An older session imported later can change it.
- Regional history additionally requires the same meanline and geometry revision. Its latest five compatible sessions can differ from the lap-level baseline. Overlapping regions remain independent and their gains are never summed.
- A prominent clear time change requires three current measurements, at least three historical sessions with three measurements each, two current laps agreeing on direction, and a change greater than both historical sample standard deviation and 300 ms (pace) or 100 ms (region). Other differences stay numerical with limited-evidence labeling. Speed increases are neutral.

## Processing and persistence

`ReviewService` runs inside the existing driver database owner. Startup discovers downloaded sessions needing backfill; ingestion enqueues changed telemetry. Each session yields to the event loop, and foreground sync/rebuild/override operations share one serialized write queue. Opening a session prioritizes it and earlier sessions of its layout. Interrupted processing returns to pending on restart; failures remain visible and require retry.

The additive schema supports existing databases:

| Table | Purpose |
| --- | --- |
| `review_jobs` | Pending/processing/ready/failed state, priority, generation, errors |
| `review_lap_metrics` | Per-lap measurements, nested independent region measurements, eligibility and source lap indices |
| `review_aggregates` | Algorithm version, source/geometry fingerprints, summary and map cache |
| `review_snapshots` | Immutable comparisons identified by evidence revision |
| `review_conditions` / `review_lap_exclusions` | User-owned corrections and exclusions |
| `review_settings` | Most recently reviewed session |
| `coaching_sessions.review_context` / `review_result` | Review revision, prompt context, provider, units, evidence, structured report or failure |

Telemetry content hashes make repeated ingestion idempotent. Algorithm, source metadata, geometry, condition and lap changes invalidate derived results; dependent comparisons use the new cached summaries. A telemetry rebuild clears derived aggregates/jobs while preserving overrides, saved snapshots and coaching history. Driver workspaces keep their existing process/database isolation.

Review and Progress reads use saved aggregates, not historical sample scans. The integration test temporarily removes the samples table and verifies both read paths still work. Coverage reports catalog entries, downloaded sessions, completed/pending jobs and failures; missing archive history links to existing download/sync screens.

Transport-neutral handlers expose `review:get`, `review:ensure`, `review:progress`, `review:conditions`, and `review:excludeLap`. `review:ensure` accepts an explicit retry flag. Both the Electron bridge and HTTP client expose typed methods. Background status travels on the separate `review:event` channel.

## Coaching

**Ask Coach** is the only trigger. Opening, syncing or recalculating never calls a provider. The backend constructs the prompt from the saved comparison snapshot and existing garage context, with the exact displayed measurements and an evidence catalogue. It uses the existing configured provider, streaming harness and report history.

The dedicated tool response includes summary, strengths, regressions, at most three priorities, valid evidence references, cues, success criteria and limitations. Unsupported references or malformed output fail rather than becoming a successful report. Prompts prohibit invented controls, unsupported speed targets, certainty from weak evidence, and addition of overlapping opportunities.

The prompt, raw/parsed output, provider/model, units, evidence and review revision are saved. Reopening reuses the saved report. Input changes retain the report and mark it stale; regeneration is explicit. Review reports in AI Coach history link back to the reviewed session. Provider errors retain the prompt and expose retry through Ask Coach.

## Validation

- `npm run typecheck`
- `npm run build` (web and Electron renderer bundles)
- `npm run test:server` (metric, matching, migration, persistence, queue, coaching and transport tests)
- `npm run test:charts`, `npm run test:analysis`, `npm run test:performance`
- Browser checks at 390×844, 844×390 and desktop sizes: real cached history, condition correction/reset, manual exclusion/restoration, filters, region selection, history navigation, keyboard activation, provider configuration failure and console errors.
- Offline state fixture: `tests/fixtures/review.html` / `review.tsx`. It exercises processing, downloading, processing failure/retry, network failure/retry, partial history, unknown conditions, a populated coach panel and stale saved advice without network/model access. Serve it with a Vite server rooted at `tests/fixtures`, with the React plugin and repository root allowed for imports.
- A temporary copy of 50 downloaded sessions (1,771,898 samples) processed successfully with 333 eligible laps and no failed jobs. The metric pass took about five seconds after ingestion on the development machine. No source telemetry database was modified for this check.

Live provider generation and physical-device touch behavior were not exercised; provider integration is verified with deterministic streamed responses, and phone layouts were checked in browser viewports. There are no inferred braking metrics, setup/tyre cohorts, weather-adjusted times, or combined cross-track scores.
