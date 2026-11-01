# Synology automatic app updates

`install-auto-update-synology.py` installs `auto-update-synology.sh` as a root-owned
script in `/usr/local/lib/catalyst-coach` and creates the native DSM task
**Update Catalyst Coach**. It runs every 15 minutes, all day, as root. The
installer can be rerun to update that same task without creating a duplicate.

Copy both scripts and `compose.yaml` to a private directory on the NAS, then run
the installer there with `sudo python3 install-auto-update-synology.py`. It
waits for any running update, creates the `media` folder for videos, installs
that `compose.yaml` (keeping the old one as `compose.yaml.previous`) and
restarts the app on the image it already runs so the folder is mounted. It
offers to delete backups left by earlier versions of the updater, then runs the
updater once and records its result in `setup.log` beside the scripts. It is
configured for the existing `/volume1/docker/catalyst-coach` deployment and the
`cooljoe` SSH account.

The updater pulls `ghcr.io/ryank311/catalyst-coach:latest`, published by successful
main-branch image builds. It does nothing if the healthy container already runs
that image, and leaves an intentionally stopped app stopped. It does not update
the Cloudflare connector or download new Compose files.

For a changed image, it replaces the container with the exact downloaded image
and polls it until it answers (up to three minutes). It copies no data: the
database stays in `data`, videos in `media`, and the app migrates its database
when it starts. The site is down only for the restart, however much data there
is. The previous image is tagged `catalyst-coach:rollback-<timestamp>`; the two
latest are kept and older ones, with unused image layers, are removed.

If the new image does not answer, the updater starts the previous image again
and pauses automatic updates. Review the failure, then remove
`/volume1/docker/catalyst-coach-updates/PAUSED` as root to resume.

Inspect or disable the task in **DSM → Control Panel → Task Scheduler**.
The latest run log is `/volume1/docker/catalyst-coach-updates/latest-run.log`.
A non-secret status receipt is readable at
`/volume1/docker/catalyst-coach/auto-update-status.txt`.
