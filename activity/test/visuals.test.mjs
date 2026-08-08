import assert from 'node:assert/strict';
import {
  BarsVisual, TunnelVisual, ColoursVisual,
  ParticlesVisual, KaleidoscopeVisual, VinylVisual, NoneVisual,
} from '../client/visuals.js';
import {
  GalaxyVisual, TerrainVisual, RainVisual, FirefliesVisual, RibbonsVisual,
  MosaicVisual, AuroraVisual, PulseVisual,
} from '../client/visuals2.js';
import { StickMenVisual } from '../client/stickmen.js';
import { VISUALS as REGISTRY } from '../client/registry.js';

// Every visualisation in the menu, taken from the registry itself.
//
// This was a hand-written list, and a hand-written list is wrong the moment
// somebody adds a visualisation and forgets it - which had already happened
// once: the note below records Stick Men being the only 2D visualisation this
// test did not cover, "which is exactly why that survived". It then happened
// again with Now Playing and Lyrics, and the suite went on reporting 18/18 as
// though nothing had been added.
//
// Reading the registry means a new visualisation is covered by existing at all.
const VISUALS = Object.fromEntries(
  REGISTRY.map((entry) => [entry.name, entry.make]),
);

/**
 * A canvas context that records every call and argument.
 *
 * Comparing recordings is the only way to test this property from outside: the
 * question is not whether a renderer throws, it is whether it draws the *same
 * picture* given the same position in the track.
 */
function recordingContext() {
  const calls = [];
  const gradient = { addColorStop: (...a) => calls.push(['stop', ...a]) };
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const context = {
    calls,
    createLinearGradient: (...a) => { record('linear')(...a); return gradient; },
    createRadialGradient: (...a) => { record('radial')(...a); return gradient; },
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: record('putImageData'),
    drawImage: record('drawImage'),
    setTransform: record('setTransform'),
  };
  for (const name of [
    'arc', 'arcTo', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath',
    'ellipse', 'fill', 'fillRect', 'fillText', 'lineTo', 'moveTo', 'quadraticCurveTo',
    'rect', 'resetTransform', 'restore', 'rotate', 'save', 'scale', 'stroke',
    'strokeRect', 'strokeText', 'transform', 'translate', 'roundRect',
  ]) {
    context[name] = record(name);
  }
  // Style properties are recorded on write, so a colour driven by a wall clock
  // is caught as readily as a coordinate.
  for (const property of [
    'fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'globalCompositeOperation',
    'lineCap', 'lineJoin', 'font', 'textAlign', 'textBaseline', 'shadowBlur',
    'shadowColor', 'filter', 'miterLimit', 'lineDashOffset',
  ]) {
    let stored;
    Object.defineProperty(context, property, {
      get: () => stored,
      set: (value) => {
        stored = value;
        calls.push([property, value]);
      },
    });
  }
  return context;
}

const canvasWith = (context) => ({
  clientWidth: 640,
  clientHeight: 360,
  width: 640,
  height: 360,
  getContext: () => context,
});

globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 };

const frameCount = 1800;
const lane = (fn) => Array.from({ length: frameCount }, (_, i) => fn(i));
const score = {
  analysis: { is_partial: false, analysed_duration_sec: 60 },
  timing: { tempo_bpm: 120, meter: 4, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3], tempo_confidence: 0.9 },
  lanes: {
    fps: 30,
    frame_count: frameCount,
    // Varying rather than constant, so a renderer that reads the wrong frame
    // shows up as a difference rather than being masked by a flat lane.
    energy: lane((i) => 0.3 + 0.3 * Math.sin(i / 40)),
    punch: lane((i) => 0.2 + 0.2 * Math.sin(i / 7)),
    brightness: lane((i) => 0.4 + 0.2 * Math.sin(i / 55)),
    flux: lane((i) => 0.3 + 0.2 * Math.sin(i / 23)),
    bass: lane((i) => 0.4 + 0.3 * Math.sin(i / 17)),
    mid: lane((i) => 0.4 + 0.2 * Math.sin(i / 19)),
    treble: lane((i) => 0.3 + 0.2 * Math.sin(i / 13)),
    // Band-major, matching a real score: sixteen bands, each a dense lane over
    // every frame. This was frame-major - an array of frames each holding
    // sixteen values - which is the transpose, and nothing caught it because
    // `LaneReader` reads `spectrum[band][frame]` and simply found `undefined`.
    // Every visualisation in this file was therefore being tested against a
    // spectrum of 1800 bands whose levels were almost all zero.
    spectrum: Array.from({ length: 16 }, (_, b) =>
      lane((i) => 0.2 + 0.5 * Math.abs(Math.sin((i + b * 9) / 21)))),
  },
  // Many short sections rather than two long ones.
  //
  // The sweep below covers 0 to 1.5 seconds of playback, so with 30-second
  // sections it never left the first one. Anything selected *by section* was
  // therefore never exercised - which is how two wall-clock reads survived in
  // the stick men's environment layer, where the section picks which of the
  // seventeen environments is drawn and the first one happens not to animate.
  // Short sections walk through that whole table inside the same sweep.
  sections: Array.from({ length: 20 }, (_, index) => ({
    index,
    start_sec: index * 0.08,
    end_sec: (index + 1) * 0.08,
    energy_mean: 0.45 + (index % 3) * 0.08,
    brightness_mean: 0.5 - (index % 4) * 0.05,
  })),
};

