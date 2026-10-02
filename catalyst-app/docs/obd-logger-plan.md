# OBD-II logger plan

Status: proposal. Nothing is implemented yet. Phase 0 is a short hands-on check
of the Catalyst and the car. It decides the host (the Catalyst itself, or a
fallback device) and the channel set.

## Goal

Anyone who drives with a Garmin Catalyst and runs Catalyst Coach should be able
to add their car's own OBD-II data to their sessions: RPM, speed, throttle and
pedal position, load, boost, temperatures — whatever the car's OBD-II port
offers.

- **On the Catalyst.** The logger runs as a native Android app on the
  Catalyst itself, so there is no phone and nothing extra in the car.
- **Automatic.** It starts with the car, connects to the Bluetooth OBD adapter,
  logs during sessions, and uploads to the driver's Catalyst Coach workspace
  over Wi‑Fi.
- **Linked and used.** Catalyst Coach matches each recording to the Catalyst
  session and uses the channels in Analysis and coaching, the same way the
  [PDR import plan](corvette-pdr-import-plan.md) does for the Corvette.

## Requirements (from the owner)

| Requirement | Consequence |
| --- | --- |
| Run on the owner's own Catalyst (original, 6.95", Android-based). | The app installs on the Catalyst through a standard Android app-install path. Primary design below. |
| No phone and no add-on sensors in the car. | Only the OBD adapter may change. Data is limited to the OBD-II port. |
| Works for anyone, any car. | Nothing car-specific is required; the app discovers each car's PIDs. Optional car profiles add extras. |
| A faster adapter is fine. | The current Veepeak BLE can be replaced if Phase 0 shows it's a bottleneck. |
| Data belongs to a workspace. | Each logger pairs with exactly one Catalyst Coach workspace. |

## Host decision (Phase 0 gate)

The Catalyst is an Android-based device the owner owns, so the goal is to
install our own app on it the same way any Android device takes a sideloaded
app. What's unverified is whether this unit exposes a **standard** Android
install path. Phase 0 checks, on the owner's own device, using only normal
Android facilities:

1. **Developer Options / USB debugging.** In Settings, look for an About or
   build-number entry and a Developer Options screen with a USB debugging
   toggle (standard Android).
2. **ADB over USB.** With the Catalyst on USB, run `adb devices`. If it appears
   as a device (not only MTP storage), try `adb install our-app.apk` with a
   trivial signed test APK.
3. **Install from storage.** If there is a files/browser surface, try opening
   an APK copied to the device, with "install unknown apps" allowed.
4. **Note the OS.** Record the Android/AOSP version shown, and whether BLE is
   available to apps.

**Outcome A — the Catalyst accepts a standard sideload.** This is the plan:
build the app (Part A) and install it this way. Everything below is written for
this case.

**Outcome B — the device only runs manufacturer-signed software and exposes no
standard install path.** Then the app can't be installed without modifying the
device's firmware or security, which this plan does not cover. The same app
also runs unchanged on any spare Android device the owner already has, but
that's a last resort, not a design goal here. Phase 0 is expected to land on
Outcome A.

The server side (Part B) is identical in every case: it accepts uploads from
any logger, so the host decision never reaches it.

> Research notes: no public source documented a standard sideload path on the
> original Catalyst, and Garmin lists it among Linux-based products and ships
> only Garmin-signed updates (Garmin Express or Wi‑Fi). That's why this is a
> device check rather than an assumption. Neither Catalyst generation reads OBD
> itself, so none of this data is already in the Garmin sessions.

## What the car can give over OBD-II

Standard OBD-II Mode 01, available on essentially every car, in canonical units:

| Category | PIDs | Notes |
| --- | --- | --- |
| Engine and speed | RPM `0C`, speed `0D` | Speed is whole km/h and often filtered; GPS speed is preferred for analysis. |
| Driver input | throttle `11`, relative throttle `45`, pedal D/E/F `49`–`4B`, commanded throttle `4C` | **The main new coaching channel.** Pedal position is the driver's foot; throttle position is the blade. |
| Load and torque | load `04`/`43`, torque `61`–`63` | Torque on newer cars only. |
| Air and boost | MAP `0B` (boost = MAP − baro `33`), MAF `10` | |
| Temperatures | coolant `05`, intake air `0F`, oil `5C` (often absent), ambient `46` | Heat soak over a session. |
| Other | timing `0E`, commanded λ `44`, module voltage `42` | Timing pulled under heat or knock. |

