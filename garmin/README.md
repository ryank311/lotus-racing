# Garmin Catalyst API — Reverse Engineering Notes & Data Pipeline

## Background

The Garmin Catalyst is a dedicated motorsport coaching device. Garmin intentionally removed FIT file
export in firmware 5.30 (April 2023). The device is fully isolated from Garmin Connect — it runs on
a separate cloud backend called GCS (Garmin Cloud Services). There is no official public API.

This folder documents the API discovered by decompiling the Android APK
(`com.garmin.android.driveapp.catalyst_2.02.25`) using JADX and `strings` analysis of the native
library `libgecko.so`.

---

## API Architecture

### Base URL

```
Production:  https://api.gcs.garmin.com/
Staging:     https://api.gcs.stage.garmin.com/
Test:        https://api.gcs.test.garmin.com/
```

All Catalyst telemetry data lives under the `autosport` service path:

```
https://api.gcs.garmin.com/autosport/api/v1/
```

### Authentication

Garmin SSO, standard OAuth2 Bearer token flow.

```
SSO (production): https://sso.garmin.com
SSO (staging):    https://ssostg.garmin.com
Token endpoint:   https://sso.garmin.com/sso/oauth2/token  (or /auth/o2/token)
```

The app uses OAuth2 PKCE (`grant_type=authorization_code` + `code_verifier`). After login, you
receive an `access_token`, `refresh_token`, and a `customerId` (your Garmin account UUID).

All API requests send:
```
Authorization: Bearer <access_token>
```

Additional headers observed in the APK (values unknown until traffic capture):
```
X-Garmin-Client-Id:        <app client ID>
X-Garmin-Client-Platform:  Android
X-Garmin-Unit-Id:          <device unit ID>
```

The `python-garminconnect` library (`pip install garminconnect`) implements the full Garmin SSO
flow and handles token refresh automatically. Under the hood it wraps `garth`, which is the
actual auth + HTTP backend.

### How auth works in our client

1. **First run**: prompts for credentials (and MFA code if your account has it enabled), logs in
   via garth, and saves OAuth1 + OAuth2 tokens to `garmin/.garth/`.
2. **Subsequent runs**: loads tokens from `.garth/`. The OAuth2 refresh token is good for ~1 year,
   so the access token auto-refreshes on use — no re-login until the refresh token itself expires.
3. **API requests** go through `garmin.garth.request("GET", "api.gcs", path, api=True)`, which
   targets `https://api.gcs.garmin.com/` (not the standard `connectapi.garmin.com`) and attaches
   the Bearer token automatically.

### Cloudflare User-Agent workaround

Garmin's Cloudflare setup blocks garth's default mobile User-Agent (`GCM-iOS-...`). The client
overrides it with a desktop Chrome UA before calling `login()`:

```python
garmin.garth.sess.headers.update({"User-Agent": "Mozilla/5.0 ... Chrome/131.0.0.0 ..."})
```

