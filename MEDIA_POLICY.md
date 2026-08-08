# Media and provider policy

## The short version

| Provider | Path | Suitable for a public or paid deployment? |
|---|---|---|
| SoundCloud | Official API, with credentials | **Yes** - their developer terms permit streaming |
| SoundCloud | Extraction, without credentials | No |
| YouTube | Data API, for *search* | Yes, within quota |
| YouTube | Extraction, for *audio* | **No** - breaches their Terms of Service |
| Apple Music, Spotify, Deezer, Tidal | Link identification only | Yes - only the track name is read |

Setting `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` moves SoundCloud
onto the licensed path. Nothing moves YouTube audio onto one, because no such
path is offered.

**Obtaining SoundCloud credentials is not free.** Their registration page states
that *"You need a SoundCloud Artist Pro subscription to register API
applications and receive credentials"* - a paid subscription, checked at
registration. So the only licensed audio path in this project is behind a
recurring cost, and a deployment that will not pay it has no licensed path at
all. That is a fact about the current state of the ecosystem rather than a
limitation of this software, and it is the single biggest constraint on shipping
this publicly.

The running server states which path it is on, at boot and at `GET /healthz`
under `licensing`. Check it before exposing a deployment to anyone else - the
fallback to extraction is silent by design, so that nothing breaks for a private
user, and that is exactly how a public deployment could end up breaching terms
without anybody noticing.


This document describes the software accurately; it is not legal advice.

## What the current alpha does

SoundCloud uses their official API when credentials are configured, and falls
back to yt-dlp extraction when they are not. YouTube always uses extraction for
audio, because no sanctioned alternative exists; its Data API is used only for
search. Either way the adapter obtains a full temporary audio file. The bot sends that audio into a Discord voice channel and analyses the
same file for visual synchronisation. The optional clip command can also obtain
and re-upload media. Temporary audio is deleted when playback moves on, but
short-lived storage and rebroadcast still occur.

## What the licence does not grant

The AGPL-3.0 licence covers KAM Media Player's source code only. It does not grant a
licence to music, video, artwork, provider APIs, trademarks, or third-party
services. A YouTube API key identifies API requests; it does not authorise
downloading, separating, or rebroadcasting media.

YouTube's developer policies prohibit API clients from downloading videos,
separating audio, and enabling background playback outside the permitted
player experience. SoundCloud's API terms prohibit stream ripping and restrict
alternative aggregated listening services. yt-dlp is not an official playback
API for either service.

Official references:

- https://developers.google.com/youtube/terms/developer-policies-guide
- https://developers.soundcloud.com/docs/api/terms-of-use
- https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service

## Safe release boundary

Publishing this repository for review, education, and contribution is different
from operating a public playback service. Do not submit this media path to the
Discord App Directory or operate it for the public unless you have replaced it
with a licensed integration and obtained any rights your use requires.

A production-safe provider path should use one of the following:

- an official embedded player that keeps playback within the provider's rules;
- a licensed catalogue and streaming agreement; or
- audio uploaded by the operator or user with explicit rights to process and
  transmit it.

Operators are responsible for provider terms, copyright, neighbouring rights,
privacy, territorial restrictions, and takedown obligations in their region.