**Not in standard OBD-II on any car:** brake pressure or brake pedal, steering
angle, individual wheel speeds, ABS activity, gear. Some cars expose extras
through manufacturer-specific requests or broadcast CAN frames; those go in
optional **car profiles** and never hold up the standard path. **Gear is
derived** from RPM against speed.

**Rates.** An ELM327-class adapter shares a budget of roughly 20–50 requests a
second across all polled channels on CAN cars (much less on older K-line cars).
With a small fast set that's about 5–10 Hz per channel. At 40 m/s, 5 Hz is a
sample every 8 m — enough to see throttle pickup and lift points per corner,
not fine pedal modulation. Each OBD point is labelled with its rate so the app
never implies more resolution than it has. Phase 0 measures the real figure.

### The two cars here (illustrative)

- **2008 Lotus Exige (CAN, 500 kbit/s):** throttle, RPM, speed and engine
  temperatures over standard PIDs. Its ECU also broadcasts a ~10 Hz frame
  (`0x400`) carrying RPM and speed, which a Lotus car profile can read passively
  for free. No brake, wheel-speed or steering data exists on this car's bus.
- **2023 Corvette C8:** standard PIDs work, but its OBD port is behind a gateway
  that blocks the richer broadcast data, and the PDR already captures brake,
  steering and wheel speed at high rate. So OBD is the Lotus's story; the C8 is
  covered by the PDR plan.

## Part A: the Catalyst app (`android-logger/`)

A new Gradle/Kotlin project at the repo root. The minimum SDK matches whatever
Android version Phase 0 reports for the Catalyst.

### A1. Running unattended

- **Auto-start.** A `BOOT_COMPLETED` receiver starts a foreground service
  (types `connectedDevice` and `location`). If the Catalyst's launcher can be
  set, the app can also be the launcher as a stronger guarantee; if not, the
  boot receiver plus foreground service is enough on most Android builds.
- **Power.** The Catalyst already powers up with the car. The app reacts to the
  OBD adapter appearing rather than to power events.
- **Coexistence.** The app must not interfere with Garmin's software: it only
  uses BLE and Wi‑Fi client networking, holds a wake lock only while recording,
  and keeps CPU and storage use low. Phase 0 confirms it runs alongside a normal
  Catalyst session without disturbing it.

### A2. Components

| Component | Responsibility |
| --- | --- |
| `LoggerService` | Foreground service owning the connection, scheduler and recorder; shows a persistent status notification. |
| `ObdTransport` | One interface, two implementations: **BLE** (scan for the paired adapter, discover `FFF0`/`FFE0` at runtime, request a high-priority connection, assemble notifications into lines) and **Classic SPP** (RFCOMM `00001101-…`). Both expose `send(cmd)` and a line stream with timeouts. |
| `Elm327` | Adapter init (`ATZ ATE0 ATL0 ATS0 ATH1 ATSP0`, then `ATDPN`), the response-count hint (e.g. `010C1`) so it doesn't wait out a timeout, adaptive timing (`ATAT2`, `ATST`), and STN detection for better buffers/filters. Response parsing adapted from `eltonvs/kotlin-obd-api` (Apache-2.0). GPL projects (AndrOBD, python-OBD) are reference only. |
| `ChannelCatalog` | Standard Mode 01 PID definitions plus optional per-car profiles (e.g. the Lotus `0x400` decoder). Supported PIDs discovered with `0100/0120/0140` and cached per vehicle (VIN from `0902`, else the adapter address). |
| `Scheduler` | Polls a **fast** set (throttle, RPM, speed; multi-PID request when the ECU allows) as fast as possible and a **slow** set round-robin (~0.5 Hz). Tracks achieved Hz per channel. A per-profile acquisition mode (poll-only, or mixed with short filtered `ATCRA`/`ATMA` windows) chosen in Phase 0. |
| `SessionDetector` | Starts a recording when the adapter answers and RPM > 0; ends after ~3 min of no engine. Brief BLE drops reconnect with backoff without splitting the recording. |
| `Recorder` | Append-only `<uuid>.obdlog`: JSON header (app/adapter/protocol/profile/catalog/UTC start) then compact binary `(elapsedRealtimeNanos, channel, value, rtt_us)`, flushed every second. Also logs the Catalyst's **own GPS** if the app can read it; otherwise alignment uses OBD speed alone. |
| `Uploader` | WorkManager job, Wi‑Fi (unmetered) constraint, exponential backoff, also fired when a recording closes. Gzips and uploads each finished recording, marks it uploaded only after the server confirms its SHA-256, deletes local copies 30 days later. |
| `PairingActivity` | Scans the QR code from Catalyst Coach (Part B) and stores server URL, device token and optional Cloudflare service-token credentials in encrypted storage; also picks the BLE adapter. |
| `StatusActivity` | Glanceable status (adapter, protocol, live RPM/throttle, recording time, achieved Hz, pending uploads, last result) plus a **Diagnostics** screen with a raw AT terminal, PID discovery and a frame sniff, so Phase 0 checks can be repeated. |

