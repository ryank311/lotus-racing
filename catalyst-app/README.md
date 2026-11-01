# Catalyst Coach

TypeScript/Electron port of the Python `catalyst_gui` + `garmin/` pipeline.
Pulls Garmin Catalyst session telemetry, loads it into DuckDB, generates
coaching briefs, and shows everything in a React-based desktop UI.

## Run

```bash
npm install
npm run dev          # launches Vite + Electron
npm run dev:server   # launches Vite + the headless server (no Electron)
```

For browser development, run `npm run dev:server` and open
`http://127.0.0.1:5173`. Vite hot-reloads the React UI and proxies `/api` to the
server on port 3210. The server runs TypeScript directly with `tsx` and restarts
when files in `src/main`, `src/garmin`, or `src/shared` change, including code
used by per-user workers. No separate build is needed. Ctrl+C stops both.

The `CATALYST_SERVER_HOST`, `CATALYST_SERVER_PORT`, and
`CATALYST_SERVER_DATA_DIR` environment variables also work in development;
Vite's API proxy follows the configured server host and port. By default this
uses the same driver workspaces as `npm run server`. Set
`CATALYST_SERVER_DATA_DIR` to a separate directory for isolated development data.

## Remote / headless server

For a persistent NAS installation and private phone access, follow the
[Synology Docker deployment guide](deploy/README.md).

Catalyst Coach can serve the complete UI to phones and other computers. Each
driver name gets a separate workspace containing its own DuckDB database, raw
sessions, Garmin token/config, AI coaching history, Garage profiles, track
edits, and settings.

Garage profile Markdown seeds DuckDB once, when a workspace first accesses
Garage or generates coaching context. From then on, Garage and AI prompts read
the workspace database, and edits save only to that database. Seed `.md` files
are left unchanged. Telemetry reloads preserve Garage data and coaching history;
include the workspace database in backups to retain saved edits.

On login with a valid Garmin session, sync automatically refreshes all session
overviews and downloads missing telemetry for the latest 20 sessions. Selecting
older sessions downloads and stores their details on demand. Overview's
**Sync now** repeats the recent sync; its caret offers **Sync All** to download
the entire archive. Already downloaded telemetry is reused.

```bash
npm install
npm run server -- --host 0.0.0.0 --port 3210 --data-dir /path/on/your/nas/catalyst-coach
```

Then open `http://<server-address>:3210` and enter a driver name. Entering a new
name creates the account; entering the same name on another device opens the
same data. There is intentionally no Catalyst-server password. Garmin sign-in
is separate and is still required before that driver can sync telemetry.

The packaged desktop app starts this server automatically on port 3210. Its
window is a client of the same server, so log into the same driver name on the
desktop and phone to share live sync progress and data.

When upgrading an existing desktop installation, the app copies its database,
raw sessions, Garmin tokens, AI settings, coaching history, Garage profiles,
track edits, and settings into a **Desktop** driver workspace. The login screen
prefills that name; use it on other devices to open the imported data. If that
name already exists, the app chooses **Desktop 2**, etc., without merging or
overwriting accounts. The original desktop files are retained. The import is
performed once, before opening the old database or starting the server; if it
fails, the desktop falls back to its original workspace and logs the error.

Environment equivalents are available for unattended services:

```bash
CATALYST_SERVER_HOST=0.0.0.0 \
CATALYST_SERVER_PORT=3210 \
CATALYST_SERVER_DATA_DIR=/path/on/your/nas/catalyst-coach \
npm run server:start
```

`server:start` expects `npm run build` to have already been run; `npm run
server` builds first. Keep this passwordless service on a trusted LAN or behind
your own authenticated reverse proxy—do not expose it directly to the public
internet. Back up the configured data directory to preserve every user.

`CATALYST_DATA_DIR`, `CATALYST_DB_PATH`, and `CATALYST_REPO_ROOT` remain local
desktop/CLI overrides. HTTP workers always keep data inside their driver's
workspace; use `CATALYST_SERVER_DATA_DIR` to relocate the server's workspaces.

