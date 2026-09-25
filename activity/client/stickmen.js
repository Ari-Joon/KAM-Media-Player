/**
 * Stick Men: 3D dancing figures under a moving camera.
 *
 * ## What changed from the flat version
 *
 * The previous renderer posed figures in 2D and faked rotation with a horizontal
 * squash. Everything here lives in a real 3D space instead: joints are computed
 * in body-local coordinates, rotated into the world, then projected through a
 * perspective camera that can orbit, dolly and change height. That is what makes
 * a figure turning actually look like it is turning, and what lets the camera
 * circle the group rather than merely zoom.
 *
 * Depth is sold three ways, because perspective alone reads as scaling: figures
 * are drawn back-to-front, each casts a floor shadow, and a ground grid recedes
 * to a horizon.
 *
 * ## Motion
 *
 * Every joint takes angles on more than one axis - a shoulder swings *and* lifts
 * *and* rotates out - which is the difference between a dancing figure and a
 * stiff one. Poses are still pure functions of position within the bar, so the
 * figures cannot drift out of time however long they run.
 *
 * Limbs also carry **secondary motion**: hands and feet lag their parent joint
 * slightly through a smoothing filter, so a fast arm movement whips rather than
 * snapping. That lag is most of what separates "animated" from "posed".
 */

import { performerCount } from './artists.js';
import { saturate } from './visuals.js';

/**
 * How long the palette takes to travel between schemes.
 *
 * Matches the value the shared renderers use, so switching between Stick Men and
 * any other mode does not change the rhythm of the colour.
 */
const PALETTE_CYCLE_SEC = 9;

/**
 * Blend two hex colours, returning hex so the result can be saturated.
 *
 * @param {string} fromHex
 * @param {string} toHex
 * @param {number} t
 * @returns {string}
 */
function mixHex(fromHex, toHex, t) {
  const parse = (hex) => {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const a = parse(fromHex);
  const b = parse(toHex);
  const k = Math.min(1, Math.max(0, t));
  return `#${a.map((channel, i) => Math.round(channel + (b[i] - channel) * k)
    .toString(16).padStart(2, '0')).join('')}`;
}

const DEG = Math.PI / 180;

/**
 * Smallest angle a limb may sit from the torso, in radians, before it is eased
 * back out - after a few seconds' grace; see `repel`.
 *
 * Below this a limb visually merges with the body and the figure stops reading
 * as posed at all - it becomes a stick with a head.
 *
 * Lift has been a plain angle out from the body since `poseAim`, so these are
 * too. An arm held 20 degrees out puts the hand 0.4 of a build from the body's
 * axis, clear of the trunk's drawn edge. They were 41 and 15 when lift was
 * multiplied 2.625 times into a turn about the vertical, where 41 already sat
 * past the side: taken literally now, 15 degrees on each leg would splay every
 * stance to three quarters of a build.
 */
const MIN_ARM_SPREAD = 20 * (Math.PI / 180);
const MIN_LEG_SPREAD = 4 * (Math.PI / 180);

/**
 * Which way a figure faces before it turns: towards the audience.
 *
 * Every camera but the side-on one stands on the -z side of the stage, and the
 * figures faced +z, away from all of them. With no face drawn that could not
 * be seen directly, but everything that shows which way a body faces went the
 * wrong way: arms reached away from the viewer, knees bent away from them, and
 * a performance meant for the room was danced to the back wall.
 */
const FACING_AUDIENCE = Math.PI;

/**
 * Body proportions, as fractions of a figure's build.
 *
 * Module constants rather than locals in `drawDancer`, so anything that needs
 * the body's geometry reads the same numbers the figure is drawn with.
 */
const SHOULDER_HALF = 0.20;
const UPPER_ARM = 0.36;
const FORE_ARM = 0.34;
const THIGH = 0.56;
const SHIN = 0.54;
const SPINE_LEN = 0.52;

/**
 * How tall a figure stands, which every on-screen size scales from.
 *
 * The trailing 0.42 is the head and neck allowance the figure is drawn with.
 */
const BODY_HEIGHT = THIGH + SHIN + SPINE_LEN + 0.42;

/** Longest a limb may stay tucked against the body, in seconds. */
const MAX_TUCK_SEC = 3;

/** Height of the floor the feet stand on: the lowest a foot may be drawn. */
const FLOOR = 0;

/**
 * How far the drawn pose trails the pose a move asks for, in seconds.
 *
 * Measured at 120bpm by comparing the springs' output with their target: 33ms
 * for the arms, 50ms for the legs and hips. `updatePosition` reads the moves
 * this far ahead of the music to cancel it, so a clap written to close on the
 * beat is drawn closing on it.
 */
const SPRING_LAG_SEC = 0.04;

/**
 * Nearest a hand or elbow may come to the torso's axis, as a fraction of build.
 *
 * The drawn trunk is 0.45 of a build wide and a hand 0.21, so their surfaces
 * meet at about 0.33. Measured on the joints `drawDancer` actually draws - six
 * dancers across four cached tracks, 200,064 dancer-frames - a forearm passed
 * through the torso on 8.07% of hand-frames and a hand sat hidden inside it on
 * 4.27%.
 *
 * The angle-based spread could not prevent it, and was the larger cause.
 * `repel` keeps a lift away from zero on whichever side it is on, so an arm
 * authored across the chest was pushed *further* across, to -41 degrees - and
 * lift reaches the aim amplified 2.625 times, an azimuth of -107.6 degrees:
 * inward and slightly backward, through the chest. Arms lifted inward on a
 * forward swing were 39% of arm poses and 81% of the forearms through the body.
 * The fix is geometric because the failure is; see `clearArm`.
 *
 * | clearance | forearm through | hand inside | median hand distance |
 * |-----------|-----------------|-------------|----------------------|
 * | none      | 8.07%           | 4.27%       | 0.555                |
 * | 0.25      | 2.71%           | 2.33%       | 0.558                |
 * | 0.28      | 1.91%           | 1.52%       | 0.563                |
 * | 0.31      | 1.44%           | 0.97%       | 0.570                |
 *
 * 0.31 is the two surfaces nearly touching, and it costs the poses 0.015 of
 * median hand distance: arms that were already clear are left where they were.
 * Hands merged into the head fell from 0.34% to 0.20% as a side effect.
 *
 * Measured again once `poseAim` and the rewritten tables stopped folding arms
 * across the chest by accident: the arms crossed on purpose - a floss, a clap
 * closing, the singer's mic hand - put a forearm through the body on 2.81% of
 * hand-frames without the clearance, and on 0.00% with it.
 */
const HAND_TORSO_CLEARANCE = 0.31;

/**
 * Nearest the two legs may come to each other, axis to axis, as a fraction of
 * build.
 *
 * Measured as above, shins passed through each other on 17.07% of
 * dancer-frames and thighs on 7.86% - with six dancers, a pair of legs going
 * through each other somewhere in about two frames in three. 57% of the shin
 * crossings were one foot landing on the other, almost always with exactly one
 * of them planted: the free foot came to rest where the loaded one stood, a
 * median 0.16 apart. The rest were knees knocking, and a swinging shin passing
 * through the standing one.
 *
 * | gap  | shins through | thighs through | median stance |
 * |------|---------------|----------------|---------------|
 * | none | 17.07%        | 7.86%          | 0.344         |
 * | 0.16 |  2.64%        | 0.66%          | 0.373         |
 * | 0.19 |  1.80%        | 0.45%          | 0.389         |
 * | 0.22 |  1.35%        | 0.35%          | 0.410         |
 * | 0.28 |  0.73%        | 0.19%          | 0.521         |
 *
 * 0.19 is two drawn legs brushing - they are 0.214 wide - without overlapping.
 * It must stay under the hips' own spacing, 0.248: past that, legs hanging
 * straight and parallel count as too close and every stance splays. 0.28
 * widened the median stance by half, which is the limp `MIN_LEG_SPREAD`'s
 * narrow floor exists to avoid. At 0.19 the median moves 13%, and what moves
 * is the feet that were standing on each other.
 *
 * Since `poseAim` made leg lift spread a stance as the tables always meant
 * it to, legs rarely come near each other: shins crossed on 0.19% of
 * dancer-frames without the gap and 0.00% with it, and the median stance is
 * 0.441 either way.
 */
const MIN_LIMB_GAP = 0.19;

/**
 * Move a point out of the torso by the shortest way.
 *
 * Radially from the torso's axis, which is the nearest exit and does the
 * right thing in every case that matters: a hand hanging at the side goes
 * out to the side, which is the arm opening from the body; a hand reaching
 * across the chest has already passed the axis in front, so it goes forward
 * and keeps its reach; a hand behind goes back.
 *
 * @param {number[]} point In the chest's frame: chest at the origin, rotated
 *   by the chest's yaw.
 * @param {number[]} hips The hips, in the same frame.
 * @param {number} radius Clearance from the axis.
 * @returns {number[]|null} The moved point, or null when it was already clear.
 */
function outOfTorso(point, hips, radius) {
  const axis = sub([0, 0, 0], hips);
  const along = Math.max(0, Math.min(1,
    dot3(sub(point, hips), axis) / Math.max(1e-9, dot3(axis, axis))));
  const nearest = add(hips, [axis[0] * along, axis[1] * along, axis[2] * along]);
  const away = sub(point, nearest);
  const distance = Math.hypot(away[0], away[1], away[2]);
  if (distance >= radius) return null;
  // Exactly on the axis has no nearest side; forward is the one a gesture
  // there is almost certainly making.
  const direction = distance > 1e-6
    ? [away[0] / distance, away[1] / distance, away[2] / distance]
    : [0, 0, 1];
  return add(nearest, [direction[0] * radius, direction[1] * radius, direction[2] * radius]);
}

/** Dot product of two 3-vectors. */
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Closest approach of two segments: the distance, and where on each it falls.
 *
 * @returns {{distance: number, a: number[], b: number[]}}
 */
function segmentGap(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);
  let s1 = 0;
  let t1 = 0;
  if (a > 1e-12 && e > 1e-12) {
    const c = dot3(d1, r);
    const b = dot3(d1, d2);
    const den = a * e - b * b;
    s1 = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
    t1 = (b * s1 + f) / e;
    if (t1 < 0) {
      t1 = 0;
      s1 = Math.max(0, Math.min(1, -c / a));
    } else if (t1 > 1) {
      t1 = 1;
      s1 = Math.max(0, Math.min(1, (b - c) / a));
    }
  } else if (e > 1e-12) {
    t1 = Math.max(0, Math.min(1, f / e));
  } else if (a > 1e-12) {
    s1 = Math.max(0, Math.min(1, -dot3(d1, r) / a));
  }
  const onA = add(p1, [d1[0] * s1, d1[1] * s1, d1[2] * s1]);
  const onB = add(p2, [d2[0] * t1, d2[1] * t1, d2[2] * t1]);
  const gap = sub(onA, onB);
  return { distance: Math.hypot(gap[0], gap[1], gap[2]), a: onA, b: onB };
}

/**
 * Keep an arm's elbow and hand out of the torso, re-solving the arm to reach.
 *
 * The shoulder itself sits inside the trunk's drawn width - 0.20 of a build
 * out against 0.225 - so an arm that heads inward has its elbow in the body
 * even once the hand is clear, and moving the hand alone left 7.4% of
 * forearms passing through. Both joints are checked; whichever is inside
 * moves the hand by its own shortfall, and the arm is solved again. A few
 * passes, because solving moves the elbow too.
 *
 * @returns {{joint: number[], end: number[]}} The arm, in the shoulder's frame.
 */
function clearArm(solved, shoulder, hips, radius, upper, lower, flare = null) {
  let arm = solved;
  for (let pass = 0; pass < 3; pass++) {
    const hand = add(shoulder, arm.end);
    const elbow = add(shoulder, arm.joint);
    const handOut = outOfTorso(hand, hips, radius);
    const elbowOut = outOfTorso(elbow, hips, radius);
    if (!handOut && !elbowOut) return arm;
    let target = handOut ?? hand;
    if (elbowOut) target = add(target, sub(elbowOut, elbow));
    const reach = aimAt(sub(target, shoulder), upper + lower);
    arm = limb(reach.elevation, reach.azimuth, reach.extend, upper, lower, -1, flare);
  }
  return arm;
}

/**
 * Push a limb away from the torso.
 *
 * ## Why this exists
 *
 * Poses are authored as target angles, and a target of "arm near the body" is
 * perfectly reachable - so limbs would settle against the torso and stay there,
 * which is exactly what made the figures look static however energetic the move.
 *
 * This behaves like a magnetic repulsion between limb and body: a force that
 * grows sharply as the gap closes and vanishes once the limb is clear. Because
 * it is a force rather than a clamp, a limb can still travel inward through the
 * dead zone - a clap has to bring the hands together - it simply cannot rest
 * there.
 *
 * The exception is time-limited. Some poses genuinely want a tucked limb: a hand
 * holding a microphone, an arm folded across the chest. Those are allowed, but
 * only for {@link MAX_TUCK_SEC}; past that the repulsion ramps in regardless, so
 * a figure can never freeze in a closed position.
 *
 * @param {number} target Desired angle from the body, this frame.
 * @param {number} visible The angle currently drawn, after smoothing.
 * @param {number} minimum Angle below which repulsion applies.
 * @param {{tuckSec: number}} state Per-limb timer, mutated.
 * @param {number} deltaSec
 * @param {number} [grace] How long a tuck is tolerated, in seconds.
 * @returns {number} The adjusted target.
 */
function repel(target, visible, minimum, state, deltaSec, grace = MAX_TUCK_SEC) {
  // The timer must judge what is actually on screen, not what the pose asked
  // for. Testing the raw target meant it stayed below the threshold every frame
  // even while the force was successfully holding the limb clear, so the timer
  // grew without bound and the grace period never ended - a limb could read as
  // tucked for twenty seconds while the code believed it was fine.
  if (Math.abs(visible) >= minimum) {
    state.tuckSec = Math.max(0, state.tuckSec - deltaSec * 1.5);
  } else {
    state.tuckSec += deltaSec;
  }

  const magnitude = Math.abs(target);
  if (magnitude >= minimum) return target;

  // The push is expressed as a fraction of the *deficit* - how far short of the
  // threshold the limb is - rather than as an inverse-square field.
  //
  // An inverse-square force is physically truthful and useless here: at 77% of
  // the threshold it produced a push of 0.003 radians, so limbs sat just inside
  // the dead zone indefinitely. Closing a measured deficit guarantees the limb
  // ends up clear, which is the actual requirement.
  const deficit = minimum - magnitude;

  // Weak during the grace period, so a deliberate tuck - a hand on a microphone,
  // an arm folded - survives for a few seconds. Past the allowance it ramps to
  // full over half a second, and the limb drifts out rather than being ejected.
  const ramp = state.tuckSec < grace
    ? 0.06
    : 0.06 + 1.09 * Math.min(1, (state.tuckSec - grace) / 0.5);

  // Overshooting the threshold slightly means the limb settles clear of it
  // rather than oscillating across the boundary.
  const sign = target < 0 ? -1 : 1;
  return target + sign * deficit * ramp;
}

/**
 * Joint limits, in radians.
 *
 * Amplification can push a pose that was already extreme past anything a body
 * could do - an arm written at -150 degrees to reach overhead became -235, which
 * wraps it round behind the back. Clamping keeps exaggeration expressive without
 * letting it become anatomically impossible.
 */
const LIMITS = {
  // Straight overhead is -180; a little past it takes the hands behind the head.
  armSwing: [-190 * DEG, 60 * DEG],
  // Out to the side is 90, and 125 raises a side-held arm 35 degrees above
  // level. Crossing over by more than 60 would take the arm through the far
  // shoulder.
  armLift: [-60 * DEG, 125 * DEG],
  // Capped well below a full fold. Past about 110 degrees the forearm is
  // travelling back toward the shoulder rather than doing anything visible, and
  // the figure reads as having its arms clamped to its sides.
  elbow: [5 * DEG, 112 * DEG],
  legSwing: [-75 * DEG, 95 * DEG],
  legLift: [-45 * DEG, 45 * DEG],
  knee: [0, 135 * DEG],
  spine: [-40 * DEG, 45 * DEG],
  head: [-45 * DEG, 45 * DEG],
  // Hip travel in world units, positive upward: a jump's hop above standing,
  // a deep crouch below it.
  bob: [-0.26, 0.30],
};

/** Constrain a value to a limit pair. */
function clamp(value, [low, high]) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Constrain a value without ever letting it rest exactly on the limit.
 *
 * ## Why a hard clamp was not enough
 *
 * Amplification pushes authored poses well past what a body can do, and
 * `clamp()` answers that by parking the joint precisely on its boundary. Once
 * several joints are parked at once the figure stops being posed at all - every
 * frame returns the same extreme, so the limbs neither move nor differ from each
 * other, and the whole figure collapses into one silhouette. Measured across
 * three tracks and 28,800 dancer-frames, the elbow sat on its limit 27.8% of the
 * time and arm swing 13.0%: for more than a quarter of every performance the
 * arms were folded flat against the torso, which is exactly the black blob the
 * figures were rendering as.
 *
 * Below the knee the value passes through untouched, so ordinary motion is
 * unaffected. Past it the remaining range is compressed through `tanh`, which
 * approaches the limit asymptotically and never reaches it - so an over-driven
 * joint reads as *strained toward* its extreme rather than dead against it, and
 * it still responds to input that a hard clamp would have thrown away entirely.
 *
 * The slope of `tanh` is 1 at the origin, so the two halves meet smoothly at the
 * knee and the joint does not visibly change behaviour as it crosses.
 */
function softClamp(value, [low, high], knee = 0.65) {
  const mid = (low + high) / 2;
  const half = (high - low) / 2;
  if (half <= 0) return mid;

  const offset = (value - mid) / half;
  const magnitude = Math.abs(offset);
  if (magnitude <= knee) return value;

  const sign = offset < 0 ? -1 : 1;
  const beyond = (magnitude - knee) / (1 - knee);
  return mid + sign * (knee + (1 - knee) * Math.tanh(beyond)) * half;
}

/**
 * The equivalent of an angle nearest another, a whole number of turns away.
 *
 * `spin` writes its turn as a ramp from 0 to 360 degrees across each bar, and
 * the body's spring chases whatever it is given - so at every bar line the
 * target fell a whole turn and the figure whipped back round through it.
 * Measured over sixteen seconds of `spin`, the figure turned backwards on 19%
 * of frames, by up to 30 degrees in one. Taking the equivalent of the target
 * nearest the angle already drawn makes the ramp continuous: no backward
 * frames since.
 *
 * @param {number} angle The turn a move asks for, in radians.
 * @param {number} from The turn currently drawn.
 * @returns {number}
 */
function nearestTurn(angle, from) {
  const turn = Math.PI * 2;
  return angle + turn * Math.round((from - angle) / turn);
}

/**
 * Environments, cycled per section.
 *
 * Named rather than parameterised: five distinct sets read as five places, where
 * five variations on one set read as the same place with the furniture moved.
 */
const ENVIRONMENTS = [
  'open', 'stage', 'columns', 'rings', 'skyline',
  'forest', 'club', 'desert', 'rain', 'arena',
  'neon', 'synthwave', 'underwater', 'volcano', 'cave',
  'storm', 'aurora', 'ice', 'temple', 'space', 'factory',
];

/**
 * Set dressing placed in the world, chosen per section.
 *
 * Separate from the environment rather than folded into it: a prop is a thing
 * standing on the floor with the dancers, so it belongs to the same space
 * whichever backdrop is behind it, and pairing the two lists independently
 * gives far more distinct-looking sets than either alone.
 */
const PROPS = [
  'none', 'speakers', 'discoball', 'lanterns', 'crates',
  'mics', 'none', 'braziers',
];

/** Backdrop palettes, one per section, cycled. */
const PALETTES = [
  ['#ff1f6b', '#ffb02b'],
  ['#12d0ff', '#0b3cff'],
  ['#b6ff20', '#00b567'],
  ['#ffd21a', '#ff4d00'],
  ['#c14dff', '#3c14ff'],
  ['#ff4040', '#ab0f52'],
];

// --- Small 3D helpers -------------------------------------------------------

/**
 * World up, hoisted to a constant.
 *
 * It was a `[0, 1, 0]` literal inside the camera basis, which meant a fresh
 * array on every projection - hundreds per frame - for a value that never
 * changes. Never mutate it.
 */
const WORLD_UP = [0, 1, 0];

/** Rotate a point about the Y (vertical) axis. */
function rotY([x, y, z], angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}

/** Rotate a point about the X (sideways) axis. */
function rotX([x, y, z], angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x, y * c - z * s, y * s + z * c];
}

/** Rotate a point about the Z (forward) axis. */
function rotZ([x, y, z], angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c, z];
}

/** Add two points. */
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Subtract b from a. */
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Cross product. */
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Normalise, tolerating a zero-length input. */
function unit(a) {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * Frame-rate independent easing.
 *
 * The obvious form, `current + (target - current) * rate * dt`, is wrong: it
 * moves twice as far per frame at 30fps as at 60, so any variation in frame time
 * appears as stutter. This was the actual source of the jitter - not the poses,
 * which are perfectly smooth functions.
 *
 * The exponential form converges at the same rate per *second* regardless of how
 * that second is divided into frames.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} rate Higher follows more tightly, in units per second.
 * @param {number} deltaSec
 * @returns {number}
 */
function ease(current, target, rate, deltaSec) {
  return current + (target - current) * (1 - Math.exp(-rate * deltaSec));
}

/** Ease each component of a 3-vector. */
function easeVec(current, target, rate, deltaSec) {
  return [
    ease(current[0], target[0], rate, deltaSec),
    ease(current[1], target[1], rate, deltaSec),
    ease(current[2], target[2], rate, deltaSec),
  ];
}

/**
 * Advance a value toward a target with momentum.
 *
 * Exponential easing always decelerates into its target and never passes it, so
 * a limb arrives and stops - correct, but lifeless. A spring carries velocity,
 * so a fast movement overshoots slightly and settles back. That overshoot is
 * follow-through, and it is most of what separates animation from interpolation.
 *
 * Damping is set just below critical: enough to overshoot visibly once, not
 * enough to oscillate, which would read as the jitter this replaced.
 *
 * @param {{value: number, velocity: number}} state Mutated in place.
 * @param {number} target
 * @param {number} stiffness Higher reaches the target sooner.
 * @param {number} damping Higher settles with less overshoot.
 * @param {number} deltaSec
 */
function spring(state, target, stiffness, damping, deltaSec) {
  // Sub-stepped so a long frame cannot make the integrator explode - a spring
  // integrated in one large step can gain energy instead of losing it.
  const steps = Math.max(1, Math.ceil(deltaSec / 0.008));
  const step = deltaSec / steps;
  for (let i = 0; i < steps; i++) {
    const acceleration = (target - state.value) * stiffness - state.velocity * damping;
    state.velocity += acceleration * step;
    state.value += state.velocity * step;
  }
}

/**
 * Pose fields driven per limb, and the spring key each one uses per side.
 *
 * Both used to be built inside `easePose`: two array literals per side and a
 * template-string key per field, so every figure allocated four arrays and
 * twelve strings each frame for names that never change. At sixty frames a
 * second with eight figures that is close to six thousand throwaway strings a
 * second. Hoisted, they cost one allocation at module load.
 *
 * The key must stay unique per side, which is what the `a0`/`a1` prefix is for -
 * both arms drive a field called `swing`.
 */
const ARM_FIELDS = ['swing', 'lift', 'elbow', 'flare'];
const LEG_FIELDS = ['swing', 'lift', 'knee'];
const ARM_KEYS = [
  ['a0swing', 'a0lift', 'a0elbow', 'a0flare'],
  ['a1swing', 'a1lift', 'a1elbow', 'a1flare'],
];
const LEG_KEYS = [
  ['l0swing', 'l0lift', 'l0knee'],
  ['l1swing', 'l1lift', 'l1knee'],
];

/**
 * Ease every numeric field of a pose toward a target pose.
 *
 * Doing this to the *whole* pose rather than only to limb tips means no value
 * can ever step, and nothing else in the renderer needs to know that moves are
 * being blended.
 *
 * ## How tight
 *
 * Tight enough to dance on the beat. These springs were set loose enough to
 * cross-fade a move change over about a second, and that same looseness is a
 * low-pass filter on the dance itself: the arms sat at stiffness 16, a natural
 * frequency of 0.64Hz, against a beat at 2Hz. Measured at 120bpm by driving
 * `updatePosition` with a stepped clock and comparing the drawn pose with the
 * target it chased, the figures showed 10-58% of the range each move asks for,
 * 250-650ms late - a clap closed to a tenth of its travel, a march lifted its
 * knees to a third of their height, and nothing landed on the beat it was
 * written for. The old amplification, up to 2.4 times, was making up the size
 * and dragging held poses out of place to do it.
 *
 * Now the arms have a natural frequency of 4.8Hz and the rest near 4Hz,
 * damped just under critical so a thrown gesture still overshoots a little.
 * Measured the same way, the limbs now reach 86-100% of each range, 33-50ms
 * behind it, and `SPRING_LAG_SEC` reads the moves that far ahead to cancel
 * the delay. The hips are critically damped, so a dip never rebounds upward,
 * and round the sharpest bounce down to about 60%. A move change is still
 * smoothed, over about a fifth of a second, and the connecting move at each
 * phrase carries the rest.
 *
 * @param {object} current Mutated in place.
 * @param {object} target
 * @param {number} rate
 * @param {number} deltaSec
 */
function easePose(current, target, rate, deltaSec) {
  // Springs are stored alongside the pose, created on first use so the pose
  // objects stay plain data.
  if (!current.springs) {
    current.springs = new Map();
  }
  const get = (key, value) => {
    let state = current.springs.get(key);
    if (!state) current.springs.set(key, state = { value, velocity: 0 });
    return state;
  };

  const drive = (owner, springKey, targetValue, stiffness, damping, field = springKey) => {
    const state = get(springKey, owner[field] ?? 0);
    spring(state, targetValue, stiffness * rate, damping, deltaSec);
    owner[field] = state.value;
  };

  // Critically damped: hips that overshoot a dip bounce back up past where
  // they started, which the preparation before a beat must never do.
  drive(current, 'bob', target.bob, 600, 49);
  drive(current, 'sway', target.sway, 500, 34);
  drive(current, 'turn', target.turn, 400, 30);
  drive(current, 'spineBend', target.spineBend, 500, 34);
  drive(current, 'spineTwist', target.spineTwist, 500, 34);
  // Travel is a speed, not a position; it can afford to be smooth.
  drive(current, 'travel', target.travel, 95, 17);
  drive(current.head, 'swing', target.head.swing, 600, 34);
  drive(current.head, 'lift', target.head.lift, 600, 34);

  // Indexed rather than for-of: this runs once per figure per frame, and
  // iterating with destructuring would put the allocations straight back.
  for (let side = 0; side < 2; side++) {
    // Arms are the loosest, damped least, so a thrown gesture follows through.
    const arm = current.arms[side];
    const armTarget = target.arms[side];
    const armKeys = ARM_KEYS[side];
    for (let i = 0; i < ARM_FIELDS.length; i++) {
      const field = ARM_FIELDS[i];
      drive(arm, armKeys[i], armTarget[field], 900, 39, field);
    }

    const leg = current.legs[side];
    const legTarget = target.legs[side];
    const legKeys = LEG_KEYS[side];
    for (let i = 0; i < LEG_FIELDS.length; i++) {
      const field = LEG_FIELDS[i];
      drive(leg, legKeys[i], legTarget[field], 700, 40, field);
    }
  }
}

