# OBD-II logger app plan

Status: proposal. Nothing is implemented yet. Phase 0 is a few hours of hands-on
checks with the car, the Veepeak adapter and the Catalyst. Those checks decide
two things: which device runs the logger, and which channels we can actually
get.

## Goal

An Android app runs in the car without anyone touching it. It:

1. starts with the car
2. connects to the Bluetooth Veepeak OBD-II adapter
3. logs every useful channel the car offers during track sessions
4. uploads the recordings to Catalyst Coach when it reaches Wi‑Fi

Catalyst Coach then links each recording to the matching Catalyst session and
uses the channels in Analysis and coaching, the same way the
[PDR import plan](corvette-pdr-import-plan.md) does for the Corvette.

## What research found

Most forum and vendor pages couldn't be opened directly, so many facts below
come from search snippets. Phase 0 exists to confirm them on our own car and
hardware.

### 1. The app almost certainly can't run on the Catalyst

- **No route in.** Neither Catalyst generation has a known way to install
  apps: no app store, no Developer Options or ADB, no sideloading or root
  reports.
- **The original Catalyst is Android underneath.** It shows up over USB as an
  Android (MTP) device. But Garmin locks it to a single app and has been
  closing access over time; firmware 5.30 removed the FIT session files.
- **Catalyst 2 may not be Android at all.** It has a 3" screen and a
  dashcam-style body.
- **Garmin's other car units are different.** The Tread Overland runs Android
  10 and accepts APKs. Nobody has reported the same for a Catalyst.

**Plan:** run the logger on a **cheap dedicated Android phone** that lives in
the car. Phase 0 includes a 10-minute check of the Catalyst anyway (USB
debugging, `adb devices`), in case we get lucky.

### 2. The Catalyst has no OBD support of its own

Neither generation reads OBD-II or CAN. Forums agree on this, and the only
Catalyst accessory is the R1 rear radar. So no engine data is hiding in the
Garmin sessions we already download. It has to come from our own logger.

### 3. What each car can give over the OBD port

| Channel you asked about | 2008 Lotus Exige (T4e ECU) | 2023 Corvette C8 |
| --- | --- | --- |
| Engine RPM | **Yes.** About 10 Hz from the ECU's broadcast frame `0x400` (see below). Also available by polling (PID `0C`). | Polling only (PID `0C`) |
| Speed | **Yes.** Broadcast (frame `0x400`) and PID `0D` | PID `0D` |
| Throttle | **Yes.** Throttle position, PID `11`, polled at a few Hz | PIDs `11`/`49`; already in the PDR at 50 Hz |
| Coolant, intake air temperature, ignition timing, engine load, MAF | Yes, polled slowly | Yes; most are in the PDR |
| Fuel level | Broadcast frame `0x400` | — |
| **Brake pedal or brake pressure** | **No.** There's no brake pressure sensor, and no public map of a brake-switch frame. | Not through the OBD port (gateway). The PDR has it at 100 Hz. |
| **Wheel speeds, ABS activity** | **No.** The ABS unit isn't on the CAN bus. | Not through the OBD port; the PDR has them. |
| Steering angle | **No.** There's no sensor. | PDR only |

#### Lotus details

**Protocol.** The 2008 model year moved to CAN at 500 kbit/s. Earlier
Elise/Exige cars use ISO 9141.

**Broadcast frame `0x400`.** The ECU sends this frame onto the diagnostic port
about 10 times a second:

| Byte | Contents | Decoding |
| --- | --- | --- |
| 1 | Speed | value − 11 |
| 3–4 | RPM | 256·A + B |
| 5 | Fuel level | 0x00 empty, 0xFF full |
| 6 | Coolant temperature | value − 14 |
| 7 | MIL and shift-light status | |

