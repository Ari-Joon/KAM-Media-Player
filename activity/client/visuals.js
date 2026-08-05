/**
 * Visualisation set, in the spirit of the classic Windows Media Player pack.
 *
 * Every visualisation implements the same three-method interface -
 * `resize()`, `render(score, playbackSec, elapsedSec)` and a constructor taking
 * a canvas - so the registry can swap between them without any of them knowing
 * the others exist.
 *
 * ## Per-viewer choice
 *
 * Which visualisation is showing is purely client state. It is never sent to the
 * server and never appears in a snapshot, so two people in the same voice
 * channel can watch completely different visuals of the same track. Only
 * playback - position, queue, transport - is shared, because only playback
 * genuinely needs to agree.
 *
 * ## Where the data comes from
 *
 * All of them read the same score. The 16-band `spectrum` lane is what makes
 * analyser-style displays possible: interpolating three coarse bands cannot
 * produce a believable EQ curve, and looked obviously fake.
 */

/** Section palettes, shared so switching visualisation keeps the mood. */
const PALETTES = [
  ['#ff1f6b', '#ffb02b'],
  ['#12d0ff', '#0b3cff'],
  ['#b6ff20', '#00b567'],
  ['#ffd21a', '#ff4d00'],
  ['#c14dff', '#3c14ff'],
  ['#ff4040', '#ab0f52'],
];

/** Parse `#rrggbb` into components. */
export function rgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Increase a colour's saturation without changing its hue or lightness.
 *
 * Pushes each channel away from the colour's own mean, which is equivalent to a
 * saturation boost in HSL but avoids two conversions per call - and this runs
 * for every stroke of every frame.
 *
 * @param {string} hex
 * @param {number} amount 0 leaves it alone; 0.2 is a fifth more saturated.
 * @returns {string} `#rrggbb`
 */