const realNow = performance.now.bind(performance);
const realRandom = Math.random;

/**
 * Deterministic stand-in for `Math.random`.
 *
 * Several of these renderers scatter particles, buildings or stars randomly, so
 * two instances naturally differ. That is fine and intended - it is decoration,
 * not synchronisation - but it would swamp the property actually under test.
 * Feeding both instances the same stream leaves wall-clock drift as the only
 * possible source of difference.
 */
const seeded = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

/**
 * Compare two recorded operations, tolerating floating-point noise.
 *
 * The two clocks are ten million milliseconds apart, and a double has only so
 * much resolution up there - so `(now - lastFrame)` differs between the runs in
 * roughly its ninth significant figure, and any integrator carries that forward.
 * Requiring bit-equality would fail on that alone.
 *
 * The tolerance is far below the defects this exists to catch: wall-clock motion
 * showed up as whole units to hundreds of units of difference - one run had a
 * turntable at 0.000 radians against the other's 0.353 - not thousandths.
 */
const TOLERANCE = 1e-3;
function sameCall(x, y) {
  if (x.length !== y.length) return false;
  return x.every((value, i) => {
    const other = y[i];
    if (typeof value === 'number' && typeof other === 'number') {
      if (Number.isNaN(value) && Number.isNaN(other)) return true;
      return Math.abs(value - other) <= TOLERANCE * Math.max(1, Math.abs(value));
    }
    return String(value) === String(other);
  });
}
const describe = (call) => call.map(
  (v) => (typeof v === 'number' ? v.toFixed(4) : String(v)),
).join(' ');

let checked = 0;
const drifting = [];

for (const [name, make] of Object.entries(VISUALS)) {
  // Two instances stepped in lockstep over exactly the same playback positions,
  // with wall clocks nearly three hours apart. Anything that differs is being
  // driven by the wall clock rather than by the track - which means it keeps
  // moving while playback is paused, ignores a seek, and is at a different point
  // for every person in the voice channel. In an Activity built around watching
  // one track together, that last one is the whole problem.
  //
  // Compared and cleared per frame rather than collected and diffed at the end:
  // some of these renderers emit thousands of operations a frame, and holding
  // two full runs for twenty visualisations exhausted the heap outright.
  let clockA = 0;
  let clockB = 10_000_000;

  // Constructed under their own fake clocks. `Canvas2DVisual` latches
  // `performance.now()` into `lastFrameMs` at construction, so building both
  // under the real clock and only then installing the fakes handed one instance
  // a negative first delta and the other a ten-thousand-second one - which made
  // every renderer look like it drifted when the difference was entirely the
  // test's own doing.
  const contextA = recordingContext();
  const contextB = recordingContext();
  performance.now = () => clockA;
  Math.random = seeded(1);
  const a = make(canvasWith(contextA));
  performance.now = () => clockB;
  Math.random = seeded(1);
  const b = make(canvasWith(contextB));
  performance.now = realNow;
  Math.random = realRandom;
  let drawn = 0;
  // Per-visual, not the shared list: guarding the loop on `drifting` meant one
  // drifting renderer skipped every later visual's loop entirely, and they then
  // failed with a misleading "drew nothing".
  let diverged = false;

  for (let frame = 0; frame < 90 && !diverged; frame++) {
    clockA += 1000 / 60;
    clockB += 1000 / 60;
    const position = frame / 60;

    // Reset to the same seed before each render so both consume an identical
    // random stream for the frame.
    performance.now = () => clockA;
    Math.random = seeded(1000 + frame);
    a.render(score, position, position);
    performance.now = () => clockB;
    Math.random = seeded(1000 + frame);
    b.render(score, position, position);
    performance.now = realNow;
    Math.random = realRandom;

    drawn += contextA.calls.length;
    if (contextA.calls.length !== contextB.calls.length) {
      drifting.push(`${name}: frame ${frame} drew`
        + ` ${contextA.calls.length} ops on one clock and ${contextB.calls.length} on another`);
      diverged = true; break;
    }
    const differing = contextA.calls.findIndex(
      (call, i) => !sameCall(call, contextB.calls[i]),
    );
    if (differing !== -1) {
      drifting.push(`${name}: frame ${frame} op ${differing}`
        + ` "${describe(contextA.calls[differing])}"`
        + ` vs "${describe(contextB.calls[differing])}"`);
      diverged = true; break;
    }
    contextA.calls.length = 0;
    contextB.calls.length = 0;
  }

  assert.ok(drawn > 0 || name === 'NoneVisual', `${name} drew nothing at all`);
  checked++;
}

