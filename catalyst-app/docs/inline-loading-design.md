# Inline loading design

Status: implemented in the shared web/desktop renderer. The sections below record the design and rollout decisions.

## Recommendation

Keep the existing page shell and instrument cards visible. Replace only values that are not known yet with short, static neutral skeleton bars. Put one small signal-orange activity mark beside a contextual status such as “Loading overview…” in the existing page metadata area. Do not cover, dim, or disable the whole page.

This uses the current carbon panels, thin borders, 2px corners, condensed display headings, and monospace metadata. Skeletons use panel-soft/border-strong tones; orange remains a small activity accent. No full-card shimmer, fake percentages, counting up from zero, or spinner in every card.

## What is wrong today

- `Home.tsx` substitutes `0` and `never` when `stats` is null (banner and four tiles), and can render “No telemetry yet” before stats arrive.
- `App.tsx` derives access from initially null auth/stats. Unknown can temporarily look signed out and empty. Its `refresh` waits for auth, stats, and email together; a failed request can prevent all three results from being committed.
- `Sessions.tsx` tracks loading, but its header still exposes initial array length and `hasDb=false` as facts.
- `Account.tsx` already uses ellipses, but swallowed request failures can leave them indefinitely.
- Route-code loading (`Suspense`) and page-data loading currently use different, minimal text treatments.

## Overview layout

1. Render the title and normal page structure immediately. Replace the header's unknown last-sync metadata with a small square and “Loading overview…”.
2. Keep the existing banner footprint. Use the neutral heading “Telemetry archive” while unresolved; replace the dynamic samples/last-sync line with a text-sized skeleton. Never show first-sync or sign-in prompts until their prerequisites have resolved.
3. Keep all four tile labels visible. Reserve the normal 44px value line; show fixed-width, 22px-high bars centered within it, approximately 3–5 characters wide. Avoid random widths that imply data.
4. Keep a stable “Review your driving” navigation row available during loading: its destination is known without fetching. Put the conditional latest-session action in a reserved slot in that row, so an independent latest-session request does not insert another full row above the tiles. On small screens reserve a second line. A missing or failed latest-session lookup must not hold up the overview.
5. Let settings load independently. Keep known local preferences usable; give remote AI settings their own compact placeholder and retry state. Only disable controls whose correct operation depends on unresolved data.
6. Keep the sync action slot stable. If auth is unresolved, use a disabled “Checking account…” control. If auth is confirmed, expose the appropriate sync/sign-in action even if stats are still pending. Ordinary page fetching must never be labelled “Syncing”: that word is reserved for the existing Garmin operation.

## State behavior

| Situation | Values/content | Local status/action |
| --- | --- | --- |
| First fetch, no known data | Static skeletons in existing slots | Loading overview… |
| Successful fetch | Actual values | Existing last-sync metadata |
| Successful, empty archive | Actual zero counts | No telemetry yet; sync CTA if signed in |
| Background refresh, same data scope | Preserve last successful content at full contrast | Updating…; do not reset values to skeletons |
| First fetch failed | Unavailable values shown as an em dash, not zero | Couldn't load overview · Retry |
| Refresh failed | Preserve last successful content | Couldn't update · Showing saved values · Retry |
| Slow first fetch | Keep skeletons | After 8 seconds: Still loading overview…; retain navigation |
| Account or incompatible dataset changes | Clear the old scope synchronously; show new skeletons | Loading the new context; ignore stale responses |

Use the same vocabulary for each region: “Loading sessions…”, “Updating progress…”, “Couldn't load tracks”. A zero is a real answer and appears only after success. An em dash means unavailable after a failure or a successfully returned missing field; it is not the primary loading design.

## Motion, timing, accessibility

- Show neutral placeholders immediately. Delay the orange activity animation about 150ms to avoid a flash on fast local reads. Never delay a completed response to satisfy a minimum animation duration.
- Animate only the small activity mark with a gentle 1.6s opacity pulse. Leave all skeletons static. Stop animation on success/error; no numeric tween.
- With reduced motion, keep the mark static. Text conveys status independently of color or motion.
- Use one polite live status per independently loading region, outside its `aria-busy` content. Hide decorative placeholders from assistive technology. Do not announce each tile or animation frame.
- Preserve focus, scroll position, headers, row heights, and chart container sizes. Do not wrap the whole app in `aria-busy` or disable unrelated navigation.
- A slow request is not evidence of a failure. Surface actual transport failure/timeout with a local Retry action; do not spin forever after rejection or replace an error with an empty state.

