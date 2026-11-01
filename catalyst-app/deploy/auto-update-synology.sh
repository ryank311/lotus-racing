#!/bin/bash
# Installed root-owned by install-auto-update-synology.py. Run via DSM scheduler.
#
# A deploy swaps the container's image and nothing else. The database stays in
# the data volume and videos in the media volume; the app migrates its database
# when it starts. Nothing is copied, so a deploy takes as long as a restart no
# matter how much data there is. If the new image does not answer, the previous
# image is started again and updates pause for review.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export CATALYST_IMAGE=ghcr.io/ryank311/catalyst-coach:latest
project=/volume1/docker/catalyst-coach
state=/volume1/docker/catalyst-coach-updates
[[ $(id -u) == 0 ]] || { echo 'Administrator access is required.' >&2; exit 1; }
mkdir -p "$state"
chmod 700 "$state"
exec 9>"$state/update.lock"
flock -n 9 || exit 0
exec > >(tee "$state/latest-run.log") 2>&1
previous=
candidate=
write_status() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" > "$state/status.txt"
  # A separate, non-secret receipt is readable over the existing SSH account.
  cp "$state/status.txt" "$project/auto-update-status.txt"
  chmod 644 "$project/auto-update-status.txt"
}
# The app answers as soon as it listens, well before Docker's 30 s health
# interval would report it healthy; poll it directly.
wait_for_app() {
  local deadline=$((SECONDS + 180))
  until curl --silent --fail --max-time 5 http://127.0.0.1:3210/api/health >/dev/null; do
    (( SECONDS < deadline )) || break
    sleep 1
  done
  curl --silent --show-error --fail --max-time 10 http://127.0.0.1:3210/api/health
  printf '\n'
}
compose() {
  docker compose --project-name catalyst-coach --env-file "$project/.env.cloudflare" \
    -f "$project/compose.yaml" -f "$project/compose.cloudflare.yaml" "$@"
}
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    if [[ -n "$previous" ]]; then
      echo "Starting the previous image again: $previous"
      export CATALYST_IMAGE="$previous"
      compose up -d --no-deps catalyst || true
      printf 'Image %s did not answer; the previous image is running. Review latest-run.log.\n' "$candidate" > "$state/PAUSED"
    fi
    write_status "FAILED exit=$result; see $state/latest-run.log" || true
  fi
  exit "$result"
}
trap finish EXIT
if [[ -f "$state/PAUSED" ]]; then
  echo 'Automatic updates are paused pending review.' >&2
  exit 1
fi
compose config --quiet
cid=$(compose ps --all --quiet catalyst)
[[ -n "$cid" ]] || { echo 'Existing Catalyst container was not found.' >&2; exit 1; }
if [[ $(docker inspect --format '{{.State.Running}}' "$cid") != true ]]; then
  write_status 'SKIPPED: Catalyst is stopped; leaving it stopped.'
  exit 0
fi
current=$(docker inspect --format '{{.Image}}' "$cid")
compose pull catalyst
candidate=$(docker image inspect --format '{{.Id}}' "$CATALYST_IMAGE")
if [[ "$current" == "$candidate" ]]; then
  wait_for_app
  write_status "CURRENT image=$current"
  exit 0
fi
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$CATALYST_IMAGE")
[[ "$digest" == ghcr.io/ryank311/catalyst-coach@sha256:* ]]
stamp=$(date +%Y%m%dT%H%M%S)
docker image tag "$current" "catalyst-coach:rollback-$stamp"
previous="catalyst-coach:rollback-$stamp"
echo "Deploying $digest"
# Use exactly the image just checked, even if latest changes meanwhile.
export CATALYST_IMAGE="$digest"
compose up -d --no-deps catalyst
wait_for_app
previous=
write_status "UPDATED image=$candidate"
# Keep the last two images for a manual rollback; drop older ones and any
# layers nothing uses, so images do not fill the disk either.
docker image ls --format '{{.Repository}}:{{.Tag}}' catalyst-coach | grep ':rollback-' | sort -r | tail -n +3 |
  xargs -r docker image rm >/dev/null 2>&1 || true
docker image prune --force >/dev/null || true