Without this override, login fails with a Cloudflare challenge. See
[matin/garth issue #217](https://github.com/matin/garth/issues) for the upstream tracker.

---

## REST Endpoints

All endpoints are under `https://api.gcs.garmin.com/autosport/api/v1/`.

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List all sessions (paginated) |
| GET | `/sessions/count` | Total number of sessions |
| GET | `/sessions/metadata` | Metadata for sessions (dates, tracks) |
| GET | `/session` | Single session detail (pass `?sessionId=<guid>`) |
| GET | `/session-track-days` | Sessions grouped by track day |
| GET | `/session-track-days/count` | Count of track days |

**Likely query parameters** (observed as filter fields in the app):
- `sessionId` — GUID of a specific session
- `filterStartDateTime` — ISO8601 start filter
- `filterEndDateTime` — ISO8601 end filter
- `filterTrackConfigurationId` — filter by track layout
- `filterTrackIsReverse` — boolean, reverse config
- `limit` — page size
- `offset` — pagination offset

### Telemetry / Lap Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/meanLine` | Reference GPS lap line (the "mean" driven line) |

The following appear to be sub-resource identifiers or filter values for detailed telemetry.
Their exact query param structure needs to be confirmed via traffic capture:
- `autosport.session.meanline.detail` — GPS point-by-point path data
- `autosport.session.performance.detail` — per-lap performance metrics
- `autosport.session.optimallap.detail` — composite optimal lap data

### Track Info

| Method | Path | Description |
|--------|------|-------------|
| GET | `/track` | Track info |
| GET | `/trackConfigurations` | Track layout variants (full, partial, reverse) |
| GET | `/trackFacilities` | Track venue info |
| GET | `/trackFacilities/count` | Count |

### Leaderboards

| Method | Path | Description |
|--------|------|-------------|
| GET | `/leaderboard/session` | Leaderboard for a session |
| GET | `/leaderboard/day` | Daily leaderboard |
| GET | `/leaderboard/annual` | Annual leaderboard |

### User / Account

| Method | Path | Description |
|--------|------|-------------|
| GET | `/user` | User profile |
| GET | `/customer` | Customer/account data (contains your `customerId`) |
| GET | `/connections` | Friends/connections list |
| GET | `/connections/count` | Count |
| GET | `/connection` | Single connection detail |
| GET | `/image` | Profile/session image |

---

## Confirmed Response Data Fields

These field names were extracted from string constants in `libgecko.so`:

### GPS / Position
- `gpsLatitude`, `gpsLongitude`, `gpsTimestamp`
- `altitudeMeters`, `gnss_altitude_m`, `topo_altitude_m`, `avg_altitude_m`
- `gnss_heading_deg`, `gnss_heading_deriv_dps`
- `lateral_position` — lateral position on track relative to meanline
- `meanline_guid` — GUID of the reference line for this track config

### Speed
- `speed`, `gnss_speed_mps`, `speed_kph`, `speed_mph`
- `max_speed_mps`, `min_speed_mps`, `avg_speed_mps`

### Acceleration / G-Forces
- `acceleration`, `acceleration_g` — longitudinal G (braking/acceleration)
- `cornering_g` — lateral G-force

### Lap Timing
- `bestLapDurationNormal` — best lap time (normal direction)
- `bestLapNormal` — best lap identifier
- `optimalLap`, `optimalLapInfo` — composite optimal lap
- `optimal_lap_video_guid` — video file GUID for the optimal lap
- `lap_distance` — lap distance
- `lap_number` — lap index
- `number_of_laps`
- `start_time_session_ms`, `start_time_utc_s`
- `relativeTime` — time delta vs reference

### Session Metadata
- `startTime`, `endTime`, `startDateTime`, `endDateTime`
- `track_name`, `track_condition` (dry/wet/mixed)
- `windSpeed`
- `track_cartography_id`

---

## Push / Streaming Channels (GCS Backchannel)

Separate from the REST API, the app subscribes to live data over a persistent connection:
```
https://geckobackchannel.gcs.garmin.com/proto
```

Channel topic names observed:
- `autosport.session.meanline.detail`
- `autosport.session.performance.detail`
- `autosport.session.optimallap.detail`
- `gcs.autosport.request`

These are used for real-time sync when the app is connected to the device. For historical data
pull, the REST endpoints above are sufficient.

---

## How to Capture a Real Auth Token (Recommended First Step)

The easiest way to get a working Bearer token without a rooted device is a proxy cert on your
real phone:

1. Install **mitmproxy** (`brew install mitmproxy`) or **Charles Proxy** on your Mac
2. Set your iPhone/Android to use your Mac's IP as an HTTP proxy (port 8080)
3. Install the proxy's CA certificate on your phone (mitmproxy: visit `mitm.it` on the device)
4. Open the Catalyst app and tap sync / browse your sessions
5. In mitmproxy, filter for `api.gcs.garmin.com` — capture the `Authorization: Bearer ...` header
6. Also capture the `X-Garmin-Client-Id` and `X-Garmin-Unit-Id` header values
7. Plug those values into `config.json` (see below)

Tokens appear to be long-lived (the app stores a refresh token). Garth can also generate tokens
directly using your Garmin username/password — try that first before the proxy approach.

---

## File Layout

```
garmin/
├── README.md              — this file
├── requirements.txt       — Python dependencies
├── catalyst_client.py     — main data fetching script
├── config.json            — credentials and settings (gitignored)
└── data/
    └── sessions/
        └── <session-guid>/
            ├── metadata.json      — session overview
            ├── laps.json          — lap times and per-lap stats
            ├── telemetry.json     — GPS + speed + G-force trace
            └── optimal_lap.json   — optimal lap composition
```

`config.json` is gitignored and never committed. Copy `config.example.json` to create it.
