/**
 * Second visualisation set, taking the total to twenty.
 *
 * Same contract as the first: a constructor taking a canvas, `resize()`, and
 * `render(score, playbackSec)`. They share {@link Canvas2DVisual}, which handles
 * sizing and the smoothed lane reader, so each file below is only the drawing.
 *
 * The set is deliberately varied in *kind* rather than in decoration: a
 * spectrum bent into a new shape is still a spectrum. These cover landscape,
 * weather, swarm, structure, sweep and orbit, so switching between them changes
 * what you are looking at rather than merely how it is coloured.
 */

import { Canvas2DVisual, mix, rgb } from './visuals.js';

/**
 * Galaxy: the solar system, sprawling outward.
 *
 * Replaces Nebula and Orbits, which were doing the same thing twice - both drew
 * bodies circling a centre with trails, and the only real difference was how
 * much they wandered. Merging them means one mode that does it properly.
 *
 * The inner system is accurate in the ways that read visually: the eight planets
 * in order, with relative orbital radii and periods roughly true to scale, so
 * Mercury whips round while Neptune barely moves. Beyond them the outer bodies
 * are free to sprawl - comets and debris on long eccentric paths that carry them
 * well past the edge of the frame and back.
 *
 * The sun never changes colour and never moves. It is the fixed point everything
 * else is legible against, and it only breathes with the beat.
 */
