/**
 * Painter: the song rendered as an oil painting, built live.
 *
 * A white canvas at 0:00 that fills with brushwork as the track plays, with the
 * brush itself visible and every stroke laid down exactly where its tip is. By
 * the end of the song the painting is complete.
 *
 * ## Position, not elapsed time
 *
 * The amount painted is a function of the track's *position*, so joining
 * midway shows a partly-finished canvas rather than a blank one - the painting
 * reflects where the song is, not how long you have been watching. Seeking
 * backwards therefore has to erase, which is why the whole picture is rebuilt
 * from a deterministic stroke list rather than accumulated into the canvas.
 *
 * ## Where the picture comes from
 *
 * Every choice is derived from the track, so the same song always paints the
 * same picture:
 *
 * - **Palette** from the artist's country of origin, via a table of regional
 *   colour traditions. A Nordic act paints in cold blues and greys, a West
 *   African one in ochre and indigo.
 * - **Composition** from the song's structure - each section becomes a band of
 *   the canvas, so a track with a long intro has a large quiet foreground.
 * - **Stroke character** from the audio: loud passages give broad, fast,
 *   high-contrast strokes; quiet ones give fine, closely-valued ones.
 * - **Subject** from the overall energy and brightness, choosing between a
 *   landscape, a seascape, a figure study or an abstract.
 *
 * ## Why strokes are pre-computed
 *
 * A stroke list is generated once per track from a seeded generator. Painting
 * then means drawing the first N of them, where N tracks playback position.
 * That makes the picture identical on every viewer's screen, reproducible on
 * replay, and cheap to redraw after a seek.
 */

import { Canvas2DVisual, mix, rgb } from './visuals.js';

/**
 * Fallback palettes when no cover art can be read.
 *
 * Regional rather than random: an act's part of the world is the best available
 * guess at what a painter depicting them would reach for. Only used when the
 * artwork itself is unavailable, since the artwork is always the better source.
 */
const REGIONAL_PALETTES = [
  {
    match: /\b(?:k-?pop|korea|seoul|illit|bts|blackpink|newjeans|aespa)\b/i,
    name: 'Korean',
    colours: ['#f2e8dc', '#d94f70', '#3f6fb5', '#1f2a44', '#e8b34a', '#7fa88a'],
  },
  {
    match: /\b(?:japan|tokyo|j-?pop|osaka)\b/i,
    name: 'Japanese',
    colours: ['#f4efe6', '#bf3b45', '#2f4858', '#1a1a1a', '#c9a227', '#8fa9a3'],
  },
  {
    match: /\b(?:sweden|norway|finland|denmark|iceland|nordic|oslo|stockholm)\b/i,
    name: 'Nordic',
    colours: ['#eef2f5', '#7c98a6', '#3d5a6c', '#1c2b33', '#b7c9d3', '#d9e3e8'],
  },
  {
    match: /\b(?:nigeria|ghana|afro|lagos|senegal|mali|amapiano|africa)\b/i,
    name: 'West African',
    colours: ['#f6e7cb', '#d98324', '#8c3503', '#1b3a4b', '#2b6b5a', '#e4b363'],
  },
  {
    match: /\b(?:brazil|brasil|samba|bossa|rio|latin|reggaeton|cuba|colombia)\b/i,
    name: 'Latin American',
    colours: ['#fdf1dc', '#e94f37', '#f6a01a', '#137547', '#1d3557', '#f4a3a3'],
  },
  {
    match: /\b(?:india|bollywood|punjabi|hindi|mumbai|desi)\b/i,
    name: 'South Asian',
    colours: ['#fbeee0', '#e03a3e', '#f5a623', '#128c7e', '#4a1e6b', '#f2c14e'],
  },
  {
    match: /\b(?:france|paris|italy|spain|europe|berlin|london|uk|british)\b/i,
    name: 'European',
    colours: ['#efe9dd', '#8d6a4f', '#4a5859', '#242f33', '#a9927d', '#c4b7a6'],
  },
  {
    match: /\b(?:usa|america|nyc|new york|la|atlanta|chicago|detroit|tupac|hip ?hop|rap)\b/i,
    name: 'American',
    colours: ['#f0ece2', '#c1442f', '#2f4b7c', '#1a1a1a', '#d99a2b', '#6b7a8f'],
  },
];

/** Ground and palette when nothing matches and no artwork is available. */
const DEFAULT_PALETTE = {
  name: 'Neutral',
  colours: ['#f2ede3', '#b5651d', '#4a6670', '#22252a', '#d4a373', '#8a9b6e'],
};

