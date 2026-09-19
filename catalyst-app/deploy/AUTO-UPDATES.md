# Synology automatic app updates

`install-auto-update-synology.py` installs `auto-update-synology.sh` as a root-owned
script in `/usr/local/lib/catalyst-coach` and creates the native DSM task
**Update Catalyst Coach**. It runs every 15 minutes, all day, as root. The
installer can be rerun to update that same task without creating a duplicate.

Copy both scripts to a private directory on the NAS, then run the installer
there with `sudo python3 install-auto-update-synology.py`. The installer also
runs the updater once and records its result in `setup.log` beside the scripts.
It is configured for the existing `/volume1/docker/catalyst-coach` deployment
and the `cooljoe` SSH account.

The updater pulls `ghcr.io/ryank311/catalyst-coach:latest`, published by successful
main-branch image builds. It does nothing if the healthy container already runs
that image, and leaves an intentionally stopped app stopped. It does not update
the Cloudflare connector or download new Compose files.

For a changed image, it stops Catalyst, archives the entire data directory and
deployment configuration, then starts the exact downloaded image and waits up
to three minutes for health. The five latest complete backups are retained in
`/volume1/docker/catalyst-coach-updates/backups`. Previous images receive local
`catalyst-coach:rollback-<timestamp>` tags; the updater does not prune Docker
images. Backups contain credentials and are accessible only to root.

If backup creation fails, the old container is restarted. If installing or
verifying the new image fails, automatic updates pause rather than automatically
restoring an older database over possible new writes. Review the failure and
matching backup before recovery. Once resolved, remove
`/volume1/docker/catalyst-coach-updates/PAUSED` as root to resume.

Inspect or disable the task in **DSM → Control Panel → Task Scheduler**.
The latest run log is `/volume1/docker/catalyst-coach-updates/latest-run.log`.
A non-secret status receipt is readable at
`/volume1/docker/catalyst-coach/auto-update-status.txt`.
