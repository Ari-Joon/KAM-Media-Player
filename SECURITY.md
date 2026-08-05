# Security policy

## Supported versions

Only the newest tagged alpha receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
**Security → Report a vulnerability** private advisory form. If that facility is
unavailable, contact the operator through the support link on the Discord app
profile and avoid including secrets or personal data in ordinary chat.

## Current trust boundary

Version 0.2.0 is intended for personal use and otherwise trusted Discord
servers. It is not approved for a public, discoverable deployment.

### What is enforced now

Every route that changes something verifies the caller's Discord identity
against Discord's own `/users/@me` using the OAuth access token, then checks
guild membership, and additionally requires presence in the voice channel for
anything that changes what a room hears. The identity comes from the verified
token and never from the request body, so a crafted request cannot queue,
favourite, rename, or control playback as somebody else.

Also in place: a 32 KiB JSON body ceiling, per-route rate limits, an image proxy
that refuses redirects to private addresses, non-image content and oversized
responses, and stores that keep only server-resolved track descriptors, so
neither favourites nor playlists can carry a client-supplied URL into the
player.

### What is still outstanding

Before App Directory submission or use by untrusted communities:

1. validate `instanceId` with Discord's Activity Instance API and bind the
   session to the returned guild, channel, and user - membership in the guild is
   checked, but participation in *this Activity instance* is not;
2. move from a bearer token on each request to a secure, partitioned, HTTP-only
   session cookie, and add CSRF defences to match;
3. authenticate the now-playing poll. It is deliberately unauthenticated and
   takes a user id from the query string, used only to decide whether one star
   is drawn filled; a forged id reveals nothing but whether that user has
   favourited the track already playing in a channel they can see;
4. encrypt persistent Discord API data at rest and provide a user deletion path.
   Favourites and playlists are stored as plain JSON under the cache directory,
   readable by whoever runs the server - including private playlists, which are
   private from other *users*, not from the operator;
5. replace or remove unlicensed extraction-based media providers - see
   `MEDIA_POLICY.md`.

Never commit `.env` files, bot tokens, OAuth secrets, API keys, cache contents,
downloaded media, or production data. Rotate a credential immediately if it is
ever exposed, including in Git history or a release ZIP.
