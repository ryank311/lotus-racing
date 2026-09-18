#!/bin/bash
# Pull the published NAS image and serve it through a configured Cloudflare Tunnel.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == --help ]]; then
  cat <<'HELP'
Usage: bash deploy/test-cloudflare-mac.sh

First install/open Docker Desktop, then follow deploy/CLOUDFLARE.md to configure
your domain, email access policy, tunnel, and deploy/.env.cloudflare.
Every run pulls ghcr.io/ryank311/catalyst-coach:latest; no local app build runs.
Ctrl+C removes the test containers while preserving all app data.

Optional environment variables:
  CATALYST_TEST_PORT        Local HTTP port (default 3211)
  CATALYST_TEST_DATA_DIR    Absolute path to a separate test workspace
  CATALYST_CLOUDFLARE_ENV   Absolute path to the Cloudflare environment file
HELP
  exit 0
fi
[[ $# -eq 0 ]] || { echo 'Use --help for usage.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'This helper is for macOS.' >&2; exit 1; }
# Include Desktop's credential helpers even when only docker was linked into PATH.
for desktop_bin in /Applications/Docker.app/Contents/Resources/bin "$HOME/Applications/Docker.app/Contents/Resources/bin"; do
  if [[ -d "$desktop_bin" ]]; then
    export PATH="$PATH:$desktop_bin"
  fi
done
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || {
  echo 'Install Docker Desktop (including Docker Compose), then open it and rerun.' >&2; exit 1;
}
docker info >/dev/null 2>&1 || { echo 'Start Docker Desktop, wait until it is ready, then rerun.' >&2; exit 1; }

ENV_FILE="${CATALYST_CLOUDFLARE_ENV:-$DEPLOY_DIR/.env.cloudflare}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Copy $DEPLOY_DIR/.env.cloudflare.example to $ENV_FILE and fill in your hostname and tunnel token." >&2
  echo "Configure email sign-in first, following $DEPLOY_DIR/CLOUDFLARE.md" >&2
  exit 1
fi
HTTP_PORT="${CATALYST_TEST_PORT:-3211}"
DATA_DIR="${CATALYST_TEST_DATA_DIR:-$DEPLOY_DIR/data/cloudflare-mac}"
[[ "$DATA_DIR" == /* && "$DATA_DIR" != / ]] || { echo 'Use an absolute test data directory, not /.' >&2; exit 1; }
[[ "$HTTP_PORT" =~ ^[1-9][0-9]{3,4}$ ]] && (( HTTP_PORT >= 1024 && HTTP_PORT <= 65535 )) || {
  echo 'CATALYST_TEST_PORT must be between 1024 and 65535.' >&2; exit 1;
}
IMAGE=ghcr.io/ryank311/catalyst-coach:latest
compose() {
  CATALYST_IMAGE="$IMAGE" CATALYST_NAS_DATA_DIR="$DATA_DIR" CATALYST_HTTP_PORT="$HTTP_PORT" \
    docker compose --project-name catalyst-cloudflare-mac --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/compose.yaml" -f "$DEPLOY_DIR/compose.cloudflare.yaml" "$@"
}
# Validate without printing the resolved configuration, which includes a secret.
compose config --quiet
if [[ -n "$(compose ps --status running -q)" ]]; then
  echo 'The Mac Cloudflare test is already running. Stop it in its original terminal first.' >&2
  exit 1
fi
if /usr/sbin/lsof -nP -iTCP:"$HTTP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'Local port is busy. Set CATALYST_TEST_PORT to another port.' >&2; exit 1
fi

echo "Pulling $IMAGE and the Cloudflare connector..."
compose pull --policy always
umask 077
# Migrate the complete old workspace only after confirming the test is stopped.
# Never merge or overwrite two existing workspaces, or move a custom data path.
OLD_DATA_DIR="$DEPLOY_DIR/data/tailscale-mac"
if [[ -z "${CATALYST_TEST_DATA_DIR:-}" && -d "$OLD_DATA_DIR" ]]; then
  if [[ -e "$DATA_DIR" ]]; then
    echo 'Both old and new test data folders exist. Set CATALYST_TEST_DATA_DIR to the one you want to use.' >&2
    exit 1
  fi
  mv "$OLD_DATA_DIR" "$DATA_DIR"
  echo "Moved existing test data to: $DATA_DIR"
fi
mkdir -p "$DATA_DIR"
# Match the NAS image's UID/GID, including files created by the old Node helper.
docker run --rm --pull=never --platform linux/amd64 --network none --user 0 \
  --mount "type=bind,source=$DATA_DIR,target=/data" --entrypoint sh "$IMAGE" \
  -c 'chown -R 1000:1000 /data && chmod 700 /data'

cleanup() {
  compose down || true
  echo "Test stopped. Saved data remains in: $DATA_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
/usr/bin/caffeinate -i -w "$$" &
if ! compose up -d --no-build --pull never --force-recreate --wait --wait-timeout 120; then
  compose logs --tail=60
  exit 1
fi
PUBLIC_HOSTNAME="$(docker inspect --format '{{ index .Config.Labels "io.catalyst.public-hostname" }}' "$(compose ps -q cloudflared)")"
cat <<INFO

Published image: $IMAGE
Website: https://$PUBLIC_HOSTNAME
Local app: http://127.0.0.1:$HTTP_PORT
Saved test data: $DATA_DIR

Open the website on your phone with Wi-Fi OFF and no VPN connected.
Cloudflare should ask for your approved email and a sign-in code first.
Then enter a driver name and sign into Garmin. Save something in Garage,
restart this script, and use the same driver name to reopen your saved data.

Keep the Mac's lid open and this terminal running. Ctrl+C stops the test.
The logs below show when the tunnel has connected to Cloudflare.

INFO
compose logs --follow --tail=20
