# Corvette PDR import plan

Status: proposal. Nothing is implemented yet. Phase 0 needs a real recording
from the car before any code is written.

## Goal

The C8 records Chevrolet Performance Data Recorder (PDR) files alongside the
Garmin Catalyst. Import those recordings, attach each one to the matching
Catalyst session, and use them in the app:

- **Pedals and steering.** Show measured throttle, brake and steering on the
  Analysis charts.
- **Better phase detection.** Use those measured channels to replace the
  g-based guesses for braking and throttle in lap phases and coaching.
- **Video.** Play the in-car video in sync with the charts and the track map.
- **Car health and setup data.** Keep the extra channels (RPM, gear, wheel
  speeds, yaw rate, tyre pressure and temperature, fluid temperatures, ABS/TC/PTM
  activity) for setup and car-health analysis.

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

**Two formats.** The parser must tell them apart by reading the data track's
`hdlr`/`stsd` atoms:

| Format | Cars | Track | Notes |
| --- | --- | --- | --- |
| **Marlin** ("Cougar PDR 2.0") | C7, 2020–2025 C8 (**our 2021 car**), Camaro, Blackwings | `hdlr`=`ctbx`, sample entry `marl` | `moov` sits before `mdat`. The sample entry describes itself: `mrlv` holds metadata (track name, date, time zone, start timestamp `tstm`), and `mrld` is a channel dictionary of 448-byte records (id, name, units, multiplier, offset, interval). Samples are runs of 16-byte big-endian records (channel, i32 raw value, u64 time in 100 ns ticks). Logging is change-driven, so channels are sparse and have different rates. |
| **AliveDrive** ("PDR 2.5") | 2026+ Corvette, 2025+ CT5-V | `hdlr`=`adrv`, sample entry `adco` | `moov` is at the end. Data comes as fixed 1-second packets of 100 ms frames, with 59 named channels (`com.cosworth.channel.*`). It carries the VIN, lap events, and video with no overlay. |

**Marlin channels on a real C8.** The real C8 file has 67 channels at these
nominal rates (observed rates are lower because logging is change-driven):

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

**Cosworth tools don't help with import.** Cosworth Toolbox and AliveDrive
Desktop have no usable CSV export, so the plan is to parse the MP4 directly.
That needs no ffmpeg: reading the MP4 atoms in Node is enough.

**Remuxing destroys the data.** Remuxing to `.mp4` with ffmpeg drops the data
track. The original file must be stored untouched.

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
  `coachPacket.ts` tells the model the same. Measured channels can replace both.
- **The server can't take big files or stream video.** It handles JSON RPC only,
  with a 25 MB request body limit (`server.ts`), and `staticAssets.ts` has no
  HTTP Range support. Cloudflare's proxy caps each request body at 100 MB on the
  Free plan. Multi-GB uploads need resumable chunks, and video needs a
  Range-capable media endpoint.
- **Each driver gets an isolated worker.** Workspaces each have their own worker
  process and DuckDB. Database writes are serialized through
  `reviews.foreground()`, and progress uses `WorkerEvent` broadcasts. A PDR
  import should be one more job of that kind.
- **Charts share a hover distance.** Analysis already shares `hoverDistanceM`
  across charts and the track map. Video sync can drive, and be driven by, that
  same cursor.
- **UTC start time isn't stored yet.** Catalyst stores session start as local
  wall-clock time. `performance.pb` has `start_time_utc_s` and
  `utc_to_local_offset_s`, which are decoded but not saved, so we need to keep
  them.

## Design

### 1. Parser module: `src/pdr/`

- **Reads byte ranges, never whole files.** The parser is written against a
  `ByteSource` interface, `read(offset, length) → Uint8Array`. Node uses a file
  handle and the browser uses `File.slice()`. One module then runs on the server
  for imports and in the browser for a pre-upload scan.
- **Reads only what it needs.** It parses `moov`, finds the data track, and walks
  its `stsz`/`stco`/`co64` tables. It reads only the telemetry samples, a few
  percent of the file.
- **Files:**
  - `detect.ts`: format registry keyed by `hdlr`/sample entry
  - `marlin.ts`: dictionary, metadata and record decoder
  - `alivedrive.ts`: later
  - `channels.ts`: maps names to canonical keys and canonical units
  - `video.ts`: video track codec, size, fps, duration, edit-list offsets
- **Port from OpenPDR, keep raw records.** Port the decoders from OpenPDR (MIT;
  keep its notice in `THIRD-PARTY-NOTICES`). Port the record decoder only, not
  its 10 Hz carry-forward resampler: we want every record at its true rate and
  timestamp.
