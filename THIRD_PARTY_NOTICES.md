# Third-party notices

KAM Media Player's MIT licence applies only to this project's own source. The
software installs third-party packages that remain under their own licences.
This file is a convenience summary, not a replacement for the licence files in
each installed package or operating-system distribution.

## Direct Node.js packages

| Package | Locked version | Licence |
| --- | ---: | --- |
| @discord/embedded-app-sdk | 2.5.0 | MIT |
| @discordjs/voice | 0.19.2 | Apache-2.0 |
| compression | 1.8.1 | MIT |
| discord.js | 14.27.0 | Apache-2.0 |
| dotenv | 16.6.1 | BSD-2-Clause |
| express | 4.22.2 | MIT |
| libsodium-wrappers | 0.7.16 | ISC |
| opusscript | 0.0.8 | MIT |
| acorn | 8.18.0 | MIT |
| acorn-walk | 8.3.5 | MIT |
| concurrently | 9.2.4 | MIT |
| vite | 7.3.6 | MIT |

The complete Node dependency tree is pinned in `activity/package-lock.json`.
At the time of the 0.9.0 audit its declared licences were MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, and Unlicense, with no unknown entries.

## Python and system runtime

The analyser installs librosa, soundfile, pydantic, and their transitive
dependencies. The container additionally installs Python, ffmpeg, yt-dlp, and
Debian system libraries. Binary wheels and operating-system packages may bundle
additional components and notices. Distributors of a prebuilt image or binary
must preserve the notices and source-offer obligations that apply to the exact
artifacts they redistribute.

Authoritative package metadata and licence texts are available from the
installed packages and their upstream projects:

- https://github.com/librosa/librosa
- https://github.com/bastibe/python-soundfile
- https://github.com/pydantic/pydantic
- https://ffmpeg.org/legal.html
- https://github.com/yt-dlp/yt-dlp

No third-party music, video, album art, or provider branding is included in this
source release.
