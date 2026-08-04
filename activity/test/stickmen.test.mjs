import assert from 'node:assert/strict';
import { StickMenVisual, PHRASE_BARS, moveForSection } from '../client/stickmen.js';

// The renderer only needs the canvas API's side effects. Recording method calls
// is unnecessary here because the regression is choreography state, but every
// drawing method remains present so the test exercises a complete render frame.
const gradient = { addColorStop() {} };
const context = {
  arc() {}, beginPath() {}, closePath() {}, ellipse() {}, fill() {}, fillRect() {},
  lineTo() {}, moveTo() {}, restore() {}, save() {}, stroke() {},
  createLinearGradient: () => gradient,
  createRadialGradient: () => gradient,
};
const canvas = {
  clientWidth: 960,
  clientHeight: 540,
  width: 960,
  height: 540,
  getContext: () => context,
};

globalThis.window = { devicePixelRatio: 1 };

// Springs integrate seconds, so the wall clock must advance deliberately. A
// frozen clock only tests zero-delta poses; using playback microseconds as the
// clock would hide the original timing bug by making every spring explode.
let fakeNow = 0;
const realNow = performance.now.bind(performance);
performance.now = () => fakeNow;

const frameCount = 2400;
const score = {
  analysis: { is_partial: false, analysed_duration_sec: 80 },
  timing: { tempo_bpm: 120, meter: 4, beats: [0] },
  lanes: {
    fps: 30,
    frame_count: frameCount,
    energy: Array(frameCount).fill(0.5),
    punch: Array(frameCount).fill(0.4),
  },
  sections: [{
    index: 0,
    start_sec: 0,
    end_sec: 80,
    energy_mean: 0.5,
    brightness_mean: 0.5,
  }],
  choreography: {
    sections: [{ routine: ['step', 'clap', 'robot'] }],
  },
};

const visual = new StickMenVisual(canvas, 2);
const renderAt = (playbackSec) => {
  fakeNow += 1000 / 60;
  visual.render(score, playbackSec);
};

renderAt(0);
assert.equal(visual.section, score.sections[0], 'section state should be retained');
assert.equal(visual.move, 'step', 'first phrase should use the routine opening');
assert.equal(visual.phraseIndex, 0);

// Phrase length is derived rather than hard-coded, so this test keeps passing if
// PHRASE_BARS changes again - the behaviour under test is that a phrase holds
// its move for exactly one phrase and then advances, not that it lasts a
// particular number of seconds.
// At 120 BPM in 4/4, one bar is two seconds.
const phraseSeconds = PHRASE_BARS * 4 * (60 / 120);

renderAt(phraseSeconds - 0.01);
assert.equal(visual.move, 'step', 'move changed before the phrase boundary');
renderAt(phraseSeconds);
assert.equal(visual.move, 'clap', 'second phrase did not advance the routine');
assert.equal(visual.phraseIndex, 1);
renderAt(phraseSeconds * 2);
assert.equal(visual.move, 'robot', 'third phrase did not advance the routine');
renderAt(phraseSeconds * 3);
assert.equal(visual.move, 'step', 'routine should loop after its last entry');

// Seeking is based on score position, not accumulated render calls.
renderAt(phraseSeconds);
assert.equal(visual.move, 'clap', 'backward seek did not restore its phrase');

// Artist metadata may replace the cast mid-phrase. The next frame must assign
// differentiated phrase roles to the new dancers instead of waiting four bars.
visual.setCount(3);
renderAt(8.5);
assert.ok(visual.dancers.every((dancer) => typeof dancer.move === 'string'),
  'new cast did not receive phrase roles');
assert.ok(visual.dancers.every((dancer) => Math.abs(dancer.beatOffset) < 0.03),
  'cast timing drifted far enough to stop reading as coordinated choreography');

const jumper = visual.dancers[0];
jumper.move = 'jump';
for (let frame = 0; frame < 120; frame++) {
  visual.updatePosition(jumper, 2, 4, 1 / 60);
}
assert.ok(jumper.pose.bob > 0.15, 'airborne jump phase did not raise the hips');
for (let frame = 0; frame < 120; frame++) {
  visual.updatePosition(jumper, 0.4, 4, 1 / 60);
}
assert.ok(jumper.pose.bob < -0.05, 'jump anticipation did not lower into a crouch');