/** A pose with everything at rest, used to seed a dancer's smoothed state. */
function restPose() {
  return {
    bob: 0, sway: 0, turn: 0, spineBend: 0, spineTwist: 0, travel: 0,
    head: { swing: 0, lift: 0 },
    arms: [
      { swing: 0, lift: 0, elbow: 0, flare: 0 },
      { swing: 0, lift: 0, elbow: 0, flare: 0 },
    ],
    legs: [
      { swing: 0, lift: 0, knee: 0 },
      { swing: 0, lift: 0, knee: 0 },
    ],
  };
}

/**
 * Aim a limb from the angles the pose tables are written in.
 *
 * `forward` swings the limb forward and up from hanging straight down: a
 * quarter turn is level in front, a half turn straight overhead. `outward` then
 * opens it away from the body's midline, towards the figure's own +x, in the
 * plane across the body - so it means "out to the side" at every swing, level
 * or overhead. Callers sign it by side, so a table writes the same positive
 * number to open either arm, and a negative one to cross it over.
 *
 * ## What this replaced
 *
 * A conversion that read lift as a turn about the vertical, scaled by 2.625
 * between it and `drawDancer`. It failed three ways, each found by drawing a
 * crafted pose through `drawDancer` and reading back the joints:
 *
 * - A limb hanging near vertical has almost no horizontal extent to turn, so
 *   lift barely moved it. Every table spreads the legs with lift, and a leg
 *   lift of 10 degrees moved the foot 0.06 of a build: the stances never opened.
 * - Where it did act, 2.625 carried it past the side and round the back: the 48
 *   degrees a clap opens by became 126, behind the body.
 * - Leg swing ran backwards. The tables write a forward kick as a positive
 *   swing - `march` lifts its knees with one, `charleston` flicks its heels with
 *   a negative - and the conversion sent positive swing behind the body, so the
 *   march raised its knees behind it and the Charleston kicked forward.
 *
 * @param {number} forward Radians forward and up from hanging.
 * @param {number} outward Radians away from the midline, towards +x.
 * @param {number} bendAngle Radians of joint fold.
 * @returns {{elevation: number, azimuth: number, extend: number}}
 */
function poseAim(forward, outward, bendAngle) {
  const across = Math.sin(outward);
  const inPlane = Math.cos(outward);
  const down = -inPlane * Math.cos(forward);
  const ahead = inPlane * Math.sin(forward);
  // A larger fold means a shorter reach - but never a reach of nothing.
  //
  // The floor is the fix for arms tucking into the body. A bend of 135 degrees
  // mapped to an extension of zero, which places the hand back at the shoulder
  // and folds the whole arm flat against the torso. Real elbows stop well short
  // of that, and a dancer's almost never reach it. Holding a minimum of 0.42
  // keeps the forearm out where it can be seen at every pose.
  const extend = Math.max(0.42, Math.min(1, 1 - Math.abs(bendAngle) / (Math.PI * 0.9)));
  return {
    elevation: Math.asin(Math.max(-1, Math.min(1, down))),
    azimuth: Math.atan2(across, ahead),
    extend,
  };
}

/**
 * Place a two-bone limb by aiming it at a direction.
 *
 * ## Why this replaced sequential rotations
 *
 * The previous model rotated a downward vector by a swing about X and then a
 * lift about Z. Composing rotations that way means the second one acts in
 * whatever plane the first left behind, so *lift stopped meaning "out to the
 * side"* as soon as swing was large. Measured on the old code, a 60-degree lift
 * moved the hand 0.26 units sideways at swing 0, 0.00 at swing -90, and
 * **-0.18 at swing -135** - actively pulling the arm inward. Since most poses
 * use large negative swings, that is exactly why limbs always hugged the body
 * however much the numbers were increased.
 *
 * Aiming has no such coupling. Elevation and azimuth are independent spherical
 * coordinates, so "out to the side" means the same thing at every elevation.
 *
 * The joint is then solved rather than assumed: given the distance to the end
 * point, the cosine rule gives how far along that line the joint sits, and the
 * remainder is how far it breaks perpendicular. That guarantees the forearm
 * bends *away* from the upper arm instead of continuing its arc, which is the
 * other half of why arms never appeared to extend.
 *
 * @param {number} elevation Radians. -PI/2 is straight down, 0 horizontal,
 *   +PI/2 straight up.
 * @param {number} azimuth Radians. 0 is forward, +PI/2 directly out to the side.
 * @param {number} extend 0-1, how straight the limb is.
 * @param {number} upper Length of the first bone.
 * @param {number} lower Length of the second.
 * @param {number} [bend] Which way the joint breaks, +1 or -1.
 * @param {number[]|null} [flare] Swing the joint out towards this direction
 *   instead, by the vector's length, 0-1. See `flare` in {@link MOVES}.
 * @returns {{joint: number[], end: number[]}} Offsets from the parent joint.
 */
function limb(elevation, azimuth, extend, upper, lower, bend = 1, flare = null) {
  const span = upper + lower;
  // Never fully straight and never folded flat: both extremes look broken.
  // Expressed through the shared constants because `aimAt` inverts this exact
  // line - if the two drifted apart, a pinned foot would settle somewhere other
  // than where it was planted and the error would be invisible in isolation.
  const reach = span * (MIN_REACH
    + (MAX_REACH - MIN_REACH) * Math.min(1, Math.max(0, extend)));

  const horizontal = Math.cos(elevation);
  const direction = [
    Math.sin(azimuth) * horizontal,
    Math.sin(elevation),
    Math.cos(azimuth) * horizontal,
  ];
  const end = [direction[0] * reach, direction[1] * reach, direction[2] * reach];

  // Cosine rule: distance along the aim at which the two bones meet.
  const along = Math.min(
    upper,
    (reach * reach + upper * upper - lower * lower) / (2 * Math.max(reach, 0.001)),
  );
  const out = Math.sqrt(Math.max(0, upper * upper - along * along));

  // Break the joint in a plane that stays continuous as the limb rotates.
  //
  // Crossing with world up and swapping to a fixed axis at the poles created a
  // discontinuity: as a limb passed near vertical the reference flipped and the
  // elbow jumped instantly to the other side of the arm. That is the teleporting
  // - it was a singularity in the solver, not a smoothing problem.
  //
  // Blending between two reference axes by how vertical the limb is means the
  // basis rotates smoothly through the pole instead of switching at it.
  const verticality = Math.abs(direction[1]);
  const reference = unit([
    0,
    1 - verticality,
    verticality,
  ]);
  let side = cross(direction, reference);
  // Still degenerate only if direction is parallel to the blended reference,
  // which the blend makes impossible in practice; guarded regardless.
  if (Math.hypot(side[0], side[1], side[2]) < 1e-4) side = [1, 0, 0];
  let perpendicular = unit(cross(unit(side), direction));
  let breaks = bend;

  // Flared: the joint swings towards the given side instead, by as much as
  // asked. An elbow otherwise always breaks back or down, which cannot draw
  // hands on hips or behind the head - the elbows go out for both. Only the
  // part of the flare across the limb counts, so an arm pointing straight
  // along it (level out to the side) keeps its ordinary bend rather than
  // snapping round.
  if (flare) {
    const amount = Math.min(1, Math.hypot(flare[0], flare[1], flare[2]));
    const along = dot3(flare, direction);
    const across = [
      flare[0] - direction[0] * along,
      flare[1] - direction[1] * along,
      flare[2] - direction[2] * along,
    ];
    const blended = [
      perpendicular[0] * bend * (1 - amount) + across[0],
      perpendicular[1] * bend * (1 - amount) + across[1],
      perpendicular[2] * bend * (1 - amount) + across[2],
    ];
    if (Math.hypot(blended[0], blended[1], blended[2]) > 1e-3) {
      perpendicular = unit(blended);
      breaks = 1;
    }
  }

  return {
    joint: [
      direction[0] * along + perpendicular[0] * out * breaks,
      direction[1] * along + perpendicular[1] * out * breaks,
      direction[2] * along + perpendicular[2] * out * breaks,
    ],
    end,
  };
}

/** Reach limits of {@link limb}, as fractions of the two bones' total span. */
const MIN_REACH = 0.42;
const MAX_REACH = 0.98;

/**
 * Convert an offset from the parent joint back into aim coordinates.
 *
 * The inverse of what {@link limb} consumes: given where a limb tip has to end
 * up, work out the elevation, azimuth and extension that put it there. This is
 * what lets a foot be *placed* rather than merely pointed, and placing feet is
 * the whole of what stops the figures skating across the floor.
 *
 * Distance is clamped into the range `limb()` can actually reach. A hip that has
 * travelled too far from a planted foot therefore produces the most extended
 * reachable pose rather than a broken one, and `reachable` tells the caller to
 * give up the plant and take a step instead of stretching further.
 *
 * @param {number[]} offset Target position relative to the parent joint, in
 *   body-local coordinates.
 * @param {number} span Total length of the two bones.
 * @returns {{elevation: number, azimuth: number, extend: number,
 *   reachable: boolean}}
 */
function aimAt(offset, span) {
  const distance = Math.hypot(offset[0], offset[1], offset[2]);
  const clamped = Math.min(span * MAX_REACH, Math.max(span * MIN_REACH, distance));
  // Invert `reach = span * (MIN_REACH + (MAX_REACH - MIN_REACH) * extend)`.
  const extend = (clamped / span - MIN_REACH) / (MAX_REACH - MIN_REACH);

  // A zero-length offset has no direction to report. Straight down is the only
  // sensible answer and matches the rest position the pose tables assume.
  if (distance < 1e-6) {
    return { elevation: -Math.PI / 2, azimuth: 0, extend, reachable: false };
  }

  return {
    elevation: Math.asin(Math.min(1, Math.max(-1, offset[1] / distance))),
    azimuth: Math.atan2(offset[0], offset[2]),
    extend,
    reachable: distance <= span * MAX_REACH,
  };
}

