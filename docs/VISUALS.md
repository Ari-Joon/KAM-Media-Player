# The visualisations

Eighteen of them, plus a **None** entry for people who want the player without
the light show. Every one is Canvas2D - there is no WebGL path, and reinstating
one would reinstate the failure modes that removing it fixed.

![Architecture](architecture.svg)

## What they all share

Every visualisation reads the same [VisualScore](../visualcore/README.md): beat
and downbeat times, sections, seven dense lanes - energy, punch, brightness,
flux, bass, mid, treble - and sixteen spectrum bands, all sampled at 30 fps and
addressed by playback position.

Two rules apply to all of them, and both exist because several people watch one
track together:

**Motion comes from the score, never the wall clock.** Anything driven by
`performance.now()` keeps running through a pause, ignores a seek, and sits at a
different point for every viewer. The test suite renders every visualisation
twice over identical playback positions with wall clocks hours apart and fails
if the two draw different pictures. The single exception is frame delta, which
is a fact about the browser rather than about the music.

**Anything random is seeded, and anything cyclical is keyed to structure.** A
section index rather than a timer, so a seek lands on the right state instead of
wherever a clock had drifted to.

---

## The track itself

### Now Playing · `img/nowplaying.png`
![Now Playing](img/nowplaying.png)

The cover, held large and steady. The restraint is the point - a sleeve does not
need throwing around the screen to be worth looking at, so the artwork scales
gently with energy and lifts on a beat, and everything that moves is *behind*
it: a glow from the section palette, and a ring that fills as the track plays.

### Painter · `img/painter.png`
![Painter](img/painter.png)

Paints an original picture over the length of the track, finishing before it
ends. Every choice derives from the song, so the same track always paints the
same picture: **palette** from the artist's country of origin via a table of
regional colour traditions, **composition** from the song's structure with each
section becoming a band of the canvas, **stroke character** from the audio, and
**subject** - landscape, seascape, figure study or abstract - from overall
energy and brightness.

The amount painted is a function of *position*, not elapsed time, so joining
midway shows a partly-finished canvas rather than a blank one. That means
seeking backwards has to erase, which is why the picture is rebuilt from a
deterministic stroke list rather than accumulated into the canvas.

### Stick Men · `img/stickmen.png`
![Stick Men](img/stickmen.png)

Dancing figures in a real 3D space under an orbiting camera. Joints are computed
in body-local coordinates, rotated into the world and projected through a
perspective camera, which is what makes a turning figure look like it is
turning. Poses are pure functions of position within the bar, so the cast cannot
drift out of time however long it runs.

Limbs carry secondary motion - hands and feet lag their parent joint through a
spring, so a fast gesture whips rather than snapping. Feet are *planted* rather
than pointed, which is what stops the figures skating. Four-bar routines,
formations, and a cast size taken from the artist's line-up.

### Vinyl · `img/vinyl.png`
![Vinyl](img/vinyl.png)

A record on a turntable, lit from above. An earlier version drew concentric
coloured rings and read as a *diagram* of a record. Real vinyl is almost black;
what makes it recognisable is **specular reflection** - a sheen sweeping across
the surface as the disc turns. So the music is expressed through light rather
than hue: the spectrum modulates how strongly each radial zone catches the
sheen, the beat drives rotation, and bass tilts the platter.

The label is the whole cover, inscribed so its corners touch the circle at any
aspect ratio, with the leftover segments filled by mirroring the artwork across
the nearest edge.

---

## Spectrum and waveform

### Bars & Waves · `img/bars.png`
![Bars & Waves](img/bars.png)

A classic analyser with peak caps and a reflection. The reflection is what makes
it read as a finished product rather than a debug readout, and costs one extra
pass with a gradient alpha.

### Scope · `img/scope.png`
![Scope](img/scope.png)

An oscilloscope trace. The score holds no waveform - storing one would be
enormous - so the trace is synthesised as a sum of sinusoids weighted by the
band levels. Not the literal signal, but it moves the way a scope does, which is
the point of the display.

### Kaleidoscope · `img/kaleidoscope.png`
![Kaleidoscope](img/kaleidoscope.png)

One wedge of spectrum geometry mirrored around the centre. Additive blending is
what makes it luminous - overlapping segments accumulate into saturated colour
instead of flatly covering one another. Alternate segments are flipped, which
gives the folded look rather than a simple rotation.

### Mosaic · `img/mosaic.png`
![Mosaic](img/mosaic.png)

A grid of tiles lit by band level. Each tile has its own threshold, so the grid
lights in patterns rather than solid rows. The axis that maps tiles onto bands -
left to right, top to bottom, or outward from the middle - changes at *section
boundaries*, a structural event the ear is already expecting, rather than on a
timer.

---

## Places