// --- Camera basis ----------------------------------------------------------
// The look-at basis was hoisted out of project() so it is built once per frame
// rather than once per projection. That is only safe while the basis genuinely
// tracks the camera, so recompute it here independently and compare. A missing
// refreshBasis() call would leave the whole scene projected through a stale eye
// while every individual projection still looked perfectly well-formed.
const basisFor = (camera) => {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const unit = (a) => {
    const length = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / length, a[1] / length, a[2] / length];
  };
  const forward = unit(sub(camera.look, camera.position));
  const right = unit(cross(forward, [0, 1, 0]));
  return { forward, right, up: cross(right, forward) };
};

const basisMatches = (visual_) => {
  const expected = basisFor(visual_.camera);
  return ['forward', 'right', 'up'].every((axis) => expected[axis].every(
    (value, i) => Math.abs(value - visual_.basis[axis][i]) < 1e-12,
  ));
};

assert.ok(basisMatches(visual), 'basis is stale immediately after a render');

// The camera eases toward its shot every frame, so a few frames on must still
// agree - this is what catches a refreshBasis() that runs only at construction.
const beforeMove = visual.camera.position.slice();
for (let frame = 0; frame < 30; frame++) renderAt(20 + frame / 60);
assert.ok(
  beforeMove.some((value, i) => Math.abs(value - visual.camera.position[i]) > 1e-6),
  'camera did not move, so the staleness check proves nothing',
);
assert.ok(basisMatches(visual), 'basis did not follow the camera');

// Projection must stay finite and screen-shaped for a point at the origin.
const centre = visual.project([0, 0, 0], 960, 540);
assert.ok(Number.isFinite(centre.x) && Number.isFinite(centre.y), 'projection is not finite');
assert.ok(centre.depth >= 0.45, 'depth clamp did not hold');
assert.ok(centre.scale > 0, 'projection scale must be positive');

// --- Theme routines --------------------------------------------------------
// THEME_ROUTINES named 'sway', which is a pose field rather than a move, so
// MOVES['sway'] was undefined and the next frame threw - taking Stick Men off
// the menu for the rest of the session via the render guard in main.js. Every
// theme routine must now resolve to real moves.
const themed = new StickMenVisual(canvas, 2);
for (const [theme, arousal] of [['romance', 0.1], ['romance', 0.9],
  ['melancholy', 0.1], ['melancholy', 0.9]]) {
  const themedScore = {
    ...score,
    choreography: undefined,
    lyrics: { sections: [{ valence: 0, arousal, density: 1, theme, keywords: [] }] },
  };
  themed.sectionIndex = -1;
  assert.doesNotThrow(() => {
    for (let frame = 0; frame < 8; frame++) {
      fakeNow += 1000 / 60;
      themed.render(themedScore, frame * phraseSeconds);
    }
  }, `theme "${theme}" at arousal ${arousal} threw during render`);
  assert.ok(themed.dancers.every((dancer) => typeof dancer.move === 'string'),
    `theme "${theme}" left a dancer without a move`);
}

// --- Foot planting ---------------------------------------------------------
// A foot carrying weight must hold its world position while the body moves over
// it. Poses describe joint angles, so without this the feet go wherever the hips
// send them and the figures skate.
//
// The renderer's final foot position is what `lag.feet[side]` holds, so drift is
// measured there rather than from anything the test computes itself - that way a
// pin that works in the solver but is then undone downstream still fails.
const planting = new StickMenVisual(canvas, 2);
for (let frame = 0; frame < 180; frame++) {
  fakeNow += 1000 / 60;
  planting.render(score, frame / 60);
}

const plantedDrift = [];
const freeDrift = [];
let steps = 0;
const previous = planting.dancers.map(() => [null, null]);
const previousStrength = planting.dancers.map(() => [0, 0]);
const previousHeld = planting.dancers.map(() => [false, false]);

for (let frame = 180; frame < 180 + 1200; frame++) {
  fakeNow += 1000 / 60;
  planting.render(score, frame / 60);
  planting.dancers.forEach((dancer, index) => {
    for (const side of [0, 1]) {
      const foot = dancer.lag.feet[side];
      const { strength, held } = dancer.plant[side];
      if (previousHeld[index][side] && !held) steps++;
      const was = previous[index][side];
      if (was) {
        const moved = Math.hypot(foot[0] - was[0], foot[1] - was[1], foot[2] - was[2]);
        if (strength > 0.9 && previousStrength[index][side] > 0.9) plantedDrift.push(moved);
        else if (strength < 0.1) freeDrift.push(moved);
      }
      previous[index][side] = foot.slice();
      previousStrength[index][side] = strength;
      previousHeld[index][side] = held;
    }
  });
}