/**
 * Resolution the cover art is sampled at.
 *
 * Each cell becomes one brush stroke, so this is the painting's stroke count in
 * each axis, and directly sets how faithful the painting is to the artwork: a
 * cell is the smallest feature the picture can resolve. 101x101 gives 10,201
 * strokes, a further 25% on the 8,100 of 90x90.
 *
 * That costs nothing overall, because the per-dab work was cut by more than it
 * added - see the batched bristles in drawStroke. Total drawing operations
 * actually fell.
 *
 * Raising this is a *quadratic* cost, not a linear one: it is the count per
 * axis, so a 20% increase in strokes is only a 9.5% increase here. Worth
 * remembering before nudging it again.
 */
const SAMPLE_SIZE = 101;

/**
 * Most strokes laid into the buffer in one frame.
 *
 * Sized against demand rather than picked: the full poster is 39,296 strokes
 * spread over 87% of a track, which is well under 4 strokes a frame on average
 * and about 27 through the lettering, which is the busiest stretch by far. 400
 * is an order of magnitude above that, so it never touches normal playback -
 * it only bounds the catch-up after a seek, which previously laid every
 * outstanding stroke in a single frame.
 *
 * The cost of the bound is that a full repaint takes 39,296 / 400 = 99 frames,
 * about 1.6 seconds at 60fps, to build back up. That reads as the picture being
 * repainted, which is what this visualisation is, and is much better than one
 * frame that stalls.
 */
const STROKE_BUDGET = 400;

/**
 * Deterministic pseudo-random generator.
 *
 * Seeded from the track, so the same song paints the same picture on every
 * screen and on every replay. `Math.random` would give a different painting
 * each time, which would break both reproducibility and the shared experience.
 *
 * @param {number} seed
 * @returns {() => number} Generator returning 0-1.
 */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    // xorshift32: small, fast and good enough for scattering brush strokes.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