export function saturate(hex, amount) {
  const [r, g, b] = rgb(hex);
  const mean = (r + g + b) / 3;
  const push = (channel) => Math.round(
    Math.min(255, Math.max(0, mean + (channel - mean) * (1 + amount))),
  );
  return `#${[push(r), push(g), push(b)]
    .map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Blend two hex colours, returning hex.
 *
 * `mix` returns an `rgb()` string, which is what canvas wants but cannot be fed
 * back into another blend. The palette is blended and then saturated, so it
 * needs a form that composes.
 *
 * @param {string} fromHex
 * @param {string} toHex
 * @param {number} t
 * @returns {string} `#rrggbb`
 */
function mixHexPair(fromHex, toHex, t) {
  const a = rgb(fromHex);
  const b = rgb(toHex);
  const k = Math.min(1, Math.max(0, t));
  return `#${a.map((channel, i) => Math.round(channel + (b[i] - channel) * k)
    .toString(16).padStart(2, '0')).join('')}`;
}

/**
 * How long the palette takes to travel from one scheme to the next.
 *
 * Colour previously changed only at section boundaries - every twenty or thirty
 * seconds - so a long verse held one scheme throughout and the visuals felt
 * static however much the shapes moved. Cycling continuously means the colour is
 * always going somewhere, and a section change becomes a jump on top of that
 * rather than the only source of variety.
 */
const PALETTE_CYCLE_SEC = 9;

/** Blend two hex colours. @returns {string} An `rgb()` string. */
export function mix(fromHex, toHex, t) {
  const a = rgb(fromHex);
  const b = rgb(toHex);
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},`
    + `${Math.round(a[1] + (b[1] - a[1]) * k)},`
    + `${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

/**
 * Reads and smooths score lanes, so no visualisation repeats that work.
 *
 * Smoothing is not optional decoration: lane data is per-frame and genuinely
 * spiky, and feeding it straight to a renderer produces flicker rather than
 * motion. Each lane has its own time constant chosen by what it drives -
 * composition-level values are slow, accents are fast.
 */
export class LaneReader {
  constructor() {
    this.energy = 0;
    this.punch = 0;
    this.brightness = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.flux = 0;
    this.beat = 0;
    /** Smoothed per-band levels. */
    this.spectrum = [];
    /** Slowly-decaying peaks, for analyser peak caps. */
    this.peaks = [];
    this.sectionIndex = -1;
    this.palette = PALETTES[0];
    this.paletteBase = 0;
    /**
     * This section's lyric mood, or null when the track has no transcription.
     *
     * Most tracks will not have one - the pass is optional and can fail - so
     * every consumer must treat this as absent by default rather than assuming
     * a zeroed object.
     */
    this.mood = null;
    /** How much louder this section is than the one before it. */
    this.sectionLift = 0;
    this.sectionStartSec = 0;
    /** 0..1, how far into a drop we are. See the note in `sample`. */
    this.drop = 0;
  }

  /**
   * Sample the score at a playback position.
   *
   * @param {object} score A VisualScore.
   * @param {number} playbackSec
   * @param {number} deltaSec Time since the previous frame, for peak decay.
   */
  sample(score, playbackSec, deltaSec) {
    const lanes = score.lanes;
    const analysed = score.analysis.analysed_duration_sec;
    const scoreSec = score.analysis.is_partial && playbackSec >= analysed && analysed > 0
      ? playbackSec % analysed
      : playbackSec;
    const frame = Math.max(0, Math.min(
      Math.floor(scoreSec * lanes.fps), lanes.frame_count - 1,
    ));
    this.frame = frame;
    this.scoreSec = scoreSec;

    // Continuous palette travel, evaluated every frame.
    //
    // Two palettes are blended by a phase that advances with playback, so the
    // scheme is always moving between neighbouring schemes rather than holding
    // one. Driven by score position rather than wall time, so it stays identical
    // for everyone watching and survives a seek.
    // The section's offset is eased rather than applied directly.
    //
    // Shifting it by a whole integer the instant a section changes moves the
    // cycle a full palette in one frame, which shows as a hard colour flicker -
    // measured at 475 points of RGB change in a single frame. Approaching the
    // new offset over about a second turns that into a deliberate transition.
    const targetOffset = this.paletteBase ?? 0;
    if (this.paletteOffset === undefined) this.paletteOffset = targetOffset;
    // Take the shorter way round the ring, so moving from the last palette back
    // to the first does not travel backwards through all of them.
    let gap = targetOffset - this.paletteOffset;
    if (gap > PALETTES.length / 2) gap -= PALETTES.length;
    if (gap < -PALETTES.length / 2) gap += PALETTES.length;
    this.paletteOffset += gap * (1 - Math.exp(-1.2 * deltaSec));

    const cycle = (scoreSec / PALETTE_CYCLE_SEC) + this.paletteOffset;
    const step = Math.floor(cycle);
    // Smoothstep, so each palette holds briefly before moving on instead of
    // sliding continuously and never quite being any of them.
    const raw = cycle - step;
    const blend = raw * raw * (3 - 2 * raw);

    const current = PALETTES[step % PALETTES.length];
    const next = PALETTES[(step + 1) % PALETTES.length];

    // Blended, then saturated. Mixing two colours always moves the result
    // toward grey, so without the boost the travelling palette would be duller
    // than either end of it.
    this.palette = [
      saturate(mixHexPair(current[0], next[0], blend), 0.22),
      saturate(mixHexPair(current[1], next[1], blend), 0.22),
    ];

    // Asymmetric, for the same reason the spectrum bands below are: a hit
    // should be met at once and released gently.
    //
    // These were eased symmetrically, which is a low-pass filter in both
    // directions - and a transient a few frames long only ever moved the output
    // a fraction of the way toward it. Measured across twenty cached tracks,
    // comparing the raw lane against what the renderers actually received:
    //
    //   lane    raw p99   smoothed p99   peak kept   time above 0.8
    //   punch      0.92           0.50         55%   2.3% -> 0.0%
    //   flux       0.92           0.37         40%   2.4% -> 0.0%
    //   bass       0.98           0.70         71%   6.4% -> 0.1%
    //   energy     0.99           0.81         82%  11.3% -> 1.6%
    //
    // Punch is the hit signal and it never once reached the top of its range.
    // Anything scaling an effect by it was running at half amplitude and never
    // peaking, which is what made so much of the set feel flat.
    //
    // Rising four times faster restores the peaks (punch 99% kept, energy 90%,
    // treble 97%) while leaving the release exactly as it was, so nothing gains
    // flicker - the fall is what stops a transient reading as a strobe.
    const ease = (previous, next, factor) => {
      const rate = next > previous ? Math.min(1, factor * 4) : factor;
      return previous + (next - previous) * rate;
    };
    this.energy = ease(this.energy, lanes.energy[frame], 0.07);
    this.punch = ease(this.punch, lanes.punch[frame], 0.22);
    this.brightness = ease(this.brightness, lanes.brightness[frame], 0.04);
    this.bass = ease(this.bass, lanes.bass[frame], 0.10);
    this.mid = ease(this.mid, lanes.mid[frame], 0.09);
    this.treble = ease(this.treble, lanes.treble[frame], 0.16);
    this.flux = ease(this.flux, lanes.flux[frame], 0.07);

    // Per-band smoothing, with asymmetric attack and release: bars should jump
    // to a transient and fall back gently, which is how hardware analysers
    // behave and why they read as responsive rather than twitchy.
    const bands = lanes.spectrum ?? [];
    if (this.spectrum.length !== bands.length) {
      this.spectrum = new Array(bands.length).fill(0);
      this.peaks = new Array(bands.length).fill(0);
    }
    // Spectrum with a floor, so a band that is genuinely silent still has a
    // small presence rather than vanishing. Bars, spikes and rings built on raw
    // levels disappeared entirely during quiet intros.
    for (let i = 0; i < bands.length; i++) {
      const raw = bands[i][frame] ?? 0;
      // The floor rises slightly for the lower bands, which carry most tracks.
      const target = Math.max(raw, 0.06 + (1 - i / bands.length) * 0.05);
      this.spectrum[i] = target > this.spectrum[i]
        ? ease(this.spectrum[i], target, 0.55)
        : ease(this.spectrum[i], target, 0.11);
      this.peaks[i] = Math.max(this.spectrum[i], this.peaks[i] - deltaSec * 0.55);
    }

    // Derived lanes, so every visualisation has the same inputs available
    // regardless of what the track actually provides.
    //
    // A purely instrumental piece has no lyrics; a quiet one barely moves the
    // spectrum; a partial score has fewer sections. Renderers written against
    // those inputs went inert on exactly the tracks where they should have been
    // most interesting. Filling the gaps here means it is solved once rather
    // than in twenty-one places, and every mode behaves the same way.
    const lyrics = score.lyrics ?? null;
    const sectionForMood = score.sections.findIndex(
      (s) => scoreSec >= s.start_sec && scoreSec < s.end_sec,
    );
    const mood = lyrics?.sections?.[sectionForMood] ?? null;

    // Mood, or a stand-in derived from the audio. Brightness maps well to
    // valence - major, open-sounding music is spectrally brighter - and flux to
    // arousal, since agitation is the spectrum changing quickly.
    this.valence = mood ? mood.valence : (this.brightness - 0.45) * 1.6;
    this.arousal = mood ? mood.arousal : Math.min(1, this.flux * 1.5);
    this.theme = mood?.theme ?? null;
    this.hasLyrics = Boolean(mood);

    // A guaranteed-moving value for renderers that would otherwise stall on a
    // sparse track. Never zero, always advancing, and tied to the beat so it
    // stays musical even when every lane is quiet.
    this.pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.beatCount * Math.PI));

    // Overall level, with a floor. Several modes scale their whole output by
    // energy, which on a quiet passage collapses them to nothing.
    this.drive = 0.28 + this.energy * 0.72;

    const section = score.sections.find(
      (s) => scoreSec >= s.start_sec && scoreSec < s.end_sec,
    );
    if (section && section.index !== this.sectionIndex) {
      this.sectionIndex = section.index;
      this.paletteBase = section.index % PALETTES.length;
      // How much louder this section is than the one before it.
      //
      // Read from the section table rather than detected by watching a lane
      // rise: a drop is a structural event, and taking it from the structure
      // means it is identical for every viewer, lands at exactly the same
      // moment for all of them, and is still correct after a seek. A detector
      // integrating energy over frames would satisfy none of those.
      const previous = score.sections[section.index - 1];
      this.sectionLift = previous ? section.energy_mean - previous.energy_mean : 0;
      this.sectionStartSec = section.start_sec;
    }

    // Lyric mood for this section, falling back to the whole-track summary so a
    // renderer still gets something during an instrumental passage. Null when
    // there is no transcription at all, which is the common case.
    this.mood = score.lyrics?.sections?.[this.sectionIndex]
      ?? score.lyrics?.overall
      ?? null;

    // The drop: the opening seconds of a section that arrives markedly louder
    // than the one before it, decaying over four seconds. An event rather than
    // a state - a section that is simply loud throughout is not a drop, and
    // treating it as one would leave the effect stuck on for a whole chorus.
    const intoSection = Math.max(0, scoreSec - this.sectionStartSec);
    this.drop = this.sectionLift > 0.12
      ? Math.max(0, 1 - intoSection / 4) * Math.min(1, this.sectionLift / 0.3)
      : 0;

    // Beat phase from the measured tempo, so it stays continuous past the end of
    // a partial score's beat list.
    const { tempo_bpm: bpm, beats, tempo_confidence: confidence, meter } = score.timing;
    const interval = 60 / (bpm > 0 ? bpm : 120);
    const origin = beats.length ? beats[0] : 0;
    const beatCount = Math.max(0, playbackSec - origin) / interval;
    this.beatCount = beatCount;
    this.beatPhase = beatCount % 1;
    this.barPhase = (beatCount % meter) / meter;
    const pulse = confidence < 0.5 ? 0 : Math.pow(1 - this.beatPhase, 2.4);
    this.beat = ease(this.beat, pulse, 0.20);
  }
}

