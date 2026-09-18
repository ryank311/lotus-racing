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
the API key for that provider. Provider keys are saved only in the local
`garmin/config.json` (which is gitignored); no keys are bundled in the app or
source. OpenAI supports Astra (`gpt-6-astra`), Sol (`gpt-5.6-sol`), and Terra
(`gpt-5.6-terra`) through the Responses API with x-high reasoning.
