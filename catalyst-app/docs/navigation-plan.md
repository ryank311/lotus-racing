# URL navigation and history plan

Status: implemented. Actual Android Firefox toolbar/keyboard behavior still
requires device verification.

## Implementation notes

- React Router supplies browser/hash history and navigation blocking. The shared
  navigation provider owns query updates, scroll/focus restoration, and overlays.
- Browser assets use root URLs. The build also emits `dist-renderer/desktop` with
  relative assets for Electron's `file:` fallback. HTTP deployment is rooted at `/`.
- Links are limited to 16,000 characters. Oversized selection updates are rejected
  visibly without truncation; persisted large comparisons are not enabled.
- Track browser starts with the circuit picker; choosing a layout pushes its URL.
- Visiting a URL does not auto-sync or download telemetry. Sessions exposes an
  explicit Download selected telemetry action for older sessions.
- Report headings stay in normal document flow, routed links retain their control
  styles, and navigation context identity survives Vite hot updates.
- New browser regression suites were removed at the user's request. Existing tests
  remain; the browser checks performed during implementation are not added to CI.

## Goals and current constraints

Every page and meaningful detail view must have a reproducible URL. Back and
Forward must restore the previous view, selection, and scroll position. Refresh
and direct links must work without first visiting Overview.

Before this change, `App.tsx` kept the page, selected session IDs, and active coaching
report only in React state. Garage, Tracks, and AI Coach also kept their selected
details locally. The desktop app can load from `file:`, while the browser app
loads from the HTTP server. The server already serves the app for extensionless
paths, but Vite's relative asset base needs changing for nested HTTP routes.

## Route hierarchy

Use these paths in the browser. Use the same route definitions after `#` in the
packaged desktop app, for example `index.html#/sessions`. Choose the history
adapter from the document protocol, not whether the API uses a remote server.

| Route | View and URL state |
| --- | --- |
| `/` | Replace with `/overview`; no extra Back step. |
| `/overview` | Dashboard, sync, AI provider settings, and units. Settings remain here for this change. |
| `/sessions` | Session list. Query: `q`, `vehicle`, `sort`, `dir`, and repeated `selected` session GUIDs. |
| `/analysis` | Analysis workspace. Repeated `session` GUIDs are the analysis input; `laps=top3\|top5\|top10\|all`, `view=charts\|map`, and optional `report` identify the displayed scope and saved report. No session IDs means the existing empty state. |
| `/coach` | Saved coaching reports and Ask Coach action. Repeated `session` GUIDs specify inputs for a new run. |
| `/coach/:reportId` | A saved report, fetched by ID. Its “Open in Analysis” link includes the saved session IDs, lap scope, and report ID. |
| `/garage` | Vehicle list and unselected detail pane. |
| `/garage/:vehicleGuid` | Selected vehicle and profile. |
| `/garage/:vehicleGuid/files/:fileId` | Selected profile document/editor. Use an opaque or encoded profile-relative identifier; never expose an absolute filesystem path. Resolve it through the vehicle's authorized profile. |
| `/tracks` | Circuit/layout browser. Optional `track` selects a circuit group by its encoded name; no new fabricated circuit ID is needed. |
| `/tracks/:meanLineGuid` | Selected track layout/map/editor. Optional `turn` selects a corner. The layout ID also determines the circuit group. |
| `/account` | Current account and sign-out action. No account credentials in the URL. |
| `/logs` | Diagnostics. Query: `q`, repeated `level`, and `follow=0\|1`. Logs themselves remain ephemeral and can be empty after refresh. |
| `/sign-in?returnTo=…` | Remote workspace sign-in. Return only to a validated local app route. Garmin sign-in remains a separate dialog over the requested page. |
| Unrecognized route | Not-found view with links to Overview and Sessions; preserve the bad URL so the failure is visible. |