assert.ok(steps > 20, `figures should step regularly, saw ${steps} in 20s`);
assert.ok(plantedDrift.length > 200, 'not enough planted frames to judge');

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const plantedMedian = median(plantedDrift);
const freeMedian = median(freeDrift);

// Measured at roughly 12-21x depending on cast size. Ten is a floor that leaves
// room for the poses to change without becoming a tripwire, while still failing
// outright if planting stops working.
assert.ok(plantedMedian * 10 < freeMedian,
  `planted feet should barely move: ${plantedMedian.toFixed(5)} vs free ${freeMedian.toFixed(5)}`);

// No single frame may teleport a planted foot. This is the one that caught the
// real bug: suppressing lag by *lowering* its rate froze the foot at a stale
// position and then snapped it back, spiking to 0.723 world units in one frame
// while the median stayed a healthy 0.0003.
const worst = Math.max(...plantedDrift);
assert.ok(worst < 0.1, `a planted foot jumped ${worst.toFixed(4)} in one frame`);

// --- Anticipation ----------------------------------------------------------
// Accents must be prepared for, not merely reacted to: the hips gather in the
// last part of a beat so the figure meets the accent instead of being knocked
// into motion by it.
//
// This cannot be read off the bob curve directly, because the existing on-beat
// bounce is five times larger and troughs mid-beat, so the preparation shows as
// a plateau rather than a local minimum. Instead it is isolated the way it was
// originally measured: the preparation is scaled by punch, so two runs that
// differ only in the punch lane differ only by the preparation.
//
// `groove` is pinned deliberately. It is one of the moves that does not take
// punch as an argument, so with it held the punch lane cannot reach `bob` by any
// route except the term under test.
const bobProfile = (punch) => {
  const bins = 24;
  const total = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);
  const lanes = { ...score.lanes, punch: Array(frameCount).fill(punch) };
  const punchScore = { ...score, lanes };

  const visual = new StickMenVisual(canvas, 1);
  for (let frame = 0; frame < 600; frame++) {
    fakeNow += 1000 / 60;
    visual.render(punchScore, frame / 60);
    visual.dancers[0].move = 'groove';
  }
  for (let frame = 600; frame < 600 + 2400; frame++) {
    fakeNow += 1000 / 60;
    const seconds = frame / 60;
    visual.render(punchScore, seconds);
    visual.dancers[0].move = 'groove';
    // 120 BPM, so a beat is half a second.
    const bin = Math.floor(((seconds / 0.5) % 1) * bins);
    total[bin] += visual.dancers[0].pose.bob;
    counts[bin] += 1;
  }
  return total.map((value, i) => value / counts[i]);
};

const quiet = bobProfile(0);
const punchy = bobProfile(1);
const contribution = punchy.map((value, i) => value - quiet[i]);

// Negative throughout: preparation only ever lowers the hips.
assert.ok(contribution.every((value) => value <= 1e-9),
  'preparation should never raise the hips');

// The deepest point must fall in the run-up to the beat rather than after it.
// An input peaking on the beat emerges at phase 0.13 once the pose springs have
// lagged it, which is a second follow-through and the bug this pins down.
const deepest = contribution.indexOf(Math.min(...contribution)) / contribution.length;
assert.ok(deepest > 0.7,
  `preparation should bottom out before the beat, got phase ${deepest.toFixed(2)}`);

// And it has to be big enough to see. Measured at 0.0096 of hip travel, 27% of
// the existing beat bounce; 0.003 is a floor well clear of numerical noise.
const depth = Math.abs(Math.min(...contribution));
assert.ok(depth > 0.003, `preparation is too small to read: ${depth.toFixed(5)}`);

