# Discord Activity - shader visualiser

`/play <track>` resolves a song, analyses it, and posts a link that opens a
full-bleed reactive visualiser inside the voice channel. This is the
lightweight render mode; silhouettes reuse the same score and clock.

## The one limitation you should decide about first

Users never upload files, so this system has no access to full-track audio. It
analyses a **30-second official preview** from Apple's iTunes Search API - free,
unauthenticated, deleted immediately after analysis, never served to anyone.

That gives an accurate **BPM** and a faithful **colour and energy character**.
What it cannot give is **beat phase**. The preview is an excerpt from the middle
of the track, so knowing beats land every 0.5s does not tell you *where* the
downbeat falls in the YouTube stream you are actually playing. Visuals will
pulse at the right rate and can sit up to half a beat out of alignment.

Three ways forward, in order of how much they cost you:

1. **Ship it.** At 120 BPM the worst case is a 250ms offset. On a flowing noise
   field this reads as feel, not error. Add a `/nudge` command so anyone can
   shift the offset by ±50ms and the room can dial it in by eye.
2. **Use full audio you are allowed to have.** Free Music Archive and Jamendo
   licence full downloads. Perfect sync, much smaller catalogue.
3. **Fetch full audio from YouTube for analysis.** Perfect sync, and against
   YouTube's terms - the thing that got Rythm and Groovy shut down. Not built
   here, and I would not build it.

Only option 1 works with "play any rap track", so it is what the code assumes.

## Expected layout

The server resolves the analyser by relative path, so keep the two projects as
siblings:

```
project/
  activity/     <- you run everything from here
  visualcore/
```

## Windows

Everything works on Windows, with four differences:

- **`&&` does not chain commands in Windows PowerShell 5.1** (the blue one).
  Use `;` between commands, or install PowerShell 7 where `&&` works.
- **Set `PYTHON_BIN=python`** in `.env`. There is no `python3` on Windows.
- **Install via winget**, not apt: `winget install Gyan.FFmpeg` and
  `winget install Cloudflare.cloudflared`. Close and reopen PowerShell
  afterwards so `PATH` refreshes, then confirm with `ffmpeg -version`.
- **Use three terminals**: cloudflared and the server both run in the
  foreground, and it helps to keep their logs apart.

## Requirements

Node **22.12+** (vite 7 requires it), Python 3.10+, and ffmpeg on `PATH`.

## Setup

**1. Discord application** - at <https://discord.com/developers/applications>:
create an app, add a bot, and under **Activities → Settings** enable Activities.
Copy the client ID, client secret, and bot token.

**2. YouTube Data API v3 key** from the Google Cloud console. Search costs 100
quota units per call against a 10,000/day default, so roughly **100 `/play`
calls a day** before it stops. Scores are cached, so repeats are free.

**3. Install ffmpeg** - required, not optional. Preview clips are `.m4a`, and
`soundfile` cannot decode AAC, so librosa falls back to `audioread`, which
shells out to ffmpeg. Without it every `/play` fails at the analysis step.

```bash
sudo apt install ffmpeg      # or: brew install ffmpeg
ffmpeg -version              # must succeed for the user running the server
```

**4. Configure**

```bash
cp .env.example .env    # fill in every value; VITE_DISCORD_CLIENT_ID = DISCORD_CLIENT_ID
npm install
npm run build
```

**5. Expose it.** Discord loads Activities in an iframe over HTTPS, so localhost
will not work:

```bash
cloudflared tunnel --url http://localhost:3000
```

Use `cloudflared`, not ngrok - ngrok's interstitial page breaks the iframe. Paste
the generated hostname (without `https://`) into **Activities → URL Mappings**
with target `/`.

**6. Run**

```bash
npm start
```

Invite the bot with the `bot` and `applications.commands` scopes, plus **Create
Invite** permission - without it the Activity link cannot be generated.

**7. Test.** Join a voice channel, run `/play <track>`, click the posted link.

## Testing without Discord

The visualiser and clock have no Discord dependency:

```bash
npm test        # clock, beat grid, score-time mapping and track resolution
npx vite        # then open the client with a score JSON to iterate on the shader
```

## How playback stays in sync

`getCurrentTime()` on the YouTube IFrame API only updates about four times a
second; sampling it per frame makes the visuals visibly step. `PlaybackClock`
advances locally on wall time between polls, eases out small drift, and snaps
only on large jumps (seeks, stalls, buffering). Covered by the tests, including
the case where a buffering player reports 0 and must not yank the clock back.

## Files

| File | Role |
|---|---|
| `server.js` | Bot, Activity host, OAuth exchange, score cache |
| `client/visualizer.js` | WebGL shader, score-driven |
| `client/clock.js` | Playback position estimation |
| `client/main.js` | SDK auth, player mounting, render loop |
| `client/index.html` | Shell and telemetry chrome |

## Preview looping

A preview score covers ~30s while playback runs for minutes. Past the analysed
window the lanes **loop** rather than clamping - clamping parked every visual on
the final analysed frame, which froze the whole scene 30 seconds in. The beat
grid does not loop with them: it extrapolates forward from the measured tempo,
because restarting the bar every 30s reads as a bug in a way a continuous grid
never does. Both behaviours are covered by regression tests.

## Dependency advisories

`npm audit` on vite 5 reports two findings that both trace to one root:
esbuild's dev-server advisory (GHSA-67mh-4wv8-2f99). This project never starts
the dev server - `vite build` and `vite build --watch` don't - so exposure was
minimal either way, but vite 7 clears both and produces byte-equivalent output
from this client. Pinned to `^7.3.6` for that reason.

The `esbuild` postinstall script that npm withholds by default is **not
required**: the binary ships in the platform-specific optional dependency, and
builds were verified working with the script skipped.

## Hosting (always-on)

Quick tunnels give a new hostname every restart, which means re-pasting the URL
mapping every session. Deploying fixes that permanently: the host's own HTTPS
domain is stable, so the mapping is set once.

`Dockerfile` bundles all three runtimes (Node, Python, ffmpeg). `fly.toml`
targets Fly.io, where the load-bearing setting is `min_machines_running = 1` -
a Discord bot holds a persistent gateway connection and must never scale to
zero. Free tiers that sleep on idle (Render's, for one) will drop the bot
offline.

```bash
fly launch --no-deploy          # from the repo root, above activity/
fly volumes create kam_data --size 1
fly secrets set DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
  DISCORD_BOT_TOKEN=... YOUTUBE_API_KEY=... VITE_DISCORD_CLIENT_ID=...
fly deploy
```

Then set the URL mapping to `kam-media-player.fly.dev` once and never again.

Note `VITE_DISCORD_CLIENT_ID` is baked in at build time, so it must be present
when the image builds, not only at runtime.

## Known gaps

- **Both providers go through yt-dlp.** YouTube extraction breaches its Terms of
  Service. SoundCloud *could* be sanctioned use, but its REST API now needs an
  OAuth `client_credentials` token that expires every six hours, and its streams
  moved to AAC over HLS at the end of 2025 - so the simple `stream_url` fetch no
  longer works. Using yt-dlp for both is what makes SoundCloud function today;
  restoring the defensible path means implementing that token flow and consuming
  HLS directly.
- **Free-text search prefers YouTube and falls back to SoundCloud** when the
  daily quota is exhausted, since SoundCloud search has no such allowance.
- **Tracks with no Apple catalogue entry cannot be analysed at all.** DJ sets,
  unreleased leaks and most remixes have no preview clip, so `/play` refuses
  them rather than showing unsynced visuals.
- **Analysis blocks the `/play` reply** by a few seconds on a cache miss. The
  one-off ~35s Python startup is now paid at boot instead of by the first user.
- **No `/nudge` yet**, so beat phase cannot be corrected by hand at runtime.
- **`nowPlaying` is in-memory.** A restart clears playback state by design.
- **No queue.** One track per voice channel; `/play` replaces it.