export class GalaxyVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.bodies = null;
    this.stars = null;
  }

  /** Build the system once. */
  build(bands) {
    if (this.bodies && this.bodies.bands === bands) return;

    // Relative orbital radius and period, normalised so the frame holds the
    // whole inner system. Periods are the real ratios - Neptune's year is 165
    // times Earth's - compressed logarithmically so the outer planets still
    // visibly move.
    const PLANETS = [
      { name: 'Mercury', radius: 0.10, period: 0.24, size: 2.0, colour: '#a8a29b' },
      { name: 'Venus', radius: 0.15, period: 0.62, size: 3.4, colour: '#e6c07a' },
      { name: 'Earth', radius: 0.21, period: 1.00, size: 3.6, colour: '#4a90d9' },
      { name: 'Mars', radius: 0.27, period: 1.88, size: 2.6, colour: '#c1502e' },
      { name: 'Jupiter', radius: 0.40, period: 11.9, size: 8.5, colour: '#d8a878' },
      { name: 'Saturn', radius: 0.52, period: 29.4, size: 7.2, colour: '#e3c98f', ring: true },
      { name: 'Uranus', radius: 0.63, period: 84.0, size: 5.0, colour: '#8fd4dd' },
      { name: 'Neptune', radius: 0.73, period: 165, size: 4.8, colour: '#3f5ec9' },
    ];

    const planets = PLANETS.map((planet, i) => ({
      ...planet,
      angle: (i * 2.399) % (Math.PI * 2),
      // Compressed so Neptune still travels: the true ratio would leave it
      // apparently motionless for the length of any song.
      speed: 1 / Math.pow(planet.period, 0.55),
      band: Math.floor((i / PLANETS.length) * bands),
      trail: [],
    }));

    // Outer bodies: comets and debris on long eccentric orbits that sprawl well
    // beyond the planets and off the edge of the frame.
    const rand = (i, n) => ((Math.sin(i * 31.7 + n * 173.3) * 43758.5453) % 1 + 1) % 1;
    // Roughly a fifth of the outer bodies orbit something other than the sun -
    // a rogue star out in the field rather than the system's centre. Their paths
    // therefore cross the frame at angles nothing else takes, which is what
    // stops the outer region reading as one uniform swarm.
    const outer = Array.from({ length: 32 }, (_, i) => ({
      rogue: rand(i, 20) < 0.20,
      // Where that star sits, as a fraction of the frame from the centre.
      hostX: (rand(i, 21) - 0.5) * 1.5,
      hostY: (rand(i, 22) - 0.5) * 1.2,
      angle: rand(i, 1) * Math.PI * 2,
      axis: 0.85 + rand(i, 2) * 1.5,
      eccentricity: 0.35 + rand(i, 3) * 0.45,
      inclination: (rand(i, 4) - 0.5) * 1.1,
      tilt: rand(i, 5) * Math.PI,
      precession: (rand(i, 6) - 0.5) * 0.12,
      speed: 0.10 + rand(i, 7) * 0.16,
      size: 1 + rand(i, 8) * 2.2,
      band: Math.floor(rand(i, 9) * bands),
      trail: [],
    }));

    this.bodies = { bands, planets, outer };
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;
    if (bands === 0) return;
    this.build(bands);

    context.fillStyle = '#01020a';
    context.fillRect(0, 0, width, height);

    const t = this.lanes.scoreSec;

    // A dense blanket of stars, fixed in place and individually twinkling.
    //
    // The previous field was sparse and every star shared one alpha, so they
    // pulsed together as a visible grid of dots. Six hundred with independent
    // phases reads as a real sky: nothing appears to move, but the field is
    // never quite still.
    if (!this.stars || this.stars.width !== width) {
      this.stars = {
        width,
        points: Array.from({ length: 600 }, (_, i) => ({
          x: ((i * 7919) % 10000) / 10000 * width,
          y: ((i * 6271) % 10000) / 10000 * height,
          size: ((i * 3571) % 100) / 100 < 0.08 ? 1.9 : 0.9,
          // Independent phase and rate, so no two blink together.
          phase: ((i * 4813) % 628) / 100,
          rate: 0.4 + ((i * 2749) % 100) / 100 * 1.4,
        })),
      };
    }

    context.fillStyle = '#ffffff';
    for (const star of this.stars.points) {
      const twinkle = 0.45 + 0.55 * Math.sin(t * star.rate + star.phase);
      context.globalAlpha = (0.20 + lanes.treble * 0.28) * twinkle;
      context.fillRect(star.x, star.y, star.size, star.size);
    }
    context.globalAlpha = 1;

    const band = context.createLinearGradient(0, height * 0.2, width, height * 0.8);
    band.addColorStop(0, 'rgba(0,0,0,0)');
    band.addColorStop(0.5, mix(from, '#ffffff', 0.25));
    band.addColorStop(1, 'rgba(0,0,0,0)');
    context.globalAlpha = 0.06 + lanes.energy * 0.05;
    context.fillStyle = band;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    const cx = width / 2;
    const cy = height / 2;
    // The inner system occupies a modest part of the frame so the outer bodies
    // have somewhere to sprawl into.
    // Larger, so the system fills the frame rather than sitting as a small
    // diagram in the middle of a lot of empty space.
    const scale = Math.min(width, height) * 0.56;

    context.globalCompositeOperation = 'lighter';

    // --- Outer bodies, drawn behind the planets ---------------------------
    for (const body of this.bodies.outer) {
      const level = lanes.spectrum[body.band % bands];
      body.angle += deltaSec * body.speed * (1 + level * 0.8);
      body.tilt += deltaSec * body.precession * 0.1;

      // Rogue systems are smaller, as a lone star's would be.
      const a = scale * body.axis * (body.rogue ? 0.35 : 1);
      const b = a * (1 - body.eccentricity);
      const ex = Math.cos(body.angle) * a;
      const ey = Math.sin(body.angle) * b * (0.4 + body.inclination * 0.4);
      // Rogue bodies orbit their own star rather than the sun.
      const hostX = body.rogue ? cx + body.hostX * scale : cx;
      const hostY = body.rogue ? cy + body.hostY * scale : cy;
      const x = hostX + ex * Math.cos(body.tilt) - ey * Math.sin(body.tilt);
      const y = hostY + ex * Math.sin(body.tilt) + ey * Math.cos(body.tilt);

      body.trail.push([x, y]);
      // Shorter and drawn as one continuous path. Long trails of separately
      // stroked segments appeared as faint dotted lines scattered across the
      // background, which read as rendering noise rather than as motion.
      if (body.trail.length > 26) body.trail.shift();

      const colour = mix(from, to, body.band / bands);
      context.strokeStyle = colour;
      context.globalAlpha = 0.10 + level * 0.30;
      context.lineWidth = 0.9 + level * 1.8;
      context.beginPath();
      for (let i = 0; i < body.trail.length; i++) {
        const [tx, ty] = body.trail[i];
        if (i === 0) context.moveTo(tx, ty);
        else context.lineTo(tx, ty);
      }
      context.stroke();

      context.fillStyle = colour;
      context.globalAlpha = 0.45 + level * 0.45;
      context.beginPath();
      context.arc(x, y, body.size * (1 + level * 0.6), 0, Math.PI * 2);
      context.fill();
    }

    // --- Planets -----------------------------------------------------------
    for (const planet of this.bodies.planets) {
      const level = lanes.spectrum[planet.band % bands];
      planet.angle += deltaSec * planet.speed * 0.28 * (1 + level * 0.5);

      const radius = scale * planet.radius;
      // A slight tilt to the whole plane, so the system is seen at an angle
      // rather than face on - which is what makes it read as three-dimensional.
      const x = cx + Math.cos(planet.angle) * radius;
      const y = cy + Math.sin(planet.angle) * radius * 0.62;

      planet.trail.push([x, y]);
      if (planet.trail.length > 110) planet.trail.shift();

      // Orbit path, brighter than before so the structure of the system is
      // obvious at a glance rather than something you have to look for.
      context.strokeStyle = mix(from, to, planet.radius);
      context.globalAlpha = 0.20 + level * 0.10;
      context.lineWidth = 1.2;
      context.beginPath();
      context.ellipse(cx, cy, radius, radius * 0.62, 0, 0, Math.PI * 2);
      context.stroke();

      // Trail.
      context.lineWidth = 1 + level * 2.5;
      for (let i = 1; i < planet.trail.length; i++) {
        context.strokeStyle = planet.colour;
        context.globalAlpha = (i / planet.trail.length) * (0.12 + level * 0.35);
        context.beginPath();
        context.moveTo(planet.trail[i - 1][0], planet.trail[i - 1][1]);
        context.lineTo(planet.trail[i][0], planet.trail[i][1]);
        context.stroke();
      }

      // Half again as large, and scaled to the canvas. These are the subject of
      // the mode and were reading as specks against the sun.
      const size = planet.size * 1.5 * (1 + level * 0.5) * (Math.min(width, height) / 720);

      // Saturn's rings, drawn before the body so the near half overlaps it.
      if (planet.ring) {
        context.strokeStyle = mix(planet.colour, '#ffffff', 0.4);
        context.globalAlpha = 0.5;
        context.lineWidth = Math.max(1, size * 0.28);
        context.beginPath();
        context.ellipse(x, y, size * 2.1, size * 0.7, 0.4, 0, Math.PI * 2);
        context.stroke();
      }

      context.fillStyle = planet.colour;
      context.globalAlpha = 0.9;
      context.beginPath();
      context.arc(x, y, size, 0, Math.PI * 2);
      context.fill();

      // A highlight on the sunward side, which gives each planet a little form.
      const toSun = Math.atan2(cy - y, cx - x);
      context.fillStyle = mix(planet.colour, '#ffffff', 0.55);
      context.globalAlpha = 0.55;
      context.beginPath();
      context.arc(x + Math.cos(toSun) * size * 0.3, y + Math.sin(toSun) * size * 0.3,
        size * 0.55, 0, Math.PI * 2);
      context.fill();
    }

    // --- The sun -----------------------------------------------------------
    // Fixed in colour and position; only its size answers the beat.
    // Smaller relative to the system than before. At the previous size its glow
    // reached past Mars and washed out the inner planets entirely.
    const sunRadius = scale * (0.048 + lanes.beat * 0.016 + lanes.bass * 0.008);
    const sun = context.createRadialGradient(cx, cy, 0, cx, cy, sunRadius * 3.4);
    sun.addColorStop(0, '#ffffff');
    sun.addColorStop(0.20, '#fff2c0');
    sun.addColorStop(0.42, 'rgba(255, 186, 60, 0.55)');
    sun.addColorStop(1, 'rgba(255, 120, 0, 0)');
    context.globalAlpha = 1;
    context.fillStyle = sun;
    context.beginPath();
    context.arc(cx, cy, sunRadius * 3.4, 0, Math.PI * 2);
    context.fill();

    context.globalCompositeOperation = 'source-over';
  }
}


