/**
 * Shader visualiser: the lightweight ("Windows Media Player") render mode.
 *
 * Reads a VisualScore and a playback position, and paints a full-bleed
 * reactive field. It never touches audio - all reactivity comes from the
 * pre-computed lanes, which keeps the Activity browser independent from the
 * server-side audio decoder and Discord voice stream.
 *
 * The silhouette mode will consume the same score and the same clock; only the
 * draw call differs.
 */

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

/**
 * Fragment shader.
 *
 * Structure: a domain-warped fractal noise field supplies the base motion,
 * bass drives concentric pressure rings from the centre, punch drives a
 * short-lived bloom, and hue comes from the brightness lane offset by the
 * current section - so a section change reads as a deliberate palette shift
 * rather than a cut.
 */
const FRAGMENT_SHADER = `
precision highp float;

uniform vec2  uResolution;
uniform float uTime;        // seconds since load
uniform float uEnergy;      // 0-1 overall loudness
uniform float uPunch;       // 0-1 percussive onset
uniform float uBrightness;  // 0-1 spectral centroid
uniform float uFlux;        // 0-1 rate of spectral change
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;        // 1.0 on a beat, decaying before the next
uniform float uSectionHue;  // hue offset, constant within a section
uniform float uSeed;        // per-track, so no two tracks share an arrangement

/**
 * Lava-lamp field.
 *
 * The previous version layered fractal noise, expanding shells and per-frame
 * hue jitter, all driven at high frequency - the result read as shaking rather
 * than moving, and was genuinely unpleasant to look at.
 *
 * This is built instead from sixty soft metaballs drifting along slow
 * incommensurate orbits. Nothing in the image changes faster than the eye wants
 * to track: the audio scales sizes and colour, it never jerks positions. Beat
 * response is a gentle swell in radius, not a flash.
 */

/**
 * A blob's contribution, zero beyond its own neighbourhood.
 *
 * This was radius / (d * d + 0.05) - an inverse square with a floor and no
 * cutoff, so every blob contributed something at every pixel in the frame. With
 * sixteen of them the tails alone summed past the iso threshold everywhere, and
 * the whole screen resolved to a single connected mass. Measured on the shipped
 * constants: at the threshold in use, 81.5% of the frame was wax and it was
 * *one* body; raising the threshold went straight from one giant mass (43% of
 * frame at 3.6) to nothing at all (0% at 10). No threshold could have fixed it,
 * because the problem was never where the surface sat - it was that a blob had
 * no locality to have a surface around.
 *
 * The Wyvill polynomial is the standard metaball kernel and is exactly zero at
 * and beyond "reach", so a blob influences only its own neighbourhood and two
 * blobs merge when they genuinely touch. Returns 0..1 rather than an unbounded
 * magnitude, which is what lets the iso value below be a plain fraction.
 *
 * The squash factor stretches it along one axis and twist rotates it, so the
 * cast are ellipses at varying angles rather than identical circles.
 */
float blob(vec2 uv, vec2 centre, float radius, float squash, float twist) {
  vec2 p = uv - centre;
  float c = cos(twist);
  float s = sin(twist);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  p.x *= squash;
  p.y /= squash;

  // Reach and blob count are one decision. Both fill the frame and both merge
  // it, and past a point more blobs give *fewer* visible bodies rather than
  // more: measured over five points in a track at reach 1.70, a quiet passage
  // shows 7.6 separate bodies with 36 blobs, 7.0 with 48 and 6.0 with 60, while
  // coverage climbs 16.3% -> 20.1% -> 26.3%. Sixty at 1.70 is the most colour
  // on screen that still resolves into distinct wax rather than a single sheet.
  float reach = radius * 1.70;
  float q2 = dot(p, p) / (reach * reach);
  if (q2 >= 1.0) return 0.0;
  float k = 1.0 - q2;
  return k * k * k;
}

vec3 palette(float t, float hue) {
  // Cosine palette: three phase-shifted cosines give smooth, always-in-gamut
  // ramps without any branching or texture lookups.
  vec3 phase = vec3(0.0, 0.33, 0.67) + hue;
  return 0.5 + 0.5 * cos(6.28318 * (t + phase));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);

  // One slow clock for everything. Slower again than before: the brief was
  // liquid rather than gas, and viscosity is mostly a matter of rate.
  // Slower again. A lava lamp's convection cycle is on the order of a minute,
  // and the previous rate still read as weather rather than as fluid.
  // Already integrated on the JavaScript side, and already score-locked. See
  // the note where uTime is set: computing the rate here, as a multiplier on
  // elapsed time, meant every change in flux teleported the whole cast.
  float t = uTime;

  // Bass swells every blob together; the beat adds a small extra lift. Both are
  // already smoothed on the JavaScript side before arriving here.
  // Larger blobs, so a handful of big masses drift and merge rather than a
  // scatter of small ones milling about.
  // Roughly half the previous size.
  //
  // At the old scale a dozen blobs of this radius overlapped into one
  // connected mass: measured, only 14% of the frame was wax, but all of it
  // was a single body spanning half the screen. A lamp reads as a lamp
  // because there are *many* separate bodies, so the radius has to be small
  // enough that neighbours stay apart at their usual spacing.
  // A high floor and shallow modulation, so the lamp is full at any volume.
  //
  // This was 0.052 with bass at 0.050 and energy at 0.022, and the radius below
  // swelled by up to 150% again on sustain. Measured across a quiet, a middling
  // and a loud passage, coverage ran 9.8% -> 29.3% -> 65.4%, and at the loud end
  // it was a single merged body. A frame that inflates almost sevenfold and then
  // collapses is not calm, and it is empty half the time by construction.
  //
  // The swing is now roughly 1.7x rather than 6.7x, with the quiet floor more
  // than doubled. The music still moves it; it no longer throws it.
  float swell = 0.120 + uBass * 0.020 + uBeat * 0.005 + uEnergy * 0.012;

  // Sixty blobs, each with its own hue, tracked separately.
  //
  // Sixteen left the frame far too empty, and neither 24 nor 36 filled it.
  // Sixty does, provided the reach comes down with the count - at the reach 36
  // used, sixty blobs merge into one sheet.
  //
  // The previous version summed every contribution into one scalar and coloured
  // the total with a single hue, which is why it read as one mass however many
  // terms were added. Accumulating a colour weighted by each blob's own
  // contribution means a pixel takes the hue of whichever blob dominates it, and
  // the boundaries between blobs become visible colour transitions.
  float field = 0.0;
  vec3 tint = vec3(0.0);
  float tintWeight = 0.0;

  // Accumulated outward direction, used below to fake a surface normal.
  //
  // A lit sphere needs a normal, and the usual routes to one are both
  // expensive here: screen-space derivatives are a WebGL1 extension this cannot
  // rely on, and sampling the field again at offsets would run the whole
  // sixty-blob loop three times over. But each blob already knows which way
  // is "out" - it is simply the direction from its centre to this pixel - so
  // summing that, weighted by how much each blob contributes, gives the
  // outward direction of whichever blob owns the pixel for free.
  vec2 outward = vec2(0.0);

  for (int i = 0; i < 60; i++) {
    // Offset by the track's seed, so the cast is a different set of phases,
    // columns, sizes and hues for every song. Everything below is a function of
    // "fi", so without this every track ran the identical arrangement - which
    // is what made the lamp look scripted rather than alive.
    float fi = float(i) + uSeed * 13.0;

    // The actual thermodynamic cycle, not a circuit.
    //
    // The previous version walked each blob around an ellipse. That is a
    // carousel: the motion is continuous, symmetrical and never rests, and it
    // reads as decoration going round rather than as wax. Before that it was a
    // sine on each axis, which pumped in place.
    //
    // A real lamp runs a four-stage cycle, and the stages are not the same
    // length or the same speed:
    //
    //   1. Wax heated at the base expands, becomes less dense than the fluid
    //      around it and breaks away, accelerating upward as buoyancy wins.
    //   2. It cools on the way up, so it slows as it nears the surface.
    //   3. At the top it is denser than it was, spreads out against the cool
    //      glass and dwells there, flattened.
    //   4. It sinks - slower than it rose, because there is no buoyancy driving
    //      it, only gravity against a viscous fluid - and pools at the base to
    //      reheat.
    //
    // Timing follows from that: the rise is quick and eases out, the descent is
    // slow and symmetric, and there are two genuine rest stages. The asymmetry
    // between rise and fall is most of what the eye recognises.
    float cycle = fract(t * (0.028 + fi * 0.0032) + fi * 0.137);

    float height;
    float neck;
    if (cycle < 0.34) {
      // Rising, decelerating as it cools.
      float r = cycle / 0.34;
      height = mix(-0.80, 0.68, 1.0 - pow(1.0 - r, 1.9));
      // Necked while travelling: a rising blob is drawn out into a teardrop by
      // the drag of the fluid it is climbing through.
      neck = 1.0 + 0.42 * sin(r * 3.14159);
    } else if (cycle < 0.46) {
      // Spread against the cool top, flattened and nearly still.
      float r = (cycle - 0.34) / 0.12;
      height = 0.68 + 0.03 * sin(r * 3.14159);
      neck = 1.0 - 0.40 * sin(r * 3.14159);
    } else if (cycle < 0.88) {
      // Sinking. Longer than the rise and eased at both ends, because gravity
      // through a viscous fluid never produces the sharp departure that
      // buoyancy does.
      float r = (cycle - 0.46) / 0.42;
      height = mix(0.68, -0.80, r * r * (3.0 - 2.0 * r));
      neck = 1.0 + 0.26 * sin(r * 3.14159);
    } else {
      // Pooled at the base, reheating and swelling before it breaks away again.
      float r = (cycle - 0.88) / 0.12;
      height = -0.80;
      neck = 1.0 - 0.46 * sin(r * 3.14159);
    }

    // Rising and sinking happen in different columns, which is what stops a
    // blob retracing its own path and is why a real lamp always has wax moving
    // both ways at once in different places.
    float riseColumn = (fract(fi * 0.618) - 0.5) * 1.05;
    float sinkColumn = (fract(fi * 0.379 + 0.31) - 0.5) * 1.05;
    float descending = smoothstep(0.34, 0.46, cycle) - smoothstep(0.88, 1.0, cycle);

    vec2 centre = vec2(
      mix(riseColumn, sinkColumn, descending) + 0.09 * sin(t * 0.31 + fi * 2.1),
      height
    );

    // Nothing pushes a blob bodily on a beat.
    //
    // A kick used to shift each centre by up to 0.17 vertically and the punch
    // to shove it sideways, on the reasoning that an impact should read as an
    // impact. At two beats a second that is a twitch twice a second, and it is
    // the wrong physics for the subject: wax in a lamp has enormous inertia and
    // is the one thing on screen that visibly *cannot* be moved quickly. The
    // music now reaches the lamp through size, brightness and colour, which can
    // change smoothly, and the path stays a deliberate rise, spread, sink and
    // pool.

    // A held note - loud and sustained, so energy is high while flux is low -
    // swells a subset of blobs dramatically. Flux measures how fast the spectrum
    // is changing, so low flux with high energy is precisely a singer holding a
    // note, and that is the moment worth reacting to.
    float sustain = uEnergy * (1.0 - smoothstep(0.10, 0.45, uFlux));
    float sustainShare = 0.5 + 0.5 * sin(fi * 1.9);

    float radius = swell
      * (0.70 + 0.40 * sin(fi * 1.7 + t * 0.5) + uMid * 0.08)
      // Sustain was 1.5: a single blob could swell by 150% and swallow its
      // neighbours, which is most of what made the frame lurch between empty
      // and one merged mass. At 0.22 a held note still opens the wax out, but
      // gently, and the bodies stay bodies.
      * (1.0 + sustain * sustainShare * 0.22);

    // Shape follows the cycle rather than a free-running sine, so a blob is
    // drawn out while it climbs and flattened while it rests.
    float squash = neck * (1.0 + 0.10 * sin(fi * 2.1));

    // Barely rotated. Wax does not spin: it is a dense fluid falling through a
    // lighter one, so its long axis stays close to vertical the whole way. The
    // previous constant rotation - a full turn every few seconds - was most of
    // what made these read as drifting ellipses rather than as something
    // molten, because nothing in a real lamp ever rotates like that.
    float twist = 0.10 * sin(t * 0.13 + fi);

    float contribution = blob(uv, centre, radius, squash, twist);
    field += contribution;

    // Hues spread around the wheel by golden-ratio spacing, which distributes
    // twelve values as evenly as possible without any two landing close.
    float hue = fract(uSectionHue + fi * 0.618034 + uTime * 0.39);
    // Cubed, not squared.
    //
    // Squaring still let a pixel midway between two blobs take a near-even
    // blend of both hues, so every boundary became a colour ramp and the frame
    // read as one smeared rainbow rather than as separate coloured bodies. In
    // the reference images each blob is essentially one hue with a gradient
    // across it, and the joins are where two colours *meet*, not where they
    // average. Cubing makes the nearest blob win decisively while still
    // resolving smoothly enough not to alias along the seam.
    float weight = contribution * contribution * contribution;
    tint += palette(0.55 + 0.25 * sin(fi), hue) * weight;
    tintWeight += weight;

    // Direction from this blob's centre, weighted the same way, so the sum is
    // dominated by whichever blob owns the pixel.
    vec2 away = uv - centre;
    float distance = length(away);
    if (distance > 0.0001) outward += (away / distance) * weight;
  }

  tint /= max(tintWeight, 0.0001);

  // Surface tension: rounding the field toward discrete levels near the
  // threshold makes edges behave like a meniscus - liquid separating and
  // merging - instead of a uniform haze.
  // A metaball iso-surface, not a saturating curve.
  //
  // This was a saturating exponential, which has no surface in it at all: it
  // rises smoothly and flattens out, so with twelve overlapping contributors the
  // field sits far past the knee across nearly the whole frame and every pixel
  // resolves to almost the same value. The result was a soft wash of colour with
  // no boundaries anywhere - the blobs were moving correctly underneath and none
  // of it was visible, because nothing distinguished wax from fluid.
  //
  // A threshold is what a metaball surface actually needs. Below it there is no
  // wax, above it there is, and the narrow band between the two is the meniscus.
  // Separate blobs become separately visible the moment the surface exists, and
  // two that approach each other now merge at a boundary that travels, which is
  // the behaviour the whole piece is built on.
  //
  // The two numbers come from the field's actual distribution rather than from
  // taste. Sampling the accumulation across the frame over forty seconds gives
  // p10=2.2, p25=3.1, p50=6.1, p75=13.7, p90=21.0 - so the field is enormous
  // near a blob and falls away steeply, and where the threshold sits decides
  // what fraction of the picture is wax:
  //
  // The threshold has to move with the blob radius, because a smaller blob
  // produces a smaller field. Swept together against the halved radius and a
  // cast of sixteen:
  //
  //   4.0-9.0   ->   1% wax   (blobs vanish entirely)
  //   2.0-4.5   ->  22% wax
  //   1.6-3.6   ->  ~30% wax  (chosen)
  //
  // A lamp is mostly fluid with many distinct bodies in it, so around a third
  // wax is the balance worth having. Raise both numbers together to shrink
  // every blob; widen the gap between them to soften the edges.
  // With a compact kernel the field is a sum of 0..1 contributions from only
  // the blobs actually near this pixel, so the iso value is a plain fraction
  // and 0.5 is the classical metaball surface. Swept at reach x2.6 over five
  // points in a track:
  //
  //   0.35  ->  19.7% wax, 4.6 bodies
  //   0.45  ->  16.2% wax, 5.2 bodies   (band centred here)
  //   0.55  ->  13.3% wax, 5.4 bodies
  //   0.70  ->   9.2% wax, 5.6 bodies
  //
  // The band is the meniscus: narrow it to harden the edges, widen it to soften
  // them. Raise both numbers together to shrink every body.
  float shade = smoothstep(0.32, 0.62, field);

  // Stronger surface tension: sharper boundaries make the mass read as a
  // separate fluid rather than as a gradient, which is the whole character of a
  // lava lamp.
  float tension = smoothstep(0.26, 0.58, shade);
  shade = mix(shade, floor(shade * 5.0 + 0.5) / 5.0, tension * 0.55);

  // Each blob brings its own colour, so the frame carries a dozen hues at once
  // rather than one sweeping wash. Brightness lifts the whole image toward its
  // lighter range, which is how a bright passage reads without changing hue.
  // Brightness lifts the wax itself rather than the whole frame. It used to be
  // added flat, which meant a bright passage raised the background too.
  vec3 colour = tint * (0.40 + shade * 0.90 + uBrightness * 0.12);

  // Treble adds a faint sheen at the blob edges - visible on hi-hats without
  // touching the overall composition.
  float edge = smoothstep(0.35, 0.75, shade) * (1.0 - smoothstep(0.75, 0.98, shade));
  colour += edge * uTreble * 0.16;

  // Specular highlight, which is what makes a blob read as a rounded body with
  // a wet surface rather than as a flat region of colour. Every blob in the
  // reference images has one.
  //
  // The normal is reconstructed rather than computed: the accumulated outward
  // vector gives the direction across the surface, and how far out we are is
  // read from the shade -
  // high at the core where the surface faces the viewer, low at the rim where
  // it turns away. Those two give a plausible hemisphere without ever knowing
  // the real geometry, which is the point, because there is no real geometry.
  float rim = 1.0 - clamp(shade, 0.0, 1.0);
  vec2 across = length(outward) > 0.0001 ? normalize(outward) : vec2(0.0);
  vec3 normal = normalize(vec3(across * rim, sqrt(max(0.04, 1.0 - rim * rim))));

  // Lit from above and slightly to the left, matching where the highlight sits
  // in the references. Tight exponent so it stays a small bright spot instead
  // of a broad sheen across half the body.
  vec3 lightDir = normalize(vec3(-0.42, 0.66, 0.62));
  float specular = pow(max(dot(normal, lightDir), 0.0), 24.0);
  // Gated on shade so it only ever appears on wax, never in the fluid.
  colour += specular * shade * (0.55 + uEnergy * 0.35);

  // The fluid the wax sits in is genuinely dark, so the field falls to black
  // rather than to a dim wash of the palette.
  //
  // Four separate terms used to survive into the background: the tint kept 55%
  // of its value at zero shade, a flat brightness term was added everywhere,
  // this darkening bottomed out at 0.20 instead of 0, and the punch lift below
  // was added after it. Together they lit the entire frame, so the blobs had
  // nothing to be distinct against - which is most of the difference between
  // the reference images and what this was producing.
  //
  // Multiplying by shade rather than adding a floor takes the fluid to true
  // black while the second factor keeps the meniscus bright enough to read as
  // a surface rather than a hard cut.
  colour *= shade * (0.25 + shade * 0.85);

  // Scaled by shade as well. Added flat, this reached the background too.
  colour += uPunch * 0.06 * shade;

  // Vignette, gentle enough not to read as a frame.
  colour *= 1.0 - smoothstep(0.55, 1.25, length(uv)) * 0.55;

  gl_FragColor = vec4(colour, 1.0);
}
`;