### A3. Time alignment

Each sample is stamped on receipt (`elapsedRealtimeNanos` minus half the
measured round trip; the round trip is stored). Elapsed time maps to UTC via
GPS fixes where available, else NTP. Exact alignment happens on the server by
cross-correlating OBD (and any GPS) speed against the Catalyst session's GPS
speed, so device clock error doesn't matter.

### A4. Build and install

A GitHub Actions job builds a signed release APK on changes under
`android-logger/`, keystore in repository secrets. Install by the standard path
Phase 0 confirmed (`adb install`, or opening the APK on the device). The app
checks the server for a newer APK and prompts on the status screen.

### A5. Tests

JVM unit tests (PID formulas, profile decoders, response parsing incl.
`NO DATA`/`BUFFER FULL`/`SEARCHING...`, scheduler fairness, session detection,
file format, upload round-trip). Integration against a fake `ObdTransport` that
replays Phase 0 traffic fixtures. An on-device checklist (reboot → app running →
adapter connects → recording on engine start → stops after engine off → uploads
on home Wi‑Fi).

## Part B: Catalyst Coach changes (`catalyst-app/`)

### B1. Share the PDR plan's telemetry model

The PDR plan already designs storage, linking, per-lap derivation and
optional-data handling for one extra telemetry source. OBD needs the same, so
build it once, **source-agnostic** (whichever feature ships first creates it):

| PDR table | Generic | Change |
| --- | --- | --- |
| `pdr_recordings` | `aux_recordings` | add `source` (`pdr`/`obd`) + source metadata JSON |
| `pdr_channels` | `aux_channels` | same shape |
| `pdr_samples_raw` | `aux_samples` | `(recording_id, channel, t_ns, value)`; OBD values arrive decoded |
| `pdr_links` | `aux_links` | unchanged |
| `pdr_lap_samples` | `aux_lap_samples` | per-lap canonical channels on the Catalyst distance grid, with `source` and achieved-rate columns, `NULL` where a source lacks a channel |

Video stays PDR-only. Everything is workspace-scoped and survives `loadAll()`
exactly as that plan describes.

### B2. Device pairing and auth

The server is cookie-based and passwordless, and the public site is behind
Cloudflare Access email sign-in, so a headless logger needs two credentials:

- **Cloudflare service token** — a second Access application scoped to
  `/api/ingest/*` only, with a Service Auth policy; the rest of the site keeps
  the email policy. Empty on a LAN/Tailscale install. (Add steps to
  `deploy/CLOUDFLARE.md`.)
- **Workspace device token** — created under **Account → Logging devices → Add
  device**; only its SHA-256 and a label are stored, in the workspace DB. The
  page shows a one-time QR (`{serverUrl, token, cfClientId?, cfClientSecret?}`)
  and a device list with last-seen and **Revoke**. The token embeds the
  workspace name like the session cookie (`base64url(username).random`), so the
  parent server routes to the right worker and no token can reach another
  workspace.

### B3. Ingest endpoint

**`POST /api/ingest/obd`**, served by the parent process: authenticates (B2),
hands the body to the workspace worker. Body is a gzipped `.obdlog` ≤ 20 MB
(a 30-min recording at ~40 samples/s is well under 1 MB), headers carry the UUID
and SHA-256. Idempotent on repeated UUID+hash (`200 duplicate`); hash mismatch
`422`. Worker job (`WorkerKind` `'obd'`, inside `reviews.foreground()`): parse →
insert `aux_*` → link (B4) → derive per-lap channels → `markReviewDirty()`.
Recordings show in **Sessions → Logged data** as linked / needs review / waiting
for Catalyst sync; the last retries after each Garmin sync, because the logger
often uploads before the Catalyst session is downloaded.

