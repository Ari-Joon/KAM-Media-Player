# Changelog

## 0.9.7 - 2026-09-22

The server says when a newer version is out.

### Added

- **An update notice at boot.** The server asks GitHub once, when it starts,
  whether a newer version has been tagged, and says so in the console and in
  the `update` field of `/healthz` - never in Discord. It reads the tags rather
  than the latest release, which lags them, and only a higher version counts.
  It never delays the boot, sends nothing but its own version number, and
  `UPDATE_CHECK=off` switches it off.

### Changed

- **DEPLOY.md's update steps** now pull the new code and restart, and no longer
  point at an old path.

## 0.9.6 - 2026-08-23

A pass over every place displayed state and audible state could disagree.

### Fixed

- **Editing the queue during a crossfade no longer mislabels the audio.**
  Nothing cancelled a transition when the queue was mutated, so the handover
  advanced to whatever was next at that moment rather than to the track whose
  audio was actually playing. Removing the incoming track mid-fade left the
  title naming a different song, the audio path pointing at the wrong file, and
  the analyser handed a track paired with another track's audio. Scores are
  cached per track, so that mis-pairing persisted on every later play. The join
  is now abandoned when the queue moves under it, and the next track starts
  cleanly from its own file.

### Changed

- **A track's visuals are ready when it starts, not a wait after it starts.**
  The analysis ran when a track became current, which under a crossfade is the
  moment it is already audible. The audio has been on disk since the prefetch,
  usually most of a song earlier, so the score is now built then and is a cache
  hit by the time the track plays.

## 0.9.5 - 2026-08-23

### Fixed

- **The now playing title no longer changes before you can hear the new song.**
  One field was serving as both the incoming track's zero inside the joined
  resource, which the clock needs, and the moment to advance the queue. Under a
  crossfade those are different instants: `acrossfade` puts that zero at the
  start of the fade, so the title flipped within one 100 ms tick of the fade
  beginning. A 12 second crossfade spent its whole length naming a song that
  was still fading in, while the outgoing track was the louder of the two for
  the first half. The handover is now the midpoint of the fade, where an
  equal-power curve has the two tracks at equal level. The clock is unchanged.

### Changed

- **Recently played holds fifteen tracks instead of seven.** The panel was
  sized as a convenience rather than a history, and a session runs longer than
  seven tracks.

## 0.9.4 - 2026-08-23

Crossfade actually crossfades, and the stick men stop putting a hand through
their own head.

### Fixed

- **The crossfade no longer sags in the middle.** The fade curve was `tri`, a
  linear fade, and crossing two uncorrelated signals linearly puts each at half
  amplitude at the centre, summing to 0.707 of full power - a 3 dB hole. Over
  two uncorrelated pink-noise sources with a 6 s fade the centre of the join
  measured -3.00 dB under `tri` and -0.20 dB under `qsin`. Confirmed on a real
  pair with only the curve changed: mid-fade RMS 0.13983 against 0.19611, so
  the join holds 2.93 dB more level. Peak moved 0.9153 to 0.9427 with no sample
  at full scale, so the limiter still has room.
- **A track queued during playback is now prefetched, so the join can happen.**
  The prefetch ran only on a track change, so anything added while the current
  song played was never fetched and the transition found no file on disk.
  Queueing the next song mid-playback is the normal way a queue is used, which
  is why the crossfade appeared to work only sometimes.
- **A transition that does not happen now says so.** All three bail-outs
  returned in silence, so the only available report was that it sometimes did
  not activate. Each now names the condition that stopped it.
- **Stick men: hands stop merging into the head.** The original clearance met
  its brief - a 15% reduction in hands *beside* the head - and still looked
  wrong, because what the eye registers is the hand *inside* the head circle.
  0.45 removed only a third of those. Swept over a six-figure cast at 60fps:
  merging runs 2.225% with the clearance off, 1.481% at 0.45 and 0.345% at
  0.75. Raised to 0.75, which cuts merging 4.3x while 8.36% of hands still pass
  beside the head, so the arm is pushed off rather than forbidden.

## 0.9.3 - 2026-08-23

Artwork and artist credits on pasted links, and a troubleshooting section for
the failure every self-hoster will eventually hit.

### Fixed

- **A pasted link now carries its artwork.** `resolveYouTube` never returned a
  thumbnail. Searched tracks always had one and links never did, so Painter had
  no pixels to sample and produced an abstract from a regional palette instead
  of an oil rendition of the cover.
- **A title with no dash credits the artist rather than the uploader.** The
  artist was only ever read from before a dash, so `KATSEYE 'That way' lyrics`
  by the channel "Regular ccl" asked MusicBrainz about the lyrics channel.
  Measured against the live lookup: `katseye` returns 6 members and
  `regular ccl` returns 1, so the lookup was never at fault. A six-piece group
  danced as a solo act. Titles of the form `ARTIST 'SONG'` are now parsed, with
  the opening quote required to follow whitespace so an apostrophe inside a
  word cannot open one.

### Documentation

- **A troubleshooting section in the README**, led by the yt-dlp 403. YouTube
  requires a solved JavaScript challenge to sign the audio URL and a stale
  binary cannot solve it, but metadata lookup keeps working - so the track
  resolves, joins the queue, and only dies at playback, which reads as a player
  bug. Measured 23 August 2026: 2026.07.04 returned a flat 403 on every video
  tried; 2026.08.19 fetched the same URL and produced valid AAC. Also covers the
  white-screen tunnel mapping and why a pasted link works when a search does
  not.

## 0.9.2 - 2026-08-23

The other half of the 0.9.1 fix: the path a pasted link actually takes.

### Fixed

- **A pasted YouTube link no longer depends on the Data API.** 0.9.1 stopped a
  network fault from killing *search*, but a link is resolved somewhere else
  entirely, and that call was still unguarded - so the original
  `TypeError: fetch failed` still took a working link down. The API supplies
  only title, channel and duration for a link whose ID is already in the URL,
  and yt-dlp fetches the audio regardless, so the extractor can supply the same
  three fields. A link now falls through to extraction on a transport fault, on
  quota, and on any other error, keeping the original reason in the message.
- **A YouTube link no longer needs an API key.** The key exists to turn free
  text into a video ID; a link already has one. Refusing links on a deployment
  without the optional key was an unnecessary restriction.
- Playlist imports name the unreachable service instead of surfacing a raw
  `TypeError`. Only the API can enumerate a playlist, so the fault is still
  fatal there - it is just legible now.

## 0.9.1 - 2026-08-08

A single fix, for a fault that should have cost nothing.

### Fixed

- **Any YouTube search failure now falls through to SoundCloud, not only
  quota.** A dropped TLS handshake to googleapis.com surfaced as
  `TypeError: fetch failed` and took search down completely, while SoundCloud
  sat there working. The fallback existed but tested the error message for
  "quota", and a reset socket does not say quota. YouTube is the optional
  provider here - without an API key searches go straight to SoundCloud anyway -
  so no failure of it is worth passing to the user in preference to a working
  search. Network faults are also converted into a message naming the cause
  rather than escaping as a raw TypeError.

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
