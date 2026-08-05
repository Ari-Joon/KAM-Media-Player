import assert from 'node:assert/strict';
import {
  BarsVisual, ScopeVisual, TunnelVisual, ColoursVisual,
  ParticlesVisual, KaleidoscopeVisual, VinylVisual, NoneVisual,
} from '../client/visuals.js';
import {
  GalaxyVisual, TerrainVisual, RainVisual, FirefliesVisual, RibbonsVisual,
  MosaicVisual, AuroraVisual, PulseVisual,
} from '../client/visuals2.js';
import { PainterVisual } from '../client/painter.js';
import { StickMenVisual } from '../client/stickmen.js';

// Every 2D visualisation in the menu. The WebGL one is excluded: it needs a real
// GL context, and `main.js` already drops it when one is unavailable.
const VISUALS = {
  BarsVisual, ScopeVisual, TunnelVisual, ColoursVisual,
  ParticlesVisual, KaleidoscopeVisual, VinylVisual, NoneVisual,
  GalaxyVisual, TerrainVisual, RainVisual, FirefliesVisual, RibbonsVisual,
  MosaicVisual, AuroraVisual, PulseVisual,
  PainterVisual,
  // Added after two wall-clock reads were found in it: the camera drift and the
  // whole environment layer ran on performance.now(), so the scene kept moving
  // while playback was paused and sat at a different point for every viewer.
  // It was the only 2D visualisation this test did not cover, which is exactly
  // why that survived.
  StickMenVisual,
};

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
    spectrum: lane((i) => Array.from({ length: 16 },
      (_, b) => 0.2 + 0.5 * Math.abs(Math.sin((i + b * 9) / 21)))),
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

for (const [name, Visual] of Object.entries(VISUALS)) {
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
  const a = new Visual(canvasWith(contextA));
  performance.now = () => clockB;
  Math.random = seeded(1);
  const b = new Visual(canvasWith(contextB));
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
for (const [name, Visual] of Object.entries(VISUALS)) {
  const visual = new Visual(canvasWith(recordingContext()));
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