/** Parse `#rrggbb`. */
function rgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Blend two hex colours into an `rgb()` string. */
function mix(fromHex, toHex, t) {
  const a = rgb(fromHex);
  const b = rgb(toHex);
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},`
    + `${Math.round(a[1] + (b[1] - a[1]) * k)},`
    + `${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

/**
 * Fill only the square a radial gradient can actually paint.
 *
 * A radial gradient whose outer stop is transparent paints nothing past its
 * radius, so `fillRect(0, 0, width, height)` was rasterising the whole canvas in
 * order to composite one circle. The `stage` environment did that nine times per
 * frame, on top of the backdrop's two full-canvas fills and the floor's one -
 * twelve full-canvas composites a frame. On a 1920x1080 stage at a device ratio
 * of 2 that is roughly 100 million pixel writes per frame for a picture whose
 * actual content is a handful of glows, and it is the reason the stage set was
 * the heaviest of the ten.
 *
 * The painted result is identical; only the rasterised area changes.
 */
function fillGlow(context, x, y, radius, width, height) {
  const left = Math.max(0, x - radius);
  const top = Math.max(0, y - radius);
  const right = Math.min(width, x + radius);
  const bottom = Math.min(height, y + radius);
  if (right <= left || bottom <= top) return;
  context.fillRect(left, top, right - left, bottom - top);
}

/** Smooth 0-1-0 across a phase. */
function swell(phase) {
  return Math.sin(phase * Math.PI);
}

/** Sharp attack decaying across a phase. */
function attack(phase) {
  return Math.pow(Math.max(0, 1 - phase), 2.4);
}

/**
 * Where within a beat the preparation *input* peaks, and how wide it is.
 *
 * `attack()` is follow-through: a sharp value on the beat, decaying after it.
 * Every accent in this renderer had one and none had the counterpart, so every
 * movement was a reaction - the figures were always responding to the music and
 * never meeting it. Preparation is what reads as intent.
 *
 * The centre is well before the beat, and that is not a stylistic choice: the
 * pose springs are what actually reach the screen and they lag. Measured against
 * an otherwise identical run with anticipation disabled, an input peaking
 * exactly on the beat produced its deepest *drawn* dip at phase 0.13 - after the
 * beat, making it a second follow-through rather than a preparation. The bob
 * spring's lag is therefore about 0.13 of a beat.
 *
 * Centred at 0.72, that put the drawn dip at phase 0.92. The springs have
 * since been tightened and the moves are read 40ms ahead of the music (see
 * `SPRING_LAG_SEC`), which left 0.72 drawing the dip at 0.71 - nearer the
 * middle of the beat than the accent - and three times deeper than intended,
 * because the springs no longer swallowed it.
 *
 * Centred at 0.86 and narrowed to fit before the beat, the deepest drawn point
 * falls between 0.83 and 0.88 of the beat, measured in 24ths, and at 0.03 of
 * depth per unit of preparation it adds 0.0119 of hip travel: 25% of the beat
 * bounce, which reads without taking the movement over.
 *
 * Retune both if the body spring's stiffness changes: they compensate for it,
 * they do not describe the music.
 */
const ANTICIPATION_CENTRE = 0.86;
const ANTICIPATION_WIDTH = 0.26;

/**
 * Smooth preparation pulse within a beat.
 *
 * A raised sine rather than a ramp, so the gather eases in and releases again
 * instead of cutting off. A hard edge at the end of the window steps the spring,
 * which shows as a tick rather than as a body gathering itself.
 *
 * @param {number} phase Position within the beat, 0-1.
 * @returns {number} 0 outside the window, peaking at 1 in the middle of it.
 */
function anticipate(phase) {
  const start = ANTICIPATION_CENTRE - ANTICIPATION_WIDTH / 2;
  const t = (phase - start) / ANTICIPATION_WIDTH;
  if (t <= 0 || t >= 1) return 0;
  const shaped = Math.sin(t * Math.PI);
  return shaped * shaped;
}

// --- Move vocabulary --------------------------------------------------------

/**
 * Poses, as pure functions of `(bar, beat, energy, punch)`.
 *
 * Each returns joint angles in degrees-times-`DEG`, and they are drawn as
 * written: the dynamics in `updatePosition` make a move bigger or smaller about
 * its own centre, so the numbers here are where each gesture happens. Every
 * table was rewritten on 25 September 2026, when the conversion that draws
 * them was found to have been reversing the legs and folding the arms round
 * behind the body; see `poseAim`.
 *
 * ## Conventions
 *
 * - Arm `swing`: 0 hangs straight down, -90 is level in front, -180 straight
 *   overhead; positive swings behind the body.
 * - Leg `swing`: the other way round, because every table was written so -
 *   positive lifts the leg forward, negative takes it behind.
 * - `lift`: opens a limb away from the body in the plane across it, on either
 *   side. 90 is straight out to the side at any swing; negative crosses over.
 *   Write the same number for both arms to open them symmetrically.
 * - `elbow` and `knee`: 0 straight. An elbow breaks backward and down, a knee
 *   forward; `flare`, 0-1, swings an elbow out to the side instead, which is
 *   what hands on hips and hands behind the head need.
 * - `bob` raises the hips (negative sinks them), `sway` shifts them sideways,
 *   `turn` yaws the body, `spineBend` leans the chest forward, `spineTwist`
 *   turns the shoulders against the hips, and `head.swing` nods it forward.
 * - `travel` moves the figure across the floor.
 *
 * Every move has one defining mechanic, and that is what it is written around:
 * the Twist is hips against shoulders, the Charleston heels flicking back, the
 * Running Man a foot sliding under a lifted knee. Get the mechanic and a dance
 * reads even on a stick figure; get only the energy and none of them do.
 */
const MOVES = {
  /** Two-step: a weight change to each side per bar, arms swinging against the legs. */
  step(bar, beat, energy) {
    const shift = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -attack(beat) * 0.035 * drive,
      sway: shift * 0.09 * drive,
      turn: shift * 10 * DEG,
      spineBend: 4 * DEG,
      spineTwist: -shift * 12 * DEG,
      head: { swing: attack(beat) * 8 * DEG, lift: shift * 6 * DEG },
      travel: shift * 0.25 * drive,
      arms: [
        { swing: (-30 + shift * 26 * drive) * DEG, lift: 26 * DEG, elbow: (72 - shift * 14) * DEG },
        { swing: (-30 - shift * 26 * drive) * DEG, lift: 26 * DEG, elbow: (72 + shift * 14) * DEG },
      ],
      legs: [
        { swing: (3 + shift * 16 * drive) * DEG, lift: 5 * DEG,
          knee: (14 + Math.max(0, -shift) * 18) * DEG },
        { swing: (3 - shift * 16 * drive) * DEG, lift: 5 * DEG,
          knee: (14 + Math.max(0, shift) * 18) * DEG },
      ],
    };
  },

  /** Hands up: arms high in a wide V, bouncing on the beat. The hype move. */
  reach(bar, beat, energy, punch) {
    const hit = attack(beat);
    const wave = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -hit * (0.04 + punch * 0.03) * drive,
      sway: wave * 0.05,
      turn: wave * 8 * DEG,
      spineBend: -7 * DEG,
      spineTwist: wave * 8 * DEG,
      head: { swing: -(8 + hit * 8) * DEG, lift: wave * 5 * DEG },
      travel: 0,
      arms: [
        { swing: (-168 + wave * 6) * DEG, lift: (38 + wave * 8) * DEG, elbow: (8 + hit * 24) * DEG },
        { swing: (-168 - wave * 6) * DEG, lift: (38 - wave * 8) * DEG, elbow: (8 + hit * 24) * DEG },
      ],
      legs: [
        { swing: 3 * DEG, lift: 6 * DEG, knee: (14 + hit * 26 * drive) * DEG },
        { swing: 3 * DEG, lift: 6 * DEG, knee: (14 + hit * 26 * drive) * DEG },
      ],
    };
  },

  /** Running: knees driving, arms pumping against them, leaning into it. */
  run(bar, beat, energy) {
    const cycle = Math.sin(bar * Math.PI * 4);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -Math.abs(cycle) * 0.05 * drive,
      sway: cycle * 0.03,
      turn: 0,
      spineBend: 12 * DEG,
      spineTwist: -cycle * 14 * DEG,
      head: { swing: -4 * DEG, lift: 0 },
      travel: 0.6 * drive,
      arms: [
        { swing: (-35 + cycle * 45 * drive) * DEG, lift: 20 * DEG, elbow: (88 - cycle * 10) * DEG },
        { swing: (-35 - cycle * 45 * drive) * DEG, lift: 20 * DEG, elbow: (88 + cycle * 10) * DEG },
      ],
      legs: [
        { swing: (8 + cycle * 38 * drive) * DEG, lift: 3 * DEG,
          knee: (28 + Math.max(0, cycle) * 58) * DEG },
        { swing: (8 - cycle * 38 * drive) * DEG, lift: 3 * DEG,
          knee: (28 + Math.max(0, -cycle) * 58) * DEG },
      ],
    };
  },

  /**
   * Floss: straight arms swung together to one side, one in front of the body
   * and one behind, while the hips swing the other way.
   */
  floss(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 4);
    // Squared off, so each side is a hit that holds rather than a pendulum.
    const side = Math.sign(s) * Math.min(1, Math.abs(s) * 1.6);
    const drive = 0.75 + energy * 0.4;
    return {
      bob: -attack(beat) * 0.03,
      sway: -side * 0.11 * drive,
      turn: 0,
      spineBend: 4 * DEG,
      spineTwist: side * 10 * DEG,
      head: { swing: 4 * DEG, lift: -side * 6 * DEG },
      travel: 0,
      arms: [
        { swing: side * 22 * DEG, lift: (18 + side * 38 * drive) * DEG, elbow: 12 * DEG },
        { swing: -side * 22 * DEG, lift: (18 - side * 38 * drive) * DEG, elbow: 12 * DEG },
      ],
      legs: [
        { swing: 3 * DEG, lift: 5 * DEG, knee: (16 + Math.max(0, side) * 10) * DEG },
        { swing: 3 * DEG, lift: 5 * DEG, knee: (16 + Math.max(0, -side) * 10) * DEG },
      ],
    };
  },

  /**
   * Robot: joints locked, snapping between held positions on the eighth notes.
   * The stillness between the snaps is the move.
   */
  robot(bar, beat, energy) {
    const step = Math.floor(bar * 8) % 4;
    // Forearms level in front; one arm thrown straight out; back; the other.
    const held = [
      [[-44, 10, 82, 0.3], [-44, 10, 82, 0.3]],
      [[-92, 6, 4, 0], [-10, 16, 84, 0.5]],
      [[-44, 10, 82, 0.3], [-44, 10, 82, 0.3]],
      [[-10, 16, 84, 0.5], [-92, 6, 4, 0]],
    ][step];
    const facing = step === 1 ? 1 : step === 3 ? -1 : 0;
    const drive = 0.8 + energy * 0.3;
    return {
      bob: 0,
      sway: facing * 0.04,
      turn: facing * 18 * DEG * drive,
      spineBend: 0,
      spineTwist: -facing * 8 * DEG,
      head: { swing: 0, lift: -facing * 14 * DEG },
      travel: 0,
      arms: held.map(([swing, lift, elbow, flare]) => ({
        swing: swing * DEG, lift: lift * DEG, elbow: elbow * DEG, flare,
      })),
      legs: [
        { swing: 2 * DEG, lift: 6 * DEG, knee: 8 * DEG },
        { swing: 2 * DEG, lift: 6 * DEG, knee: 8 * DEG },
      ],
    };
  },

  /** Spin: a full turn each bar on one foot, arms held out level. */
  spin(bar, beat) {
    return {
      bob: -attack(beat) * 0.03,
      sway: 0,
      turn: bar * Math.PI * 2,
      spineBend: -4 * DEG,
      spineTwist: 0,
      head: { swing: -4 * DEG, lift: 0 },
      travel: 0.2,
      arms: [
        { swing: -80 * DEG, lift: 78 * DEG, elbow: 12 * DEG },
        { swing: -80 * DEG, lift: 78 * DEG, elbow: 12 * DEG },
      ],
      legs: [
        { swing: 4 * DEG, lift: 4 * DEG, knee: 12 * DEG },
        // The free foot tucked in beside the standing knee, as a pivot is.
        { swing: 18 * DEG, lift: 1 * DEG, knee: 64 * DEG },
      ],
    };
  },

  /**
   * Arm wave: arms out to the sides, a ripple running from one hand through
   * the shoulders to the other.
   */
  wave(bar, beat, energy) {
    const phase = bar * Math.PI * 2;
    const lead = Math.sin(phase);
    const middle = Math.sin(phase - 0.7);
    const follow = Math.sin(phase - 1.4);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -swell(beat) * 0.02,
      sway: middle * 0.06,
      turn: 0,
      spineBend: 2 * DEG,
      spineTwist: 0,
      head: { swing: 0, lift: -middle * 10 * DEG },
      travel: 0,
      arms: [
        { swing: -20 * DEG, lift: (86 + lead * 22 * drive) * DEG,
          elbow: (16 + (1 - lead) * 18) * DEG },
        { swing: -20 * DEG, lift: (86 + follow * 22 * drive) * DEG,
          elbow: (16 + (1 - follow) * 18) * DEG },
      ],
      legs: [
        { swing: 3 * DEG, lift: 5 * DEG, knee: (16 + Math.max(0, middle) * 10) * DEG },
        { swing: 3 * DEG, lift: 5 * DEG, knee: (16 + Math.max(0, -middle) * 10) * DEG },
      ],
    };
  },

  /** Jump: crouch with the arms back, spring up with them thrown high, tuck, land. */
  jump(bar, beat, energy) {
    // A cycle across the bar rather than a sine, so the crouch and the landing
    // are distinct beats instead of a continuous bounce.
    const crouch = Math.max(0, 1 - Math.abs(bar - 0.10) * 7);
    const air = Math.max(0, Math.sin((bar - 0.18) * Math.PI * 1.5));
    const land = Math.max(0, 1 - Math.abs(bar - 0.88) * 9);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -crouch * 0.16 - land * 0.08 + air * 0.4 * drive,
      sway: 0,
      turn: 0,
      spineBend: (crouch * 26 + land * 14 - air * 8) * DEG,
      spineTwist: 0,
      head: { swing: (crouch * 12 - air * 14) * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (crouch * 30 - air * 172 - land * 50) * DEG, lift: (16 + air * 16) * DEG,
          elbow: (22 - air * 12) * DEG },
        { swing: (crouch * 30 - air * 172 - land * 50) * DEG, lift: (16 + air * 16) * DEG,
          elbow: (22 - air * 12) * DEG },
      ],
      legs: [
        { swing: (crouch * 20 + air * 42 + land * 16) * DEG, lift: (5 + air * 4) * DEG,
          knee: (12 + crouch * 72 + air * 76 + land * 50) * DEG },
        { swing: (crouch * 20 + air * 36 + land * 16) * DEG, lift: (5 + air * 4) * DEG,
          knee: (12 + crouch * 72 + air * 70 + land * 50) * DEG },
      ],
    };
  },

  /**
   * Sing: the mic held just under the chin, the free hand reaching out to the
   * room with the phrase.
   *
   * Reserved for the lead, which is what makes a group legible: one figure
   * sings while the others dance behind.
   */
  sing(bar, beat, energy, punch) {
    const phrase = Math.sin(bar * Math.PI * 2);
    const emphasis = attack(beat) * (0.4 + punch * 0.6);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -emphasis * 0.03,
      sway: phrase * 0.06,
      turn: phrase * 12 * DEG,
      spineBend: (-4 - emphasis * 6) * DEG,
      spineTwist: phrase * 8 * DEG,
      head: { swing: (-6 - emphasis * 8) * DEG, lift: phrase * 8 * DEG },
      travel: phrase * 0.08,
      arms: [
        // The mic at the chin rather than the mouth. A hand held over the face
        // merges the forearm into the head, which is the arm-stuck-to-the-head
        // look the figures were rewritten to lose.
        { swing: -98 * DEG, lift: -22 * DEG, elbow: 108 * DEG },
        { swing: (-80 - phrase * 25 * drive) * DEG, lift: (38 + phrase * 16) * DEG,
          elbow: (24 + emphasis * 20) * DEG },
      ],
      legs: [
        { swing: (3 + phrase * 8) * DEG, lift: 5 * DEG,
          knee: (14 + emphasis * 14 + Math.max(0, -phrase) * 8) * DEG },
        { swing: (3 - phrase * 8) * DEG, lift: 5 * DEG,
          knee: (14 + emphasis * 14 + Math.max(0, phrase) * 8) * DEG },
      ],
    };
  },

  /** Groove: a loose bounce in the knees, hips and shoulders rolling against each other. */
  groove(bar, beat, energy) {
    const hip = Math.sin(bar * Math.PI * 4);
    const roll = Math.sin(bar * Math.PI * 4 + 1.6);
    const bounce = attack(beat);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -bounce * 0.05 * drive,
      sway: hip * 0.10 * drive,
      turn: hip * 12 * DEG,
      spineBend: (6 + roll * 5) * DEG,
      spineTwist: -roll * 14 * DEG * drive,
      head: { swing: bounce * 10 * DEG, lift: hip * 8 * DEG },
      travel: hip * 0.15,
      arms: [
        { swing: (-40 - roll * 22 * drive) * DEG, lift: (32 + hip * 10) * DEG,
          elbow: (82 + roll * 14) * DEG },
        { swing: (-40 + roll * 22 * drive) * DEG, lift: (32 - hip * 10) * DEG,
          elbow: (82 - roll * 14) * DEG },
      ],
      legs: [
        { swing: (4 + hip * 10) * DEG, lift: 6 * DEG,
          knee: (20 + bounce * 18 + Math.max(0, hip) * 10) * DEG },
        { swing: (4 - hip * 10) * DEG, lift: 6 * DEG,
          knee: (20 + bounce * 18 + Math.max(0, -hip) * 10) * DEG },
      ],
    };
  },

  /** March: knees lifted high in turn, arms driving against them. Reads at any distance. */
  march(bar, beat, energy) {
    const c = Math.sin(bar * Math.PI * 4);
    const up = [Math.max(0, c), Math.max(0, -c)];
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -Math.abs(c) * 0.02,
      sway: c * 0.04,
      turn: 0,
      spineBend: 2 * DEG,
      spineTwist: -c * 10 * DEG,
      head: { swing: 0, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-30 + c * 40 * drive) * DEG, lift: 20 * DEG, elbow: 88 * DEG },
        { swing: (-30 - c * 40 * drive) * DEG, lift: 20 * DEG, elbow: 88 * DEG },
      ],
      legs: up.map((raised) => ({
        swing: raised * 68 * drive * DEG, lift: 4 * DEG, knee: (6 + raised * 95) * DEG,
      })),
    };
  },

  /**
   * Clap: hands meeting in front of the chest on the beat, held open between.
   *
   * A held position between hits is what makes a movement read as deliberate.
   * Motions that ease continuously from one extreme to the other look like
   * drifting; pausing at the extremes looks like intent.
   */
  clap(bar, beat, energy) {
    // Closing fast over the last fifth of the beat and opening slowly after it,
    // rather than a symmetric sine. It snapped shut on the beat itself, which
    // left the pose springs no time: the hands reached 79% of their travel,
    // and after the beat rather than on it.
    const closed = beat < 0.45
      ? Math.pow(1 - beat / 0.45, 1.6)
      : Math.pow(Math.max(0, 1 - (1 - beat) / 0.18), 1.2);
    const drive = 0.75 + energy * 0.4;
    // Open wide, then crossed far enough that the two hands meet on the midline.
    const lift = (44 * drive - closed * 66) * DEG;
    return {
      bob: -closed * 0.04 * drive,
      sway: 0,
      turn: 0,
      spineBend: (4 + closed * 6) * DEG,
      spineTwist: 0,
      head: { swing: closed * 8 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: -72 * DEG, lift, elbow: (34 + closed * 10) * DEG },
        { swing: -72 * DEG, lift, elbow: (34 + closed * 10) * DEG },
      ],
      legs: [
        { swing: 3 * DEG, lift: 5 * DEG, knee: (14 + closed * 16) * DEG },
        { swing: 3 * DEG, lift: 5 * DEG, knee: (14 + closed * 16) * DEG },
      ],
    };
  },

  /**
   * Point: one arm thrown up to the far corner and held, the other hand on the
   * hip, changing sides each half bar.
   */
  point(bar, beat) {
    const half = Math.floor(bar * 2) % 2;
    const within = (bar * 2) % 1;
    // Out fast, held, back at the end. Holding is the whole gesture; a
    // pointing arm that keeps moving is just waving.
    const held = within < 0.8 ? Math.min(1, within * 8) : 1 - (within - 0.8) * 5;
    const pointing = {
      swing: (-60 - held * 100) * DEG, lift: (20 + held * 18) * DEG, elbow: (40 - held * 36) * DEG,
    };
    const onHip = { swing: 8 * DEG, lift: 12 * DEG, elbow: 104 * DEG, flare: 1 };
    const side = half === 0 ? 1 : -1;
    return {
      bob: -attack(beat) * 0.03,
      sway: -side * held * 0.07,
      turn: side * held * 12 * DEG,
      spineBend: -4 * DEG,
      spineTwist: side * held * 10 * DEG,
      head: { swing: -held * 10 * DEG, lift: side * held * 8 * DEG },
      travel: 0,
      arms: half === 0 ? [pointing, onHip] : [onHip, pointing],
      legs: [
        { swing: 3 * DEG, lift: (5 + (half === 0 ? held * 5 : 0)) * DEG,
          knee: (half === 0 ? 8 : 24) * DEG },
        { swing: 3 * DEG, lift: (5 + (half === 1 ? held * 5 : 0)) * DEG,
          knee: (half === 1 ? 8 : 24) * DEG },
      ],
    };
  },

  /** Headbang: a hard nod on the beat with the whole spine following it down. */
  headbang(bar, beat, energy) {
    const hit = attack(beat);
    const drive = 0.75 + energy * 0.4;
    return {
      bob: -hit * 0.05 * drive,
      sway: 0,
      turn: 0,
      spineBend: (10 + hit * 22 * drive) * DEG,
      spineTwist: 0,
      head: { swing: (-10 + hit * 44 * drive) * DEG, lift: 0 },
      travel: 0,
      // Fists low and pumping with the nod.
      arms: [
        { swing: (-36 - hit * 30) * DEG, lift: 26 * DEG, elbow: (96 - hit * 20) * DEG },
        { swing: (-36 - hit * 30) * DEG, lift: 26 * DEG, elbow: (96 - hit * 20) * DEG },
      ],
      legs: [
        { swing: 6 * DEG, lift: 8 * DEG, knee: (24 + hit * 14) * DEG },
        { swing: 6 * DEG, lift: 8 * DEG, knee: (24 + hit * 14) * DEG },
      ],
    };
  },

  /** Shimmy: shoulders shaking fast over steady hips, leaning in. */
  shimmy(bar, beat, energy) {
    // Much faster than the bar: the contrast between quick shoulders and a
    // steady base is what makes it read as a shimmy.
    const shake = Math.sin(bar * Math.PI * 16);
    const drive = 0.75 + energy * 0.4;
    return {
      bob: -attack(beat) * 0.02,
      sway: Math.sin(bar * Math.PI * 2) * 0.05,
      turn: 0,
      spineBend: 12 * DEG,
      spineTwist: shake * 16 * DEG * drive,
      head: { swing: -6 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-34 - shake * 10) * DEG, lift: 30 * DEG, elbow: 96 * DEG, flare: 0.4 },
        { swing: (-34 + shake * 10) * DEG, lift: 30 * DEG, elbow: 96 * DEG, flare: 0.4 },
      ],
      legs: [
        { swing: 6 * DEG, lift: 7 * DEG, knee: 28 * DEG },
        { swing: 6 * DEG, lift: 7 * DEG, knee: 28 * DEG },
      ],
    };
  },

  /** Kick: a straight leg thrown forward on the beat, arms out for balance. */
  kick(bar, beat, energy) {
    const phase = (bar * 2) % 1;
    const out = Math.pow(Math.max(0, 1 - Math.abs(phase - 0.25) * 5), 1.3);
    const side = bar < 0.5 ? 0 : 1;
    const drive = 0.75 + energy * 0.45;
    const kicking = { swing: out * 72 * drive * DEG, lift: 4 * DEG, knee: (8 + (1 - out) * 22) * DEG };
    const standing = { swing: -4 * DEG, lift: 5 * DEG, knee: (12 + out * 10) * DEG };
    return {
      bob: out * 0.02,
      sway: (side === 0 ? -1 : 1) * 0.05,
      turn: 0,
      spineBend: -out * 10 * DEG,
      spineTwist: (side === 0 ? 1 : -1) * out * 10 * DEG,
      head: { swing: -6 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-40 - out * 20) * DEG, lift: (50 + out * 14) * DEG, elbow: 30 * DEG },
        { swing: (-40 - out * 20) * DEG, lift: (50 + out * 14) * DEG, elbow: 30 * DEG },
      ],
      legs: side === 0 ? [kicking, standing] : [standing, kicking],
    };
  },

  /** Electric slide: stepping out and closing, sideways, the arms opening with it. */
  slide(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const open = Math.abs(s);
    const drive = 0.75 + energy * 0.4;
    return {
      bob: -attack(beat) * 0.03,
      sway: s * 0.10 * drive,
      turn: s * 8 * DEG,
      spineBend: 4 * DEG,
      spineTwist: -s * 8 * DEG,
      head: { swing: 0, lift: s * 10 * DEG },
      travel: s * 0.6 * drive,
      arms: [
        { swing: -50 * DEG, lift: (26 + Math.max(0, s) * 44) * DEG, elbow: (60 - Math.max(0, s) * 40) * DEG },
        { swing: -50 * DEG, lift: (26 + Math.max(0, -s) * 44) * DEG, elbow: (60 - Math.max(0, -s) * 40) * DEG },
      ],
      legs: [
        { swing: 2 * DEG, lift: (5 + Math.max(0, s) * 10 * drive) * DEG, knee: (14 + open * 10) * DEG },
        { swing: 2 * DEG, lift: (5 + Math.max(0, -s) * 10 * drive) * DEG, knee: (14 + open * 10) * DEG },
      ],
    };
  },

  // --- Named dances --------------------------------------------------------

  /** Moonwalk: gliding backwards while appearing to walk forwards. */
  moonwalk(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.5;
    // One leg straight and sliding back flat while the other bends onto its
    // toe. The illusion is entirely in the contrast between the two.
    const sliding = (amount) => ({
      swing: (4 - amount * 26 * drive) * DEG, lift: 3 * DEG, knee: 6 * DEG,
    });
    const onToe = { swing: 10 * DEG, lift: 3 * DEG, knee: 42 * DEG };
    const back = Math.max(0, s);
    const forth = Math.max(0, -s);
    return {
      bob: 0,
      sway: s * 0.03,
      turn: 0,
      spineBend: 6 * DEG,
      spineTwist: -s * 6 * DEG,
      head: { swing: 6 * DEG, lift: s * 5 * DEG },
      travel: -0.4 * drive,
      arms: [
        { swing: (-20 - s * 18) * DEG, lift: 24 * DEG, elbow: (44 + s * 12) * DEG },
        { swing: (-20 + s * 18) * DEG, lift: 24 * DEG, elbow: (44 - s * 12) * DEG },
      ],
      legs: s >= 0 ? [sliding(back), onToe] : [onToe, sliding(forth)],
    };
  },

  /** The Twist: hips and shoulders turning against each other, knees bent low. */
  twist(bar, beat, energy) {
    // Twice a bar: the Twist is a fast alternation rather than a sway.
    const s = Math.sin(bar * Math.PI * 4);
    const drive = 0.75 + energy * 0.4;
    return {
      bob: -Math.abs(s) * 0.03 - 0.03,
      sway: 0,
      turn: s * 24 * DEG * drive,
      spineBend: 8 * DEG,
      spineTwist: -s * 36 * DEG * drive,
      head: { swing: 4 * DEG, lift: -s * 6 * DEG },
      travel: 0,
      arms: [
        { swing: (-56 - s * 24) * DEG, lift: 40 * DEG, elbow: 96 * DEG, flare: 0.5 },
        { swing: (-56 + s * 24) * DEG, lift: 40 * DEG, elbow: 96 * DEG, flare: 0.5 },
      ],
      legs: [
        { swing: 10 * DEG, lift: 6 * DEG, knee: (30 + s * 8) * DEG },
        { swing: 10 * DEG, lift: 6 * DEG, knee: (30 - s * 8) * DEG },
      ],
    };
  },

  /** Charleston: heels flicking back in turn, arms swinging against the legs. */
  charleston(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const flick = Math.sin(bar * Math.PI * 4);
    const drive = 0.75 + energy * 0.45;
    return {
      bob: attack(beat) * 0.04 * drive,
      sway: s * 0.06,
      turn: s * 10 * DEG,
      spineBend: 6 * DEG,
      spineTwist: -s * 12 * DEG,
      head: { swing: -4 * DEG, lift: s * 8 * DEG },
      travel: s * 0.10,
      // Arms swing opposite the legs, elbows loose and high - the twenties look.
      arms: [
        { swing: (-50 + s * 46 * drive) * DEG, lift: 30 * DEG, elbow: 62 * DEG },
        { swing: (-50 - s * 46 * drive) * DEG, lift: 30 * DEG, elbow: 62 * DEG },
      ],
      // Heels flick backwards rather than the knees lifting forwards, which is
      // what separates a Charleston from a march.
      legs: [
        { swing: (4 - Math.max(0, flick) * 36) * DEG, lift: 6 * DEG,
          knee: (12 + Math.max(0, flick) * 92) * DEG },
        { swing: (4 - Math.max(0, -flick) * 36) * DEG, lift: 6 * DEG,
          knee: (12 + Math.max(0, -flick) * 92) * DEG },
      ],
    };
  },

  /** Running Man: a knee lifting as the other foot slides back under it. */
  runningman(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 4);
    const drive = 0.75 + energy * 0.45;
    const leg = (up) => ({
      swing: (up > 0 ? up * 62 : up * 30) * drive * DEG,
      lift: 4 * DEG,
      knee: (14 + Math.max(0, up) * 88) * DEG,
    });
    return {
      bob: -Math.abs(s) * 0.03,
      sway: 0,
      turn: 0,
      spineBend: 8 * DEG,
      spineTwist: -s * 10 * DEG,
      head: { swing: 6 * DEG, lift: 0 },
      travel: 0,
      // Fists pumping at chest height, pulling down as the knee comes up.
      arms: [
        { swing: (-70 - s * 30) * DEG, lift: 26 * DEG, elbow: (96 - s * 12) * DEG },
        { swing: (-70 + s * 30) * DEG, lift: 26 * DEG, elbow: (96 + s * 12) * DEG },
      ],
      legs: [leg(s), leg(-s)],
    };
  },

  /** The Dougie: a lean back and a rock of the shoulders, one hand brushing past the head. */
  dougie(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 4);
    const hand = Math.floor(bar * 2) % 2;
    const drive = 0.75 + energy * 0.4;
    const brush = { swing: (-150 + s * 10) * DEG, lift: 52 * DEG, elbow: 104 * DEG, flare: 0.8 };
    const low = { swing: (-26 - s * 14) * DEG, lift: 26 * DEG, elbow: 54 * DEG };
    return {
      bob: -attack(beat) * 0.04 * drive,
      sway: s * 0.10 * drive,
      turn: s * 14 * DEG,
      spineBend: -8 * DEG,
      spineTwist: s * 14 * DEG,
      head: { swing: -6 * DEG, lift: s * 12 * DEG },
      travel: 0,
      arms: hand === 0 ? [brush, low] : [low, brush],
      legs: [
        { swing: (4 + s * 8) * DEG, lift: 6 * DEG, knee: (20 + Math.max(0, -s) * 16) * DEG },
        { swing: (4 - s * 8) * DEG, lift: 6 * DEG, knee: (20 + Math.max(0, s) * 16) * DEG },
      ],
    };
  },

  /** Gangnam Style: one hand on the reins, the other swinging the lasso, a galloping hop. */
  gangnam(bar, beat, energy) {
    const gallop = Math.sin(bar * Math.PI * 8);
    const circle = bar * Math.PI * 4;
    const drive = 0.75 + energy * 0.45;
    return {
      bob: Math.max(0, gallop) * 0.05 * drive,
      sway: 0,
      turn: 0,
      spineBend: 6 * DEG,
      spineTwist: Math.sin(circle) * 8 * DEG,
      head: { swing: -6 * DEG, lift: Math.sin(circle) * 6 * DEG },
      travel: 0,
      arms: [
        // The lasso: overhead, the hand circling.
        { swing: (-160 + Math.cos(circle) * 10) * DEG, lift: (36 + Math.sin(circle) * 10) * DEG,
          elbow: 36 * DEG, flare: 0.6 },
        // The reins: low in front, across the body.
        { swing: -52 * DEG, lift: -14 * DEG, elbow: 70 * DEG },
      ],
      legs: [
        { swing: (6 + Math.max(0, gallop) * 26) * DEG, lift: 6 * DEG,
          knee: (22 + Math.max(0, gallop) * 44) * DEG },
        { swing: (6 + Math.max(0, -gallop) * 26) * DEG, lift: 6 * DEG,
          knee: (22 + Math.max(0, -gallop) * 44) * DEG },
      ],
    };
  },

  /** Macarena: the arm sequence, one position a beat, the hips rolling underneath. */
  macarena(bar, beat, energy) {
    // Distinct positions rather than a continuous curve: the Macarena is a
    // sequence, and a smooth blend would erase it. Arm 1 runs a beat behind.
    const positions = [
      { swing: -88, lift: 14, elbow: 8, flare: 0 },     // out in front
      { swing: -76, lift: -30, elbow: 104, flare: 0.3 }, // to the opposite shoulder
      { swing: -160, lift: 30, elbow: 108, flare: 1 },   // behind the head
      { swing: 6, lift: 10, elbow: 104, flare: 1 },       // on the hips
    ];
    const stage = Math.floor(bar * 4) % 4;
    const at = (index) => {
      const p = positions[index];
      return { swing: p.swing * DEG, lift: p.lift * DEG, elbow: p.elbow * DEG, flare: p.flare };
    };
    const s = Math.sin(bar * Math.PI * 4);
    return {
      bob: -attack(beat) * 0.03,
      sway: s * 0.08,
      turn: 0,
      spineBend: 2 * DEG,
      spineTwist: 0,
      head: { swing: 4 * DEG, lift: s * 6 * DEG },
      travel: 0,
      arms: [at(stage), at((stage + 3) % 4)],
      legs: [
        { swing: 3 * DEG, lift: 5 * DEG, knee: (16 + Math.max(0, -s) * 12) * DEG },
        { swing: 3 * DEG, lift: 5 * DEG, knee: (16 + Math.max(0, s) * 12) * DEG },
      ],
    };
  },

  /** Vogue: sharp frames around the face, snapping from one held pose to the next. */
  vogue(bar, beat, energy) {
    // Held positions with hard changes between them, because voguing is posing.
    const frames = [
      [{ swing: -172, lift: 20, elbow: 6 }, { swing: -120, lift: 60, elbow: 104, flare: 1 }],
      [{ swing: -96, lift: 76, elbow: 6 }, { swing: -140, lift: 40, elbow: 108, flare: 1 }],
      [{ swing: -120, lift: 60, elbow: 104, flare: 1 }, { swing: -172, lift: 20, elbow: 6 }],
      [{ swing: -140, lift: 40, elbow: 108, flare: 1 }, { swing: -96, lift: 76, elbow: 6 }],
    ];
    const stage = Math.floor(bar * 4) % 4;
    const side = stage % 2 === 0 ? 1 : -1;
    return {
      bob: 0,
      sway: side * 0.06,
      turn: side * 14 * DEG,
      spineBend: -4 * DEG,
      spineTwist: -side * 10 * DEG,
      head: { swing: -4 * DEG, lift: side * 14 * DEG },
      travel: 0,
      arms: frames[stage].map((p) => ({
        swing: p.swing * DEG, lift: p.lift * DEG, elbow: p.elbow * DEG, flare: p.flare ?? 0,
      })),
      legs: [
        { swing: (side > 0 ? 3 : 14) * DEG, lift: 6 * DEG, knee: (side > 0 ? 8 : 30) * DEG },
        { swing: (side > 0 ? 14 : 3) * DEG, lift: 6 * DEG, knee: (side > 0 ? 30 : 8) * DEG },
      ],
    };
  },

  /** Cabbage Patch: fists together in front of the chest, circling. */
  cabbagepatch(bar, beat, energy) {
    const around = bar * Math.PI * 4;
    const drive = 0.75 + energy * 0.4;
    return {
      bob: -attack(beat) * 0.04,
      sway: Math.cos(around) * 0.07 * drive,
      turn: 0,
      spineBend: (8 + Math.sin(around) * 4) * DEG,
      spineTwist: Math.cos(around) * 12 * DEG,
      head: { swing: 6 * DEG, lift: Math.cos(around) * 8 * DEG },
      travel: 0,
      // Both hands trace one circle: out and forward, across and back.
      arms: [
        { swing: (-66 - Math.sin(around) * 18) * DEG, lift: (-6 + Math.cos(around) * 18) * DEG,
          elbow: 100 * DEG, flare: 0.6 },
        { swing: (-66 - Math.sin(around) * 18) * DEG, lift: (-6 - Math.cos(around) * 18) * DEG,
          elbow: 100 * DEG, flare: 0.6 },
      ],
      legs: [
        { swing: 4 * DEG, lift: 6 * DEG, knee: (24 + Math.max(0, Math.cos(around)) * 12) * DEG },
        { swing: 4 * DEG, lift: 6 * DEG, knee: (24 + Math.max(0, -Math.cos(around)) * 12) * DEG },
      ],
    };
  },

  /** The Sprinkler: one hand behind the head, the other arm sweeping round in steps. */
  sprinkler(bar, beat, energy) {
    // Sweeps out in beats and snaps back, like the garden sprinkler it is named
    // after. The asymmetry between the two arms is the joke and the mechanic.
    const within = (bar * 2) % 1;
    const sweep = Math.floor(within * 4) / 3;
    const back = within > 0.85 ? (within - 0.85) / 0.15 : 0;
    const across = Math.min(1, sweep) * (1 - back);
    return {
      bob: -attack(beat) * 0.04,
      sway: (across - 0.5) * 0.08,
      turn: (across - 0.5) * 30 * DEG,
      spineBend: 6 * DEG,
      spineTwist: 0,
      head: { swing: 4 * DEG, lift: (across - 0.5) * 16 * DEG },
      travel: 0,
      arms: [
        { swing: -90 * DEG, lift: (-18 + across * 88) * DEG, elbow: 8 * DEG },
        { swing: -156 * DEG, lift: 42 * DEG, elbow: 108 * DEG, flare: 1 },
      ],
      legs: [
        { swing: 4 * DEG, lift: 6 * DEG, knee: 20 * DEG },
        { swing: 10 * DEG, lift: 6 * DEG, knee: 30 * DEG },
      ],
    };
  },

  /** Disco point: one arm stabbing up to the far corner, then down across the body. */
  discopoint(bar, beat, energy) {
    // Up on one beat, down on the next; the other hand on the hip throughout.
    const up = Math.floor(bar * 4) % 2 === 0;
    const side = Math.floor(bar * 2) % 2;
    const hit = attack(beat);
    const pointing = up
      ? { swing: -164 * DEG, lift: 34 * DEG, elbow: 4 * DEG }
      : { swing: -24 * DEG, lift: -34 * DEG, elbow: 6 * DEG };
    const onHip = { swing: 8 * DEG, lift: 12 * DEG, elbow: 104 * DEG, flare: 1 };
    const lean = side === 0 ? 1 : -1;
    return {
      bob: -hit * 0.04,
      sway: (up ? -lean : lean) * 0.07,
      turn: lean * 10 * DEG,
      spineBend: (up ? -6 : 8) * DEG,
      spineTwist: (up ? lean : -lean) * 10 * DEG,
      head: { swing: (up ? -12 : 10) * DEG, lift: (up ? lean : -lean) * 10 * DEG },
      travel: 0,
      arms: side === 0 ? [pointing, onHip] : [onHip, pointing],
      legs: [
        { swing: 4 * DEG, lift: (side === 0 ? 10 : 5) * DEG, knee: (side === 0 ? 8 : 22) * DEG },
        { swing: 4 * DEG, lift: (side === 1 ? 10 : 5) * DEG, knee: (side === 1 ? 8 : 22) * DEG },
      ],
    };
  },

  /** Two-step: side, together, side - the club default, fingers snapping at the hips. */
  twostep(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const out = [Math.max(0, s), Math.max(0, -s)];
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -attack(beat) * 0.04 * drive,
      sway: s * 0.10 * drive,
      turn: s * 8 * DEG,
      spineBend: 5 * DEG,
      spineTwist: -s * 10 * DEG,
      head: { swing: attack(beat) * 6 * DEG, lift: s * 8 * DEG },
      travel: s * 0.3 * drive,
      arms: [
        { swing: (-44 + s * 16) * DEG, lift: 32 * DEG, elbow: (86 + attack(beat) * 10) * DEG },
        { swing: (-44 - s * 16) * DEG, lift: 32 * DEG, elbow: (86 + attack(beat) * 10) * DEG },
      ],
      legs: out.map((stepping) => ({
        swing: 3 * DEG, lift: (5 + stepping * 9 * drive) * DEG, knee: (14 + (1 - stepping) * 12) * DEG,
      })),
    };
  },

  /** Melbourne shuffle: fast heel-toe steps, one foot kicking out low as the other slides. */
  shuffle(bar, beat, energy) {
    // Twice the rate of an ordinary step: the shuffle is defined by being faster
    // than the music appears to demand.
    const s = Math.sin(bar * Math.PI * 8);
    const drive = 0.75 + energy * 0.45;
    const leg = (k) => ({
      swing: (k > 0 ? k * 34 : k * 12) * drive * DEG,
      lift: (4 + Math.max(0, k) * 4) * DEG,
      knee: (14 + Math.max(0, -k) * 26) * DEG,
    });
    return {
      bob: -Math.abs(s) * 0.03,
      sway: s * 0.04,
      turn: 0,
      spineBend: 8 * DEG,
      spineTwist: -s * 8 * DEG,
      head: { swing: 6 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-34 - s * 22) * DEG, lift: 26 * DEG, elbow: 84 * DEG },
        { swing: (-34 + s * 22) * DEG, lift: 26 * DEG, elbow: 84 * DEG },
      ],
      legs: [leg(s), leg(-s)],
    };
  },

  /** Y.M.C.A.: the four letters, one a beat. */
  ymca(bar, beat, energy) {
    // Y: arms up and out. M: hands to the top of the head, elbows wide.
    // C: both arms curved to one side. A: arms up and together.
    const letters = [
      [{ swing: -168, lift: 32, elbow: 4 }, { swing: -168, lift: 32, elbow: 4 }],
      [{ swing: -150, lift: 58, elbow: 110, flare: 1 }, { swing: -150, lift: 58, elbow: 110, flare: 1 }],
      [{ swing: -146, lift: 62, elbow: 46 }, { swing: -120, lift: -16, elbow: 58 }],
      [{ swing: -176, lift: 6, elbow: 10 }, { swing: -176, lift: 6, elbow: 10 }],
    ];
    const stage = Math.floor(bar * 4) % 4;
    return {
      bob: -attack(beat) * 0.04,
      sway: stage === 2 ? 0.06 : 0,
      turn: 0,
      spineBend: -4 * DEG,
      spineTwist: 0,
      head: { swing: -8 * DEG, lift: stage === 2 ? -10 * DEG : 0 },
      travel: 0,
      arms: letters[stage].map((p) => ({
        swing: p.swing * DEG, lift: p.lift * DEG, elbow: p.elbow * DEG, flare: p.flare ?? 0,
      })),
      legs: [
        { swing: 3 * DEG, lift: 6 * DEG, knee: (12 + attack(beat) * 12) * DEG },
        { swing: 3 * DEG, lift: 6 * DEG, knee: (12 + attack(beat) * 12) * DEG },
      ],
    };
  },

  /** Salsa basic: a rock step forward and back on one-two-three, the hips leading. */
  salsa(bar, beat, energy) {
    // Quick-quick-slow across the bar, the fourth beat held.
    const count = bar * 4;
    const phase = count < 3 ? Math.sin((count / 3) * Math.PI * 2) : 0;
    const hips = Math.sin(bar * Math.PI * 4);
    const drive = 0.75 + energy * 0.45;
    return {
      bob: -attack(beat) * 0.03,
      sway: hips * 0.09 * drive,
      turn: hips * 8 * DEG,
      spineBend: 4 * DEG,
      spineTwist: -hips * 10 * DEG,
      head: { swing: 2 * DEG, lift: hips * 8 * DEG },
      travel: 0,
      // The frame held: elbows out, forearms forward, as if holding a partner.
      arms: [
        { swing: -58 * DEG, lift: 40 * DEG, elbow: 96 * DEG, flare: 0.7 },
        { swing: -58 * DEG, lift: 40 * DEG, elbow: 96 * DEG, flare: 0.7 },
      ],
      legs: [
        { swing: (3 + phase * 18 * drive) * DEG, lift: 5 * DEG,
          knee: (14 + Math.max(0, -phase) * 14) * DEG },
        { swing: (3 - phase * 12 * drive) * DEG, lift: 5 * DEG,
          knee: (14 + Math.max(0, phase) * 14) * DEG },
      ],
    };
  },

  /**
   * Gentle weight shift, for passages that are quiet but still playing.
   *
   * It exists because the only alternative for a quiet section was `idle`, which
   * is small enough that figures read as having stopped altogether. Measured
   * across the 46 cached scores, 28 of 431 sections fall below the old cutoff,
   * and only 9 of those are near-silent enough for stillness to be right; the
   * other 19 are quiet passages that simply froze.
   *
   * Everything is driven from the hips, because that is what a sway is: a weight
   * transfer the rest of the body follows. The arms hang and drift rather than
   * gesturing, and the knees soften alternately to take the load.
   */
  sway(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -swell(beat) * 0.015 - Math.abs(s) * 0.01,
      sway: s * 0.13 * drive,
      turn: s * 8 * DEG,
      spineBend: 3 * DEG,
      // Shoulders counter the hips, which keeps a sway balanced rather than leaning.
      spineTwist: -s * 10 * DEG,
      head: { swing: 4 * DEG, lift: s * 8 * DEG },
      // No travel at all. A quiet section that wanders across the stage reads as
      // restlessness, which is the opposite of what this is for.
      travel: 0,
      arms: [
        { swing: (-14 - s * 14) * DEG, lift: (20 + s * 6) * DEG, elbow: (30 + s * 12) * DEG },
        { swing: (-14 + s * 14) * DEG, lift: (20 - s * 6) * DEG, elbow: (30 - s * 12) * DEG },
      ],
      legs: [
        { swing: (3 + s * 5) * DEG, lift: 5 * DEG, knee: (14 + Math.max(0, -s) * 14) * DEG },
        { swing: (3 - s * 5) * DEG, lift: 5 * DEG, knee: (14 + Math.max(0, s) * 14) * DEG },
      ],
    };
  },

  /** Near-stillness: breathing, a small shift, arms at rest. Only for near-silence. */
  idle(bar) {
    const s = Math.sin(bar * Math.PI * 2);
    return {
      bob: -Math.abs(s) * 0.008,
      sway: s * 0.04,
      turn: s * 6 * DEG,
      spineBend: 3 * DEG,
      spineTwist: -s * 5 * DEG,
      head: { swing: 4 * DEG, lift: s * 5 * DEG },
      travel: 0,
      arms: [
        { swing: (-10 - s * 6) * DEG, lift: 20 * DEG, elbow: 22 * DEG },
        { swing: (-10 + s * 6) * DEG, lift: 20 * DEG, elbow: 22 * DEG },
      ],
      legs: [
        { swing: 2 * DEG, lift: 5 * DEG, knee: 10 * DEG },
        { swing: 2 * DEG, lift: 5 * DEG, knee: 10 * DEG },
      ],
    };
  },
};