/** Shared canvas sizing and per-frame timing. */
export class Canvas2DVisual {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('2D canvas is unavailable.');
    this.lanes = new LaneReader();
    this.lastFrameMs = performance.now();
    this.ratio = 1;
    this.needsMeasure = true;
  }

  /**
   * Mark the canvas as needing re-measurement.
   *
   * Called from outside - `main.js` drives it from a ResizeObserver on both
   * canvases plus visibilitychange and focus. It only sets a flag; the actual
   * measurement happens on the next frame in {@link measure}.
   *
   * Splitting it this way is the point. `resize()` used to measure directly and
   * was called from `begin()` on every frame, so every visualisation performed
   * four layout-forcing reads - `innerWidth`, `devicePixelRatio`, `clientWidth`,
   * `clientHeight` - sixty times a second to discover a size that changes maybe
   * twice in a session.
   */
  resize() {
    this.needsMeasure = true;
  }

  /** Read the element's size and resize the backing store to match. */
  measure() {
    this.needsMeasure = false;
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
    }
    this.ratio = ratio;
  }

  /** Sample lanes and return the drawing context plus dimensions. */
  begin(score, playbackSec) {
    if (this.needsMeasure) this.measure();

    // Start every frame from a known context state.
    //
    // All twenty-odd visualisations share one canvas and one 2D context, so
    // anything left set at the end of a frame is inherited by whatever draws
    // next. That is survivable while every renderer tidies up after itself, and
    // it is not survivable when one throws: Pulse sets
    // `globalCompositeOperation = 'lighter'` near the top of its render and
    // restores it on the last line, so an exception in between left every
    // *other* visualisation compositing additively - which turned the whole set
    // white until the page was reloaded, and made a fault in one renderer look
    // like a fault in all of them.
    //
    // Resetting here rather than in a `finally` in each renderer means a
    // visualisation cannot poison its neighbours however it fails.
    const context = this.context;
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.filter = 'none';
    context.shadowBlur = 0;
    context.shadowColor = 'rgba(0,0,0,0)';
    context.setTransform(1, 0, 0, 1, 0, 0);

    const now = performance.now();
    // Clamped at both ends. The upper bound stops a long stall integrating in
    // one huge step; the lower bound stops a *negative* delta, which can happen
    // when a tab is restored or the clock is adjusted, and which makes a spring
    // integrator gain energy instead of losing it - the pose diverges to
    // nonsense within a few frames and never recovers.
    const deltaSec = Math.min(Math.max((now - this.lastFrameMs) / 1000, 0), 0.1);
    this.lastFrameMs = now;
    this.lanes.sample(score, playbackSec, deltaSec);
    return {
      context: this.context,
      width: this.canvas.width,
      height: this.canvas.height,
      deltaSec,
      // Score position, for any motion that needs a clock.
      //
      // Ambient motion - drifts, rotations, blinks - used to read
      // `performance.now()` directly in thirteen places across the two
      // visualisation modules, which breaks the rule `LaneReader.sample` states
      // a few lines above and then relies on: wall-clock motion keeps running
      // while the track is paused, ignores a seek entirely, and is at a
      // different point for every person in the voice channel. In an Activity
      // built around several people watching one track together, that last one
      // is the whole problem.
      //
      // `deltaSec` above remains wall time, and must: it measures how long the
      // last frame took, which is a fact about the browser rather than about the
      // music.
      sec: this.lanes.scoreSec,
    };
  }
}

/**
 * Bars and Waves: a classic spectrum analyser with peak caps and a reflection.
 *
 * The reflection is what made the original read as a polished product rather
 * than a debug readout, and it costs one extra pass with a gradient alpha.
 */
export class BarsVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    context.fillStyle = '#05050a';
    context.fillRect(0, 0, width, height);

    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    const baseline = height * 0.68;
    const maxBar = height * 0.52;
    const slot = width / bands;
    const barWidth = slot * 0.66;

    for (let i = 0; i < bands; i++) {
      const level = lanes.spectrum[i];
      const x = i * slot + (slot - barWidth) / 2;
      const barHeight = Math.max(2, level * maxBar);
      // Colour ramps across the spectrum, so low and high ends are
      // distinguishable at a glance.
      const colour = mix(from, to, i / (bands - 1));

      context.fillStyle = colour;
      context.fillRect(x, baseline - barHeight, barWidth, barHeight);

      // Reflection below the baseline, fading out.
      context.save();
      context.globalAlpha = 0.20;
      const gradient = context.createLinearGradient(0, baseline, 0, baseline + barHeight * 0.7);
      gradient.addColorStop(0, colour);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(x, baseline, barWidth, barHeight * 0.7);
      context.restore();

      // Peak cap: holds the recent maximum and falls slowly.
      const peakY = baseline - Math.max(2, lanes.peaks[i] * maxBar);
      context.fillStyle = '#ffffff';
      context.globalAlpha = 0.75;
      context.fillRect(x, peakY - 3, barWidth, 3);
      context.globalAlpha = 1;
    }

    // Waveform strip above the bars, from the same band data.
    context.strokeStyle = mix(to, '#ffffff', 0.4);
    context.lineWidth = Math.max(1.5, height * 0.003);
    context.beginPath();
    const waveY = height * 0.18;
    for (let x = 0; x <= width; x += 2) {
      const t = x / width;
      let sum = 0;
      for (let i = 0; i < bands; i++) {
        sum += lanes.spectrum[i]
          // 1000/700 preserves the original rate now that the clock is in
          // seconds of score rather than milliseconds of wall time.
          * Math.sin(t * Math.PI * 2 * (i + 1) * 1.7
            + this.lanes.scoreSec * 1.4286 * (1 + i * 0.1));
      }
      const y = waveY + (sum / bands) * height * 0.14;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
}

/**
 * Scope: an oscilloscope trace.
 *
 * The score holds no waveform - storing one would be enormous - so the trace is
 * synthesised as a sum of sinusoids weighted by the band levels. It is not the
 * literal signal, but it moves with the music in the way a scope does, which is
 * the point of the display.
 */