/**
 * Terrain: a heightfield flown over, in perspective.
 *
 * The first attempt stacked polylines and scaled them, which is not perspective
 * - rows converged but nothing else did, so it read as flat ribbons rather than
 * ground. This projects a real grid: each vertex has a world position and is
 * divided by its depth, so the mesh converges correctly and the sense of flying
 * over something comes for free.
 *
 * Height comes from the spectrum, recorded one row per moment and scrolled
 * toward the viewer, so the landscape ahead is the music that has just played.
 */
export class TerrainVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    /** Height rows, newest at index 0 (nearest the camera). */
    this.rows = [];
    this.sinceRow = 0;
    this.offset = 0;
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    const ROWS = 34;
    const COLUMNS = 30;

    // Sky gradient down to the horizon.
    const sky = context.createLinearGradient(0, 0, 0, height * 0.55);
    sky.addColorStop(0, '#04030d');
    sky.addColorStop(1, mix(from, '#000000', 0.55));
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    // Sun, before the terrain so hills occlude it.
    // The horizon sits higher in frame so the sun clears the ridges.
    const horizonY = height * 0.36;
    const sunR = Math.min(width, height) * (0.15 + lanes.beat * 0.035);
    const sun = context.createRadialGradient(width / 2, horizonY, 0, width / 2, horizonY, sunR);
    sun.addColorStop(0, mix(to, '#ffffff', 0.45));
    sun.addColorStop(0.6, to);
    sun.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = sun;
    context.fillRect(0, 0, width, horizonY + sunR);

    // Scroll continuously and emit a row whenever a full cell has passed.
    const rowsPerSecond = 2.2 + lanes.energy * 2.6;
    this.offset += deltaSec * rowsPerSecond;
    while (this.offset >= 1) {
      this.offset -= 1;
      // Resample the spectrum across the grid width, mirrored so ridges run
      // symmetrically away from the centre line rather than sloping one way.
      const row = [];
      for (let c = 0; c <= COLUMNS; c++) {
        const across = Math.abs((c / COLUMNS) * 2 - 1);
        const band = Math.min(bands - 1, Math.floor(across * bands));
        row.push(lanes.spectrum[band]);
      }
      this.rows.unshift(row);
      if (this.rows.length > ROWS) this.rows.pop();
    }
    while (this.rows.length < ROWS) this.rows.push(new Array(COLUMNS + 1).fill(0));

    // Perspective projection of a ground-plane vertex.
    // Higher and further back than before, so more of the landscape's history
    // is visible at once and the hills no longer rise in front of the sun.
    const eyeHeight = 4.6;
    const focal = Math.min(width, height) * 0.95;
    const project = (x, y, z) => {
      const depth = Math.max(0.6, z);
      const scale = focal / depth;
      return { x: width / 2 + x * scale, y: horizonY + (eyeHeight - y) * scale, scale };
    };

    const spanX = 30;
    // Lower peaks: at the old amplitude the nearest ridges filled the frame.
    const amplitude = 1.7 + lanes.bass * 1.3;

    // Far to near, filling each quad strip so nearer ground hides farther.
    for (let r = this.rows.length - 1; r > 0; r--) {
      const near = this.rows[r - 1];
      const far = this.rows[r];
      const zNear = (r - 1 + this.offset) * 1.15 + 2.6;
      const zFar = (r + this.offset) * 1.15 + 2.6;
      const fade = 1 - r / this.rows.length;

      context.beginPath();
      for (let c = 0; c <= COLUMNS; c++) {
        const x = ((c / COLUMNS) - 0.5) * spanX;
        const p = project(x, far[c] * amplitude, zFar);
        if (c === 0) context.moveTo(p.x, p.y);
        else context.lineTo(p.x, p.y);
      }
      for (let c = COLUMNS; c >= 0; c--) {
        const x = ((c / COLUMNS) - 0.5) * spanX;
        const p = project(x, near[c] * amplitude, zNear);
        context.lineTo(p.x, p.y);
      }
      context.closePath();

      // Solid fill first, so the strip occludes everything beyond it.
      context.fillStyle = mix('#05030f', from, fade * 0.30);
      context.fill();
      context.strokeStyle = mix(from, to, fade);
      context.globalAlpha = 0.25 + fade * 0.65;
      context.lineWidth = Math.max(0.8, fade * 2.2);
      context.stroke();
    }

    // Longitudinal lines, which is what sells it as a grid being flown over.
    context.globalAlpha = 0.35;
    for (let c = 0; c <= COLUMNS; c += 2) {
      const x = ((c / COLUMNS) - 0.5) * spanX;
      context.beginPath();
      for (let r = 0; r < this.rows.length; r++) {
        const z = (r + this.offset) * 1.15 + 2.6;
        const p = project(x, this.rows[r][c] * amplitude, z);
        if (r === 0) context.moveTo(p.x, p.y);
        else context.lineTo(p.x, p.y);
      }
      context.strokeStyle = mix(to, from, 0.4);
      context.lineWidth = 1;
      context.stroke();
    }
    context.globalAlpha = 1;
  }
}

/**
 * Rain: streaks falling at a rate set by the music.
 *
 * Drops splash on impact, and the beat briefly steepens the fall, so rhythm is
 * visible in the sheet rather than only in colour.
 */
