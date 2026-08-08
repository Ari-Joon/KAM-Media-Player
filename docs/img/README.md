# Screenshots go here

Filenames are the visualisation IDs from `activity/client/registry.js`, so they
cannot drift from the code:

```
nowplaying.png   stickmen.png     painter.png      vinyl.png
mosaic.png       alchemy.png      bars.png         scope.png
kaleidoscope.png pulse.png        galaxy.png       terrain.png
aurora.png       rain.png         tunnel.png       fireflies.png
colours.png      ribbons.png
```

Around 1280×720 sits well at the width `VISUALS.md` renders them. PNG rather
than JPEG: these are mostly flat colour and hard edges on a dark background,
which is exactly what JPEG smears.

Two things worth doing before you capture:

- **Play something with a real dynamic range.** Most of these are driven by the
  energy and spectrum lanes, so a quiet passage makes a good visualisation look
  broken.
- **Give the ones that accumulate some time.** Painter, Terrain and Tunnel all
  build from what has already played, so a capture ten seconds in shows an empty
  canvas, flat ground and an empty tunnel. Painter in particular is a function
  of *position*: about two thirds through is when the picture is worth showing.
- **Let the analyser finish.** The first 0.21 s of a new track is a provisional
  score built from the opening 45 seconds; the full one lands about two seconds
  later and is what the visual is actually designed against.