/**
 * Section energy below which the figures genuinely stand still.
 *
 * There used to be one cutoff at 0.16 and it did two jobs badly: it was the
 * boundary between "dance" and "stand still", with nothing in between, so a
 * section at 0.159 froze and one at 0.161 got a full routine.
 *
 * Both numbers come from the 46 analysed scores in `activity/cache`, 431
 * sections in total. The distribution runs p5=0.120, p10=0.205, p50=0.444,
 * p90=0.660, so the old 0.16 sat around the seventh percentile - and 28 sections
 * fell below it. Inspecting those, 9 are below 0.05 and are real near-silence
 * (intros, outros, breakdowns) where stillness is correct. The other 19 are
 * quiet passages that are unambiguously still playing, and those are the ones
 * that read as broken.
 *
 * So: stillness only below 0.05, a genuinely low-energy move up to 0.20, and the
 * ordinary vocabulary above that.
 */
const CALM_ENERGY = 0.05;
const QUIET_ENERGY = 0.20;

/**
 * Pick a move for a section from its measured character.
 *
 * The fallback for a supplied choreography that names no move this file knows.
 * Every other track is danced from `planChoreography`, which replaced this as
 * the source of the dance: chosen by section index, it walked the same list in
 * the same order for every song.
 */
export function moveForSection(section) {
  const { energy_mean: energy, brightness_mean: brightness, index } = section;
  const big = ['reach', 'jump', 'run', 'floss', 'march', 'kick', 'headbang',
    'runningman', 'charleston', 'gangnam', 'discopoint', 'shuffle', 'ymca'];
  const mid = ['step', 'groove', 'robot', 'wave', 'shimmy', 'slide', 'clap', 'point',
    'twist', 'dougie', 'macarena', 'vogue', 'cabbagepatch', 'sprinkler',
    'twostep', 'salsa', 'moonwalk'];
  const calm = ['sway', 'wave', 'sway', 'sing'];
  if (energy < CALM_ENERGY) return 'idle';
  if (energy < QUIET_ENERGY) return calm[index % calm.length];
  if (energy > 0.50 && brightness > 0.35) return big[index % big.length];
  if (energy > 0.38) return index % 5 === 4 ? 'spin' : big[index % big.length];
  return mid[index % mid.length];
}

// --- Choreography plan --------------------------------------------------------

/**
 * Dance styles: one per song, so a whole track reads as one piece of
 * choreography rather than a shuffle of unrelated moves.
 *
 * Each style has three tiers of intensity and a hook - the signature move its
 * choruses come back to, which is what makes a chorus recognisable the second
 * time it arrives. Between them the styles cover every move in {@link MOVES}
 * except `idle`, reserved for near-silence, and `sing`, which is the lead's.
 *
 * There is no swing or Latin style, though the moves are here. Nothing in the
 * analysis can tell when a song suits a Charleston or a salsa, and as a style it
 * kept landing on the wrong songs - a metal track, then a hip-hop mashup, each
 * with a salsa hook. As moves inside other styles they read as flavour; as the
 * whole dance they read as a mistake.
 */
const STYLES = {
  pop: {
    low: ['step', 'sway', 'twostep'],
    mid: ['clap', 'point', 'wave', 'shimmy', 'macarena', 'slide', 'twist'],
    high: ['reach', 'jump', 'floss', 'discopoint', 'spin', 'charleston'],
    hook: ['clap', 'floss', 'macarena'],
    drop: 'jump',
  },
  groove: {
    low: ['sway', 'twostep', 'groove'],
    mid: ['dougie', 'groove', 'shimmy', 'point', 'sprinkler', 'moonwalk'],
    high: ['runningman', 'cabbagepatch', 'jump', 'floss'],
    hook: ['dougie', 'cabbagepatch', 'runningman'],
    drop: 'jump',
  },
  disco: {
    low: ['step', 'twostep', 'sway'],
    mid: ['discopoint', 'shimmy', 'moonwalk', 'groove', 'vogue', 'robot', 'salsa'],
    high: ['discopoint', 'spin', 'ymca', 'vogue', 'jump'],
    hook: ['discopoint', 'ymca', 'vogue'],
    drop: 'spin',
  },
  club: {
    low: ['twostep', 'groove', 'step'],
    mid: ['shuffle', 'runningman', 'slide', 'robot', 'twostep'],
    high: ['jump', 'shuffle', 'reach', 'runningman', 'gangnam'],
    hook: ['shuffle', 'runningman', 'gangnam'],
    drop: 'jump',
  },
  rock: {
    low: ['step', 'march', 'sway'],
    mid: ['headbang', 'march', 'kick', 'point', 'run', 'charleston'],
    high: ['jump', 'headbang', 'kick', 'reach'],
    hook: ['headbang', 'jump', 'kick'],
    drop: 'jump',
  },
  ballad: {
    low: ['sway', 'step', 'twostep'],
    mid: ['wave', 'sway', 'groove', 'step'],
    high: ['reach', 'wave', 'spin'],
    hook: ['wave', 'reach'],
    drop: 'reach',
  },
};

/**
 * Which styles suit a felt tempo, most natural first.
 *
 * Tempo is the one fact about genre the analysis is sure of - confidence ran
 * 0.96 to 0.98 across the cached tracks - so it narrows the field, and the
 * audio's character and the song's seed choose within it.
 *
 * @param {number} bpm Felt tempo; see {@link songCharacter}.
 * @returns {string[]}
 */
function stylesForTempo(bpm) {
  if (bpm < 92) return ['ballad', 'groove'];
  if (bpm < 112) return ['groove', 'pop', 'disco'];
  if (bpm < 124) return ['disco', 'pop', 'groove'];
  if (bpm < 136) return ['club', 'disco', 'pop'];
  if (bpm < 150) return ['rock', 'pop', 'club'];
  return ['rock', 'club'];
}

/** FNV-1a: a stable 32-bit hash of a string. */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A small seeded generator, so a song's choreography is a property of the
 * song: every viewer gets the same dance, and a seek lands in the same routine.
 *
 * @param {number} seed
 * @returns {() => number} Uniform in [0, 1).
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean of a lane, or a fallback when the lane is missing. */
function laneMean(lane, fallback) {
  if (!Array.isArray(lane) || lane.length === 0) return fallback;
  let sum = 0;
  for (const value of lane) sum += value;
  return sum / lane.length;
}

/**
 * Where a value sits among the songs this was calibrated on: 0.25 at their
 * lower quartile, 0.75 at their upper, clamped to 0-1.
 *
 * The raw lanes span narrow ranges - brightness ran 0.31 to 0.55 across the
 * twenty-two cached tracks, punch 0.13 to 0.26 - so a fit written in raw units
 * compares numbers on different scales, and one style simply wins everywhere.
 */
function placed(value, [q25, q75]) {
  return Math.min(1, Math.max(0, 0.25 + ((value - q25) / Math.max(1e-6, q75 - q25)) * 0.5));
}

/** Quartiles of each trait over the twenty-two cached tracks, 25 September 2026. */
const TRAIT_QUARTILES = {
  energy: [0.390, 0.530],
  brightness: [0.381, 0.473],
  punch: [0.160, 0.191],
  bass: [0.290, 0.353],
  range: [0.231, 0.546],
};

/**
 * The song's character: the few numbers that decide how it should be danced,
 * each placed against the calibration songs, and the tempo it is *felt* at.
 *
 * ## Felt tempo
 *
 * Beat tracking reports a slow groove at double time as readily as not: two
 * R&B tracks felt at 67 and 70 came back as 134 and 140, and were planned as
 * rock - headbanging - which is the wrong dance entirely. What separates them
 * from genuinely fast music is that they are quiet, or dark with a heavy low
 * end; the fast rock tracks in the cache are bright and loud. So a fast song
 * that is quiet, or dark and bass-heavy, is danced at half its tracked tempo.
 *
 * @param {object} score
 */
export function songCharacter(score) {
  const sections = score.sections ?? [];
  const energies = sections.map((section) => section.energy_mean);
  const lanes = score.lanes ?? {};
  const bassLane = laneMean(lanes.bass, 0.3);
  const raw = {
    energy: laneMean(lanes.energy, 0.45),
    brightness: laneMean(lanes.brightness, 0.42),
    punch: laneMean(lanes.punch, 0.18),
    // Share of the band energy in the lows: what separates a groove built on
    // the bass from a guitar song at the same tempo.
    bass: bassLane / Math.max(0.05, bassLane + laneMean(lanes.mid, 0.3) + laneMean(lanes.treble, 0.2)),
    range: energies.length ? Math.max(...energies) - Math.min(...energies) : 0.38,
  };
  const bpm = score.timing?.tempo_bpm > 0 ? score.timing.tempo_bpm : 120;
  const halfTime = bpm >= 128 && (raw.energy < 0.42
    || (raw.brightness < 0.43 && (raw.bass >= 0.36 || bpm >= 160)));
  return {
    bpm,
    feltBpm: halfTime ? bpm / 2 : bpm,
    raw,
    energy: placed(raw.energy, TRAIT_QUARTILES.energy),
    brightness: placed(raw.brightness, TRAIT_QUARTILES.brightness),
    punch: placed(raw.punch, TRAIT_QUARTILES.punch),
    bass: placed(raw.bass, TRAIT_QUARTILES.bass),
    range: placed(raw.range, TRAIT_QUARTILES.range),
  };
}

/**
 * How well a style fits a song's character, 0-1.
 *
 * Deliberately coarse. These are tendencies, not genre detection - which the
 * analysis cannot do - and a song landing on a neighbouring style still gets a
 * coherent dance; it only has to be a plausible one. Every trait here is placed
 * 0-1 against the calibration songs, so the terms are comparable.
 */
function styleFit(style, character) {
  const { energy, brightness, punch, bass, range } = character;
  switch (style) {
    // A ballad is soft as well as quiet. Weighted on loudness alone, three
    // cached tracks mastered quietly - a hip-hop classic, a dancehall riddim
    // and a slow rap single, all with heavy drums or bass - came out as ballads
    // and were danced with waves and sways.
    case 'ballad': return (1 - energy) * 0.35 + (1 - punch) * 0.45 + (1 - bass) * 0.2;
    case 'groove': return bass * 0.4 + punch * 0.35 + (1 - brightness) * 0.25;
    case 'disco': return brightness * 0.3 + range * 0.3 + punch * 0.2 + (1 - bass) * 0.2;
    // Club is told from rock by its low end and its steadiness: drums punch as
    // hard in both, but club music carries more bass and changes level less.
    case 'club': return energy * 0.3 + punch * 0.2 + bass * 0.4 + (1 - range) * 0.1;
    case 'rock': return energy * 0.35 + brightness * 0.3 + (1 - bass) * 0.2 + range * 0.15;
    case 'pop': return 0.5 - Math.abs(energy - 0.5) * 0.4 + brightness * 0.2;
    default: return 0.5;
  }
}

/**
 * Choose the song's style: the best fit for its felt tempo and character, with
 * the seed choosing between styles that fit nearly as well. Without the seed,
 * every song at a similar tempo and loudness would dance alike, which is the
 * problem this replaces - eight of twenty-two cached songs opened with the same
 * three moves.
 *
 * @param {ReturnType<typeof songCharacter>} character
 * @param {() => number} random
 * @returns {string}
 */
function styleFor(character, random) {
  const candidates = stylesForTempo(character.feltBpm)
    .map((name, rank) => ({ name, fit: styleFit(name, character) - rank * 0.03 }))
    .sort((a, b) => b.fit - a.fit);
  const close = candidates.filter((c) => c.fit >= candidates[0].fit - 0.04);
  return close[Math.floor(random() * close.length)].name;
}

/**
 * Each section's part in the song, from how it stands against the rest of it.
 *
 * The analysis does not label sections, but their levels carry the shape a
 * listener hears: one cached track's energies run 0.26, 0.57, 0.38, 0.68, 0.46,
 * 0.27 - intro, chorus, verse, bigger chorus, bridge, outro.
 *
 * Judged against the song's *typical* section, the median, not its extremes.
 * Against the extremes, one near-silent ending stretched the range until every
 * other section counted as loud: a disco track came out as ten choruses in a
 * row. A chorus has to stand clear of the typical section, by at least 0.04 and
 * by half the distance to the song's top fifth.
 *
 * Standing out is loudness plus half the brightness. A chorus is often brighter
 * and denser rather than louder, and on loudness alone five of the twenty-two
 * cached songs came out as nothing but verses, so their dancers never reached
 * the hook. A song that still shows fewer than one chorus in five playing
 * sections has its brightest, loudest sections promoted until it does.
 *
 * @param {object[]} sections
 * @returns {{role: string, intensity: number}[]}
 */
export function sectionRoles(sections) {
  const lift = (section) => section.energy_mean + section.brightness_mean * 0.5;
  const playingSections = sections.filter((section) => section.energy_mean >= CALM_ENERGY);
  const lifts = playingSections.map(lift).sort((a, b) => a - b);
  const energies = playingSections.map((section) => section.energy_mean).sort((a, b) => a - b);
  const at = (values, p) => (values.length
    ? values[Math.min(values.length - 1, Math.round(p * (values.length - 1)))]
    : 0);
  const median = at(lifts, 0.5);
  const chorusAt = Math.max(median + 0.04, median + (at(lifts, 0.8) - median) * 0.5);
  const quietAt = Math.min(median - 0.04, median - (median - at(lifts, 0.2)) * 0.5);
  const energyMedian = at(energies, 0.5);
  const spread = Math.max(0.1, at(energies, 0.8) - at(energies, 0.2));

  const roles = [];
  sections.forEach((section, i) => {
    const energy = section.energy_mean;
    // Mostly relative, partly absolute, so a quiet song's chorus is its peak
    // without being danced as hard as a loud song's. Near-silence is danced at
    // nothing: judged against the playing sections it can come out above the
    // middle, and a figure bracing through a silence reads as a glitch.
    const relative = Math.min(1, Math.max(0, 0.5 + (energy - energyMedian) / spread));
    const absolute = Math.min(1, Math.max(0, (energy - 0.12) / 0.6));
    const intensity = energy < CALM_ENERGY ? 0 : relative * 0.6 + absolute * 0.4;
    const level = lift(section);
    const previous = sections[i - 1];
    const next = sections[i + 1];
    const before = roles[i - 1]?.role;
    let role;
    if (energy < CALM_ENERGY) role = 'silence';
    else if (i === 0 && level < chorusAt) role = 'intro';
    else if (i === sections.length - 1 && level < chorusAt) role = 'outro';
    else if (level >= chorusAt) {
      // A drop is a chorus *arriving*: markedly louder than what came before,
      // and not simply the next section of a chorus already under way.
      role = previous && energy - previous.energy_mean > 0.12
        && before !== 'chorus' && before !== 'drop' ? 'drop' : 'chorus';
    } else if (next && lift(next) >= chorusAt && level >= quietAt) role = 'build';
    else if (level <= quietAt && ['chorus', 'drop'].includes(before)) role = 'breakdown';
    else role = 'verse';
    roles.push({ role, intensity });
  });

  // Every song reaches its hook: promote the strongest verses if too few
  // sections stood out on their own.
  const wanted = playingSections.length >= 3 ? Math.round(playingSections.length * 0.2) : 0;
  let have = roles.filter(({ role }) => role === 'chorus' || role === 'drop').length;
  const candidates = sections
    .map((section, i) => ({ i, level: lift(section) }))
    .filter(({ i }) => roles[i].role === 'verse' || roles[i].role === 'build')
    .sort((a, b) => b.level - a.level);
  for (const { i } of candidates) {
    if (have >= wanted) break;
    roles[i].role = 'chorus';
    have += 1;
  }
  // A build only means something before a chorus; re-derive after promotion.
  roles.forEach((entry, i) => {
    const next = roles[i + 1]?.role;
    if (entry.role === 'verse' && (next === 'chorus' || next === 'drop') && i > 0
      && lift(sections[i]) >= quietAt) entry.role = 'build';
  });
  return roles;
}

/**
 * The shape of each role's routine, one entry per phrase, cycling.
 *
 * `low`, `mid` and `high` draw from the style's tiers; `hook` is the song's
 * signature move and `drop` its impact move. A chorus returns to its hook every
 * other phrase, a build climbs a tier as it goes, and a breakdown stays down -
 * which is the arc of the song danced rather than described.
 */
const ROLE_SHAPES = {
  intro: ['low', 'low', 'mid', 'low'],
  verse: ['mid', 'low', 'mid', 'mid'],
  build: ['mid', 'mid', 'high', 'high'],
  chorus: ['hook', 'high', 'hook', 'high'],
  drop: ['drop', 'hook', 'high', 'hook'],
  breakdown: ['low', 'low', 'low', 'low'],
  outro: ['low', 'mid', 'low', 'low'],
  silence: ['idle'],
};

/**
 * Plan a song's dance from its analysis, once.
 *
 * Replaces choosing each section's move from its *index*, which walked the same
 * list in the same order for every song: section 0 of any mid-energy track was
 * always `step`, and eight of the thirty-four moves were never chosen at all.
 *
 * - The song gets one style, from its felt tempo and character, seeded per song.
 * - Each section gets a role - intro, verse, build, chorus, drop, breakdown,
 *   outro - from its energy against the song's typical level.
 * - Sections with the same role share one routine. The second chorus is danced
 *   like the first, which more than anything makes choreography read as meant.
 * - The seed is the song's identity, so every viewer sees the same dance.
 *
 * @param {object} score
 * @returns {{style: string, hook: string, sections: {role: string,
 *   intensity: number, routine: string[]}[]}}
 */
export function planChoreography(score) {
  const sections = score.sections ?? [];
  const identity = score.source?.provider_id ?? score.source?.title
    ?? `${score.source?.duration_sec ?? score.analysis?.analysed_duration_sec ?? 0}`;
  const random = seededRandom(hashString(String(identity)));
  const style = styleFor(songCharacter(score), random);
  const vocabulary = STYLES[style];

  // Drawn without repeating within a routine where the tier allows it.
  const draw = (tier, taken) => {
    const pool = vocabulary[tier].filter((move) => !taken.has(move));
    const from = pool.length ? pool : vocabulary[tier];
    return from[Math.floor(random() * from.length)];
  };
  const hook = vocabulary.hook[Math.floor(random() * vocabulary.hook.length)];

  const byRole = new Map();
  const routineFor = (role) => {
    if (byRole.has(role)) return byRole.get(role);
    const shape = ROLE_SHAPES[role];
    const taken = new Set([hook]);
    const picked = {};
    const routine = shape.map((slot, i) => {
      if (slot === 'idle') return 'idle';
      if (slot === 'hook') return hook;
      if (slot === 'drop') return vocabulary.drop;
      // The same slot twice in a shape alternates between two moves, so a verse
      // goes back and forth rather than wandering through four.
      const key = `${slot}${shape.slice(0, i).filter((other) => other === slot).length % 2}`;
      if (!picked[key]) {
        picked[key] = draw(slot, taken);
        taken.add(picked[key]);
      }
      return picked[key];
    }).filter((move) => MOVES[move]);
    byRole.set(role, routine.length ? routine : ['step']);
    return byRole.get(role);
  };

  return {
    style,
    hook,
    sections: sectionRoles(sections)
      .map(({ role, intensity }) => ({ role, intensity, routine: routineFor(role) })),
  };
}

/**
 * Number of musical bars for which one routine entry is held.
 *
 * Eight rather than four. At 128bpm a four-bar phrase lasts under eight
 * seconds, which is barely long enough to register a move before it changes,
 * so the movement read as restless rather than choreographed. Eight bars gives
 * each move time to be seen.
 */
export const PHRASE_BARS = 8;

/**
 * Shape of one phrase, as a pair of curves over its length.
 *
 * ## The problem this solves
 *
 * Every move is a pure function of `bar`, which is position within a *single*
 * bar - so a move resets completely eight times per phrase and can never go
 * anywhere. That is the difference between animation and choreography: a routine
 * has a beginning, a build, a peak and a resolution, and none of that could be
 * expressed by a vocabulary whose longest thought is two seconds.
 *
 * Rather than rewrite nineteen pose tables to take phrase position - which would
 * change the character of every one of them - the arc is applied *on top* of
 * whatever a move produces. The move keeps its identity; the phrase decides how
 * far it is pushed and when it lands.
 *
 * ## The two curves
 *
 * `intensity` scales the whole performance: a phrase opens slightly held back,
 * grows through its middle, and peaks about three-quarters through, which is
 * where a musical phrase usually puts its weight. Peaking dead centre reads as
 * symmetrical and therefore as mechanical.
 *
 * `settle` rises only across the final bar. It pulls travel and rotation back
 * toward neutral so a phrase *arrives* somewhere instead of being cut off
 * mid-gesture when the next one starts - which is what makes the change of move
 * read as deliberate rather than as a jump.
 *
 * Measured effect on a held `groove` at energy 0.5: the arm swing range moves
 * from 48.0 degrees early in the phrase to 57.0 at its peak, and the legs from
 * 27.6 to 31.9 - about 19% and 16%. It was 9% and 13% when the pose springs
 * smeared most of every move away; the drawn pose follows the move now, so the
 * same arc shows. Deliberately modest. Pushing the range wider makes the
 * figures visibly pulse in and out rather than reading as a phrase that grows,
 * which is a worse artefact than the flatness it replaced.
 *
 * @param {number} t Position within the phrase, 0-1.
 * @returns {{intensity: number, settle: number}}
 */
function phraseArc(t) {
  const clamped = Math.min(1, Math.max(0, t));
  // Peak at 0.75. Two half-cosines either side of it keep the curve smooth
  // across the join rather than kinking at the peak.
  const peak = 0.75;
  const rise = clamped < peak
    ? clamped / peak
    : 1 - (clamped - peak) / (1 - peak);
  const shaped = 0.5 - 0.5 * Math.cos(Math.min(1, Math.max(0, rise)) * Math.PI);

  // The last bar of the phrase, expressed as a fraction of the whole.
  const settleFrom = 1 - 1 / PHRASE_BARS;
  const settle = clamped < settleFrom
    ? 0
    : ((clamped - settleFrom) / (1 - settleFrom)) ** 2;

  return { intensity: 0.78 + shaped * 0.44, settle };
}

/**
 * How far apart the cast is allowed to drift, across one phrase.
 *
 * Every dancer carried a fixed `beatOffset`, so the group was permanently and
 * identically out of step with itself - which means it never hit anything
 * together. A real group does the opposite: it lands in unison on the structural
 * beats and breaks into canon between them, and that contrast is most of what
 * makes several figures read as a troupe rather than as one figure copied.
 *
 * Zero at both ends of the phrase, so a phrase begins and ends with the whole
 * cast on the same frame.
 *
 * @param {number} t Position within the phrase, 0-1.
 * @returns {number} 0 for unison, 1 for full canon spread.
 */
function canonAmount(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return Math.sin(clamped * Math.PI) ** 2;
}

/**
 * Beats of connecting movement at the start of each phrase.
 *
 * A move change used to be a pure cross-fade: the springs dissolved one pose
 * into the next over roughly a second. That is a transition in the video-editing
 * sense and not in the dance sense - nothing *happens* between the two moves,
 * the first simply becomes the second.
 *
 * Running a neutral connecting move over the first two beats gives the springs
 * something to travel through, so the figure steps out of one move and into the
 * next. Two beats is one second at 120bpm: long enough to register as its own
 * action, short enough that the new move still owns the phrase.
 */