assert.equal(drifting.length, 0,
  `these visualisations drift with the wall clock:\n  ${drifting.join('\n  ')}`);

// A renderer must also survive a score with no beats and a partial analysis,
// which is what the client holds while a track is still being analysed.
const sparse = {
  ...score,
  analysis: { is_partial: true, analysed_duration_sec: 20 },
  timing: { tempo_bpm: 0, meter: 4, beats: [], tempo_confidence: 0 },
};
for (const [name, make] of Object.entries(VISUALS)) {
  const visual = make(canvasWith(recordingContext()));
  let fakeNow = 0;
  performance.now = () => fakeNow;
  assert.doesNotThrow(() => {
    for (let frame = 0; frame < 30; frame++) {
      fakeNow += 1000 / 60;
      // Deliberately past the analysed window, where a partial score loops.
      visual.render(sparse, 25 + frame / 60, frame / 60);
    }
  }, `${name} threw on a partial score with no beat grid`);
  performance.now = realNow;
}

console.log(`visuals: ${checked}/${checked} pass (score-locked, partial scores survived)`);

// --- a renderer that dies must not poison the next one -----------------------
// Every visualisation shares one canvas and one 2D context. Pulse sets
// `globalCompositeOperation = 'lighter'` near the top of its render and restores
// it on the last line, so an exception in between left every *other*
// visualisation compositing additively - the whole set went white, and a fault
// in one renderer looked like a fault in all of them.
{
  const context = recordingContext();
  const canvas = canvasWith(context);

  // Leave the context exactly as a renderer that threw mid-frame would.
  context.globalCompositeOperation = 'lighter';
  context.globalAlpha = 0.3;
  context.filter = 'blur(4px)';

  const visual = new BarsVisual(canvas);
  context.calls.length = 0;
  visual.render(score, 1, 1);

  // `begin` must have restored the defaults before the renderer drew anything.
  const first = (property) => context.calls.find((call) => call[0] === property);
  assert.deepEqual(first('globalCompositeOperation'), ['globalCompositeOperation', 'source-over'],
    'a frame must start in source-over, whatever the previous renderer left');
  assert.deepEqual(first('globalAlpha'), ['globalAlpha', 1], 'and at full alpha');
  assert.deepEqual(first('filter'), ['filter', 'none'], 'and with no filter');
  console.log('context hygiene: 3/3 pass (a crashed renderer cannot poison the next)');
}

// --- Pulse: a negative brightness must not index off the bucket array --------
// `lit` can go negative, because `crest` is (swell + 1) / 2 and `swell` reaches
// -roughness, which passes -1 once roughness exceeds 1. Flooring that gave -1,
// `buckets[-1]` is undefined, and the frame died on `.push` - taking the
// composite mode with it, because Pulse restores it on its last line. Latent
// until the lane smoothing was made asymmetric and energy and bass could
// actually reach the top of their range.
{
  const loud = {
    ...score,
    // No usable tempo, so no repeating beats and therefore no shockwaves. The
    // troughs only go negative where nothing is brightening them, which in a
    // real track is a loud sustained passage between transients.
    timing: { ...score.timing, tempo_bpm: 0, beats: [], tempo_confidence: 0 },
    lanes: {
      ...score.lanes,
      // roughness = 0.35 + energy * 0.75 + bass * 0.30, so this is its ceiling.
      energy: lane(() => 1),
      bass: lane(() => 1),
      // No spectrum energy, so no wave brightens the troughs back above zero.
      spectrum: lane(() => Array.from({ length: 16 }, () => 0)),
    },
  };

  // A full-size canvas and enough frames for the smoothing to saturate: the
  // troughs only go negative once roughness passes 1, which needs energy and
  // bass near the top of their range, and only some grid points sample the
  // deepest trough of the three combined swells.
  const context = recordingContext();
  const big = { ...canvasWith(context), clientWidth: 1920, clientHeight: 1080, width: 1920, height: 1080 };
  const visual = new PulseVisual(big);
  let threw = null;
  try {
    for (let frame = 0; frame < 240; frame++) visual.render(loud, frame * 0.05, frame * 0.05);
  } catch (error) {
    threw = error.message;
  }
  assert.equal(threw, null, `Pulse threw on a loud passage: ${threw}`);
  // Honest about what this covers: a smoke test over a loud, wave-free passage,
  // not a reproduction. The original failure needs the deepest trough of three
  // combined swells to coincide with a point no shockwave is lighting, and that
  // alignment could not be forced here - the arithmetic was confirmed instead
  // (minimum lit -0.110, which floors to bucket -1) and the fix is a clamp.
  console.log('pulse: 1/1 pass (survives a loud wave-free passage)');
}

