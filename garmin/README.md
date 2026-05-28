# Garmin Catalyst API — Reverse Engineering Notes & Data Pipeline

## Background

The Garmin Catalyst is a dedicated motorsport coaching device. Garmin intentionally removed FIT
file export in firmware 5.30 (April 2023). The device is fully isolated from Garmin Connect — it
runs on a separate cloud backend called GCS (Garmin Cloud Services). There is no official public
API.

This folder documents the API discovered by decompiling the Android APK
(`com.garmin.android.driveapp.catalyst_2.02.25`) using JADX and `strings` analysis of the native
library `libgecko.so`, **and verified against the live production API.** Working auth and a
subset of working endpoints have been confirmed via `catalyst_client.py --probe`.

---

## Status as of 2026-05-28 (afternoon)

### ✅ Working end-to-end

- **Authentication** — 3-step SSO service_ticket flow → 90-day Catalyst Bearer token.
- **Bulk download** — `catalyst-fetch` pulls all sessions (50 sessions, 205 MB).
- **Protobuf decoder** — `decode_performance.py` parses the binary lap/sample files
  with zero schema (hand-rolled wire-format reader).
- **DuckDB loader** — `catalyst-load` ingests sessions/laps/samples into
  `data/catalyst.duckdb`. Currently: 50 sessions, 392 laps, 2,035,080 samples.
- **PySide6 GUI** — `catalyst-gui` shows account, sync status, sessions table,
  car-setup markdown viewer/editor.

### ✅ Endpoints (verified against production)

**Discovery method:** all path constants pulled from `libgecko.so` strings; required
param names + enum values found by string-grepping the binary; verified by hitting
production and inspecting JSON / protobuf responses.

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| GET | `/autosport/api/v1/sessions/count` | filterTrackConfigurationId? | JSON `{sessionsCount}` |
| GET | `/autosport/api/v1/sessions` | **sortType** ∈ {`SESSION_START_TIME`, `TRACK_NAME`, `BEST_LAP`}, **sortOrder** ∈ {`ASCENDING`, `DESCENDING`}, `limit`, `offset` | JSON `{sessionsSummaries: [...]}` |
| GET | `/autosport/api/v1/session-track-days` | `limit`, filters | JSON `{sessionTrackDays: [...]}` |
| GET | `/autosport/api/v1/trackFacilities` | `limit` | JSON `{trackFacilities: [...]}` |
| GET | `/autosport/api/v1/trackConfigurations` | `trackCartographyId` | JSON `{trackConfigurations: [...]}` |
| GET | `/autosport/api/v1/session/<sessionGuid>/metadata` | — | JSON (garminGuid, productIdentifier, meanLineGuid) |
| GET | `/autosport/api/v1/session/<sessionGuid>/weather` | — | JSON (description, temp, humidity, wind) |
| GET | `/autosport/api/v1/session/<sessionGuid>/performanceData` | — | **protobuf** (~3-6 MB) — all laps + per-sample telemetry |
| GET | `/autosport/api/v1/session/<sessionGuid>/optimalLap` | — | **protobuf** — composite optimal lap |
| GET | `/autosport/api/v1/meanLine/<meanLineGuid>` | — | **protobuf** — reference GPS line for a track config |

### ⚠ Endpoints discovered but not needed (or still unmapped)

- `/autosport/api/v1/sessions/metadata` — 400; requires a `modifiedAfterDate` ISO param (used
  by the app for incremental sync, not needed for full pulls). Not blocking anything.
- `/autosport/api/v1/track` — 400; not needed since trackFacilities + trackConfigurations
  give everything we need.
- `/autosport/api/v1/leaderboard/{session,day,annual}` — all 404 when we tried.
  String constants confirm they exist; the app constructs URLs with a required
  `criteria` (`leaderboardCriteriaType`) plus `vehicleType` / `startDateTime` /
  `endDateTime`. Worth a follow-up but not in the critical path.
- `/autosport/api/v1/customer`, `/user`, `/connections` — 404. The user/profile
  data is available from `/session/<guid>/metadata.garminGuid` which is enough
  to identify your account.

## Protobuf schema (reverse-engineered)

We don't have `.proto` files (Garmin compiled them into libgecko.so). Instead
`decode_performance.py` reads the wire format directly. Discovered structure:

