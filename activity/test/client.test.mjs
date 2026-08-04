import assert from 'node:assert/strict';
import { PlaybackClock } from '../client/clock.js';
import { beatPulse, resolveScoreTime } from '../client/visualizer.js';

// --- PlaybackClock ---------------------------------------------------------
// Drive the clock with a controllable fake wall clock.
let fakeNow = 0;
const realNow = performance.now.bind(performance);
performance.now = () => fakeNow;

let reported = 0;
const clock = new PlaybackClock({ readPosition: () => reported });
clock.lastTickMs = 0; clock.lastPollMs = 0;
clock.play();

// 1. Advances with wall time while the player reports nothing useful.
for (let i = 0; i < 10; i++) { fakeNow += 16; clock.tick(); }   // 160ms, no poll yet
assert.ok(Math.abs(clock.position - 0.16) < 1e-9, `advanced ${clock.position}`);

// 2. Large drift snaps (a seek).
reported = 42.0; fakeNow += 300;
clock.tick();
assert.ok(Math.abs(clock.position - 42.0) < 1e-9, `snap gave ${clock.position}`);

// 3. Small drift eases rather than jumping.
reported = 42.4; fakeNow += 300; clock.tick();      // local ~42.3, drift 0.1 < 0.25
const eased = clock.position;
assert.ok(eased > 42.29 && eased < 42.35, `ease gave ${eased}`);

// 4. Paused clock does not advance, but still converges on the player (so a
// scrub while paused is picked up).
clock.pause();
reported = 41.0;
for (let i = 0; i < 200; i++) { fakeNow += 16; clock.tick(); }
assert.ok(Math.abs(clock.position - 41.0) < 0.01,
  `paused clock should converge to player, got ${clock.position}`);
const held = clock.position;

// 5. Player reporting 0 (buffering) must not yank the clock back to zero.
clock.play(); reported = 0;
for (let i = 0; i < 40; i++) { fakeNow += 16; clock.tick(); }
assert.ok(clock.position > held, 'buffering reset the clock');
performance.now = realNow;
console.log('PlaybackClock: 5/5 pass');

// --- beatPulse -------------------------------------------------------------
const score = (confidence, beats, partial = false, analysed = 30, bpm = 120) => ({
  timing: { tempo_confidence: confidence, beats, tempo_bpm: bpm },
  analysis: { is_partial: partial, analysed_duration_sec: analysed },
});
const beats = [1.0, 1.5, 2.0, 2.5, 3.0];

assert.equal(beatPulse(score(0.2, beats), 1.0), 0, 'low confidence must suppress');
assert.equal(beatPulse(score(0.9, beats), 0.4), 0, 'before first beat');
assert.equal(beatPulse(score(0.9, beats), 2.0), 1, 'exactly on a beat');
assert.ok(Math.abs(beatPulse(score(0.9, beats), 2.09) - 0.5) < 1e-9, 'mid-decay');
assert.equal(beatPulse(score(0.9, beats), 2.4), 0, 'fully decayed before next beat');
assert.equal(beatPulse(score(0.9, beats), 99), 0, 'past the last beat');
assert.equal(beatPulse(score(0.9, []), 5), 0, 'empty beat list');
// Binary search must agree with a linear scan across the whole range.
for (let t = 0; t < 4; t += 0.013) {
  const linear = [...beats].reverse().find((b) => b <= t);
  const expected = linear === undefined ? 0 : Math.max(0, 1 - (t - linear) / 0.18);
  assert.ok(Math.abs(beatPulse(score(0.9, beats), t) - expected) < 1e-9, `mismatch at t=${t}`);
}
console.log('beatPulse: 8/8 pass (binary search matches linear scan across range)');

// --- resolveScoreTime: partial scores must loop, not freeze ------------------
const full = { analysis: { is_partial: false, analysed_duration_sec: 200 } };
const part = { analysis: { is_partial: true, analysed_duration_sec: 30 } };

assert.equal(resolveScoreTime(full, 150), 150, 'full score passes time through');
assert.equal(resolveScoreTime(part, 12), 12, 'inside the window is untouched');
assert.equal(resolveScoreTime(part, 30), 0, 'wraps exactly at the boundary');
assert.ok(Math.abs(resolveScoreTime(part, 71.5) - 11.5) < 1e-9, 'wraps repeatedly');
assert.equal(resolveScoreTime({ analysis: { is_partial: true, analysed_duration_sec: 0 } }, 5), 5,
  'zero-length analysis must not divide by zero');
// The regression this exists to prevent: a 3-minute track must never park on
// the final analysed frame.
const laneFrames = 901, fps = 30;
for (const t of [45, 90, 135, 180]) {
  const frame = Math.floor(resolveScoreTime(part, t) * fps);
  assert.ok(frame < laneFrames - 1, `lanes froze on the last frame at t=${t}`);
}
console.log('resolveScoreTime: 9/9 pass (partial scores loop instead of freezing)');

// --- beatPulse past the analysed window -------------------------------------
const partScore = score(0.9, [0.25, 0.75, 1.25], true, 30, 120);
// Grid extrapolates from beats[0]=0.25 at 120 BPM, so beats land at 0.25+0.5n.
assert.ok(Math.abs(beatPulse(partScore, 100.25) - 1) < 1e-9, 'extrapolated beat peak');
assert.ok(Math.abs(beatPulse(partScore, 100.75) - 1) < 1e-9, 'next extrapolated beat');
assert.equal(beatPulse(partScore, 100.5), 0, 'decayed between extrapolated beats');
// Phase must stay continuous across the loop seam rather than restarting.
assert.ok(Math.abs(beatPulse(partScore, 30.25) - 1) < 1e-9, 'no phase jump at the seam');
console.log('beatPulse (partial): 4/4 pass (grid extrapolates, phase stays continuous)');