// --- Terrain must not start on flat ground ----------------------------------
// The landscape is a scrolling record of what has already been heard, emitted
// at two to five rows a second. Starting that record empty and padding it with
// zeroes meant selecting Terrain part-way through a track gave a flat plain and
// about ten seconds of nothing while thirty-four rows filled. A VisualScore is
// time-addressable, so the history is simply read from the track's past.
{
  const context = recordingContext();
  const visual = new TerrainVisual(canvasWith(context));
  // One frame, well into the track - the case that used to start empty.
  visual.render(score, 30, 30);

  const flat = visual.rows.filter((row) => row.every((height) => height === 0));
  assert.ok(visual.rows.length > 0, 'Terrain built no rows at all');
  assert.equal(flat.length, 0,
    `Terrain started with ${flat.length} of ${visual.rows.length} rows flat`);
  console.log('terrain priming: 2/2 pass (the landscape is populated on the first frame)');
}

// --- Vinyl: the whole cover, not the middle of it ----------------------------
// The label is the album art inscribed in the record's centre circle, with the
// leftover segments filled by mirroring it across each edge.
//
// It was inscribed *after* the source had been squared off, so a 16:9 thumbnail
// lost its left and right thirds before the inscribe ever happened - the label
// showed the middle of the picture, enlarged, which is the crop that inscribing
// exists to avoid.
{
  const context = recordingContext();
  const visual = new VinylVisual(canvasWith(context));
  // A 16:9 thumbnail, which is what every YouTube track supplies.
  visual.label = { naturalWidth: 1280, naturalHeight: 720 };
  visual.render(score, 4);

  const draws = context.calls.filter(([name]) => name === 'drawImage');
  assert.ok(draws.length >= 5,
    `expected the cover and its four mirrors, got ${draws.length} draws`);

  // The source rectangle must cover the whole picture.
  //
  // It is nine arguments now rather than five, because the label trims any
  // letterbox or pillarbox bars baked into a thumbnail before inscribing. That
  // is not a crop of content - it is the removal of pixels that are not
  // content - so what has to hold is that the source rectangle equals the
  // picture, which with no bars detected is the whole image.
  for (const call of draws) {
    assert.equal(call.length, 10,
      'the cover is not drawn with an explicit source rectangle');
    const [, , sx, sy, sw, sh] = call;
    assert.deepEqual([sx, sy, sw, sh], [0, 0, 1280, 720],
      `part of the picture is being cropped away: source ${sx},${sy} ${sw}x${sh}`);
  }

  const [, , , , , , , , width, height] = draws[draws.length - 1];
  assert.ok(Math.abs(width / height - 1280 / 720) < 1e-9,
    `the cover was stretched: drawn ${width.toFixed(1)}x${height.toFixed(1)}`);

  // The label is clipped to a circle, and the arc that does it gives the radius
  // the drawing is sized against. Read it back rather than recomputing it here.
  const clipIndex = context.calls.findIndex(([name]) => name === 'clip');
  const clipArc = context.calls.slice(0, clipIndex).reverse()
    .find(([name]) => name === 'arc');
  assert.ok(clipArc, 'the label is no longer clipped to a circle');
  const diameter = clipArc[3] * 2;

  // Never smaller than inscribed - that would fill the circle with mirror
  // rather than cover.
  assert.ok(Math.hypot(width, height) >= diameter - 1e-6,
    `the cover is smaller than inscribed: diagonal ${Math.hypot(width, height).toFixed(1)} `
    + `against a diameter of ${diameter.toFixed(1)}`);

  // A wide cover is scaled past the diagonal fit so it does not read as a strip
  // laid across its own reflection. 16:9 inscribed by diagonal covers only 0.49
  // of the diameter, against a square cover's 0.71.
  const fill = Math.min(width, height) / diameter;
  assert.ok(fill >= 0.62 - 1e-6,
    `a 16:9 cover fills only ${fill.toFixed(3)} of the label's diameter, so most `
    + 'of what is on screen is its own reflection');
  // But not so far that the clipping becomes the story.
  assert.ok(Math.max(width, height) / diameter <= 1.25,
    `the cover is scaled to ${(Math.max(width, height) / diameter).toFixed(2)} of `
    + 'the diameter, so its long edges are mostly clipped away');

  // A square cover must be untouched by that floor: the diagonal fit already
  // exceeds it, so this change is only ever about wide images.
  {
    const squareContext = recordingContext();
    const square = new VinylVisual(canvasWith(squareContext));
    square.label = { naturalWidth: 640, naturalHeight: 640 };
    square.render(score, 4);
    const squareDraws = squareContext.calls.filter(([name]) => name === 'drawImage');
    const [, , , , , , , , sw2, sh2] = squareDraws[squareDraws.length - 1];
    const squareClip = squareContext.calls.slice(
      0, squareContext.calls.findIndex(([name]) => name === 'clip'),
    ).reverse().find(([name]) => name === 'arc');
    assert.ok(Math.abs(Math.hypot(sw2, sh2) - squareClip[3] * 2) < 1e-6,
      'a square cover is no longer inscribed exactly - the fill floor should '
      + 'never reach it');
  }

  // The mirrors sit exactly one image away, so each shares an edge with the
  // original rather than overlapping it or leaving a gap.
  const offsets = context.calls
    .filter(([name]) => name === 'translate')
    .map(([, dx, dy]) => `${Math.round(dx)},${Math.round(dy)}`);
  for (const expected of [
    `0,${-Math.round(height)}`, `0,${Math.round(height)}`,
    `${-Math.round(width)},0`, `${Math.round(width)},0`,
  ]) {
    assert.ok(offsets.includes(expected),
      `no mirror at ${expected}; the segment beside that edge stays empty`);
  }

  console.log('vinyl label: 13/13 pass (dead space trimmed, wide covers not left as strips)');
}