## Comparing against other drivers

**Analysis → ⇄ Compare** overlays other drivers' sessions on your own. The
picker lists the other drivers on the server and their sessions on your
layout, in the same format as the Sessions page, with each session's best lap
and its gap to yours. Sessions on other layouts, without downloaded telemetry,
or already in your analysis are shown but cannot be picked. You can compare up
to 4 drivers and 20 sessions per driver. The choice is kept in the URL
(`compare=<driver>:<session>`), in the sidebar's link back to Analysis, and in
any coach report run with it.

Their laps use your lap filter, and each driver has one colour (yours are
orange):

- Speed, time-delta and long-G charts and the map overlay their laps. Every
  reference line (fastest lap, theoretical best, Garmin optimal) stays yours.
- A **Driver comparison** card shows each driver's best, theoretical and
  average lap and top speed, where the time goes split by split, and each
  corner on everyone's fastest lap.
- The segment heatmap shows **All drivers** (every lap against the best
  plausible split by anyone) or **Your laps**. "Implausibly fast" is judged
  within each driver's own laps.
- G-G draws one cloud and p95 circle per driver. The corner, braking and
  consistency charts add each driver's fastest lap (or spread) in their colour.
- **Ask Coach** sends them too: the packet measures each driver on your corner
  complexes (`driver.D1.*` evidence) and the coach uses their best passes as a
  second reference. Focus items are still measured on your laps only.

The stat strip, your own heatmap, and the AI coach's focus tracking describe
only your laps.

Each driver's backend owns its database, so the server asks the compared
driver's backend for a read-only export of the selected laps
(`compare:export`, which never syncs or downloads) and hands it to yours. The
desktop app does the same through the local server it starts, so its own
workspace can be compared against that server's drivers.

## Corvette PDR videos and car data

A Corvette Performance Data Recorder (PDR) writes its telemetry inside each
`PDR_####.mp4` (on its SD card or USB drive, in `DCIM/100PDR02`): a data track
named "Cougar PDR 2.0" (sample format `marl`) of 16-byte records, each a
channel number, a signed value and a 100 ns timestamp on the video's own
timeline. `pdrFile.ts` reads it straight from the MP4's sample table (no
ffmpeg; a 3 GB video costs a few MB of reads). The channels and scales in
`shared/pdr.ts` were identified against GPS and lap timing on a 2021 C8 at
VIR: speed, engine RPM, throttle, brake, gear, steering angle, the four wheel
speeds, lateral/longitudinal G, GPS position/heading/altitude, odometer and
the PDR's own lap counter. The brake channel is linear in deceleration
(≈1.1 g at 141) and shown as bar; that unit is inferred. Channels not
identified yet (temperatures, pressures, PDR internals) are stored raw.

**Import** (sidebar, ⌘9) takes one or more
videos. Each is matched to the Garmin session it was recorded in, without
choosing one:

1. Sessions near the PDR's clock are candidates. The PDR writes local time;
   whole-hour clock errors are tolerated. A candidate's telemetry is
   downloaded first if it is missing.
2. The car's speed is matched against each session's Garmin speed, second by
   second over the whole overlap (lap times differ, so this finds the right
   lap), then the PDR's GPS track against the Garmin positions to a few
   hundredths of a second (`pdrAlign.ts`).
3. The best match wins. A video that matches nothing (for example, the car
   never moves) is kept unattached with the reason, and can be matched again
   or attached to a session from that day by hand on the Import page.

**Session Review → Attach PDR video** attaches to that session only.

Uploads go up in 32 MB pieces (Cloudflare limits a request body to 100 MB),
and the server decodes and matches in the background while the page polls
(a proxied request may not take longer than 100 s). Videos are private to
their driver's workspace (`garmin/data/videos/<id>.mp4`) and are served with
range requests so the player can seek. The desktop app in development
(Electron IPC) copies the picked file instead and plays it from
`catalyst-video://`.

What is stored, in the workspace database:

- `session_videos` — one row per video: file, recording clock, length, the
  session it is attached to, and the sync offset (session time = video time +
  offset), as matched and as adjusted by hand.
