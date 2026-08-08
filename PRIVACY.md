# Privacy notice

Effective: 1 August 2026

KAM Media Player is self-hosted software. The person or organisation operating a
deployment is responsible for that deployment and is the contact for privacy or
deletion requests. Their contact method should be published in the Discord app
profile before other people are invited to use it.

**If you run an instance, that operator is you.** Every deployment is
independent: its own Discord application, its own bot token, its own cache, its
own favourites file. Instances do not communicate, and no data reaches the
authors of this software or anyone else who runs it. There is no telemetry in
this codebase; the only outbound requests are to Discord and to the music
providers a deployment has been configured to use.

## The one file worth being careful with

`activity/cache/favourites.json` records the Discord user IDs and usernames of
everyone who has favourited a track on your instance. It is other people's
personal data, and it is the file most likely to leave a machine by accident.

`.gitignore` excludes the whole `cache/` directory, so it cannot be committed.
That protection does **not** apply to a zip of the project folder, a screen
share, or a copied directory - delete `cache/` before sharing the folder by any
of those routes.

## Data handled

A deployment receives Discord user IDs, usernames, avatar references, guild and
voice-channel IDs, Activity OAuth data, commands, search terms, queue actions,
and favourite selections. Favourites and contributor attribution can be stored
in the deployment's cache. Queues and playback sessions are normally held in
memory. Audio and video may be stored temporarily while being analysed, played,
or uploaded. Technical logs may contain request paths, errors, and search terms.

OAuth access tokens are exchanged for Activity authentication and should not be
written to application logs or persistent storage.

## Purposes

The data is used only to authenticate the Activity, join the requested voice
channel, coordinate shared playback, attribute queue and favourite actions,
produce visuals, diagnose failures, and prevent abuse.

## Third parties

Depending on enabled features, data or media identifiers may be sent to Discord,
the hosting provider, YouTube, SoundCloud, MusicBrainz, Apple Music, Spotify, and
their infrastructure providers. Each service applies its own terms and privacy
notice.

## Retention and deletion

Temporary media should be deleted after the operation completes. In-memory data
ends when the process restarts. Cached scores, artist metadata, favourites, and
logs remain until the deployment operator deletes them under their documented
retention schedule.

Users may request access, correction, or deletion through the support contact on
the app profile. A public operator must implement that request path and document
its actual retention periods before launch. Self-hosters can remove their own
cache and logs directly.

This repository does not operate a shared KAM Media Player service and does not
receive data from independent forks.
