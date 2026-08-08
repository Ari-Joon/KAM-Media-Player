# Changelog

## 0.9.0 - 2026-08-07

First public release. Crossfade, a queue that behaves on touch, and a long pass
over the parts that only measurement could find.

### Added

- **Crossfade and gapless transitions**, 0-12 seconds, set from the queue panel
  and remembered across restarts. One ffmpeg `acrossfade` produces a single
  stream spanning the boundary, because an `AudioPlayer` plays one resource at a
  time and a connection subscribes to one player - there is no arrangement of
  the discord.js pieces with two tracks audible at once. The position clock
  survives it: the boundary sits at a known offset, so it stays a measurement of
  audio actually transmitted.
- **Touch selection in the queue.** Multi-select was ctrl-click and shift-click
  only, so the batched remove could not be reached at all on a phone. A long
  press enters a selection mode; the selection bar is the way out.
- **A history section** for already-played tracks, behind a toggle beside
  shuffle. They carry no position and cannot be reordered or dropped into, so
  inline at the top of the queue they read as queue rows that had gone wrong.
- **Hand-to-head clearance for the stick men.** Measured over 129,600
  hand-frames: 14.04% of them had a hand level with and beside the figure's own
  head, now 11.93%.

### Changed

- The queue returns to the right-hand edge. Its own edge let it stay open
  alongside playlists, at the cost of permanently covering the visualisation.
- Vinyl shows the whole cover. It inscribed the artwork so nothing would be
  cropped, then squared the source off first - which threw away the left and
  right thirds of a 16:9 thumbnail before the inscribe happened.
- The score cache is bounded, and superseded analyser versions are dropped at
  boot. They can never be read again, and nothing had ever deleted them: on one
  install that was 47MB of 62MB.

### Removed

- **Lyric transcription.** The requirement was instant and accurate, and local
  Whisper can be neither: it is a speech model on a CPU, so it costs seconds per
  track and is unreliable on sung vocals over a full mix. Its voice-activity
  filter discarded whole tracks as containing no speech at all. The `lyrics`
  field stays in the schema, optional and unset - filling it needs a source of
  pre-timed lyrics, not a transcriber.

### Fixed

- Transitions faded at the end of the *file* rather than at the join, because
  `acrossfade` fades the end of its first input and that input was untrimmed.
- Transitions landed on the track's own outro, which is its quietest part, so a
  correct fade was still inaudible.
- Transitions clipped: two masters at half gain reach full scale exactly.
- Gapless never fired, its lead being shorter than the gap between a provider's
  stated duration and the real file.
- `VisualScore.lyrics` was typed `dict` while the analyser built a `Lyrics`, so
  every completed transcription was discarded at the last step.

## 0.2.0-alpha - 2026-08-05

Playlists, a console worth reading, and a long pass over the visualisations.

### Added

- **Playlists.** Two per person per server, one public and one private, both
  renameable. Visibility is a property of the slot rather than a flag, so no
  rename or edit can publish a private collection; another member's private
  slot is never serialised. Other members' public playlists appear in the same
  panel, with a search across every playlist and a filter by member.
- **A right-click menu on every track** - in search results, favourites, the
  queue, and playlists - offering *add to queue*, *play next*, and either
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
- Stick Men: the camera cuts on the bar with a rate set by energy - eight bars
  while quiet, one on a drop - and chooses its angle for the moment rather than
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

## 0.1.1-alpha - 2026-08-01

- repaired the npm lockfile so `npm ci` succeeds on a fresh clone;
- made the YouTube API key optional and added no-key configuration tests;
- restored the tested four-bar stickman phrase scheduler and dance dynamics;
- hardened the image proxy against redirect SSRF, non-image data, and oversized
  responses;
- added a 32 KiB JSON request-body ceiling;
- added GitHub CI, contribution guidance, privacy and application terms,
  third-party notices, and an accurate media/provider policy;
- clarified permanent hosting versus local PowerShell and Discord distribution.

## 0.1.0-alpha - 2026-07-31

- initial self-hosted alpha packaging.