// --- The palette must survive a negative cycle -------------------------------
// `LaneReader` blends between neighbouring palettes on a phase that advances
// with playback. That phase goes *negative* in ordinary use, and the indexing
// did not survive it:
//
//   - the shorter-way-round logic drives `paletteOffset` to -1 when travelling
//     from the first palette back to the last, and
//   - a track change restarts `scoreSec` at zero,
//
// so `cycle` sits around -1 for the opening seconds of the next song. A
// negative remainder stays negative in JavaScript, `PALETTES[-1]` is undefined,
// and every visualisation reading `lanes.palette` threw
// "Cannot read properties of undefined (reading '0')" on the destructure.
//
// The render guard then disabled whatever was on screen and substituted the
// default, so the symptom was "the visual snaps back to Painter between songs"
// rather than anything that pointed at an array index.
{
  const context = recordingContext();
  const visual = new VinylVisual(canvasWith(context));

  // Wind the palette phase to where the wrap leaves it: travelling from the
  // first scheme back to the last takes the offset below zero.
  visual.lanes.paletteBase = 5;
  visual.lanes.paletteOffset = -1.2;

  // The opening of a track, which is exactly when scoreSec is small enough for
  // a negative offset to dominate the phase.
  for (const at of [0, 0.05, 0.2, 0.5, 1]) {
    assert.doesNotThrow(
      () => visual.render(score, at),
      `a negative palette phase threw at ${at}s - the visual would be disabled `
      + 'and replaced with the default on every track change',
    );
    const [from, to] = visual.lanes.palette;
    assert.ok(typeof from === 'string' && from.startsWith('#'),
      `palette start is not a colour at ${at}s: ${from}`);
    assert.ok(typeof to === 'string' && to.startsWith('#'),
      `palette end is not a colour at ${at}s: ${to}`);
  }

  // And far past the end of the table in both directions, since the phase is
  // unbounded - it advances for as long as a track plays.
  for (const offset of [-40, -7.5, 0, 7.5, 40]) {
    visual.lanes.paletteOffset = offset;
    assert.doesNotThrow(() => visual.render(score, 12),
      `a palette offset of ${offset} threw`);
  }

  console.log('palette wrap: 15/15 pass (negative phase indexes a real palette)');
}