// --- Quiet sections --------------------------------------------------------
// A section that is quiet but still playing must keep moving. There used to be
// one cutoff at energy 0.16 below which everyone but the lead was put on `idle`,
// so 19 of the 431 sections in the cached corpus froze despite the music
// continuing. Stillness is now reserved for genuine near-silence.
const movesAtEnergy = (energy) => {
  const lanes = {
    ...score.lanes,
    energy: Array(frameCount).fill(energy),
    punch: Array(frameCount).fill(energy * 0.8),
  };
  const quietScore = {
    ...score,
    lanes,
    choreography: undefined,
    sections: [{ ...score.sections[0], energy_mean: energy, brightness_mean: 0.4 }],
  };
  const visual = new StickMenVisual(canvas, 3);
  for (let frame = 0; frame < 240; frame++) {
    fakeNow += 1000 / 60;
    visual.render(quietScore, frame / 60);
  }

  // Total limb travel is the thing that actually reads as "moving", so measure
  // that rather than trusting the move name alone.
  let travel = 0;
  let previous = null;
  for (let frame = 240; frame < 240 + 600; frame++) {
    fakeNow += 1000 / 60;
    visual.render(quietScore, frame / 60);
    const hand = visual.dancers[1].lag.hands[0];
    if (previous) {
      travel += Math.hypot(
        hand[0] - previous[0], hand[1] - previous[1], hand[2] - previous[2],
      );
    }
    previous = hand.slice();
  }
  return { moves: visual.dancers.map((dancer) => dancer.move), travel };
};

const silent = movesAtEnergy(0.02);
const quietBand = movesAtEnergy(0.12);
const loud = movesAtEnergy(0.45);

// Near-silence keeps its stillness: that case is not a bug.
assert.ok(silent.moves.slice(1).every((move) => move === 'idle'),
  `near-silence should settle, got ${silent.moves.join(',')}`);

// The quiet band must not. This is the regression: no backing figure may be
// parked on `idle` while the music is still playing.
assert.ok(quietBand.moves.every((move) => move !== 'idle'),
  `a quiet section left a figure idle: ${quietBand.moves.join(',')}`);
assert.ok(quietBand.travel > silent.travel * 1.15,
  `quiet sections should move more than silent ones: ${quietBand.travel.toFixed(2)} vs ${silent.travel.toFixed(2)}`);

// And it must still read as quieter than a loud one, or the fix has simply
// replaced one wrong answer with another.
assert.ok(loud.travel > quietBand.travel * 1.5,
  `loud sections should clearly outpace quiet ones: ${loud.travel.toFixed(2)} vs ${quietBand.travel.toFixed(2)}`);

// `sway` must be reachable from every table that can name it, or the move that
// exists to fix this dead-ends back into the general vocabulary.
const swayVisual = new StickMenVisual(canvas, 2);
swayVisual.mood = { theme: 'melancholy', arousal: 0.1, valence: -0.5, density: 0 };
const melancholy = swayVisual.routineFor(score.sections[0]);
assert.ok(melancholy.includes('sway'),
  `the melancholy routine should now keep its sway: ${melancholy.join(',')}`);

// --- Phrase structure ------------------------------------------------------
// A routine needs a shape across its phrase, not just a repeating bar. These
// walk a long single-section score and bin what happens by position within the
// phrase.
//
// Every dancer is forced onto one move each frame, because otherwise the cast
// runs different moves and any measurement is dominated by that rather than by
// the phrase behaviour under test.
const phraseSeconds2 = PHRASE_BARS * 4 * (60 / 120);
const longScore = {
  ...score,
  choreography: undefined,
  analysis: { is_partial: false, analysed_duration_sec: 200 },
  sections: [{ ...score.sections[0], end_sec: 200 }],
};

