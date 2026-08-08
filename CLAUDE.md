# CLAUDE.md

Guidance for Claude Code working in this repository.

## Stack

- **`activity/`** — Node/Express service (`server.js` + `server/*.js`) that runs
  the discord.js bot, the voice player, and the HTTPS backend serving the
  Discord Activity. Node 22.12+, ESM throughout, Vite builds the client.
- **`visualcore/`** — Python analyser (`visualcore` package, librosa +
  soundfile + pydantic). Runs as a persistent worker driven by
  `activity/server/analyser.js`. Produces a **VisualScore** JSON document —
  the single contract between analysis and rendering, defined in
  `visualcore/src/visualcore/schema.py`.
- **`activity/client/`** — vanilla JS, no framework. 18 visualisations plus a
  "None" entry, registered in `client/registry.js` (`VISUALS`). Implementations
  live in `visuals.js`, `visuals2.js`, `stickmen.js` and `painter.js`. All of
  them are Canvas2D: there is no WebGL path, and reintroducing one means
  reintroducing the failure modes that removing it fixed.
- `client/playlists.js` holds the playlists panel and the track context menu,
  and `client/transport.js` everything else about the player UI. The two are
  joined by a small context object rather than by reaching into each other.

Platform: Windows 11, PowerShell.

### The VisualScore contract

Read the docstring at the top of `schema.py` before changing anything that
crosses the boundary. The rules downstream code depends on:

- Everything is time-addressable from the voice player's position in seconds.
- Lanes are dense, fixed-rate arrays: `lane[int(t * fps)]` is O(1).
- Lane values are normalised to 0–1 and rounded to 3 dp to keep the JSON
  shippable to a browser.
- `SCHEMA_VERSION` is semantic. Bump the major on any breaking change so cached
  scores from an older analyser are rejected rather than misread.

## Conventions

- **Every terminal block starts with the full `cd`.** The user copies blocks
  straight into PowerShell; a bare command run from the wrong directory is a
  wasted round trip.
- **Brief explanations. No flattery.** State what changed and why it matters.
- **Comments explain why, not what.** Especially where something non-obvious
  was fixed — record what broke and what the fix defends against. **If a number
  came from measurement, record the measurement**, not just the number, so the
  next person knows whether it is still valid.
- **British spelling** in code, comments, docs, and UI strings: `colour`,
  `visualisation`, `normalised`, `analyser`, `behaviour`.

## Before shipping

```powershell
cd "C:\Projects\Discord Media Player\activity"; npm test
```

`npm test` runs `audit.mjs` — a scope-aware acorn pass that catches undefined
identifiers across the listed client and server modules — followed by the unit
tests in `test/`. The audit exists because an edit twice removed a function
while leaving its callers in place, and a regex cannot tell that apart from a
class method or a template literal.

**Verify each edit actually landed.** A clean syntax check proves the file
parses, not that your change is in it. Re-read the changed region, or grep for
the new symbol, before claiming the work is done.

## A green suite is not evidence

**The bugs that survive here are the ones the tests cannot see.** The suite
proves a renderer does not throw and a function returns. It cannot hear a
crossfade, look at a label, or notice that a success message is reporting
nonsense. Every defect found on 7 August 2026 needed a measurement built
specially to catch it, and not one was findable by reading the code:

- The crossfade produced output **byte-identical to no crossfade**. `acrossfade`
  fades the end of its first input, and untrimmed that is the end of the *file*
  rather than the join. Caught by rendering the graph and measuring its RMS
  envelope: 0.264 flat before, 0.244 → 0.026 after.
- The lyrics pass logged `4 words` and looked like a success. Voice-activity
  detection had discarded the whole track — `VAD filter removed 06:06.922 of
  audio` — and a count above zero passed every check there was.
- A palette crash presented as *"the visual snaps back to Painter between
  songs"*. It was `PALETTES[-1]`: a negative remainder stays negative in
  JavaScript, and the render guard was substituting the default exactly as
  designed. The symptom pointed nowhere near the cause.
- Vinyl cropped the artwork twice in opposite directions and rendered happily
  throughout.

So: **build the thing that would prove it, then put the number in the commit
message and the comment.** Render the ffmpeg graph and measure it. Count the
frames matching a geometric predicate, before and after. Diff two runs. If a
change is audible or visible, a passing suite says only that nothing threw —
ask for a screenshot.

The corollary is about reports, not code. A symptom described in user terms is
an accurate observation of *behaviour* and a poor guide to *location*. Twice the
described symptom was several layers from the cause. Go and measure; do not
start where the symptom points.

## Testing visualisations

Use a stubbed canvas and a **manually advanced clock**.

Renderers derive their frame delta from `performance.now()`. A back-to-back
render loop in a test gives them microseconds per frame, so nothing moves — the
test passes while the visualisation is visibly broken. Stub `performance.now`
with a variable you step yourself, as `test/client.test.mjs` does:

```js
let fakeNow = 0;
const realNow = performance.now.bind(performance);
performance.now = () => fakeNow;
// ... fakeNow += 16; visual.render(score, t, elapsed);
performance.now = realNow;
```

Advance in realistic increments (16 ms ≈ 60 fps) and assert that state actually
changed between frames.

**Construct the visualisation under the fake clock too.** `Canvas2DVisual`
latches `performance.now()` into `lastFrameMs` in its constructor, so building
it before the stub is installed gives the first frame a nonsense delta — which
looks exactly like a renderer bug and isn't one.

### Motion must be locked to the score, not the wall clock

Anything that moves reads its clock from the score: `this.lanes.scoreSec`, or
`playbackSec` directly. Never `performance.now()`. Wall-clock motion keeps
running while playback is paused, ignores a seek, and sits at a different point
for every viewer — and this is an Activity where several people watch one track
together.

The exception is `deltaSec`, which measures how long the last frame took. That
is a fact about the browser, not about the music.

`test/visuals.test.mjs` enforces this: it renders every visualisation twice over
identical playback positions with wall clocks far apart, and fails if the two
draw different pictures.

## Constraints

- **yt-dlp breaches YouTube's Terms of Service.** Fine for private,
  self-hosted use; it makes the project unsellable and blocks any public App
  Directory listing. Do not build features that assume this path is
  distributable. See `MEDIA_POLICY.md`.
- **SoundCloud has a licensed path** via their official API
  (`server/soundcloud.js`). This is the route to prefer for anything intended
  to ship.
- **Discord's Activity sandbox blocks external images.** All artwork must route
  through `/api/image` (`server/imageproxy.js`). Never point an `<img>` or CSS
  `url()` at a third-party host — it will silently fail inside Discord. The
  same applies to webfonts, which is why the font stacks in `main.js` are
  restricted to system fonts.
