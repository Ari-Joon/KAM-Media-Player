# Changelog

## 0.2.0-alpha — 2026-08-05

Playlists, a console worth reading, and a long pass over the visualisations.

### Added

- **Playlists.** Two per person per server, one public and one private, both
  renameable. Visibility is a property of the slot rather than a flag, so no
  rename or edit can publish a private collection; another member's private
  slot is never serialised. Other members' public playlists appear in the same
  panel, with a search across every playlist and a filter by member.
- **A right-click menu on every track** — in search results, favourites, the
  queue, and playlists — offering *add to queue*, *play next*, and either
  playlist by name.
- **Queue all**, so a playlist can actually be played rather than clicked
  through one row at a time.
- **Multi-select in the queue**: ctrl-click to pick, shift-click for a range,
  and remove the selection in one request.
- **Server-verified identity** on every endpoint that changes something. The
  user is taken from the OAuth token and never from the request body, so a
  crafted request can no longer queue, favourite, or control playback as
  somebody else.
- **A logging layer.** Routine polling is counted and summarised once a minute
  instead of printing a line per request; failures, slow requests and user
  actions still print immediately. `LOG_LEVEL=debug` restores the per-request
  line.
- **Next-track prefetch**, and downloaded audio is reused rather than deleted
  and fetched again, so skipping is close to instant.

### Changed

- The queue panel is called Queue again, and playlists have their own place
  beside Search.
- Stick Men: the camera cuts on the bar with a rate set by energy — eight bars
  while quiet, one on a drop — and chooses its angle for the moment rather than
  by rotation. The whole cast hits a drop in unison, and the camera stays on
  whoever is leading.
- Pulse is a quarter less intense; measured as the share of lit pixels over the
  loudest five seconds of a track.
- Painter finishes the image at 75% of a track and the lettering at 87%, and
  the poster type is a quarter thicker.
- The launcher runs the server and the tunnel in one console, and says outright
  when the tunnel's address has changed since the last run.

### Removed

- **Lava Lamp**, and with it the entire WebGL path. Seventeen visualisations
  plus *None* remain, all Canvas2D.
- Skyline, Spikes and Shoal.

### Fixed

- The star on the playback bar was often wrong: the now-playing poll sent a
  user id that the route discarded, so it was only ever correct just after a
  button press.
- Clicking a long title to read it masked its first characters for four
  seconds.
- A crashed visualisation could take every other one down with it, and could
  leave the Activity blank; failures now name the file and line they came from.
- Pulse indexed off the end of an array on any loud passage and killed the
  frame.
- Terrain spent its first three seconds empty.
- Favourites could not be dragged into the queue at all, because both panels
  were pinned to the same edge and were mutually exclusive.
- Lyrics were transcribed on every play and never written to the score cache.
- A second analyser worker, so a long transcription no longer blocks the next
  track's analysis.

### Security

- The image proxy rejects redirects to private addresses, non-image content and
  oversized responses.
- Playlists and favourites store only server-resolved track descriptors, so
  neither can carry a client-supplied URL into the player.

## 0.1.1-alpha — 2026-08-01

- repaired the npm lockfile so `npm ci` succeeds on a fresh clone;
- made the YouTube API key optional and added no-key configuration tests;
- restored the tested four-bar stickman phrase scheduler and dance dynamics;
- hardened the image proxy against redirect SSRF, non-image data, and oversized
  responses;
- added a 32 KiB JSON request-body ceiling;
- added GitHub CI, contribution guidance, privacy and application terms,
  third-party notices, and an accurate media/provider policy;
- clarified permanent hosting versus local PowerShell and Discord distribution.

## 0.1.0-alpha — 2026-07-31

- initial self-hosted alpha packaging.