Resource IDs are authoritative; names are display labels. A renamed vehicle or
report retains its URL. A stale or inaccessible resource gets an explicit
unavailable state with a parent link, rather than silently opening another item.
Opening `/tracks` may select its current default layout using replace, while a
direct layout URL must never be overwritten by the default-selection effect.

## History behavior

Use one router and typed route/query helpers as the source of navigation state.
Remove the independent `page` state and direct `setPage` calls. Navigation links
must be real links, supporting new tabs and copied addresses. Sidebar highlighting
comes from the matched parent route. Keyboard shortcuts use the same navigation
helpers. Clicking the active destination does not add a duplicate history entry.

| Action | History behavior |
| --- | --- |
| Sidebar page change, Analyze, open report, vehicle, document, or layout | Push one entry. |
| Session checkbox or Select/Clear visible | Replace `selected` on the Sessions entry; do not create a Back step per checkbox. |
| Search, vehicle filter, sort, lap filter, Charts/Map switch, selected corner, log filters | Replace the current query. Debounce text input and keep all unrelated supported parameters. |
| URL normalization, automatic initial selection, successful sign-in return, deleted resource's parent | Replace. |
| Browser Back/Forward | Restore the existing entry without pushing, redirecting unnecessarily, or rerunning actions. |
| Sync, save, upload, delete confirmation, coaching job progress | No history entry merely because work occurred. Never start these operations by visiting a URL. |
| Coaching completes in the background | Refresh report data and show a notification. Do not automatically navigate away; clicking View pushes the report/analysis destination. |

Example: `/overview` → `/sessions` → select A and B (replace the Sessions URL)
→ `/analysis?session=A&session=B`. One Back returns to the same list with A and B
selected, the previous filters, and the prior scroll position. Forward restores
the analysis. The page's “Sessions” link is a parent link, not a blind
`history.back()`: return to the originating Sessions URL when available, otherwise
build `/sessions` with the current selection. Use the existing prior entry only
when it is known to be that destination; direct-link arrivals must stay in-app.

Selection belongs to the URL of the current workflow. Links from Sessions to
Analysis or AI Coach carry it explicitly. Preserve the most recent Sessions URL
per workspace for the sidebar's return link, with a plain `/sessions` fallback.
Opening `/analysis` directly must not silently inherit a different tab's selection.
Changing sessions or lap scope invalidates an incompatible `report` parameter;
opening a report initializes its saved scope before analysis loads.

## State, validation, and loading

- Keep reproducible inputs in the URL. Sort/deduplicate GUID sets, encode values,
  omit defaults, validate enums, and normalize with replace. Distinguish malformed
  input from a syntactically valid resource that does not exist.
- Use repeated GUID parameters initially. Define and test a URL size limit before
  shipping; never silently truncate a large selection. If large comparisons exceed
  it, add a persisted comparison ID route before enabling those selections.
- Keep API keys, tokens, unsaved document contents, hover positions, chart gestures,
  and background-job logs out of URLs. Units and AI settings remain stored settings.
- Load records by URL IDs on both refresh and direct entry. Resolve account and
  database availability before choosing a sign-in or unavailable state. Preserve
  the current cached-telemetry access behavior when Garmin is signed out.
- Keep the requested route through authentication. Validate `returnTo` against
  known local routes and reject external/protocol-relative targets. Clear per-account
  caches, selections, and restoration state when switching workspaces.
- Cancel or ignore stale requests after navigation so an older response cannot
  overwrite the new route. Missing report/session data must not crash the page.
- If a selected session needs telemetry, show an explicit download action or pending
  state; resolving a shared URL alone must not start synchronization or paid coaching.
- Preserve the existing outer `remote` and `catalystServer` bootstrap parameters in
  desktop launches. Route query parameters belong inside the hash there, so they
  cannot overwrite the transport configuration.

## Scrolling, focus, dialogs, and edits

The app shell, page heading, selection footer, and active status footer stay outside
the content scroll region. On phones, the Analyze footer occupies layout space
within the dynamic viewport instead of overlaying the list. Apply the bottom safe
area once. Avoid making the shell itself a secondary scroll container.