### Galaxy · `img/galaxy.png`
![Galaxy](img/galaxy.png)

The solar system, sprawling outward. The inner system is accurate in the ways
that read visually: eight planets in order, with relative orbital radii and
periods roughly to scale, so Mercury whips round while Neptune barely moves.
Beyond them, comets and debris on long eccentric paths that carry them past the
edge of the frame and back. The sun never moves and never changes colour.

### Terrain · `img/terrain.png`
![Terrain](img/terrain.png)

A heightfield flown over in true perspective. Each vertex has a world position
and is divided by its depth, so the mesh converges correctly rather than merely
scaling. Height comes from the spectrum, recorded one row per moment and
scrolled toward the viewer - so the landscape ahead of you is the music that has
just played.

### Aurora · `img/aurora.png`
![Aurora](img/aurora.png)

Vertical curtains of light. Each is a tall gradient whose horizontal position
and waviness come from the spectrum, blended additively so overlaps brighten -
which is how the real thing behaves.

### Rain · `img/rain.png`
![Rain](img/rain.png)

Streaks falling at a rate set by the music, splashing on impact, reflected in
wet ground. The beat briefly steepens the fall, so rhythm is visible in the
sheet rather than only in the colour.

### Tunnel · `img/tunnel.png`
![Tunnel](img/tunnel.png)

Concentric rings receding toward a vanishing point. Rings are emitted on the
beat and travel outward, so the depth of the tunnel is literally the recent
rhythmic history - a bar of fast hits looks different from a bar of sparse ones.

### Fireflies · `img/fireflies.png`
![Fireflies](img/fireflies.png)

A murmuration wheeling across the frame. A flock reads as a flock because of
three behaviours acting together - cohesion toward the local centre, alignment
with neighbours, separation to avoid collision - and because the mass travels
while individuals lag behind it. True boids over 700 birds would be 490,000
comparisons a frame, so this uses a uniform grid: each bird inspects only its
own cell and the neighbours, keeping the cost roughly linear and the count high
enough to actually look like a flock.

### Pulse · `img/pulse.png`
![Pulse](img/pulse.png)

Shockwaves crossing open sea, viewed from directly overhead. Every beat emits a
ring, and a field of points is displaced and brightened as each wavefront passes
through - so rhythm is visible in the *interference* between waves rather than
in a flash. A fast passage has several rings crossing at once; a sparse one has
a single ripple crossing a still field.

Under the rings run three swell trains at incommensurate angles and wavelengths,
because open sea is never flat and beat-rings alone read as impacts on a plane.
Where crests meet they stack, where a crest meets a trough they cancel, and that
interference is what the eye recognises as sea from the air.

---

## Colour and line

### Musical Colours · `img/colours.png`
![Musical Colours](img/colours.png)

Bands of colour flowing across the whole frame like ink in water. Rewritten
three times, and the failures are instructive: scrolling a bitmap and wiping to
black threw the picture away; sweeping from random edges produced a rectangle of
stripes; a mandala was pretty but sat as a disc on a black screen and read as a
chart.

This one fills the frame. Each frequency band owns a horizontal layer whose
vertical position, thickness and opacity come from its level, and every layer is
distorted by a slow travelling wave so the boundaries fold into each other
rather than sitting in stripes.

### Ribbons · `img/ribbons.png`
![Ribbons](img/ribbons.png)

Flowing bands threading across the frame. Each is a smooth curve whose control
points come from the spectrum, so they braid and separate with the music. Drawn
with soft wide strokes under thin bright ones, which is what makes them look
like fabric rather than wire.

### Alchemy · `img/alchemy.png`
![Alchemy](img/alchemy.png)

Matter falling into a black hole. Particles are pulled inward by inverse-square
attraction and given tangential launch velocity, so they spiral rather than fall
straight in - forming an accretion disc without simulating one explicitly.

Three numbers took several attempts. Gravity is *derived* from the spawn radius
rather than fixed, because a constant was an order of magnitude too weak and
everything hung at the rim: for a particle to fall from radius `r` in time `T`,
`G` is on the order of `2r³/T²`. Launch speed is a fraction of the circular-orbit
velocity `sqrt(G/r)`, so orbits start already decaying.

---

## None

No visualisation at all, so the Activity can be used purely as a player - a
shared queue and transport with nothing moving behind it. Useful when the
visuals would distract, when someone is on a machine where they cost too much,
or when the Activity is simply background audio for a conversation.

It still clears the canvas every frame. Leaving the previous visualisation
frozen on screen would look like a crash rather than a deliberate choice.

---

## Video

Short clips read far better than stills for the ones that move - Stick Men,
Ribbons, Aurora, Pulse and Terrain especially. GitHub plays `.mp4` uploaded
directly to a release or an issue comment, but **not** from a repository path in
a README, so link them from the release rather than committing them here.