export class ScopeVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    // Slight persistence rather than a hard clear, so the trace leaves a trail
    // like phosphor on a real scope.
    context.fillStyle = 'rgba(5, 5, 10, 0.28)';
    context.fillRect(0, 0, width, height);

    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    const centre = height / 2;
    const amplitude = height * (0.10 + lanes.energy * 0.30);

    // Bass drives how fast the trace travels across the screen, so a heavy track
    // sweeps quickly and a sparse one drifts. This is the horizontal motion that
    // makes a scope feel like it is running rather than oscillating in place.
    //
    // Roughly three times the previous rate. At 0.15 + bass * 1.9 the trace
    // crawled, and a scope that crawls reads as a waveform being redrawn rather
    // than as a signal running past a window - the sense of travel is the whole
    // reason the horizontal motion exists.
    //
    // Advanced on *score* time, not wall time. The accumulator is the right
    // structure - the rate varies with bass, so the phase has to be integrated
    // rather than computed - but it was integrating `deltaSec`, which is how
    // long the last frame took. That kept the trace sweeping while playback was
    // paused and left it unmoved by a seek. Clamped at both ends so a jump in
    // position advances the sweep by at most one ordinary step instead of
    // spinning it, and a backward seek holds rather than running in reverse.
    const scoreSec = this.lanes.scoreSec;
    const scoreDelta = Math.min(Math.max(scoreSec - (this.lastScoreSec ?? scoreSec), 0), 0.1);
    this.lastScoreSec = scoreSec;
    // Rate raised 30% on request: 0.45 and 5.6 became 0.585 and 7.28. Both ends
    // of the range are scaled, so a sparse track drifts 30% faster and a heavy
    // one sweeps 30% faster, rather than only the loud passages speeding up.
    //
    // Travel is right to left, which falls out of the sign: a crest of
    // sin(kt + phase) sits at t = (c - phase) / k, so t decreases as the phase
    // grows. Negating the phase term would send it the other way.
    this.sweep = (this.sweep ?? 0) + scoreDelta * (0.585 + lanes.bass * 7.28);
    const phase = this.sweep;
    void deltaSec;

    for (const pass of [0, 1]) {
      context.beginPath();
      for (let x = 0; x <= width; x += 2) {
        const t = x / width;
        let sum = 0;
        let weight = 0;
        for (let i = 0; i < bands; i++) {
          const level = lanes.spectrum[i];
          // Weighted toward the vocal range. Bands 3-9 of sixteen cover roughly
          // 200Hz to 3kHz, which is where a human voice lives - emphasising them
          // means the trace follows the singer rather than the kick drum, which
          // is the whole point of watching a waveform.
          const vocal = i >= 3 && i <= 9 ? 2.6 : 0.55;
          sum += level * vocal * Math.sin(
            t * Math.PI * 2 * (1 + i * 1.3) + phase * (0.6 + i * 0.12) + pass * 0.8,
          );
          weight += level * vocal;
        }
        const y = centre + (weight > 0 ? sum / weight : 0) * amplitude;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      // Two passes: a wide soft glow under a crisp line.
      context.strokeStyle = pass === 0 ? mix(from, to, 0.5) : '#ffffff';
      context.lineWidth = pass === 0 ? Math.max(6, height * 0.012) : Math.max(1.2, height * 0.002);
      context.globalAlpha = pass === 0 ? 0.35 : 0.95;
      context.stroke();
    }
    context.globalAlpha = 1;
  }
}


/**
 * Tunnel: concentric rings receding toward a vanishing point.
 *
 * Rings are emitted on the beat and travel outward, so the depth of the tunnel
 * is literally the recent rhythmic history - a bar of fast hits looks different
 * from a bar of sparse ones.
 */
export class TunnelVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    /** @type {{radius: number, level: number}[]} */
    this.rings = [];
    this.lastBeat = -1;
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    context.fillStyle = '#04040a';
    context.fillRect(0, 0, width, height);

    // Emit one ring per beat, sized by the energy at that moment.
    const beatIndex = Math.floor(lanes.beatCount);
    if (beatIndex !== this.lastBeat) {
      this.lastBeat = beatIndex;
      this.rings.push({ radius: 0, level: 0.35 + lanes.energy * 0.65 });
      if (this.rings.length > 40) this.rings.shift();
    }

    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.hypot(width, height) / 2;
    const speed = maxRadius * (0.14 + lanes.flux * 0.20);

    for (const ring of this.rings) ring.radius += speed * deltaSec;
    this.rings = this.rings.filter((ring) => ring.radius < maxRadius);

    context.save();
    // Rotate the whole tunnel slowly, which reads as travel rather than pulsing.
    context.translate(cx, cy);
    context.rotate(this.lanes.scoreSec * 0.05);
    context.translate(-cx, -cy);

    for (const ring of this.rings) {
      const t = ring.radius / maxRadius;
      context.strokeStyle = mix(to, from, t);
      context.globalAlpha = (1 - t) * 0.85;
      context.lineWidth = Math.max(1.5, (1 - t) * height * 0.02 * ring.level);
      context.beginPath();
      // Slight polygonal distortion driven by mids, so rings ripple.
      const sides = 48;
      for (let i = 0; i <= sides; i++) {
        const angle = (i / sides) * Math.PI * 2;
        const wobble = 1 + Math.sin(angle * 5 + t * 6) * lanes.mid * 0.10;
        const x = cx + Math.cos(angle) * ring.radius * wobble;
        const y = cy + Math.sin(angle) * ring.radius * wobble;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.restore();
    context.globalAlpha = 1;

    // Bright centre, so the tunnel has a vanishing point to recede toward.
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, maxRadius * 0.22);
    glow.addColorStop(0, `rgba(255,255,255,${0.30 + lanes.beat * 0.35})`);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }
}

/**
 * Musical Colours: bands of colour flowing across the whole frame like ink in
 * water.
 *
 * Rewritten three times, and the reasoning matters. First it scrolled a bitmap
 * and wiped to black, throwing the picture away. Then it swept from random
 * edges, which stopped the wipe but produced a rectangle of stripes. Then it
 * drew a mandala, which was pretty but occupied a disc in the middle of a black
 * screen and read as a chart.
 *
 * This fills the frame. Each frequency band owns a horizontal layer of colour
 * whose vertical position, thickness and opacity come from its level, and every
 * layer is distorted by a slow travelling wave so the boundaries fold into each
 * other rather than sitting in stripes. The result advects like dye dropped into
 * moving water, and the whole canvas is the visualisation.
 */