## Apply to other pages

- **Sessions / Tracks / Garage:** keep headings, search, column labels, and known controls. Use 4–6 representative skeleton rows or cards in the content region on initial load. Hide unknown result counts and database-status claims. A confirmed empty result uses the existing empty state.
- **Account:** use the same tile placeholders and explicit errors; prevent false “unknown driver” or token-expiring claims while auth/profile are unresolved.
- **Progress / Analysis / Session Review:** keep section headings and chart frames, with a quiet local loading status. Do not invent chart traces, zero axes, lap times, or track geometry. Preserve existing known processing stages for genuine telemetry/coaching work.
- **Route module fetch:** retain the application shell and route title and use the same local status primitive. Use a route-specific content skeleton only where the layout is known; avoid one generic dashboard skeleton on every route.
- **Filter/context changes:** retain old data only when its scope still matches the visible labels. If showing the previous result while a new filter loads, label it explicitly and suspend dependent actions; otherwise clear the affected region. Never show old-account values under a new account.

## Implementation sequence

1. **Correct resource state first.** In `App.tsx`, model auth, stats, and account identity with explicit pending/success/error states plus last successful data and refresh status. Commit independent results independently; email failure must not discard successful stats. Preserve existing data while refreshing the same scope. Ignore older responses after a newer request or account change; cancel where the transport supports it. Leave worker `busy` separate.
2. **Correct access decisions.** Signed out and no data must be established, not inferred from null. If either known valid auth or known cached data grants access, render the page. Otherwise show its inline initial-load state while prerequisites are unknown; show the sign-in gate only after both prerequisites are resolved and deny access. Use a retry state if access cannot be established because a prerequisite failed.
3. **Add small shared primitives.** A decorative `Skeleton`, contextual `InlineLoadStatus`, and tile value slot in renderer components; styles and reduced-motion rules in `styles.css`. Keep resource lifecycle state separate from presentation. No new loading library or cache framework is required for the first pass.
4. **Ship Overview first.** Update `Home` to consume explicit state; remove null-to-zero/never substitutions, stabilize banner/actions, and separate latest-session/settings fetches. Apply the same state to any sidebar/status-bar claims about auth. Preserve true empty-state behavior.
5. **Adopt page by page.** Sessions and Account next, then Tracks/Garage, then chart/review pages and route fallbacks. Use the same visual language but match each content shape. Audit other initial defaults rather than mechanically replacing every zero.

## Acceptance checks for implementation

- With a delayed initial API response, no `0`, `never`, “No telemetry”, false DB status, or false sign-in gate appears before the necessary successful response.
- Test success with data, success with genuine zero, slow response, initial failure, refresh success, refresh failure, and partial independent failures.
- Cached content stays visible during a same-scope refresh. Account switching and out-of-order responses never expose another scope's data.
- Navigation stays usable; only dependent actions are unavailable. Retry targets the failed resource and preserves successful regions.
- Check both browser transport and desktop bridge with fast and delayed reads, direct links and route navigation.
- Verify desktop and narrow layouts, stable value/card dimensions, keyboard focus, one appropriate screen-reader announcement, and reduced motion.
- Add meaningful renderer integration coverage for the false-zero/auth-gate regression and refresh/account-switch behavior; run typecheck and existing relevant checks after implementation.

## Preview

The companion concept previews first load, ready, refresh, confirmed empty, and failure states with illustrative sample values. The design controls compare neutral value bars with an em-dash alternative and motion on/off. The recommended default is neutral bars plus one small activity mark. The preview is cropped to the Overview's data section; existing settings remain below it.

## Verification

- TypeScript checks and both web/desktop production renderer builds pass.
- `tests/fixtures/loading.html` runs 12 regression checks using the browser HTTP adapter and 9 using the desktop preload adapter. Responses are mocked, including delayed/rejected calls; no backend or Garmin connection is used.
- Checks cover initial placeholders, real empty results, retry, refresh retention/failure, independent identity failure, access gating, list pages, and out-of-order responses across data scopes.
- Run `npx vite tests/fixtures --host 127.0.0.1 --port 5187`, open `/loading.html?remote=1` and `/loading.html`, then select **Run regression checks** in each. The fixture reports PASS or the failed assertion. **Preview loading** holds Overview in its initial state for layout inspection.
- Visually inspected Overview at desktop and 390px widths. Reduced-motion styling leaves the activity mark static.