export class RainVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.drops = [];
    this.splashes = [];
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    context.fillStyle = 'rgba(4, 6, 14, 0.35)';
    context.fillRect(0, 0, width, height);

    // Bass drives the count, so a heavy passage is a heavier downpour. Energy
    // still contributes, but bass is what the request was about and what a
    // listener feels as the weight of the track.
    const target = Math.floor(90 + lanes.energy * 220 + lanes.bass * 420);
    while (this.drops.length < target) {
      // Size and speed correlate, as they do in reality: bigger drops fall
      // faster. Kept within a believable range - nothing the size of a marble.
      const size = 0.55 + Math.random() * 0.75;
      this.drops.push({
        x: Math.random() * width,
        // Spawned across the full height rather than only above the frame, so a
        // sudden increase in count fills in rather than arriving as a curtain.
        y: Math.random() * height * 1.8 - height,
        speed: 0.7 + size * 0.7,
        length: 6 + size * 26,
        size,
      });
    }
    if (this.drops.length > target) this.drops.length = target;

    // Fall speed tracks the spectrum's overall level, so the rain visibly
    // quickens with the music rather than only becoming denser.
    const fall = height * (0.50 + lanes.energy * 0.75 + lanes.beat * 0.40
      + lanes.treble * 0.25);
    const groundY = height * 0.88;

    // Drawn in two passes by size, so thin drops read as distant and fat ones
    // as near - a single width made the sheet look like scratches on glass.
    // Position is advanced for every drop before drawing, not inside the draw
    // pass. Advancing inside meant only the thin drops moved, so the fat ones
    // hung motionless as vertical lines across the top of the frame.
    for (const drop of this.drops) {
      drop.y += fall * drop.speed * deltaSec;
    }

    for (const pass of [0, 1]) {
      context.strokeStyle = mix(from, to, pass === 0 ? 0.3 : 0.6);
      context.lineWidth = pass === 0 ? 0.9 : 1.8;
      context.globalAlpha = (pass === 0 ? 0.35 : 0.65) + lanes.energy * 0.3;
      context.beginPath();
      for (const drop of this.drops) {
        if ((drop.size > 0.85) !== (pass === 1)) continue;
        if (drop.y > groundY) {
          this.splashes.push({
            x: drop.x, y: groundY, radius: 0, life: 1, size: drop.size,
          });
          drop.y = -20;
          drop.x = Math.random() * width;
        }
        context.moveTo(drop.x, drop.y);
        context.lineTo(drop.x, drop.y + drop.length * drop.speed);
      }
      context.stroke();
    }

    // Splashes, capped so a loud passage cannot fill the array unboundedly.
    context.globalAlpha = 1;
    if (this.splashes.length > 220) this.splashes.splice(0, this.splashes.length - 220);
    for (const splash of this.splashes) {
      // Bigger drops make bigger, slower ripples.
      splash.radius += (40 + splash.size * 60) * deltaSec;
      splash.life -= deltaSec * (2.6 - splash.size);
      if (splash.life <= 0) continue;

      // Two concentric rings: real ripples travel outward as a train, and a
      // single ring looks like a drawn circle rather than water.
      for (const ring of [0, 1]) {
        const radius = splash.radius * (1 - ring * 0.45);
        if (radius <= 0) continue;
        context.strokeStyle = mix(to, '#ffffff', 0.45);
        context.globalAlpha = splash.life * (ring === 0 ? 0.45 : 0.22);
        context.lineWidth = 1 + splash.size * 0.6;
        context.beginPath();
        context.ellipse(splash.x, splash.y, radius, radius * 0.28, 0, 0, Math.PI * 2);
        context.stroke();
      }

      // A short vertical highlight where the drop struck, which is what sells
      // impact rather than a ring appearing from nowhere.
      if (splash.life > 0.7) {
        context.globalAlpha = (splash.life - 0.7) * 2.4;
        context.beginPath();
        context.moveTo(splash.x, splash.y);
        context.lineTo(splash.x, splash.y - 6 * splash.size);
        context.stroke();
      }
    }
    this.splashes = this.splashes.filter((splash) => splash.life > 0);

    // Wet ground reflecting the palette.
    const sheen = context.createLinearGradient(0, groundY, 0, height);
    sheen.addColorStop(0, mix(from, '#000000', 0.45));
    sheen.addColorStop(1, '#03030a');
    context.globalAlpha = 1;
    context.fillStyle = sheen;
    context.fillRect(0, groundY, width, height - groundY);

    // Reflected rain in the wet ground: the same streaks mirrored, faint and
    // horizontally wobbled so the surface reads as disturbed water.
    context.save();
    context.beginPath();
    context.rect(0, groundY, width, height - groundY);
    context.clip();
    context.globalAlpha = 0.16 + lanes.energy * 0.10;
    context.strokeStyle = mix(to, '#ffffff', 0.3);
    context.lineWidth = 1.2;
    context.beginPath();
    for (const drop of this.drops) {
      if (drop.y < groundY - height * 0.25) continue;
      const mirrored = groundY + (groundY - drop.y) * 0.5;
      const wobble = Math.sin((mirrored + this.lanes.scoreSec * 2.5) * 0.08) * 3;
      context.moveTo(drop.x + wobble, mirrored);
      context.lineTo(drop.x + wobble, mirrored + drop.length * 0.4);
    }
    context.stroke();
    context.restore();
    context.globalAlpha = 1;
  }
}

/**
 * Fireflies: a murmuration wheeling across the frame.
 *
 * Rewritten from a simple attractor swarm, which looked like dots drifting. A
 * flock reads as a flock because of three behaviours acting together - cohesion
 * toward the local centre, alignment with neighbours, and separation to avoid
 * collision - and because the whole mass travels while individuals lag behind
 * it.
 *
 * Running true boids over 700 birds would be 490,000 comparisons a frame. This
 * uses a **uniform grid**: each bird only inspects the cell it occupies and its
 * neighbours, which keeps the cost roughly linear and lets the count go high
 * enough to actually look like a flock.
 */