Record each relevant pane's scroll position and focus target by history entry key,
not just pathname: two visits to the same route can have different positions. Save
before leaving. New page/detail navigation starts at the top and focuses its heading;
Back/Forward restores positions after lazy content and data have rendered. Query
replacement preserves focus and scroll unless a changed filter requires resetting
the list. Restore the list after selection changes without covering its last card.

Mobile navigation, maximized charts, and sign-in/confirmation dialogs use a shared
overlay history policy: opening an overlay pushes a same-URL entry with an overlay
marker; Back closes the top overlay first. Closing explicitly consumes only the
entry the overlay owns. On refresh, drop transient overlay markers with replace.
Never leave duplicate dead entries or let a close button go back past the app.
Desktop Escape, focus restoration, and native dialog handling use that same manager.

Garage documents and track edits must block all navigation that would discard dirty
state, including browser Back/Forward, resource selection, and sidebar links. Offer
Save/Discard/Cancel; Cancel retains the route, history position, and draft. Use the
browser's unload protection for refresh/close where available. Drafts are not stored
in history or query parameters.

## Implementation sequence

1. Finish the mobile shell/footer fix independently of routing. Verify Android
   Firefox portrait on the actual device; desktop viewport emulation is insufficient
   to prove browser-toolbar and keyboard behavior.
2. Add a router with browser and hash history adapters, typed URL parsers/builders,
   route loading/error boundaries, navigation blocking, and scroll restoration.
   Cover all eight existing pages, sign-in, and not-found behavior first.
3. Move Sessions and Analysis inputs into URL state. Wire sidebar links, keyboard
   shortcuts, parent links, and the coaching notification. Remove automatic
   background-result navigation and test Back/Forward as one complete workflow.
4. Add saved-report, Garage document, and track-layout detail routes; remove local
   default-selection effects that override deep links. Add editor navigation guards.
5. Make HTTP builds use assets rooted at the configured deployment base; keep
   relative assets for packaged `file:` builds. Verify server/proxy fallback for
   every nested route. Ensure opaque document IDs avoid the current static server's
   extension-based fallback exclusion. Missing JS/CSS and `/api/*` must remain errors.
6. Add overlay history and finish cross-browser acceptance checks. Update page titles
   with the route/resource and retain navigation focus announcements.

## Acceptance checks

- Every route: direct entry, reload, copied link/new tab, Back, Forward, missing ID,
  malformed query, loading failure, and authenticated/unauthenticated startup.
- Sessions: select, scroll, analyze, Back, Forward; restore filters, selection,
  position, and an operable Analyze button. Repeat with downloaded and missing data.
- Reports: open from history, reload, open in Analysis with saved lap scope, delete,
  and navigate back to a deleted report. Background completion never steals the page.
- Garage/Tracks: deep-link to the selected item, edit, then exercise Save/Discard/
  Cancel with Back, Forward, sidebar navigation, reload, and item selection.
- Android Firefox portrait: browser chrome shown/hidden, address-bar interaction,
  search keyboard open/closed, bottom-of-list scrolling, active sync status, drawer,
  and maximized charts. Also check Chrome Android, Safari iOS, landscape, and desktop.
- HTTP production build: nested-route assets load correctly through the deployment
  proxy. Packaged Electron: identical route behavior with hash URLs and remote API
  bootstrap parameters preserved.

## Current mobile investigation

The existing layout clips the bottom of Overview and hides the Sessions Analyze
bar at 844 × 390 in both desktop Chrome and Firefox viewport checks. The implicit
grid row grows to roughly 464 px despite a 390 px shell. Portrait checks in those
desktop engines do not reproduce the reported Android Firefox issue. The shell
and footer changes address the demonstrated overflow and remove the mobile fixed
footer dependency; actual Android Firefox portrait verification remains required.