const walkPhrase = ({ forceMove }) => {
  const visual = new StickMenVisual(canvas, 4);
  const bins = 8;
  const travel = new Array(bins).fill(0);
  const spread = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);
  const low = new Array(bins).fill(Infinity);
  const high = new Array(bins).fill(-Infinity);
  const onFloor = new Array(4).fill(null);
  const pin = () => visual.dancers.forEach((dancer) => {
    if (!forceMove) return;
    dancer.move = forceMove;
    dancer.connector = forceMove;
  });

  for (let frame = 0; frame < 300; frame++) {
    fakeNow += 1000 / 60;
    visual.render(longScore, frame / 60);
    pin();
  }

  let previous = visual.dancers.map((dancer) => dancer.lag.hands[0]?.slice() ?? null);
  for (let frame = 300; frame < 300 + 3600; frame++) {
    fakeNow += 1000 / 60;
    const seconds = frame / 60;
    visual.render(longScore, seconds);
    pin();
    const bin = Math.floor(((seconds % phraseSeconds2) / phraseSeconds2) * bins);
    visual.dancers.forEach((dancer, index) => {
      previous[index] = dancer.lag.hands[0].slice();
    });

    // Angular range, not hand travel. The hand's distance from the body is
    // bounded by arm length no matter how hard a pose is amplified, so a
    // position-based measure cannot see the arc at all - measured flat within
    // noise while the underlying amplification was varying by half again.
    const swing = visual.dancers[1].pose.arms[0].swing;
    low[bin] = Math.min(low[bin], swing);
    high[bin] = Math.max(high[bin], swing);

    // Floor speed, not the pose's travel field: the settle scales the applied
    // displacement and strengthens the pull back to the formation slot, so only
    // the position actually reached shows it.
    let floorSpeed = 0;
    visual.dancers.forEach((dancer, index) => {
      const was = onFloor[index];
      if (was) floorSpeed += Math.hypot(dancer.x - was.x, dancer.z - was.z);
      onFloor[index] = { x: dancer.x, z: dancer.z };
    });

    const bobs = visual.dancers.map((dancer) => dancer.pose.bob);
    travel[bin] += floorSpeed;
    spread[bin] += Math.max(...bobs) - Math.min(...bobs);
    counts[bin] += 1;
  }
  return {
    travel: travel.map((value, i) => value / counts[i]),
    spread: spread.map((value, i) => value / counts[i]),
    range: low.map((value, i) => high[i] - value),
    visual,
  };
};

// 'step' travels across the floor, which is what the settle acts on; it also
// amplifies like every other move, so the arc and canon are visible in it too.
// `step` travels across the floor, which is what the settle acts on, and it
// amplifies like every other move so the arc and canon are visible in it too.
const walked = walkPhrase({ forceMove: 'step' });

// Unison at the phrase boundaries, canon in between. Every figure used to carry
// a fixed offset, so the cast was permanently and identically out of step and
// therefore never hit anything together. Measured at 4.4x; 2x is a floor that
// still fails outright if the canon collapses to a constant.
const ends = (walked.spread[0] + walked.spread[7]) / 2;
const middle = (walked.spread[3] + walked.spread[4]) / 2;
assert.ok(middle > ends * 2,
  `cast should spread mid-phrase and rejoin at its edges: ends ${ends.toFixed(5)}, middle ${middle.toFixed(5)}`);

// The phrase must build. Measured at 117.3 to 128.2 degrees of arm swing range
// on a held groove; 4% is a floor that still fails outright if the arc is
// removed or flattened, without being a tripwire on pose tweaks.
const peakRange = Math.max(...walked.range);
const floorRange = Math.min(...walked.range);
assert.ok(peakRange > floorRange * 1.04,
  `phrase should grow, range ${floorRange.toFixed(3)} to ${peakRange.toFixed(3)} rad`);

// And its weight belongs in the second half, where a musical phrase puts it.
// A peak at the very start means the arc is inverted.
const peakBin = walked.range.indexOf(peakRange);
assert.ok(peakBin >= 4, `phrase should build rather than front-load, peak at bin ${peakBin}`);

// The final bar resolves: travel falls away so the figure arrives on its mark
// instead of being caught mid-stride when the next phrase starts.
assert.ok(walked.travel[7] < Math.max(...walked.travel) * 0.9,
  `phrases should settle, final bin ${walked.travel[7].toFixed(4)}`);

// --- Connectors ------------------------------------------------------------
// A move change was a pure cross-fade: the springs dissolved one pose into the
// next and nothing actually happened between them. A phrase now opens with a
// shared connecting move so the figures step out of one and into the next.
const connecting = new StickMenVisual(canvas, 3);
for (let frame = 0; frame < 60; frame++) {
  fakeNow += 1000 / 60;
  connecting.render(longScore, frame / 60);
}
// The opening phrase must not run a connector: there is nothing to connect from.
assert.ok(connecting.dancers.every((dancer) => dancer.transitionBeats <= 0),
  'the first phrase should start on its own move, not a connector');

// Step over the first phrase boundary.
fakeNow += 1000 / 60;
connecting.render(longScore, phraseSeconds2 + 0.01);
assert.ok(connecting.dancers.every((dancer) => dancer.transitionBeats > 0),
  'crossing a phrase boundary should arm a connector');
const connectors = new Set(connecting.dancers.map((dancer) => dancer.connector));
assert.equal(connectors.size, 1,
  `the cast should connect through one shared move, saw ${[...connectors].join(',')}`);
