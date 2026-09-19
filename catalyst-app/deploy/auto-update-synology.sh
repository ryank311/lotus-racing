#!/bin/bash
# Installed root-owned by install-auto-update-synology.py. Run via DSM scheduler.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export CATALYST_IMAGE=ghcr.io/ryank311/catalyst-coach:latest
project=/volume1/docker/catalyst-coach
state=/volume1/docker/catalyst-coach-updates
[[ $(id -u) == 0 ]] || { echo 'Administrator access is required.' >&2; exit 1; }
mkdir -p "$state/backups"
chmod 700 "$state" "$state/backups"
exec 9>"$state/update.lock"
flock -n 9 || exit 0
exec > >(tee "$state/latest-run.log") 2>&1
stopped=0
deploying=0
cid=
write_status() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" > "$state/status.txt"
  # A separate, non-secret receipt is readable over the existing SSH account.
  cp "$state/status.txt" "$project/auto-update-status.txt"
  chmod 644 "$project/auto-update-status.txt"
}
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    if (( stopped == 1 && deploying == 0 )); then
      docker start "$cid" || true
    fi
    if (( deploying == 1 )); then
      printf 'New image did not pass verification; review latest-run.log and backups.\n' > "$state/PAUSED"
    fi
    write_status "FAILED exit=$result; see $state/latest-run.log" || true
  fi
  exit "$result"
}
trap finish EXIT
compose() {
  docker compose --project-name catalyst-coach --env-file "$project/.env.cloudflare" \
    -f "$project/compose.yaml" -f "$project/compose.cloudflare.yaml" "$@"
}
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
  [[ $(docker inspect --format '{{.State.Health.Status}}' "$cid") == healthy ]]
  write_status "CURRENT image=$current"
  exit 0
fi
data=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$cid")
[[ "$data" == "$project/data" && -d "$data" ]] || {
  echo 'Unexpected data mount; refusing an update without a verified backup source.' >&2
  exit 1
}
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$CATALYST_IMAGE")
[[ "$digest" == ghcr.io/ryank311/catalyst-coach@sha256:* ]]
stamp=$(date +%Y%m%dT%H%M%S)
backup="$state/backups/$stamp"
mkdir "$backup"
printf 'previous_image=%s\nnew_image=%s\nnew_digest=%s\n' "$current" "$candidate" "$digest" > "$backup/images.txt"
docker image tag "$current" "catalyst-coach:rollback-$stamp"
cp "$project/compose.yaml" "$project/compose.cloudflare.yaml" "$project/.env.cloudflare" "$backup/"
echo "Backing up the stopped workspace to $backup/data.tar.gz"
stopped=1
compose stop catalyst
tar -czf "$backup/data.tar.gz.partial" -C "$data" .
gzip -t "$backup/data.tar.gz.partial"
mv "$backup/data.tar.gz.partial" "$backup/data.tar.gz"
# Use exactly the image just checked, even if latest changes during the backup.
export CATALYST_IMAGE="$digest"
deploying=1
compose up -d --no-deps --wait --wait-timeout 180 catalyst
curl --silent --show-error --fail --max-time 10 http://127.0.0.1:3210/api/health
printf '\n'
stopped=0
deploying=0
write_status "UPDATED image=$candidate backup=$backup"
# Retain five complete backups; retain old image tags for manual rollback.
count=0
while IFS= read -r old; do
  [[ "$old" =~ ^[0-9]{8}T[0-9]{6}$ ]] || continue
  [[ -f "$state/backups/$old/data.tar.gz" ]] || continue
  count=$((count + 1))
  if (( count > 5 )); then rm -rf -- "$state/backups/$old"; fi
done < <(find "$state/backups" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
