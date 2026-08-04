# Security policy

## Supported versions

Only the newest tagged alpha receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
**Security → Report a vulnerability** private advisory form. If that facility is
unavailable, contact the operator through the support link on the Discord app
profile and avoid including secrets or personal data in ordinary chat.

## Current trust boundary

Version 0.1.1 is intended for personal development and otherwise trusted
Discord servers. It is not approved for a public, discoverable deployment.

The Activity currently sends user, guild, and channel identifiers from the
client, while several backend routes do not independently prove that the caller
is that Discord user or is participating in that Activity instance. Before App
Directory submission or use by untrusted communities, the server must:

1. Exchange OAuth once, resolve identity through Discord on the server, and use
   a secure, partitioned, HTTP-only session cookie.
2. validate `instanceId` with Discord's Activity Instance API and bind the
   session to the returned guild, channel, and user;
3. authorise every read and mutation against that verified session;
4. add CSRF defences, request-size ceilings, and per-session rate limits;
5. harden the image proxy against redirect-based SSRF and oversized responses;
6. encrypt persistent Discord API data at rest and provide a user deletion path;
7. replace or remove unlicensed extraction-based media providers.

Never commit `.env` files, bot tokens, OAuth secrets, API keys, cache contents,
downloaded media, or production data. Rotate a credential immediately if it is
ever exposed, including in Git history or a release ZIP.
