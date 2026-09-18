# Catalyst Coach with a public URL and email sign-in

Use a domain on Cloudflare, Cloudflare Access for invited email addresses, and a
Cloudflare Tunnel container alongside Catalyst. Visitors only need a browser.
The tunnel connects outbound, so no router port forwarding is needed. The app
still runs on your Mac/NAS and all its data stays in the mounted data folder.

## Prepared King Racing setup

`coach.kingracing.net` is configured with an Access email-code policy for the two
requested invitees. The `catalyst-coach` tunnel routes it to `http://catalyst:3210`
and requires a valid Access token. The private `.env.cloudflare` is already
saved on this Mac; it is not committed to Git. Start Docker Desktop and run the
Mac command below. The app becomes available when its containers are running.

The one-time instructions below document how to recreate this configuration or
configure a different domain; they do not need to be repeated for this account.

## One-time Cloudflare setup

1. Register a domain with Cloudflare, or add a domain you already own and finish
   its DNS setup. Pick an app hostname such as `coach.yourdomain.com`.
2. In **Zero Trust → Access controls → Applications**, create a self-hosted
   application for that exact hostname, with no path restriction (protect the
   whole site, including `/api/*`). Enable **One-time PIN** for login. Add an
   **Allow** policy containing only your email and invited email addresses.
   Create this protection **before** connecting the tunnel. Do not add an
   Everyone/Bypass policy.
3. Create a remotely managed **Cloudflare Tunnel**, selecting the `cloudflared`
   connector. The dashboard's Docker installation command contains a tunnel
   token. Copy only that token into the private environment file below; do not
   also run that installation command, because Compose runs the connector.
4. Add a published application route for the same hostname:
   - Service type: **HTTP**
   - Service URL: **`catalyst:3210`**
   - Enable **Protect with Access**, using your Access team and application's
     audience (AUD) tag, so the connector validates Access tokens.

   `catalyst` is the Docker service name. Do not use `localhost` here: inside
   the connector container that would point back to the connector itself.
5. Copy `.env.cloudflare.example` to `.env.cloudflare`, then fill in
   `CATALYST_PUBLIC_HOSTNAME` and `CLOUDFLARE_TUNNEL_TOKEN`. Protect the file with
   `chmod 600 .env.cloudflare`. It is gitignored and should not be posted in chat
   or committed to GitHub. Avoid displaying `docker compose config` without
   `--quiet`, because the rendered configuration contains the token.

Access restricts who can enter the app. The app's existing driver-name selector
still allows an admitted visitor to open any known driver workspace. Invite
only people you trust with that access; independent private accounts would need
an additional application authentication change.

Official guides: [Access-protected web applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
and [creating a tunnel](https://developers.cloudflare.com/tunnel/get-started/).
Use a named tunnel; Cloudflare's temporary Quick Tunnels do not support the
Server-Sent Events used by the app for live sync and coaching progress.

## Test the published image on this Mac

Install and start **Docker Desktop**. No local Node.js, npm build, Tailscale, or
phone VPN is needed. From `catalyst-app`, run:

```sh
bash deploy/test-cloudflare-mac.sh
```

Every run pulls `ghcr.io/ryank311/catalyst-coach:latest` and the Cloudflare
connector, then starts them using the NAS Compose configuration. The app uses
`linux/amd64`, matching the DS920+; Docker Desktop emulates it on Apple Silicon.
The test uses its own Compose project and local port 3211.

Open the printed HTTPS URL on your phone with Wi-Fi and any VPN turned off.
You should see Cloudflare's email-code login before the app. Sign into a driver
workspace and Garmin, then try syncing and editing Garage data. Keep the Mac's
lid open. Ctrl+C stops and removes the test containers. Run it again and choose
the same driver to see that the data survived.

The helper retains the previous helper's `deploy/data/tailscale-mac/` folder so
existing test data is preserved. Despite its name, that folder is now used by
the Docker test. Use `CATALYST_TEST_DATA_DIR=/absolute/path` for a different test
workspace. The data is gitignored and is never included in the container image.

## Run on the NAS

Copy `compose.yaml`, `compose.cloudflare.yaml`, and `.env.cloudflare` to
`/volume1/docker/catalyst-coach`. Set `CATALYST_NAS_DATA_DIR` in the environment
file to `/volume1/docker/catalyst-coach/data` (or your actual NAS path).

Stop the Mac test before connecting the NAS with the same tunnel token. Two
connectors for one tunnel can receive requests interchangeably, but these app
instances have separate databases. For simultaneous Mac testing later, create
a separate tunnel and hostname protected by its own Access application.

```sh
cd /volume1/docker/catalyst-coach
sudo mkdir -p data
sudo chown 1000:1000 data
sudo chmod 700 data
sudo chmod 600 .env.cloudflare
sudo docker compose --env-file .env.cloudflare -f compose.yaml -f compose.cloudflare.yaml pull
sudo docker compose --env-file .env.cloudflare -f compose.yaml -f compose.cloudflare.yaml up -d
```

Open the same HTTPS URL in a browser. The NAS runs the containers after reboot
using the restart policy. The domain/tunnel does not transfer Mac data; import
existing workspaces before first startup if desired, as described in the
[persistence and migration guide](README.md#persistence-backups-upgrades-and-rollback).
All databases, tokens, telemetry, and saved settings remain in the NAS `data`
folder across container stops, restarts, and replacement.

For upgrades, back up the data first, then repeat the two Compose commands.
Use the same `--env-file` and both `-f` arguments for `stop`, `start`, `logs`,
and `down` too. Stopping the containers for a consistent backup also makes the
website unavailable until they start again.
