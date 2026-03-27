# Garmin Catalyst Data Extraction Research

## Background

The Garmin Catalyst captures rich telemetry and video data during track sessions, but Garmin restricts access to this data through their proprietary mobile app. This document catalogs research into extracting session data for independent analysis.

## What the Catalyst Captures

### Sensor Data
- **GPS**: 10 Hz on Gen 1, 25 Hz on Catalyst 2
- **Accelerometer**: Multi-axis, records lateral G-forces, longitudinal acceleration/braking
- **Gyroscope**: Rotational data
- **Camera**: 1080p @ 30fps (Gen 1), 1440p (Catalyst 2), ~9 Mbit/s bitrate
- **OBD-II**: Vehicle speed, RPM, etc. (when connected)

### Derived Data
- Lap times, sector/segment times
- Adaptive delta time vs. best lap
- vMin/vMax per corner
- Racing line / track positioning
- "True Optimal Lap" (composite of best segments)
- Corner-by-corner performance correlation

---

## Current Data Access Situation

### FIT Files Removed in Firmware 5.30

**This is the root problem.** Prior to firmware version 5.30 (released ~April 2023), the Catalyst wrote standard Garmin FIT (Flexible and Interoperable Data Transfer) binary files to its internal storage. These could be copied via USB and parsed with standard tools.

Starting with firmware 5.30, Garmin intentionally removed FIT file creation. A Garmin support ticket confirmed: **"The .fit files have been removed by design."**