```
PerformanceData (and OptimalLap, same Lap schema):
  field 2  = DeviceInfo { unit_id, part_number, version }
  field 3.1 = session_guid (string)
  field 4.1 = mean_line_guid (string)
  field 5..10 = session-level summary scalars (not yet labeled)

  field 11 = first/warm-up Lap     ← single
  field 12 = subsequent timed Laps ← repeated

  Lap {
    field 1  = lap_number_raw   (jumps 2,4,6,... — semantic unclear)
    field 2  = duration_ms       ← VERIFIED (107106 = 1:47.106)
    field 3..10 = lap aggregates (one of: min/max/avg speed)

    field 11 = repeated Sample
    Sample {
      field 1  = dist_idx (float counter, integer-valued)
      field 2  = seq (varint)
      field 3  = Position { lat: double, lon: double }
      field 4..15 = 12 floats per sample — speed, altitude, heading, accel_g,
                    cornering_g, lateral_position, etc. (mapping TBD via value
                    range analysis vs. libgecko.so field-name strings)
    }
  }

MeanLine:
  device + meanLineGuid + track config metadata + GPS path (lat/lon doubles)
```

**Critical insight:** every lap of a given track config has the **same sample
count** (~5,256 for VIR Full Course). Samples are aligned by *distance along the
meanline*, not time. This makes cross-lap comparison trivial — same `dist_idx`
in two different sessions refers to the same physical point on the track.

---

## API Architecture

### Base URLs

```
Production:  https://api.gcs.garmin.com/
Staging:     https://api.gcs.stage.garmin.com/
Test:        https://api.gcs.test.garmin.com/
```

All Catalyst telemetry data lives under the `autosport` service path:

```
https://api.gcs.garmin.com/autosport/api/v1/
```

The app also makes requests to **`automotive.garmin.com`** and
**`catalyst.automotive.garmin.com`** (e.g. `/profile?guid=`, `/whatsnew/public/`). These are
behind their own cert pinning in `libgecko.so` and cannot be intercepted via Charles/mitmproxy.

### Authentication — the full flow

The Catalyst autosport API rejects tokens issued under the default Garmin Connect mobile
client_id (`GARMIN_CONNECT_MOBILE_ANDROID_DI`). Standard `garth` login returns a Connect token,
which **401s on every autosport endpoint.** A Catalyst-scoped token is required, with
`client_id=GARMIN_MOBILE_CATALYST_ANDROID`.

The flow (reverse-engineered from `libgecko.so` strings + verified end-to-end):

1. **Standard SSO login via garth** (with desktop Chrome User-Agent to bypass Cloudflare).
   This sets the SSO TGT cookie in the live `requests.Session`.

2. **GET** `https://sso.garmin.com/sso/login?service=https://sso.garmin.com/sso/embed`
   `&mobile=true&clientId=GARMIN_MOBILE_CATALYST_ANDROID`

   The active TGT cookie causes a **302 redirect** to
   `https://sso.garmin.com/sso/embed?ticket=ST-XXXXXXX-...-cas` — a fresh CAS service
   ticket scoped to the Catalyst client.

   *(Do NOT pass `performMFACheck=true` unless the account actually has MFA enabled — the
   server will 302 to `verifyMFA/setupMfaRequired` and refuse to mint a ticket.)*

3. **POST** `https://services.garmin.com/api/oauth/token` (form-encoded):
   ```
   grant_type=service_ticket
   client_id=GARMIN_MOBILE_CATALYST_ANDROID
   service_ticket=ST-XXXXXXX-...-cas
   service_url=https://sso.garmin.com/sso/embed
   ```

   Response:
   ```json
   {
     "access_token": "<JWT>",
     "refresh_token": "...",
     "token_type": "Bearer",
     "expires_in": 7776000,           // 90 days
     "refresh_token_expires_in": 31536000   // 365 days
   }
   ```

4. **API requests** to `https://api.gcs.garmin.com/autosport/api/v1/...` succeed with
   `Authorization: Bearer <access_token>`.

#### Important quirks

- **Re-running steps 1–3 requires a fresh garth login** (not `garth.resume()`), because
  garth doesn't persist SSO cookies — only OAuth tokens. The TGT cookie must be in the
  live in-memory session. `catalyst_client.py` handles this automatically by clearing
  the garth token store and re-logging in if no cached Catalyst token is present.
- **Cloudflare blocks garth's default mobile UA.** Override with:
  ```python
  garth.client.sess.headers.update({"User-Agent": "Mozilla/5.0 ... Chrome/131.0.0.0 ..."})
  ```