export class FirefliesVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.birds = [];
    this.grid = new Map();
  }

  /** Rebuild the spatial index for this frame. */
  index(cellSize) {
    this.grid.clear();
    for (const bird of this.birds) {
      const key = `${Math.floor(bird.x / cellSize)},${Math.floor(bird.y / cellSize)}`;
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, cell = []);
      cell.push(bird);
    }
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    // Short trails: long ones smear a fast flock into a fog.
    context.fillStyle = 'rgba(3, 4, 10, 0.30)';
    context.fillRect(0, 0, width, height);

    // Enough to fill most of the frame. The grid keeps this affordable.
    const target = Math.floor(1680 + lanes.energy * 1080);
    while (this.birds.length < target) {
      const angle = Math.random() * Math.PI * 2;
      this.birds.push({
        x: width * 0.5 + Math.cos(angle) * width * 0.3,
        y: height * 0.5 + Math.sin(angle) * height * 0.3,
        vx: Math.cos(angle + 1.57) * 90,
        vy: Math.sin(angle + 1.57) * 90,
        seed: Math.random(),
      });
    }
    if (this.birds.length > target) this.birds.length = target;

    const cellSize = Math.max(28, Math.min(width, height) * 0.06);
    this.index(cellSize);

    const t = this.lanes.scoreSec;
    // No attractor. Pulling every bird toward a moving point produced a visible
    // ring in the middle of the frame - the flock orbited it instead of roaming.
    // A slowly turning shared heading gives direction without a centre.
    const drift = t * 0.13;
    const headingX = Math.cos(drift) + Math.sin(t * 0.07) * 0.4;
    const headingY = Math.sin(drift * 0.8) + Math.cos(t * 0.05) * 0.4;

    // Half again as fast as before.
    const speed = 230 + lanes.energy * 390;
    const scatter = lanes.beat * 260;

    for (const bird of this.birds) {
      const cx = Math.floor(bird.x / cellSize);
      const cy = Math.floor(bird.y / cellSize);

      let sumX = 0; let sumY = 0; let sumVX = 0; let sumVY = 0;
      let pushX = 0; let pushY = 0; let count = 0;

      // Only the nine surrounding cells, which is what makes this affordable.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cell = this.grid.get(`${cx + ox},${cy + oy}`);
          if (!cell) continue;
          for (const other of cell) {
            if (other === bird) continue;
            const dx = other.x - bird.x;
            const dy = other.y - bird.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > cellSize * cellSize) continue;
            sumX += other.x; sumY += other.y;
            sumVX += other.vx; sumVY += other.vy;
            count += 1;
            // Separation, strongest when very close.
            if (d2 < 320) {
              pushX -= dx / (d2 + 1) * 900;
              pushY -= dy / (d2 + 1) * 900;
            }
          }
        }
      }

      if (count > 0) {
        // Cohesion toward the local centre.
        bird.vx += ((sumX / count) - bird.x) * 0.9 * deltaSec;
        bird.vy += ((sumY / count) - bird.y) * 0.9 * deltaSec;
        // Alignment with neighbours' heading.
        bird.vx += ((sumVX / count) - bird.vx) * 1.6 * deltaSec;
        bird.vy += ((sumVY / count) - bird.vy) * 1.6 * deltaSec;
      }
      bird.vx += pushX * deltaSec;
      bird.vy += pushY * deltaSec;

      // A shared drifting heading, weighted per bird, so the whole mass travels
      // in fun wandering directions without converging on a point.
      bird.vx += headingX * (40 + bird.seed * 70) * deltaSec;
      bird.vy += headingY * (40 + bird.seed * 70) * deltaSec;

      // The beat scatters them sideways to their heading, which reads as the
      // flock flaring rather than exploding from a centre.
      const perpendicular = Math.atan2(bird.vy, bird.vx) + Math.PI / 2;
      const flare = (bird.seed < 0.5 ? 1 : -1) * scatter;
      bird.vx += Math.cos(perpendicular) * flare * deltaSec;
      bird.vy += Math.sin(perpendicular) * flare * deltaSec;

      // Normalise toward a common cruising speed: real flocks do not have
      // stragglers drifting at a tenth of everyone else's pace.
      const current = Math.hypot(bird.vx, bird.vy) || 1;
      const wanted = speed * (0.85 + bird.seed * 0.3);
      bird.vx *= 1 + (wanted / current - 1) * 0.06;
      bird.vy *= 1 + (wanted / current - 1) * 0.06;

      bird.x += bird.vx * deltaSec;
      bird.y += bird.vy * deltaSec;

      // Wrap, so the flock can leave and return rather than bouncing.
      if (bird.x < -40) bird.x = width + 40;
      if (bird.x > width + 40) bird.x = -40;
      if (bird.y < -40) bird.y = height + 40;
      if (bird.y > height + 40) bird.y = -40;
    }

    // Drawn as short heading-aligned strokes, not dots: direction is most of
    // what makes a flock legible.
    //
    // Batched into a handful of colour buckets and stroked once each. Setting
    // style and stroking per bird was four canvas calls times two thousand
    // birds; this is four calls times six.
    context.lineCap = 'round';
    const BUCKETS = 6;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const low = bucket / BUCKETS;
      const high = (bucket + 1) / BUCKETS;
      context.strokeStyle = mix(from, to, (low + high) / 2);
      context.globalAlpha = 0.42 + (low + high) / 2 * 0.4;
      context.lineWidth = 0.9 + (low + high) / 2 * 1.1;
      context.beginPath();
      for (const bird of this.birds) {
        if (bird.seed < low || bird.seed >= high) continue;
        const heading = Math.atan2(bird.vy, bird.vx);
        const length = 2 + bird.seed * 3.5 + lanes.energy * 3;
        context.moveTo(bird.x, bird.y);
        context.lineTo(bird.x - Math.cos(heading) * length, bird.y - Math.sin(heading) * length);
      }
      context.stroke();
    }
    context.globalAlpha = 1;
  }
}

/**
 * Ribbons: flowing bands threading across the frame.
 *
 * Each ribbon is a smooth curve whose control points come from the spectrum, so
 * they braid and separate with the music. Drawn with soft wide strokes under
 * thin bright ones, which is what makes them look like fabric rather than wire.
 */