- **Output.**
  - Recording metadata: format, version, `tstm` start in UTC, local date/time
    and zone, track name, software version, duration.
  - The channel dictionary.
  - Raw records `(channel_id, t_100ns, raw_i32)`.
  - Video track facts.
  - The start offset between the video and data tracks.
- **Canonical units match the app:** m/s, metres, g, °C, kPa, degrees, 0–1
  fractions for pedals.

### 2. Storage

Videos stay on disk; DuckDB holds the metadata and telemetry. A 1–4 GB blob
does not belong in the database.

The file layout is
`<DATA_DIR>/pdr/<recording_id>/PDR_NNNN.mp4`, with the original bytes untouched.
Here `recording_id` is the SHA-256 of the `moov` box, which includes the start
timestamp and sample tables. It is cheap to compute, unique per recording, and
makes re-imports idempotent. In dev, `DATA_DIR` is `garmin/data/`, which is
already gitignored.

New tables, created in `initSchema` and **not** dropped by `loadAll`:

| Table | Contents |
| --- | --- |
| `pdr_recordings` | One row per recording: id, file path relative to `DATA_DIR`, bytes, format, format version, parser version, start time (UTC and local), track name, software version, duration, video facts, video retained, status, error, import time. |
| `pdr_channels` | The recording's dictionary: id, name, units, multiplier, offset, nominal interval, canonical key and unit. |
| `pdr_samples_raw` | Long format `(recording_id, channel_id, t_100ns BIGINT, raw INTEGER)`. This is the durable source of truth. A view applies multiplier, offset and unit conversion, so a conversion fix (such as the RPM factor) never needs the MP4 again. A 22-minute session is about 1–2 M rows, which DuckDB compresses well. |
| `pdr_laps` | The recording's own laps, from Beacon increments: index, start t, duration. |
| `pdr_links` | `(recording_id, session_guid)` primary key, method (`auto`/`manual`), `offset_ms` (Catalyst session time = PDR time + offset), `drift_ppm`, alignment score, median GPS residual. A recording can span several Catalyst sessions, and a session can have several recordings if the PDR was restarted. |
| `pdr_lap_samples` | **Derived cache** on the Catalyst grid `(session_guid, lap_index, distance_m)`: throttle, brake, steering, rpm, gear, car speed, wheel speeds ×4, yaw rate, ABS/TC/stability flags, PTM/drive mode, tyre pressure/temperature ×4, coolant/oil/transmission temperature, plus `video_ms` (the video position for that metre). It is rebuilt whenever a link changes or `loadSession()` reloads the Catalyst session. |

Also add `sessions.start_utc_ms`, filled from `performance.pb`, so that matching
works in UTC. Give the deletion and re-derivation hooks the same migration
treatment as the review tables.

### 3. Getting files in

**Browser and phone (and the desktop app, which is a client of the same
server):**

1. **Pick files.** Use an **Import PDR** action on Sessions. It accepts files or
   a whole SD-card folder (`<input webkitdirectory>`) and also supports
   drag-and-drop.
2. **Scan before uploading.** The shared parser reads each file's `moov` and
   lists:
   - recording date, track name and duration
   - whether it's already imported
   - the likely Catalyst session match

   The user deselects anything they don't want before any big transfer starts.
3. **Upload in resumable chunks.** The parent server process handles these new
   endpoints. They are authenticated by the existing cookie and write straight
   into the user's instance directory, so no bytes pass through worker IPC:

   | Endpoint | Purpose |
   | --- | --- |
   | `POST /api/uploads` | Takes `{name, size, recordingId}` and returns `{uploadId, receivedBytes}`. It resumes an existing partial upload. |
   | `PUT /api/uploads/:id` | Takes 8 MB chunks with `Content-Range`. The offset is validated, the size is capped, and free disk space is checked first. |
   | `POST /api/uploads/:id/finish` | Moves the file into the PDR folder and calls the worker RPC `pdr:import`. |

   Stale partial uploads are cleaned up after 7 days.

**NAS inbox** (best for 4 GB files on the home network): a `pdr-inbox/` folder
inside each workspace. It can be exposed as a Synology share and filled by
copying the SD card over SMB. Then **Scan inbox** imports everything there.

Both paths end in the same worker job.

### 4. Import job (worker, `WorkerKind` `'pdr'`)

The job runs inside `reviews.foreground()` and reports progress over the
existing events:

1. **Detect and parse.** On failure, mark the recording `failed` with the error.
   Unsupported formats are stored and shown, not dropped.
