# Catalyst Coach on a Synology DS920+

Run the Linux `amd64` container in Synology Container Manager. Store its data in
a NAS folder and use Tailscale's free Personal plan for private remote access.
Your phone needs the Tailscale app connected to the same network. No purchased
domain or router port forwarding is needed. The NAS must remain powered on and
connected to the internet.

The [Synology integration guide](https://tailscale.com/docs/integrations/synology)
covers installation and updates. This app has a passwordless username selector:
anyone allowed to reach it can open a known username's workspace. Restrict its
Tailscale access to people you trust; do not expose port 3210 or enable Funnel.

## Image builds on GitHub

The repository's **Container image** workflow builds `linux/amd64` images and
publishes them to `ghcr.io/ryank311/catalyst-coach` using `GITHUB_TOKEN`.
No Docker Hub account or new registry secret is required.

- Pushes to `main` publish `latest`, `main`, and `sha-<commit>` tags.
- Pushes to `codex/**` publish branch and commit tags, leaving `latest` unchanged.
- Pull requests build without publishing; Actions also supports manual builds.

Open [Actions](https://github.com/ryank311/lotus-racing/actions), select the
successful **Container image** run, and copy its image tag from the summary.
For a stable installation, pin a `sha-<commit>` tag or image digest in `.env`.
Upgrades are deliberate; the NAS does not automatically pull new releases.

GitHub initially creates container packages as private. For anonymous NAS pulls,
open the `catalyst-coach` package's settings on GitHub and change visibility to
**Public**. The image contains app code and existing repository templates, not
your local data or credentials. Alternatively, keep the package private and run
`sudo docker login ghcr.io -u YOUR_GITHUB_USERNAME` on the NAS using a personal
access token with `read:packages`. See [GitHub's registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Install when you get home

The image `ghcr.io/ryank311/catalyst-coach:sha-983b96f` was successfully built
and confirmed anonymously pullable on September 18, 2026
([build run](https://github.com/ryank311/lotus-racing/actions/runs/35373239084)).
You can use this version for your first installation without a GitHub token.
GitHub builds and publishes images; installing or upgrading the NAS is a manual
step using the commands below.

1. In DSM, install **Container Manager** and **Tailscale** from Package Center.
   Update Tailscale if the packaged version is old. Sign in to Tailscale on the
   NAS and your phone using the same account.
2. Create `/volume1/docker/catalyst-coach`. Copy `compose.yaml` and `.env.example`
   from this folder there. Rename `.env.example` to `.env` and set
   `CATALYST_IMAGE` to the successful build's image reference. The default
   `ghcr.io/ryank311/catalyst-coach:latest` uses the latest successful main build.
   Set `CATALYST_NAS_DATA_DIR` to the absolute NAS data folder, initially
   `/volume1/docker/catalyst-coach/data`. Keep that path unchanged on upgrades.
3. Enable DSM SSH temporarily and connect as an administrator. Create the
   container's data directory with the image's unprivileged UID/GID:

   ```sh
   cd /volume1/docker/catalyst-coach
   sudo mkdir -p data
   sudo chown 1000:1000 data
   sudo chmod 700 data
   sudo docker compose config
   sudo docker compose pull
   sudo docker compose up -d
   sudo docker compose ps
   ```

   In the rendered configuration, confirm the bind mount maps your absolute NAS
   data folder to `/data`. The folder must exist; Compose deliberately refuses
   to create it automatically. If your DSM provides `docker-compose` instead of
   `docker compose`, substitute that command. If it rejects `create_host_path`,
   update Container Manager/Compose. Container Manager's **Project → Create** can
   also deploy the same folder and Compose file; create the writable data
   directory first. Adjust both the commands and `CATALYST_NAS_DATA_DIR` if your
   Docker shared folder lives on another volume.

4. Give the app a persistent private HTTPS endpoint:

   ```sh
   sudo /var/packages/Tailscale/target/bin/tailscale serve --bg --https=8443 http://127.0.0.1:3210
   sudo /var/packages/Tailscale/target/bin/tailscale serve status
   ```

   Follow any HTTPS-enablement link printed by the first command. Open the exact
   URL printed by `serve status`, such as
   `https://your-nas.your-tailnet.ts.net:8443`, from your phone with Tailscale on.
   Port 8443 keeps this endpoint separate from DSM's normal HTTPS service.
   Tailscale Serve handles the HTTPS certificate and `--bg` restores the endpoint
   after a reboot. See the [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

5. Enter your Catalyst username (case-insensitive), then sign into Garmin and
   complete MFA if prompted. Each app login with a valid Garmin session refreshes
   all session overviews and downloads missing details for the latest 20 sessions.
   Older selections download on demand. **Sync now ▾ → Sync All** fetches every
   session's missing details.

The Compose file binds the app to NAS loopback only. Direct access at
`http://NAS-LAN-IP:3210` is intentionally unavailable; use the Tailscale HTTPS URL
at home as well as away. You do not need a subnet router or exit node for this.
For unattended access, review the NAS device's key-expiry setting in Tailscale's
admin console and disable expiry for this trusted server if appropriate.

## Persistence, backups, upgrades, and rollback

`CATALYST_NAS_DATA_DIR` (default `/volume1/docker/catalyst-coach/data`) is a
**NAS folder bind-mounted at `/data`**, outside the container's writable layer.
It contains the session-signing secret and every username's database,
downloaded telemetry, Garmin tokens, AI settings, coaching history, and Garage
files. It survives container replacement and NAS restarts. Treat backups as
private because they include credentials. There is no need to install Node,
Electron, or development dependencies on the NAS.

The main database for each driver is stored at:

```text
/volume1/docker/catalyst-coach/data/users/<driver-id>/garmin/data/catalyst-app.duckdb
```

Keep the entire `data` folder, including any DuckDB `.wal` files. `stop`, `start`,
`restart`, and `down` followed by `up -d` preserve this bind-mounted folder.
Removing/replacing the container or pulling a newer image does not delete it.
Deleting the NAS folder, pointing `CATALYST_NAS_DATA_DIR` at a different empty
folder, or losing the NAS disks can still lose data or make the app appear empty.
Container persistence is not a backup; keep a separate backup of this folder.
The container root filesystem is read-only, so app data must go to `/data`;
`/tmp` is temporary scratch space only.

For a consistent backup, stop the container, back up the entire project folder
with Hyper Backup or a filesystem snapshot, and then start it again:

```sh
sudo docker compose stop
# Take the backup/snapshot of /volume1/docker/catalyst-coach now.
sudo docker compose start
```

To upgrade, back up first, update `CATALYST_IMAGE` in `.env`, then run:

```sh
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=80 catalyst
```

Retain the previous image tag and matching backup. To roll back, stop the app,
restore the matching data backup if a database migration requires it, set the
previous image tag, and run `docker compose up -d`. Do not run two containers
against the same data folder. The restart policy recovers exited containers;
an unhealthy health check is visible in Container Manager but does not itself
restart a still-running process. Logs rotate to avoid filling the NAS.

To bring existing desktop data, stop both apps, back up both copies, and copy
the **entire server data directory**, including `.session-secret` and `users`,
into the NAS `data` folder before its first start. This imports existing driver
workspaces. Restore ownership to UID/GID 1000 after copying. Signing in with the
same username alone does not transfer data between separate server installations.

On this Mac, the default server data directory is
`~/Library/Application Support/catalyst-coach/server/` unless you set
`CATALYST_SERVER_DATA_DIR`. Copy its **contents**, including the hidden
`.session-secret`, into the NAS `data` folder. Do not copy only the database or
only the repository's legacy `garmin/data` folder. After copying, run on the NAS:

```sh
sudo chown -R 1000:1000 /volume1/docker/catalyst-coach/data
sudo chmod 700 /volume1/docker/catalyst-coach/data
```

Then start the container and choose the same driver name (often `Desktop` for
an imported desktop workspace). Configure desktop clients to connect to the NAS
server if you want all devices to share that one data store.

## Try private phone access on your Mac

Install [Tailscale for macOS](https://tailscale.com/download/mac) and Tailscale on
your phone, then connect both to the same account. From `catalyst-app`, run:

```sh
bash deploy/test-tailscale-mac.sh
```

The script builds and runs the headless browser app locally, then uses
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) to
print a private HTTPS URL. Follow its HTTPS-enablement link if prompted. Open
the URL on your phone with Tailscale connected and Wi-Fi off to test over cellular.
Log into a driver workspace, sign into Garmin, and try syncing and saving Garage
data. Ctrl+C stops the app and temporary sharing. Rerun and use the same driver
name to reopen the saved workspace.

Test data stays in `deploy/data/tailscale-mac/` (gitignored), separate from the
normal desktop data. This exercises the browser app and Tailscale access using
Node.js 22+, without requiring Docker. The NAS will use the container instead.
Keep the Mac awake with its lid open during the test; the script prevents idle
sleep while the server runs. Use `--help` for port and data-directory overrides.

## Local image build (optional)

From the repository root on a machine with Docker:

```sh
docker build --platform linux/amd64 -f catalyst-app/Dockerfile -t catalyst-coach:local .
```

`Dockerfile.dockerignore` limits the build context to app source and profile/track
templates. The runtime excludes Electron and development packages. The build
checks that the Linux DuckDB native binding and server module can load.
