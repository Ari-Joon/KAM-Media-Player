# Licensing

KAM Media Player is released under the **GNU Affero General Public License,
version 3** (AGPL-3.0-or-later).

## What that means in practice

**For anyone running it privately or in their own community:** nothing changes.
Run it, modify it, share it. There is no obligation to publish anything, and no
cost.

**For anyone offering it as a service to others:** the AGPL's network clause
applies. If you run a modified version where other people can use it - a hosted
bot, a SaaS, a paid instance - you must publish your modified source under the
same licence. This is the clause the ordinary GPL lacks, and the reason it was
chosen: without it, a company could take this, improve it, host it commercially
and never contribute anything back.

**For anyone wanting to sell it, or use it in a closed-source product:** the
AGPL does not permit that. A separate commercial licence is required. See below.

## Why not MIT

The project was briefly MIT-licensed. MIT permits anyone to take the code,
rebrand it and sell it with no obligation beyond preserving a copyright notice.
That is a perfectly reasonable choice for a library; it is the wrong choice for
a finished product whose author may want to license it commercially later.

Copyright is unaffected either way. Publishing source does not transfer
ownership - the author remains the copyright holder, and the licence only
governs what others may do with it.

## Commercial licensing

The copyright holder can license this work under different terms to anyone who
wants to use it in a way the AGPL does not allow - typically a company that
wants to build on it without publishing their changes.

If that is you, get in touch through the repository's issue tracker.

## Third-party components

The dependencies carry their own licences, listed in
`THIRD_PARTY_NOTICES.md`. Note in particular that this project *invokes*
`yt-dlp` and `ffmpeg` as external programs rather than linking to them, so their
licences apply to those programs and not to this codebase.

## A note on what you may do with the audio

The licence covers this software. It does not, and cannot, grant any rights over
the music it plays. See `MEDIA_POLICY.md` - the short version is that extracting
audio from YouTube breaches their Terms of Service, and doing so commercially is
a materially worse position than doing so privately. Choosing a licence does not
change that.
