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
ffmpeg; a 3 GB video costs a few MB of reads).

The track's sample description (`stsd` → `marl` → `mrld`) also holds the
PDR's own table of its channels: one 448-byte entry per channel with its
number, name, unit, logging period, and the scale and offset to SI units
(the table Cosworth Toolbox reads). A C8 Z51 lists 66 channels. Each video is
decoded with its own table; `shared/pdr.ts` names the ones the app uses
(`PDR_CHANNELS`, by the PDR's name) and keeps the C8's table for videos
stored before the table was read. Decoded: speed, engine RPM, throttle and
brake pedal (%), gear, steering angle, the four wheel speeds, lateral and
longitudinal G, GPS position/heading/altitude, odometer, the PDR's lap
counter, the four **tyre pressures and temperatures** (the TPMS sensors:
4 kPa and 1 °C steps, 1 s), engine oil, coolant, transmission oil, intake and
outside air temperatures, oil pressure, fuel level, battery voltage and the
ABS/traction/stability flags. The rest (clutch, boost, the PDR's CPU and SD
card) stays raw.

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
- `pdr_channels` — the video's channel table, as the PDR wrote it.
- `pdr_lap_samples` — the known channels on each lap's 1 m Garmin samples,
  with the video time at each metre (tyres and fluids included). Re-computed
  when the sync is nudged or the session's laps are reloaded.
- `pdr_lap_stats` — tyres, fluids, fuel and battery over each lap: first,
  last, lowest and highest.

`session_videos.decode_version` records how a video's lap data was decoded.
When decoding changes, raise `DECODE_VERSION` in `videoStore.ts`: on its next
start each workspace recomputes older videos from `pdr_records` in the
background (`redecodeVideos`), reading a missing channel table from the video
file. Nothing is re-uploaded.

Where it shows up:

- **Analysis** adds throttle, brake, gear/RPM, steering and rear-wheel slip
  (rears vs fronts, against a no-slip baseline taken from the session)
  charts for laps a video covers, then tyre pressure and tyre temperature
  (one tyre at a time) and fluids (oil, coolant, transmission temperature,
  oil pressure), and the lap video player (below). Each tyre and fluid chart,
  and each choice on it, appears only when a video logged it.
- **Session Review** shows the lap video player beside speed, the time gap
  and (with a PDR video) throttle, brake, gear and steering for the lap
  against a reference, and a table of driver inputs per corner: where braking
  starts, peak brake, coasting time, throttle pickup, lowest gear and
  steering. **Tyres and fluids by lap** charts each tyre's pressure and
  temperature and the hottest fluids across the laps, with a table of them
  at the end of each lap (and as the first lap started); clicking a lap plays
  it.
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

## 3D replay: track, terrain and car models

The Replay page drives a lap over real ground. Its data comes from three
places; all of it is built on the server and shared where it can be.

**The scene and the laps** come from the driver's own workspace (RPC
`replay:scene` and `replay:lap`, `src/garmin/replayData.ts`). The track is the
session's Garmin mean line (one point a metre), its width, the course's
corners from the shared track library, Garmin's primary sectors, and the area
to load terrain for: every mean line of that facility in the workspace (so
Full, Grand West and North share one terrain) plus 400 m. Ghost candidates
are the driver's 40 fastest valid laps from other sessions on the same
course, matched by Garmin's course ID. A lap comes back in time order with
GPS, speed, accelerations, GNSS altitude and heading; a lap measured along
another mean line (another device's, or one Garmin rebuilt) is moved onto
the scene's line (`meanLineAlign.ts`), and a lap a synced video covers carries
the same car data as Session Review. GNSS altitude is height above the WGS84
ellipsoid: at VIR it sits about 30 m below the terrain's heights, so place the
car on the terrain (`sampleTerrain`) and use altitude only for its shape.

**Terrain** (`src/garmin/terrain.ts`) is downloaded once per area from two
public-domain USGS services and kept for every driver:

- Elevation: [USGS 3D Elevation Program](https://www.usgs.gov/3d-elevation-program)
  bare-earth lidar, `3DEPElevation/ImageServer` (`exportImage`, float32
  GeoTIFF in WGS84).
- Imagery: [USDA NAIP](https://naip-usdaonline.hub.arcgis.com/) aerial photos
  via The National Map, `USGSNAIPPlus/ImageServer` (JPEG).
- Both are public domain; each build records their credit in
  `TerrainInfo.attribution` (“Elevation: USGS 3D Elevation Program (3DEP).
  Imagery: USDA NAIP via USGS The National Map. Public domain.”). The replay
  page does not show it.

An area is rounded outward to a 0.005° grid (at most 0.1° a side); the box is
the key (`t1_p36.545_m79.220_p36.575_m79.195`: south, west, north, east) and
exactly the area every product covers. Heights are fetched at about 1 m in
tiles of at most 1,500 px (USGS's gateway gives up on larger exports after
90 s), two at a time with retries, read by a small pure-JavaScript TIFF reader
(uncompressed float32 strips or tiles only), and resampled through each
tile's own GeoTIFF placement. The build keeps three products:

- `fine.f32`: heights at about 1 m, for `sampleTerrain` (the track surface);
- `grid.f32` / `grid.ctg.gz`: the renderer's mesh, at most 1,400 vertices on
  the long side; browsers get 16-bit steps between the lowest and highest
  point (a few millimetres), gzipped;
- `image.jpg`: the photo, at most 4,096 px on the long side (a phone's WebGL
  texture limit; NAIP serves up to 4,000), in one request so it never needs
  stitching. It is requested in exactly the area's proportions so the service
  keeps the box.

Both height grids are vertex grids: the first and last rows and columns lie
on the area's edges, so a mesh stretched edge to edge over the area puts each
height where it was measured. The photo's outer pixel edges are the area's
edges, the way a texture spans 0…1. VIR (Full Course area, 0.025° × 0.030°)
took 135 s to build from USGS: 2,786 × 3,343 heights in 6 tiles (39 MB
downloaded), a 937 × 1,400 mesh and a 3,330 × 3,996 photo (2.8 MB). Its heights
run 103–158 m.

Builds run one at a time and once per key; files land in a temporary folder
renamed into place. Downloaded tiles are kept until the build succeeds, so a
retry fetches only what failed. A failure is reported (with USGS's answer)
for a minute, then the next request tries again. Override the services with
`CATALYST_USGS_ELEVATION_URL` and `CATALYST_USGS_IMAGERY_URL` (each the
`…/ImageServer` URL; the tests point them at a local fake).

Server routes (signed in; Cloudflare cuts requests at about 100 s, so a build
never holds one open):

- `POST /api/terrain {area}`: 200 `{terrain}` when built, 202 while building
  (poll again), 502 with the error after a failed build;
- `GET /api/terrain/<key>/grid` and `/image.jpg`: cached for a year
  (`immutable`; the key changes with the build version);
- `POST /api/terrain/<key>/sample`: little-endian float64 `[lat, lon, …]` in,
  float32 heights out (NaN outside the area), at most 250,000 points a request.

**Car models** (`src/garmin/carModels.ts`) are `.glb` files (glTF 2 binary,
at most 300 MB) that drivers add in Garage → 3D models, shared by every
driver. Each has a name, a credit line, the vehicles that use it
(`LOTUS EXIGE`, from Garmin's make and model) and its fit in the car (set in
the replay; a new model starts from its vehicle's preset). Sketchfab writes the
title, author, licence and source into the file's `asset.extras`; an empty name
or credit is filled from them (“2006 Lotus Exige S” by Ddiaz Design
(CC-BY-NC-SA-4.0) · https://sketchfab.com/…). Uploads use the same 32 MB
chunks as videos; the server checks the glTF header and JSON chunk.

A `.glb` copied into the folder by hand is registered at startup and whenever
the library is listed: checked the same way, named and credited from its
`asset.extras`, matched to the vehicles whose model word its title names
(“Exige”, “Corvette”), and left where it is. On the Synology install that
folder is `/media/shared/car-models` in the container, which is
`/volume1/docker/catalyst-coach/media/shared/car-models` on the NAS (the
server creates it; the container runs as uid 1000):

```bash
sudo cp 2006_lotus_exige_s.glb /volume1/docker/catalyst-coach/media/shared/car-models/
sudo chown 1000:1000 /volume1/docker/catalyst-coach/media/shared/car-models/*.glb
```

Routes: `GET /api/car-models`; `POST /api/car-models/uploads`, then
`PUT …/uploads/<id>?offset=` and `POST …/uploads/<id>/finish`;
`GET /api/car-models/<id>.glb`; `PATCH` and `DELETE /api/car-models/<id>`.

**Track models** (`src/garmin/trackModels.ts`) are 3D tracks, such as a
converted Assetto Corsa track, that replace the generated road and terrain
when a session's facility and layout match. Each is a folder copied in by
hand (there is no upload) under `shared/track-models/<id>/`, holding its
`.glb` files and a `track.json`:

```json
{
  "name": "VIR (Assetto Corsa)",
  "trackName": "Virginia International Raceway",
  "attribution": "…credits, kept for the record (not shown in the replay)…",
  "layouts": {
    "Full Course": { "files": ["vir-base.glb", "vir-full.glb"] },
    "North Course": { "files": ["vir-base.glb", "vir-trackday.glb", "vir-north.glb"] }
  },
  "georef": { "originLat": 36.56196, "originLon": -79.20697, "rotationDeg": -1.099342,
              "scale": 1.002667, "offsetM": [-60.819, -3.546, 161.681], "flips": { "x": false, "z": false } },
  "footprint": { "file": "footprint.png", "x0": -820, "z0": -1204, "cellM": 4, "width": 420, "height": 605 },
  "drivablePattern": null
}
```

`trackName` and the layout keys match Garmin's facility and configuration
names (case and punctuation aside). The georef places glTF coordinates on
the earth: `world = offsetM + rotY(rotationDeg) · (scale · glb)` in the
equirectangular frame around the origin (x east, y metres above sea level,
z south), the same projection as the replay's own frame. glTF nodes whose
`extras` say `drivable: true` (roads, kerbs, pits) or `ground: true` (grass,
earth) are the surface the cars sit on; `drivablePattern` (a regular
expression on node names) can add more. The footprint is a PNG mask (255 =
the model has ground) in glTF x/z; the public lidar terrain and photo are
drawn around the model as far field and sunk under it inside the mask.

A folder is registered at startup and whenever the library is listed, once
its `track.json` parses and every file it names is present (`.glb` files are
checked to be glTF 2 binaries); a broken folder is logged once and retried
when it changes. The folder is only read. On the NAS:

```bash
sudo cp -r vir /volume1/docker/catalyst-coach/media/shared/track-models/
sudo chown -R 1000:1000 /volume1/docker/catalyst-coach/media/shared/track-models/vir
```

Routes: `GET /api/track-models` (each model with its files' versions) and
`GET /api/track-models/<id>/<file>`, only for files `track.json` names.
`.glb` files are served gzipped when the browser accepts it, from a copy made
on first use (registration starts it) in `track-models/.cache/<id>/`; with
`?v=<version>` the response is cached for a year (`immutable`), without it
the browser revalidates (`ETag`). Desktop: `<data dir>/track-models/`, over IPC.
Draco, meshopt and KTX2 compression are not supported (the renderer's CSP
blocks their WebAssembly decoders); `KHR_mesh_quantization` and WebP
textures are.

Models are third-party work under their own licences: never commit them, and
keep their credit lines. Terrain and models live with the media, not in the
database:

| | Server | Desktop (IPC) |
|---|---|---|
| Terrain | `<media dir or data dir>/shared/terrain/<key>/` | `<data dir>/terrain/<key>/` |
| Car models | `<media dir or data dir>/shared/car-models/` (`*.glb`, `models.json`) | `<data dir>/car-models/` |
| Track models | `<media dir or data dir>/shared/track-models/<id>/` (`*.glb`, `track.json`) | `<data dir>/track-models/<id>/` |

Both can be deleted at any time: terrain is downloaded again on the next
replay, and models must be added again.

## 3D replay: the page

**3D Replay** (sidebar, ⌘6) drives one lap on the track in three.js:
`/replay/<session>?lap=<index|optimal>&ghost=<session>:<lap|optimal>|none&view=chase|driver|garmin`.
Lap indices are the app's own (L3 is `lap=2`). Without a session it opens the
latest session with laps; without a lap, the session's best; without a ghost,
the best lap when you watch another (`ghost=none` turns it off). Session
Review links each lap and the video panel's lap here ("Watch in 3D").
three.js loads with this page only (lazy route).

What you see: the car on the road with the speed-coloured racing line, an
optional ghost (translucent cyan, its own line, and the live gap at the same
distance: red when behind), the lap timer, speed, a g-meter oriented like
Analysis's G-G chart (the force the driver feels: braking up, a right-hander
to the left; with a 1.5 s trail), and with a
PDR video gear, RPM, throttle, brake and steering. The onboard video plays
picture in picture at the 3D car's distance (`car.videoT`): while playing it
runs at the replay's rate and closes small drift by running up to 25 % fast
or slow, seeking only beyond 0.6 s; paused or scrubbed it seeks directly.
Space plays and pauses, ← → step a second (⇧ five), C cycles the cameras:
chase, the driver's seat, and the Garmin camera. Playback runs at 0.25–2×;
the scrub bar marks each corner's apex.

Drag the view to look around (mouse or one finger; the world follows the
pointer). From the driver's seat and the Garmin camera the head turns up to
±160° and tilts ±70°, relative to the car, so it stays turned through
corners. Chasing, the camera orbits the car (any direction, 5–80° above it)
and the wheel or a two-finger pinch sets its distance (3–40 m). A press
that moves under 5 px is a click, not a drag. Double-click (double-tap)
or **Reset view** goes back to the default camera; each camera keeps its
own offset when you switch. Drags start on the 3D view only (the HUD, the
scrub bar and the video are not part of it), never select text, and on a
phone the page still scrolls from outside the view.

**Track: Public data | Assetto Corsa** appears when a track model matches
the session's layout (see track models above): public data is the lidar,
the aerial photo and the road along Garmin's line; the model is drawn in its
place, with the lidar and photo as the far field around it. The car and
ghost sit on the model's surface wheel by wheel (kerbs too), and the racing
and ghost lines follow it. The choice is remembered in this browser; the
model's files stay in memory while the app is open, so switching back is
quick. If the model cannot be loaded the replay falls back to public data
with a note.

The **Garmin camera** matches what the Catalyst's windscreen camera records,
so the 3D view and the onboard video compare frame for frame: the camera sits
at the top centre of the screen (per car), tilted slightly up, and the scene
is drawn through a 120° lens with barrel distortion (`replay/lens.ts`: drawn
wider into a texture, then remapped between rectilinear and fisheye), framed
16:9 like the video. The Exige's mount was tuned against a Catalyst frame on
VIR's front straight (horizon 58% down, the clam's humps 21% from the bottom).

How the world is built (`src/renderer/replay/`, framework-free; the page is
`pages/Replay.tsx`):

- `geo.ts`: local metres around the track (x east, y up, z south). The height
  grid is a vertex grid over the terrain box; the photo's UVs are linear in
  lat/lon.
- `road.ts`, `edges.ts`, `roadMesh.ts`: stations every metre along the mean
  line. Garmin's mean line is the average driven line, not the middle of the
  tarmac, so each station's edges are found in the aerial photo: along the
  normal, the run of grey tarmac (as grey as the tarmac under the line, not
  much darker; dry grass is nearly as light but never as grey), smoothed
  over ±12 m, with ±width/2 where the photo is unclear. At VIR the tarmac is
  found on about half the lap; its centre sits a median 0.4 m from Garmin's
  line and up to 3 m. Heights across the road come from `sampleTerrain`
  (the 1 m lidar), a running median (drops spikes such as a bridge deck)
  and smoothing. Edge lines, kerbs on the inside of each corner's apex and
  a chequered start/finish line sit on top.
- `terrain.ts`: the 1,400 px grid as one vertex buffer drawn in culled tiles,
  the photo draped on it, pressed just under the road and its verges and
  eased back to the lidar over a few metres, a skirt down to a wide ground
  plane, sky and fog. `trees.ts` scatters low-poly trees where the photo is
  forest, at least 15 m off the tarmac.
- `lapPath.ts`, `engine.ts`: the lap by lap time, positions lightly smoothed,
  heading from the path over ±3 m. The car's height, pitch and roll come from
  the road surface under its four wheels. The chase camera follows the car's
  position exactly and eases only its heading and height; the driver's camera
  sits at the model's eye point looking 4° down at the road (FOV 70°, wider
  on a tall phone screen).
  Resolution adapts to hold 50–60 fps; the WebGL context is restored after
  a loss; everything is disposed when you leave.
- `car.ts`: the model for the session's car is the newest one whose matches
  include the vehicle key (or the one picked in the Car panel, remembered per
  car in this browser), else a low-poly car at the real dimensions. A model
  is centred, turned (yaw), scaled to its length and nudged (offset); the
  Car panel edits the fit live and saves it, including the Garmin camera's
  mount, tilt and lens (`dashcamM`, `dashcamPitchDeg`, `dashcamFovDeg`;
  absent, the car's preset). Glass is drawn as plain tinted transparency
  (transmission would render the scene twice). The car reflects a neutral
  studio environment (three's RoomEnvironment), not the sky, so paint reads
  true: silver stays silver, gloss black black.

Without terrain (offline, or USGS failed) the road follows the lap's GPS
altitude over flat ground, with a note. The first visit to a circuit waits
for the server's terrain build ("Building VIR terrain from USGS elevation
data…", about 2 minutes); later visits load in a second or two.

Debugging: in `vite` dev, or after `localStorage['catalyst:replay-debug'] = '1'`,
the timer shows the frame rate, O toggles an orbit camera, and
`window.replay` is the engine.

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
