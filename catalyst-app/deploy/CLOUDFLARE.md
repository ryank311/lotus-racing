# Catalyst Coach with a public URL and email sign-in

Use a domain on Cloudflare, Cloudflare Access for invited email addresses, and a
Cloudflare Tunnel container alongside Catalyst. Visitors only need a browser.
The tunnel connects outbound, so no router port forwarding is needed. The app
still runs on your Mac/NAS and all its data stays in the mounted data folder.

## Prepared King Racing setup

`coach.kingracing.net` is configured with an Access email-code policy for the two
requested invitees. The `catalyst-coach` tunnel routes it to `http://catalyst:3210`
and requires a valid Access token. The private `.env.cloudflare` is the
production/NAS configuration; it is not committed to Git.

The Mac test uses `dev.kingracing.net` with a separate `catalyst-coach-dev`
tunnel and private `.env.cloudflare.mac` file. Complete the dev setup below
before its first run. Both servers can then run at the same time.

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

### One-time dev tunnel setup

1. Create a separate Access application for **`dev.kingracing.net`**, protecting
   the whole site with the same invited-email Allow policy and One-time PIN
   login as production. Do this before publishing the dev route.
2. Create a new remotely managed tunnel named **`catalyst-coach-dev`**. Add a
   published application route for **`dev.kingracing.net`** to
   **`http://catalyst:3210`**, enabling **Protect with Access** with the dev
   application's audience (AUD) tag. Creating the route in the dashboard also
   creates the hostname's DNS record.
3. Prepare the private Mac configuration:

   ```sh
   cp deploy/.env.cloudflare.mac.example deploy/.env.cloudflare.mac
   chmod 600 deploy/.env.cloudflare.mac
   ```

   Paste the **new dev tunnel's token** into `CLOUDFLARE_TUNNEL_TOKEN` in that
   file. Keep `CATALYST_PUBLIC_HOSTNAME=dev.kingracing.net`.

The hostname variable is a display label; Cloudflare's remote tunnel route
controls actual traffic. Changing only the hostname while reusing the production
token would still connect the Mac to production. Separate tunnels are required;
see [Cloudflare's routing guide](https://developers.cloudflare.com/tunnel/concepts/routing/).
The helper rejects the production hostname and, when `.env.cloudflare` exists
locally, an identical production token. It also ignores exported token/hostname
variables so they cannot override the selected file.

### Run the test

Install and start **Docker Desktop**. No local Node.js, npm build, Tailscale, or
phone VPN is needed. From `catalyst-app`, run:

```sh
bash deploy/test-cloudflare-mac.sh
```

Every run pulls `ghcr.io/ryank311/catalyst-coach:latest` and the Cloudflare
connector, then starts them using the NAS Compose configuration. The app uses
`linux/amd64`, matching the DS920+; Docker Desktop emulates it on Apple Silicon.
The test uses its own Compose project, local port 3211, and
`deploy/.env.cloudflare.mac`. Open **https://dev.kingracing.net**.
`CATALYST_CLOUDFLARE_ENV=/absolute/path` can select another private dev environment
file; it must still specify `dev.kingracing.net` and the separate dev token.

The connector uses HTTP/2 over TCP. On networks where QUIC/UDP stalls, the
server can finish analysis but the tunnel cuts off its JSON response, leaving
the browser unable to display it. Repeated `timeout: no recent network activity`
messages alongside JSON parse errors are consistent with this transport problem. After
changing the Compose command, recreate the connector (a restart alone retains
the old command); its connection logs should show `protocol=http2`. See
[Cloudflare tunnel troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/).

Cloudflare's automatically injected Web Analytics script is allowed by the
app's Content Security Policy. Its beacon uses the already permitted same-origin
`/cdn-cgi/rum` endpoint. Analytics script warnings are separate from analysis
API failures. See [Cloudflare's CSP requirements](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp).

Open the printed HTTPS URL on your phone with Wi-Fi and any VPN turned off.
You should see Cloudflare's email-code login before the app. Sign into a driver
workspace and Garmin, then try syncing and editing Garage data. Keep the Mac's
lid open. Ctrl+C stops and removes the test containers. Run it again and choose
the same driver to see that the data survived.

The helper stores data in `deploy/data/cloudflare-mac/`. On first run, it moves
the previous helper's data folder there if present, preserving all workspaces.
It never merges or overwrites two existing folders. Use
`CATALYST_TEST_DATA_DIR=/absolute/path` for a different test workspace. The data
is gitignored and is never included in the container image.

## Run on the NAS

Copy `compose.yaml`, `compose.cloudflare.yaml`, and `.env.cloudflare` to
`/volume1/docker/catalyst-coach`. Set `CATALYST_NAS_DATA_DIR` in the environment
file to `/volume1/docker/catalyst-coach/data` (or your actual NAS path).

The NAS uses the `catalyst-coach` tunnel and **`coach.kingracing.net`**. Keep its
production token in `.env.cloudflare`; the Mac's dev token belongs only in
`.env.cloudflare.mac`. The separate tunnels let the NAS and Mac run concurrently
without sending requests to each other's databases. Stop any Mac test started
with the old shared configuration before restarting it with the dev file.

```sh
cd /volume1/docker/catalyst-coach
sudo mkdir -p data
sudo chown 1000:1000 data
sudo chmod 700 data
sudo chmod 600 .env.cloudflare
sudo docker compose --env-file .env.cloudflare -f compose.yaml -f compose.cloudflare.yaml pull
sudo docker compose --env-file .env.cloudflare -f compose.yaml -f compose.cloudflare.yaml up -d
```

Open **https://coach.kingracing.net** in a browser. The NAS runs the containers after reboot
using the restart policy. The domain/tunnel does not transfer Mac data; import
existing workspaces before first startup if desired, as described in the
[persistence and migration guide](README.md#persistence-backups-upgrades-and-rollback).
All databases, tokens, telemetry, and saved settings remain in the NAS `data`
folder across container stops, restarts, and replacement.

For upgrades, back up the data first, then repeat the two Compose commands.
Use the same `--env-file` and both `-f` arguments for `stop`, `start`, `logs`,
and `down` too. Stopping the containers for a consistent backup also makes the
website unavailable until they start again.