/** Hash a string to a 32-bit integer, for seeding. */
function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class PainterVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.plan = null;
    this.painted = 0;
    this.buffer = null;
    /** Replacement buffer while a repaint is in flight; see `render`. */
    this.pending = null;
    /** Set when the plan changed under us and the picture must be rebuilt. */
    this.repaint = false;
  }

  /**
   * Load the cover art and read its pixels.
   *
   * Routed through this origin's image proxy, which matters for two reasons:
   * the Activity sandbox blocks direct loads from external hosts, and reading
   * pixels from a cross-origin image would taint the canvas and make
   * `getImageData` throw. Same-origin keeps the data readable.
   *
   * @param {string} url
   * @returns {Promise<{data: ImageData, width: number, height: number}|null>}
   */
  async loadArtwork(url) {
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      // Already-local sources are used as they are. Only a third-party host
      // needs the proxy, and wrapping a `blob:` or same-origin URL in it would
      // ask the server to fetch something it cannot reach - which is exactly
      // what the development harness supplies when artwork is picked from disk.
      const local = /^(blob:|data:|\/)/.test(url);
      image.src = local ? url : `/api/image?url=${encodeURIComponent(url)}`;
      await image.decode();

      // Sample at a coarse resolution: one cell per brush stroke.
      const aspect = image.naturalHeight / Math.max(1, image.naturalWidth);
      const w = SAMPLE_SIZE;
      const h = Math.max(8, Math.round(SAMPLE_SIZE * aspect));

      const buffer = this.makeBuffer(w, h);
      if (!buffer) return null;
      buffer.context.drawImage(image, 0, 0, w, h);
      return { data: buffer.context.getImageData(0, 0, w, h), width: w, height: h };
    } catch {
      // No artwork, a blocked request, or a decode failure: the caller falls
      // back to a derived palette rather than failing.
      return null;
    }
  }

  /**
   * Decide what this track's painting looks like.
   *
   * @param {object} score
   * @param {object|null} track
   * @returns {object} A plan.
   */
  plan_(score, track) {
    const text = `${track?.title ?? ''} ${track?.artist ?? ''}`;
    const region = REGIONAL_PALETTES.find((entry) => entry.match.test(text)) ?? DEFAULT_PALETTE;
    const random = seeded(hashText(text || 'untitled'));

    const sections = score.sections ?? [];
    const meanEnergy = sections.length
      ? sections.reduce((sum, s) => sum + s.energy_mean, 0) / sections.length
      : 0.5;
    const meanBright = sections.length
      ? sections.reduce((sum, s) => sum + s.brightness_mean, 0) / sections.length
      : 0.5;

    return {
      key: `${track?.provider}:${track?.providerId}`,
      region,
      random,
      meanEnergy,
      meanBright,
      title: (track?.title ?? '').replace(/[([].*$/, '').trim(),
      artist: (track?.artist ?? '').replace(/\s*-\s*topic$/i, '').trim(),
      artwork: null,
      strokes: null,
    };
  }

  /**
   * Build the stroke list, as a film-poster composition.
   *
   * ## Layout
   *
   * Posters are not free compositions - they follow a convention, and following
   * it is what makes the result read as a poster rather than as abstract paint.
   * The upper two thirds carry the image, the lower third carries the lettering,
   * and a margin frames the whole thing.
   *
   * ## Where the colours come from
   *
   * When the cover art loaded, every stroke takes the colour of the pixel it
   * covers, so the painting is an oil rendition of the actual artwork rather
   * than an invented picture in vaguely similar colours. Strokes are ordered
   * dark-to-light, which is how a painter works: masses first, highlights last.
   *
   * @param {object} plan
   * @param {number} width
   * @param {number} height
   * @returns {object[]}
   */
  makeStrokes(plan, width, height) {
    const { random, artwork } = plan;
    const strokes = [];

    // Poster proportions: image above, lettering below, margin around.
    const margin = Math.min(width, height) * 0.05;
    const imageTop = margin;
    const imageBottom = height * 0.70;
    const imageHeight = imageBottom - imageTop;
    const imageWidth = width - margin * 2;

    if (artwork) {
      const { data, width: sw, height: sh } = artwork;

      // Fit the artwork into the image area without distorting it.
      const scale = Math.min(imageWidth / sw, imageHeight / sh);
      const drawW = sw * scale;
      const drawH = sh * scale;
      const originX = (width - drawW) / 2;
      const originY = imageTop + (imageHeight - drawH) / 2;

      const cellW = drawW / sw;
      const cellH = drawH / sh;

      // Underpainting, laid per cell rather than in broad strokes.
      //
      // The previous attempt blocked in with averaged strokes nearly six cells
      // wide. Those sampled the artwork's letterboxed edges and bled outward as
      // a black frame around the picture, so the layer was removed entirely and
      // coverage was left to the detail strokes overlapping each other.
      //
      // That worked only while the dabs were larger than their cells. They are
      // now a fifth smaller and round rather than elongated, and a circle of
      // diameter 0.99 cells cannot cover a cell's corners however many
      // neighbours it has - the half-diagonal alone is 0.707 cells before any
      // positional jitter.
      //
      // A per-cell rectangle of that cell's own sampled colour fixes both
      // problems at once: coverage is guaranteed by construction rather than by
      // arithmetic about overlap, and a rect that is exactly one cell cannot
      // bleed into its neighbours or reach the letterboxed edge the way a
      // six-cell stroke did. It is laid immediately before that cell's dab, so
      // the picture still builds progressively rather than appearing at once.

      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const i = (y * sw + x) * 4;
          const r = data.data[i];
          const g = data.data[i + 1];
          const b = data.data[i + 2];
          const luminance = (r * 0.299 + g * 0.587 + b * 0.114) / 255;

          // Ordered coarse-to-fine, not dark-to-light.
          //
          // Sorting by luminance meant that early in a track only the darkest
          // strokes had been laid, so the canvas showed a solid black rectangle
          // for the first minute and only became an image near the end. Which
          // is technically how some painters work and completely wrong for
          // something watched while it happens.
          //
          // Interleaving instead means every stage of the painting covers the
          // whole picture: a rough version appears almost immediately and gains
          // detail. The pass number comes from a hash of position, so successive
          // passes scatter rather than sweeping in bands.
          const scatter = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
          strokes.push({
            // Offset just past its own block, so the detail for a region always
            // lands after that region has been blocked in.
            layer: scatter * 0.94 + 0.06,
            x: originX + (x + 0.5) * cellW + (random() - 0.5) * cellW * 0.5,
            y: originY + (y + 0.5) * cellH + (random() - 0.5) * cellH * 0.5,
            // Tighter than before. Strokes still overlap enough that no grid
            // shows, but a stroke that spread nearly three cells wide dragged
            // each colour across its neighbours - which is exactly the smudging
            // that made small features unreadable.
            // Sized to guarantee overlap with every neighbour. The variation is
            // deliberately small: a stroke much larger than this starts carrying
            // its colour into cells it was not sampled from, which is the
            // smearing that made faces unreadable.
            // Round rather than elongated, and smaller.
            //
            // An oval stroke smears its colour along its long axis, which is
            // what limited how much of the artwork's detail survived. A round
            // dab states one colour in one place, so neighbouring cells stay
            // distinct and the picture holds far more information.
            //
            // Equal on both axes, and a fifth smaller than they were: 1.24 and
            // 0.20 became 0.99 and 0.16. Bare canvas is no longer a constraint
            // on this number, because the per-cell underpainting above
            // guarantees coverage - so the dab is free to be the size that
            // reads best rather than the size that happens to tile.
            length: cellW * (0.99 + random() * 0.16),
            width: cellW * (0.99 + random() * 0.16),
            // The exact cell this dab was sampled from, so the underpainting can
            // fill it without any risk of reaching a neighbour.
            base: {
              x: originX + x * cellW,
              y: originY + y * cellH,
              w: cellW + 1,
              h: cellH + 1,
            },
            // Loose angle variation, so the surface has the directional texture
            // of brushwork instead of the regularity of pixels.
            // Less angular variation too: a strongly rotated stroke carries its
            // colour furthest from the cell it was sampled from.
            // Angle matters far less for a round dab, but a little keeps the
            // bristle texture from aligning into visible rows.
            angle: (random() - 0.5) * 1.2,
            // Stored as components rather than a CSS string. The previous
            // version wrote "rgb(r,g,b)" and the stroke renderer parsed it with
            // a *hex* parser, so every channel came back NaN and every artwork
            // stroke painted pure black - which is why the canvas was a black
            // rectangle however good the source image was.
            colour: [r, g, b],
            // Translucent, so overlapping strokes build up tone the way glazed
            // oil does. At near-opaque, the densest areas simply went flat.
            alpha: 0.72,
          });
        }
      }
    } else {
      // No artwork: a painted portrait mass in the regional palette, which at
      // least gives the poster a subject rather than an empty frame.
      const palette = plan.region.colours;
      const cx = width / 2;
      const cy = imageTop + imageHeight * 0.5;
      const radius = Math.min(imageWidth, imageHeight) * 0.34;

      for (let i = 0; i < 900; i++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * radius * (1 + random() * 0.3);
        const inside = distance < radius;
        strokes.push({
          layer: inside ? 0.3 + random() * 0.5 : 0.1 + random() * 0.2,
          x: cx + Math.cos(angle) * distance * 0.75,
          y: cy + Math.sin(angle) * distance,
          length: radius * (0.10 + random() * 0.16),
          width: radius * (0.05 + random() * 0.07),
          angle: angle + Math.PI / 2 + (random() - 0.5) * 0.6,
          colour: inside
            ? palette[1 + Math.floor(random() * 3)]
            : palette[Math.floor(random() * 2) === 0 ? 2 : 3],
          alpha: 0.8,
        });
      }
    }

    strokes.sort((a, b) => a.layer - b.layer);
    // Recorded before the lettering is appended, so the two can be paced
    // independently.
    const artStrokeCount = strokes.length;

    // --- Lettering ---------------------------------------------------------
    // Added after sorting so the type is always painted last, as a poster's
    // titling would be. Each glyph is decomposed into strokes by rasterising it
    // once and reading which cells are covered - the same trick as the artwork,
    // which keeps the lettering in the same painterly language as the image.
    // Positioned clear of the transport bar, which sits across the bottom.
    const titleStrokes = this.letterStrokes(
      plan.title.toUpperCase(), width, height * 0.80,
      width * 0.88, height * 0.088, plan, random,
    );
    const artistStrokes = this.letterStrokes(
      plan.artist.toUpperCase(), width, height * 0.895,
      width * 0.55, height * 0.036, plan, random,
    );

    const all = strokes.concat(titleStrokes, artistStrokes);
    all.artStrokeCount = artStrokeCount;
    return all;
  }

  /**
   * Turn a line of text into brush strokes.
   *
   * The text is rasterised once into a small offscreen canvas and every covered
   * cell becomes a stroke, so the lettering carries the same brushwork as the
   * rest of the canvas. Drawing it as ordinary type instead was tried and was
   * plainly worse: crisp, but obviously pasted on top of a painting rather than
   * part of one.
   *
   * Clarity comes from the raster resolution, not from abandoning the
   * technique - at 30 rows the letterforms keep their counters and stems while
   * each stroke is still large enough to read as paint.
   *
   * @param {string} text
   * @param {number} canvasWidth
   * @param {number} centreY
   * @param {number} maxWidth
   * @param {number} fontSize
   * @param {object} plan
   * @param {() => number} random
   * @returns {object[]}
   */
  letterStrokes(text, canvasWidth, centreY, maxWidth, fontSize, plan, random) {
    if (!text) return [];

    const rasterHeight = 30;
    const rasterWidth = Math.max(24, Math.min(320,
      Math.round(rasterHeight * (maxWidth / fontSize))));
    const buffer = this.makeBuffer(rasterWidth, rasterHeight);
    if (!buffer) return [];

    const context = buffer.context;
    context.clearRect(0, 0, rasterWidth, rasterHeight);
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    let size = rasterHeight * 0.86;
    const font = (px) => `700 ${px}px "Arial Narrow", "Roboto Condensed", `
      + 'Impact, sans-serif';
    context.font = font(size);
    while (context.measureText(text).width > rasterWidth * 0.94 && size > 5) {
      size -= 1;
      context.font = font(size);
    }
    context.fillText(text, rasterWidth / 2, rasterHeight / 2);

    let pixels;
    try {
      pixels = context.getImageData(0, 0, rasterWidth, rasterHeight).data;
    } catch {
      return [];
    }

    const cellW = maxWidth / rasterWidth;
    const scaleY = fontSize / rasterHeight;
    const originX = (canvasWidth - maxWidth) / 2;
    const originY = centreY - fontSize / 2;

    const inkColour = plan.inkColour ?? plan.region.colours[3];

    const out = [];
    for (let y = 0; y < rasterHeight; y++) {
      for (let x = 0; x < rasterWidth; x++) {
        if (pixels[(y * rasterWidth + x) * 4 + 3] < 128) continue;

        // A solid stroke guaranteeing the letterform is filled, then a textured
        // one over it. Texture alone left pinholes inside the glyphs.
        out.push({
          layer: 1.9,
          x: originX + (x + 0.5) * cellW,
          y: originY + (y + 0.5) * scaleY,
          length: cellW * 1.45,
          width: scaleY * 1.28,
          angle: 0,
          colour: inkColour,
          alpha: 1,
        });
        out.push({
          layer: 2,
          // Small offsets only: larger jitter thickened the stems and closed up
          // the gaps between letters, which is what made words unreadable.
          x: originX + (x + 0.5) * cellW + (random() - 0.5) * cellW * 0.3,
          y: originY + (y + 0.5) * scaleY + (random() - 0.5) * scaleY * 0.3,
          length: cellW * 1.06,
          width: scaleY * 0.85,
          angle: (random() - 0.5) * 0.18,
          colour: inkColour,
          alpha: 0.92,
        });
      }
    }
    return out;
  }

  /**
   * Draw one dab of paint.
   *
   * ## Why the silhouette is a circle
   *
   * The body used to be a row of overlapping ellipses stepped along the stroke's
   * length, which produced a lozenge however equal the two axes were set: the
   * per-step radius came from `length / steps` while the cross radius came from
   * `width / 2`, so the two were only equal by coincidence and never were.
   * A single circular dab states its colour in one place and keeps the picture's
   * detail where it was sampled.
   *
   * The internal linework stays. Those streaks are what stop a dab reading as a
   * flat vector disc and give the surface its layered, built-up look - they are
   * simply clipped to the disc now, so they texture the paint instead of
   * escaping past its edge as whiskers.
   */
  drawStroke(context, stroke) {
    // Accepts either components or a hex string, so palette-driven strokes and
    // artwork-driven ones can share one renderer.
    const [r, g, b] = Array.isArray(stroke.colour) ? stroke.colour : rgb(stroke.colour);

    // Underpainting for this cell, laid before the dab and only for artwork
    // strokes - the title card and palette strokes have no cell to fill.
    if (stroke.base) {
      context.fillStyle = `rgb(${r},${g},${b})`;
      context.fillRect(stroke.base.x, stroke.base.y, stroke.base.w, stroke.base.h);
    }

    context.save();
    context.translate(stroke.x, stroke.y);
    context.rotate(stroke.angle);

    const radius = stroke.width / 2;
    if (radius <= 0.2) {
      context.restore();
      return;
    }

    // The disc, at exactly the colour this cell sampled.
    //
    // There used to be a 0.94 load factor here, darkening every dab by 6%
    // against the artwork it came from. Across the whole canvas that is a
    // uniform shift away from the source - the one error that cannot cancel
    // out, because it applies to every stroke in the same direction. The
    // unevenness it was after is already supplied by the two crescents and
    // the bristles below, which vary locally instead.
    context.fillStyle = `rgba(${r},${g},${b},${stroke.alpha})`;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();

    // Everything below is confined to the disc just drawn.
    context.save();
    context.clip();

    // A brighter crescent on one side, which is what makes a dab read as loaded
    // paint catching the light rather than as a filled circle.
    context.globalAlpha = stroke.alpha * 0.35;
    context.fillStyle = `rgb(${Math.min(255, r + 26)},${Math.min(255, g + 26)},`
      + `${Math.min(255, b + 26)})`;
    context.beginPath();
    context.arc(-radius * 0.22, -radius * 0.22, radius * 0.82, 0, Math.PI * 2);
    context.fill();

    // A darker crescent opposite it: the shaded side of the ridge the brush
    // leaves behind. Light alone makes a dab look domed; light with a shadow
    // makes it look like a *deposit* with an edge standing above the surface,
    // and that raised edge is what gives an oil surface its roughness.
    context.globalAlpha = stroke.alpha * 0.26;
    context.fillStyle = `rgb(${Math.max(0, r - 30)},${Math.max(0, g - 30)},`
      + `${Math.max(0, b - 30)})`;
    context.beginPath();
    context.arc(radius * 0.30, radius * 0.30, radius * 0.78, 0, Math.PI * 2);
    context.fill();

    // Bristle streaks, kept faint. At the previous strength they read as
    // scratches across every stroke rather than as texture within it.
    //
    // Five rather than three, and alternating light against dark. A brush has
    // many bristles and they furrow the paint in both directions - a set of
    // uniformly bright lines reads as a highlight pattern, where alternating
    // ones read as the ridged, combed surface loaded paint actually has.
    // Batched into two paths rather than five.
    //
    // The streaks alternate light against dark, so they only need two styles -
    // but they were being drawn one at a time, which meant five beginPath and
    // five stroke calls for every dab in the painting. Collecting each colour
    // into a single path cuts the most expensive operation per dab from five
    // calls to two, and draws exactly the same lines.
    context.lineWidth = Math.max(0.4, stroke.width * 0.075);
    for (const lit of [true, false]) {
      context.globalAlpha = stroke.alpha * (lit ? 0.14 : 0.10);
      context.strokeStyle = lit
        ? `rgb(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)})`
        : `rgb(${Math.max(0, r - 34)},${Math.max(0, g - 34)},${Math.max(0, b - 34)})`;
      context.beginPath();
      for (let i = lit ? 0 : 1; i < 5; i += 2) {
        const offset = (i / 4 - 0.5) * stroke.width * 0.62;
        context.moveTo(-radius * 1.1, offset);
        context.lineTo(radius * 1.1, offset * 0.7);
      }
      context.stroke();
    }

    context.restore();
    context.restore();
    context.globalAlpha = 1;
  }

  /** Draw the brush, tip exactly on the last stroke laid down. */
  drawBrush(context, stroke, width, height) {
    const scale = Math.min(width, height) / 720;
    const tipX = stroke.x;
    const tipY = stroke.y;

    // The brush comes in from the lower right, as a right-handed painter's
    // would, angled so the tip is unobstructed.
    const angle = -0.9;
    const ferruleLength = 62 * scale;
    const handleLength = 190 * scale;
    const dx = Math.cos(angle);
    const dy = -Math.sin(angle);

    context.save();

    // Handle: lacquered wood, tapering.
    const handleEnd = [tipX + dx * handleLength, tipY + dy * handleLength];
    const wood = context.createLinearGradient(tipX, tipY, handleEnd[0], handleEnd[1]);
    wood.addColorStop(0, '#6b4a2f');
    wood.addColorStop(0.5, '#8a5f3c');
    wood.addColorStop(1, '#4a3220');
    context.strokeStyle = wood;
    context.lineCap = 'round';
    context.lineWidth = 11 * scale;
    context.beginPath();
    context.moveTo(tipX + dx * ferruleLength, tipY + dy * ferruleLength);
    context.lineTo(handleEnd[0], handleEnd[1]);
    context.stroke();

    // Ferrule: metal band, brighter along one edge.
    const metal = context.createLinearGradient(
      tipX + dx * 14 * scale, tipY + dy * 14 * scale,
      tipX + dx * ferruleLength, tipY + dy * ferruleLength,
    );
    metal.addColorStop(0, '#9aa3ab');
    metal.addColorStop(0.4, '#e2e8ee');
    metal.addColorStop(1, '#78828b');
    context.strokeStyle = metal;
    context.lineWidth = 13 * scale;
    context.beginPath();
    context.moveTo(tipX + dx * 15 * scale, tipY + dy * 15 * scale);
    context.lineTo(tipX + dx * ferruleLength, tipY + dy * ferruleLength);
    context.stroke();

    // Bristles, in the colour currently being painted - the brush is loaded
    // with exactly the paint that is appearing under it.
    const [r, g, b] = Array.isArray(stroke.colour) ? stroke.colour : rgb(stroke.colour);
    context.strokeStyle = `rgb(${r},${g},${b})`;
    context.lineWidth = 9 * scale;
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(tipX + dx * 16 * scale, tipY + dy * 16 * scale);
    context.stroke();

    // Individual bristles splaying at the tip.
    context.lineWidth = 1.6 * scale;
    context.globalAlpha = 0.85;
    for (let i = -2; i <= 2; i++) {
      const spread = i * 2.6 * scale;
      context.beginPath();
      context.moveTo(tipX + dy * spread * 0.4, tipY - dx * spread * 0.4);
      context.lineTo(tipX + dx * 15 * scale + dy * spread, tipY + dy * 15 * scale - dx * spread);
      context.stroke();
    }

    // Wet paint gathering at the very tip.
    context.globalAlpha = 0.9;
    context.fillStyle = `rgb(${r},${g},${b})`;
    context.beginPath();
    context.arc(tipX, tipY, 3.2 * scale, 0, Math.PI * 2);
    context.fill();

    context.restore();
    context.globalAlpha = 1;
  }

  /**
   * Create the offscreen paint buffer.
   *
   * Returns null where no canvas can be created, so the renderer falls back to
   * drawing directly rather than failing.
   *
   * @param {number} width
   * @param {number} height
   * @returns {{canvas: object, context: object}|null}
   */
  makeBuffer(width, height) {
    try {
      const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      const context = canvas.getContext('2d');
      return context ? { canvas, context, width, height } : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch the artwork for a plan and rebuild its strokes around it.
   *
   * Guarded on the plan still being current: a track change during the fetch
   * would otherwise repaint the new song with the old song's cover.
   *
   * @param {object} plan
   * @param {number} width
   * @param {number} height
   */
  async loadPlanArtwork(plan, width, height) {
    if (!this.track?.thumbnail) return;
    const artwork = await this.loadArtwork(this.track.thumbnail);
    if (!artwork || this.plan !== plan) return;

    plan.artwork = artwork;
    // Darkest sampled colour, used for the lettering so the type belongs to the
    // picture's own palette rather than being an arbitrary black.
    let darkest = null;
    let lowest = Infinity;
    const { data } = artwork;
    for (let i = 0; i < data.data.length; i += 4) {
      const [r, g, b] = [data.data[i], data.data[i + 1], data.data[i + 2]];
      const luminance = r * 0.299 + g * 0.587 + b * 0.114;
      if (luminance < lowest) {
        lowest = luminance;
        darkest = [r, g, b];
      }
    }
    plan.inkColour = darkest ?? [26, 26, 26];

    plan.strokes = this.makeStrokes(plan, width, height);
    plan.artStrokeCount = plan.strokes.artStrokeCount;
    // The canvas already holds strokes from the fallback plan, which no longer
    // correspond to anything, so the painting restarts. Flagged rather than
    // cleared here: `render` rebuilds into a second buffer and keeps showing
    // the fallback painting until the real one has caught up, so the artwork
    // arriving never blanks the stage.
    this.repaint = true;
  }

  /** Rebuild the plan when the track changes. @param {object|null} track */
  setTrack(track) {
    this.track = track;
    this.plan = null;
    // A new track is a new painting, and here the blank canvas is the point -
    // dropping both buffers means the next frame starts from bare canvas
    // rather than from the previous song's picture. This is the one moment the
    // stage is deliberately empty.
    this.painted = 0;
    this.buffer = null;
    this.pending = null;
    this.repaint = false;
  }

  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;

    // Rebuild when the track or the canvas size changes; both invalidate the
    // stroke coordinates.
    const key = `${this.track?.providerId ?? 'none'}:${width}x${height}`;
    if (!this.plan || this.plan.canvasKey !== key) {
      this.plan = this.plan_(score, this.track);
      this.plan.canvasKey = key;
      // Built immediately from the fallback so there is always something to
      // paint, then rebuilt once the artwork arrives. Waiting on the network
      // before drawing anything would leave the canvas blank for a second or
      // two at the exact moment a track starts.
      this.plan.strokes = this.makeStrokes(this.plan, width, height);
      this.plan.artStrokeCount = this.plan.strokes.artStrokeCount;
      this.loadPlanArtwork(this.plan, width, height);
    }

    // Ground: an unpainted canvas, warm white rather than pure white so the
    // paint has something to sit against.
    context.fillStyle = '#f7f4ec';
    context.fillRect(0, 0, width, height);

    // Canvas weave, very faint. Without it the white reads as a blank screen.
    context.globalAlpha = 0.04;
    context.strokeStyle = '#8a7f6a';
    context.lineWidth = 1;
    for (let x = 0; x < width; x += 4) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    context.globalAlpha = 1;

    // How much of the painting is done: a function of position in the track, so
    // joining midway shows a partly-finished canvas.
    // The track's own length first, which is what the scrub bar shows.
    //
    // This read `score.source.duration_sec` first and fell back to a hardcoded
    // 240. Whenever that fallback was reached - a score whose source block is
    // missing or zero - a three-minute track was paced as though it were four,
    // so the picture was only ~74% done at the point the bar read 90% and the
    // lettering had not started at all. Diagnosed from a screenshot at 2:59 of
    // 3:19 showing the last ~1% of cells still unpainted; because strokes are
    // ordered by a hash-based scatter, that residue appears as speckle spread
    // evenly over the whole canvas rather than as an unfinished corner.
    //
    // Pacing from the track means the painting and the scrub bar can never
    // disagree, which is the only comparison a viewer can actually make.
    const duration = this.track?.durationSec
      || score.source?.duration_sec
      || score.analysis?.analysed_duration_sec
      || 240;
    const progress = Math.min(1, Math.max(0, playbackSec / duration));

    const strokes = this.plan.strokes;

    // Two schedules rather than one.
    //
    // A single curve over the whole list finished the picture in the first
    // third of a track and then spent the remainder on lettering. Pacing the
    // artwork to complete at 75% gives it three times as long, which is what
    // affords the extra detail; the title is then laid in quickly over the
    // final quarter, as a painter signs a finished canvas.
    const artworkEnd = 0.75;
    const artStrokes = this.plan.artStrokeCount;
    const letterStrokeCount = strokes.length - artStrokes;

    // Eased *back*, so the picture is still visibly gaining through to 75%.
    //
    // The exponent was 0.88, which front-loads: measured across the schedule it
    // put 70% of the image on the canvas by the halfway point of the song and
    // 85% by 62.5%, leaving the final third to add scattered detail the eye
    // does not register. The painting therefore looked finished around 60% even
    // though the last stroke genuinely landed at 75%.
    //
    // At 1.3 the same schedule reads 24% / 41% / 59% / 79% at 25 / 37.5 / 50 /
    // 62.5% of the song - still obviously building right up to the end of the
    // window. Lower it towards 1.0 if the opening feels too bare; 1.5 was the
    // other end tried and leaves only 19% painted a quarter of the way in.
    const artProgress = Math.min(1, progress / artworkEnd);
    const artCount = Math.floor(artStrokes * Math.pow(artProgress, 1.3));

    // Lettering is written over the twelve per cent after the artwork completes,
    // then holds - the poster is finished well before the track ends rather than
    // still going at the last second.
    const letterProgress = Math.min(1, Math.max(0, (progress - artworkEnd) / 0.12));

    const count = artCount + Math.floor(letterStrokeCount * letterProgress);

    // Paint into an offscreen buffer and blit it, rather than redrawing every
    // stroke each frame. A finished canvas is nearly a thousand strokes and
    // 59,000 canvas operations; accumulating means a frame costs only the
    // strokes that are actually new, which is usually none.
    //
    // Seeking backwards is the one case that needs a full repaint, since paint
    // cannot be un-applied - detected by the count going down.
    // A repaint is painted *behind* what is on screen, never over a cleared
    // canvas.
    //
    // Clearing the visible buffer and refilling it blanks the stage to bare
    // canvas, and with the per-frame budget below that blank lasts about a
    // second and a half rather than a single frame. Repeated - and the buffer
    // is rebuilt on any change of canvas size, so a resize or a device-ratio
    // change is enough - that reads as the page flashing white, which is
    // unpleasant to look at and was reported as causing headaches.
    //
    // So: keep displaying the last complete picture, build the replacement in a
    // second buffer, and swap only once it has caught up. The swap is then
    // invisible and the stage never goes blank mid-track.
    const sizeChanged = this.buffer
      && (this.buffer.width !== width || this.buffer.height !== height);

    if (!this.buffer) {
      // First paint of a track. An empty canvas is right here - a painting
      // starting from nothing is the whole idea.
      this.buffer = this.makeBuffer(width, height);
      this.painted = 0;
    } else if (sizeChanged || this.repaint || count < this.painted) {
      this.repaint = false;
      if (!this.pending || this.pending.width !== width || this.pending.height !== height) {
        this.pending = this.makeBuffer(width, height);
      } else {
        this.pending.context.clearRect(0, 0, width, height);
      }
      this.painted = 0;
    }

    const target = this.pending ?? this.buffer;
    if (target) {
      // Capped per frame. Ordinary playback never reaches this: the whole
      // poster is 39,296 strokes laid over 87% of a track, which is under 4 a
      // frame averaged and about 27 a frame through the lettering, its busiest
      // stretch. What the cap exists for is the jump - seeking forward, or
      // repainting after a backward seek clears the buffer - where the
      // uncapped loop laid every outstanding stroke in a single frame.
      //
      // `this.painted` is set to what was actually drawn, never to `count`.
      // Setting it to `count` marks strokes as painted that were never laid,
      // and because the accumulating buffer is never revisited those become
      // permanent holes in the picture.
      const limit = Math.min(count, this.painted + STROKE_BUDGET);
      for (let i = this.painted; i < limit; i++) {
        this.drawStroke(target.context, strokes[i]);
      }
      this.painted = limit;

      // The replacement only goes on screen once it has caught up with the
      // schedule, so the handover cannot show a partly-painted canvas.
      if (this.pending && this.painted >= count) {
        this.buffer = this.pending;
        this.pending = null;
      }

      // Drawn at the current size: while a resize is being repainted the
      // displayed buffer is still the old one, and scaling it for a frame or
      // two is invisible next to blanking the stage.
      context.drawImage(this.buffer.canvas, 0, 0, width, height);
    } else {
      // No offscreen canvas available: correct, just slower.
      for (let i = 0; i < count; i++) this.drawStroke(context, strokes[i]);
    }

    // Varnish: a warm glaze over the finished area, which is what gives oil its
    // depth rather than looking like flat gouache.
    context.globalAlpha = 0.06 + lanes.energy * 0.04;
    const varnish = context.createRadialGradient(
      width * 0.42, height * 0.38, 0, width * 0.5, height * 0.5, Math.hypot(width, height) * 0.6,
    );
    varnish.addColorStop(0, '#fff3d0');
    varnish.addColorStop(1, '#3a2a12');
    context.fillStyle = varnish;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    // The brush, at the most recent stroke laid down.
    if (count > 0 && count < strokes.length) {
      this.drawBrush(context, strokes[count - 1], width, height);
    }
  }
}