export class RibbonsVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    context.fillStyle = 'rgba(4, 4, 10, 0.30)';
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';

    const t = this.lanes.scoreSec;
    const steps = 96;

    for (let r = 0; r < 6; r++) {
      const phase = t * (0.9 + r * 0.35) + r * 1.1;
      const points = [];

      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const level = lanes.spectrum[Math.min(bands - 1, Math.floor(u * bands))];
        // Several frequencies stacked, the fastest jittering hard: electricity
        // is a smooth path with a high-frequency crackle on top, and the old
        // single slow sine had none of that.
        const jitter =
          Math.sin(u * 34 + phase * 7) * 0.30
          + Math.sin(u * 71 + phase * 13) * 0.16
          + Math.sin(u * 141 + phase * 23) * 0.08;
        const y = height * 0.5
          + Math.sin(u * 5.4 + phase * 0.5) * height * (0.10 + r * 0.025)
          + jitter * height * (0.05 + level * 0.13 + lanes.energy * 0.06);
        points.push([u * width, y]);
      }

      const colour = mix(from, to, r / 5);

      // Three passes: a wide dim halo, the arc itself, then a white-hot core.
      // That layering is what makes a line read as glowing rather than drawn.
      for (const [widthScale, alpha, tint] of [
        [16, 0.05 + lanes.energy * 0.07, colour],
        [4, 0.30, colour],
        [1.2, 0.85, mix(colour, '#ffffff', 0.75)],
      ]) {
        context.strokeStyle = tint;
        context.globalAlpha = alpha;
        context.lineWidth = widthScale * (0.6 + lanes.bass * 0.7);
        context.beginPath();
        for (const [x, y] of points) context.lineTo(x, y);
        context.stroke();
      }

      // Occasional branch forking off the arc, as a discharge does.
      if (lanes.punch > 0.45 && r % 2 === 0) {
        const at = Math.floor(steps * (0.2 + (r / 6) * 0.6));
        const [bx, by] = points[at];
        context.strokeStyle = mix(colour, '#ffffff', 0.5);
        context.globalAlpha = lanes.punch * 0.7;
        context.lineWidth = 1.4;
        context.beginPath();
        context.moveTo(bx, by);
        let x = bx; let y = by;
        for (let step = 0; step < 5; step++) {
          x += (Math.random() - 0.5) * width * 0.05;
          y += (Math.random() - 0.4) * height * 0.06;
          context.lineTo(x, y);
        }
        context.stroke();
      }
    }

    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
}





/**
 * Mosaic: a grid of tiles lit by the spectrum.
 *
 * Each tile maps to a band and a position, and lights when its band exceeds a
 * threshold that varies across the grid. The result is a shifting pattern rather
 * than a bar chart, and it stays legible at any window size.
 */
/**
 * Directions the mosaic's light can travel.
 *
 * The band index was `(cx + cy) % bands`, which puts every tile on an
 * anti-diagonal in the same band - so the grid always lit along one diagonal,
 * in one direction, for every track ever played. Projecting the tile onto a
 * chosen axis instead gives the same pattern a direction, and swapping the axis
 * gives the visualisation seven behaviours rather than one.
 *
 * Module-level so the array is not rebuilt on every frame.
 *
 * @type {Array<(cx: number, cy: number, columns: number, rows: number) => number>}
 */
const MOSAIC_AXES = [
  (cx, cy) => cx + cy,                        // down-right diagonal, the original
  (cx, cy, columns) => (columns - cx) + cy,   // down-left diagonal
  (cx) => cx,                                 // left to right
  (cx, cy, columns) => columns - cx,          // right to left
  (cx, cy) => cy,                             // top to bottom
  (cx, cy, columns, rows) => rows - cy,       // bottom to top
  // Outward from the middle, which reads quite differently from any sweep.
  (cx, cy, columns, rows) => Math.round(Math.hypot(cx - columns / 2, cy - rows / 2)),
];

export class MosaicVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    context.fillStyle = '#05050c';
    context.fillRect(0, 0, width, height);

    const columns = 16;
    const rows = Math.max(6, Math.round(columns * height / width));
    const tileW = width / columns;
    const tileH = height / rows;
    const gap = Math.min(tileW, tileH) * 0.10;
    const t = this.lanes.scoreSec;

    // The direction changes at section boundaries - a structural event the ear
    // is already expecting - rather than on a timer. Keyed to sectionIndex, so
    // it is identical for everyone watching and a seek lands on the right one
    // instead of wherever a wall clock had drifted to.
    const axis = MOSAIC_AXES[
      Math.abs(lanes.sectionIndex ?? 0) % MOSAIC_AXES.length
    ];

    for (let cx = 0; cx < columns; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        // Wrapped twice: an axis such as `columns - cx` goes negative once the
        // grid is wider than the band count, and a negative remainder would
        // index off the end of the spectrum.
        const band = ((axis(cx, cy, columns, rows) % bands) + bands) % bands;
        const level = lanes.spectrum[band];
        // Threshold varies per tile, so the grid lights in patterns rather than
        // in solid rows.
        const threshold = 0.18 + 0.45 * Math.abs(Math.sin(cx * 1.7 + cy * 2.3 + t * 0.4));
        if (level < threshold) continue;

        const strength = Math.min(1, (level - threshold) / 0.4);
        context.fillStyle = strength > 0.7
          ? mix(to, '#ffffff', (strength - 0.7) * 2)
          : mix(from, to, band / (bands - 1));
        context.globalAlpha = 0.25 + strength * 0.75;
        context.fillRect(
          cx * tileW + gap, cy * tileH + gap,
          tileW - gap * 2, tileH - gap * 2,
        );
      }
    }
    context.globalAlpha = 1;
  }
}

/**
 * Aurora: vertical curtains of light rippling across the sky.
 *
 * Each curtain is a tall gradient whose horizontal position and waviness come
 * from the spectrum. Additive blending makes overlaps brighten, which is exactly
 * how the real thing behaves.
 */