export class ColoursVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    context.fillStyle = '#05050c';
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'lighter';

    const t = this.lanes.scoreSec;
    // Resolution of the horizontal sampling. Fine enough that the folds are
    // smooth, coarse enough to stay cheap at any window size.
    const steps = 64;
    const stepWidth = width / steps;

    for (let i = 0; i < bands; i++) {
      const level = lanes.spectrum[i];
      if (level < 0.02) continue;

      const centre = height * (0.5 + ((i / (bands - 1)) - 0.5) * 1.15);
      const thickness = height * (0.05 + level * 0.20);
      const colour = mix(from, to, i / (bands - 1));

      // Two travelling waves of different speed per layer: a single sine folds
      // uniformly and still reads as a stripe, while two beating against each
      // other never repeat and produce genuine turbulence.
      const speedA = 0.22 + i * 0.035;
      const speedB = 0.13 + i * 0.021;

      context.beginPath();
      for (let step = 0; step <= steps; step++) {
        const u = step / steps;
        const fold =
          Math.sin(u * 5.1 + t * speedA + i * 0.7) * height * (0.06 + level * 0.10)
          + Math.sin(u * 11.3 - t * speedB + i * 1.9) * height * (0.03 + lanes.energy * 0.05);
        context.lineTo(step * stepWidth, centre + fold - thickness / 2);
      }
      for (let step = steps; step >= 0; step--) {
        const u = step / steps;
        const fold =
          Math.sin(u * 5.1 + t * speedA + i * 0.7) * height * (0.06 + level * 0.10)
          + Math.sin(u * 11.3 - t * speedB + i * 1.9) * height * (0.03 + lanes.energy * 0.05);
        context.lineTo(step * stepWidth, centre + fold + thickness / 2);
      }
      context.closePath();

      // A gradient across the layer rather than a flat fill, so overlaps blend
      // into new hues instead of stacking as visible bands.
      const wash = context.createLinearGradient(0, centre - thickness, 0, centre + thickness);
      wash.addColorStop(0, 'rgba(0,0,0,0)');
      wash.addColorStop(0.5, colour);
      wash.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = wash;
      context.globalAlpha = 0.10 + level * 0.42;
      context.fill();
    }

    // A slow full-frame veil in the section colour, which ties the layers
    // together and stops the darkest areas reading as empty.
    const veil = context.createLinearGradient(0, 0, width, height);
    veil.addColorStop(0, mix(from, '#000000', 0.82));
    veil.addColorStop(1, mix(to, '#000000', 0.86));
    context.globalAlpha = 0.35 + lanes.beat * 0.15;
    context.fillStyle = veil;
    context.fillRect(0, 0, width, height);

    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
}

/**
 * Alchemy: matter falling into a black hole.
 *
 * Particles are pulled inward by inverse-square attraction and given tangential
 * launch velocity, so they spiral rather than fall straight in - which forms an
 * accretion disc without simulating one explicitly.
 *
 * Three numbers took several attempts to get right, and the reasoning is worth
 * keeping. Gravity is derived from the spawn radius, because a fixed constant
 * was an order of magnitude too weak and everything simply hung at the rim: for
 * a particle to fall from radius r in time T, G is on the order of 2r^3/T^2.
 * Launch speed is a fraction of the circular-orbit velocity sqrt(G/r), so orbits
 * start already decaying. And the inward drift comes from **viscous drag**, not
 * from a tangential push - an earlier "frame dragging" term added orbital energy
 * continuously and pushed matter outward, which is the opposite of an accretion
 * disc.
 */
export class ParticlesVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.particles = [];
  }

  /** Spawn a particle at the rim on a decaying orbit. */
  spawn(width, height, gravity) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.max(width, height) * (0.38 + Math.random() * 0.30);
    const circular = Math.sqrt(gravity / radius);
    const fraction = 0.62 + Math.random() * 0.22;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: -Math.sin(angle) * circular * fraction,
      vy: Math.cos(angle) * circular * fraction,
      seed: Math.random(),
      heat: 0,
    };
  }

  ensurePool(width, height, gravity) {
    const target = Math.min(1100, Math.floor((width * height) / 4200));
    while (this.particles.length < target) {
      this.particles.push(this.spawn(width, height, gravity));
    }
    if (this.particles.length > target) this.particles.length = target;
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    const cx = width / 2;
    const cy = height / 2;
    const horizon = Math.min(width, height) * (0.055 + lanes.beat * 0.018 + lanes.bass * 0.012);

    const rim = Math.max(width, height) * 0.68;
    const infallSeconds = 5.5 - lanes.bass * 1.8 - lanes.energy * 0.9;
    const gravity = (2 * rim ** 3) / (infallSeconds ** 2);

    this.ensurePool(width, height, gravity);

    // Long trails: the spiral is the subject, and a hard clear destroys it.
    context.fillStyle = 'rgba(2, 2, 6, 0.16)';
    context.fillRect(0, 0, width, height);

    context.save();
    context.translate(cx, cy);
    // Additive: overlapping particles brighten into a glowing disc.
    context.globalCompositeOperation = 'lighter';

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const distance = Math.hypot(p.x, p.y) || 1;

      const pull = gravity / (distance * distance);
      p.vx += (-p.x / distance) * pull * deltaSec;
      p.vy += (-p.y / distance) * pull * deltaSec;

      // Gentle swirl, kept small so it cannot pump energy into the orbit.
      const swirl = Math.sqrt(gravity / distance) * (0.10 + lanes.mid * 0.22);
      p.vx += (-p.y / distance) * swirl * deltaSec;
      p.vy += (p.x / distance) * swirl * deltaSec;

      // Viscous drag: the term that actually causes infall.
      const damping = Math.pow(0.965 - lanes.bass * 0.02, deltaSec * 60);
      p.vx *= damping;
      p.vy *= damping;

      if (distance > horizon * 4) {
        p.vx += (Math.random() - 0.5) * lanes.treble * 120 * deltaSec;
        p.vy += (Math.random() - 0.5) * lanes.treble * 120 * deltaSec;
      }

      p.x += p.vx * deltaSec;
      p.y += p.vy * deltaSec;
      p.heat = Math.min(1, Math.max(p.heat * 0.97, 1 - distance / rim));

      if (distance < horizon * 1.05 || distance > Math.max(width, height) * 1.3) {
        this.particles[i] = this.spawn(width, height, gravity);
        continue;
      }

      const size = 0.7 + p.seed * 1.6 + p.heat * 2.2;
      context.fillStyle = p.heat > 0.65
        ? mix('#ffffff', to, (1 - p.heat) * 2.2)
        : mix(from, to, 1 - p.heat);
      context.globalAlpha = 0.22 + p.heat * 0.70;
      context.beginPath();
      context.arc(p.x, p.y, size, 0, Math.PI * 2);
      context.fill();
    }

    // Lensing ring just outside the horizon.
    context.globalAlpha = 0.55 + lanes.beat * 0.35;
    const ring = context.createRadialGradient(0, 0, horizon, 0, 0, horizon * 2.6);
    ring.addColorStop(0, 'rgba(255,255,255,0.00)');
    ring.addColorStop(0.18, mix('#ffffff', to, 0.35));
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = ring;
    context.beginPath();
    context.arc(0, 0, horizon * 2.6, 0, Math.PI * 2);
    context.fill();

    // The horizon, drawn normally so it is genuinely black - additive blending
    // could never produce black.
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.fillStyle = '#000000';
    context.beginPath();
    context.arc(0, 0, horizon, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = mix('#ffffff', to, 0.30);
    context.globalAlpha = 0.75 + lanes.beat * 0.25;
    context.lineWidth = Math.max(1, horizon * 0.07);
    context.beginPath();
    context.arc(0, 0, horizon * 1.03, 0, Math.PI * 2);
    context.stroke();

    context.restore();
    context.globalAlpha = 1;
  }
}

