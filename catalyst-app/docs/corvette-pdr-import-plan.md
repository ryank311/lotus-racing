# Corvette PDR import plan

Status: proposal. Nothing is implemented yet. Phase 0 needs a real recording
from the car before any code is written.

## Goal

The 2023 C8 records Chevrolet Performance Data Recorder (PDR) files, always
alongside the Garmin Catalyst. Import those recordings into the workspace that
uploaded them, attach each one to its matching Catalyst session, and use them
in the app:

- **Pedals and steering.** Show measured throttle, brake and steering on the
  Analysis charts.
- **Better phase detection.** Use those measured channels to replace the
  g-based guesses for braking and throttle in lap phases and coaching.
- **Video.** Keep the in-car video permanently, processed with ffmpeg into
  per-session playback files, and play it in sync with the charts and the track
  map.
- **Car health and setup data.** Keep the extra channels (RPM, gear, wheel
  speeds, yaw rate, tyre pressure and temperature, fluid temperatures, ABS/TC/PTM
  activity) for setup and car-health analysis.

## Decisions

| Decision | Consequence |
| --- | --- |
| The Catalyst always runs when the PDR records. | Every recording must link to a Catalyst session. There are no PDR-only sessions. A recording with no match is a problem to resolve, never a new session. |
| The car is a 2023 C8. | It uses the Marlin format. The real file in gm_pdr_analyzer is also a 2023 C8, so its channel list is a good guide. AliveDrive (2026+) support is out of scope. |
| Imports come from a phone or a laptop. | The browser upload is the one import path. It must handle multi-GB files over Cloudflare and resume after dropped connections. |
| Videos are kept forever, and ffmpeg processing is preferred. | ffmpeg trims each recording to its sessions and transcodes the result for playback. The processed files are permanent. ffmpeg becomes a runtime dependency. |
| PDR data is workspace-scoped. | Files, tables, uploads and media all live in the uploading driver's workspace only. Nothing goes in the shared server root. |
| Not every car has a PDR (the Lotus doesn't). | Every PDR feature is optional. Without PDR data the app behaves exactly as it does today. |

## What a PDR recording is

Researched from the ExifTool `GM.pm` module and three open-source parsers:
[OpenPDR](https://github.com/rhizocode/OpenPDR) (MIT, TypeScript),
[gm_pdr_analyzer](https://github.com/a7v7/gm_pdr_analyzer) (which includes a real
2023 C8 export) and [pdr-telemetry](https://github.com/Mile-High-Ideas/pdr-telemetry).

**One file per recording.** Each recording is a single `PDR_NNNN.mp4`. Gen 2
cards appear to use a `DCIM/100PDRxx/` folder. There is no sidecar database or
CSV: the telemetry is a timed-metadata track inside the MP4, next to H.264
1080p30 video and AAC audio. Typical sizes:

- about 40 MB per minute
- one 22-minute session is roughly 1 GB
- one observed 43-minute file was 4 GB
- telemetry is 3–9% of the file

**Our car's format: Marlin** ("Cougar PDR 2.0", used on 2020–2025 C8s). The
data track has `hdlr`=`ctbx` and sample entry `marl`, and `moov` sits before
`mdat`. The sample entry describes itself:

- **`mrlv` (metadata):** track name, date, time zone, and the start timestamp
  `tstm`.
- **`mrld` (channel dictionary):** 448-byte records giving id, name, units,
  multiplier, offset and interval.

Samples are runs of 16-byte big-endian records: channel, i32 raw value, and u64
time in 100 ns ticks. Logging is change-driven, so channels are sparse and have
different rates.

The newer **AliveDrive** format (2026+ cars) uses `adrv`/`adco` and differs
completely. The parser's format registry rejects it with a clear message.

**Channels on the real 2023 C8 file.** There are 67 channels at these nominal
rates. Observed rates are lower because logging is change-driven.

| Group | Channels | Nominal rate |
| --- | --- | --- |
| Driver inputs | Accelerator %, Brake Pos % (pedal position, not pressure), Steering Angle | 100 Hz for brake and steering, 50 Hz for throttle |
| Engine and gearbox | RPM, Gear (codes 13/14/15 = N/R/P) | 100 Hz for RPM, 4 Hz for gear |
| Car speeds and motion | Speed, four wheel speeds, yaw rate, lateral, longitudinal and vertical g | 100 Hz for wheels and yaw, 50 Hz for accelerometers, 10 Hz for speed |
| Tyres | LF/RF/LR/RR pressure and temperature | 1–2 Hz |
| Fluids and engine | Coolant, oil and transmission temperature, oil pressure, boost, intake air temperature | 1–2 Hz |
| Stability and modes | ABS, TC, stability control, PTM mode, drive mode | not stated |
| GPS | Position | 10 Hz |
| Laps | Beacon (lap counter that steps at the start/finish line) | not stated |

**Decoding warning.** Decode values with the channel dictionary
(value = raw × multiplier + offset, then convert units). Do not use hard-coded
channel IDs, because one existing tool mislabels channels.

**RPM factor.** Existing tools multiply RPM by an "arbitrary ×10". The
dictionary units imply ×60/2π (≈9.55) instead. On a real C8 file, ×10 gives a
6,703 rpm peak and ×9.55 gives 6,400 rpm. Phase 0 checks which is right
against the car's limiter.

**The overlay is burned into the video pixels.** On 2020–2025 cars, the overlay
the driver picks (None/Sport/Track/Timing) is drawn into the video itself. The
telemetry track is recorded whatever overlay is chosen.

**Cosworth tools don't help with import.** Cosworth Toolbox has no usable CSV
export, so the plan is to parse the MP4 directly. Reading the telemetry needs
no ffmpeg: reading the MP4 atoms in Node is enough. ffmpeg is used only for
video processing.

**Remuxing destroys the data.** Remuxing to `.mp4` with ffmpeg drops the data
track. Telemetry must be extracted from the original upload before any video
processing.

## How it fits the current app

These constraints in the existing code shape the design:

- **Reloads drop the main tables.** `loadAll()` (`src/garmin/loadToDb.ts`) drops
  and rebuilds `sessions`, `laps` and `samples` from `garmin/data/sessions/`.
  PDR data must live in separate tables and files that a reload doesn't touch.
  It must also be re-derived onto the rebuilt Catalyst laps afterwards.
- **Samples are indexed by distance.** Every Catalyst sample is a metre along
  the layout's mean line (`distance_m`, `lateral_position`). Charts, the map,
  complexes and coaching all join on that distance. PDR channels should be
  resampled onto the same grid.
- **Pedal phases are guessed today.** `lapPhases.ts` infers braking and throttle
  from smoothed longitudinal g ("Catalyst has no pedal channels").
  `coachPacket.ts` tells the model the same. Measured channels can replace both
  where they exist, and the inference must remain for every other lap.
- **The server can't take big files or stream video.** It handles JSON RPC only,
  with a 25 MB request body limit (`server.ts`), and `staticAssets.ts` has no
  HTTP Range support. Cloudflare's proxy caps each request body at 100 MB on the
  Free plan. Multi-GB uploads need resumable chunks, and video needs a
  Range-capable media endpoint.
- **Workspaces are already isolated.** Each driver name gets its own instance
  directory (`CATALYST_INSTANCE_DIR`), worker process and DuckDB file. `paths.ts`
  derives every data path from it. The only shared state is the root
  `ai_provider_keys` database, and PDR data must not go there.
- **Database writes are serialized.** Writes go through `reviews.foreground()`,
  and progress uses `WorkerEvent` broadcasts. A PDR import should be one more
  job of that kind.
- **Charts share a hover distance.** Analysis already shares `hoverDistanceM`
  across charts and the track map. Video sync can drive, and be driven by, that
  same cursor.
- **UTC start time isn't stored yet.** Catalyst stores session start as local
  wall-clock time. `performance.pb` has `start_time_utc_s` and
  `utc_to_local_offset_s`, which are decoded but not saved, so we need to keep
  them.

## Design

### 1. Workspace scoping

All PDR state belongs to the workspace that uploaded it:

- **Files.** Everything lives under that workspace's `DATA_DIR`:
  - `pdr/` for videos
  - `uploads/` for partial uploads

  Both paths are derived from `paths.ts` like the existing ones.
- **Tables.** All PDR tables live in the workspace's own DuckDB.
- **Upload endpoints.** These run in the parent server process. They resolve the
  target directory only from the signed session cookie, via
  `userDirectory(dataDir, username)`. They never take a path or username from the
  request.
- **Media endpoint.** It serves a file only after the cookie's workspace worker
  confirms the recording ID through an RPC. The path comes from that workspace's
  `pdr_recordings` row, never from the URL. A recording ID from another workspace
  returns 404.
- **Linking.** A recording can only link to Catalyst sessions in the same
  workspace.
- **Desktop.** The desktop app reaches the same server as a client, so it gets
  the same scoping.

### 2. Parser module: `src/pdr/`

- **Reads byte ranges, never whole files.** The parser is written against a
  `ByteSource` interface, `read(offset, length) → Uint8Array`. Node uses a file
  handle and the browser uses `File.slice()`. One module then runs on the server
  for imports and in the browser for a pre-upload scan.
- **Reads only what it needs.** It parses `moov`, finds the data track, and walks
  its `stsz`/`stco`/`co64` tables. It reads only the telemetry samples, a few
  percent of the file.
- **Files:**
  - `detect.ts`: format registry; accepts Marlin and rejects anything else with a
    clear message
  - `marlin.ts`: dictionary, metadata and record decoder
  - `channels.ts`: maps names to canonical keys and canonical units
  - `video.ts`: video track codec, size, fps, duration, edit-list offsets
- **Port from OpenPDR, keep raw records.** Port the decoders from OpenPDR (MIT;
  keep its notice in `THIRD-PARTY-NOTICES`). Port the record decoder only, not
  its 10 Hz carry-forward resampler: we want every record at its true rate and
  timestamp.
- **Output.**
  - Recording metadata: format version, `tstm` start in UTC, local date/time and
    zone, track name, software version, duration.
  - The channel dictionary.
  - Raw records `(channel_id, t_100ns, raw_i32)`.
  - Video track facts.
  - The start offset between the video and data tracks.
- **Canonical units match the app:** m/s, metres, g, °C, kPa, degrees, 0–1
  fractions for pedals.

### 3. Storage

Videos stay on disk; DuckDB holds the metadata and telemetry.

**Files** (workspace `DATA_DIR`; in dev this is `garmin/data/`, which is
gitignored):

```
pdr/<recording_id>/
  telemetry.parquet            # raw records + dictionary, self-contained copy
  session-<session_guid>.mp4   # permanent playback video, one per linked session
  poster-<session_guid>.jpg
uploads/<upload_id>.part       # in-progress uploads, removed after import
```

`recording_id` is the SHA-256 of the original `moov` box, which includes the
start timestamp and sample tables. It is cheap to compute, unique per
recording, and makes re-uploads idempotent.

**Tables**, created in `initSchema` and **not** dropped by `loadAll`:

| Table | Contents |
| --- | --- |
| `pdr_recordings` | One row per recording: id, original file name and size, format version, parser version, start time (UTC and local), track name, software version, duration, original video facts, status (`uploaded`/`parsed`/`linked`/`needs_review`/`processing_video`/`ready`/`failed`), error, import time. |
| `pdr_channels` | The recording's dictionary: id, name, units, multiplier, offset, nominal interval, canonical key and unit. |
| `pdr_samples_raw` | Long format `(recording_id, channel_id, t_100ns BIGINT, raw INTEGER)`. This is the source of truth for telemetry. A view applies multiplier, offset and unit conversion, so a conversion fix (such as the RPM factor) never needs the original MP4. A 22-minute session is about 1–2 M rows. `telemetry.parquet` holds the same data so each recording folder can rebuild its rows if the database is lost. |
| `pdr_laps` | The recording's own laps, from Beacon increments: index, start t, duration. Used as a cross-check against Catalyst laps. |
| `pdr_links` | `(recording_id, session_guid)` primary key, method (`auto`/`manual`), `offset_ms` (Catalyst session time = PDR time + offset), `drift_ppm`, alignment score, median GPS residual. A recording can span several Catalyst sessions, and a session can have several recordings if the PDR was restarted. |
| `pdr_videos` | One row per processed playback file: recording id, session guid, relative path, resolution, bitrate, duration, `start_pdr_ms` (where the file starts on the PDR clock), poster path, bytes, processing settings. |
| `pdr_lap_samples` | **Derived cache** on the Catalyst grid `(session_guid, lap_index, distance_m)`: throttle, brake, steering, rpm, gear, car speed, wheel speeds ×4, yaw rate, ABS/TC/stability flags, PTM/drive mode, tyre pressure/temperature ×4, coolant/oil/transmission temperature, plus `video_ms` (the playback file position for that metre). It is rebuilt whenever a link or video changes, or when `loadSession()` reloads the Catalyst session. |

Also add `sessions.start_utc_ms`, filled from `performance.pb`, so that matching
works in UTC. Add a startup re-derivation hook, like the review tables have.

**Startup recovery.** If `pdr_samples_raw` is empty for a recording but its
`telemetry.parquet` exists, reload the rows from the file. This covers restoring
a workspace from a file backup.

### 4. Upload (phone and laptop)

The **Import PDR** action on Sessions works the same in the browser, on a phone
and in the desktop app:

1. **Pick files.** Accept files or a whole SD-card folder
   (`<input webkitdirectory>`, where the browser supports it), plus drag-and-drop
   on desktop. On a phone, the user picks files from Files or Photos after
   copying them from the card.
2. **Scan before uploading.** The shared parser reads each file's `moov` and
   data track in the browser and lists:
   - recording date, track name and duration
   - whether it's already imported (`recording_id` is checked against the
     workspace)
   - the Catalyst session it matches

   Recordings without a Catalyst match in this workspace are flagged before
   upload, which catches a wrong workspace or an unsynced Catalyst. Unwanted
   files can be deselected before any big transfer starts.
3. **Upload in resumable chunks.** The parent server process handles these new
   endpoints. They are authenticated by the existing cookie and write straight
   into that workspace's `uploads/` folder, so no bytes pass through worker IPC:

   | Endpoint | Purpose |
   | --- | --- |
   | `POST /api/uploads` | Takes `{name, size, recordingId}` and returns `{uploadId, receivedBytes}`. It resumes an existing partial upload. |
   | `PUT /api/uploads/:id` | Takes 8 MB chunks with `Content-Range`. The offset is validated, the size is capped, and free disk space is checked first. |
   | `POST /api/uploads/:id/finish` | Checks the size, then calls the worker RPC `pdr:import` with the upload ID. |

   Stale partial uploads are cleaned up after 7 days.

   The client uploads one file at a time and keeps going while the screen stays
   on. It shows per-file progress and resumes automatically when the page
   reopens. The `recordingId` from step 2 identifies the upload.

### 5. Import job (worker, `WorkerKind` `'pdr'`)

The job runs inside `reviews.foreground()` and reports progress over the
existing events:

1. **Parse and insert.** Parse the upload. Write the recording, dictionary, raw
   samples and Beacon laps in one transaction, then write `telemetry.parquet`.
   On failure, mark the recording `failed` and keep the upload so the user can
   retry.
2. **Match** (§6). On success, mark the recording `linked`, derive
   `pdr_lap_samples` and call `markReviewDirty()` for each linked session.
   Otherwise mark it `needs_review` and stop until the user resolves it.
3. **Queue video processing** (§7) for each link.
4. **Delete the original upload** once every linked session has a verified
   playback file. Telemetry already lives in the database and in
   `telemetry.parquet`. A workspace setting **Also keep original PDR files**
   (default off) keeps the untouched MP4 in `pdr/<recording_id>/original.mp4`
   instead.

`loadAll()` and `loadSession()` gain one step: after a Catalyst session's samples
are written, rebuild `pdr_lap_samples` for its links. That way a telemetry
reload keeps the PDR data.

### 6. Matching and time alignment

Every recording must end up linked. There is no unlinked state that the app
treats as usable data.

1. **Find candidates.** Look for Catalyst sessions in this workspace whose UTC
   window overlaps the recording's window. The Catalyst session ends at its last
   lap's start plus duration. No car-specific filter is needed: time overlap plus
   the GPS check is enough.
2. **Coarse offset.** Take the start-time difference. Phase 0 must verify that
   `tstm` is UTC and not local time.
3. **Fine offset.** Resample Catalyst `gnss_speed_mps` and PDR speed to 20 Hz.
   Cross-correlate within ±120 s of the coarse offset, then refine to about 10 ms
   with parabolic interpolation.
4. **Check for drift.** Align the first and last five minutes separately. If they
   disagree by more than 50 ms, fit offset plus linear drift.
5. **Validate.** Compute the median distance between Catalyst and PDR GPS at the
   matched times.
   - **Auto-link** when exactly one candidate scores well, for example
     correlation ≥ 0.95 and median GPS residual ≤ 3 m.
   - **Needs review** otherwise. The import dialog shows both speed traces
     overlaid, a session picker and a ±ms nudge.
   - **No candidate at all.** Ask the user to sync the Catalyst first, or to check
     they're in the right workspace. Offer **Retry matching** and **Delete
     upload**.
6. **Map onto Catalyst laps.** For each Catalyst sample `(lap, distance_m,
   time_ms)`, interpolate each PDR channel at the corresponding PDR time:
   - Continuous channels: linear interpolation.
   - Discrete channels (gear, flags, modes): sample-and-hold.
   - Each channel's own rate is respected, and gaps longer than about 3× its
     interval are left `NULL`.

   Once the playback file exists, compute `video_ms`.

Catalyst stays in charge of laps, distance, the line and validity. PDR adds
channels. The PDR Beacon lap times act as a cross-check: they should agree with
Catalyst lap times to within about 50 ms.

### 7. Video processing (ffmpeg)

The original recording usually includes paddock, grid and cool-down footage.
ffmpeg turns it into one permanent file per linked session:

- **Trim.** Keep from 60 s before the session's first lap to 60 s after its last
  lap ends. Use the PDR clock and link offset; frame-accurate trimming re-encodes
  anyway.
- **Transcode.** Default to H.264 High, 1080p, CRF 23, `-preset veryfast`, with
  AAC 128 kb/s audio. Use `-movflags +faststart` so browsers can seek over HTTP.
  This keeps the burned-in overlay readable at roughly 300–500 MB per 22-minute
  session, versus about 900 MB for the original.
  - A workspace setting can choose 720p (about 150–250 MB) to save space.
  - A 720p "mobile" rendition for phones over Cloudflare is optional and can be
    added later if 1080p stutters.
- **Poster.** Take one JPEG from the first lap for lists and the player.
- **Verify.** Run `ffprobe` on the output: duration within 0.5 s of expected,
  video stream present. Record the output's actual start on the PDR clock in
  `pdr_videos.start_pdr_ms`, from the trim point and the first decoded frame's
  timestamp. Then derive `pdr_lap_samples.video_ms`.
- **Queue.** Run one job at a time per server, at low CPU priority (`nice`), in a
  separate child process so a long transcode never blocks the workspace's
  database. The DS920+ (Celeron J4125) should transcode at or near real time with
  x264 `veryfast`. Intel Quick Sync (`h264_qsv`, with `/dev/dri` mapped into the
  container) is an optional speed-up for later. Progress shows in the import
  dialog. An interrupted job restarts from the original upload, which is kept
  until processing succeeds.
- **Re-processing.** Changing the link (manual relink or nudge) re-runs the trim
  only if the session window moved by more than the 60 s padding. Otherwise only
  `video_ms` is recomputed.

**Runtime dependency.**

- **Docker:** add `ffmpeg` (Debian package) to the runtime image, and check
  `ffmpeg -version` in the existing build-time sanity step.
- **Desktop and dev:** use the system `ffmpeg`, with a `CATALYST_FFMPEG_PATH`
  override. The packaged Electron app can bundle `ffmpeg-static`. Check its GPL
  licence terms before shipping.
- **Without ffmpeg:** importing still parses and links telemetry, and the
  recording stays `processing_video` with a visible "ffmpeg not found" message.

**Retention.** Playback videos and telemetry are kept forever. There is no
automatic deletion. The Account page shows storage use per car, and the backup
note in `deploy/README.md` must mention that the data directory now grows by
about 2–4 GB per track weekend.

### 8. Using the data, with PDR optional everywhere

The Lotus has no PDR, and Corvette sessions imported before this feature won't
have it either. These rules apply everywhere:

- **Presence is per lap.** A lap has PDR data when `pdr_lap_samples` has rows for
  it. The Analysis payload gains `pdr: { laps: string[], hasVideo: string[] }`
  plus optional per-lap arrays. Laps without PDR data simply omit the arrays.
  Absent never means zero.
- **No PDR in the selection.** The Analysis payload, charts, Session Review and
  coaching packet are byte-for-byte what they are today. A regression test pins
  this using a Lotus-style fixture.
- **Mixed selections.** For example, Corvette laps before and after PDR import,
  or several cars. PDR cards show the PDR laps and list the rest as "no PDR data"
  rather than drawing flat lines. Comparisons of measured metrics only compare
  laps where they're measured.
- **No PDR tables yet.** Queries use the existing `hasTable()` pattern so an older
  database keeps working.
- **Navigation.** The Import PDR action is always visible, since a workspace may
  have both cars. PDR controls (video view, PDR chart cards) appear only when the
  current data has PDR data.

**Analysis charts**, shown only when a selected lap has PDR data:

- **THROTTLE / BRAKE:** both as 0–100% on one card.
- **STEERING:** steering angle.
- **RPM / GEAR:** RPM with gear changes marked.
- **Intervention strip:** shaded bands where ABS, TC or stability control was
  active.

These charts use the same distance axis, lap colours and hover cursor as the
rest.

**Video panel** on Analysis (a third view, `view=video`, next to Charts and Map,
offered only when a selected lap has video) and on Session Review:

- **Seeking.** Picking a lap seeks to its start. While the video is paused,
  hovering a chart seeks to that metre (debounced).
- **Cursor sync.** While it plays, `requestVideoFrameCallback` converts video
  time to session time, then to lap and distance, and drives `hoverDistanceM`.
  The chart cursor and map dot follow the video.
- **Media endpoint.** A new `GET`/`HEAD /api/media/pdr/:recordingId/:sessionGuid`
  handles `Range` (206/416), `Accept-Ranges` and `video/mp4`. It is scoped as in
  §1 and streamed from disk by the parent process.

**Measured lap phases** (`lapPhases.ts`): `LapSeries` gains optional `throttle`,
`brake` and `steer` arrays.

- **Measured thresholds, with fallback.** When present:
  - braking onset is brake > 5% and release is < 2%
  - throttle pickup is sustained accelerator > 10%
  - coasting is both pedals below threshold

  Tune these thresholds in Phase 0. When the arrays are absent, the existing
  g-based inference runs unchanged. Each phase records its source
  (`measured`/`inferred`).
- **New per-complex metrics** (PDR laps only; `not_measured` otherwise):
  - trail-brake distance (brake > 5% while |steering| > 10°)
  - brake ramp time to peak
  - peak pedal %
  - time to full throttle
  - full-throttle share per segment
  - steering corrections (sign changes in steering rate mid-corner)
  - ABS/TC events
- **Understeer index:** measured steering angle minus the angle the car would need
  for that speed and lateral g (from the 2,723 mm wheelbase and the steering
  ratio, calibrated from straight-line and low-speed data). It is reported per
  corner. This directly targets the understeer at Turn 1 and Oak Tree noted in
  `Vette/Car.md`.
- **Session-level data:**
  - hot tyre pressures and temperatures per lap
  - coolant, oil and transmission temperature trends (DCT heat on long sessions)
  - drive mode and PTM setting

  Pressures can pre-fill the Session Review notes.

**Coaching** (`coachPacket.ts`):

- **Pedal wording.** The "inferred from longitudinal g (no pedal sensors)"
  sentence stays for laps without PDR. When the packet includes PDR laps, each
  phase metric is labelled measured or inferred, and mixed packets say which laps
  are which.
- **New evidence and focus metrics.** Add the new metrics as evidence IDs and
  focus metrics, for example `C6.trail_brake`, `C6.understeer`,
  `C6.full_throttle`. They are offered to the model only when the packet has PDR
  laps. Focus checks on later sessions without PDR report `not_measured`, using
  the existing verdict.
- **Setup context.** When available, give the setup-recommendation section the
  understeer index, hot pressures and temperatures. Today it reasons only from
  speed and g.

**Sessions list:** add a PDR badge (video and pedals) on linked sessions only,
and a "needs review" count on the Import action.

## Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Samples and spike** | Copy 2–3 recordings from the 2023 car: a short test drive, plus a VIR session that also has a Catalyst recording. Confirm: Marlin format and channel list; whether `tstm` is UTC; whether Catalyst sample `time_ms` counts from session start; the video/data start offset (check burned-in overlay speed against telemetry at a frame); the RPM factor; pedal thresholds; behaviour at 4 GB, 30+ minute and restarted recordings; x264 transcode speed on the NAS. | Notes added to this doc; open questions below answered. |
| **1. Parse, store, link** | `src/pdr/` parser, schema, `pdr:import` RPC (fed by a dev-only local path), matching and alignment, `pdr_lap_samples`, `telemetry.parquet`, the `loadAll` hook, workspace scoping tests. | A real recording imports, auto-links to the right session with error below 100 ms (checked against Beacon laps), and survives a full reload. A Lotus-only workspace is unchanged. |
| **2. Upload UI** | Browser pre-scan, resumable chunked upload endpoints, import dialog with status, needs-review matching UI, Sessions badge. | 1 GB file uploads from a phone through Cloudflare, resumes after a dropped connection, and lands only in the uploading workspace. |
| **3. Channels in Analysis** | Throttle/brake, steering, RPM/gear charts, intervention strip, measured lap phases with fallback, optional-data handling. | Corner phases on a PDR lap come from pedals. Lotus and older Corvette laps are unchanged, and mixed selections render correctly. |
| **4. Video** | ffmpeg processing queue, Docker/desktop dependency, Range media endpoint, video panel on Analysis and Session Review, two-way cursor sync, storage view. | A session's playback file is created automatically after import. Hovering a braking zone shows that moment on video within one frame on desktop, and seeking works on a phone. |
| **5. Coaching** | New metrics, understeer index, tyre and fluid data in the packet, focus tracking, measured/inferred labels. | A coaching report on a PDR session cites measured pedal metrics. A Lotus report is unchanged. |
| **6. Extras** | Side-by-side two-lap video synced by distance, per-lap clip export, a 720p mobile rendition, Quick Sync encoding. | As needed. |

## Testing

Follow the existing `node --test tests/*.test.cjs` pattern.

- **Parser.**
  - A tiny synthetic MP4 fixture generator writes a `moov` with a `marl` data
    track. It covers:
    - full and diff records
    - the "time not valid" sentinel
    - dictionary conversion, including RPM
    - unit conversion
    - rejection of non-Marlin files
  - Assert that the bytes read are a small fraction of the file size.
  - A real recording stays local and gitignored for an opt-in test, because
    trimming with ffmpeg loses the data track.
- **Alignment.** Recover a known synthetic offset and drift. Reject a
  wrong-session candidate. No candidate gives `needs_review`, never a new
  session.
- **Storage.** A reload preserves links and rebuilds `pdr_lap_samples`.
  Re-uploading is idempotent. Parquet recovery restores missing rows.
- **Workspace scoping.** Uploads land under the cookie user's directory only.
  Workspace B gets 404 for workspace A's recording ID. Links never cross
  workspaces.
- **Server.** Upload resume, `Content-Range` validation, size and disk limits.
  The media endpoint handles 200/206/416/HEAD.
- **Video.** Generate a few-second test clip with ffmpeg's `testsrc`. Trim and
  transcode it, check the `ffprobe` verification, the `start_pdr_ms` arithmetic,
  and the missing-ffmpeg path.
- **Optional data.** The Analysis payload, phases and coach packet are identical
  for a no-PDR fixture before and after the change. Mixed selections produce PDR
  arrays only for PDR laps. Measured phases are used when pedals exist and fall
  back otherwise.

## Risks and open questions

- **Format variance.** Format details come from community reverse engineering.
  The real 2023 C8 file in gm_pdr_analyzer lowers the risk for our car, but
  Phase 0 still decides, and the parser must reject unknown versions clearly.
- **Disk space.** Permanent 1080p playback files are about 2–4 GB per track
  weekend, about 4–8 GB with "keep originals". That is fine on the NAS, but
  backups grow.
- **Privacy.** Video includes cabin audio and exact GPS. The server has no
  passwords and relies on Tailscale or Cloudflare Access. Media must never be
  served without the session cookie. Workspace scoping (§1) keeps each driver's
  recordings private from other workspaces.
- **Phone uploads.** Uploading a 1 GB file from a phone needs the screen on and a
  reasonable connection. Resumable chunks make interruptions cheap, but a
  weekend's worth on cellular is slow. Uploading from the laptop on home Wi-Fi is
  the comfortable path.
- **Transcode time.** If the NAS can't keep up (Phase 0 measures it), use Quick
  Sync or 720p output. Telemetry is usable while video is still processing.
- **Still open:**
  - Which overlay mode do you record in? If it's None, a later phase could draw
    our own overlay on clean video.
  - Should the default playback resolution be 1080p (proposed) or 720p?