export class AuroraVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;

    // Water column: light from above falling away into darkness below.
    const water = context.createLinearGradient(0, 0, 0, height);
    water.addColorStop(0, mix(from, '#001018', 0.72));
    water.addColorStop(0.45, '#02121c');
    water.addColorStop(1, '#01070c');
    context.fillStyle = water;
    context.fillRect(0, 0, width, height);

    const t = this.lanes.scoreSec;

    // Shafts of light from the surface, swaying. These sit behind everything
    // and are what make the scene read as underwater rather than as sky.
    context.globalCompositeOperation = 'lighter';
    for (let shaft = 0; shaft < 7; shaft++) {
      const x = width * ((shaft + 0.5) / 7) + Math.sin(t * 0.3 + shaft) * width * 0.04;
      const beam = context.createLinearGradient(x, 0, x, height * 0.85);
      beam.addColorStop(0, `rgba(180, 235, 255, ${0.05 + lanes.energy * 0.05})`);
      beam.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = beam;
      context.beginPath();
      context.moveTo(x - width * 0.02, 0);
      context.lineTo(x + width * 0.02, 0);
      context.lineTo(x + width * 0.09, height * 0.85);
      context.lineTo(x - width * 0.09, height * 0.85);
      context.closePath();
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';

    // Suspended particles drifting upward, as in any real underwater shot.
    context.fillStyle = '#cfeaf5';
    context.globalAlpha = 0.20 + lanes.treble * 0.30;
    for (let i = 0; i < 140; i++) {
      const x = ((i * 4813) % 1000) / 1000 * width
        + Math.sin(t * 0.4 + i) * 6;
      const y = (((i * 2749) % 1000) / 1000 * height - t * 12) % height;
      context.fillRect(x, y < 0 ? y + height : y, 1.4, 1.4);
    }

    context.globalCompositeOperation = 'lighter';
    // More fronds than before, since kelp grows in stands rather than in a
    // handful of separate curtains.
    const curtains = Math.max(10, Math.min(bands, 16));

    for (let c = 0; c < curtains; c++) {
      const level = bands > 0 ? lanes.spectrum[c % bands] : lanes.energy;
      const baseX = width * ((c + 0.5) / curtains);
      // Kelp is anchored to the seabed and sways at the top, so the movement is
      // largest far from the floor - the opposite of a hanging curtain.
      const sway = Math.sin(t * 0.5 + c * 0.9) * width * 0.05;
      const top = height * (0.10 + 0.16 * Math.sin(t * 0.28 + c) - level * 0.06);
      const bottom = height * 1.02;

      const glow = context.createLinearGradient(0, top, 0, bottom);
      const colour = mix(from, to, c / (curtains - 1));
      glow.addColorStop(0, 'rgba(0,0,0,0)');
      glow.addColorStop(0.35, colour);
      glow.addColorStop(1, 'rgba(0,0,0,0)');

      context.fillStyle = glow;
      context.globalAlpha = 0.16 + level * 0.55;

      // A wavy band rather than a rectangle: drawn as a ribbon of segments so
      // the curtain folds instead of standing rigid.
      const bandWidth = (width / curtains) * (0.5 + level * 0.7);
      context.beginPath();
      // Sway scaled by height above the seabed, so the frond is rooted.
      const bend = (y) => {
        const above = Math.max(0, (bottom - y) / (bottom - top));
        return Math.sin(y * 0.010 + t * 0.9 + c) * width * 0.025 * above
          + sway * above * above;
      };
      for (let y = top; y <= bottom; y += 12) {
        context.lineTo(baseX + bend(y) - bandWidth / 2, y);
      }
      for (let y = bottom; y >= top; y -= 12) {
        context.lineTo(baseX + bend(y) + bandWidth / 2, y);
      }
      context.closePath();
      context.fill();

      // Vertical striations inside each curtain. Real aurorae are made of rays
      // aligned with the magnetic field, and without them a curtain is just a
      // smear of colour.
      context.strokeStyle = mix(colour, '#ffffff', 0.35);
      context.globalAlpha = 0.06 + level * 0.22;
      context.lineWidth = 1.2;
      // Veins running the length of each frond.
      for (let ray = 0; ray < 5; ray++) {
        const offset = (ray / 4 - 0.5) * bandWidth;
        context.beginPath();
        for (let y = top; y <= bottom; y += 16) {
          context.lineTo(baseX + bend(y) + offset, y);
        }
        context.stroke();
      }
    }

    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
}

/**
 * Pulse: shockwaves crossing a field of light.
 *
 * Replaces Strobe, which flashed polygons on the beat and conveyed nothing -
 * flashing is an effect, not an idea.
 *
 * Here every beat emits a ring that travels outward, and a grid of points is
 * displaced and brightened as each wavefront passes through it. The rhythm is
 * therefore visible in the *interference* between waves rather than in a flash:
 * a fast passage has several rings crossing at once, a sparse one has a single
 * ripple crossing an otherwise still field.
 */
/**
 * Directional swell trains, viewed from directly overhead.
 *
 * The beat-driven rings on their own read as impacts on a flat plane, because a
 * flat plane is what they were hitting - between beats the field had nothing but
 * a per-point shimmer, which is noise rather than water. Open sea is never flat:
 * it always carries a long dominant swell, usually with a second shorter train
 * crossing it at an angle and a third finer one on top. Where two crests meet
 * they stack, where a crest meets a trough they cancel, and that interference
 * pattern is what the eye recognises as sea from the air.
 *
 * Three trains at incommensurate angles and wavelengths, so the pattern never
 * visibly repeats. `length` is a fraction of the short side of the canvas, so
 * the swell keeps its scale relative to the frame at any size.
 */
const SWELLS = [
  { angle: 0.42, length: 0.62, speed: 0.42, weight: 1.00 },
  { angle: 1.15, length: 0.33, speed: 0.68, weight: 0.55 },
  { angle: 2.31, length: 0.17, speed: 1.05, weight: 0.28 },
];
const SWELL_TOTAL = SWELLS.reduce((sum, s) => sum + s.weight, 0);

