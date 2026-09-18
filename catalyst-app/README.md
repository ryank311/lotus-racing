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

## Test Garmin SSO

The Garmin sign-in dialog offers **Email / password** (the existing flow) and
**Garmin SSO** (experimental). Select that tab, then choose **Continue with
Garmin**. No email or password is required in the Catalyst dialog; choose your
account and complete any verification on Garmin's own page in the new window.
The connection uses a generic **Garmin SSO** label. A successful return closes
the dialog and starts the usual recent-session sync.

SSO works through a browser popup in web/server mode, including the packaged
desktop app, or an isolated Garmin window in desktop development mode. Allow
popups for Catalyst Coach. In web mode, use Cancel in the Catalyst dialog to
abandon an attempt; in desktop development, close the Garmin window. Pending
attempts expire after ten minutes. If a ticket is already being exchanged,
cancellation waits for that exchange to finish. Server restarts invalidate
pending attempts. The callback uses the same public API origin you opened, so
reverse proxies must forward `/api/auth/garmin/*` along with the other API paths.

This uses Garmin's hosted Catalyst-compatible SSO widget and existing Catalyst
ticket grant. Garmin still controls which challenges or existing sessions it
accepts; actual account authentication and ticket issuance require a manual
test. If it fails, the original email/password option remains available.

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

## CLI scripts (run individually without the GUI)

```bash
npm run fetch        # pull all sessions from Garmin
npm run load         # load downloaded JSON+protobuf into DuckDB
npm run corners      # detect corners on a meanline
npm run brief -- --last 5         # generate a coaching brief
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

Anthropic offers Fable 5.1 (`claude-fable-5-1`), Opus 5 (`claude-opus-5`),
Sonnet 5 (`claude-sonnet-5`), and Haiku 4.5 (`claude-haiku-4-5-20251001`).
Older saved Opus/Sonnet selections are upgraded within their family.
OpenAI supports Astra (`gpt-6-astra`), Sol (`gpt-5.6-sol`), and Terra
(`gpt-5.6-terra`) through the Responses API with x-high reasoning.