### B4. Linking

Reuses the PDR plan's matching: candidate Catalyst sessions in this workspace
whose UTC window overlaps; fine alignment by cross-correlating OBD (and any GPS)
speed against Catalyst GPS speed; drift check on first vs last five minutes;
auto-link a single good match, else **needs review** with the manual picker and
nudge. Unlike the PDR, one recording can **span several Catalyst sessions** (the
logger may run all day), so the link step splits it across every overlapping
session. The OBD-speed-to-GPS-speed ratio is stored per session as a
tyre-size/calibration check.

### B5. Using the data (optional everywhere)

Same rules as the PDR plan: data is optional per lap, absence is never zero,
today's no-aux output is pinned by a regression test, and mixed selections label
laps without data. What a car with OBD gains:

- **THROTTLE chart** — first measured pedal channel for the Lotus; the card
  shows the rate ("throttle · OBD · ~5 Hz").
- **RPM / GEAR chart** — gear derived from the RPM/speed ratio, clustered per
  car (seedable from a Garage profile's gear ratios): shift points, time near
  the limiter, over-rev on downshifts.
- **Measured throttle in lap phases** — pickup and lift points from throttle
  when present; still g-inferred otherwise. Braking stays g-inferred unless a
  car profile supplies a brake channel; coaching text labels each metric
  measured or inferred.
- **Temperature trends** — coolant/IAT/timing per session (heat soak, timing
  pulled).
- **Coaching packet** — measured-throttle metrics (pickup point, full-throttle
  share per segment, lift on fast corners), RPM/gear at corner minimums, and
  temperatures, offered to the model only when the packet has OBD laps.

## Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Host and car check** | On the Catalyst: check for Developer Options / USB debugging, try `adb install` of a test APK, or an APK from storage; note the Android version and BLE availability. On the car with a free terminal app: `ATDPN`, `0100/0120/0140`, test a multi-PID request, time 200 fast-PID polls, and note any useful broadcast frame. Decide host (Catalyst vs fallback) and acquisition mode. | Findings written here: install path, Android version, protocol, PID list, achieved Hz, chosen adapter. |
| **1. Logger MVP** | Transports, ELM327 driver, catalog + any car profile, scheduler, recorder, status/diagnostics screens; manual start/stop and a share-recording export. | A drive produces a recording with RPM, speed and throttle at the measured rates, no gaps beyond adapter dropouts. |
| **2. Hands-off** | Auto-start, auto-connect, session detection, reconnect handling; runs cleanly alongside a Catalyst session. | 3 drives logged untouched with Garmin recording normally. |
| **3. Server ingest & pairing** | Generic `aux_*` schema (shared with PDR), device tokens + QR pairing, Cloudflare service-token setup/docs, ingest endpoint, worker job, Uploader. | Recordings upload automatically on Wi‑Fi through Cloudflare and land only in the paired workspace; a revoked device gets 401. |
| **4. Linking** | Alignment, multi-session splitting, waiting-for-sync retries, needs-review UI. | A VIR day auto-links every session, alignment error < 100 ms vs lap-boundary speed features. |
| **5. Analysis & coaching** | Throttle and RPM/gear charts, gear derivation, measured throttle phases, temperature trends, packet changes, optional-data regression tests. | A coaching report cites measured throttle metrics; non-OBD sessions unchanged. |

## Risks

- **Install path unknown until Phase 0.** The whole on-device design is gated on
  it. Phase 0 is scoped to answer it first, before any build work starts.
- **Low sample rate.** If a channel polls under ~3 Hz, move to an STN-based
  adapter (OBDLink CX, BLE) — a transport change only.
- **Running alongside Garmin.** The app must stay light and must never disturb a
  Catalyst session; Phase 2 verifies this.
- **Firmware updates.** A Garmin update could remove a sideloaded app; it can be
  reinstalled by the same path.
- **Credentials on the device.** It holds a workspace upload token and an
  ingest-scoped Cloudflare token; both are revocable and neither can read data.

## Questions for the owner

- **Catalyst generation:** confirmed original (6.95")?
- **Adapter model:** which Veepeak (OBDCheck BLE, BLE+, VP11)? The label says.
- **If Phase 0 shows the Catalyst won't take a standard sideload:** stop there
  and reconsider, or fall back to a spare Android device running the same app?
