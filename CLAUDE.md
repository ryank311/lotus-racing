# Racing / Catalyst Coach — Project Notes

## Dev Server

The Catalyst app runs at **http://localhost:5173** (Vite, started via `catalyst-app/`).

## Browser Inspection (chrome-devtools MCP)

Use the `mcp__chrome-devtools__*` tools to inspect and interact with the running app.

**Typical workflow:**
1. `mcp__chrome-devtools__list_pages` — confirm the app is open and get the page URL
2. `mcp__chrome-devtools__take_screenshot` — see the current visual state
3. `mcp__chrome-devtools__take_snapshot` — get the a11y tree with `uid` values for every element
4. `mcp__chrome-devtools__click` — click an element by `uid` from the snapshot
5. `mcp__chrome-devtools__navigate_page` — navigate by URL (type: "url") or history (back/forward/reload)

**Note:** All tools must be loaded via `ToolSearch` with `select:<tool-name>` before first use in a session.

## App Navigation

The app uses **client-side page state**, not URL routing. Direct URL navigation (e.g. `/logs`) does NOT work — the app always renders the default page.

Navigate by clicking sidebar items or footer buttons:

| Page | How to reach |
|------|-------------|
| Overview | Sidebar — "Overview" (⌘1) |
| Sessions | Sidebar — "Sessions" (⌘2) |
| Session Review | Sidebar — "Session Review" (⌘3) |
| Progress | Sidebar — "Progress" (⌘4) |
| Analysis | Sidebar — "Analysis" (⌘5) |
| 3D Replay | Sidebar — "3D Replay" (⌘6), or "Watch in 3D" on a lap in Session Review. Ghost picker → "Another driver" races another server driver's lap (`?ghost=driver:<name>:<session>:<lap>`; Both cars camera `?view=both`, the default when racing another driver) |
| AI Coach | Sidebar — "AI Coach" (⌘7) |
| Garage | Sidebar — "Garage" (⌘8) |
| Tracks | Sidebar — "Tracks" (⌘9) |
| Import | Sidebar — "Import" (⌘0) — PDR videos and car documents |
| Logs | Sidebar footer — bug icon button ("Debug logs") |

To click a sidebar item: take a snapshot, find the `uid` for the button/link, then use `mcp__chrome-devtools__click`.