/** Names of every uniform the fragment shader consumes. */
const UNIFORM_NAMES = [
  'uResolution', 'uTime', 'uEnergy', 'uPunch', 'uBrightness',
  'uFlux', 'uBass', 'uMid', 'uTreble', 'uBeat', 'uSectionHue', 'uSeed',
];

/**
 * Compile a shader and throw with the driver's log if it fails.
 *
 * @param {WebGLRenderingContext} gl
 * @param {number} type gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
 * @param {string} source GLSL source.
 * @returns {WebGLShader}
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${log}`);
  }
  return shader;
}

export class ShaderVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas Target canvas, sized to its container.
   * @throws {Error} If WebGL is unavailable or the shaders fail to compile.
   */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,      // the field is noise; MSAA buys nothing here
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL is not available in this client.');
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);
    this.program = program;

    // One full-screen triangle pair. No geometry changes, so this is uploaded
    // once and never touched again.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {};
    for (const name of UNIFORM_NAMES) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    /** Smoothed lane values, to stop per-frame jitter reading as flicker. */
    this.smoothed = {
      energy: 0, punch: 0, brightness: 0, flux: 0, bass: 0, mid: 0, treble: 0,
    };
    this.sectionHue = 0;
    /** Per-track arrangement seed; see {@link setTrack}. */
    this.seed = 0;
    this.lastSectionIndex = -1;
    this.needsMeasure = true;
  }

  /**
   * Mark the drawing buffer as needing re-measurement; see
   * `Canvas2DVisual.resize` for why the measurement itself is deferred.
   */
  resize() {
    this.needsMeasure = true;
  }

  /**
   * A new track means a new arrangement of the lamp.
   *
   * Every blob's phase, column, size and hue derives from its index, so without
   * a seed every track ran the identical arrangement - the same bodies doing
   * the same things in the same places, which is what made it read as scripted.
   *
   * Hashed from the track's identity rather than `Math.random`, because this is
   * a room where several people watch one track together: a random seed would
   * give every viewer a different lamp, and it would also change on a reload
   * mid-song. Same track, same lamp, for everyone, always.
   *
   * @param {object|null} track
   */
  setTrack(track) {
    const key = `${track?.provider ?? ''}:${track?.providerId ?? ''}`;
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    this.seed = (hash >>> 0) / 4294967296;
  }

  /** Match the drawing buffer to the display size. */
  measure() {
    this.needsMeasure = false;
    // Cap at 2x: the field is noise-based and fill-rate bound, so rendering at
    // 3x on a high-DPI display costs a lot and shows almost nothing.
    // Capped harder on small screens.
    //
    // A phone reporting a ratio of 3 would render a 1170-wide viewport at 3510
    // pixels across - more work than a desktop at full size, on a fraction of
    // the hardware, which is most of why the Activity struggled on mobile. The
    // difference between 1.5x and 3x is not visible at arm's length.
    const small = Math.min(window.innerWidth ?? 1920, window.innerHeight ?? 1080) < 700;
    const ratio = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
    const width = Math.floor(this.canvas.clientWidth * ratio);
    const height = Math.floor(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
  }

  /**
   * Draw one frame.
   *
   * @param {object} score A VisualScore.
   * @param {number} playbackSec Current playback position in seconds.
   * @param {number} elapsedSec Seconds since page load, for idle motion.
   */
  render(score, playbackSec, elapsedSec) {
    const gl = this.gl;
    if (this.needsMeasure) this.measure();

    const lanes = score.lanes;
    // Lanes and sections read from score-space (looped for partial scores);
    // the beat grid reads from real playback time so it never jumps phase.
    const scoreSec = resolveScoreTime(score, playbackSec);
    const frame = Math.max(0, Math.min(
      Math.floor(scoreSec * lanes.fps), lanes.frame_count - 1,
    ));

    // Exponential smoothing. Punch uses a much weaker filter because its whole
    // job is to feel instantaneous.
    const ease = (previous, next, factor) => previous + (next - previous) * factor;
    // Heavier smoothing than the first version. Lane data is per-frame and
    // genuinely spiky; feeding it straight to the shader produced flicker rather
    // than motion. Bass and energy are slowest because they set the composition;
    // treble is fastest because it only tints an edge.
    this.smoothed.energy = ease(this.smoothed.energy, lanes.energy[frame], 0.045);
    this.smoothed.punch = ease(this.smoothed.punch, lanes.punch[frame], 0.14);
    this.smoothed.brightness = ease(this.smoothed.brightness, lanes.brightness[frame], 0.055);
    this.smoothed.flux = ease(this.smoothed.flux, lanes.flux[frame], 0.050);
    this.smoothed.bass = ease(this.smoothed.bass, lanes.bass[frame], 0.060);
    this.smoothed.mid = ease(this.smoothed.mid, lanes.mid[frame], 0.055);
    this.smoothed.treble = ease(this.smoothed.treble, lanes.treble[frame], 0.11);

    // A section change rotates the hue by an irrational-ish step so successive
    // sections stay distinguishable instead of cycling back to earlier colours.
    const section = score.sections.find(
      (s) => scoreSec >= s.start_sec && scoreSec < s.end_sec,
    );
    if (section && section.index !== this.lastSectionIndex) {
      this.lastSectionIndex = section.index;
      // Sections jump a large fraction of the wheel, so a new section reads as a
      // deliberate change of scene on top of the continuous drift.
      this.sectionHue = (section.index * 0.41 + section.brightness_mean * 0.25) % 1;
    }

    // The lamp's clock: integrated, and taken from the music.
    //
    // The shader used to compute its own time as `uTime * (0.026 + uFlux *
    // 0.020)`, with `uTime` being seconds since page load. Two faults in one
    // line. The rate *multiplied* elapsed time, so any change in flux instantly
    // rescaled the entire timeline and every blob jumped to a new point in its
    // cycle - which is most of what read as jitter, and as the motion being
    // random rather than deliberate. And it was wall time, so the lamp kept
    // moving while playback was paused, ignored a seek, and sat at a different
    // point for every person in the channel.
    //
    // Integrating the rate instead means changing it bends the motion from here
    // on rather than teleporting it, and taking the delta from the score means
    // everyone's lamp agrees. Clamped like every other delta in the project: a
    // seek must not advance the cycle by a minute in one frame.
    const lavaDelta = Math.min(Math.max(scoreSec - (this.lastLavaSec ?? scoreSec), 0), 0.1);
    this.lastLavaSec = scoreSec;
    this.lavaPhase = (this.lavaPhase ?? 0)
      + lavaDelta * (0.016 + this.smoothed.flux * 0.012);

    gl.uniform2f(this.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.uTime, this.lavaPhase);
    gl.uniform1f(this.uniforms.uEnergy, this.smoothed.energy);
    gl.uniform1f(this.uniforms.uPunch, this.smoothed.punch);
    gl.uniform1f(this.uniforms.uBrightness, this.smoothed.brightness);
    gl.uniform1f(this.uniforms.uFlux, this.smoothed.flux);
    gl.uniform1f(this.uniforms.uBass, this.smoothed.bass);
    gl.uniform1f(this.uniforms.uMid, this.smoothed.mid);
    gl.uniform1f(this.uniforms.uTreble, this.smoothed.treble);
    // The raw pulse is a sawtooth; easing it turns a flash into a swell.
    this.smoothedBeat = ease(this.smoothedBeat ?? 0, beatPulse(score, playbackSec), 0.16);
    gl.uniform1f(this.uniforms.uBeat, this.smoothedBeat);
    gl.uniform1f(this.uniforms.uSectionHue, this.sectionHue);
    gl.uniform1f(this.uniforms.uSeed, this.seed ?? 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

/**
 * Map playback position into the analysed window.
 *
 * A preview-based score only covers ~30 seconds, while playback runs the full
 * track. Without this the lane index clamps to the final frame and every
 * visual freezes the moment the preview data runs out. Looping reuses the
 * excerpt, which works because a preview is taken from the middle of a track
 * and is broadly representative of it.
 *
 * The seam every ~30s is a single-frame step in the lane values, which the
 * visualiser's exponential smoothing absorbs.
 *
 * @param {object} score A VisualScore.
 * @param {number} playbackSec Current playback position in seconds.
 * @returns {number} Position in score-space, always inside the analysed window.
 */
export function resolveScoreTime(score, playbackSec) {
  const analysed = score.analysis.analysed_duration_sec;
  if (!score.analysis.is_partial || playbackSec < analysed || analysed <= 0) {
    return playbackSec;
  }
  return playbackSec % analysed;
}

/**
 * Decaying pulse that peaks at each beat.
 *
 * Gated on `tempo_confidence`: when beat tracking was unreliable, returning 0
 * suppresses beat-driven motion entirely rather than pulsing at the wrong
 * times, and the continuous lanes carry the visual on their own.
 *
 * Past the analysed window of a partial score the beat list is exhausted, so
 * the grid is extrapolated from the measured tempo instead of looping with the
 * lanes. Looping would restart the bar every ~30s, and a phase jump reads as a
 * mistake in a way that a continuous grid never does.
 *
 * @param {object} score A VisualScore.
 * @param {number} playbackSec Real playback position in seconds.
 * @returns {number} Pulse strength in 0-1.
 */
export function beatPulse(score, playbackSec) {
  const { beats, tempo_confidence: confidence, tempo_bpm: bpm } = score.timing;
  if (confidence < 0.5 || beats.length === 0) return 0;

  const decay = 0.18;  // seconds; short enough to read as a hit, not a swell
  const analysed = score.analysis.analysed_duration_sec;

  if (score.analysis.is_partial && playbackSec >= analysed && bpm > 0) {
    // Extrapolate the grid forward from the first measured beat.
    const interval = 60 / bpm;
    const since = (playbackSec - beats[0]) % interval;
    return Math.max(0, 1 - since / decay);
  }

  // Binary search for the latest beat at or before now. Beat lists run to a
  // few hundred entries, so a linear scan every frame would be wasteful.
  let low = 0;
  let high = beats.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (beats[mid] <= playbackSec) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (index < 0) return 0;

  return Math.max(0, 1 - (playbackSec - beats[index]) / decay);
}