- **`/sso/requestToken` is a refresh endpoint** for an existing Catalyst token, NOT
  the initial-issuance endpoint. Sending a Connect access token there returns 400
  "MissingRequiredParameter" — wasted ~an hour on this dead end.

#### Browser fallback for MFA / captcha

If the headless SSO ticket request fails (302 to `setupMfaRequired`, captcha, etc.),
`catalyst_client.py` opens the system browser to `sso.garmin.com/sso/embed`
with `service=http://localhost:8765/callback` and spins up a tiny local HTTP server to
capture the ticket from the post-login redirect. The captured ticket is then exchanged
for a token in step 3 above.

---

## What lives where

| Host                              | Notes                                                                                                                  |
|-----------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `sso.garmin.com`                  | OAuth/SSO. `/sso/signin`, `/sso/embed`, `/sso/login`, `/sso/requestToken`. Used for both ticket mint and refresh.       |
| `services.garmin.com`             | **`/api/oauth/token`** — exchanges service tickets and refresh tokens for OAuth2 access tokens.                        |
| `api.gcs.garmin.com`              | Main data API. **`/autosport/api/v1/`** is the Catalyst namespace.                                                     |
| `geckobackchannel.gcs.garmin.com` | Real-time streaming via `/proto`. Used for live device sync (not needed for historical data pull).                     |
| `automotive.garmin.com`           | User profile, what's-new content (`/whatsnew/public/`, `/profile?guid=`). Cert-pinned; cannot be intercepted.          |
| `catalyst.automotive.garmin.com`  | Catalyst profile page (`/profile?guid=`). Cert-pinned.                                                                 |

---

## REST Endpoints — current state

All endpoints are under `https://api.gcs.garmin.com/autosport/api/v1/`.

### Sessions

| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/sessions/count` | ✅ 200 | `{"sessionsCount": 50}` |
| GET | `/sessions` | ❌ 400 | Required params unknown |
| GET | `/sessions/metadata` | ❌ 400 | Same |
| GET | `/session` | ⚠ untested | Likely needs `?sessionId=<guid>` |
| GET | `/session-track-days` | ✅ 200 | `{"sessionTrackDays":[...]}` |
| GET | `/session-track-days/count` | ⚠ untested | |

**Known filter param names** (from libgecko.so string constants):
- `filterStartDateTime` (ISO8601)
- `filterEndDateTime` (ISO8601)
- `filterTrackConfigurationId` (int)
- `filterTrackIsReverse` (bool)
- `sortOrder` (likely `asc`/`desc`)

**App-side method names:**
- `SessionsRequestController::StartGetSessionsCount(filter)`
- `SessionsRequestController::StartGetSessionsByStartTime(filter, sort, offset, limit)`
- `SessionsRequestController::StartGetSessionsByTrackName(filter, sort, offset, limit)`
- `SessionsRequestController::StartGetSessionsByBestLapTime(filter, sort, offset, limit)`

The 400 likely means the server requires a specific `sort` value the app sends but I haven't
discovered yet — possibly `START_TIME`/`TRACK_NAME`/`BEST_LAP_TIME` or an enum like
`SortBy.START_TIME`. Worth trying a `mitmproxy` capture on Android since the autosport API
calls go through libcurl (libgecko.so does its own SSL — Charles cannot intercept). The
better path is probably Frida-hooking libgecko's HTTP request function.

### Tracks

| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/trackFacilities` | ✅ 200 | Returns `{"trackFacilities":[{trackCartographyId, trackName, sessionCount}]}` |
| GET | `/trackFacilities/count` | ⚠ untested | |
| GET | `/trackConfigurations?trackCartographyId=N` | ✅ 200 | `{"trackConfigurations":[{trackCartographyId, trackName, trackConfigurationId, trackConfigurationName, trackIsReverse, sessionCount}]}` |
| GET | `/track` | ❌ 400 | Required params unknown |

### Telemetry / Lap Data

| Method | Path | Status |
|--------|------|--------|
| GET | `/meanLine` | ⚠ untested — likely needs `?sessionId=` |

### Leaderboards

| Method | Path | Status |
|--------|------|--------|
| GET | `/leaderboard/session?sessionId=` | ⚠ untested |
| GET | `/leaderboard/day?trackDayId=` | ⚠ untested |
| GET | `/leaderboard/annual` | ❌ 404 — path needs more segments |

### User / Account — none of the guessed paths work