/**
 * Kaleidoscope: one wedge of spectrum geometry mirrored around the centre.
 *
 * Additive blending is what makes it luminous: overlapping mirrored segments
 * accumulate into saturated colour instead of flatly covering one another.
 * Alternate segments are flipped, which produces the folded look rather than a
 * simple rotation.
 */
export class KaleidoscopeVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;

    // Persistence rather than a clear, so segments smear and the figure glows.
    context.fillStyle = 'rgba(4, 4, 10, 0.30)';
    context.fillRect(0, 0, width, height);
    if (bands === 0) return;

    const cx = width / 2;
    const cy = height / 2;
    // Back to a contained disc. Filling the frame turned the pattern into a
    // wash with no shape to read; a kaleidoscope is an object you look into.
    const reach = Math.min(width, height) * 0.42;
    context.globalCompositeOperation = 'lighter';

    // Segment count follows section brightness, so complexity tracks the music.
    const segments = 6 + (Math.floor(lanes.brightness * 4) * 2);
    const spin = this.lanes.scoreSec * (0.10 + lanes.flux * 0.22);

    for (let segment = 0; segment < segments; segment++) {
      context.save();
      context.translate(cx, cy);
      context.rotate(spin + (segment / segments) * Math.PI * 2);
      if (segment % 2 === 1) context.scale(1, -1);

      for (let i = 0; i < bands; i++) {
        const level = lanes.spectrum[i];
        if (level < 0.02) continue;
        const radius = (i / bands) * reach;
        const thickness = Math.max(2, level * reach * 0.16);
        const arc = (Math.PI * 2 / segments) * (0.35 + level * 0.55);

        // Bloom, then core. Alphas are lower than before: additive blending
        // across a dozen mirrored segments was summing past white, which washed
        // out exactly the saturated colour the mode exists for.
        context.strokeStyle = mix(from, to, i / (bands - 1));
        context.globalAlpha = 0.03 + level * 0.08;
        context.lineWidth = thickness * 2.4;
        context.beginPath();
        context.arc(0, 0, radius, 0, arc);
        context.stroke();

        // The core keeps its hue instead of being pushed toward white, so peaks
        // read as intense colour rather than as glare.
        context.strokeStyle = mix(from, to, i / (bands - 1));
        context.globalAlpha = 0.09 + level * 0.22;
        context.lineWidth = thickness;
        context.beginPath();
        context.arc(0, 0, radius, 0, arc);
        context.stroke();
      }
      context.restore();
    }

    // A much smaller, dimmer centre. The old one covered a third of the frame
    // in white and was most of why the colours never came through.
    // Dimmer centre still. Additive blending across a dozen mirrored segments
    // already sums toward white in the middle; adding a bright core on top was
    // what blew out the very colours the mode exists to show.
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) * 0.10);
    glow.addColorStop(0, `rgba(255,255,255,${0.04 + lanes.beat * 0.10})`);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = glow;
    context.globalAlpha = 1;
    context.fillRect(0, 0, width, height);

    context.globalCompositeOperation = 'source-over';

    // Vignette, so the scope reads as a lens rather than a pattern that happens
    // to stop.
    const edge = context.createRadialGradient(cx, cy, reach * 0.72, cx, cy, reach * 1.25);
    edge.addColorStop(0, 'rgba(4,4,10,0)');
    edge.addColorStop(1, 'rgba(4,4,10,0.92)');
    context.fillStyle = edge;
    context.fillRect(0, 0, width, height);
  }
}

/**
 * Vinyl: a record on a turntable, lit from above.
 *
 * Rebuilt for realism. The previous version drew concentric coloured rings,
 * which reads as a diagram of a record rather than a record. Real vinyl is
 * almost black; what makes it recognisable is not colour but **specular
 * reflection** - a bright sheen that sweeps across the surface as the disc
 * turns, thousands of fine grooves catching the light, and a paper label with
 * printed detail.
 *
 * So the music is expressed through the light rather than through hue: the
 * spectrum modulates how strongly each radial zone catches the sheen, the beat
 * drives the rotation, and bass tilts the whole platter.
 */