- `pdr_records` — every telemetry record, raw, so channels can be re-read or
  re-scaled later without the video file.
- `pdr_lap_samples` — the known channels on each lap's 1 m Garmin samples,
  with the video time at each metre. Re-computed when the sync is nudged or
  the session's laps are reloaded.

Where it shows up:

- **Analysis** adds throttle, brake pressure, gear/RPM, steering and
  rear-wheel slip (rears vs fronts, against a no-slip baseline taken from
  the session) charts for laps a video covers, and the lap video player
  (below).
- **Session Review** shows the lap video player beside speed, the time gap
  and (with a PDR video) throttle, brake, gear and steering for the lap
  against a reference, and a table of driver inputs per corner: where braking
  starts, peak pressure, coasting time, throttle pickup, lowest gear and
  steering.
- **Import** lists every video with its session and laps, nudges the sync
  (±0.1/0.5 s) if the video runs ahead of or behind the charts, re-matches
  and deletes. Sessions with video are marked on the Sessions page.

## The lap video player

Session Review and Analysis share one player (`VideoDeck.tsx`), for PDR
and Catalyst videos alike:

- **Two laps at once.** Pick a lap and one to compare it with (another of
  your laps, the stitched optimal lap, or a compared driver's lap) and show
  them **side by side** (stacked when the player is narrow), **overlaid**
  (the second lap see-through, with an opacity slider on the picture), or
  as a **wipe** (the second lap over the first, cut at a handle you drag
  across the picture, or move with the arrow keys). The second
  video is kept at the same place on track as the first: its playback rate
  follows the speed ratio between the laps, and it jumps when it drifts by
  more than 0.35 s. Each video has a HUD with the lap, speed, time into the
  lap and, on the second, the gap at that point.
- **Linked to the charts.** Playing moves every distance chart's cursor and
  the map marker; hovering a chart while paused moves both videos there.
  Session Review's charts draw the two laps you picked, with corner labels,
  plus a gap chart (above zero: losing time). Without a comparison they use
  the fastest lap, or on the fastest lap the optimal one.
- **The lap strip** under the video shows the corners (click a number to play
  that corner, from 40 m before to 30 m after), the time gap between the two
  laps (shaded by who is ahead) and where you are; click or drag to move.
  ⏮ ⏭ (or [ ]) jump between corners; space plays, arrows step a frame
  (Shift: a second).
- **Play from the data.** Session Review's corner explorer (▶ Watch) and its
  corner inputs table, and in Analysis a heatmap cell (that lap's split) or a
  corner or segment named by the coach or the comparison panel, play or cue
  that stretch of track.
- In Analysis the player sits above the map, or across the page above the
  charts (⤢), where it stays in view while the charts scroll.

**Comparing drivers' videos.** A compared driver's export includes, for each
lap a video of theirs covers, the video's ID and where the lap starts in it;
Analysis places it on your distances from their lap timing. Their video
streams from their workspace (`GET /api/drivers/<name>/videos/<id>.mp4`, for
signed-in drivers; `catalyst-video://driver/<name>/<id>.mp4` in the desktop
app). Nothing is copied between workspaces.

## Garmin Catalyst session videos

The Catalyst records a video of every session on its SD card:

```
…/Android/data/com.garmin.racingcoach/files/RaceData/
  <DRIVER>/<Track name>/<CAR MAKE MODEL YEAR>/<YYYYMMDD>/<HHMMSS>/
    video_1.mp4             the whole session (1080p30, 1–2 GB; video_2.mp4… if split)
    optimal_lap_video.mp4   Garmin's render of the optimal lap
```

With the Catalyst connected over USB and opened in MacDroid, the card is at
`~/Library/CloudStorage/MacDroid-Catalyst/<SD card>/Android/data/com.garmin.racingcoach/files/RaceData`.
**Import → Garmin Catalyst → Choose RaceData folder** lists every recording on
it (the browser only reads names and sizes) and matches each folder to a
synced Garmin session (`src/garmin/catalystVideos.ts`):

- Same track name, same car (the session's make and model appear in the folder's
  car name), and the session starts between 3 minutes before and 30 minutes
  after the folder clock (in practice 8 s to 19 minutes after: the folder is
  created when the session is started on the device, the Garmin session when
  timing starts). Closest pairs win, and each session takes one folder.
- **Sync.** Garmin's lap times count from the folder clock (when the session
  was started on the device), but `video_1.mp4` starts at Garmin's session
  start, about 0.4 s late. So the video sits at
  `session start − folder clock + 0.4 s` on the lap clock; `video_N` follows
  the earlier parts. Neither the MP4 (video and audio tracks only, no
  creation time or data track) nor the synced telemetry
  (`start_time_utc_s` is the session start) records the folder clock, so the
  folder name is the link. Checked by matching the video's rotation (the
  horizon's sideways shift) against Garmin's turn rate (lateral g ÷ speed) on
  four sessions from 2025 and 2026: correlation 0.95–0.98, within 0.1–0.6 s
  of the rule. A video attached by hand to a session whose start does not fit
  the folder clock is placed at that session's start, with a note. The sync
  can be nudged on the Import page. Videos imported by earlier versions (at
  offset 0) are re-synced on startup, keeping any nudge.
- Recordings without a synced session are listed with the reason but cannot
  be chosen; sync that day, then choose the folder again.

The picker lists one row per day (date, layouts, number of sessions, size,
and what is new or already imported) with a checkbox for the whole day; open
a day to choose its sessions one by one. Every new matched session starts
selected, and the button shows the total before anything uploads. Garmin's
`optimal_lap_video.mp4` files are not offered: Session Review builds the
optimal lap from the session's own video instead (below).

Files go up one at a time through the same chunked upload as PDR videos,
carrying their device path
(`DRIVER/Track/Car/date/time/file`), which is stored as `source_path` with
`source` = `catalyst` or `catalyst-optimal`. The same path and size are never
stored twice, and choosing the folder again shows what is already imported.
Catalyst videos have no car channels: Session Review and Analysis show the
player and Garmin GPS speed, and the throttle/brake/gear/steering charts appear
only for laps with a PDR video (preferred when both cover a lap).

**The optimal lap** (Session Review's lap list, "◆ Optimal") is cut from the
session's video the way Garmin builds its own: each of Garmin's segments
(tiled end to end, as for the splits) from the valid lap that went through it
fastest, with the lap time being their sum. The player seeks from one lap to
the next at each cut, and the charts and elapsed time run on across the
joins (`stitchOptimalLap` in `src/renderer/components/carData.ts`). It needs
two valid laps in one video. On a wet 2026-09-22 session it came to 2:12.9
from laps of 2:21.6 and 2:22.9; Garmin's own optimal-lap render for that
session runs 2:11.3.

Upload speed is limited by MacDroid (about 20 MB/s) and by the path to the
server: through the Cloudflare domain, files travel over your internet
upload; through the Tailscale HTTPS URL on the same network, they usually go
directly over the LAN.

## CLI scripts (run individually without the GUI)

```bash
npm run fetch        # pull all sessions from Garmin
npm run load         # load downloaded JSON+protobuf into DuckDB
npm run corners      # detect corners on a meanline
npm run brief -- --last 5         # write the coaching prompt (system prompt, context, packet) as Markdown
npm run brief -- --last 5 --csv   # also write sessions, laps and per-complex phases as CSV
```

## Package

```bash
npm run package      # build + electron-builder, output to release/
```

## Data location

By default the app reads from `../garmin/data/` and `../garmin/config.json`
(sibling to the Python project) so the existing data set is reused.
Override with the `CATALYST_DATA_DIR` env var.

## AI Coach providers

Choose Anthropic or OpenAI in **Overview → AI Coach**, select a model, and add
the API key for that provider, then click **Save AI settings**. Keys are stored
only in DuckDB. Server logins share one `ai_provider_keys` table in
`<server-data-dir>/catalyst-app.duckdb`, accessed through the existing DuckDB
helpers by the server process. Provider/model preferences remain per driver.
The UI shows whether each key is configured without returning the saved secret;
replacing or removing a key affects all server logins. Desktop fallback uses
the same table in its existing workspace database.

On startup, legacy keys are imported from driver `garmin/config.json` files and
removed from those files after a successful database write. Existing database
values take precedence; otherwise the most recently modified config with a key
wins per provider. Back up the entire server data directory, including the root
database, to preserve these shared keys.

Anthropic offers Fable 5.1 (`claude-fable-5-1`), Opus 5.5 (`claude-opus-5-5`),
Sonnet 5.5 (`claude-sonnet-5-5`), Opus 5 (`claude-opus-5`), Sonnet 5
(`claude-sonnet-5`), and Haiku 4.5 (`claude-haiku-4-5-20251001`). Older saved
Opus/Sonnet 4 selections are upgraded to the 5.5 models.
OpenAI supports Astra (`gpt-6-astra`), Sol (`gpt-5.6-sol`), and Terra
(`gpt-5.6-terra`) through the Responses API.

Every model that has an effort setting runs at x-high. Anthropic models with
adaptive thinking get auto tool choice (Fable 5.1, Opus 5.5 and Sonnet 5.5
reject forced tool use), a strict report schema, summarized thinking in the
progress log, and one retry if they answer in prose instead of calling the
report tool. Output is capped at 100K tokens for Anthropic (thinking included)
and 64K for OpenAI; a run may take up to 30 minutes.

## How AI coaching works

Code computes every number; the model interprets. `src/garmin/coachPacket.ts`
builds a packet from valid laps only (Garmin-flagged and Session Review
exclusions are dropped), narrowed by the lap filter: Top 10, 5 or 3 overall,
Session bests, or Top 3 per session:

- **Corner complexes** run from one braking zone to the next. They are derived
  from the layout's fastest valid lap and saved with the layout in the shared
  track library, editable on the Tracks page. A complex stores only its
  boundaries (and any name you type); its corner list and default name come
  from the current corners, so renaming a turn updates the coach immediately.
  Saving corners re-derives complexes the app derived, but keeps ones you edited.
- **Track layouts** (named corners, segments, complexes) are shared by every
  driver: one layout per course (Garmin's track configuration ID), in the
  track library (`src/garmin/trackLibrary.ts`). On a server it lives in the
  server's `catalyst-app.duckdb` and user workers reach it over private
  process IPC; the desktop app keeps it in the workspace database. Each
  Catalyst device records its own mean line for a course, so a layout's
  positions are stored along the line it was drawn on and moved onto each
  driver's own line on read and back on save (`src/garmin/trackStore.ts`,
  `src/garmin/meanLineAlign.ts`). `tracks/*.yaml` files are seeds only: a
  course with no layout is imported from its YAML once; after that the YAML
  is never read or written for it. Layouts that workspaces kept before the
  library are copied in once (on the server's first start after upgrading):
  the one with the most corners wins a course, and edits made since are never
  replaced.
- **Phases per complex:** braking point, peak deceleration, brake release,
  minimum speed and where it happens, throttle pickup, coasting distance, and
  speed 100/200 m after the minimum (`src/garmin/lapPhases.ts`; braking and
  throttle are inferred from longitudinal g).
- **References:** fastest lap, ideal lap (plausible complex bests), all-time PB
  for the car and layout, and Garmin's optimal lap.
- **Evidence IDs** label every figure. The report schema only accepts those
  IDs, complex IDs, metric IDs and lap IDs, so the app can render numbers and
  reject invented ones.

The model returns one to three focus items, each tied to a metric. The app
turns them into targets (halfway to, or matching, the driver's best pass) and
checks them automatically on later sessions: on Session Review, on the
Overview dashboard, and in the next coaching prompt. Garage documents reach the
coach only when enabled under Garage → AI coach context (Car.md, driver/coach
notes and the current track guide by default; research sections are
stripped). Session notes (tires, pressures, setup, traffic) from Session Review
are included too.