const TRANSITION_BEATS = 2;

/**
 * Neutral moves used to connect two phrases.
 *
 * All four are travelling or weight-shifting rather than gestural, because a
 * connector that plants a pose competes with the move it is introducing.
 */
const CONNECTORS = ['step', 'groove', 'slide', 'sway'];

/** Deterministic move sequences keyed by their opening move. */
const ROUTINES = {
  idle: ['idle', 'wave', 'idle', 'sing'],
  reach: ['reach', 'jump', 'clap', 'spin'],
  jump: ['jump', 'reach', 'kick', 'clap'],
  run: ['run', 'march', 'slide', 'kick'],
  floss: ['floss', 'shimmy', 'groove', 'clap'],
  march: ['march', 'clap', 'kick', 'reach'],
  kick: ['kick', 'groove', 'march', 'jump'],
  headbang: ['headbang', 'clap', 'groove', 'reach'],
  step: ['step', 'groove', 'clap', 'slide'],
  groove: ['groove', 'shimmy', 'step', 'point'],
  robot: ['robot', 'point', 'robot', 'clap'],
  wave: ['wave', 'slide', 'groove', 'spin'],
  shimmy: ['shimmy', 'groove', 'floss', 'step'],
  slide: ['slide', 'step', 'wave', 'kick'],
  clap: ['clap', 'step', 'point', 'reach'],
  point: ['point', 'clap', 'groove', 'spin'],
  spin: ['spin', 'groove', 'step', 'reach'],
  sing: ['sing', 'groove', 'clap', 'wave'],
  // Stays within the calm vocabulary. A quiet section that resolves into a
  // routine with `clap` or `kick` in it defeats the point of choosing it.
  sway: ['sway', 'wave', 'sway', 'sing'],
  // Named dances, each sequenced with neighbours of a similar era or energy
  // so a phrase reads as one routine rather than a shuffle of unrelated bits.
  moonwalk: ['moonwalk', 'slide', 'twostep', 'moonwalk'],
  twist: ['twist', 'charleston', 'twist', 'twostep'],
  charleston: ['charleston', 'twist', 'kick', 'charleston'],
  runningman: ['runningman', 'shuffle', 'runningman', 'cabbagepatch'],
  dougie: ['dougie', 'twostep', 'dougie', 'groove'],
  gangnam: ['gangnam', 'jump', 'gangnam', 'clap'],
  macarena: ['macarena', 'twostep', 'macarena', 'clap'],
  vogue: ['vogue', 'point', 'vogue', 'discopoint'],
  cabbagepatch: ['cabbagepatch', 'runningman', 'cabbagepatch', 'groove'],
  sprinkler: ['sprinkler', 'cabbagepatch', 'sprinkler', 'twostep'],
  discopoint: ['discopoint', 'vogue', 'discopoint', 'spin'],
  twostep: ['twostep', 'salsa', 'twostep', 'dougie'],
  shuffle: ['shuffle', 'runningman', 'shuffle', 'jump'],
  ymca: ['ymca', 'clap', 'ymca', 'reach'],
  salsa: ['salsa', 'twostep', 'salsa', 'twist'],
};

/** Resolve generated and legacy choreography into a safe section routine. */
function routineForSection(section, planned) {
  const supplied = planned?.routine ?? planned?.moves;
  if (Array.isArray(supplied)) {
    const valid = supplied.filter((move) => typeof move === 'string' && MOVES[move]);
    if (valid.length > 1) return valid;
    if (valid.length === 1) return ROUTINES[valid[0]] ?? valid;
  }
  const requested = planned?.move;
  const opening = typeof requested === 'string' && MOVES[requested]
    ? requested
    : moveForSection(section);
  return ROUTINES[opening] ?? [opening];
}

/**
 * The move for one performer within a section.
 *
 * The lead sings while everyone else dances, which is what turns a row of
 * identical figures into a group with a front person - and joins them when the
 * song lifts, so the whole cast dances the chorus. On quiet sections nobody
 * takes lead, because a ballad with a hype man behind it reads as wrong.
 *
 * @param {string} sectionMove Move chosen for the section.
 * @param {number} dancerIndex
 * @param {object} section
 * @param {string} [role] The section's part in the song; see `sectionRoles`.
 * @returns {string}
 */
function moveForDancer(sectionMove, dancerIndex, section, role = 'verse') {
  if (section.energy_mean < CALM_ENERGY) {
    // Near-silence: the lead still performs, everyone else settles. This is the
    // only case where standing still is the right answer.
    return dancerIndex === 0 ? 'sing' : 'idle';
  }

  if (section.energy_mean < QUIET_ENERGY) {
    // Quiet but playing. Everyone keeps moving; the backing figures sway while
    // the lead does something marginally more expressive, so the group still
    // has a front person without anybody freezing.
    return dancerIndex === 0 ? sectionMove : 'sway';
  }

  if (dancerIndex === 0) {
    // The lead sings the quieter parts of the song and joins the dance when it
    // lifts. It used to sing two sections in three by *index*, whatever the
    // music was doing, so the figure with the microphone was often the one
    // standing apart through a chorus.
    return ['build', 'chorus', 'drop'].includes(role) ? sectionMove : 'sing';
  }

  // The chorus is danced together. Companion moves are what stop a cast
  // reading as clones through a verse; the hook is the moment a group locks
  // into one move, and it is the part of a routine an audience remembers.
  if (role === 'chorus' || role === 'drop') return sectionMove;

  // Backing performers take related but distinct moves rather than all copying
  // the section's choice, which is what turns a row of clones into a group.
  const companions = {
    reach: ['jump', 'clap', 'reach'],
    jump: ['reach', 'kick', 'jump'],
    run: ['march', 'slide', 'run'],
    floss: ['shimmy', 'groove', 'floss'],
    march: ['clap', 'march', 'kick'],
    kick: ['march', 'groove', 'kick'],
    headbang: ['headbang', 'clap', 'groove'],
    step: ['groove', 'step', 'shimmy'],
    groove: ['shimmy', 'step', 'groove'],
    robot: ['robot', 'point', 'robot'],
    wave: ['wave', 'slide', 'groove'],
    shimmy: ['groove', 'shimmy', 'step'],
    slide: ['slide', 'step', 'groove'],
    clap: ['clap', 'step', 'clap'],
    point: ['point', 'clap', 'groove'],
    spin: ['spin', 'groove', 'step'],
    sway: ['sway', 'wave', 'sway'],
    moonwalk: ['slide', 'twostep', 'moonwalk'],
    twist: ['twist', 'twostep', 'charleston'],
    charleston: ['charleston', 'kick', 'twist'],
    runningman: ['shuffle', 'runningman', 'groove'],
    dougie: ['dougie', 'groove', 'twostep'],
    gangnam: ['gangnam', 'clap', 'jump'],
    macarena: ['macarena', 'macarena', 'twostep'],
    vogue: ['vogue', 'point', 'vogue'],
    cabbagepatch: ['cabbagepatch', 'groove', 'runningman'],
    sprinkler: ['sprinkler', 'cabbagepatch', 'groove'],
    discopoint: ['discopoint', 'point', 'vogue'],
    twostep: ['twostep', 'salsa', 'groove'],
    shuffle: ['shuffle', 'runningman', 'shuffle'],
    ymca: ['ymca', 'ymca', 'clap'],
    salsa: ['salsa', 'twostep', 'salsa'],
    sing: ['groove', 'clap', 'step'],
  }[sectionMove] ?? [sectionMove];

  return companions[(dancerIndex - 1) % companions.length];
}

/**
 * Floor formations, in world units. Returns `[x, z]`.
 *
 * Spacing widens with the cast so figures never crowd: two performers stand
 * well apart and read as a duet, where the previous fixed spacing had everyone
 * overlapping regardless of how many there were.
 */
const FORMATIONS = [
  // Line, generously spaced.
  (i, n) => [(i - (n - 1) / 2) * (n <= 2 ? 2.6 : 2.0), 0],
  // Staggered in depth, which the perspective camera reads as a crowd.
  (i, n) => [(i - (n - 1) / 2) * 1.6, (i % 2) * 2.2 - 1.1],
  // Circle, sized so it never collapses for small casts.
  (i, n) => {
    const radius = Math.max(1.8, n * 0.55);
    return [Math.cos((i / n) * Math.PI * 2) * radius,
      Math.sin((i / n) * Math.PI * 2) * radius];
  },
  // Wedge, lead figure forward.
  (i, n) => [(i - (n - 1) / 2) * 1.4, -Math.abs(i - (n - 1) / 2) * 1.5],
  // Facing pair, or a loose arc for larger casts.
  (i, n) => (n === 2
    ? [i === 0 ? -1.7 : 1.7, 0]
    : [Math.sin((i / Math.max(1, n - 1) - 0.5) * 2.4) * 3.0,
      Math.cos((i / Math.max(1, n - 1) - 0.5) * 2.4) * 1.4 - 1.0]),
];

/**
 * Which formation each part of a song is danced in, by index into
 * {@link FORMATIONS}.
 *
 * It was the section's index, so the formation changed at every boundary but
 * meant nothing - a chorus could land in any of the five. Now the shape follows
 * the song: an open arc for the intro and outro, staggered rows for a verse, a
 * line for a build, the wedge with the lead forward for a chorus and a drop,
 * and a circle for a breakdown. The second chorus lands in the shape the first
 * did, which is half of what makes it read as the chorus again.
 */
const ROLE_FORMATIONS = {
  intro: 4,
  verse: 1,
  build: 0,
  chorus: 3,
  drop: 3,
  breakdown: 2,
  outro: 4,
  silence: 4,
};

/**
 * Which shots suit which moment in a track.
 *
 * The camera used to take `SHOTS[sectionIndex % SHOTS.length]` - a round robin,
 * so the music had no say in whether a drop was seen from a crane or from the
 * floor. Staging is choosing the angle *for the moment*: a quiet passage wants
 * air around the cast and a long lens, a chorus wants to be close and low, and
 * a drop wants the most dramatic angle available at the instant it lands.
 *
 * Named rather than indexed so the intent survives someone reordering `SHOTS`.
 */
export const SHOT_PLAN = {
  quiet: ['wide', 'sidelong', 'high wide', 'crane'],
  build: ['crane', 'tracking', 'wide', 'sidelong'],
  // `wide` earns a place here too. Measured over a loud track, the moment
  // classifier called almost every bar a chorus, so a vocabulary of four close
  // angles meant the widest shot in the table went unused for the whole song -
  // and an unbroken run of close work has nothing to be close *against*.
  chorus: ['low hero', 'close', 'tracking', 'floor', 'wide'],
  drop: ['low hero', 'floor', 'close'],
};

/**
 * Bars held before cutting, by moment and loudness.
 *
 * Cut *rate* is what makes footage feel like it belongs to the track. A ballad
 * that cuts every two bars is frantic; a chorus that holds one angle for thirty
 * seconds is a webcam. Energy decides, so a song is naturally as cut-heavy as
 * it is loud, and drops cut hardest.
 *
 * Bars rather than seconds, because a cut that lands off the bar reads as a
 * glitch rather than as an edit.
 */
function barsPerCut(moment, energy) {
  if (moment === 'drop') return 1;
  if (energy > 0.66) return 2;
  if (energy > 0.38) return 4;
  return 8;
}

/**
 * Camera setups, chosen per section.
 *
 * Each is a *position* in world space plus what it looks at, rather than a yaw
 * and a distance. That is what allows genuine movement on all three axes - a
 * crane rising while tracking sideways, a low push-in - none of which an
 * orbit-and-distance rig can express.
 *
 * `drift` adds a slow continuous motion on top, so no shot is ever perfectly
 * still: `[x, y, z]` amplitudes and a period in seconds.
 */
export const SHOTS = [
  {
    name: 'wide', position: [0, 2.2, -9.5], look: [0, 1.0, 0], target: null,
    drift: { amp: [1.6, 0.35, 0.8], period: [17, 11, 23] },
  },
  {
    name: 'low hero', position: [-2.6, 0.55, -4.2], look: [0, 1.1, 0], target: 'pick',
    drift: { amp: [1.1, 0.20, 0.9], period: [13, 9, 19] },
  },
  {
    name: 'crane', position: [3.2, 4.1, -8.6], look: [0, 1.1, 0], target: null,
    drift: { amp: [2.2, 0.9, 1.2], period: [21, 15, 26] },
  },
  {
    name: 'close', position: [1.2, 1.5, -2.9], look: [0, 1.3, 0], target: 'pick',
    drift: { amp: [0.8, 0.35, 0.6], period: [11, 8, 14] },
  },
  {
    name: 'floor', position: [0, 0.25, -5.0], look: [0, 1.4, 0], target: null,
    drift: { amp: [2.4, 0.12, 0.5], period: [19, 23, 17] },
  },
  // From the wings, not square to the side. Every formation spreads the cast
  // across the stage, and looking straight along that the figures stood one
  // behind another: measured over four cached tracks, a figure was hidden
  // behind another in 45.6% of this shot's dancer-frames, and 50.0% once
  // builds took to a line. From here it is 19.5%.
  {
    name: 'sidelong', position: [-6.4, 1.6, -3.9], look: [0, 1.1, 0], target: null,
    drift: { amp: [0.9, 0.5, 1.6], period: [24, 13, 18] },
  },
  // Was a near-plan view: 7.5 up, 3.0 out, looking at the floor - about 68
  // degrees down. These figures are drawn as flat strokes with no volume, so
  // from up there a raised arm projects onto a few pixels and the whole cast
  // reads as blobs on a floor. The dancing was not worse from that angle, it
  // was invisible, which is worse. Now a high three-quarter: high enough to
  // show the floor pattern and the spacing between figures, shallow enough
  // (about 19 degrees) that a limb still crosses the frame.
  //
  // Same reason `crane` came down from 5.4 to 4.1 and moved back to 8.6. Any
  // new shot wants its pitch kept under roughly 25 degrees; there is no angle
  // steep enough to be interesting that these figures survive.
  {
    name: 'high wide', position: [1.6, 3.6, -8.2], look: [0, 1.15, 0], target: null,
    drift: { amp: [1.8, 0.6, 1.8], period: [27, 19, 22] },
  },
  {
    name: 'tracking', position: [4.5, 1.8, -6.0], look: [0, 1.1, 0], target: 'pick',
    drift: { amp: [3.4, 0.4, 1.4], period: [15, 12, 20] },
  },
];