export class PulseVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.waves = [];
    this.lastBeat = -1;
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    // Deep water, not black. A vertical gradient reads as the sea receding from
    // the viewer even under an overhead camera, because the far water carries
    // more of the sky in it.
    const sea = context.createLinearGradient(0, 0, 0, height);
    sea.addColorStop(0, mix('#04070f', from, 0.14));
    sea.addColorStop(1, mix('#02030a', to, 0.06));
    context.fillStyle = sea;
    context.fillRect(0, 0, width, height);

    // One wave per beat, from a position that walks around so the field is
    // never struck twice from the same place.
    const beatIndex = Math.floor(lanes.beatCount);
    if (beatIndex !== this.lastBeat) {
      this.lastBeat = beatIndex;
      const angle = beatIndex * 2.399;
      this.waves.push({
        x: width * (0.5 + Math.cos(angle) * 0.28),
        y: height * (0.5 + Math.sin(angle) * 0.26),
        radius: 0,
        strength: 0.55 + lanes.energy * 0.65,
      });
      // A second wave on heavy beats, offset, so a bass-driven passage has
      // several fronts crossing at once rather than one at a time.
      if (lanes.bass > 0.5) {
        this.waves.push({
          x: width * (0.5 - Math.cos(angle) * 0.22),
          y: height * (0.5 - Math.sin(angle) * 0.20),
          radius: 0,
          strength: (0.35 + lanes.bass * 0.55),
        });
      }
      if (this.waves.length > 20) this.waves.shift();
    }

    const speed = Math.max(width, height) * (0.32 + lanes.flux * 0.28);
    for (const wave of this.waves) {
      wave.radius += speed * deltaSec;
      wave.strength *= Math.pow(0.55, deltaSec);
    }
    this.waves = this.waves.filter(
      (wave) => wave.strength > 0.02 && wave.radius < Math.hypot(width, height),
    );

    // The field. Spacing scales with the canvas so density is consistent.
    // A tenth denser than before, which is as far as it goes before the field
    // stops reading as discrete points.
    const spacing = Math.max(14, Math.min(width, height) / 46);
    const columns = Math.ceil(width / spacing) + 1;
    const rows = Math.ceil(height / spacing) + 1;
    const bands = lanes.spectrum.length;

    context.globalCompositeOperation = 'lighter';

    const BUCKETS = 6;
    const buckets = Array.from({ length: BUCKETS }, () => []);
    const foam = [];

    // Swell geometry, hoisted: these depend on the canvas and the clock, not on
    // the point, and the inner loop runs a couple of thousand times a frame.
    const shortSide = Math.min(width, height);
    const swellTime = this.lanes.scoreSec;
    const swells = SWELLS.map((s) => ({
      kx: Math.cos(s.angle) * ((Math.PI * 2) / (shortSide * s.length)),
      ky: Math.sin(s.angle) * ((Math.PI * 2) / (shortSide * s.length)),
      phase: swellTime * s.speed * 2.2,
      weight: s.weight,
    }));
    // The sea gets rougher with the track rather than the swell simply getting
    // brighter, which is what keeps quiet passages looking like calm water.
    const roughness = 0.35 + lanes.energy * 0.75 + lanes.bass * 0.30;

    for (let cx = 0; cx < columns; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const baseX = cx * spacing;
        const baseY = cy * spacing;

        // Surface height at this point, -1 in a trough to +1 on a crest.
        let swell = 0;
        for (const s of swells) {
          swell += Math.sin(baseX * s.kx + baseY * s.ky - s.phase) * s.weight;
        }
        swell = (swell / SWELL_TOTAL) * roughness;

        let displaceX = 0;
        let displaceY = 0;
        let brightness = 0;

        for (const wave of this.waves) {
          const dx = baseX - wave.x;
          const dy = baseY - wave.y;
          const distance = Math.hypot(dx, dy) || 1;
          // Only points near the wavefront respond, which is what makes the
          // ring visible rather than the whole field brightening at once.
          const offset = distance - wave.radius;
          const influence = Math.exp(-(offset * offset) / (spacing * spacing * 9));
          if (influence < 0.01) continue;
          const push = influence * wave.strength * spacing * 1.4;
          displaceX += (dx / distance) * push;
          displaceY += (dy / distance) * push;
          brightness += influence * wave.strength;
        }

        // A quiet baseline shimmer keyed to the spectrum, so the field is alive
        // between beats instead of frozen.
        const band = bands > 0 ? lanes.spectrum[(cx + cy) % bands] : lanes.energy;

        // Water rides up the face of a swell and slides back down its rear, so
        // the points bunch along the crests and thin out over the troughs. That
        // bunching is most of what makes a still frame read as water rather than
        // as a grid with a brightness gradient painted over it.
        const crest = (swell + 1) / 2;
        displaceX += Math.cos(SWELLS[0].angle) * swell * spacing * 0.55;
        displaceY += Math.sin(SWELLS[0].angle) * swell * spacing * 0.55;

        // Height reads as light: a crest catches the sky, a trough sits in
        // shadow. Added to the shockwave term so a beat still lifts the surface.
        const lit = brightness + crest * 0.55;
        const size = (0.7 + crest * 1.1) + band * 1.4 + Math.min(brightness, 1.4) * 3.0;

        // Foam, only where a crest is genuinely breaking. Gated hard so calm
        // water carries none at all - foam everywhere is the thing that makes
        // rendered sea look like static.
        if (swell > 0.72 && crest * roughness > 0.62) {
          foam.push([baseX + displaceX, baseY + displaceY, size * 0.55]);
        }

        // Collected rather than drawn: points are bucketed by brightness below
        // so the whole field costs a handful of fills instead of one per point.
        const bucket = Math.min(BUCKETS - 1, Math.floor(Math.min(lit, 1) * BUCKETS));
        buckets[bucket].push([baseX + displaceX, baseY + displaceY, size, band]);
      }
    }

    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const points = buckets[bucket];
      if (points.length === 0) continue;
      const brightness = (bucket + 0.5) / BUCKETS;
      context.fillStyle = brightness > 0.5
        ? mix(to, '#ffffff', Math.min(1, (brightness - 0.5) * 1.4))
        : mix(from, to, brightness);
      // More saturated overall: the field was legible but muted against the
      // shockwaves, so the two never felt like one image.
      context.globalAlpha = 0.20 + brightness * 0.80;
      context.beginPath();
      for (const [x, y, size] of points) {
        context.moveTo(x + size, y);
        context.arc(x, y, size, 0, Math.PI * 2);
      }
      context.fill();
    }

    // Foam on the breaking crests, drawn last so it sits on top of the water
    // rather than being averaged into it. Near-white and barely tinted: foam is
    // aerated water and takes almost no colour from the sea beneath it.
    if (foam.length > 0) {
      context.fillStyle = mix('#ffffff', to, 0.10);
      context.globalAlpha = 0.30 + lanes.energy * 0.45;
      context.beginPath();
      for (const [fx, fy, fr] of foam) {
        context.moveTo(fx + fr, fy);
        context.arc(fx, fy, fr, 0, Math.PI * 2);
      }
      context.fill();
    }

    // Faint ring outlines, which give the waves an edge to read against.
    for (const wave of this.waves) {
      context.strokeStyle = mix(to, '#ffffff', 0.3);
      context.globalAlpha = wave.strength * 0.20;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2);
      context.stroke();
    }

    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
}
