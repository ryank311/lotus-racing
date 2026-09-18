#!/bin/bash
# Run the complete browser app through a temporary, private Tailscale endpoint.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: bash deploy/test-tailscale-mac.sh

Install Tailscale on your Mac and phone, and connect both to the same account.
This builds the app, runs its headless server, and starts private HTTPS sharing.
Open the URL Tailscale prints on your phone. Ctrl+C stops sharing and the app.
Test data is retained in deploy/data/tailscale-mac between runs.

Optional environment variables:
  CATALYST_TEST_PORT        Local HTTP port (default 3211)
  CATALYST_TEST_HTTPS_PORT  Tailscale HTTPS port (default 8443)
  CATALYST_TEST_DATA_DIR    Absolute path to a separate test workspace
  TAILSCALE_BIN            Path to the Tailscale CLI
HELP
  exit 0
fi
[[ $# -eq 0 ]] || { echo 'Use --help for usage.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'This helper is for macOS.' >&2; exit 1; }
command -v node >/dev/null && command -v npm >/dev/null || {
  echo 'Install Node.js 22 or newer, then run this script again.' >&2; exit 1;
}
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required"); process.exit(1) }'

if [[ -n "${TAILSCALE_BIN:-}" ]]; then
  TS_BIN="$TAILSCALE_BIN"
elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  TS_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale
elif [[ -x "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
  TS_BIN="$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"
elif command -v tailscale >/dev/null; then
  TS_BIN="$(command -v tailscale)"
else
  echo 'Install and open Tailscale: https://tailscale.com/download/mac' >&2
  echo 'Sign in on your Mac and phone using the same account, then rerun this script.' >&2
  exit 1
fi
"$TS_BIN" status --json | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (s.BackendState !== "Running") {
    console.error("Open Tailscale, sign in, and connect this Mac before continuing."); process.exit(1);
  }
'

HTTP_PORT="${CATALYST_TEST_PORT:-3211}"
HTTPS_PORT="${CATALYST_TEST_HTTPS_PORT:-8443}"
DATA_DIR="${CATALYST_TEST_DATA_DIR:-$APP_DIR/deploy/data/tailscale-mac}"
[[ "$DATA_DIR" == /* ]] || { echo 'CATALYST_TEST_DATA_DIR must be an absolute path.' >&2; exit 1; }
node - "$HTTP_PORT" "$HTTPS_PORT" <<'NODE'
for (const value of process.argv.slice(2)) {
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error('Use port numbers between 1024 and 65535');
}
const server = require('node:net').createServer();
server.on('error', () => { console.error('Local port is busy. Set CATALYST_TEST_PORT to another port.'); process.exit(1); });
server.listen(Number(process.argv[2]), '127.0.0.1', () => server.close());
NODE

# Avoid changing a Serve/Funnel endpoint that was already configured by the user.
"$TS_BIN" serve status --json | node -e '
  const config = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const port = process.argv[1];
  function usesPort(value) {
    return value && typeof value === "object" && Object.entries(value).some(([key, child]) =>
      key === port || key.endsWith(":" + port) || usesPort(child));
  }
  if (usesPort(config)) {
    console.error("Tailscale already uses port " + port + ". Set CATALYST_TEST_HTTPS_PORT to another port."); process.exit(1);
  }
' "$HTTPS_PORT"

cd "$APP_DIR"
if [[ ! -d node_modules ]]; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
fi
npm run build
umask 077
mkdir -p "$DATA_DIR"
LOG_FILE="$DATA_DIR/server.log"
SERVER_PID=''
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo "Test stopped. Saved data remains in: $DATA_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

NODE_ENV=production node dist-main/main/headless.js \
  --host 127.0.0.1 --port "$HTTP_PORT" --data-dir "$DATA_DIR" >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
# Keep the Mac awake during the test (leave the lid open).
/usr/bin/caffeinate -i -w "$SERVER_PID" &
READY=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "App failed to start. See $LOG_FILE" >&2; exit 1
  fi
  if curl --noproxy '*' --fail --silent --max-time 1 "http://127.0.0.1:$HTTP_PORT/api/health" >/dev/null; then
    READY=true; break
  fi
  sleep 1
done
[[ "$READY" == true ]] || { echo "Startup timed out. See $LOG_FILE" >&2; exit 1; }
cat <<INFO

App ready: http://127.0.0.1:$HTTP_PORT
Saved test data: $DATA_DIR
Server log: $LOG_FILE

1. If prompted below, follow Tailscale's link to enable HTTPS.
2. On your phone, connect Tailscale and turn OFF Wi-Fi to test over cellular.
3. Open the https:// URL printed below. Enter a driver name and sign into Garmin.
4. Save something in Garage; stop and rerun this script, then use the same driver
   name to confirm your data is still there.

Keep this terminal open and your Mac's lid open. Press Ctrl+C when finished.
Sharing is private to your Tailscale network; this app uses a passwordless driver selector.

INFO
# Foreground Serve is temporary: exiting it removes this test's sharing session.
"$TS_BIN" serve --https="$HTTPS_PORT" "http://127.0.0.1:$HTTP_PORT"