`customer`, `user`, `users/me`, `profile`, `account` all return 404. The user/profile data
likely lives on `automotive.garmin.com` (intercepted requests visible in Charles but
cert-pinned so headers aren't readable) or via the SSO/profile endpoints on `services.garmin.com`.

---

## Confirmed Response Field Names

### From real `--probe` responses

**session-track-days record:**
```
trackCartographyId, trackName, isCustomFacility, trackConfigurationId, isCustomConfig,
trackIsReverse, trackDirection, trackConfigurationName, trackDate,
trackTimeZoneOffsetSeconds, trackDateTimeStart, trackDateTimeEnd,
bestLapDuration ("PT2M13.967S"), bestLapDurationNormal
```

**trackFacilities record:**
```
trackCartographyId, trackName, sessionCount
```

**trackConfigurations record:**
```
trackCartographyId, trackName, trackConfigurationId, trackConfigurationName,
trackIsReverse, sessionCount
```

### From `libgecko.so` string constants (unverified field names)

**GPS / Position**
- `gpsLatitude`, `gpsLongitude`, `gpsTimestamp`
- `altitudeMeters`, `gnss_altitude_m`, `topo_altitude_m`, `avg_altitude_m`
- `gnss_heading_deg`, `gnss_heading_deriv_dps`
- `lateral_position` — lateral position on track relative to meanline
- `meanline_guid` — GUID of the reference line for this track config

**Speed**
- `speed`, `gnss_speed_mps`, `speed_kph`, `speed_mph`
- `max_speed_mps`, `min_speed_mps`, `avg_speed_mps`

**Acceleration / G-Forces**
- `acceleration`, `acceleration_g` — longitudinal G (braking/acceleration)
- `cornering_g` — lateral G-force

**Lap Timing**
- `bestLapDurationNormal` ✅ (confirmed) — best lap time
- `bestLapNormal` — best lap identifier
- `optimalLap`, `optimalLapInfo` — composite optimal lap
- `optimal_lap_video_guid` — video file GUID
- `lap_distance`, `lap_number`, `number_of_laps`
- `start_time_session_ms`, `start_time_utc_s`
- `relativeTime`

**Session Metadata**
- `startTime`, `endTime`, `startDateTime`, `endDateTime`
- `track_name`, `track_condition` (dry/wet/mixed)
- `windSpeed`
- `track_cartography_id` ✅ (matches `trackCartographyId` we see)

---

## Push / Streaming Channels

```
https://geckobackchannel.gcs.garmin.com/proto
```

Channel topic names observed in libgecko.so:
- `autosport.session.meanline.detail`
- `autosport.session.performance.detail`
- `autosport.session.optimallap.detail`
- `gcs.autosport.request`

Live device sync — not needed for historical pull.

---

## Reverse-Engineering Roadmap (what's still blocked)

The cleanest path forward is to capture real `/sessions` and `/session` request URLs from
the running Android app. Roadblocks tried so far:

| Approach | Result |
|----------|--------|
| Charles/mitmproxy on iOS | SSL pinning blocks |
| Charles on Android emulator + APEX cacert overlay | Works for Java traffic, but `libgecko.so` has its OWN baked-in cert store and ignores Android's system CA — every autosport request comes from libcurl inside libgecko |
| OkHttp `CertificatePinner` patching | Pin set is empty — not the source of pinning |
| apk-mitm recompile | libgecko.so verifies its own certs, can't be patched without binary rewriting |
| Pull `CredentialStore.xml` from rooted emulator | Token is encrypted with Android Keystore — can't decrypt outside the app process |

**Best next options**:

1. **Frida hook on `libgecko.so`** to dump every libcurl HTTP request. This bypasses the
   SSL pinning entirely (we see plaintext before TLS).
2. **Grep further in libgecko.so** for protobuf field names mentioning `Sort_t` enum values
   — the values `START_TIME` / `TRACK_NAME` / `BEST_LAP_TIME` may appear as string consts.
3. **String-search the Java code** under `/sources/p4/` and `/sources/p3/` — Kotlin
   classes like `CompareSessionsViewModel` reference session list APIs and may construct
   URLs with parameter names in plain text after JADX decompilation.

---

## How to Capture a Real Auth Token (legacy notes)

If the SSO ticket flow ever stops working, you can capture a token manually:

1. Install **mitmproxy** (`brew install mitmproxy`) on your Mac
2. Set your phone to use your Mac as an HTTP proxy (port 8080)
3. Install mitmproxy's CA cert on the phone (visit `mitm.it`)
4. Open the Catalyst app and tap sync
5. Filter for `api.gcs.garmin.com` in mitmproxy — capture the `Authorization: Bearer ...` header

Note: this **fails on iOS** (more aggressive pinning) and **fails for native libgecko.so
requests on Android** (own SSL stack). You may only see the Java-side OkHttp traffic.
The captured token can be passed to the client with `--token <raw>` to skip the SSO flow.

---

## File Layout

```
garmin/
├── README.md              — this file
├── requirements.txt       — Python dependencies
├── catalyst_client.py     — main data fetching script
├── config.json            — credentials and settings (gitignored)
├── .garth/                — garth OAuth tokens (gitignored)
├── .catalyst_token.json   — cached 90-day Catalyst token (gitignored)
└── data/
    ├── probe/             — raw probe-mode responses for endpoint discovery
    ├── sessions_index.json
    └── sessions/
        └── <session-guid>/
            ├── session_detail.json
            ├── mean_line.json
            └── leaderboard.json
```

`config.json` is gitignored. Copy `config.example.json` to create it.

### Running

After `pip install -e .` from the repo root, four console scripts are on PATH:

```bash
catalyst-fetch              # Download all sessions (resume-safe)
catalyst-fetch --probe      # Hit each endpoint, write raw responses to data/probe/
catalyst-fetch --list       # Table of all sessions (GUID, date, track, best lap)
catalyst-fetch --session GUID
catalyst-fetch --clear-tokens

catalyst-decode data/sessions/<guid>/performance.pb --inspect
catalyst-decode data/mean_lines/<guid>.pb --inspect

catalyst-load               # Decode all .pb and ingest into data/catalyst.duckdb

catalyst-corners data/mean_lines/<guid>.pb   # Generate tracks/<config>.yaml
catalyst-prompt --last 5 --scope overview    # Generate coaching brief
catalyst-prompt --session GUID --scope corner

catalyst-gui                # PySide6 desktop app — sync + browse + edit setup
```

### Track reference data — `tracks/`

Each track configuration gets a `tracks/<config>.yaml` file containing:

- **Garmin's official 10 reference segments**, extracted from the meanline
  protobuf field 7. These are the recommended unit for sector-level pacing
  analysis (one segment can span multiple corners — e.g. VIR Full S4 covers
  both the Snake and the Climbing Esses).
- **Canonical named corners**, in driving order. Names sourced from Wikipedia,
  RacingCircuits.info, and the Race Track Driving (formerly Win HPDE) guide.
  Apex positions are detected from GPS curvature on the meanline; dist_idx
  ranges align with the per-sample dist_idx in performance.pb.

Garmin doesn't ship turn names — the API only returns the config name
(`"Full Course"`). The named corner list is compiled and verified manually
against public driver guides.

### Coaching briefs — `coaching/`

`catalyst-prompt` generates self-contained markdown briefs (~80–200 KB) for
LLM-based analysis. The brief inlines:

- Car/driver context (`lotus/Lotus.md`)
- Driver improvement + setup + track-specific guides (`lotus/*.md`)
- Track reference (segments + corners from `tracks/<config>.yaml`)
- Sessions table, per-lap aggregates, **per-segment estimated splits**,
  per-corner downsampled telemetry traces (in `--scope corner` mode)
- Field-label heuristics for the still-unlabeled `f4`..`f15` floats
- A "Your task" instruction block prescribing the LLM's output format

The LLM writes its analysis to `coaching/<YYYY-MM-DD>-<topic>.md`. From the
GUI: **Home → Generate coaching brief**.

## GUI (catalyst_gui/)

PySide6 desktop app with three pages:

- **Home** — account, sync status, token expiry, total data, last-sync time, big
  "Sync now" button. Background worker runs the SSO flow and reports progress.
- **Sessions** — sortable table from DuckDB: date, track, config, best lap,
  laps, sample count, weather. Falls back to disk-scan when DB isn't loaded.
- **Garage** — markdown viewer/editor for files in `../lotus/` (Lotus.md plus
  setup guides). Same files will feed the LLM coach later.

Sync runs `garmin.catalyst_client.fetch_all_sessions` on a `QThread`, captures
stdout via a `_StreamToSignal`, and pipes lines to the status bar.

Run with `catalyst-gui` (or `python -m catalyst_gui`).
