# Deployment guide

KAM Media Player always needs an HTTPS web service and a connected Discord bot.
There are two supported development shapes:

- local process plus a temporary HTTPS tunnel;
- a permanent container host that stays online without your PC or PowerShell.

This guide is for personal or trusted-server alpha deployments. Do not treat it
as an App Directory launch guide; complete the security and provider work in
`SECURITY.md` and `MEDIA_POLICY.md` first.

## Discord application setup

Create an application in the Discord Developer Portal, add a bot, and enable
Activities. Record the application/client ID, client secret, and bot token.
Never paste those values into source files or commit an `.env` file.

Set `VITE_DISCORD_CLIENT_ID` to the same value as `DISCORD_CLIENT_ID`. The Vite
value is intentionally public and is compiled into the browser bundle; the
client secret and bot token must remain server-only.

Invite the bot with the `bot` and `applications.commands` scopes. It needs the
permissions required to view and join voice channels, speak, send messages,
embed links, attach files if the clip feature is used, and use application
commands.

## Local development

### One command

The simplest route. It builds the client, starts the server and the tunnel
together, and prints the address to paste into the Developer Portal:

```powershell
cd "C:\Projects\Discord Media Player\activity"
npm run go
```

Use `npm run tunnel` on subsequent runs to skip the rebuild. Ctrl+C stops both
processes.

Discord has no API for URL mappings, so pasting that hostname into the portal is
the one step that cannot be automated. Everything around it is.

### Two terminals

Still supported, and useful when you want the tunnel and the server logs
separated:

Install the analyser dependencies:

```powershell
cd "C:\Projects\Discord Media Player"
python -m pip install -r visualcore\requirements.txt
```

Copy `activity/.env.example` to `activity/.env`, fill the Discord values, then:

```powershell
cd "C:\Projects\Discord Media Player\activity"
npm ci
npm test
npm run build
npm start
```

In another terminal, start an HTTPS tunnel:

```powershell
cd "C:\Projects\Discord Media Player"
cloudflared tunnel --url http://localhost:3000
```

Map the generated hostname to `/` under **Activities → URL Mappings**. Temporary
tunnel domains can later be reassigned, so remove the mapping when testing ends.

## A permanent hostname without paying

The tunnel above is free and needs no account, but Cloudflare assigns a new
hostname every time it starts - and because Discord has no API for URL mappings,
that means editing the Developer Portal by hand every session. Two ways out, both
free, neither needing the machine to be anything other than your own computer.

### ngrok, with a static domain - paid plans only

> **The free tier cannot host a Discord Activity.** ngrok's edge serves a
> "You are about to visit…" interstitial to any request with a browser
> User-Agent, and Discord loads an Activity in an embedded browser - so the
> Activity gets the warning page instead of your app and shows a white screen.
> Measured against the same URL at the same moment: `curl` received the app
> (38,103 bytes), the same request with a Chrome User-Agent received the
> interstitial (2,923 bytes).
>
> The only documented bypass is sending an `ngrok-skip-browser-warning` request
> header, and nothing can add a header to the top-level document request -
> Discord makes it. Removing the interstitial is a paid feature. Note that
> `curl` alone will not reveal this, because its User-Agent is not a browser.

On a paid plan the interstitial is gone and this is the lowest-friction option.

1. Create an account at <https://dashboard.ngrok.com> and install the agent:

```powershell
cd "C:\Projects\Discord Media Player\activity"; winget install --id Ngrok.Ngrok -e
```

2. Authenticate it once, with the token from your dashboard:

```powershell
cd "C:\Projects\Discord Media Player\activity"; ngrok config add-authtoken <your token>
```

3. Claim the free domain under **Domains** in the dashboard. It looks like
   `something.ngrok-free.app`.
4. Put it in `.env`:

```
TUNNEL_PROVIDER=ngrok
TUNNEL_DOMAIN=something.ngrok-free.app
```

5. Map that hostname to `/` in the Developer Portal, once. It never changes
   again, so no later session touches the Portal at all.

### Cloudflare named tunnel

Free forever as well, but it needs a domain already on your Cloudflare account,
so it is only worth it if you own one - Cloudflare will not host a zone you do
not control, which is why this is second rather than first.

```powershell
cd "C:\Projects\Discord Media Player\activity"; cloudflared tunnel login
```

```powershell
cd "C:\Projects\Discord Media Player\activity"; cloudflared tunnel create kam
```

```powershell
cd "C:\Projects\Discord Media Player\activity"; cloudflared tunnel route dns kam kam.example.com
```

Then in `.env`:

```
TUNNEL_PROVIDER=cloudflared
TUNNEL_NAME=kam
TUNNEL_DOMAIN=kam.example.com
```

Either way, `npm run tunnel` starts the server and the tunnel together and prints
the address, noting that it is permanent and that the Portal needs nothing.

## Permanent hosting with Fly.io

Fly.io is included as one container-hosting example, not an endorsement. Check
its current pricing, regions, limits, and terms before creating billable
resources. **This is not a free option.** Fly bills by usage and requires a card,
and this workload is not small: a Discord gateway, a voice process, and two
Python workers, one of which holds a Whisper model in memory. If the goal is to
spend nothing, use a tunnel from the section above and leave the process running
on your own machine. The provided configuration deliberately keeps one machine running
because a Discord gateway and active voice process cannot scale to zero.

Install and authenticate the Fly CLI:

```powershell
cd "C:\Projects\Discord Media Player"
iwr https://fly.io/install.ps1 -useb | iex
fly auth login
```

Choose a globally unique app name in `fly.toml`, then initialise the app and
persistent cache volume:

```powershell
cd "C:\Projects\Discord Media Player"
fly launch --no-deploy
fly volumes create kam_data --size 1 --region lhr
```

Set only the required server secrets:

```powershell
cd "C:\Projects\Discord Media Player"
fly secrets set DISCORD_CLIENT_ID=<your client ID>
fly secrets set DISCORD_CLIENT_SECRET=<your secret>
fly secrets set DISCORD_BOT_TOKEN=<your token>
```

`YOUTUBE_API_KEY` is optional. If omitted, free-text search uses SoundCloud and
YouTube lookup is disabled. A key does not authorise media extraction.

```powershell
cd "C:\Projects\Discord Media Player"
fly secrets set YOUTUBE_API_KEY=<your optional key>
```

Build and deploy. The client ID is a build argument because Vite compiles it
into the Activity bundle:

```powershell
cd "C:\Projects\Discord Media Player"
fly deploy --build-arg VITE_DISCORD_CLIENT_ID=<your client ID>
```

Map the permanent Fly hostname to `/` in the Discord Developer Portal. Once it
is deployed, Fly runs the process; your computer and PowerShell can be off.

Useful maintenance commands:

```powershell
cd "C:\Projects\Discord Media Player"
fly status
fly logs
fly deploy
```

## Plain VPS with Docker Compose

The repository also contains `docker-compose.yml` and a Caddy configuration for
a VPS. This path requires your own domain, DNS records, firewall, backups, and
server maintenance. Copy `.env.example` to `.env`, set `DOMAIN`, and keep the
file out of Git.

```powershell
cd "C:\Projects\Discord Media Player"
docker compose up -d --build
```

Caddy obtains and renews HTTPS certificates when the domain points at the VPS.

## Updating or stopping

Test updates before deploying them:

```powershell
cd "C:\Projects\Discord Media Player\activity"
npm ci
npm test
npm run build
```

If you abandon a hosted deployment, delete the application resources, volumes,
DNS mappings, and secrets through the hosting provider so they do not continue
to incur cost or expose an unused endpoint.
