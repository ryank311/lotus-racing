# Catalyst Coach

TypeScript/Electron port of the Python `catalyst_gui` + `garmin/` pipeline.
Pulls Garmin Catalyst session telemetry, loads it into DuckDB, generates
coaching briefs, and shows everything in a React-based desktop UI.

## Run

```bash
npm install
npm run dev          # launches Vite + Electron
```

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