export class StickMenVisual {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} [count] Figures on stage.
   */
  constructor(canvas, count = 1) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('2D canvas is unavailable.');
    this.needsMeasure = true;
    this.setCount(count);
    /**
     * Free camera: a position and a point it looks at, both eased.
     *
     * Storing a position rather than an orbit is what makes movement on all
     * three axes possible, and easing both independently means a shot change is
     * a smooth move through space rather than a cut.
     */
    this.camera = { position: [0, 2.2, -9.5], look: [0, 1.0, 0] };
    // Seeded here so the first frame can project before `updateCamera` has run.
    this.refreshBasis();
    this.shot = SHOTS[0];
    this.shotTarget = null;

    this.energy = 0;
    this.punch = 0;
    this.sectionIndex = -1;
    this.section = null;
    this.routine = [];
    this.phraseIndex = -1;
    this.phraseKey = null;
    this.phrasePosition = 0;
    this.palette = PALETTES[0];
    this.paletteBase = 0;
    this.move = 'step';
    this.formation = 0;
    /** The song's dance, planned once per score; see `planChoreography`. */
    this.plan = null;
    this.planScore = null;
    /** The current section's part in the song, and how hard it is danced, 0-1. */
    this.role = 'verse';
    this.intensity = 0.5;
    /** Each move's centre pose, cached; see `centreOf`. */
    this.centres = new Map();
    /** Playback position, set each frame; the camera and environment read it. */
    this.scoreSec = 0;
    this.lastFrameMs = performance.now();
  }

  /**
   * Set how many figures are on stage.
   *
   * @param {number} count
   */
  setCount(count) {
    const total = Math.max(1, Math.min(8, Math.round(count)));
    if (this.dancers?.length === total) return;
    this.dancers = Array.from({ length: total }, (_, index) => ({
      index,
      x: 0,
      z: 0,
      facing: 0,
      // Different builds remain distinct without putting everybody on a
      // different beat, which previously read as unrelated exercise loops.
      build: 0.82 + ((index * 41) % 100) / 100 * 0.42,
      beatOffset: index === 0 ? 0 : (((index * 37) % 5) - 2) * 0.012,
      // How far this figure lags the cast at the height of a canon, in beats.
      //
      // Separate from `beatOffset`, which is a permanent per-figure jitter kept
      // deliberately tiny so the group still reads as coordinated. This one is
      // scaled by `canonAmount` and therefore collapses to zero at both ends of
      // every phrase, so the cast lands together on the structural beats and
      // ripples only in between. A sixth of a beat is 83ms at 120bpm - clearly
      // visible as a follow, well short of looking like a mistake.
      canon: index === 0 ? 0 : ((index % 3) - 1) * 0.17,
      // Beats of connecting movement remaining before the phrase's own move
      // takes over. Counted down in `updatePosition`.
      transitionBeats: 0,
      // The connector being run, chosen when the phrase changes.
      connector: 'step',
      // Every dancer gets its own tempo multiplier on the secondary motion, so
      // limbs do not settle into visible unison.
      looseness: 0.75 + ((index * 29) % 100) / 100 * 0.55,
      mirror: index % 2 === 0 ? 1 : -1,
      lag: { hands: [null, null], feet: [null, null] },
      // How much of the figure's weight each leg is carrying, 0-1. Written by
      // `updatePosition` and read by `drawDancer` to decide which foot is
      // planted, so the two halves agree about which leg is standing.
      support: [0.5, 0.5],
      // Where each foot is pinned to the floor, and how strongly.
      //
      // A foot carrying weight does not move. The pose tables describe leg
      // *angles*, which meant the feet went wherever the hips sent them - so
      // every figure slid across the floor like it was on ice, which is the
      // single loudest reason they did not read as standing on anything.
      //
      // `point` is a world position on the floor, or null when the foot is
      // swinging. `strength` is eased rather than switched, because a foot that
      // snaps between planted and free pops visibly at the transfer.
      plant: [
        { point: null, held: false, strength: 0 },
        { point: null, held: false, strength: 0 },
      ],
      // How long each limb has been tucked against the body, so the repulsion
      // can allow a brief deliberate one and then force it open.
      tuck: {
        arms: [{ tuckSec: 0 }, { tuckSec: 0 }],
        legs: [{ tuckSec: 0 }, { tuckSec: 0 }],
      },
      // The smoothed pose actually drawn. Targets are computed each frame and
      // this chases them, so nothing ever steps and move changes cross-fade.
      pose: restPose(),
    }));
    this.phraseKey = null;
  }

  /**
   * Adopt a track, sizing the cast to the people who actually made it.
   *
   * A solo single danced by five figures is nonsense; the count comes from the
   * artists credited in the title, so a duet gets two and a feature gets three.
   *
   * @param {object|null} track
   */
  setTrack(track) {
    // The server's MusicBrainz lookup knows group sizes; the local title parser
    // does not and never can. Prefer the former when it has arrived.
    this.setCount(track?.performerCount ?? performerCount(track));
  }

  /**
   * Mark the canvas as needing re-measurement; see `Canvas2DVisual.resize` for
   * why measuring is deferred rather than done here.
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
  }

  /**
   * Draw one frame.
   *
   * @param {object} score A VisualScore.
   * @param {number} playbackSec
   */
  render(score, playbackSec) {
    if (this.needsMeasure) this.measure();
    const context = this.context;
    const { width, height } = this.canvas;

    const now = performance.now();
    // Clamped at both ends. The upper bound stops a long stall integrating in
    // one huge step; the lower bound stops a *negative* delta, which can happen
    // when a tab is restored or the clock is adjusted, and which makes a spring
    // integrator gain energy instead of losing it - the pose diverges to
    // nonsense within a few frames and never recovers.
    const deltaSec = Math.min(Math.max((now - this.lastFrameMs) / 1000, 0), 0.1);
    this.lastFrameMs = now;

    // --- Score ------------------------------------------------------------
    const lanes = score.lanes;
    const analysed = score.analysis.analysed_duration_sec;
    const scoreSec = score.analysis.is_partial && playbackSec >= analysed && analysed > 0
      ? playbackSec % analysed
      : playbackSec;
    // Published on the instance because the camera and the environment are
    // drawn from separate methods and both need the music's clock, not the
    // browser's.
    this.scoreSec = scoreSec;
    const frame = Math.max(0, Math.min(
      Math.floor(scoreSec * lanes.fps), lanes.frame_count - 1,
    ));
    // Asymmetric: meet a hit at once, release from it gently.
    //
    // These were symmetric, and this file reads the lanes itself rather than
    // through `LaneReader` - so when the shared smoothing was given a fast
    // attack, and punch went from keeping 55% of its peak to 99%, the stick men
    // were the one renderer left out of it. A dancer answering a beat a fifth
    // of a second late is answering a different beat.
    const meet = (previous, next, factor) => {
      const rate = next > previous ? Math.min(1, factor * 4) : factor;
      return previous + (next - previous) * rate;
    };
    this.energy = meet(this.energy, lanes.energy[frame], 0.09);
    this.punch = meet(this.punch, lanes.punch[frame], 0.45);

    // Continuous palette travel, matching the shared renderers. Driven by score
    // position rather than wall time, so everyone watching sees the same colour
    // at the same moment and a seek lands where it should.
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
    const raw = cycle - step;
    const blend = raw * raw * (3 - 2 * raw);
    const currentPalette = PALETTES[step % PALETTES.length];
    const nextPalette = PALETTES[(step + 1) % PALETTES.length];
    this.palette = [
      saturate(mixHex(currentPalette[0], nextPalette[0], blend), 0.22),
      saturate(mixHex(currentPalette[1], nextPalette[1], blend), 0.22),
    ];

    // Planned once per score, and again when the score is replaced: a partial
    // analysis gives way to the full one once it is ready, and its sections
    // cover only the opening of the track.
    if (score !== this.planScore) {
      this.planScore = score;
      this.plan = planChoreography(score);
      this.sectionIndex = -1;
    }

    const section = score.sections.find(
      (s) => scoreSec >= s.start_sec && scoreSec < s.end_sec,
    );
    if (section && section.index !== this.sectionIndex) {
      this.sectionIndex = section.index;
      this.section = section;
      // The section sets where the continuous cycle starts, not the palette
      // itself - assigning here as well would overwrite the blended value for
      // one frame at every section boundary, which shows as a colour flicker.
      this.paletteBase = section.index % PALETTES.length;
      const entry = this.plan?.sections?.[section.index];
      this.role = entry?.role ?? 'verse';
      this.intensity = entry?.intensity ?? Math.min(1, section.energy_mean * 1.4);
      this.formation = ROLE_FORMATIONS[this.role] ?? section.index % FORMATIONS.length;

      // A choreography supplied with the score still takes precedence. The plan
      // dances every track that has none - which, so far, is every track.
      const planned = score.choreography?.sections?.[section.index];
      this.routine = planned || !entry ? routineForSection(section, planned) : entry.routine;
      this.phraseKey = null;
      if (planned?.palette?.length === 2) this.palette = planned.palette;
      this.sectionStartSec = section.start_sec;
      this.forceCut = true;
    }

    const { tempo_bpm: bpm, meter, beats } = score.timing;
    const interval = 60 / (bpm > 0 ? bpm : 120);
    const origin = beats.length ? beats[0] : 0;
    const beatCount = Math.max(0, playbackSec - origin) / interval;

    // --- Cutting -----------------------------------------------------------
    //
    // The camera used to change only at section boundaries - every twenty or
    // thirty seconds - and always by easing toward the new position. Four
    // minutes of that is a drone slowly circling a stage. Performance footage
    // is built from cuts, and cuts that land on the bar.
    //
    // Bars, not seconds: an edit that arrives a quarter-beat early reads as a
    // glitch. The rate comes from the raw lane rather than the smoothed one so
    // that everyone watching cuts on the same bar regardless of when they
    // joined.
    const bars = Math.max(1, meter);
    const barIndex = Math.floor(beatCount / bars);
    const rawEnergy = lanes.energy[frame] ?? 0;
    const intoSection = Math.max(0, scoreSec - (this.sectionStartSec ?? 0));
    const moment = this.momentFor(score, rawEnergy, intoSection);

    // Held for the cast, not just the camera. Cutting faster on a drop tells
    // you the editor noticed; it does not tell you the dancers did, and a room
    // full of figures carrying on with their own business through a drop is
    // the single clearest way to look unaware of the music.
    this.moment = moment;
    if (moment === 'drop' && this.lastMoment !== 'drop') {
      this.dropSec = scoreSec;
      // Whip onto the lead, without waiting for a cut. The subject is normally
      // only reassigned at a cut, so a drop inherited whatever the previous
      // shot was pointed at - measured, 18% of drop time framed a backing
      // figure while the lead carried the moment.
      //
      // Forcing a *cut* here does nothing: a drop is detected at a section
      // change, which already forces one, and that cut then waits for the next
      // bar - up to 2.6s at 91bpm, against a drop accent that lasts 2s. So the
      // camera keeps its angle and pans its subject instead, which is a move a
      // camera operator would actually make on a drop.
      if (this.shot?.target === 'pick') this.shotTarget = 0;
    }
    this.lastMoment = moment;
    // Decays over a bar and a half, so the hit is an impact that fades rather
    // than a state that switches off.
    const sinceDrop = scoreSec - (this.dropSec ?? -Infinity);
    this.dropHit = moment === 'drop' && sinceDrop >= 0
      ? Math.exp(-sinceDrop / 1.5)
      : 0;

    if (this.lastCutBar === undefined) this.lastCutBar = -Infinity;
    const held = barIndex - this.lastCutBar;
    const due = held >= barsPerCut(moment, rawEnergy);

    // A section change asks for a cut but does not take one immediately: it
    // waits for the next bar. Section boundaries do not fall on bar lines, and
    // a cut a beat and a half into a bar reads as a mistake rather than an
    // edit - measured, seven of forty-eight cuts were landing off the bar and
    // every one of them was a section change.
    const wanted = (this.forceCut && barIndex > this.lastCutBar) || due;

    // Never two cuts in quick succession, whatever asked for them. A forced cut
    // arriving just after a scheduled one produced holds of under a frame,
    // which is a flicker.
    const sinceCut = scoreSec - (this.lastCutSec ?? -Infinity);
    if (wanted && sinceCut >= 0.9) {
      this.forceCut = false;
      this.lastCutBar = barIndex;
      this.lastCutSec = scoreSec;
      // Seeded from the bar and the section, so the sequence of angles is a
      // property of the track rather than of when anyone pressed play.
      this.pickShot(moment, barIndex * 31 + this.sectionIndex * 17);
    }
    // Held so `updatePosition` can count the phrase connector in beats rather
    // than seconds, and therefore have it scale with tempo.
    this.bpm = bpm;

    this.updatePhrase(scoreSec, bpm, meter);

    this.updateCamera(deltaSec);
    this.drawBackdrop(context, width, height, beatCount);
    this.drawEnvironment(context, width, height, beatCount);
    this.drawFloor(context, width, height);
    // After the floor so props sit on it, before the dancers so they read as
    // standing behind the cast rather than pasted over them.
    this.drawProps(context, width, height, beatCount);

    // Painter's algorithm: furthest first, so nearer figures overlap correctly.
    const projected = this.dancers.map((dancer) => {
      this.updatePosition(dancer, beatCount, meter, deltaSec);
      return { dancer, depth: this.project([dancer.x, 0, dancer.z], width, height).depth };
    }).sort((a, b) => b.depth - a.depth);

    for (const { dancer } of projected) {
      this.drawShadow(context, width, height, dancer);
    }
    for (const { dancer } of projected) {
      this.drawDancer(context, width, height, dancer, beatCount, meter, deltaSec);
    }
  }

  updatePhrase(scoreSec, bpm, meter) {
    if (!this.section || this.routine.length === 0) return;
    const secondsPerBeat = 60 / (bpm > 0 ? bpm : 120);
    const beatsPerBar = meter > 0 ? meter : 4;
    const sectionBeat = Math.max(0, scoreSec - this.section.start_sec) / secondsPerBeat;
    const beatsPerPhrase = beatsPerBar * PHRASE_BARS;
    const phraseIndex = Math.floor(sectionBeat / beatsPerPhrase);

    // Computed every frame, before the boundary check below returns early.
    // `updatePosition` shapes the whole performance from this, so it has to stay
    // current rather than only being refreshed when the move changes.
    this.phrasePosition = (sectionBeat % beatsPerPhrase) / beatsPerPhrase;

    const phraseKey = this.section.index + ':' + phraseIndex;
    if (phraseKey === this.phraseKey) return;

    // A phrase boundary. Anything below here runs once per phrase.
    const firstPhrase = this.phraseKey === null;
    this.phraseKey = phraseKey;
    this.phraseIndex = phraseIndex;
    this.move = this.routine[phraseIndex % this.routine.length];

    const calm = this.section.energy_mean < QUIET_ENERGY;
    for (const dancer of this.dancers) {
      dancer.move = moveForDancer(this.move, dancer.index, this.section, this.role);
      // No connector into the very first phrase: there is nothing to connect
      // from, and running one there just delays the opening move.
      dancer.transitionBeats = firstPhrase ? 0 : TRANSITION_BEATS;
      // One connector for the whole cast, deliberately - it does not vary by
      // dancer the way the phrase moves do. A phrase boundary is the moment the
      // group is most together, and everyone stepping through the same connector
      // is what makes that legible; giving each figure its own turns the join
      // back into the wash of independent movement it replaced.
      //
      // A quiet section connects through a sway rather than a step, so the
      // connector cannot be more energetic than the phrases either side of it.
      dancer.connector = calm ? 'sway' : CONNECTORS[phraseIndex % CONNECTORS.length];
    }
  }

  /**
   * Choose a camera setup and a subject for the moment the track is in.
   *
   * The shot is a destination the camera *snaps* to - it sets `pendingCut`, and
   * `updateCamera` jumps rather than eases. Easing between two setups is a move,
   * and a move turns every edit into a swoop; the drift within a shot still
   * eases, so an angle is alive the moment it lands.
   */
  pickShot(moment, seed) {
    const names = SHOT_PLAN[moment] ?? SHOT_PLAN.build;
    // Deterministic from the seed, which is derived from bar and section - so
    // every viewer is cut to the same angle at the same moment, and a seek puts
    // you where you would have been rather than somewhere new.
    let name = names[Math.abs(seed) % names.length];
    // Never the same angle twice running: repeating a shot across a cut reads
    // as a stutter rather than an edit.
    if (name === this.shot?.name && names.length > 1) {
      name = names[Math.abs(seed + 1) % names.length];
    }
    this.shot = SHOTS.find((candidate) => candidate.name === name) ?? SHOTS[0];
    // Who the shot is on. Dancer 0 is the lead - `moveForDancer` gives it the
    // vocal and the expressive move, and everyone else a companion move - so a
    // close shot on a random backing figure is a close shot on the person not
    // carrying the moment. It used to pick uniformly, which on a five-piece
    // cast meant the lead was the subject of one close shot in five.
    //
    // Not always the lead either: a chorus that never looks at anyone else has
    // no cast, only a soloist with scenery. One cut in four goes to a backing
    // figure, and every cut during a drop goes to the lead.
    const cast = Math.max(1, this.dancers.length);
    if (this.shot.target !== 'pick') this.shotTarget = null;
    else if (moment === 'drop' || cast === 1) this.shotTarget = 0;
    else if (Math.abs(seed) % 4 === 0) this.shotTarget = 1 + (Math.abs(seed * 7) % (cast - 1));
    else this.shotTarget = 0;
    // Snap on the next camera update rather than easing across the room.
    this.pendingCut = true;
  }

  /**
   * What kind of moment the track is in, for choosing an angle.
   *
   * Read from the section table and the raw lane rather than from the smoothed
   * value, so two people watching the same second agree even if one joined a
   * moment ago and their smoothing has not settled.
   *
   * @param {object} score
   * @param {number} rawEnergy Lane value at this frame, unsmoothed.
   * @param {number} intoSection Seconds since the section began.
   * @returns {'quiet'|'build'|'chorus'|'drop'}
   */
  momentFor(score, rawEnergy, intoSection) {
    const sections = score.sections ?? [];
    const current = sections[this.sectionIndex];
    const previous = sections[this.sectionIndex - 1];
    // A drop is a section arriving markedly louder than the one before it, and
    // only for its opening seconds - a section that is merely loud throughout
    // is a chorus, and cutting every bar through all of it would be exhausting.
    if (current && previous
      && current.energy_mean - previous.energy_mean > 0.12
      && intoSection < 6) return 'drop';
    if (rawEnergy > 0.60) return 'chorus';
    if (rawEnergy > 0.34) return 'build';
    return 'quiet';
  }

  /**
   * Move the camera toward its shot.
   *
   * Position and look-at are eased separately and at different rates: the eye
   * moves more slowly than its aim, which is how a real operator behaves and
   * keeps the subject centred during a long move.
   */
  updateCamera(deltaSec) {
    const shot = this.shot;
    // The music's clock, not the browser's. This read performance.now(), so the
    // camera drifted on while playback was paused, ignored a seek, and sat at a
    // different point for every person in the room - in an Activity where the
    // whole point is that several people watch one performance together.
    const t = this.scoreSec;

    // Continuous drift on every axis, so no shot is ever locked off.
    const drift = [0, 1, 2].map(
      (axis) => Math.sin((t * Math.PI * 2) / shot.drift.period[axis] + axis * 1.7)
        * shot.drift.amp[axis],
    );

    // Loud passages pull the camera back and up a little, which gives dynamics
    // to sections without needing a separate shot for them.
    const pullBack = 1 + this.energy * 0.22;

    const subject = this.shotTarget !== null ? this.dancers[this.shotTarget] : null;
    const anchor = subject ? [subject.x, 0, subject.z] : [0, 0, 0];

    const wantedPosition = [
      anchor[0] + (shot.position[0] + drift[0]) * pullBack,
      (shot.position[1] + drift[1]) * pullBack,
      anchor[2] + (shot.position[2] + drift[2]) * pullBack,
    ];
    const wantedLook = [
      anchor[0] + shot.look[0],
      shot.look[1] + this.energy * 0.15,
      anchor[2] + shot.look[2],
    ];

    if (this.pendingCut) {
      // A cut is instantaneous: the camera is simply somewhere else on the next
      // frame. Easing between two setups is a *move*, and a move that takes a
      // second to arrive turns every edit into a swoop - which is why this read
      // as one endless drifting take however many shots were in the table.
      //
      // The drift below still eases, so the new angle is alive from the moment
      // it lands rather than being locked off.
      this.pendingCut = false;
      this.camera.position = wantedPosition;
      this.camera.look = wantedLook;
    } else {
      this.camera.position = easeVec(this.camera.position, wantedPosition, 0.55, deltaSec);
      this.camera.look = easeVec(this.camera.look, wantedLook, 1.1, deltaSec);
    }
    this.refreshBasis();
  }

  /**
   * Recompute the camera's look-at basis: forward toward the target, right
   * perpendicular to forward and world up, up the cross of those. That is what
   * lets the camera sit anywhere and still frame its subject.
   *
   * ## Why this is not inside `project()`
   *
   * It was, and the basis depends only on the camera - which moves exactly once
   * per frame - so every projection rebuilt an identical result. Counted from
   * the call sites: 28 projections per dancer (depth sort, shadow, root, twelve
   * bones at two ends each, head) plus up to 246 for the `rings` environment,
   * so eight figures rebuilt this same basis over 470 times in one frame. Each
   * rebuild cost two square roots and seven array allocations.
   *
   * Must be called whenever the camera moves. `updateCamera` does so at its end,
   * and the constructor seeds it so the first frame can project before the
   * camera has ever been advanced.
   */
  refreshBasis() {
    const eye = this.camera.position;
    const forward = unit(sub(this.camera.look, eye));
    const right = unit(cross(forward, WORLD_UP));
    this.basis = { eye, forward, right, up: cross(right, forward) };
  }

  /**
   * Project a world point through the free camera.
   *
   * The hottest function in the renderer. Vector components are inlined rather
   * than going through `sub()` and a dot-product helper, because the temporary
   * array those allocated was - once the basis moved out - the only remaining
   * allocation on the path besides the returned object.
   *
   * @param {[number, number, number]} point World coordinates, Y up.
   * @param {number} width
   * @param {number} height
   * @returns {{x: number, y: number, scale: number, depth: number}}
   */
  project(point, width, height) {
    const { eye, forward, right, up } = this.basis;
    const rx = point[0] - eye[0];
    const ry = point[1] - eye[1];
    const rz = point[2] - eye[2];

    // Clamped so a point behind the eye cannot invert the projection.
    const depth = Math.max(0.45, rx * forward[0] + ry * forward[1] + rz * forward[2]);
    const focal = Math.min(width, height) * 0.95;
    const scale = focal / depth;

    return {
      x: width / 2 + (rx * right[0] + ry * right[1] + rz * right[2]) * scale,
      y: height * 0.58 - (rx * up[0] + ry * up[1] + rz * up[2]) * scale,
      scale,
      depth,
    };
  }

  /** Saturated gradient with a beat-driven wash. */
  /**
   * Draw the environment for the current section.
   *
   * A flat gradient behind the figures reads as an empty void, and the dancers
   * end up looking like they are performing in nothing. Each environment is a
   * few large shapes projected through the same camera as the figures, so they
   * move with it and sell the space rather than sitting flat behind everything.
   *
   * They are deliberately simple: anything detailed competes with the dancers
   * for attention, and the dancers are the subject.
   */
  drawEnvironment(context, width, height, beatCount) {
    const kind = ENVIRONMENTS[this.sectionIndex % ENVIRONMENTS.length];
    const [from, to] = this.palette;
    // Score time, for the same reason as the camera: rain that keeps falling
    // while the track is paused, or that is at a different point on every
    // viewer's screen, is not part of the performance.
    const t = this.scoreSec;

    if (kind === 'stage') {
      // Rear wall with a truss of lights above, which is the most literal
      // reading of "these figures are performing".
      const lights = 9;
      for (let i = 0; i < lights; i++) {
        const x = ((i + 0.5) / lights - 0.5) * 12;
        const head = this.project([x, 5.2, 6], width, height);
        if (!Number.isFinite(head.x)) continue;
        const radius = Math.max(8, head.scale * 1.6);
        const beam = context.createRadialGradient(
          head.x, head.y, 0, head.x, head.y, radius,
        );
        const lit = 0.25 + 0.6 * Math.abs(Math.sin(beatCount * 0.5 + i));
        beam.addColorStop(0, mix(from, '#ffffff', 0.6));
        beam.addColorStop(1, 'rgba(0,0,0,0)');
        context.globalAlpha = lit * 0.5;
        context.fillStyle = beam;
        fillGlow(context, head.x, head.y, radius, width, height);
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'columns') {
      // Receding pillars either side, which give the eye something to measure
      // the camera's movement against.
      for (let i = 0; i < 8; i++) {
        for (const side of [-1, 1]) {
          const z = 4 + i * 5;
          const top = this.project([side * 5.5, 4.6, z], width, height);
          const base = this.project([side * 5.5, 0, z], width, height);
          if (!Number.isFinite(top.x)) continue;
          const w = Math.max(2, top.scale * 0.55);
          context.fillStyle = mix(to, '#000000', 0.55 + i * 0.05);
          context.globalAlpha = Math.max(0, 0.55 - i * 0.06);
          context.fillRect(top.x - w / 2, top.y, w, base.y - top.y);
        }
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'skyline') {
      // A city silhouette on the horizon: the figures are dancing on a rooftop.
      for (let i = 0; i < 26; i++) {
        const x = ((i * 37) % 100) / 100 - 0.5;
        const h = 1.5 + ((i * 53) % 100) / 100 * 4.5;
        const z = 30 + ((i * 71) % 100) / 100 * 20;
        const top = this.project([x * 40, h, z], width, height);
        const base = this.project([x * 40, 0, z], width, height);
        if (!Number.isFinite(top.x)) continue;
        const w = Math.max(3, top.scale * (0.8 + ((i * 29) % 60) / 100));
        context.fillStyle = mix(from, '#000000', 0.72);
        context.globalAlpha = 0.7;
        context.fillRect(top.x - w / 2, top.y, w, base.y - top.y);
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'rings') {
      // Concentric arcs on the floor, pulsing outward on the beat.
      for (let ring = 1; ring <= 6; ring++) {
        const radius = ring * 2.4;
        // Segments scale with the ring rather than a flat 40 for all six. A flat
        // count meant the innermost ring - a couple of world units across, and
        // often only a few dozen pixels on screen - was tessellated as finely as
        // the outermost, and the six rings together cost 246 projections per
        // frame, more than eight dancers combined. Scaling gives the same
        // smoothness where it can be seen for about a third fewer.
        const segments = 12 + ring * 4;
        context.beginPath();
        for (let a = 0; a <= segments; a++) {
          const angle = (a / segments) * Math.PI * 2;
          const point = this.project(
            [Math.cos(angle) * radius, 0.02, Math.sin(angle) * radius], width, height,
          );
          if (!Number.isFinite(point.x)) break;
          if (a === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        }
        const pulse = Math.max(0, 1 - Math.abs((beatCount % 6) - ring));
        context.strokeStyle = mix(from, to, ring / 6);
        context.globalAlpha = 0.14 + pulse * 0.45;
        context.lineWidth = 1 + pulse * 3;
        context.stroke();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'forest') {
      // Trunks at varying depths. Vertical repetition at different scales is
      // the cheapest convincing depth cue there is.
      for (let i = 0; i < 22; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const z = 5 + ((i * 37) % 100) / 100 * 26;
        const x = side * (3.5 + ((i * 53) % 100) / 100 * 9);
        const top = this.project([x, 6.5, z], width, height);
        const base = this.project([x, 0, z], width, height);
        if (!Number.isFinite(top.x)) continue;
        const w = Math.max(2, top.scale * 0.22);
        context.fillStyle = mix(from, '#000000', 0.78);
        context.globalAlpha = Math.max(0.15, 0.75 - z * 0.02);
        context.fillRect(top.x - w / 2, top.y, w, base.y - top.y);
      }
      // Light filtering through a canopy.
      const shafts = context.createLinearGradient(0, 0, width * 0.3, height);
      shafts.addColorStop(0, mix(to, '#ffffff', 0.4));
      shafts.addColorStop(1, 'rgba(0,0,0,0)');
      context.globalAlpha = 0.10 + this.energy * 0.08;
      context.fillStyle = shafts;
      context.fillRect(0, 0, width, height);
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'club') {
      // Sweeping beams from above, pivoting on the beat rather than smoothly -
      // which is how moving-head fixtures actually behave.
      const beams = 5;
      for (let i = 0; i < beams; i++) {
        const swing = Math.sin(Math.floor(beatCount * 2) * 0.7 + i * 1.9);
        const originX = width * ((i + 0.5) / beams);
        const spread = width * 0.10;
        const targetX = originX + swing * width * 0.28;
        context.beginPath();
        context.moveTo(originX - spread * 0.15, 0);
        context.lineTo(originX + spread * 0.15, 0);
        context.lineTo(targetX + spread, height);
        context.lineTo(targetX - spread, height);
        context.closePath();
        const beam = context.createLinearGradient(originX, 0, targetX, height);
        beam.addColorStop(0, mix(i % 2 === 0 ? from : to, '#ffffff', 0.55));
        beam.addColorStop(1, 'rgba(0,0,0,0)');
        context.globalAlpha = 0.10 + this.energy * 0.16;
        context.fillStyle = beam;
        context.fill();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'desert') {
      // Dunes as overlapping arcs, and a large low sun.
      const sun = this.project([2, 5, 34], width, height);
      if (Number.isFinite(sun.x)) {
        const radius = sun.scale * 2.4;
        const disc = context.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, radius);
        disc.addColorStop(0, mix(to, '#ffffff', 0.6));
        disc.addColorStop(0.5, to);
        disc.addColorStop(1, 'rgba(0,0,0,0)');
        context.globalAlpha = 0.55;
        context.fillStyle = disc;
        fillGlow(context, sun.x, sun.y, radius, width, height);
      }
      for (let i = 0; i < 5; i++) {
        const z = 12 + i * 7;
        const crest = this.project([0, 1.4 + i * 0.5, z], width, height);
        if (!Number.isFinite(crest.y)) continue;
        context.beginPath();
        context.moveTo(-width * 0.1, height);
        for (let x = -width * 0.1; x <= width * 1.1; x += width * 0.08) {
          const wave = Math.sin(x * 0.004 + i * 2.1) * height * 0.03;
          context.lineTo(x, crest.y + wave);
        }
        context.lineTo(width * 1.1, height);
        context.closePath();
        context.fillStyle = mix(from, '#000000', 0.55 - i * 0.06);
        context.globalAlpha = 0.8;
        context.fill();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'rain') {
      // A downpour behind the dancers, plus a wet floor sheen.
      context.strokeStyle = mix(to, '#ffffff', 0.5);
      context.globalAlpha = 0.16 + this.energy * 0.14;
      context.lineWidth = 1;
      context.beginPath();
      for (let i = 0; i < 220; i++) {
        const x = ((i * 7919) % 1000) / 1000 * width;
        const drift = (t * 420 + ((i * 6271) % 1000)) % height;
        context.moveTo(x, drift);
        context.lineTo(x - 4, drift + 22);
      }
      context.stroke();
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'arena') {
      // Tiered seating rising behind the stage, speckled with a crowd.
      for (let tier = 0; tier < 5; tier++) {
        const y = this.project([0, 2 + tier * 2.2, 26], width, height);
        if (!Number.isFinite(y.y)) continue;
        context.fillStyle = mix(from, '#000000', 0.80 - tier * 0.05);
        context.globalAlpha = 0.75;
        context.fillRect(0, y.y, width, Math.max(4, y.scale * 0.9));

        // Crowd: small flecks catching the light, brighter on the beat.
        context.fillStyle = mix(to, '#ffffff', 0.5);
        context.globalAlpha = 0.10 + attack(beatCount % 1) * 0.30;
        for (let i = 0; i < 60; i++) {
          const x = ((i * 4813 + tier * 97) % 1000) / 1000 * width;
          context.fillRect(x, y.y + 2, 2, 2);
        }
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'neon') {
      // A back-alley wall of signs. Vertical strips either side, each flickering
      // on its own band, so the set pulses with the spectrum without anything
      // having to move.
      for (let i = 0; i < 14; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const z = 3 + ((i * 37) % 100) / 100 * 20;
        const top = this.project([side * 4.6, 3.6 - ((i * 53) % 100) / 100 * 1.6, z], width, height);
        const base = this.project([side * 4.6, 0.6, z], width, height);
        if (!Number.isFinite(top.x)) continue;
        const w = Math.max(2, top.scale * 0.10);
        const lit = 0.35 + 0.65 * Math.abs(Math.sin(beatCount * 0.7 + i * 1.9));
        context.fillStyle = mix(i % 3 === 0 ? from : to, '#ffffff', 0.45);
        context.globalAlpha = lit * 0.75;
        context.fillRect(top.x - w / 2, top.y, w, base.y - top.y);
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'synthwave') {
      // Retro horizon: a low sun with scan gaps, over a receding grid. Both are
      // drawn with straight lines rather than projected geometry, which keeps a
      // busy-looking set to a few dozen operations.
      const sunY = height * 0.42;
      const sunR = Math.min(width, height) * 0.16;
      const disc = context.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
      disc.addColorStop(0, mix(to, '#fff3a0', 0.55));
      disc.addColorStop(1, mix(from, '#ff2d95', 0.45));
      context.fillStyle = disc;
      context.beginPath();
      context.arc(width / 2, sunY, sunR, 0, Math.PI * 2);
      context.fill();
      // Scan gaps cut across the lower half of the disc.
      context.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 7; i++) {
        const y = sunY + (i / 7) * sunR;
        context.fillRect(width / 2 - sunR, y, sunR * 2, sunR * (0.02 + i * 0.012));
      }
      context.globalCompositeOperation = 'source-over';

      // Horizon grid. Lines converge on the vanishing point, and the horizontal
      // rungs scroll toward the viewer on the beat.
      context.strokeStyle = mix(to, '#ffffff', 0.30);
      context.globalAlpha = 0.30;
      context.lineWidth = 1;
      context.beginPath();
      const horizon = sunY + sunR * 0.55;
      for (let i = -8; i <= 8; i++) {
        context.moveTo(width / 2 + i * width * 0.03, horizon);
        context.lineTo(width / 2 + i * width * 0.22, height);
      }
      for (let i = 0; i < 9; i++) {
        const p = ((i + (beatCount * 0.25) % 1) / 9) ** 2.2;
        const y = horizon + (height - horizon) * p;
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'underwater') {
      // Caustics: overlapping bright bands rippling across the floor, which is
      // the one cue that reads unmistakably as being below the surface.
      context.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 9; i++) {
        const phase = t * (0.4 + i * 0.07) + i * 1.7;
        const y = height * (0.30 + (i / 9) * 0.68) + Math.sin(phase) * height * 0.02;
        const band = context.createLinearGradient(0, y - height * 0.03, 0, y + height * 0.03);
        band.addColorStop(0, 'rgba(0,0,0,0)');
        band.addColorStop(0.5, mix(to, '#ffffff', 0.55));
        band.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = band;
        context.globalAlpha = 0.05 + this.energy * 0.07;
        context.fillRect(0, y - height * 0.03, width, height * 0.06);
      }
      context.globalCompositeOperation = 'source-over';

      // Bubbles rising on their own timers.
      context.fillStyle = mix('#ffffff', to, 0.35);
      for (let i = 0; i < 26; i++) {
        const speed = 0.10 + ((i * 29) % 100) / 100 * 0.16;
        const rise = 1 - ((t * speed + ((i * 71) % 100) / 100) % 1);
        const x = ((i * 4813) % 1000) / 1000 * width
          + Math.sin(t * 1.3 + i) * width * 0.012;
        const r = 1.5 + ((i * 53) % 100) / 100 * 3.5;
        context.globalAlpha = 0.10 + rise * 0.30;
        context.beginPath();
        context.arc(x, rise * height, r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'volcano') {
      // Light from below rather than above, which inverts how the figures read
      // against the set - they become silhouettes lit at the feet.
      const floor = context.createLinearGradient(0, height, 0, height * 0.45);
      floor.addColorStop(0, mix('#ff6a1a', to, 0.25));
      floor.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = floor;
      context.globalAlpha = 0.30 + this.energy * 0.35 + attack(beatCount % 1) * 0.20;
      context.fillRect(0, height * 0.45, width, height * 0.55);

      // Embers drifting upward, fading as they cool.
      context.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 40; i++) {
        const speed = 0.06 + ((i * 37) % 100) / 100 * 0.12;
        const rise = 1 - ((t * speed + ((i * 91) % 100) / 100) % 1);
        const x = ((i * 6271) % 1000) / 1000 * width
          + Math.sin(t * 0.7 + i * 2.1) * width * 0.03;
        context.fillStyle = mix('#ffd08a', '#ff4d16', rise);
        context.globalAlpha = (1 - rise) * 0.75;
        const r = 1 + (1 - rise) * 2.2;
        context.beginPath();
        context.arc(x, height * (0.35 + rise * 0.68), r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'cave') {
      // Stalactites hanging from above and crystals glowing on the floor. The
      // teeth are drawn as triangles straight in screen space - projecting them
      // would cost far more than the depth cue is worth at this scale.
      context.fillStyle = mix('#0b0f1a', from, 0.16);
      context.beginPath();
      for (let i = 0; i < 22; i++) {
        const x = (i / 22) * width + ((i * 53) % 100) / 100 * width * 0.02;
        const w = width * (0.018 + ((i * 37) % 100) / 100 * 0.026);
        const h = height * (0.06 + ((i * 71) % 100) / 100 * 0.20);
        context.moveTo(x - w / 2, 0);
        context.lineTo(x + w / 2, 0);
        context.lineTo(x, h);
        context.closePath();
      }
      context.fill();

      // Crystals, pulsing on their own bands.
      for (let i = 0; i < 12; i++) {
        const z = 4 + ((i * 41) % 100) / 100 * 16;
        const x = (((i * 67) % 100) / 100 - 0.5) * 11;
        const point = this.project([x, 0.15, z], width, height);
        if (!Number.isFinite(point.x)) continue;
        const r = Math.max(3, point.scale * 0.09);
        const lit = 0.30 + 0.70 * Math.abs(Math.sin(beatCount * 0.55 + i * 2.3));
        const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, r * 4);
        glow.addColorStop(0, mix(to, '#ffffff', 0.50));
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = glow;
        context.globalAlpha = lit * 0.55;
        fillGlow(context, point.x, point.y, r * 4, width, height);
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'storm') {
      // Distinct from `rain`: this is the sky rather than the water. Lightning
      // fires on strong beats and the flash is what lights the set, so the whole
      // frame changes brightness rather than anything being drawn twice.
      const strike = attack((beatCount * 0.5) % 1) * Math.min(1, this.punch * 1.6);
      if (strike > 0.04) {
        context.fillStyle = mix('#ffffff', to, 0.25);
        context.globalAlpha = strike * 0.42;
        context.fillRect(0, 0, width, height);

        // The bolt itself: a jagged polyline seeded so it is a different shape
        // on each strike rather than the same lightning every time.
        const seed = Math.floor(beatCount * 0.5);
        let x = width * (0.2 + ((seed * 37) % 100) / 100 * 0.6);
        context.strokeStyle = '#ffffff';
        context.globalAlpha = strike;
        context.lineWidth = 1.5 + strike * 2;
        context.beginPath();
        context.moveTo(x, 0);
        for (let i = 1; i <= 7; i++) {
          x += (((seed * 53 + i * 29) % 100) / 100 - 0.5) * width * 0.09;
          context.lineTo(x, (i / 7) * height * 0.62);
        }
        context.stroke();
      }

      // Heavy slanting rain behind it.
      context.strokeStyle = mix(to, '#ffffff', 0.35);
      context.globalAlpha = 0.14 + this.energy * 0.12;
      context.lineWidth = 1;
      context.beginPath();
      for (let i = 0; i < 260; i++) {
        const rx = ((i * 7919) % 1000) / 1000 * width;
        const drift = (t * 620 + ((i * 6271) % 1000)) % height;
        context.moveTo(rx, drift);
        context.lineTo(rx - 9, drift + 30);
      }
      context.stroke();
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'aurora') {
      // Polar curtains: vertical ribbons that ripple horizontally and fade at
      // both ends. Built from a handful of gradient strips rather than per-pixel
      // noise, which is what keeps it inexpensive.
      context.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const phase = t * (0.13 + i * 0.04) + i * 2.2;
        const cx = width * (0.5 + Math.sin(phase) * 0.34);
        const w = width * (0.05 + 0.03 * Math.sin(phase * 1.7));
        const curtain = context.createLinearGradient(cx, height * 0.08, cx, height * 0.72);
        curtain.addColorStop(0, 'rgba(0,0,0,0)');
        curtain.addColorStop(0.4, mix(i % 2 === 0 ? to : from, '#ffffff', 0.35));
        curtain.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = curtain;
        context.globalAlpha = 0.10 + this.energy * 0.16;
        context.fillRect(cx - w, height * 0.08, w * 2, height * 0.64);
      }
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'ice') {
      // A frozen field: shards standing out of the floor, catching light along
      // one edge. Projected rather than screen-space, so they sit in the world
      // and the camera moves past them.
      for (let i = 0; i < 16; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const z = 6 + ((i * 41) % 100) / 100 * 22;
        const x = side * (3 + ((i * 67) % 100) / 100 * 8);
        const tall = 1.6 + ((i * 29) % 100) / 100 * 3.4;
        const base = this.project([x, 0, z], width, height);
        const tip = this.project([x + side * 0.4, tall, z], width, height);
        if (!Number.isFinite(base.x) || !Number.isFinite(tip.x)) continue;
        const w = Math.max(2, base.scale * 0.30);
        context.beginPath();
        context.moveTo(base.x - w, base.y);
        context.lineTo(tip.x, tip.y);
        context.lineTo(base.x + w, base.y);
        context.closePath();
        context.globalAlpha = Math.max(0.12, 0.62 - z * 0.016);
        context.fillStyle = mix(to, '#eaffff', 0.55);
        context.fill();
        // The lit edge, which is what makes it read as ice rather than rock.
        context.globalAlpha = Math.max(0.10, 0.5 - z * 0.014);
        context.strokeStyle = '#ffffff';
        context.lineWidth = Math.max(1, base.scale * 0.03);
        context.beginPath();
        context.moveTo(base.x - w, base.y);
        context.lineTo(tip.x, tip.y);
        context.stroke();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'temple') {
      // Stepped stone and hanging banners. The steps are drawn back to front so
      // the nearer ones overlap correctly without a depth sort.
      for (let step = 5; step >= 0; step--) {
        const z = 16 + step * 2.4;
        const y = step * 0.55;
        const left = this.project([-9, y, z], width, height);
        const right = this.project([9, y, z], width, height);
        const front = this.project([-9, y - 0.55, z - 2.4], width, height);
        if (!Number.isFinite(left.x) || !Number.isFinite(front.x)) continue;
        context.globalAlpha = 0.55 - step * 0.05;
        context.fillStyle = mix(from, '#1b1208', 0.72 - step * 0.04);
        context.fillRect(left.x, left.y, right.x - left.x, Math.max(2, front.y - left.y));
      }
      // Banners, swaying on score time so every viewer sees the same cloth.
      for (let i = 0; i < 4; i++) {
        const x = -6 + i * 4;
        const top = this.project([x, 6.2, 20], width, height);
        const bottom = this.project([x + Math.sin(t * 0.4 + i) * 0.25, 2.2, 20], width, height);
        if (!Number.isFinite(top.x)) continue;
        const w = Math.max(3, top.scale * 0.5);
        context.globalAlpha = 0.5;
        context.fillStyle = mix(i % 2 === 0 ? from : to, '#000000', 0.35);
        context.beginPath();
        context.moveTo(top.x - w, top.y);
        context.lineTo(top.x + w, top.y);
        context.lineTo(bottom.x + w * 0.8, bottom.y);
        context.lineTo(bottom.x - w * 0.8, bottom.y);
        context.closePath();
        context.fill();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'space') {
      // Orbital: a starfield, and the limb of a planet curving below. The stars
      // are hashed from their index rather than stored, so there is no array to
      // allocate and every viewer gets the same sky.
      context.fillStyle = '#ffffff';
      for (let i = 0; i < 90; i++) {
        const hx = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
        const hy = Math.abs(Math.sin(i * 78.233) * 43758.5453) % 1;
        const twinkle = 0.35 + 0.35 * Math.sin(t * 0.8 + i);
        context.globalAlpha = twinkle * (0.4 + this.energy * 0.4);
        const size = hx > 0.93 ? 2.2 : 1.1;
        context.fillRect(hx * width, hy * height * 0.72, size, size);
      }
      // Planet limb: one big arc with an atmospheric rim.
      const cx = width * 0.5;
      const cy = height * 1.55;
      const radius = Math.max(width, height) * 0.95;
      context.globalAlpha = 0.9;
      context.fillStyle = mix(from, '#04060f', 0.55);
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 0.30 + this.energy * 0.2;
      context.strokeStyle = mix(to, '#ffffff', 0.5);
      context.lineWidth = Math.max(2, height * 0.006);
      context.beginPath();
      context.arc(cx, cy, radius, Math.PI, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'factory') {
      // Girders overhead and pistons that stamp on the beat. `beatCount` is
      // already derived from the score, so the stamp lands with the music.
      for (let i = 0; i < 5; i++) {
        const z = 10 + i * 5;
        const left = this.project([-11, 7.5, z], width, height);
        const right = this.project([11, 7.5, z], width, height);
        if (!Number.isFinite(left.x)) continue;
        context.globalAlpha = Math.max(0.12, 0.5 - i * 0.07);
        context.fillStyle = mix(from, '#101014', 0.8);
        context.fillRect(left.x, left.y, right.x - left.x, Math.max(3, left.scale * 0.22));
      }
      for (let i = 0; i < 4; i++) {
        const x = -7.5 + i * 5;
        // Each piston runs on its own beat subdivision, so they hammer in a
        // pattern rather than in unison.
        const stroke = Math.abs(Math.sin(beatCount * Math.PI * (0.5 + i * 0.25)));
        const headY = 5.4 - stroke * 2.2;
        const top = this.project([x, 7.4, 24], width, height);
        const head = this.project([x, headY, 24], width, height);
        if (!Number.isFinite(top.x)) continue;
        const w = Math.max(2, top.scale * 0.10);
        context.globalAlpha = 0.55;
        context.fillStyle = mix(to, '#2a2a33', 0.6);
        context.fillRect(top.x - w / 2, top.y, w, head.y - top.y);
        context.fillStyle = mix(to, '#ffffff', 0.35);
        context.fillRect(head.x - w * 2, head.y, w * 4, Math.max(3, top.scale * 0.16));
      }
      context.globalAlpha = 1;
      return;
    }

    // 'open' - nothing but the gradient, so the set is not always busy.
    void t;
  }

  /**
   * Draw the section's props.
   *
   * Drawn after the environment and before the dancers, so they read as
   * standing behind and around the cast. Kept to a handful of large shapes for
   * the same reason as the environments: anything fussy competes with the
   * figures, and the figures are the subject.
   *
   * Chosen with a different stride than the environment, so the two lists do
   * not lock into the same pairing every time round.
   */
  drawProps(context, width, height, beatCount) {
    const kind = PROPS[(this.sectionIndex * 3) % PROPS.length];
    if (kind === 'none') return;
    const [from, to] = this.palette;
    const t = this.scoreSec;

    if (kind === 'speakers') {
      // Stacks either side of the floor, with cones that push on the beat.
      for (const side of [-1, 1]) {
        const x = side * 7.5;
        const base = this.project([x, 0, 14], width, height);
        const top = this.project([x, 4.2, 14], width, height);
        if (!Number.isFinite(base.x) || !Number.isFinite(top.x)) continue;
        const w = Math.max(6, base.scale * 0.9);
        context.globalAlpha = 0.8;
        context.fillStyle = mix(from, '#0a0a0e', 0.82);
        context.fillRect(base.x - w / 2, top.y, w, base.y - top.y);
        // Two cones per stack, swelling with the beat.
        const push = attack(beatCount % 1) * (0.3 + this.energy * 0.7);
        for (const level of [0.28, 0.66]) {
          const cone = this.project([x, 4.2 * level, 13.9], width, height);
          context.globalAlpha = 0.9;
          context.fillStyle = mix(to, '#000000', 0.5);
          context.beginPath();
          context.arc(cone.x, cone.y, w * (0.3 + push * 0.05), 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'discoball') {
      const ball = this.project([0, 7.2, 16], width, height);
      if (!Number.isFinite(ball.x)) return;
      const radius = Math.max(6, ball.scale * 0.45);
      // Hangs from the ceiling and turns on score time, so the glints are at
      // the same angle for everyone in the room.
      const spin = t * 0.6;
      context.globalAlpha = 0.5;
      context.strokeStyle = mix(from, '#ffffff', 0.4);
      context.lineWidth = Math.max(1, radius * 0.05);
      context.beginPath();
      context.moveTo(ball.x, 0);
      context.lineTo(ball.x, ball.y - radius);
      context.stroke();

      context.globalAlpha = 0.85;
      context.fillStyle = mix(to, '#141420', 0.55);
      context.beginPath();
      context.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
      context.fill();
      // Facets: a ring of quads catching light as it turns.
      for (let i = 0; i < 12; i++) {
        const angle = spin + (i / 12) * Math.PI * 2;
        const face = Math.cos(angle);
        if (face <= 0) continue;
        context.globalAlpha = 0.15 + face * (0.35 + this.energy * 0.4);
        context.fillStyle = '#ffffff';
        context.fillRect(
          ball.x + Math.sin(angle) * radius * 0.7 - radius * 0.12,
          ball.y - radius * 0.55 + (i % 3) * radius * 0.4,
          radius * 0.24, radius * 0.24,
        );
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'lanterns') {
      // Floating lights at varying depths, bobbing on score time.
      for (let i = 0; i < 12; i++) {
        const x = -8 + ((i * 47) % 100) / 100 * 16;
        const z = 8 + ((i * 31) % 100) / 100 * 18;
        const y = 2.2 + ((i * 17) % 100) / 100 * 3.5 + Math.sin(t * 0.5 + i) * 0.3;
        const p = this.project([x, y, z], width, height);
        if (!Number.isFinite(p.x)) continue;
        const radius = Math.max(2, p.scale * 0.12);
        const glow = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3);
        glow.addColorStop(0, mix(to, '#fff0c0', 0.7));
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        context.globalAlpha = 0.5 + this.energy * 0.3;
        context.fillStyle = glow;
        // Bounded to the glow's own square: a radial gradient painting nothing
        // past its radius still rasterises whatever rectangle it is given.
        context.fillRect(p.x - radius * 3, p.y - radius * 3, radius * 6, radius * 6);
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'crates') {
      for (let i = 0; i < 7; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const x = side * (6 + ((i * 23) % 100) / 100 * 3.5);
        const z = 11 + ((i * 59) % 100) / 100 * 12;
        const size = 0.9 + ((i * 13) % 100) / 100 * 0.7;
        const base = this.project([x, 0, z], width, height);
        const top = this.project([x, size, z], width, height);
        if (!Number.isFinite(base.x)) continue;
        const w = Math.max(4, base.scale * size * 0.55);
        context.globalAlpha = 0.7;
        context.fillStyle = mix(from, '#141018', 0.7);
        context.fillRect(base.x - w / 2, top.y, w, base.y - top.y);
        context.globalAlpha = 0.35;
        context.strokeStyle = mix(to, '#ffffff', 0.3);
        context.lineWidth = 1;
        context.strokeRect(base.x - w / 2, top.y, w, base.y - top.y);
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'mics') {
      for (let i = 0; i < 3; i++) {
        const x = -3.5 + i * 3.5;
        const base = this.project([x, 0, 9], width, height);
        const head = this.project([x, 3.1, 9], width, height);
        if (!Number.isFinite(base.x)) continue;
        context.globalAlpha = 0.75;
        context.strokeStyle = mix(from, '#08080c', 0.65);
        context.lineWidth = Math.max(1.5, base.scale * 0.045);
        context.beginPath();
        context.moveTo(base.x, base.y);
        context.lineTo(head.x, head.y);
        context.stroke();
        context.fillStyle = mix(to, '#ffffff', 0.25);
        context.beginPath();
        context.arc(head.x, head.y, Math.max(2, base.scale * 0.09), 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      return;
    }

    if (kind === 'braziers') {
      // Fire baskets that flare on the beat.
      const flare = attack(beatCount % 1);
      for (const side of [-1, 1]) {
        const x = side * 6.5;
        const base = this.project([x, 0, 12], width, height);
        const bowl = this.project([x, 1.5, 12], width, height);
        if (!Number.isFinite(base.x)) continue;
        const w = Math.max(4, base.scale * 0.35);
        context.globalAlpha = 0.8;
        context.fillStyle = mix(from, '#0c0808', 0.75);
        context.fillRect(base.x - w * 0.25, bowl.y, w * 0.5, base.y - bowl.y);
        context.fillRect(bowl.x - w, bowl.y - w * 0.2, w * 2, w * 0.5);
        const height2 = w * (1.6 + flare * 1.4 + this.energy * 1.2);
        const fire = context.createRadialGradient(
          bowl.x, bowl.y - height2 * 0.4, 0, bowl.x, bowl.y - height2 * 0.4, height2,
        );
        fire.addColorStop(0, 'rgba(255,236,170,0.95)');
        fire.addColorStop(0.45, mix(to, '#ff7a1a', 0.6));
        fire.addColorStop(1, 'rgba(0,0,0,0)');
        context.globalAlpha = 0.55 + flare * 0.35;
        context.fillStyle = fire;
        context.fillRect(
          bowl.x - height2, bowl.y - height2 * 1.4, height2 * 2, height2 * 2,
        );
      }
      context.globalAlpha = 1;
    }
  }

  drawBackdrop(context, width, height, beatCount) {
    const [from, to] = this.palette;
    const gradient = context.createLinearGradient(0, 0, width * 0.3, height);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    const pulse = attack(beatCount % 1) * (0.25 + this.energy * 0.6);
    const washX = width * 0.5;
    const washY = height * 0.62;
    const washRadius = Math.max(width, height) * (0.30 + pulse * 0.15);
    const wash = context.createRadialGradient(
      washX, washY, 0, washX, washY, washRadius,
    );
    wash.addColorStop(0, `rgba(255,255,255,${0.20 + pulse * 0.28})`);
    wash.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = wash;
    // The gradient fill above is bounded, but the backdrop fill is not and must
    // not be: it is what clears the canvas each frame.
    fillGlow(context, washX, washY, washRadius, width, height);
  }

  /**
   * Ground plane: a soft horizon band rather than a wireframe grid.
   *
   * The grid read as stray lines cutting across the figures. A gradient horizon
   * gives the same depth cue - a floor meeting a distance - without drawing
   * anything the eye mistakes for geometry.
   */
  drawFloor(context, width, height) {
    const horizon = this.project([0, 0, 40], width, height);
    const nearEdge = this.project([0, 0, -8], width, height);
    const top = Math.max(0, Math.min(horizon.y, height));
    const bottom = Math.max(top + 1, Math.min(nearEdge.y, height * 1.4));

    const floor = context.createLinearGradient(0, top, 0, bottom);
    floor.addColorStop(0, 'rgba(0,0,0,0.00)');
    floor.addColorStop(0.35, 'rgba(0,0,0,0.10)');
    floor.addColorStop(1, 'rgba(0,0,0,0.30)');
    context.fillStyle = floor;
    context.fillRect(0, top, width, bottom - top);
  }

  /** Soft ellipse under a figure, grounding it on the floor. */
  drawShadow(context, width, height, dancer) {
    const base = this.project([dancer.x, 0, dancer.z], width, height);
    const radius = base.scale * 0.34 * dancer.build;
    if (!Number.isFinite(radius) || radius <= 0) return;
    context.save();
    context.globalAlpha = 0.22;
    context.fillStyle = '#000';
    context.beginPath();
    context.ellipse(base.x, base.y, radius, radius * 0.30, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  /** Advance a figure's floor position. */
  updatePosition(dancer, beatCount, meter, deltaSec) {
    // Where this frame sits in the phrase, and what that implies for how big the
    // performance should be and how tightly the cast should agree.
    const arc = phraseArc(this.phrasePosition);
    const spread = canonAmount(this.phrasePosition);

    // The canon term collapses to zero at both ends of a phrase, so the cast
    // lands together on structural beats and ripples only in between. Added to
    // the permanent per-figure jitter rather than replacing it.
    // A drop collapses the canon: the ripple that makes a phrase feel loose is
    // exactly wrong at the moment the whole room is supposed to hit together.
    const together = 1 - Math.min(1, this.dropHit ?? 0);
    const offset = dancer.beatOffset * together + dancer.canon * spread * together;
    // Read a little ahead of the music, by as long as the pose springs trail
    // their targets, so what is drawn lands on the beat rather than after it.
    const lead = SPRING_LAG_SEC * ((this.bpm > 0 ? this.bpm : 120) / 60);
    const dancerBeat = beatCount + offset + lead;
    const bar = (dancerBeat / meter) % 1;
    const beat = dancerBeat % 1;

    // Connecting movement at the head of a phrase. Counted in beats rather than
    // seconds so it scales with tempo: two beats of connector is two beats of
    // connector whether the track is 90bpm or 160.
    if (dancer.transitionBeats > 0) {
      dancer.transitionBeats -= deltaSec / (60 / (this.bpm > 0 ? this.bpm : 120));
    }
    const connecting = dancer.transitionBeats > 0;

    // Unison through a drop. Companion moves are what stops a cast reading as
    // clones for the other ninety percent of a track, but a drop is the one
    // moment everybody does the same thing, and the phrase system cannot
    // express that on its own - it assigns moves at phrase boundaries, and a
    // drop lands where it lands.
    const unison = (this.dropHit ?? 0) > 0.25;
    const moveName = connecting && !unison
      ? dancer.connector
      : (unison ? this.move : (dancer.move ?? this.move));
    // Falls through to a real move rather than undefined. Both earlier terms can
    // miss at once - they were the same bad name in the `sway` crash - and an
    // undefined here throws, which costs the whole visualisation for the session.
    const move = MOVES[moveName] ?? MOVES[this.move] ?? MOVES.step;
    const target = move(bar, beat, this.energy, this.punch);

    // Shared weight transfer, knee release, and downbeat compression make each
    // gesture originate from the floor instead of reading as an isolated pose.
    if (moveName !== 'jump' && moveName !== 'reach' && moveName !== 'idle') {
      const weight = Math.sin(dancerBeat * Math.PI);
      const downbeat = attack(beat);
      // The drop drives the whole group deeper into the floor on every
      // downbeat. Same term as the ordinary groove compression, scaled up -
      // a separate accent on top read as a twitch laid over the dance rather
      // than as the dance being bigger.
      const groove = (0.55 + this.energy * 0.65) * (1 + (this.dropHit ?? 0) * 0.8);
      target.bob -= downbeat * 0.045 * groove;
      target.sway += weight * 0.055 * groove;
      target.spineTwist -= weight * 5 * DEG * groove;
      target.legs[0].knee += Math.max(0, weight) * 8 * DEG * groove;
      target.legs[1].knee += Math.max(0, -weight) * 8 * DEG * groove;
    }

    // How big the dance is.
    //
    // Three things decide it, each for its own reason. The plan's intensity is
    // where this section stands in the song, so a chorus is danced harder than
    // the verse before it whatever their absolute levels. The live energy is
    // how loud this moment is. The phrase arc gives a routine somewhere to go
    // across its eight bars.
    //
    // This used to come from the lyric mood and energy, and was applied to
    // every authored angle about one fixed rest pose. That is what put the arms
    // over the heads: at a phrase peak on an ordinary section the factor was
    // 1.75, so a clap authored level with the shoulders, 95 degrees of swing,
    // was drawn at 151 with the hands at the height of the head. Measured
    // through the real camera over four cached tracks, an arm crossed a head on
    // screen in 35.0% of arm-frames and 57.9% of dancer-frames; 7.7% and 12.9%
    // since, most of it the side-on and floor-level shots, where a raised arm
    // really does pass in front of the head.
    const intensity = this.intensity;
    const gain = (0.8 + intensity * 0.3 + this.energy * 0.15)
      * (1 + (arc.intensity - 1) * 0.5);

    // Each move made bigger or smaller about its own centre.
    //
    // Scaling the distance from a fixed rest pose moved *where* a move happens
    // as well as how big it is, so every held position drifted toward the
    // extremes: the mic hand of `sing`, authored beside the face, ended up over
    // the head. Scaling only the departure from the move's own average keeps
    // every gesture where it was written and makes its travel livelier.
    const centre = this.centreOf(moveName, move, meter);
    const about = (value, middle, by = gain) => middle + (value - middle) * by;

    // A small accent on top, locked to the dancer's bar.
    //
    // This was the largest term in the motion: up to 40 degrees of arm swing
    // and 46 of lift, from free-running sines at unrelated rates, scaled by a
    // gain that reached 2.4 - so no two bars looked alike and the arms
    // wandered wherever the sum took them, which reads as flailing rather than
    // as a routine. Its job was keeping a held arm alive, and a few degrees in
    // time with the bar does that without competing with the move.
    const accent = 0.6 + intensity * 0.6;
    const pulse = Math.sin(bar * Math.PI * 2);
    const pulseHalf = Math.sin(bar * Math.PI * 4);

    // Weight shift.
    //
    // The single largest thing missing from the movement. A dancer is always
    // standing on one foot more than the other, and everything follows from
    // that: the hips ride over the supporting leg, that leg straightens to carry
    // the load, the free leg bends and lightens, and the shoulders counter-rotate
    // to stay balanced. Without it the figure is symmetrical at every instant,
    // which is why it read as a mechanism rather than a body.
    //
    // Where the move says which foot is standing, the move decides: a leg that
    // is kicked, lifted or folded is not carrying anything. Everywhere else the
    // weight alternates on the beat. That alternation used to decide alone,
    // and it put the weight on the left foot for the very beat a march lifts
    // the left knee - so the planted foot held the knee down, and the march
    // stood still.
    const freedom = (leg) => Math.abs(leg.swing) + Math.max(0, leg.knee - 20 * DEG) * 0.8;
    const favoured = Math.tanh((freedom(target.legs[1]) - freedom(target.legs[0])) * 5);
    const shiftPhase = (dancerBeat / 2) % 1;
    // Squared off rather than a sine: the transfer happens over part of the
    // cycle and then holds, which is how weight actually moves.
    const raw = Math.sin(shiftPhase * Math.PI * 2);
    const alternating = Math.sign(raw) * Math.min(1, Math.abs(raw) * 1.6);
    const weight = favoured + alternating * (1 - Math.abs(favoured));
    // +1 means weight on side 0, -1 on side 1. Written into a pair the dancer
    // already owns rather than a fresh array, because `drawDancer` needs it to
    // decide which foot is carrying the figure and may therefore be planted.
    dancer.support[0] = (1 + weight) / 2;
    dancer.support[1] = (1 - weight) / 2;
    // How far the body rides over the standing leg grows with the song, so a
    // quiet passage shifts gently and a chorus throws its weight about. The
    // support itself still alternates in full: the feet keep stepping.
    const shift = weight * (0.4 + intensity * 0.6);

    // Preparation before each accent, scaled by how much of an accent there is
    // to prepare for. A silent passage should not have the figures bracing for
    // impacts that never arrive, which is what an unscaled term would produce.
    const prep = anticipate(beat) * (0.2 + this.punch * 0.8);

    const armFlourish = [0, 1].map((side) => {
      const mirror = side === 0 ? 1 : -1;
      return {
        swing: pulse * 9 * mirror * DEG * accent,
        lift: pulseHalf * 8 * DEG * accent,
        // Opening as the arm swings forward, so the accent reads as a reach.
        elbow: -pulse * 8 * mirror * DEG * accent,
      };
    });

    const legFlourish = [0, 1].map((side) => {
      const mirror = side === 0 ? 1 : -1;
      return {
        swing: pulseHalf * 5 * mirror * DEG * accent,
        // Only ever softening a knee: a flourish that straightened one would
        // lock the leg the weight shift has just bent to take the load.
        knee: Math.max(0, pulse * mirror) * 8 * DEG * accent,
      };
    });

    // The hips and shoulders join in, so the whole body dances rather than only
    // the limbs, but by a few degrees. The body turn was up to 77 degrees on
    // its own before the move's turn was added, which spun figures side-on to
    // the camera and hid whatever their arms were doing.
    const bodyFlourish = {
      sway: pulse * 0.035 * accent,
      turn: pulse * 6 * DEG * accent,
      twist: -pulseHalf * 8 * DEG * accent,
      // A shallow bounce on the beat, not a leap.
      //
      // This was scaled by the performance gain, which reached 2.6 at high
      // energy - so the figures launched off the floor with nothing bringing
      // them down in any controlled way, which read as twitching rather than
      // dancing. Dancers stay grounded and move mostly in the hips and limbs;
      // vertical travel is punctuation, not the substance.
      //
      // The second term is the preparation: the hips sink slightly in the last
      // quarter-beat before an accent, so the figure gathers itself and then
      // meets the beat rather than being knocked into motion by it. It is
      // subtracted from a value that is already negative-going, so preparation
      // and the bounce it precedes work in the same direction.
      bob: -Math.abs(Math.sin(dancerBeat * Math.PI)) * 0.030 - prep * 0.030,
      // Folding into the preparation as well: a body that dips without its spine
      // following reads as the hips dropping out from under a rigid torso.
      prepBend: prep * 7 * DEG,
    };

    // The head keeps time.
    //
    // It was a free-running wobble of up to 47 degrees each way, doubled by the
    // gain and clamped at 45: the heads swung and scanned the room at random,
    // which more than anything made the figures look daft. A dancer's head
    // nods on the beat - deeper as the music hits harder and the song lifts -
    // and tilts a little with the bar.
    const nod = attack(beat) * (4 + this.punch * 6 + intensity * 6);
    const headExtra = {
      swing: -nod * DEG,
      lift: pulse * 4 * DEG * accent,
    };

    // Held positions of the trunk and head are amplified less than the limbs:
    // a bigger dance is bigger gestures, not a figure bent double.
    const bodyGain = Math.min(gain, 1.2);

    const amplified = {
      ...target,
      // Vertical travel is clamped hard. A move's own bob is a fraction of a
      // body height by design, but multiplying it by the gain turned a small
      // hop into a launch.
      // Riding over the supporting foot lowers the body slightly, as taking the
      // load compresses the standing leg.
      bob: clamp(
        target.bob * Math.min(gain, 1.15) + bodyFlourish.bob
          + Math.abs(shift) * 0.012,
        LIMITS.bob,
      ),
      // Hips travel toward the supporting side. This is the visible half of the
      // weight shift and the reason the figure looks planted rather than
      // hovering.
      sway: about(target.sway, centre.sway) + bodyFlourish.sway + shift * 0.10,
      // Not amplified. Turning is the one motion that hides the dance rather
      // than showing it, and `spin` authors a full turn per bar that any gain
      // would break at the bar line. See `nearestTurn` for the other half.
      turn: nearestTurn(target.turn + bodyFlourish.turn, dancer.pose.turn),
      spineBend: softClamp(
        about(target.spineBend, centre.spineBend, bodyGain) + bodyFlourish.prepBend,
        LIMITS.spine,
      ),
      // Shoulders counter-rotate against the hips, which is what keeps a shifting
      // body balanced and reads as ease rather than stiffness.
      spineTwist: softClamp(
        about(target.spineTwist, centre.spineTwist, bodyGain) + bodyFlourish.twist
          - shift * 8 * DEG,
        LIMITS.spine,
      ),
      head: {
        swing: softClamp(
          about(target.head.swing, centre.head.swing, bodyGain) + headExtra.swing, LIMITS.head,
        ),
        lift: softClamp(
          about(target.head.lift, centre.head.lift, bodyGain) + headExtra.lift, LIMITS.head,
        ),
      },
      arms: target.arms.map((arm, side) => {
        const middle = centre.arms[side];
        const swing = softClamp(
          about(arm.swing, middle.swing) + armFlourish[side].swing, LIMITS.armSwing,
        );
        const lift = softClamp(
          repel(
            about(arm.lift, middle.lift) + armFlourish[side].lift,
            dancer.pose.arms[side].lift,
            MIN_ARM_SPREAD, dancer.tuck.arms[side], deltaSec,
          ),
          LIMITS.armLift,
        );

        // Bend is barely amplified, unlike every other joint.
        //
        // Amplifying a fold is backwards. `poseAim` maps bend to reach
        // inversely - the more an elbow is folded, the shorter the arm gets and
        // the closer the hand sits to the shoulder - so scaling bend by the
        // usual factor makes a gesture *smaller* while spending the joint's
        // whole range doing it. A move authoring 80 degrees of bend came out at
        // 142, past the 112 limit, so it pinned there with the hand tucked into
        // the chest: measured at 27% of all frames, and the single largest
        // reason the figures rendered as one black mass.
        const elbow = softClamp(
          about(arm.elbow, middle.elbow, Math.min(gain, 1.12)) + armFlourish[side].elbow,
          LIMITS.elbow,
        );

        // Not amplified: how far an elbow flares is part of the shape, not
        // of its size.
        return { swing, lift, elbow, flare: arm.flare ?? 0 };
      }),
      legs: target.legs.map((leg, side) => {
        const middle = centre.legs[side];
        return {
          swing: softClamp(
            about(leg.swing, middle.swing) + legFlourish[side].swing, LIMITS.legSwing,
          ),
          lift: softClamp(
            repel(
              about(leg.lift, middle.lift),
              dancer.pose.legs[side].lift,
              MIN_LEG_SPREAD, dancer.tuck.legs[side], deltaSec,
            ),
            LIMITS.legLift,
          ),
          knee: softClamp(
            about(leg.knee, middle.knee) + legFlourish[side].knee, LIMITS.knee,
          ),
        };
      }),
    };

    // Chase the target pose. A rate around 14 keeps the movement crisp while
    // removing every step, and gives a roughly one-second cross-fade when the
    // move changes at a section boundary.
    easePose(dancer.pose, amplified, 1, deltaSec);
    const pose = dancer.pose;

    // Travel stops over the last bar of a phrase, and the pull back to the
    // formation slot strengthens. That is the whole of what makes a phrase
    // *land*: the figure stops wandering and arrives on its mark just as the
    // next phrase begins, instead of being caught mid-stride by the change.
    dancer.x += pose.travel * dancer.mirror * deltaSec * 0.5 * (1 - arc.settle);

    const [slotX, slotZ] = FORMATIONS[this.formation](dancer.index, this.dancers.length);
    const pull = 0.7 + arc.settle * 2.2;
    dancer.x += (slotX - dancer.x) * pull * deltaSec;
    dancer.z += (slotZ - dancer.z) * pull * deltaSec;

    dancer.facing = FACING_AUDIENCE + pose.turn * dancer.mirror;
  }

  /**
   * A move's centre: its average pose over one bar, at the current energy.
   *
   * What the dynamics amplify around. Moves are pure functions of the position
   * in the bar, so the mean over sixteen points of it is the pose the move
   * oscillates about - a clap held at chest height, a mic hand at the mouth -
   * and scaling only the departure from it makes a move *livelier* without
   * moving where it happens. Cached per move and energy band: sixteen calls to
   * a pose function once, rather than every frame for every dancer.
   *
   * @param {string} name
   * @param {Function} move
   * @param {number} meter
   * @returns {object} A pose, in the shape a move returns.
   */
  centreOf(name, move, meter) {
    const energyKey = Math.round(this.energy * 8);
    const punchKey = Math.round(this.punch * 8);
    const key = `${name}|${energyKey}|${punchKey}|${meter}`;
    const known = this.centres.get(key);
    if (known) return known;

    const samples = 16;
    const centre = {
      bob: 0, sway: 0, turn: 0, spineBend: 0, spineTwist: 0,
      head: { swing: 0, lift: 0 },
      arms: [{ swing: 0, lift: 0, elbow: 0, flare: 0 }, { swing: 0, lift: 0, elbow: 0, flare: 0 }],
      legs: [{ swing: 0, lift: 0, knee: 0 }, { swing: 0, lift: 0, knee: 0 }],
    };
    const share = 1 / samples;
    for (let k = 0; k < samples; k++) {
      const bar = k / samples;
      const pose = move(bar, (bar * (meter > 0 ? meter : 4)) % 1, energyKey / 8, punchKey / 8);
      for (const field of ['bob', 'sway', 'turn', 'spineBend', 'spineTwist']) {
        centre[field] += (pose[field] ?? 0) * share;
      }
      centre.head.swing += (pose.head?.swing ?? 0) * share;
      centre.head.lift += (pose.head?.lift ?? 0) * share;
      for (const side of [0, 1]) {
        for (const joint of ['swing', 'lift', 'elbow', 'flare']) {
          centre.arms[side][joint] += (pose.arms?.[side]?.[joint] ?? 0) * share;
        }
        for (const joint of ['swing', 'lift', 'knee']) {
          centre.legs[side][joint] += (pose.legs?.[side]?.[joint] ?? 0) * share;
        }
      }
    }
    // Bounded: thirty-four moves in eighty-one energy bands is the most there
    // can be, but a leak here would be one no test would notice.
    if (this.centres.size > 4000) this.centres.clear();
    this.centres.set(key, centre);
    return centre;
  }

  /**
   * Pose and draw one figure.
   *
   * ## Why this is stroked rather than filled
   *
   * Reference stick pictograms are a single merged silhouette: thick rounded
   * bars whose overlaps fuse into one shape. Earlier versions filled each bone
   * as its own tapered quad, which is structurally different - segments met at
   * visible seams, and tapering thinned every limb toward its joint. The figure
   * read as a spider no matter how the numbers were nudged, because the problem
   * was the construction, not the proportions.
   *
   * Stroking every bone at one uniform width with round caps produces the merged
   * silhouette directly: overlapping black strokes simply become one black
   * shape, which is exactly how those pictograms are built.
   *
   * ## Why the width is in pixels
   *
   * Limb width is a fraction of the figure's *projected* height rather than a
   * world constant. A world constant is correct at one camera distance and
   * spindly at every other, which is what happened whenever the camera pulled
   * back.
   */
  drawDancer(context, width, height, dancer, beatCount, meter, deltaSec) {
    // The smoothed pose, already advanced by updatePosition this frame. Drawing
    // from the raw move function here would reintroduce every step that the
    // easing exists to remove.
    const pose = dancer.pose;

    const s = dancer.build;
    // Low enough for a standing leg to reach the floor with the knee soft.
    //
    // It was 1.16, and a leg spans 1.10 of which `limb()` extends at most 98%:
    // the feet could not reach the floor at all. Measured over four cached
    // tracks, the lower foot of every figure hovered a median 0.170 of a build
    // above it - 0.094 at the tenth percentile - so the cast floated over its
    // own shadows. It is 0.000 now. At 1.02 a knee bent by 16 degrees puts the foot on the
    // floor, and `FLOOR` below catches the straighter ones.
    const hipHeight = 1.02 * s;
    const spineLen = SPINE_LEN * s;
    const shoulderHalf = SHOULDER_HALF * s;
    const upperArm = UPPER_ARM * s;
    const foreArm = FORE_ARM * s;
    const thigh = THIGH * s;
    const shin = SHIN * s;

    const yaw = dancer.facing;
    const root = [dancer.x + pose.sway * Math.cos(yaw), hipHeight + pose.bob, dancer.z];
    const toWorld = (local) => add(root, rotY(local, yaw));

    // How tall this figure is on screen right now, which everything scales from.
    const pRoot = this.project(root, width, height);
    const worldHeight = BODY_HEIGHT * s;
    const figurePx = worldHeight * pRoot.scale;
    if (!Number.isFinite(figurePx) || figurePx < 4) return;

    // The single most important number in this file. Much below 0.11 and the
    // figure reads as a stick insect rather than a stick figure.
    const limbPx = Math.max(3, figurePx * 0.105);
    const headPx = Math.max(4, figurePx * 0.100);

    let chestLocal = [0, spineLen, 0];
    chestLocal = rotX(chestLocal, pose.spineBend);
    const chest = toWorld(chestLocal);
    const chestYaw = yaw + pose.spineTwist;

    let headLocal = [0, (headPx / pRoot.scale) * 1.5, 0];
    headLocal = rotX(headLocal, pose.head.swing);
    headLocal = rotZ(headLocal, pose.head.lift);
    const head = add(chest, rotY(headLocal, chestYaw));

    const bones = [];
    // Elbows and knees, marked so limb articulation is visible.

    // Trunk, thicker so the body has mass.
    bones.push({ a: root, b: chest, w: limbPx * 2.10 });
    // Shoulder bar: what gives the figure width across the top.
    bones.push({
      a: add(chest, rotY([shoulderHalf, 0, 0], chestYaw)),
      b: add(chest, rotY([-shoulderHalf, 0, 0], chestYaw)),
      w: limbPx * 1.20,
    });
    // Hip bar, so legs emerge from a body rather than a point.
    bones.push({
      a: add(root, rotY([shoulderHalf * 0.62, 0, 0], yaw)),
      b: add(root, rotY([-shoulderHalf * 0.62, 0, 0], yaw)),
      w: limbPx * 1.40,
    });
    // Neck.
    bones.push({ a: chest, b: head, w: limbPx * 1.05 });

    // The hips in the arms' frame, for the torso clearance below.
    const hipsInChest = rotY(sub(root, chest), -chestYaw);

    pose.arms.forEach((arm, side) => {
      const sign = side === 0 ? 1 : -1;
      const shoulder = add(chest, rotY([sign * shoulderHalf, 0, 0], chestYaw));
      // Drawn as written; see `poseAim`. An arm's swing is written negative
      // for forward.
      const aimed = poseAim(-arm.swing, arm.lift * sign, arm.elbow);
      const flareBy = Math.min(1, Math.max(0, arm.flare ?? 0));
      const flare = flareBy > 0 ? [sign * flareBy, 0, 0] : null;
      // Elbows break backward, both of them.
      //
      // The bend used to be `sign`, i.e. mirrored per side - so one elbow bent
      // backward and the other forward, and neither was reliably anatomical.
      // Both arms bend the same way relative to the body, which is what stops
      // the joints looking inverted.
      const solved = clearArm(
        limb(
          // Negative: an elbow protrudes *behind* the line from shoulder to hand.
          // Positive put it in front, which is why arms appeared to bend the wrong
          // way at every pose.
          aimed.elevation, aimed.azimuth, aimed.extend, upperArm, foreArm, -1, flare,
        ),
        // Out of the trunk, and solved again to reach: see HAND_TORSO_CLEARANCE.
        [sign * shoulderHalf, 0, 0], hipsInChest, HAND_TORSO_CLEARANCE * s,
        upperArm, foreArm, flare,
      );
      const elbow = add(shoulder, rotY(solved.joint, chestYaw));
      let hand = add(shoulder, rotY(solved.end, chestYaw));
      // A little trail on the hands, varied per dancer so a cast in unison
      // does not move as one machine. It was a rate of 8, a time constant of
      // 125ms, which on its own took a beat-rate gesture down to 54%.
      hand = this.applyLag(dancer.lag.hands, side, hand, deltaSec, 40 * dancer.looseness);
      bones.push({ a: shoulder, b: elbow, w: limbPx });
      bones.push({ a: elbow, b: hand, w: limbPx * 0.95 });
    });

    const legSpan = thigh + shin;
    // Both legs are aimed before either is planted, because where one may go
    // depends on where the other stands. See MIN_LIMB_GAP.
    const legs = pose.legs.map((leg, side) => {
      const sign = side === 0 ? 1 : -1;
      const hip = add(root, rotY([sign * shoulderHalf * 0.62, 0, 0], yaw));
      // A leg's swing is written positive for forward, the opposite of an
      // arm's, because that is how every table was written.
      let freeAim = poseAim(leg.swing, leg.lift * sign, leg.knee);

      // Where the foot would go if it were merely pointed, which is what the
      // pose tables describe and what planting decisions are measured from.
      let freeSolved = limb(
        freeAim.elevation, freeAim.azimuth, freeAim.extend, thigh, shin, 1,
      );

      // Never through the floor, and a foot carrying weight stands on it:
      // bending a knee is how a dancer sinks, not a way of lifting a foot. A
      // loaded foot within reach of the floor is put there and the knee solves
      // for it; a foot that would pass below the floor stands on it too. Done
      // here, before planting, so a foot is only pinned where it can stand.
      const reached = add(hip, rotY(freeSolved.end, yaw));
      const standing = dancer.support[side] > 0.5 && reached[1] < FLOOR + 0.15 * s;
      if (reached[1] < FLOOR || standing) {
        freeAim = aimAt(rotY(sub([reached[0], FLOOR, reached[2]], hip), -yaw), legSpan);
        freeSolved = limb(freeAim.elevation, freeAim.azimuth, freeAim.extend, thigh, shin, 1);
      }
      return {
        side, hip, freeAim, freeSolved, freeFoot: add(hip, rotY(freeSolved.end, yaw)),
      };
    });
    this.separateLegs(dancer, legs, yaw, legSpan, thigh, shin, MIN_LIMB_GAP * s);

    legs.forEach(({ side, hip, freeAim, freeSolved, freeFoot }) => {
      const aim = this.updatePlant(
        dancer, side, hip, yaw, freeFoot, freeAim, freeSolved.end, legSpan, deltaSec,
      );

      // Knees break forward, both of them - the opposite of the elbows, which
      // is the single most recognisable fact about how a human bends.
      const solvedLeg = aim === freeAim ? freeSolved : limb(
        // Positive: a knee protrudes in front, the opposite of an elbow.
        aim.elevation, aim.azimuth, aim.extend, thigh, shin, 1,
      );
      const knee = add(hip, rotY(solvedLeg.joint, yaw));
      let foot = add(hip, rotY(solvedLeg.end, yaw));

      // Lag is suppressed in proportion to how planted the foot is: trailing a
      // foot that is bearing weight is exactly the sliding this removes.
      //
      // Suppression *raises* the rate, because `applyLag`'s rate is tightness -
      // higher follows the target more closely. Scaling it down instead, which
      // is the obvious reading of "less lag", drove the rate toward zero and
      // froze the foot at a stale position; combined with a threshold that
      // switched to direct assignment, it snapped between the two. That was the
      // whole of the residual skid - measured at 0.723 world units in one frame
      // against a median of 0.0003, six times over 30 seconds.
      //
      // Blended rather than branched so there is no threshold left to cross.
      foot = this.applyLag(
        dancer.lag.feet, side, foot, deltaSec,
        40 * dancer.looseness + dancer.plant[side].strength * 400,
      );

      bones.push({ a: hip, b: knee, w: limbPx * 1.16 });
      bones.push({ a: knee, b: foot, w: limbPx * 1.04 });
    });

    // Drawn twice: a wider light pass, then the black silhouette on top.
    //
    // The outline is what makes a pose readable. A solid black figure against a
    // saturated backdrop loses its internal edges entirely - an arm crossing the
    // torso simply disappears into it - so the silhouette shows the outer shape
    // and nothing of what the limbs are doing. A light rim restores those edges
    // without turning the figure into line art.
    context.lineCap = 'round';
    context.lineJoin = 'round';

    // Project once and reuse for both passes.
    const projected = [];
    for (const bone of bones) {
      const pa = this.project(bone.a, width, height);
      const pb = this.project(bone.b, width, height);
      if (!Number.isFinite(pa.x) || !Number.isFinite(pb.x)) continue;
      projected.push({ pa, pb, w: bone.w });
    }
    const pHead = this.project(head, width, height);

    // Thinner than before: a heavy rim swallowed the figure's shape and made
    // every pose look like the same rounded blob.
    const outlinePx = Math.max(1, limbPx * 0.15);

    for (const pass of ['outline', 'body']) {
      const isOutline = pass === 'outline';
      // A soft near-white rather than pure white, which would read as a glow.
      context.strokeStyle = isOutline ? 'rgba(255,255,255,0.85)' : '#000';
      context.fillStyle = isOutline ? 'rgba(255,255,255,0.85)' : '#000';

      for (const bone of projected) {
        context.lineWidth = bone.w + (isOutline ? outlinePx * 2 : 0);
        context.beginPath();
        context.moveTo(bone.pa.x, bone.pa.y);
        context.lineTo(bone.pb.x, bone.pb.y);
        context.stroke();
      }

      if (Number.isFinite(pHead.x)) {
        context.beginPath();
        context.arc(pHead.x, pHead.y, headPx + (isOutline ? outlinePx : 0), 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  /**
   * Keep the two legs out of each other.
   *
   * Works on the *free* aims, before planting, because `updatePlant` pins a foot
   * at its free target the moment it takes weight: a foot moved clear only after
   * that would plant back in the old spot and slide there, which is the skating
   * the planting exists to prevent. Each leg is judged as `updatePlant` will
   * draw it - a planted one blended towards its pin by how firmly it is planted
   * - and the lighter-loaded leg yields, in proportion. A free foot placed better
   * is a step; a planted one moved is a skid.
   *
   * Thighs and shins both, and the whole of each, because feet were only half
   * of it: knees knocking and one shin passing through the other made up 35% of
   * the crossings. Pushed horizontally, so a foot kicked up past the other is
   * judged by the real distance between them and left alone.
   *
   * @param {object} dancer
   * @param {{side: number, hip: number[], freeAim: object, freeSolved: object,
   *   freeFoot: number[]}[]} legs Mutated: a leg that yields is re-aimed.
   * @param {number} yaw
   * @param {number} span Leg length, hip to foot.
   * @param {number} thigh
   * @param {number} shin
   * @param {number} gap Smallest distance allowed between the two legs.
   */
  separateLegs(dancer, legs, yaw, span, thigh, shin, gap) {
    const drawn = (leg) => {
      const plant = dancer.plant[leg.side];
      const k = plant.point ? plant.strength : 0;
      let solved = leg.freeSolved;
      if (k > 0.002) {
        const pinned = rotY(sub(plant.point, leg.hip), -yaw);
        const free = leg.freeSolved.end;
        const aim = aimAt([
          free[0] + (pinned[0] - free[0]) * k,
          free[1] + (pinned[1] - free[1]) * k,
          free[2] + (pinned[2] - free[2]) * k,
        ], span);
        solved = limb(aim.elevation, aim.azimuth, aim.extend, thigh, shin, 1);
      }
      return {
        knee: add(leg.hip, rotY(solved.joint, yaw)),
        foot: add(leg.hip, rotY(solved.end, yaw)),
        load: k,
      };
    };

    for (let pass = 0; pass < 3; pass++) {
      const [a, b] = legs.map(drawn);
      const shins = segmentGap(a.knee, a.foot, b.knee, b.foot);
      const thighs = segmentGap(legs[0].hip, a.knee, legs[1].hip, b.knee);
      const worst = shins.distance <= thighs.distance ? shins : thighs;
      if (worst.distance >= gap) return;

      // Apart along the line between the closest points, flattened: legs stand
      // on a floor, and lifting one to clear the other is not a step anyone takes.
      let dx = worst.b[0] - worst.a[0];
      let dz = worst.b[2] - worst.a[2];
      const across = Math.hypot(dx, dz);
      if (across < 1e-6) {
        // Coincident: part them along the hips, each to its own side. Leg 0 is
        // the +x side of the body, so leg 1 lies towards -x.
        const lateral = rotY([1, 0, 0], yaw);
        dx = -lateral[0];
        dz = -lateral[2];
      } else {
        dx /= across;
        dz /= across;
      }
      const deficit = gap - worst.distance;
      const loads = a.load + b.load;
      // Each leg moves in proportion to the *other* one's load.
      const share = loads < 1e-6 ? [0.5, 0.5] : [b.load / loads, a.load / loads];
      for (const leg of legs) {
        const push = deficit * share[leg.side] * (leg.side === 0 ? -1 : 1);
        if (Math.abs(push) < 1e-9) continue;
        const target = [
          leg.freeFoot[0] + dx * push, leg.freeFoot[1], leg.freeFoot[2] + dz * push,
        ];
        const aim = aimAt(rotY(sub(target, leg.hip), -yaw), span);
        leg.freeAim = { elevation: aim.elevation, azimuth: aim.azimuth, extend: aim.extend };
        leg.freeSolved = limb(aim.elevation, aim.azimuth, aim.extend, thigh, shin, 1);
        leg.freeFoot = add(leg.hip, rotY(leg.freeSolved.end, yaw));
      }
    }
  }

  /**
   * Plant, hold or release one foot, returning the aim the leg should use.
   *
   * ## Why a figure needs this
   *
   * Poses describe joint *angles*, so a foot ended up wherever the hips sent it.
   * Move the body and both feet travel with it, which is skating - and it is why
   * the figures never read as standing on the floor however good the poses were.
   * A real dancer's loaded foot does not move; the body moves over it, and the
   * leg angles are a *consequence* of that rather than the cause.
   *
   * So while a foot carries weight it is pinned to a world point, and the leg is
   * solved backwards from hip to plant. That inverts the normal direction of the
   * rig for one limb at a time, which is what `aimAt` exists for.
   *
   * ## Why the blend is in offset space
   *
   * The first version blended elevation, azimuth and extension. That has a
   * singularity: azimuth is `atan2` of the horizontal offset, so when a foot
   * passes near-vertically below its hip the angle is undefined and swings by up
   * to PI between frames. Blended against a free aim that is *not* vertical, that
   * threw the foot sideways. Measured over 1,171 planted frames the median drift
   * was a clean 0.00054 world units, but 1.6% of frames spiked past 0.1 and the
   * worst reached 0.723 - a visible skid, once every second or so.
   *
   * Interpolating the two offset *vectors* has no such pole, and `aimAt` clamps
   * the result into solvable range, so the leg stays a valid two-bone chain
   * throughout. The foot simply travels in a straight line between where the
   * pose wants it and where it is planted.
   *
   * @param {number[]} freeOffset Where the pose alone would put the foot,
   *   relative to the hip, in body-local coordinates.
   * @returns {{elevation: number, azimuth: number, extend: number}} The aim to
   *   solve the leg with; the free aim itself when the foot is not planted.
   */
  updatePlant(dancer, side, hip, yaw, freeFoot, freeAim, freeOffset, span, deltaSec) {
    const plant = dancer.plant[side];
    const load = dancer.support[side];

    // `held` and `point` are separate on purpose.
    //
    // Releasing by clearing the point meant the leg snapped from its pinned pose
    // straight back to the free one in a single frame, and - because the load is
    // usually still high at that moment - re-planted immediately at wherever the
    // foot had jumped to. Measured over 900 frames, the planted foot moved
    // 0.661 world units in a frame against 0.021 for a free one: the pin was
    // making the skating thirty times worse than no pin at all.
    //
    // Keeping the point alive while the strength eases back down gives the blend
    // something to travel from, so a release is a step rather than a snap.
    // Only a foot on the floor can take weight. Without this a figure in the
    // air planted whichever foot the beat said was loaded, where it hung.
    const grounded = freeFoot[1] < FLOOR + 0.06 * dancer.build;
    if (!plant.held && load > 0.62 && grounded) {
      // Pinned where the foot actually is, *not* at floor level.
      //
      // A foot taking weight is usually on the floor, but not always - it can
      // be landing from a hop, or reaching for the floor with the hips risen -
      // and a pin it cannot reach releases on the frame it is made and pins
      // nothing. The hips once sat too high for any foot to reach the floor at
      // all, and snapping plants to it pinned nothing, ever. Holding the foot's
      // own position is reachable by construction, because the foot is
      // already there.
      plant.held = true;
      plant.point = [freeFoot[0], freeFoot[1], freeFoot[2]];
    }

    if (plant.held && plant.point) {
      const stretch = Math.hypot(
        plant.point[0] - hip[0], plant.point[1] - hip[1], plant.point[2] - hip[2],
      );
      // Released either because the weight has moved off this foot - the musical
      // reason, which is a step - or because the body has travelled far enough
      // that holding on would stretch the leg past what it can solve. The margin
      // is what stops a figure dragging a foot behind it across the stage.
      if (load < 0.38 || stretch > span * MAX_REACH * 1.12) plant.held = false;
    }

    // Hysteresis, not one threshold: a single cutoff sitting near the weight
    // curve's own value makes a foot plant and release repeatedly within a beat,
    // which reads as a stutter rather than a step.
    plant.strength = ease(plant.strength, plant.held ? 1 : 0, 14, deltaSec);
    if (!plant.point || plant.strength < 0.002) {
      plant.point = null;
      return freeAim;
    }

    // Hip to plant, expressed in the body's own frame so the solver sees the
    // same coordinates the pose tables are written in.
    const pinned = rotY(sub(plant.point, hip), -yaw);

    const k = plant.strength;
    return aimAt([
      freeOffset[0] + (pinned[0] - freeOffset[0]) * k,
      freeOffset[1] + (pinned[1] - freeOffset[1]) * k,
      freeOffset[2] + (pinned[2] - freeOffset[2]) * k,
    ], span);
  }

  /**
   * Smooth a limb tip toward its target, producing follow-through.
   *
   * @param {Array} store Per-side previous positions.
   * @param {number} side 0 or 1.
   * @param {[number, number, number]} target Ideal position this frame.
   * @param {number} deltaSec
   * @param {number} rate Higher follows more tightly.
   * @returns {[number, number, number]}
   */
  applyLag(store, side, target, deltaSec, rate) {
    const previous = store[side];
    if (!previous) {
      store[side] = target;
      return target;
    }
    // Exponential, not linear-in-dt: see the note on ease(). The previous form
    // made follow-through depend on frame rate, which is precisely what read as
    // jitter on limb tips.
    const next = easeVec(previous, target, rate, deltaSec);
    store[side] = next;
    return next;
  }

}
