import assert from 'node:assert/strict';
import {
  StickMenVisual, PHRASE_BARS, SHOTS, SHOT_PLAN, planChoreography,
} from '../client/stickmen.js';

// The renderer only needs the canvas API's side effects. Recording method calls
// is unnecessary here because the regression is choreography state, but every
// drawing method remains present so the test exercises a complete render frame.
const gradient = { addColorStop() {} };
// Answers to *any* canvas method, rather than the handful the renderer happened
// to use when this was written. The explicit list missed `strokeRect`, which
// `drawProps` calls for crates - so a whole prop layer could throw in Discord
// while the suite stayed green, and only did not because the props that section
// chose were the ones already covered.
const context = new Proxy({}, {
  get: (target, key) => {
    if (key in target) return target[key];
    if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
    if (key === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set: (target, key, value) => { target[key] = value; return true; },
});
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

// A song built from section levels, with the lanes the planner reads.
const songScore = (providerId, levels, bpm = 120, character = {}) => {
  const frames = levels.length * 600;
  const fill = (value) => Array(frames).fill(value);
  return {
    source: { provider_id: providerId },
    analysis: { is_partial: false, analysed_duration_sec: levels.length * 20 },
    timing: { tempo_bpm: bpm, meter: 4, beats: [0] },
    lanes: {
      fps: 30,
      frame_count: frames,
      energy: levels.flatMap((level) => Array(600).fill(level)),
      punch: levels.flatMap((level) => Array(600).fill(level * 0.4)),
      brightness: fill(character.brightness ?? 0.42),
      bass: fill(character.bass ?? 0.3),
      mid: fill(character.mid ?? 0.3),
      treble: fill(character.treble ?? 0.2),
    },
    sections: levels.map((level, index) => ({
      index,
      start_sec: index * 20,
      end_sec: (index + 1) * 20,
      energy_mean: level,
      brightness_mean: 0.35 + level * 0.3,
    })),
  };
};

// Every joint `drawDancer` draws, captured through `project` in its fixed
// order: 26 points a figure, so a test sees exactly what is on screen rather
// than a re-derivation that could drift from it. Points 1-2 are the trunk;
// 10/12 and 14/16 an elbow and hand; 17/18/20 and 21/22/24 a hip, knee and
// foot; 25 the head.
const captureJoints = (visual) => {
  const project = visual.project.bind(visual);
  let capture = null;
  visual.project = (point, width, height) => {
    const result = project(point, width, height);
    if (capture) capture.push({ world: [point[0], point[1], point[2]], screen: result });
    return result;
  };
  const draw = visual.drawDancer.bind(visual);
  const drawn = [];
  visual.drawDancer = (...args) => {
    capture = [];
    draw(...args);
    if (capture.length === 26) drawn.push({ dancer: args[3], s: args[3].build, at: capture });
    capture = null;
  };
  return drawn;
};

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

// --- The plan ---------------------------------------------------------------
// Every track without supplied choreography is danced from `planChoreography`:
// one style from the song's tempo and character, a part in the song for each
// section from how it stands against the rest, and one routine per part so the
// second chorus is danced like the first.
{
  // One cached track's section energies, as the planner's own notes quote
  // them: intro, chorus, verse, bigger chorus, bridge, outro.
  const energies = [0.26, 0.57, 0.38, 0.68, 0.46, 0.27];
  const plan = planChoreography(songScore('plan-test', energies));
  const roles = plan.sections.map((section) => section.role);

  assert.equal(roles[0], 'intro', `the song should open as an intro, got ${roles.join(',')}`);
  assert.equal(roles.at(-1), 'outro', `the song should close as an outro, got ${roles.join(',')}`);
  const loudest = energies.indexOf(Math.max(...energies));
  assert.ok(['chorus', 'drop'].includes(roles[loudest]),
    `the loudest section should be danced as the hook, got ${roles[loudest]}`);

  // The same song plans the same dance, so every viewer sees one performance.
  assert.deepEqual(planChoreography(songScore('plan-test', energies)), plan,
    'the plan must be a property of the song');

  // A part of the song that comes back is danced the same way again.
  for (const role of new Set(roles)) {
    const routines = plan.sections.filter((section) => section.role === role)
      .map((section) => section.routine.join());
    assert.equal(new Set(routines).size, 1, `every ${role} should dance one routine`);
  }

  // Harder where the song is bigger.
  const intensities = plan.sections.map((section) => section.intensity);
  assert.ok(intensities[loudest] > intensities[0] + 0.3,
    `the loudest section should be danced harder: ${intensities.map((i) => i.toFixed(2)).join(',')}`);

  // Seeded per song. The index-driven choice this replaced opened every
  // mid-energy song with the same move; forty songs identical in every other
  // way must not dance alike.
  const openings = new Set(Array.from({ length: 40 }, (_, i) => planChoreography(
    songScore(`song-${i}`, energies),
  ).sections[2].routine.join()));
  assert.ok(openings.size >= 6, `forty songs shared ${openings.size} verse routines`);

  // Every move can be reached, or it has been authored and can never be seen.
  // `sing` is the lead's and `idle` is for near-silence; both are assigned
  // outside the plan.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const reached = new Set();
  for (let i = 0; i < 300; i++) {
    const levels = Array.from({ length: 8 }, () => 0.15 + random() * 0.6);
    const corpusScore = songScore(`corpus-${i}`, levels, 70 + random() * 100, {
      brightness: 0.3 + random() * 0.3,
      bass: 0.2 + random() * 0.25,
      mid: 0.2 + random() * 0.2,
      treble: 0.1 + random() * 0.2,
    });
    for (const section of planChoreography(corpusScore).sections) {
      for (const move of section.routine) reached.add(move);
    }
  }
  const vocabulary = [
    'step', 'reach', 'run', 'floss', 'robot', 'spin', 'wave', 'jump', 'groove', 'march',
    'clap', 'point', 'headbang', 'shimmy', 'kick', 'slide', 'moonwalk', 'twist',
    'charleston', 'runningman', 'dougie', 'gangnam', 'macarena', 'vogue', 'cabbagepatch',
    'sprinkler', 'discopoint', 'twostep', 'shuffle', 'ymca', 'salsa', 'sway',
  ];
  const never = vocabulary.filter((move) => !reached.has(move));
  assert.equal(never.length, 0, `the plan never chooses: ${never.join(', ')}`);
}

// The lead sings the verses and joins the dance when the song lifts; the chorus
// is danced in unison, and each part of the song has its own formation.
{
  const energies = [0.26, 0.57, 0.38, 0.68, 0.46, 0.27];
  const songPlan = planChoreography(songScore('lead-test', energies));
  const visual = new StickMenVisual(canvas, 4);
  const song = songScore('lead-test', energies);
  const formations = new Map();
  for (const [index, entry] of songPlan.sections.entries()) {
    for (let frame = 0; frame < 30; frame++) {
      fakeNow += 1000 / 60;
      visual.render(song, index * 20 + 4 + frame / 60);
    }
    assert.equal(visual.role, entry.role, `section ${index} should be danced as its planned part`);
    const lead = visual.dancers[0].move;
    if (['chorus', 'drop', 'build'].includes(entry.role)) {
      assert.notEqual(lead, 'sing', `the lead should dance the ${entry.role}, not sing it`);
    } else {
      assert.equal(lead, 'sing', `the lead should sing the ${entry.role}, got ${lead}`);
    }
    if (entry.role === 'chorus' || entry.role === 'drop') {
      const backing = visual.dancers.slice(1).map((dancer) => dancer.move);
      assert.ok(backing.every((move) => move === visual.move),
        `the ${entry.role} should be danced in unison, got ${backing.join(',')}`);
    }
    const seen = formations.get(entry.role) ?? new Set();
    seen.add(visual.formation);
    formations.set(entry.role, seen);
  }
  for (const [role, seen] of formations) {
    assert.equal(seen.size, 1, `every ${role} should stand in one formation`);
  }
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
// An input peaking on the beat emerged at phase 0.13 once the pose springs had
// lagged it, which is a second follow-through and the bug this pins down. It
// measures 0.83 now.
const deepest = contribution.indexOf(Math.min(...contribution)) / contribution.length;
assert.ok(deepest > 0.7,
  `preparation should bottom out before the beat, got phase ${deepest.toFixed(2)}`);

// And it has to be big enough to see. Measured at 0.0119 of hip travel, 25% of
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

// Near-silence keeps its stillness: that case is not a bug.
assert.ok(silent.moves.slice(1).every((move) => move === 'idle'),
  `near-silence should settle, got ${silent.moves.join(',')}`);

// The quiet band must not. This is the regression: no backing figure may be
// parked on `idle` while the music is still playing.
assert.ok(quietBand.moves.every((move) => move !== 'idle'),
  `a quiet section left a figure idle: ${quietBand.moves.join(',')}`);
assert.ok(quietBand.travel > silent.travel * 1.15,
  `quiet sections should move more than silent ones: ${quietBand.travel.toFixed(2)} vs ${silent.travel.toFixed(2)}`);

// And a quiet passage must still read quieter than the loud part of the same
// song, or the fix has simply replaced one wrong answer with another. Judged
// within one song, because that is how the dance is planned: a section's part
// is decided against the rest of its song, so a lone section at any level is
// that song's intro.
{
  const song = songScore('dynamics', [0.18, 0.18, 0.62, 0.62, 0.18, 0.62]);
  const visual = new StickMenVisual(canvas, 3);
  const travelIn = (section) => {
    let travel = 0;
    let previous = null;
    for (let frame = 0; frame < 600; frame++) {
      fakeNow += 1000 / 60;
      visual.render(song, section * 20 + 4 + frame / 60);
      const hand = visual.dancers[1].lag.hands[0];
      if (previous && frame > 60) {
        travel += Math.hypot(hand[0] - previous[0], hand[1] - previous[1], hand[2] - previous[2]);
      }
      previous = hand.slice();
    }
    return travel;
  };
  const quietTravel = travelIn(1);
  const loudTravel = travelIn(3);
  assert.ok(loudTravel > quietTravel * 1.5,
    `the loud part should clearly outpace the quiet one: ${loudTravel.toFixed(2)} vs ${quietTravel.toFixed(2)}`);
}

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
// therefore never hit anything together. Measured at 4.6x; 2x is a floor that
// still fails outright if the canon collapses to a constant.
const ends = (walked.spread[0] + walked.spread[7]) / 2;
const middle = (walked.spread[3] + walked.spread[4]) / 2;
assert.ok(middle > ends * 2,
  `cast should spread mid-phrase and rejoin at its edges: ends ${ends.toFixed(5)}, middle ${middle.toFixed(5)}`);

// The phrase must build. Measured at 62.8 to 73.6 degrees of arm swing range
// on this held step; 4% is a floor that still fails outright if the arc is
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
  armSwing: [-190 * DEG, 60 * DEG],
  armLift: [-60 * DEG, 125 * DEG],
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

// A drop must reach the cast, not only the camera. Everybody hits together, so
// the spread of the figures' vertical offsets should fall sharply while the
// drop accent is live.
//
// What this covers is the unison move assignment, which is nearly all of the
// effect: measured over a real track, spread went 0.0189 outside a drop to
// 0.0044 with unison alone. The canon collapse on top takes it to 0.0036 - an
// 18% further tightening that this assertion does *not* isolate, confirmed by
// removing that line and watching the test still pass. Do not read a green run
// here as proof the canon term works.
{
  const dropFrames = 3000;
  const dropScore = {
    analysis: { is_partial: false, analysed_duration_sec: 100 },
    timing: { tempo_bpm: 120, meter: 4, beats: [0] },
    lanes: {
      fps: 30,
      frame_count: dropFrames,
      // Quiet for 20s, then loud - which is what `momentFor` reads as a drop.
      energy: Array.from({ length: dropFrames }, (_, i) => (i < 600 ? 0.20 : 0.95)),
      punch: Array.from({ length: dropFrames }, (_, i) => (i < 600 ? 0.15 : 0.90)),
    },
    sections: [
      { index: 0, start_sec: 0, end_sec: 20, energy_mean: 0.20, brightness_mean: 0.4 },
      { index: 1, start_sec: 20, end_sec: 100, energy_mean: 0.95, brightness_mean: 0.6 },
    ],
    choreography: { sections: [{ routine: ['step'] }, { routine: ['jump'] }] },
  };

  const dropVisual = new StickMenVisual(canvas);
  dropVisual.setTrack({ providerId: 't', title: 't', thumbnail: null, performerCount: 5 });

  const spreadNow = () => {
    const bobs = dropVisual.dancers.map((dancer) => dancer.pose?.bob ?? 0);
    const mean = bobs.reduce((a, b) => a + b, 0) / bobs.length;
    return Math.sqrt(bobs.reduce((a, b) => a + (b - mean) ** 2, 0) / bobs.length);
  };

  const during = [];
  const after = [];
  for (let t = 0; t < 40; t += 1 / 60) {
    fakeNow += 1000 / 60;
    dropVisual.render(dropScore, t);
    if (dropVisual.dropHit > 0.25) during.push(spreadNow());
    else if (t > 30) after.push(spreadNow());
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  assert.ok(during.length > 30, `the drop was never detected (${during.length} frames)`);
  assert.ok(mean(during) < mean(after) * 0.5,
    `the cast did not converge on the drop: spread ${mean(during).toFixed(4)} during `
    + `against ${mean(after).toFixed(4)} after`);
}

// Every shot named in the plan must resolve to a real setup. `pickShot` falls
// back to `SHOTS[0]` on a miss, so renaming a shot without updating the plan
// does not throw - it silently pins that whole moment to the wide, and the only
// symptom is a track that never cuts anywhere interesting.
for (const [moment, names] of Object.entries(SHOT_PLAN)) {
  for (const name of names) {
    assert.ok(SHOTS.some((shot) => shot.name === name),
      `SHOT_PLAN.${moment} names "${name}", which is not in SHOTS`);
  }
}

// No shot may look down more steeply than 25 degrees. These figures are flat
// strokes with no volume: past about that, limbs project onto almost nothing
// and the cast reads as blobs on a floor. The overhead shot sat at 68 degrees
// and made good choreography look broken.
for (const shot of SHOTS) {
  const rise = shot.position[1] - shot.look[1];
  const run = Math.hypot(shot.position[0] - shot.look[0], shot.position[2] - shot.look[2]);
  // Drift lifts the camera above its base position, so the worst case is what
  // matters, not the nominal.
  const worst = (Math.atan2(rise + shot.drift.amp[1], run) * 180) / Math.PI;
  assert.ok(worst <= 25,
    `shot "${shot.name}" looks down ${worst.toFixed(0)} degrees at the top of its drift`);
}

// --- Arms clear of the head -----------------------------------------------------
// An arm drawn across the head merges into it, and the figure reads as having
// its arm stuck to its head - the complaint that ran through three rounds of
// fixes to an angle-space model of where a hand would be. Measured here as the
// viewer sees it: the drawn arm against the drawn head, through the square-on
// wide shot, where the pose is to blame rather than the angle.
//
// Before the moves were rewritten, 39.6% of arm-frames in that shot crossed a
// head across four cached tracks, and 35.0% over every shot; on this track it
// measures 1.30% now. Arms must still go up, so raised hands are required too:
// 14.0% of arm-frames have a hand above the head.
{
  const frames = 2400;
  const song = songScore('arms-test', [0.3, 0.55, 0.42, 0.7, 0.5, 0.35]);
  const visual = new StickMenVisual(canvas, 6);
  visual.setCount(6);
  visual.pickShot = function pickShot() {
    this.shot = SHOTS.find((shot) => shot.name === 'wide');
    this.shotTarget = null;
    this.pendingCut = true;
  };
  const drawn = captureJoints(visual);
  let arms = 0;
  let onHead = 0;
  let raised = 0;
  for (let frame = 0; frame < frames; frame++) {
    fakeNow += 1000 / 30;
    drawn.length = 0;
    visual.render(song, frame / 30);
    for (const { s, at } of drawn) {
      const figurePx = (0.56 + 0.54 + 0.52 + 0.42) * s * at[0].screen.scale;
      const headPx = Math.max(4, figurePx * 0.1);
      const limbPx = Math.max(3, figurePx * 0.105);
      const toSegment = (p, a, b) => {
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const t = Math.max(0, Math.min(1,
          ((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(1e-9, abx * abx + aby * aby)));
        return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
      };
      const head = at[25].screen;
      for (const [shoulder, elbow, hand] of [[9, 10, 12], [13, 14, 16]]) {
        arms += 1;
        const gap = Math.min(
          toSegment(head, at[shoulder].screen, at[elbow].screen),
          toSegment(head, at[elbow].screen, at[hand].screen),
        );
        if (gap < headPx + 0.25 * limbPx) onHead += 1;
        if (at[hand].world[1] > at[25].world[1]) raised += 1;
      }
    }
  }
  const rate = (onHead / arms) * 100;
  const raisedRate = (raised / arms) * 100;
  assert.ok(arms > 20000, `too few arm-frames sampled (${arms})`);
  assert.ok(rate < 4,
    `an arm crossed a head on ${rate.toFixed(2)}% of arm-frames in the wide shot`);
  assert.ok(raisedRate > 5,
    `hands went above the head on only ${raisedRate.toFixed(2)}% of arm-frames`);
}

// --- Moves as written -------------------------------------------------------------
// What a move asks for has to reach the screen, and in the right direction.
{
  // The springs follow the moves. At stiffness 16 the arms showed a tenth of a
  // clap's travel and a third of a march's knee lift, up to a beat late; here
  // a figure whose springs run to convergence every frame is the reference.
  // Measured at 90% for the clap and 99% for the march.
  const rangeOf = (name, converge) => {
    const visual = new StickMenVisual(canvas, 1);
    const dancer = visual.dancers[0];
    Object.assign(visual, { energy: 0.55, punch: 0.45, intensity: 0.6, move: name, bpm: 120 });
    dancer.move = name;
    dancer.connector = name;
    let low = [Infinity, Infinity];
    let high = [-Infinity, -Infinity];
    for (let frame = 0; frame < 480; frame++) {
      const beatCount = (frame / 60) * 2;
      for (let k = 0; k < (converge ? 30 : 1); k++) visual.updatePosition(dancer, beatCount, 4, 1 / 60);
      if (frame < 240) continue;
      const values = [dancer.pose.arms[0].lift, dancer.pose.legs[0].knee];
      low = low.map((value, i) => Math.min(value, values[i]));
      high = high.map((value, i) => Math.max(value, values[i]));
    }
    return high.map((value, i) => value - low[i]);
  };
  for (const [name, joint, label] of [['clap', 0, 'arm lift'], ['march', 1, 'knee']]) {
    const drawnRange = rangeOf(name, false)[joint];
    const targetRange = rangeOf(name, true)[joint];
    assert.ok(drawnRange > targetRange * 0.8,
      `${name} drew ${((drawnRange / targetRange) * 100).toFixed(0)}% of its ${label} travel`);
  }

  // Legs as the tables write them: a march lifts its knee to the hip, a kick
  // goes forward, and a Charleston flicks its heel back. Forward is toward the
  // audience, which the figures face. The conversion that drew them ran leg
  // swing backwards, so every one of these went the other way; measured now,
  // the march's knee rises 0.25 of a build above the hip and the kick reaches
  // 0.83 in front of it.
  const legsOf = (name) => {
    const visual = new StickMenVisual(canvas, 1);
    const dancer = visual.dancers[0];
    const drawn = captureJoints(visual);
    const frames = [];
    for (let frame = 0; frame < 480; frame++) {
      fakeNow += 1000 / 60;
      drawn.length = 0;
      visual.render(score, 60 + frame / 60);
      dancer.move = name;
      dancer.connector = name;
      dancer.transitionBeats = 0;
      if (frame > 120 && drawn.length) frames.push(drawn[0]);
    }
    return frames;
  };
  const facingOf = ({ dancer }) => [Math.sin(dancer.facing), Math.cos(dancer.facing)];
  const ahead = (frame, point) => {
    const [fx, fz] = facingOf(frame);
    const hip = frame.at[1].world;
    return ((point[0] - hip[0]) * fx + (point[2] - hip[2]) * fz) / frame.s;
  };
  const march = legsOf('march');
  const highestKnee = Math.max(...march.map((frame) => Math.max(
    frame.at[18].world[1] - frame.at[17].world[1], frame.at[22].world[1] - frame.at[21].world[1],
  ) / frame.s));
  assert.ok(highestKnee > -0.1, `a march should lift a knee to the hip, got ${highestKnee.toFixed(2)}`);
  const kick = legsOf('kick');
  const furthestKick = Math.max(...kick.map((frame) => Math.max(
    ahead(frame, frame.at[20].world), ahead(frame, frame.at[24].world),
  )));
  assert.ok(furthestKick > 0.5, `a kick should go forward, reached ${furthestKick.toFixed(2)}`);
  const charleston = legsOf('charleston');
  const furthestFlick = Math.min(...charleston.map((frame) => Math.min(
    ahead(frame, frame.at[20].world), ahead(frame, frame.at[24].world),
  )));
  assert.ok(furthestFlick < -0.25, `a Charleston should flick back, reached ${furthestFlick.toFixed(2)}`);

  // A clap closes in front of the chest, facing the room.
  const clap = legsOf('clap');
  const handsAhead = clap.map((frame) => (ahead(frame, frame.at[12].world)
    + ahead(frame, frame.at[16].world)) / 2);
  const inFront = handsAhead.filter((value) => value > 0.2).length / handsAhead.length;
  assert.ok(inFront > 0.9, `a clap's hands should be in front of the body, ${(inFront * 100).toFixed(0)}% were`);

  // Feet stand on the floor. The hips sat too high for a leg to reach it and
  // every figure hovered a median 0.170 of a build above its own shadow.
  const lowest = [...march, ...kick, ...clap].map((frame) => Math.min(
    frame.at[20].world[1], frame.at[24].world[1],
  ) / frame.s).sort((a, b) => a - b);
  const medianLowest = lowest[Math.floor(lowest.length / 2)];
  assert.ok(medianLowest < 0.03, `feet hover ${medianLowest.toFixed(3)} above the floor`);
  assert.ok(lowest[0] > -0.005, `a foot went through the floor, to ${lowest[0].toFixed(3)}`);
}

// --- Limbs stay out of bodies ---------------------------------------------------
// Measured on the joints `drawDancer` actually draws, captured through
// `project`: every drawn point passes through it, in a fixed order, so this
// sees exactly what is on screen rather than a re-derivation that could drift
// from it. The same method as the audit behind HAND_TORSO_CLEARANCE and
// MIN_LIMB_GAP, run here on a synthetic track so the suite needs no cached
// audio. Numbers for this track are in the assertions.
{
  const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const gap = (p1, q1, p2, q2) => {
    // Closest approach of two segments, sampled finely enough for a test.
    let best = Infinity;
    for (let i = 0; i <= 12; i++) {
      const a = [p1[0] + (q1[0] - p1[0]) * i / 12, p1[1] + (q1[1] - p1[1]) * i / 12,
        p1[2] + (q1[2] - p1[2]) * i / 12];
      const d = minus(q2, p2);
      const t = Math.max(0, Math.min(1, dot(minus(a, p2), d) / Math.max(1e-12, dot(d, d))));
      const b = [p2[0] + d[0] * t, p2[1] + d[1] * t, p2[2] + d[2] * t];
      best = Math.min(best, Math.hypot(...minus(a, b)));
    }
    return best;
  };

  // drawDancer's own proportions, per unit of build.
  const LIMB = (0.56 + 0.54 + 0.52 + 0.42) * 0.105;
  const TORSO_R = (LIMB * 2.10) / 2;
  const LIMB_R = LIMB / 2;

  const frames = 1800;
  const limbScore = {
    analysis: { is_partial: false, analysed_duration_sec: 60 },
    timing: { tempo_bpm: 124, meter: 4, beats: [0] },
    lanes: {
      fps: 30,
      frame_count: frames,
      energy: Array.from({ length: frames }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i / 240))),
      punch: Array.from({ length: frames }, (_, i) => 0.25 + 0.5 * Math.abs(Math.sin(i / 110))),
    },
    sections: Array.from({ length: 4 }, (_, i) => ({
      index: i,
      start_sec: i * 15,
      end_sec: (i + 1) * 15,
      energy_mean: 0.3 + i * 0.15,
      brightness_mean: 0.3 + i * 0.12,
    })),
    choreography: { sections: Array.from({ length: 4 }, () => ({ routine: null })) },
  };

  const visual = new StickMenVisual(canvas, 6);
  visual.setCount(6);
  const drawn = captureJoints(visual);

  let hands = 0;
  let through = 0;
  let figures = 0;
  let crossed = 0;
  const stance = [];
  for (let frame = 0; frame < frames; frame++) {
    fakeNow += 1000 / 30;
    drawn.length = 0;
    visual.render(limbScore, frame / 30);
    for (const { s, at: points } of drawn) {
      const at = points.map((point) => point.world);
      figures += 1;
      // Points 1-2 are the trunk; 10/12 and 14/16 an elbow and hand; 18/20 and
      // 22/24 a knee and foot - drawDancer's bone order.
      for (const [elbow, hand] of [[at[10], at[12]], [at[14], at[16]]]) {
        hands += 1;
        if (gap(elbow, hand, at[1], at[2]) < TORSO_R * s * 0.8) through += 1;
      }
      if (gap(at[18], at[20], at[22], at[24]) < LIMB_R * s) crossed += 1;
      stance.push(Math.hypot(at[20][0] - at[24][0], at[20][2] - at[24][2]) / s);
    }
  }
  stance.sort((a, b) => a - b);
  const throughRate = (through / hands) * 100;
  const crossedRate = (crossed / figures) * 100;
  const medianStance = stance[Math.floor(stance.length / 2)];

  // 9.71% before the clearance, 2.71% after, 0.28% once the conversion
  // stopped folding the second arm across the chest.
  assert.ok(throughRate < 2,
    `a forearm passed through the torso on ${throughRate.toFixed(2)}% of hand-frames`);
  // 17.11% before the separation, 1.96% after, 0.01% once leg lift spread
  // the stance as the tables meant it to.
  assert.ok(crossedRate < 2,
    `shins passed through each other on ${crossedRate.toFixed(2)}% of dancer-frames`);
  // 0.447 since the tables were rewritten: feet a little outside the
  // shoulders. A stance past about half a build reads as splayed - an earlier
  // leg separation pushed it to 0.521 and the figures limped - and one under
  // the hips' own spacing, 0.248, reads as feet standing on each other.
  assert.ok(medianStance < 0.5,
    `the median stance is ${medianStance.toFixed(3)}, splayed past a dancer's natural width`);
  assert.ok(medianStance > 0.3,
    `the median stance is ${medianStance.toFixed(3)}, narrower than the hips`);
}

performance.now = realNow;
console.log('StickMenVisual: 74/74 pass (the plan, the lead, planting, anticipation, quiet, phrase, canon, 15 dances, staging, drops, arms clear of the head, moves as written, limbs out of bodies)');