2. **Insert.** Write the recording, dictionary, raw samples and Beacon laps in
   one transaction.
3. **Match** (§5), then derive `pdr_lap_samples` for each link and call
   `markReviewDirty()` for each linked session.
4. **Report the outcome.** The result is linked, needs review, or unmatched.

`loadAll()` and `loadSession()` gain one step: after a Catalyst session's samples
are written, rebuild `pdr_lap_samples` for its links. That way a telemetry
reload keeps the PDR data.

### 5. Matching and time alignment

1. **Find candidates.** Look for Catalyst sessions whose car maps to the Vette
   Garage profile (`garage_vehicle_profiles`) and whose UTC window overlaps the
   recording's window. The Catalyst session ends at its last lap's start plus
   duration.
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
   - **Needs review** otherwise. The import dialog then shows both speed traces
     overlaid, a session picker and a ±ms nudge.
6. **Map onto Catalyst laps.** For each Catalyst sample `(lap, distance_m,
   time_ms)`, interpolate each PDR channel at the corresponding PDR time:
   - Continuous channels: linear interpolation.
   - Discrete channels (gear, flags, modes): sample-and-hold.
   - Each channel's own rate is respected, and gaps longer than about 3× its
     interval are left `NULL`.

   Then compute `video_ms` from the video/data track offset.

Catalyst stays in charge of laps, distance, the line and validity. PDR adds
channels. The PDR Beacon lap times act as a cross-check: they should agree with
Catalyst lap times to within about 50 ms.

### 6. Using the data

**Analysis charts**, shown only when a selected lap has PDR data:

- **THROTTLE / BRAKE:** both as 0–100% on one card.
- **STEERING:** steering angle.
- **RPM / GEAR:** RPM with gear changes marked.
- **Intervention strip:** shaded bands where ABS, TC or stability control was
  active.

These charts use the same distance axis, lap colours and hover cursor as the
rest. Laps without PDR data are listed as "no PDR data" rather than drawn flat.

**Video panel** on Analysis (a third view, `view=video`, next to Charts and Map)
and on Session Review:

- **Seeking.** Picking a lap seeks to its start. While the video is paused,
  hovering a chart seeks to that metre (debounced).
- **Cursor sync.** While it plays, `requestVideoFrameCallback` converts video
  time to session time, then to lap and distance, and drives `hoverDistanceM`.
  The chart cursor and map dot follow the video.
- **Media endpoint.** A new `GET`/`HEAD /api/media/pdr/:recordingId` handles
  `Range` (206/416), `Accept-Ranges`, and `video/mp4`. The parent server process
  serves it straight from disk after checking the cookie. Paths are resolved only
  through the user's `pdr_recordings` row, never from the URL.
- **Browser support.** Marlin files have `moov` first and use H.264/AAC, so
  browsers can stream and seek them as they are, with no transcoding or ffmpeg.
- **Delete video, keep telemetry.** This action frees disk space. Storage is
  shown per recording, with totals on Account.

**Measured lap phases** (`lapPhases.ts`): `LapSeries` gains optional `throttle`,
`brake` and `steer` arrays.

- **Measured thresholds, with fallback.** When present:
  - braking onset is brake > 5% and release is < 2%
  - throttle pickup is sustained accelerator > 10%
  - coasting is both pedals below threshold

  Tune these thresholds in Phase 0. Without PDR, the existing g-based inference
  stays as the fallback. Each phase records its source (`measured`/`inferred`).
- **New per-complex metrics:**
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

- **Pedal wording.** When pedal data exists, drop the "inferred from
  longitudinal g (no pedal sensors)" disclaimer. Label each phase metric
  measured or inferred.
- **New evidence and focus metrics.** Add the new metrics as evidence IDs and
  focus metrics, for example `C6.trail_brake`, `C6.understeer`,
  `C6.full_throttle`. The existing target-and-check loop then tracks them across
  sessions.
- **Setup context.** Give the setup-recommendation section the understeer index,
  hot pressures and temperatures. Today it reasons only from speed and g.

**Sessions list:** add a PDR badge (video and pedals) per session, and a
"needs review" count on the Import action.

### 7. Recordings with no Catalyst session (later phase)

When the Catalyst wasn't running, create a session with `source='pdr'` and
`session_guid = 'pdr-' + recording_id`:

- **Find the layout.** Pick the mean line whose centreline is within a few
  metres of the PDR GPS trace.
- **Project onto it.** Project points onto the mean line (nearest segment with a
  forward search window) to get `distance_m` and `lateral_position`.
