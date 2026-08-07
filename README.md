# KAM Media Player

KAM Media Player is a self-hosted Discord Activity and voice bot with queues,
shared controls, and audio-reactive visuals. A Node/Express service runs the bot
and Activity, while a persistent Python/librosa worker produces beat, section,
energy, and spectrum data for eighteen visualisations.

![Architecture](docs/architecture.svg)

## Release status

Version 0.9.0 is a free, open-source **self-hosted release candidate**. The
source is published on GitHub for people to inspect, fork, improve, and run in
their own Discord developer applications.

0.9 rather than 1.0 deliberately: everything here works and is in daily use, but
1.0 is a promise about stability that is worth earning over a little more time
rather than claiming on the day the last feature landed.

It is **not** offered as one public App Directory service, and the reason is
worth reading before you decide what to do with it.

Every state-changing route now verifies the caller's Discord identity
server-side, checks guild membership, and requires presence in the voice channel
for anything that changes what a room hears. Favourites are attributed from the
verified token rather than from whatever the client claims.

What remains is not a bug to fix but a fact about the ecosystem: **there is no
free licensed path to audio.**

- **YouTube audio** is obtained with yt-dlp. YouTube's developer policies
  prohibit downloading and separating audio, and no official alternative is
  offered. Nothing configures this into compliance.
- **SoundCloud** *does* have a licensed path through their official API — but
  they require a paid **Artist Pro** subscription before they will issue API
  credentials at all.

So a deployment either pays for SoundCloud credentials and drops YouTube audio,
or it is a private, self-hosted tool. This project takes the second position and
does not pretend otherwise. See [MEDIA_POLICY.md](MEDIA_POLICY.md).

### What you are choosing by running this

Running your own instance makes **you** the operator. You supply your own
Discord application and bot token, your own optional API keys, and your own
machine; nothing is shared with, or reported to, anyone else. There is no
telemetry in this codebase — the only outbound requests are to Discord and to
the music providers themselves.

That also means the provider terms above apply to *your* deployment, and the
data your instance stores is yours to look after. See
[PRIVACY.md](PRIVACY.md).

The running server states which provider paths it is on at boot and at
`GET /healthz` under `licensing`, so this is never a question of reading source
to find out.

## What "download" means

| Distribution | Does your PC need to stay on? | Status |
| --- | --- | --- |
| GitHub source; each person self-hosts | No | Ready as an alpha |
| Local development with a tunnel | Yes | Supported |
| One permanent private deployment | No, the cloud host runs it | Supported; see DEPLOY.md |
| One public Discord App Directory listing | No | Not offered; see the release status above |

Downloading the source does **not** connect anyone to your bot. Each person
creates their own Discord application and runs their own server, with their own
cache and their own favourites; instances share nothing.

A Discord Activity is a web application, not a file Discord executes. It always
needs an HTTPS backend and a connected bot process. Permanent hosting removes
the need to keep PowerShell open; it does not remove the server.

## Highlights

- Discord voice playback, queues, decks, favourites, and playlist imports
- Personal playlists: two per member per server, one public and one private,
  with a search across every playlist and a filter by member
- Right-click any track to queue it, play it next, or save it to a playlist
- Optional YouTube lookup plus SoundCloud lookup
- Persistent analyser with tempo, beats, sections, energy, punch, and spectrum
- Crossfade and gapless transitions, 0–12 seconds, remembered across restarts
- Eighteen Canvas2D visualisations, plus a "None" mode —
  see [the gallery](docs/VISUALS.md)
- Stick figures with four-bar routines, formations, spring follow-through,
  beat-synchronised weight transfer, and artist-aware cast size
- Docker, Fly.io, and Caddy deployment examples
- Scope-aware JavaScript audit and regression tests

## Requirements

- Node.js 22.12 or newer
- Python 3.10 or newer
- ffmpeg and yt-dlp on `PATH`
- A Discord application with Activities enabled
- Optional: YouTube Data API v3 key. Without it, free-text search uses
  SoundCloud and YouTube lookup is disabled.

## Windows quick start

Install the Python analyser:

```powershell
cd "C:\Projects\Discord Media Player"
python -m pip install -r visualcore\requirements.txt
```

Copy `activity/.env.example` to `activity/.env`, then fill in the three required
Discord values and set `VITE_DISCORD_CLIENT_ID` to the same client ID.

Install, test, build, and start:

```powershell
cd "C:\Projects\Discord Media Player\activity"
npm ci
npm test
npm run build
npm start
```

Discord Activities require HTTPS. For local development, open a second terminal:

```powershell
cd "C:\Projects\Discord Media Player"
cloudflared tunnel --url http://localhost:3000
```

Map the generated hostname to `/` under **Activities → URL Mappings** in the
Discord Developer Portal. A detailed permanent-hosting path is in
[DEPLOY.md](DEPLOY.md).

## Contributing

Bug reports, visualisations, tests, documentation fixes, and provider-interface
improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), and run
`npm test` before opening a pull request.

## Project documents

- [docs/VISUALS.md](docs/VISUALS.md): the eighteen visualisations
- [docs/pipeline.svg](docs/pipeline.svg): how a track becomes a VisualScore
- [DEPLOY.md](DEPLOY.md): local and permanent hosting
- [SECURITY.md](SECURITY.md): threat boundary and production blockers
- [MEDIA_POLICY.md](MEDIA_POLICY.md): provider and media-rights limitations
- [PRIVACY.md](PRIVACY.md): data handled by a deployment
- [APP_TERMS.md](APP_TERMS.md): baseline terms for an operated deployment
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): dependency licence summary
- [CHANGELOG.md](CHANGELOG.md): release history
- [LICENSE](LICENSE): AGPL-3.0 licence for this source code
- [LICENSING.md](LICENSING.md): what the licence permits, and commercial terms

Discord, YouTube, SoundCloud, Apple Music, and Spotify are trademarks of their
respective owners. KAM Media Player is not affiliated with or endorsed by them.