- Forum post reporting the change: [Garmin Forums - FIT Files Removed in 5.30](https://forums.garmin.com/developer/fit-sdk/f/discussion/331182/catalyst-fit-files-removed-in-software-version-5-30) (April 22, 2023)
- No firmware downgrade method has been confirmed for the Catalyst
- Community reaction has been strongly negative

### Current Data Flow
```
Catalyst Device --[Wi-Fi]--> Garmin Cloud (Google Cloud) --[API]--> Catalyst Mobile App
```

- Data syncs from device to Garmin's cloud via Wi-Fi
- The mobile app reads from the cloud — there is no direct device-to-phone transfer of session data
- Video does NOT sync wirelessly (Gen 1); Catalyst 2 adds optional Vault cloud video ($9.99/month)
- **No web portal exists** — data is accessible only through the mobile app

### Catalyst is Separate from Garmin Connect

The Catalyst ecosystem is completely isolated from Garmin Connect:
- Uses **Google Cloud** infrastructure, not the traditional Garmin Connect backend
- Does not appear in Garmin Connect at all
- The `python-garminconnect` package (127+ endpoints) has zero Catalyst/motorsport endpoints
- No other Garmin API library (Garth, Garmy, garminexport) has Catalyst support

---

## Approach 1: Intercept the Catalyst App's API Traffic (Most Promising)

Since the Catalyst app communicates with Garmin's cloud to fetch session data, intercepting that traffic would reveal the API endpoints, authentication scheme, and data format.

### What We Know About the App
- **Android package**: `com.garmin.android.driveapp.catalyst` (~98.5 MB)
- **Available on**: [APKMirror](https://www.apkmirror.com/apk/garmin/garmin-catalyst/) (latest ~v2.03.40)
- **Auth**: Almost certainly uses Garmin SSO (`sso.garmin.com`), same as all Garmin products
- **SSL Pinning**: Garmin apps likely implement certificate pinning, requiring bypass tooling
- **Data format**: Possibly protobuf (Garmin uses protobuf extensively in device communication per the Gadgetbridge project), or REST/JSON

### Setup Required
1. **Rooted Android device or emulator** — needed to install Frida and bypass SSL pinning
2. **mitmproxy** or **Burp Suite** — to intercept HTTPS traffic
3. **Frida** — runtime instrumentation framework for SSL pinning bypass
   - Best current unpinning scripts: [httptoolkit/frida-interception-and-unpinning](https://github.com/httptoolkit/frida-interception-and-unpinning)
4. **The Catalyst APK** from APKMirror

### Steps
1. Set up a rooted Android emulator (e.g., Android Studio AVD with Google APIs, then root with Magisk)
2. Install mitmproxy and configure the emulator to use it as proxy
3. Install the mitmproxy CA certificate on the device
4. Install Frida server on the device
5. Install the Catalyst APK
6. Run Frida with SSL unpinning scripts targeting `com.garmin.android.driveapp.catalyst`
7. Log into the app and trigger a data sync
8. Capture and analyze the API calls in mitmproxy

### What to Look For
- API base URL(s) — likely a Google Cloud domain
- Authentication headers (Bearer token, cookies, etc.)
- Session list endpoint
- Individual session data endpoint (telemetry, lap times, etc.)
- Data format (JSON, protobuf, FIT-over-HTTP)
- Pagination patterns
- Rate limiting

### Risks / Challenges
- Garmin may use advanced anti-tampering beyond basic SSL pinning
- ProGuard/R8 obfuscation may make the app harder to instrument
- The app may require a real Catalyst device paired to the account to show data
- Garmin could change APIs at any time

---

## Approach 2: Decompile the APK (Complementary to Approach 1)

Static analysis of the APK can reveal API endpoints without needing to run the app.

### Tools
- **[JADX](https://github.com/skylot/jadx)** — decompiles APK to readable Java source
- **apktool** — for resource extraction and manifest analysis

### What to Look For
1. `network_security_config.xml` — certificate pinning configuration, trusted CAs
2. **Retrofit/OkHttp endpoint definitions** — Garmin likely uses Retrofit for REST calls; grep for `@GET`, `@POST`, `@PUT`, base URL strings
3. **Hardcoded API URLs** — search for `https://`, `api.`, `cloud.`, `garmin.com`
4. **Protobuf `.proto` definitions** — if the app uses protobuf, schema files may be embedded
5. **Authentication flow** — SSO login URL, token storage, refresh logic
6. **Data models** — Java/Kotlin classes representing session data, lap data, telemetry

### Challenges
- ProGuard/R8 obfuscation renames classes and methods
- API URLs may be constructed dynamically rather than hardcoded
- Protobuf messages may be compiled into Java code without human-readable field names

---

## Approach 3: Network-Level Discovery (Low Effort, Limited Results)

Without rooting or decompiling, you can still discover which servers the app talks to.

### DNS Monitoring
- Use your router's DNS logging or a tool like Pi-hole to see which domains the Catalyst app resolves
- Also useful during device Wi-Fi sync — the Catalyst itself contacts Garmin's cloud

### Wireshark
- Capture traffic on the same network during a sync
- Won't see request/response content (TLS encrypted) but will show destination IPs and SNI hostnames

### What This Gets You
- The domain names and IP addresses of Garmin's Catalyst backend
- Timing and frequency of API calls
- Rough request/response sizes (may hint at data format)

---

## Approach 4: Garmin SSO Authentication (Building Block)

Regardless of which approach discovers the API endpoints, authentication will be needed. The Garmin SSO flow is already well-understood:

### Known Auth Infrastructure
- **SSO endpoint**: `sso.garmin.com`
- **Protocol**: OAuth 2.0 PKCE ([Garmin spec](https://developerportal.garmin.com/sites/default/files/OAuth2PKCE_1.pdf))
- **Token type**: JWT Bearer tokens with companion `JWT_FGP` cookie
- **Token refresh**: `POST https://connect.garmin.com/services/auth/token/refresh`
- **Headers**: `Authorization: Bearer {token}`, `Cookie: JWT_FGP={value}`, `DI-Backend: connectapi.garmin.com`

### Existing Libraries
- **[Garth](https://github.com/matin/garth)** — Python library that implements the full Garmin SSO flow, supports OAuth1 tokens (~1 year validity) with auto-refresh
- **[python-garminconnect](https://github.com/cyberjunky/python-garminconnect)** — wraps Garth for Garmin Connect API access
- These handle auth but have zero Catalyst endpoints — we'd need to add our own once discovered

### Open Question
The Catalyst app may authenticate through the same SSO flow but then hit a completely different API backend (Google Cloud). The auth tokens from Garth may or may not be accepted by the Catalyst backend. This needs to be verified.

---

## Existing Community Workarounds

People frustrated by the data lockdown have built creative alternatives:

### ApexSense
- **Repo**: [shaboinkin90/ApexSense](https://github.com/shaboinkin90/ApexSense)
- Uses **computer vision** on Catalyst video overlays to extract G-force data
- Motivation: "Garmin does not provide the raw data generated by Catalyst"

### OpenLapEVA
- **Repo**: [laekov/OpenLapEVA](https://github.com/laekov/OpenLapEVA)
- Open-source lap time extraction and analysis from Catalyst video files

### RaceRender 3
- Commercial tool that can read FIT files directly for video overlay
- Only useful if you have pre-5.30 FIT files

---

## FIT File Parsing Tools (For If/When We Get Data)

Once API endpoints are discovered, the data may come back in FIT format or a similar telemetry format. Tools for parsing:

### Official
- **[Garmin FIT SDK](https://developer.garmin.com/fit/)** — C, C++, C#, Java, JavaScript, Objective-C, Python, Swift
- **FitCSVTool** — CLI bundled with the SDK, converts FIT to CSV
- **Profile.xlsx** — reference for all FIT message types and fields

### Python
- **[garmin-fit-sdk](https://github.com/garmin/fit-python-sdk)** — official Python SDK (`pip install garmin-fit-sdk`)
- **[python-fitparse](https://github.com/dtcooper/python-fitparse)** — community library (`pip install fitparse`)

### Analysis
- **MegaLog** — recommended by the Rennlist community for CSV graphing of Catalyst data
- **RaceRender 3** — reads FIT natively for video overlay
- **[Telemetry Overlay](https://goprotelemetryextractor.com/tools-for-garmin-fit)** — commercial, supports FIT files

---

## Recommended Next Steps

1. **Start with APK decompilation** (Approach 2) — lowest barrier to entry, no special hardware needed. Download the APK from APKMirror, run JADX, search for API URLs and endpoint definitions.

2. **Set up traffic interception** (Approach 1) — this will give us the actual API calls with real request/response data. Requires more setup but produces the most actionable results.

3. **Use Garth for authentication** (Approach 4) — once we know the API endpoints, Garth gives us a ready-made auth flow.

4. **Build a Python client** — once endpoints and auth are understood, build a simple client to download session data for local analysis.

---

## Key Resources

### Forums & Community
- [Rennlist - Garmin Catalyst Technical Hacks](https://rennlist.com/forums/data-acquisition-and-analysis-for-racing-and-de/1325046-garmin-catalyst-technical-hacks.html) — deepest technical discussion
- [Garmin Forums - FIT Files Removed in 5.30](https://forums.garmin.com/developer/fit-sdk/f/discussion/331182/catalyst-fit-files-removed-in-software-version-5-30)
- [Garmin Forums - Finding Segment Data in Catalyst FIT Files](https://forums.garmin.com/developer/fit-sdk/f/discussion/317794/finding-segment-data-within-a-garmin-catalyst-fit-file)

### Tools & Libraries
- [Garth (Garmin SSO)](https://github.com/matin/garth)
- [Frida SSL Unpinning](https://github.com/httptoolkit/frida-interception-and-unpinning)
- [JADX Decompiler](https://github.com/skylot/jadx)
- [Garmin FIT SDK](https://developer.garmin.com/fit/)
- [ApexSense (CV workaround)](https://github.com/shaboinkin90/ApexSense)
- [OpenLapEVA (video extraction)](https://github.com/laekov/OpenLapEVA)

### Garmin Documentation
- [Garmin Catalyst Owner's Manual](https://www8.garmin.com/manuals/webhelp/GUID-16C78876-E016-40FD-8A0A-049BA52B462B/EN-US/)
- [Garmin FIT SDK Overview](https://developer.garmin.com/fit/overview/)
- [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/)
- [Garmin OAuth2 PKCE Spec](https://developerportal.garmin.com/sites/default/files/OAuth2PKCE_1.pdf)
- [Garmin Catalyst APK on APKMirror](https://www.apkmirror.com/apk/garmin/garmin-catalyst/)
- [Garmin Unofficial API Wiki](https://wiki.brianturchyn.net/programming/apis/garmin/)
