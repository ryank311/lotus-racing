# Catalyst Coach on a Synology DS920+

Run the Linux `amd64` container in Synology Container Manager. Store its data in
a NAS folder and use Tailscale's free Personal plan for private remote access.
Your phone needs the Tailscale app connected to the same network. No purchased
domain or router port forwarding is needed. The NAS must remain powered on and
connected to the internet.

Tailscale's [Personal plan](https://tailscale.com/pricing) currently supports
up to six users for free. The [Synology integration guide](https://tailscale.com/docs/integrations/synology)
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

1. In DSM, install **Container Manager** and **Tailscale** from Package Center.
   Update Tailscale if the packaged version is old. Sign in to Tailscale on the
   NAS and your phone using the same account.
2. Create `/volume1/docker/catalyst-coach`. Copy `compose.yaml` and `.env.example`
   from this folder there. Rename `.env.example` to `.env` and set
   `CATALYST_IMAGE` to the successful build's image reference. The default
   `ghcr.io/ryank311/catalyst-coach:latest` uses the latest successful main build.
3. Enable DSM SSH temporarily and connect as an administrator. Create the
   container's data directory with the image's unprivileged UID/GID:

   ```sh
   cd /volume1/docker/catalyst-coach
   sudo mkdir -p data
   sudo chown 1000:1000 data
   sudo chmod 700 data
   sudo docker compose pull
   sudo docker compose up -d
   sudo docker compose ps
   ```

   If your DSM provides `docker-compose` instead of `docker compose`, substitute
   that command. Container Manager's **Project → Create** can also deploy the
   same folder and Compose file; create the writable data directory first.
   Adjust `/volume1` if your Docker shared folder lives on another volume.

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

`./data` contains the session-signing secret and every username's database,
downloaded telemetry, Garmin tokens, AI settings, coaching history, and Garage
files. It survives container replacement and NAS restarts. Treat backups as
private because they include credentials. There is no need to install Node,
Electron, or development dependencies on the NAS.

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

## Local image build (optional)

From the repository root on a machine with Docker:

```sh
docker build --platform linux/amd64 -f catalyst-app/Dockerfile -t catalyst-coach:local .
```

`Dockerfile.dockerignore` limits the build context to app source and profile/track
templates. The runtime excludes Electron and development packages. The build
checks that the Linux DuckDB native binding and server module can load.