- **Split laps.** Split on Beacon increments, or on distance wrap. Interpolate the
  start/finish crossing for lap times.
- **Fill the samples table.** Accelerations and yaw rate come from the car's IMU.
- **Survive reloads.** `loadAll()` re-creates these sessions from
  `pdr_samples_raw` after the Garmin sessions.

PDR GPS runs at 10 Hz, and the line is less precise than the Catalyst's fused
GPS and camera line. Mark these sessions so line-based coaching is labelled accordingly.

## Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Samples and spike** | Copy 2–3 recordings from the car: a short test drive, plus a VIR session that also has a Catalyst recording. Confirm: Marlin format and channel list on our 2021 car; whether `tstm` is UTC; whether Catalyst sample `time_ms` counts from session start; the video/data start offset (check burned-in overlay speed against telemetry at a frame); the RPM factor; pedal thresholds; behaviour at 4 GB, 30+ minute and restarted recordings. | Notes added to this doc; open questions below answered. |
| **1. Parse, store, link** | `src/pdr/` parser, schema, NAS inbox and `pdr:import` RPC, matching and alignment, `pdr_lap_samples`, the `loadAll` hook. No UI beyond logs. | A real recording imports, auto-links to the right session with error below 100 ms (checked against Beacon laps), and survives a full reload. |
| **2. Upload UI** | Browser pre-scan, resumable chunked upload, import dialog with status, needs-review matching UI, Sessions badge. | 1 GB file uploads from a phone through Cloudflare and resumes after a dropped connection. |
| **3. Channels in Analysis** | Throttle/brake, steering, RPM/gear charts, intervention strip, measured lap phases with fallback. | Corner phases on a PDR lap come from pedals; non-PDR laps are unchanged. |
| **4. Video** | Range media endpoint, video panel on Analysis and Session Review, two-way cursor sync, video deletion and storage view. | Hovering a braking zone shows that moment on video within one frame on desktop. |
| **5. Coaching** | New metrics, understeer index, tyre and fluid data in the packet, focus tracking, measured/inferred labels. | A coaching report on a PDR session cites measured pedal metrics. |
| **6. Extras** | PDR-only sessions (§7), AliveDrive (2026+) support, side-by-side two-lap video synced by distance, optional ffmpeg proxy transcodes for slow links, our own data overlay on clean video. | As needed. |

## Testing

Follow the existing `node --test tests/*.test.cjs` pattern.

- **Parser.**
  - A tiny synthetic MP4 fixture generator writes a `moov` with a `marl` data
    track. It covers:
    - full and diff records
    - the "time not valid" sentinel
    - dictionary conversion, including RPM
    - unit conversion
  - Assert that the bytes read are a small fraction of the file size.
  - A real recording stays local and gitignored for an opt-in test, because
    trimming with ffmpeg loses the data track.
- **Alignment.** Recover a known synthetic offset and drift. Reject a
  wrong-session candidate.
- **Storage.** A reload preserves links and rebuilds `pdr_lap_samples`.
  Re-importing is idempotent.
- **Server.** Upload resume, `Content-Range` validation, size and disk limits,
  and path confinement. The media endpoint handles 200/206/416/HEAD and refuses
  other users' recordings.
- **Phases and packet.** Measured phases are used when pedals exist and fall back
  otherwise. The packet wording and evidence change accordingly.

## Risks and open questions

- **Format variance.** Format details come from community reverse engineering.
  Our 2021 car may differ, for example in channel set or version. Phase 0
  decides, and the parser must reject unknown versions clearly.
- **Disk space.** About 1 GB per session is 5–10 GB per track weekend. That is
  fine on the NAS, but it grows backups. Options: keep everything, keep videos
  for N months, or keep telemetry only.
- **Privacy.** Video includes cabin audio and exact GPS. The server has no
  passwords and relies on Tailscale or Cloudflare Access. Media must never be
  served without the session cookie, and recordings stay in the importing
  driver's workspace.
- **Remote playback.** 1080p at about 6 Mb/s over the home upload link through
  Cloudflare may stutter on a phone. If so, Phase 6's 720p proxy (ffmpeg on the
  NAS) fixes it at the cost of CPU time.
- **Questions for you:**
  - Does the Catalyst always run when the PDR records? That decides how soon §7
    is needed.
  - Which overlay mode do you record in? If it's None, a later phase could draw
    our own overlay on clean video.
  - Will you import mostly from a laptop on the home network (inbox) or from a
    phone (upload)?
  - How long should videos be kept?
  - Should a recording driven by your dad attach to his workspace instead of
    yours? Today it follows whoever imports it.