// Connectors must stay neutral: a connecting move that plants a pose competes
// with the move it is introducing.
const NEUTRAL_CONNECTORS = new Set(['step', 'groove', 'slide', 'sway']);
assert.ok(NEUTRAL_CONNECTORS.has([...connectors][0]),
  `connector ${[...connectors][0]} is not one of the neutral connecting moves`);

// And it must expire rather than running for the whole phrase.
for (let frame = 0; frame < 240; frame++) {
  fakeNow += 1000 / 60;
  connecting.render(longScore, phraseSeconds2 + 0.02 + frame / 60);
}
assert.ok(connecting.dancers.every((dancer) => dancer.transitionBeats <= 0),
  'the connector should hand over to the phrase move');

// --- Named dances ----------------------------------------------------------
// Fifteen real dances were added to the vocabulary. Each has to survive being
// danced, and - more easily broken - each has to stay inside the joint limits.
// A pose table written a little too enthusiastically pins joints against their
// clamps, and a figure with several joints pinned collapses into a single black
// silhouette with no readable limbs at all. That is not hypothetical: it is what
// the whole cast was doing before the amplification was rebalanced.
const NAMED_DANCES = [
  'moonwalk', 'twist', 'charleston', 'runningman', 'dougie', 'gangnam',
  'macarena', 'vogue', 'cabbagepatch', 'sprinkler', 'discopoint', 'twostep',
  'shuffle', 'ymca', 'salsa',
];

const DEG = Math.PI / 180;
const JOINT_LIMITS = {
  armSwing: [-170 * DEG, 45 * DEG],
  armLift: [-105 * DEG, 105 * DEG],
  elbow: [5 * DEG, 112 * DEG],
  legSwing: [-75 * DEG, 95 * DEG],
  legLift: [-45 * DEG, 45 * DEG],
  knee: [0, 135 * DEG],
};

const danced = new StickMenVisual(canvas, 3);
for (const name of NAMED_DANCES) {
  let pinned = 0;
  let checkedJoints = 0;

  assert.doesNotThrow(() => {
    for (let frame = 0; frame < 180; frame++) {
      fakeNow += 1000 / 60;
      danced.render(score, 40 + frame / 60);
      // Reasserted each frame, because a phrase boundary would otherwise hand
      // the cast back to the routine partway through.
      for (const dancer of danced.dancers) {
        dancer.move = name;
        dancer.connector = name;
      }
    }
  }, `dance "${name}" threw while being performed`);

  for (const dancer of danced.dancers) {
    for (const side of [0, 1]) {
      const joints = [
        ['armSwing', dancer.pose.arms[side].swing],
        ['armLift', dancer.pose.arms[side].lift],
        ['elbow', dancer.pose.arms[side].elbow],
        ['legSwing', dancer.pose.legs[side].swing],
        ['legLift', dancer.pose.legs[side].lift],
        ['knee', dancer.pose.legs[side].knee],
      ];
      for (const [joint, value] of joints) {
        assert.ok(Number.isFinite(value), `dance "${name}" produced a non-finite ${joint}`);
        const [low, high] = JOINT_LIMITS[joint];
        checkedJoints += 1;
        if (value <= low + 0.02 || value >= high - 0.02) pinned += 1;
      }
    }
    assert.ok(Number.isFinite(dancer.pose.bob), `dance "${name}" produced a non-finite bob`);
  }

  // Nothing should be resting on a limit. The soft knee makes it very hard to
  // reach one, so any hit here means a pose table is driving far past what the
  // body can do rather than merely being energetic.
  assert.equal(pinned, 0,
    `dance "${name}" left ${pinned}/${checkedJoints} joints pinned against a limit`);
}

// Every named dance must be reachable from the selection tables, or it has been
// authored and can never be seen.
const reachable = new Set();
for (let index = 0; index < 40; index += 1) {
  for (const energy of [0.10, 0.30, 0.45, 0.60, 0.80]) {
    reachable.add(moveForSection({
      index, energy_mean: energy, brightness_mean: 0.2 + (index % 5) * 0.15,
    }));
  }
}
const unreachable = NAMED_DANCES.filter((name) => !reachable.has(name));
assert.equal(unreachable.length, 0,
  `these dances can never be chosen: ${unreachable.join(', ')}`);

performance.now = realNow;
console.log('StickMenVisual: 56/56 pass (planting, anticipation, quiet, phrase, canon, 15 dances)');