It is documented by the open-source
[elise-shift-lights](https://github.com/bri3d/elise-shift-lights) project.

**Sniffing other frames.** Other broadcast frames may exist (a brake switch
would be valuable). Finding them is a Phase 0 sniffing exercise.

#### Corvette details

**The OBD port is behind a gateway.** Passive monitoring sees nothing there.
Racelogic taps a CAN pair behind the sill plate instead. GM Mode 22 requests
for brake, steering and wheel data through the gateway are unconfirmed.

**Conclusion:** for the C8, the PDR import already provides everything the OBD
port could, at far higher rates. **The logger is for the Lotus.** It stays
car-agnostic so it would also work in the C8 or a future car, but we don't
build anything C8-specific.

**Brake pressure and wheel speed for the Lotus need extra hardware.** An
example is a brake-line pressure transducer, plus optionally a steering sensor,
feeding a small ESP32 BLE box. The open-source
[RaceChronoDiyBleDevice](https://github.com/timurrrr/RaceChronoDiyBleDevice)
(MIT) is a template. The app is designed so a second BLE source like that can
be added later as an optional phase (Phase 6).

### 4. Sample rates are modest

- **Shared polling budget.** ELM327-type adapters poll at roughly 8–20
  requests per second in total, shared across every polled channel. With
  throttle, RPM and speed that is about 3–8 Hz each.
- **Passive frames are free.** The Lotus's `0x400` frame gives RPM and speed at
  10 Hz with no polling cost.
- **One mode at a time.** The adapter can't listen to broadcasts and poll at
  the same moment; sending a request ends monitoring.
- **Multi-PID requests could help.** If the T4e accepts several PIDs in one
  request (for example `010C0D11`), throttle, RPM and speed arrive together and
  the effective rate roughly triples. Phase 0 tests this.
- **What it means for analysis.** At 5 Hz and 40 m/s a throttle sample comes
  every 8 m. That's good enough to see throttle pickup and lift points per
  corner, not to study pedal modulation. The app labels OBD-derived points with
  their resolution.

### 5. Veepeak adapters

- **Two connection types.** The OBDCheck BLE/BLE+ are Bluetooth Low Energy:
  usually GATT service `FFF0`, notify `FFF1`, write `FFF2`. Some units use
  `FFE0`/`FFE1`. The VP11 "Mini" is Bluetooth Classic (serial port profile).
- **Must discover at runtime.** The app supports both kinds and discovers the
  characteristics at runtime rather than hard-coding them.
- **Chips vary.** Clones report any version string. Some BLE+ units are said to
  use an STN chip with larger buffers and better filters. Phase 0 identifies
  ours with `ATI`, `STI` and `STDI`.
- **Monitoring needs a filter.** Unfiltered monitoring (`ATMA`) overflows
  ("BUFFER FULL") on a busy bus, so monitoring always uses a filter
  (`ATCRA 400`).

## Architecture

```
 Lotus OBD port ── Veepeak (BLE or Classic) ── Android logger phone
                                                  │  records locally (works offline)
                                                  │  phone GPS for time alignment
                                                  ▼  on Wi‑Fi: upload
 Cloudflare Access (service token, /api/ingest/* only)
                                                  ▼
 Catalyst Coach server ── POST /api/ingest/obd ── driver workspace worker
        stores recording → links to Catalyst session → per-lap channels
        → Analysis charts, lap phases, coaching
```

## Part A: Android logger app (`android-logger/`)

A new Gradle project at the repo root, written in Kotlin. The minimum SDK is
set by the phone we choose, at least 26. It targets the current Android SDK.

### A1. Device and power

**Recommended hardware.** A used Pixel (6a/7a) or a Motorola, roughly
$100–200, in a vent or dash mount out of direct sun. Phones shut down when they
overheat in a parked car.

**Power.** Ignition-switched USB power is simplest. On the Lotus, check
whether the 12 V socket is switched.

**The phone stays on permanently** and sleeps when idle. That avoids relying
on "boot when charger connects", which most phones only support after
unlocking the bootloader. The app reacts to the adapter appearing instead.

**Kiosk mode.** The app registers as the phone's **home screen**. After any
reboot it's in the foreground, and Android's restrictions on starting
background services from boot don't apply. It also starts from
`BOOT_COMPLETED` as a fallback. Battery optimisation is disabled for the app
during setup.

### A2. Components

| Component | Responsibility |
| --- | --- |
| `LoggerService` | Foreground service (types `connectedDevice` and `location`) that owns the connection, the scheduler and the recorder. It shows a persistent notification with its state. |
| `ObdTransport` | One interface with two implementations: **BLE**, which scans for the paired adapter's address, discovers `FFF0`/`FFE0` at runtime, asks for a high-priority connection and assembles notifications into lines; and **Classic SPP**, which opens an RFCOMM socket using the `00001101-…` UUID. Both expose `send(cmd)` and a stream of response lines, with timeouts. |
| `Elm327` | Initialises the adapter (`ATZ`, `ATE0`, `ATL0`, `ATS0`, `ATH1`, `ATSP0`, then `ATDPN` to record the protocol). It adds the response-count hint (e.g. `010C1`) so the adapter doesn't wait for a timeout, and tunes adaptive timing (`ATAT2` and `ATST`). It detects STN chips and uses their extra commands when present. Adapting the response parsing from `eltonvs/kotlin-obd-api` (Apache-2.0) is fine. GPL projects such as AndrOBD and python-OBD are reference only. |
| `ChannelCatalog` | Standard Mode 01 PID definitions (formula, unit, canonical key), plus per-car **profiles**. The Lotus profile includes the `0x400` broadcast decoder. Supported PIDs are discovered with `0100`, `0120` and `0140` and cached per vehicle (VIN from `0902` when the ECU answers; otherwise the adapter's address). |
| `Scheduler` | Polls channels by priority: **fast** channels (throttle `11`, RPM `0C`, speed `0D`, multi-PID if supported) as often as possible, and **slow** channels (coolant `05`, IAT `0F`, timing `0E`, load `04`, MAF `10`, others found) round-robin at about 0.5 Hz. A per-profile **acquisition mode** chosen in Phase 0: *poll-only*, or *mixed*, which alternates short `ATCRA 400`/`ATMA` windows with polling bursts if that measures better. It tracks the achieved rate per channel. |
| `SessionDetector` | Starts a recording when the adapter answers and RPM > 0. It ends after 3 minutes of RPM = 0 or no response. Brief Bluetooth drops are reconnected with backoff without splitting the recording. |
| `Recorder` | Append-only file per recording (`<uuid>.obdlog`): a JSON header (app version, adapter ID, protocol, profile, channel catalog, UTC start), then compact binary records `(elapsedRealtimeNanos, channel, value, rtt_us)`. Buffered and flushed every second, so a crash loses at most a second. It also writes **phone GPS** fixes (Fused Location, highest rate available, usually 1–10 Hz), with GNSS time used to map elapsed time to UTC. |
| `Uploader` | WorkManager job with a **Wi‑Fi (unmetered) constraint** and exponential backoff, also triggered when a recording closes. It gzips and uploads each finished recording, marks it uploaded only after the server confirms the SHA-256, and deletes local copies 30 days after upload. |
| `PairingActivity` | Scans a QR code generated by Catalyst Coach (§B2) to store the server URL, device token and Cloudflare service-token credentials in encrypted storage. It also picks the Bluetooth adapter. |
| `StatusActivity` (home screen) | Large, glanceable status: adapter connected, protocol, live RPM/throttle, recording time, **achieved Hz per channel**, recordings waiting to upload, last upload result. It also has a **Diagnostics** screen with a raw AT terminal, PID discovery and a `0x400` sniff, so Phase 0-style checks can be repeated later. |

### A3. Time alignment

- **Timestamping.** Each sample is stamped when it is received, using
  `elapsedRealtimeNanos` minus half the measured round trip, and the round-trip
  time is stored.
- **Converting to UTC.** Elapsed time is mapped to UTC with GNSS-fix times.
  NTP is the fallback; the system clock is not trusted.
- **Exact alignment happens on the server.** It cross-correlates OBD speed
  (and phone GPS speed) against the Catalyst's GPS speed (§B4). That makes
  phone clock error irrelevant.

### A4. Build and install

**Build.** A GitHub Actions job builds a signed release APK on pushes that
change `android-logger/`. It keeps the signing keystore in repository secrets.

**Install.** Copy the APK onto the phone with `adb install`, or have Catalyst
Coach offer the latest APK for download on the pairing page. No Play Store is
needed.

**Updates.** The app checks the server for a newer APK and prompts on the
status screen. Silent self-update isn't possible without device-owner mode.
Device-owner mode is an optional later step.

### A5. App tests

| Kind | What it covers |
| --- | --- |
| JVM unit tests | PID formulas, `0x400` decoding, response parsing (multi-line, `NO DATA`, `BUFFER FULL`, `SEARCHING...`), scheduler fairness, session detection, the recording file format, and the round trip of the upload protocol. |
| Integration against a simulated adapter | A fake `ObdTransport` replays recorded traffic from the Phase 0 sessions. It is checked in as fixtures, so reconnects and timeouts are tested deterministically. The Python `ELM327-emulator` project can drive a Classic-SPP smoke test. |
| On-device checklist | Reboot → app in front → adapter connects → recording starts on engine start → stops after engine off → uploads on home Wi‑Fi. |

## Part B: Catalyst Coach changes (`catalyst-app/`)

### B1. Share the PDR plan's model for extra telemetry

The PDR plan already designs storage, linking, per-lap derivation and
"optional data" handling for one extra telemetry source. OBD recordings need
the same thing. **Build it once, source-agnostic**, and use it for both
features (whichever ships first creates it):

| PDR plan table | Generic name | Change |
| --- | --- | --- |
| `pdr_recordings` | `aux_recordings` | Adds `source` (`pdr`/`obd`) and source-specific metadata as JSON |
| `pdr_channels` | `aux_channels` | Same shape: dictionary plus canonical key and unit |
| `pdr_samples_raw` | `aux_samples` | `(recording_id, channel, t_ns, value)`. OBD values arrive already decoded. |
| `pdr_links` | `aux_links` | Unchanged |
| `pdr_lap_samples` | `aux_lap_samples` | Per-lap canonical channels on the Catalyst distance grid, with `source` and achieved-rate columns, and `NULL` where a source lacks the channel |

Video (`pdr_videos`) stays PDR-only. Everything stays in the uploading
driver's workspace and survives `loadAll()` exactly as that plan describes.

### B2. Device pairing and authentication

The server is cookie-based and passwordless, and the public site sits behind
Cloudflare Access email sign-in. A phone can't do either, so it needs two
credentials:

- **Cloudflare service token** (one-time setup in the Cloudflare dashboard;
  add the steps to `deploy/CLOUDFLARE.md`).
  - Create a service token.
  - Add a second Access application for **`/api/ingest/*` only**, with a
    *Service Auth* policy allowing that token.
  - The rest of the site keeps the email policy.
  - The phone sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
  - On a LAN or Tailscale install, this credential is simply left empty.
- **Workspace device token** (in the app).
  - Under **Account → Logging devices → Add device**, the server creates a
    random token for this workspace.
  - Only its SHA-256 and a label are stored, in the **workspace's** database.
  - The page shows a QR code with `{serverUrl, token, cfClientId?,
    cfClientSecret?}` once, plus a list of devices with last-seen time and a
    **Revoke** button.
- **Routing to the right workspace.** The token embeds the workspace name like
  the session cookie does: `base64url(username).random`. The parent server
  reads the name, forwards the request to that workspace's worker, and the
  worker checks the hash. A wrong or revoked token gets `401`. No token can
  reach another workspace.

### B3. Ingest endpoint

**`POST /api/ingest/obd`** handles uploads. It is served by the parent process,
which authenticates as in B2 and then hands the body to the workspace worker.

**Request.** The body is a gzipped `.obdlog` file of at most 20 MB, under the
existing 25 MB body limit. A 30-minute recording at about 40 samples/s is well
under 1 MB. Headers carry the recording UUID and SHA-256.

**Responses.**

- **Idempotent.** A repeated UUID with the same hash returns `200 {status:
  "duplicate"}`.
- **Hash mismatch.** Returns `422`.

**Worker job** (`WorkerKind` `'obd'`), run inside `reviews.foreground()`:

1. Parse the file and convert to canonical units.
2. Insert `aux_*` rows.
3. Link (§B4).
4. Derive the per-lap channels.
5. Call `markReviewDirty()` on linked sessions.

**Status.** Recordings appear in **Sessions → Logged data** with states
*linked*, *needs review* and *waiting for Catalyst sync*. The last state retries
automatically after every Garmin sync, because the phone often uploads before
the Catalyst session has been downloaded.

### B4. Linking to Catalyst sessions

This reuses the PDR plan's matching:

1. **Find candidates.** Catalyst sessions in this workspace whose UTC window
   overlaps the recording.
2. **Fine alignment.** Cross-correlate OBD speed (10 Hz from `0x400` or polled)
   and phone GPS speed against Catalyst GPS speed.
3. **Check for drift.** Compare the first and last five minutes.
4. **Validate the GPS.** Phone GPS against the Catalyst track: median residual
   ≤ 10 m. Phone GPS is coarser than the PDR's.
5. **Link or ask.** Auto-link a single good match; otherwise mark the recording
   *needs review* with the same manual picker and nudge.

Unlike the PDR, a recording can **cover several Catalyst sessions**: the
logger may run all day if the engine idles between sessions. The link step
splits it across every overlapping session.

**Speed sensor check.** The car's OBD speed comes from its own speed sensor.
The ratio of OBD speed to GPS speed is stored per session as a tyre-size and
calibration check.

### B5. Using the data (optional everywhere)

The same rules as the PDR plan apply:

- **Data is optional per lap.** Laps without auxiliary data are unchanged, and
  absence is never treated as zero.
- **Pinned regression.** A test pins today's output for a selection with no
  auxiliary data.
- **Mixed selections** label laps that have no data.

What the Lotus gains:

- **THROTTLE chart.** The first measured pedal channel for the Lotus. The card
  shows the achieved rate, e.g. "throttle · OBD · ~5 Hz".
- **RPM / GEAR chart.** Gear is derived from the RPM-to-speed ratio and
  clustered per car. The Exige's gear ratios can seed the clusters via its
  Garage profile. This gives shift points, time spent near the 7,800 rpm
  limiter, and over-revving on downshifts.
- **Measured throttle in lap phases.** Throttle pickup and lift points come from
  throttle position when present; they're still inferred from g when it isn't.
  **Braking stays g-inferred on the Lotus**, because no pedal channel exists, and
  coaching text says so per metric (measured/inferred).
- **Coolant, IAT and timing trends** per session. They support heat-soak notes
  and a check for the ECU pulling timing.
- **Coaching packet.** Gains measured-throttle metrics (pickup point,
  full-throttle share per segment, lift on fast corners such as the Climbing
  Esses), RPM and gear at corner minimums, and temperatures. These are offered to
  the model only when the packet has OBD laps.

## Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Hands-on checks** (one afternoon plus one drive) | **Catalyst:** look for Developer Options and USB debugging, and try `adb devices` over USB. **Veepeak:** model number, BLE or Classic, `ATI`/`STI`/`STDI`. **Lotus:** with a free terminal app (nRF Connect for BLE, Serial Bluetooth Terminal for Classic), run `ATDPN`, `0100`/`0120`/`0140`, and test `010C0D11`. Time 200 polls of fast PIDs. Run `ATCRA 400` + `ATMA`, then broader filtered sniffing for other frames while pressing the brake pedal. **Drive:** log once with Torque Lite to sanity-check rates. **Power:** check whether the Lotus 12 V socket is switched and whether the Veepeak drains the battery overnight. | Findings written into this doc: protocol, PID list, achieved Hz per mode, chosen acquisition mode, any brake-switch frame, logger device decision. |
| **1. Logger MVP** | Transports, ELM327 driver, channel catalog plus Lotus profile, scheduler, recorder with phone GPS, status and diagnostics screens. Manual start/stop and "share recording" export. | A track or road drive produces a recording with RPM, speed and throttle at the measured rates and no gaps beyond adapter dropouts. |
| **2. Hands-off operation** | Home-screen (kiosk) mode, boot start, auto-connect, session detection, reconnect handling, heat and battery settings. | 3 consecutive drives logged with nobody touching the phone. |
| **3. Server ingest and pairing** | Generic `aux_*` schema (shared with the PDR plan), device tokens and QR pairing, Cloudflare service-token setup and docs, ingest endpoint, worker job, Uploader. | Recordings upload automatically on home Wi‑Fi through Cloudflare and land only in the paired workspace; a revoked device gets 401. |
| **4. Linking** | Alignment, multi-session splitting, *waiting for Catalyst sync* retries, needs-review UI. | A VIR day auto-links every session, with alignment error under 100 ms checked against lap-boundary speed features. |
| **5. Analysis and coaching** | Throttle and RPM/gear charts, gear derivation, measured throttle phases, temperature trends, packet changes, optional-data regression tests. | A Lotus coaching report cites measured throttle metrics. Sessions without OBD data are unchanged. |
| **6. Optional brake hardware** | ESP32 BLE box with brake pressure (and optionally steering angle), added as a second source in the logger. | Measured braking phases on the Lotus. |

## Risks

- **Low sample rate.** If Phase 0 measures under about 3 Hz per channel for
  throttle, consider an STN-based adapter such as an OBDLink MX+, around $100.
  That swap needs only a transport-profile change.
- **Phone heat and reliability.** A phone in a sealed car on a summer
  trailer can overheat. Use a vent mount, keep it out of the sun, and take it
  out between events if needed. The status screen shows the battery
  temperature.
- **Adapter battery drain.** The Veepeak is powered from the OBD port's
  permanent 12 V. Unplug it, or rely on its sleep mode, during storage;
  Phase 0 measures this.
- **Android background limits.** Running as the home screen plus a foreground
  service avoids most of them. Vendor battery savers (Samsung especially) are
  the reason to prefer a Pixel or Motorola.
- **Credentials on the phone.** The phone holds a workspace upload token and,
  for the public site, a Cloudflare service token limited to `/api/ingest/*`.
  Both can be revoked separately. A stolen phone can upload junk, but it can't
  read data.

## Questions for you

- **Adapter model:** which Veepeak is it? The model on the label, e.g.
  OBDCheck BLE, BLE+ or VP11.
- **Catalyst generation:** which one do you have? The repo notes suggest the
  original (6.95" screen).
- **Hardware:** are you OK buying a cheap dedicated Android phone for the car?
- **Scope:** confirm Lotus only, since the Corvette's PDR covers it.
- **Brake data:** are you interested in Phase 6 (a brake pressure sensor), the
  only way to get braking data on the Lotus?