export class VinylVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.angle = 0;
    this.dust = null;
    this.label = null;
    /** Pre-rendered disc: grooves, dust and body, none of which change. */
    this.disc = null;
  }

  /**
   * Render the unchanging parts of the record once.
   *
   * The grooves are roughly 260 concentric rings, each a full-circle stroke of
   * up to 400px radius. Drawing them every frame was the entire cost of this
   * mode - over five hundred large arc strokes, expensive on a real canvas and
   * doubly so at a 2x device pixel ratio.
   *
   * None of it changes between frames; only the rotation does. Rendering it once
   * into an offscreen canvas and rotating that image reduces the per-frame work
   * to a single blit plus the handful of arcs that genuinely react to the music.
   *
   * @param {number} outer Disc radius in pixels.
   * @returns {{canvas: object, outer: number, size: number}|null}
   */
  buildDisc(outer) {
    if (this.disc && this.disc.outer === outer) return this.disc;

    const size = Math.ceil(outer * 2 + 4);
    let surface;
    try {
      surface = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
    } catch {
      return null;
    }
    const context = surface.getContext('2d');
    if (!context) return null;

    context.translate(size / 2, size / 2);

    // Body: nearly black, with the slight blue-grey cast real vinyl has.
    const body = context.createRadialGradient(0, 0, outer * 0.20, 0, 0, outer);
    body.addColorStop(0, '#141419');
    body.addColorStop(0.7, '#0d0d11');
    body.addColorStop(1, '#08080b');
    context.fillStyle = body;
    context.beginPath();
    context.arc(0, 0, outer, 0, Math.PI * 2);
    context.fill();

    // Fine grooves; their number is what produces the moire shimmer.
    const grooveCount = Math.floor(outer * 0.9);
    for (let i = 0; i < grooveCount; i++) {
      const radius = outer * (0.32 + (i / grooveCount) * 0.66);
      context.strokeStyle = `rgba(30,30,36,${0.35 + (i % 3) * 0.08})`;
      context.lineWidth = 0.6;
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.stroke();
    }

    // Wider gaps between tracks, as on a real side.
    context.strokeStyle = 'rgba(6,6,9,0.9)';
    context.lineWidth = Math.max(1.5, outer * 0.008);
    for (let track = 1; track <= 5; track++) {
      context.beginPath();
      context.arc(0, 0, outer * (0.30 + (track / 6) * 0.68), 0, Math.PI * 2);
      context.stroke();
    }

    // Dust and hairline imperfections.
    context.fillStyle = 'rgba(200,205,215,0.35)';
    for (let i = 0; i < 90; i++) {
      const r = (((i * 7919) % 1000) / 1000) ** 0.5;
      const radius = outer * (0.30 + r * 0.68);
      const angle = ((i * 6271) % 1000) / 1000 * Math.PI * 2;
      context.beginPath();
      context.arc(
        Math.cos(angle) * radius, Math.sin(angle) * radius,
        0.4 + ((i * 3571) % 100) / 100 * 1.1, 0, Math.PI * 2,
      );
      context.fill();
    }

    this.disc = { canvas: surface, outer, size };
    return this.disc;
  }

  /**
   * Load the track's artwork for the record label.
   *
   * Through the image proxy, since the Activity sandbox blocks direct external
   * loads. A failure leaves `label` null and the printed-paper label is drawn
   * instead, so this never has to succeed.
   *
   * @param {object|null} track
   */
  setTrack(track) {
    this.label = null;
    if (!track?.thumbnail) return;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', () => {
      // Guard against a track change during the load.
      if (this.trackId === track.providerId) this.label = image;
    });
    this.trackId = track.providerId;
    image.src = `/api/image?url=${encodeURIComponent(track.thumbnail)}`;
  }

  /** Fixed dust and surface imperfections, generated once. */
  ensureDust(outer) {
    if (this.dust && this.dust.outer === outer) return;
    this.dust = {
      outer,
      specks: Array.from({ length: 90 }, (_, i) => {
        const r = (((i * 7919) % 1000) / 1000) ** 0.5;
        return {
          radius: outer * (0.30 + r * 0.68),
          angle: ((i * 6271) % 1000) / 1000 * Math.PI * 2,
          size: 0.4 + ((i * 3571) % 100) / 100 * 1.1,
        };
      }),
    };
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const bands = lanes.spectrum.length;
    if (bands === 0) return;

    const cx = width / 2;
    const cy = height / 2;
    const outer = Math.min(width, height) * 0.40;
    this.ensureDust(outer);

    // Deck surface: a dark felt-like ground with a soft pool of light.
    context.fillStyle = '#0a0a0d';
    context.fillRect(0, 0, width, height);
    const room = context.createRadialGradient(
      cx - outer * 0.4, cy - outer * 0.6, 0, cx, cy, Math.hypot(width, height) * 0.7,
    );
    room.addColorStop(0, 'rgba(255,250,235,0.10)');
    room.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = room;
    context.fillRect(0, 0, width, height);

    // 33 1/3 rpm is the real speed of an LP, and using it rather than an
    // arbitrary rate is most of why this reads as a record: the eye knows what
    // that rotation looks like. The beat only perturbs it slightly.
    const revolutionsPerSecond = 33.333 / 60;
    this.angle += deltaSec * revolutionsPerSecond * Math.PI * 2
      * (1 + lanes.beat * 0.05 + lanes.punch * 0.03);

    // Bass tilts the platter, faked by squashing one axis.
    const tilt = 0.10 + lanes.bass * 0.05;

    context.save();
    context.translate(cx, cy);
    context.scale(1, 1 - tilt);

    // Drop shadow beneath the disc.
    context.fillStyle = 'rgba(0,0,0,0.55)';
    context.beginPath();
    context.arc(outer * 0.03, outer * 0.05, outer * 1.01, 0, Math.PI * 2);
    context.fill();

    // The static disc: body, grooves and dust, drawn once and rotated.
    const disc = this.buildDisc(Math.round(outer));
    if (disc) {
      context.save();
      context.rotate(this.angle);
      const grow = 1 + lanes.beat * 0.012;
      context.drawImage(
        disc.canvas, -disc.size / 2 * grow, -disc.size / 2 * grow,
        disc.size * grow, disc.size * grow,
      );
      context.restore();
    }

    // Six coloured zones over the grooves, each averaging a slice of the
    // spectrum. Six wide arcs rather than a colour per groove: the same effect
    // for a fraction of the drawing cost, and at this size sixteen thin rings
    // blurred into a gradient anyway.
    const RING_BANDS = 6;
    for (let zone = 0; zone < RING_BANDS; zone++) {
      const low = Math.floor((zone / RING_BANDS) * bands);
      const high = Math.max(low + 1, Math.floor(((zone + 1) / RING_BANDS) * bands));
      let level = 0;
      for (let b = low; b < high; b++) level += lanes.spectrum[b];
      level /= high - low;

      const t = zone / (RING_BANDS - 1);
      const radius = outer * (0.36 + t * 0.58);
      const colour = level > 0.62
        ? mix(mix(from, to, t), '#ffffff', (level - 0.62) * 1.6)
        : mix(from, to, t);

      // A sheen over near-black vinyl rather than a replacement: a fully
      // coloured record would stop reading as one.
      context.strokeStyle = colour;
      context.globalAlpha = 0.05 + level * 0.30;
      context.lineWidth = outer * 0.095;
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.stroke();
    }
    context.globalAlpha = 1;


    // --- Specular sheen ----------------------------------------------------
    // Two opposed highlights that stay fixed relative to the light, not to the
    // disc - which is exactly how reflection behaves, and the single detail
    // that makes the surface read as glossy rather than matte.
    context.globalCompositeOperation = 'lighter';
    for (const direction of [-1, 1]) {
      const sheenAngle = -0.7 * direction;
      const sx = Math.cos(sheenAngle) * outer * 0.55 * direction;
      const sy = Math.sin(sheenAngle) * outer * 0.55 * direction;
      const sheen = context.createRadialGradient(sx, sy, 0, sx, sy, outer * 0.95);
      const strength = 0.16 + lanes.energy * 0.16;
      sheen.addColorStop(0, `rgba(${180 + lanes.brightness * 60},190,215,${strength})`);
      sheen.addColorStop(0.5, `rgba(120,130,160,${strength * 0.3})`);
      sheen.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = sheen;
      context.beginPath();
      context.arc(0, 0, outer, 0, Math.PI * 2);
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';

    // --- Label -------------------------------------------------------------
    context.save();
    context.rotate(this.angle);
    const labelRadius = outer * 0.30;

    if (this.label) {
      // The album art as the record's label, clipped to the circle and turning
      // with the disc - which is what a picture disc looks like.
      context.save();
      context.beginPath();
      context.arc(0, 0, labelRadius, 0, Math.PI * 2);
      context.clip();
      // Aspect-fill rather than stretch. Album art is usually square but not
      // always, and forcing a 16:9 thumbnail into a circle distorted every face
      // on it. Cropping the source to a square first preserves the proportions
      // and costs nothing extra - drawImage does the crop in the same call.
      const iw = this.label.naturalWidth || this.label.width || 1;
      const ih = this.label.naturalHeight || this.label.height || 1;
      const side = Math.min(iw, ih);
      context.drawImage(
        this.label,
        (iw - side) / 2, (ih - side) / 2, side, side,
        -labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2,
      );
      // Darkened toward the rim, so the paper sits under the vinyl rather than
      // floating on top of it.
      const shade = context.createRadialGradient(0, 0, labelRadius * 0.5, 0, 0, labelRadius);
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(0,0,0,0.5)');
      context.fillStyle = shade;
      context.fillRect(-labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2);
      context.restore();
    } else {
      const label = context.createRadialGradient(
        -labelRadius * 0.3, -labelRadius * 0.3, 0, 0, 0, labelRadius,
      );
      label.addColorStop(0, mix(to, '#ffffff', 0.35));
      label.addColorStop(0.75, to);
      label.addColorStop(1, mix(from, '#000000', 0.35));
      context.fillStyle = label;
      context.beginPath();
      context.arc(0, 0, labelRadius, 0, Math.PI * 2);
      context.fill();
    }

    // Printed rings on the label, as nearly every pressing has.
    context.strokeStyle = 'rgba(0,0,0,0.30)';
    context.lineWidth = Math.max(1, outer * 0.004);
    for (const r of [0.55, 0.78, 0.92]) {
      context.beginPath();
      context.arc(0, 0, labelRadius * r, 0, Math.PI * 2);
      context.stroke();
    }

    // Text on the label, curved with the disc. Bands of type rather than real
    // words: legible lettering would be unreadable at this rotation anyway.
    context.fillStyle = 'rgba(0,0,0,0.42)';
    for (let line = 0; line < 3; line++) {
      const r = labelRadius * (0.36 + line * 0.16);
      const span = 0.9 - line * 0.18;
      context.lineWidth = labelRadius * 0.05;
      context.strokeStyle = 'rgba(0,0,0,0.35)';
      context.beginPath();
      context.arc(0, 0, r, -span / 2, span / 2);
      context.stroke();
    }

    // Spindle hole, with the paper's cut edge catching light.
    context.fillStyle = '#07070a';
    context.beginPath();
    context.arc(0, 0, outer * 0.021, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.18)';
    context.lineWidth = 1;
    context.stroke();

    context.restore();
    context.restore();

    // --- Tonearm -----------------------------------------------------------
    // Drawn outside the platter transform, since it does not rotate with the
    // disc. It tracks inward as the track plays, which gives the whole image a
    // sense of progress.
    const duration = score.source?.duration_sec
      || score.analysis?.analysed_duration_sec || 240;
    const progress = Math.min(1, playbackSec / duration);

    const pivotX = cx + outer * 1.02;
    const pivotY = cy - outer * 0.72;
    // Stylus travels from the outer edge inward toward the label.
    const stylusR = outer * (0.96 - progress * 0.62);
    const stylusX = cx + Math.cos(Math.PI * 0.62) * stylusR;
    const stylusY = cy + Math.sin(Math.PI * 0.62) * stylusR * (1 - tilt);

    // Arm shadow on the disc.
    context.strokeStyle = 'rgba(0,0,0,0.45)';
    context.lineWidth = Math.max(3, outer * 0.020);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(pivotX + 6, pivotY + 8);
    context.lineTo(stylusX + 6, stylusY + 8);
    context.stroke();

    // The arm itself: brushed metal, brighter along the top edge.
    const arm = context.createLinearGradient(pivotX, pivotY - 4, stylusX, stylusY + 4);
    arm.addColorStop(0, '#c9d0d6');
    arm.addColorStop(0.5, '#8d959c');
    arm.addColorStop(1, '#b6bec5');
    context.strokeStyle = arm;
    context.lineWidth = Math.max(3, outer * 0.018);
    context.beginPath();
    context.moveTo(pivotX, pivotY);
    context.lineTo(stylusX, stylusY);
    context.stroke();

    // Headshell at the stylus end.
    context.save();
    context.translate(stylusX, stylusY);
    context.rotate(Math.atan2(stylusY - pivotY, stylusX - pivotX));
    context.fillStyle = '#2a2d33';
    context.fillRect(-outer * 0.045, -outer * 0.022, outer * 0.075, outer * 0.044);
    context.fillStyle = '#d8dee4';
    context.fillRect(-outer * 0.045, -outer * 0.022, outer * 0.075, outer * 0.008);
    context.restore();

    // Pivot housing.
    const pivot = context.createRadialGradient(
      pivotX - 4, pivotY - 4, 0, pivotX, pivotY, outer * 0.075,
    );
    pivot.addColorStop(0, '#e3e8ec');
    pivot.addColorStop(1, '#5c646b');
    context.fillStyle = pivot;
    context.beginPath();
    context.arc(pivotX, pivotY, outer * 0.075, 0, Math.PI * 2);
    context.fill();

    // Counterweight behind the pivot.
    context.fillStyle = '#3a3f45';
    context.beginPath();
    context.arc(pivotX + outer * 0.10, pivotY - outer * 0.07, outer * 0.05, 0, Math.PI * 2);
    context.fill();
  }
}
/**
 * None: no visualisation at all.
 *
 * Exists so the Activity can be used purely as a player - a shared queue and
 * transport with nothing moving behind it. Useful when the visuals would be
 * distracting, when someone is on a machine where they cost too much, or when
 * the Activity is simply background audio for a conversation.
 *
 * It still clears the canvas each frame, because leaving whatever the previous
 * visualisation drew frozen on screen would look like a crash rather than a
 * deliberate choice.
 */
export class NoneVisual extends Canvas2DVisual {
  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    context.fillStyle = '#05050a';
    context.fillRect(0, 0, width, height);
  }
}
