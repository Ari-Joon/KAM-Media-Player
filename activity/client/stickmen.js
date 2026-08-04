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
 * Smallest angle a limb may sit from the torso, in radians.
 *
 * Roughly 26 degrees for arms and 15 for legs. Below that a limb visually merges
 * with the body and the figure stops reading as posed at all.
 */
const MIN_ARM_SPREAD = 34 * (Math.PI / 180);
const MIN_LEG_SPREAD = 15 * (Math.PI / 180);

/** Longest a limb may stay tucked against the body, in seconds. */
const MAX_TUCK_SEC = 3;

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
 * @returns {number} The adjusted target.
 */
function repel(target, visible, minimum, state, deltaSec) {
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
  const ramp = state.tuckSec < MAX_TUCK_SEC
    ? 0.06
    : 0.06 + 1.09 * Math.min(1, (state.tuckSec - MAX_TUCK_SEC) / 0.5);

  // Overshooting the threshold slightly means the limb settles clear of it
  // rather than oscillating across the boundary.
  const sign = target < 0 ? -1 : 1;
  return target + sign * deficit * ramp;
}

/**
 * Neutral stance, used as the origin for exaggerating movement.
 *
 * Amplification scales the distance from these values rather than from zero, so
 * a deliberately held pose stays where it was written and only the moving part
 * of a gesture is pushed further. Scaling absolute angles instead turned an arm
 * held at -128 degrees into -256, wrapping it around the body - which is why
 * limbs kept ending up behind the head.
 */
const REST = {
  armSwing: -18 * DEG,
  armLift: 14 * DEG,
  elbow: 28 * DEG,
  legSwing: 10 * DEG,
  legLift: 8 * DEG,
  knee: 14 * DEG,
};

/**
 * Joint limits, in radians.
 *
 * Amplification can push a pose that was already extreme past anything a body
 * could do - an arm written at -150 degrees to reach overhead became -235, which
 * wraps it round behind the back. Clamping keeps exaggeration expressive without
 * letting it become anatomically impossible.
 */
const LIMITS = {
  armSwing: [-170 * DEG, 45 * DEG],
  armLift: [-105 * DEG, 105 * DEG],
  // Capped well below a full fold. Past about 110 degrees the forearm is
  // travelling back toward the shoulder rather than doing anything visible, and
  // the figure reads as having its arms clamped to its sides.
  elbow: [5 * DEG, 112 * DEG],
  legSwing: [-75 * DEG, 95 * DEG],
  legLift: [-45 * DEG, 45 * DEG],
  knee: [0, 135 * DEG],
  spine: [-40 * DEG, 45 * DEG],
  head: [-45 * DEG, 45 * DEG],
  // In body heights. Negative is upward; a quarter of a body height is a
  // vigorous hop and anything beyond it stops reading as a person.
  bob: [-0.26, 0.16],
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
const ARM_FIELDS = ['swing', 'lift', 'elbow'];
const LEG_FIELDS = ['swing', 'lift', 'knee'];
const ARM_KEYS = [
  ['a0swing', 'a0lift', 'a0elbow'],
  ['a1swing', 'a1lift', 'a1elbow'],
];
const LEG_KEYS = [
  ['l0swing', 'l0lift', 'l0knee'],
  ['l1swing', 'l1lift', 'l1knee'],
];

/**
 * Ease every numeric field of a pose toward a target pose.
 *
 * Doing this to the *whole* pose rather than only to limb tips gives two things
 * at once: no value can ever step, and a change of move blends over about a
 * second instead of snapping. Nothing else in the renderer needs to know that
 * moves are being cross-faded.
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

  // The body carries more mass than the limbs, so it is stiffer and settles
  // sooner; hands and feet are looser and trail further.
  const drive = (owner, springKey, targetValue, stiffness, damping, field = springKey) => {
    const state = get(springKey, owner[field] ?? 0);
    spring(state, targetValue, stiffness * rate, damping, deltaSec);
    owner[field] = state.value;
  };

  // The old body rig was over-damped and too slow for a 120 BPM target. This
  // stronger rig lands weight shifts on-beat while limbs keep their looseness.
  drive(current, 'bob', target.bob, 90, 15);
  drive(current, 'sway', target.sway, 82, 14);
  drive(current, 'turn', target.turn, 72, 13);
  drive(current, 'spineBend', target.spineBend, 82, 14);
  drive(current, 'spineTwist', target.spineTwist, 72, 13);
  drive(current, 'travel', target.travel, 95, 17);
  drive(current.head, 'swing', target.head.swing, 78, 13);
  drive(current.head, 'lift', target.head.lift, 78, 13);

  // Indexed rather than for-of: this runs once per figure per frame, and
  // iterating with destructuring would put the allocations straight back.
  for (let side = 0; side < 2; side++) {
    // Arms are the loosest: low damping gives the whip and follow-through that
    // makes a gesture look thrown rather than placed.
    const arm = current.arms[side];
    const armTarget = target.arms[side];
    const armKeys = ARM_KEYS[side];
    for (let i = 0; i < ARM_FIELDS.length; i++) {
      const field = ARM_FIELDS[i];
      drive(arm, armKeys[i], armTarget[field], 16, 8.5, field);
    }

    const leg = current.legs[side];
    const legTarget = target.legs[side];
    const legKeys = LEG_KEYS[side];
    for (let i = 0; i < LEG_FIELDS.length; i++) {
      const field = LEG_FIELDS[i];
      drive(leg, legKeys[i], legTarget[field], 22, 11, field);
    }
  }
}

/** A pose with everything at rest, used to seed a dancer's smoothed state. */
function restPose() {
  return {
    bob: 0, sway: 0, turn: 0, spineBend: 0, spineTwist: 0, travel: 0,
    head: { swing: 0, lift: 0 },
    arms: [
      { swing: 0, lift: 0, elbow: 0 },
      { swing: 0, lift: 0, elbow: 0 },
    ],
    legs: [
      { swing: 0, lift: 0, knee: 0 },
      { swing: 0, lift: 0, knee: 0 },
    ],
  };
}

/**
 * Convert a legacy swing/lift/bend triple into aim coordinates.
 *
 * The pose tables were written against the old sequential-rotation model and
 * express intent perfectly well: swing is how far the limb has travelled from
 * hanging down, lift is how far out from the body, bend is how folded it is.
 * Only the *composition* was broken. Reading them as spherical coordinates keeps
 * every authored pose and fixes the coupling in one place, rather than rewriting
 * forty tables by hand and inevitably changing their character.
 *
 * @param {number} swing Radians from straight down, negative being forward-up.
 * @param {number} lift Radians away from the body.
 * @param {number} bendAngle Radians of joint fold.
 * @returns {{elevation: number, azimuth: number, extend: number}}
 */
function fromLegacy(swing, lift, bendAngle) {
  // Straight down is -PI/2 elevation; swing rotates up from there.
  const elevation = -Math.PI / 2 - swing;
  // Lift is amplified because it now genuinely reaches sideways at every
  // elevation, where before it was mostly cancelled out.
  const azimuth = lift * 1.5;
  // A larger fold means a shorter reach - but never a reach of nothing.
  //
  // The floor is the fix for arms tucking into the body. A bend of 135 degrees
  // mapped to an extension of zero, which places the hand back at the shoulder
  // and folds the whole arm flat against the torso. Real elbows stop well short
  // of that, and a dancer's almost never reach it. Holding a minimum of 0.42
  // keeps the forearm out where it can be seen at every pose.
  const extend = Math.max(0.42, Math.min(1, 1 - Math.abs(bendAngle) / (Math.PI * 0.9)));
  return { elevation, azimuth, extend };
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
 * @returns {{joint: number[], end: number[]}} Offsets from the parent joint.
 */
function limb(elevation, azimuth, extend, upper, lower, bend = 1) {
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
  const perpendicular = unit(cross(unit(side), direction));

  return {
    joint: [
      direction[0] * along + perpendicular[0] * out * bend,
      direction[1] * along + perpendicular[1] * out * bend,
      direction[2] * along + perpendicular[2] * out * bend,
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
 * Centring the input at 0.72 puts the drawn dip at phase 0.92, just before the
 * accent, and adds 0.0096 of hip travel - 27% on top of the existing beat
 * bounce, so it reads without taking the movement over.
 *
 * Retune both if the body spring's stiffness changes: they compensate for it,
 * they do not describe the music.
 */
const ANTICIPATION_CENTRE = 0.72;
const ANTICIPATION_WIDTH = 0.36;

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
 * Each returns joint angles on multiple axes. `swing` is forward/back, `lift` is
 * out to the side; both together give the diagonal movement that stiff
 * single-axis animation lacks.
 *
 * `bob` raises the hips, `sway` shifts them sideways, `turn` yaws the whole body
 * and `travel` moves it across the floor.
 */
const MOVES = {
  /** Two-step with hip sway and counter-rotating shoulders. */
  step(bar, beat, energy) {
    const shift = Math.sin(bar * Math.PI * 2);
    const drive = 0.5 + energy * 0.7;
    return {
      bob: -attack(beat) * 0.05 * drive,
      sway: shift * 0.10 * drive,
      turn: shift * 20 * DEG,
      spineBend: 5 * DEG,
      spineTwist: -shift * 16 * DEG,
      head: { swing: attack(beat) * 10 * DEG, lift: shift * 8 * DEG },
      travel: shift * 0.30 * drive,
      arms: [
        { swing: (-40 - shift * 45) * DEG * drive, lift: (18 + shift * 14) * DEG,
          elbow: (55 + shift * 25) * DEG },
        { swing: (-40 + shift * 45) * DEG * drive, lift: (18 - shift * 14) * DEG,
          elbow: (55 - shift * 25) * DEG },
      ],
      legs: [
        { swing: (18 + shift * 26) * DEG * drive, lift: 6 * DEG, knee: (24 - shift * 18) * DEG },
        { swing: (18 - shift * 26) * DEG * drive, lift: -6 * DEG, knee: (24 + shift * 18) * DEG },
      ],
    };
  },

  /** Arms overhead, jumping on every beat. */
  reach(bar, beat, energy, punch) {
    const hit = attack(beat);
    const drive = 0.6 + energy * 0.8;
    const wave = Math.sin(bar * Math.PI * 4);
    return {
      // Positive Y is upward. The former sign made jumps sink on the beat.
      bob: (hit * 0.16 + punch * 0.05) * drive,
      sway: wave * 0.04,
      turn: wave * 14 * DEG,
      spineBend: -12 * DEG - hit * 8 * DEG,
      spineTwist: wave * 12 * DEG,
      head: { swing: -hit * 16 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-150 - wave * 20) * DEG, lift: (30 + wave * 22) * DEG,
          elbow: (12 + hit * 26) * DEG },
        { swing: (-150 + wave * 20) * DEG, lift: (-30 + wave * 22) * DEG,
          elbow: (12 + hit * 26) * DEG },
      ],
      legs: [
        { swing: (10 + hit * 22) * DEG, lift: (10 + hit * 14) * DEG, knee: (28 + hit * 44) * DEG * drive },
        { swing: (10 + hit * 22) * DEG, lift: (-10 - hit * 14) * DEG, knee: (28 + hit * 44) * DEG * drive },
      ],
    };
  },

  /** Travelling run with a full opposed arm swing. */
  run(bar, beat, energy) {
    const cycle = Math.sin(bar * Math.PI * 4);
    const opposite = Math.cos(bar * Math.PI * 4);
    const drive = 0.6 + energy * 0.9;
    return {
      bob: -Math.abs(cycle) * 0.07 * drive,
      sway: cycle * 0.03,
      turn: 26 * DEG,
      spineBend: 16 * DEG,
      spineTwist: -opposite * 22 * DEG,
      head: { swing: 6 * DEG, lift: 0 },
      travel: 1.4 * drive,
      arms: [
        { swing: (-55 + opposite * 70) * DEG * drive, lift: 14 * DEG,
          elbow: (78 - opposite * 26) * DEG },
        { swing: (-55 - opposite * 70) * DEG * drive, lift: -14 * DEG,
          elbow: (78 + opposite * 26) * DEG },
      ],
      legs: [
        { swing: cycle * 52 * DEG * drive, lift: 4 * DEG, knee: (34 + cycle * 46) * DEG },
        { swing: -cycle * 52 * DEG * drive, lift: -4 * DEG, knee: (34 - cycle * 46) * DEG },
      ],
    };
  },

  /** Floss: both arms crossing to one side while the hips counter-swing. */
  floss(bar, beat, energy) {
    const swing = Math.sin(bar * Math.PI * 4);
    const drive = 0.6 + energy * 0.6;
    return {
      bob: -attack(beat) * 0.04,
      sway: -swing * 0.09 * drive,
      turn: -swing * 16 * DEG,
      spineBend: 6 * DEG,
      spineTwist: swing * 26 * DEG,
      head: { swing: swing * 10 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-30 + swing * 20) * DEG, lift: (65 + swing * 55) * DEG * drive,
          elbow: (70 - swing * 45) * DEG },
        { swing: (-30 + swing * 20) * DEG, lift: (-65 + swing * 55) * DEG * drive,
          elbow: (70 + swing * 45) * DEG },
      ],
      legs: [
        { swing: (12 + swing * 10) * DEG, lift: 8 * DEG, knee: 22 * DEG },
        { swing: (12 - swing * 10) * DEG, lift: -8 * DEG, knee: 22 * DEG },
      ],
    };
  },

  /** Robot: quantised phase, so joints snap between held positions. */
  robot(bar, beat, energy) {
    const step = Math.floor(bar * 8) / 8;
    const flip = Math.sin(step * Math.PI * 2);
    const alt = Math.cos(step * Math.PI * 4);
    const drive = 0.5 + energy * 0.5;
    return {
      bob: 0,
      sway: flip * 0.05,
      turn: flip * 30 * DEG,
      spineBend: 0,
      spineTwist: -flip * 18 * DEG,
      head: { swing: 0, lift: flip * 14 * DEG },
      travel: 0,
      arms: [
        { swing: (-90 + flip * 60) * DEG * drive, lift: (10 + alt * 40) * DEG, elbow: 90 * DEG },
        { swing: (-90 - flip * 60) * DEG * drive, lift: (-10 + alt * 40) * DEG, elbow: 90 * DEG },
      ],
      legs: [
        { swing: 8 * DEG, lift: 8 * DEG, knee: 10 * DEG },
        { swing: 8 * DEG, lift: -8 * DEG, knee: 10 * DEG },
      ],
    };
  },

  /** Spin: a full turn per bar with arms extended. */
  spin(bar, beat, energy) {
    const drive = 0.6 + energy * 0.6;
    return {
      bob: -attack(beat) * 0.05,
      sway: 0,
      turn: bar * 360 * DEG,
      spineBend: -6 * DEG,
      spineTwist: 0,
      head: { swing: 0, lift: 0 },
      travel: 0.35,
      arms: [
        { swing: -85 * DEG, lift: 80 * DEG * drive, elbow: 10 * DEG },
        { swing: -85 * DEG, lift: -80 * DEG * drive, elbow: 10 * DEG },
      ],
      legs: [
        { swing: 14 * DEG, lift: 12 * DEG, knee: (20 + attack(beat) * 26) * DEG },
        { swing: 6 * DEG, lift: -6 * DEG, knee: 16 * DEG },
      ],
    };
  },

  /** Wave travelling up the body, arms trailing behind it. */
  wave(bar, beat, energy) {
    const w = Math.sin(bar * Math.PI * 2);
    const late = Math.sin(bar * Math.PI * 2 - 1.1);
    const drive = 0.5 + energy * 0.7;
    return {
      bob: -swell(bar) * 0.05 * drive,
      sway: w * 0.07,
      turn: w * 24 * DEG,
      spineBend: late * 24 * DEG * drive,
      spineTwist: w * 20 * DEG,
      head: { swing: -late * 16 * DEG, lift: w * 10 * DEG },
      travel: w * 0.20,
      arms: [
        { swing: (-70 + late * 60) * DEG, lift: (40 + w * 30) * DEG, elbow: (60 + w * 30) * DEG },
        { swing: (-70 - late * 60) * DEG, lift: (-40 + w * 30) * DEG, elbow: (60 - w * 30) * DEG },
      ],
      legs: [
        { swing: (16 + w * 12) * DEG, lift: 8 * DEG, knee: (22 + swell(bar) * 22) * DEG },
        { swing: (16 - w * 12) * DEG, lift: -8 * DEG, knee: (22 + swell(bar) * 22) * DEG },
      ],
    };
  },

  /** Jump: crouch, launch, tuck, land. Reads clearly even in wide shot. */
  jump(bar, beat, energy) {
    // A four-stage cycle across the bar rather than a sine, so the crouch and
    // the landing are distinct beats instead of a continuous bounce.
    const t = bar;
    const crouch = Math.max(0, 1 - Math.abs(t - 0.10) * 8);
    const air = Math.max(0, Math.sin((t - 0.15) * Math.PI * 1.4));
    const drive = 0.6 + energy * 0.8;
    return {
      // Crouch lowers the hips; airborne motion raises them.
      bob: (-crouch * 0.22 + air * 0.55) * drive,
      sway: 0,
      turn: air * 30 * DEG,
      spineBend: crouch * 30 * DEG - air * 14 * DEG,
      spineTwist: 0,
      head: { swing: -air * 18 * DEG + crouch * 14 * DEG, lift: 0 },
      travel: air * 0.5,
      arms: [
        { swing: (-30 - air * 130 + crouch * 60) * DEG, lift: (20 + air * 25) * DEG,
          elbow: (40 - air * 30) * DEG },
        { swing: (-30 - air * 130 + crouch * 60) * DEG, lift: (-20 - air * 25) * DEG,
          elbow: (40 - air * 30) * DEG },
      ],
      legs: [
        { swing: (10 + air * 40) * DEG, lift: 10 * DEG,
          knee: (crouch * 75 + air * 70) * DEG * drive },
        { swing: (10 + air * 25) * DEG, lift: -10 * DEG,
          knee: (crouch * 75 + air * 50) * DEG * drive },
      ],
    };
  },

  /**
   * Sing: one arm up holding a mic, body leaning into the phrase.
   *
   * Reserved for lead performers, which is what makes a duet legible - one
   * figure sings while the others dance behind.
   */
  sing(bar, beat, energy, punch) {
    const phrase = Math.sin(bar * Math.PI * 2);
    const emphasis = attack(beat) * (0.5 + punch * 0.5);
    const drive = 0.5 + energy * 0.7;
    return {
      bob: -emphasis * 0.05 * drive,
      sway: phrase * 0.07,
      turn: phrase * 18 * DEG,
      spineBend: -10 * DEG - emphasis * 12 * DEG,
      spineTwist: phrase * 14 * DEG,
      head: { swing: -14 * DEG - emphasis * 16 * DEG, lift: phrase * 10 * DEG },
      travel: phrase * 0.12,
      arms: [
        // Mic hand held near the face and steady.
        { swing: -128 * DEG, lift: 26 * DEG, elbow: 92 * DEG },
        // Free hand gestures with the phrasing.
        { swing: (-40 - phrase * 70) * DEG * drive, lift: (-45 - phrase * 40) * DEG,
          elbow: (50 + phrase * 40) * DEG },
      ],
      legs: [
        { swing: (12 + phrase * 14) * DEG, lift: 9 * DEG, knee: (18 + emphasis * 20) * DEG },
        { swing: (12 - phrase * 14) * DEG, lift: -9 * DEG, knee: (18 + emphasis * 20) * DEG },
      ],
    };
  },

  /** Groove: loose hips and shoulders, everything moving at once. */
  groove(bar, beat, energy) {
    const hip = Math.sin(bar * Math.PI * 4);
    const shoulder = Math.sin(bar * Math.PI * 4 + 1.6);
    const drive = 0.55 + energy * 0.75;
    return {
      bob: -attack(beat) * 0.07 * drive,
      sway: hip * 0.13 * drive,
      turn: hip * 26 * DEG,
      spineBend: 8 * DEG + shoulder * 10 * DEG,
      spineTwist: -shoulder * 30 * DEG * drive,
      head: { swing: attack(beat) * 14 * DEG, lift: hip * 12 * DEG },
      travel: hip * 0.22,
      arms: [
        { swing: (-60 - shoulder * 60) * DEG * drive, lift: (35 + hip * 30) * DEG,
          elbow: (70 + shoulder * 35) * DEG },
        { swing: (-60 + shoulder * 60) * DEG * drive, lift: (-35 + hip * 30) * DEG,
          elbow: (70 - shoulder * 35) * DEG },
      ],
      legs: [
        { swing: (14 + hip * 30) * DEG * drive, lift: (10 + hip * 8) * DEG,
          knee: (30 - hip * 22) * DEG },
        { swing: (14 - hip * 30) * DEG * drive, lift: (-10 + hip * 8) * DEG,
          knee: (30 + hip * 22) * DEG },
      ],
    };
  },

  /** March: knees high, arms driving, very readable at distance. */
  march(bar, beat, energy) {
    const cycle = Math.sin(bar * Math.PI * 4);
    const drive = 0.6 + energy * 0.7;
    return {
      bob: -Math.abs(cycle) * 0.05 * drive,
      sway: cycle * 0.05,
      turn: 12 * DEG,
      spineBend: 4 * DEG,
      spineTwist: -cycle * 18 * DEG,
      head: { swing: 0, lift: 0 },
      travel: 0.5 * drive,
      arms: [
        { swing: (-55 + cycle * 75) * DEG * drive, lift: 16 * DEG, elbow: 88 * DEG },
        { swing: (-55 - cycle * 75) * DEG * drive, lift: -16 * DEG, elbow: 88 * DEG },
      ],
      legs: [
        { swing: Math.max(0, cycle) * 70 * DEG * drive, lift: 6 * DEG,
          knee: Math.max(0, cycle) * 85 * DEG },
        { swing: Math.max(0, -cycle) * 70 * DEG * drive, lift: -6 * DEG,
          knee: Math.max(0, -cycle) * 85 * DEG },
      ],
    };
  },

  /**
   * Clap: hands meeting on the beat, held apart between.
   *
   * A held position between hits is what makes a movement read as deliberate.
   * Motions that ease continuously from one extreme to the other look like
   * drifting; pausing at the extremes looks like intent.
   */
  clap(bar, beat, energy) {
    // Snap closed on the beat and open slowly, rather than a symmetric sine.
    const closed = Math.pow(Math.max(0, 1 - beat * 2.2), 1.6);
    const drive = 0.6 + energy * 0.6;
    return {
      bob: -closed * 0.05 * drive,
      sway: 0,
      turn: 0,
      spineBend: -6 * DEG - closed * 10 * DEG,
      spineTwist: 0,
      head: { swing: -closed * 12 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: -95 * DEG, lift: (48 - closed * 44) * DEG * drive, elbow: 82 * DEG },
        { swing: -95 * DEG, lift: (-48 + closed * 44) * DEG * drive, elbow: 82 * DEG },
      ],
      legs: [
        { swing: (10 + closed * 8) * DEG, lift: 8 * DEG, knee: (16 + closed * 20) * DEG },
        { swing: (10 + closed * 8) * DEG, lift: -8 * DEG, knee: (16 + closed * 20) * DEG },
      ],
    };
  },

  /** Point: one arm thrown out and held, the other tucked. */
  point(bar, beat, energy) {
    // The arm holds for three quarters of the bar, then resets. Holding is the
    // whole gesture; a pointing arm that keeps moving is just waving.
    const held = bar < 0.75 ? 1 : 1 - (bar - 0.75) * 4;
    const side = Math.floor(bar * 2) % 2 === 0 ? 1 : -1;
    const drive = 0.6 + energy * 0.5;
    return {
      bob: -attack(beat) * 0.04,
      sway: side * held * 0.06,
      turn: side * held * 26 * DEG,
      spineBend: -8 * DEG,
      spineTwist: side * held * 22 * DEG,
      head: { swing: -10 * DEG, lift: side * held * 12 * DEG },
      travel: 0,
      arms: [
        { swing: (-70 - held * 45) * DEG * drive, lift: side > 0 ? held * 70 * DEG : 20 * DEG,
          elbow: (14 + (1 - held) * 50) * DEG },
        { swing: -50 * DEG, lift: -30 * DEG, elbow: 96 * DEG },
      ],
      legs: [
        { swing: (14 + held * 10) * DEG, lift: 10 * DEG, knee: 20 * DEG },
        { swing: (14 - held * 6) * DEG, lift: -10 * DEG, knee: 24 * DEG },
      ],
    };
  },

  /** Headbang: sharp nod on the beat, whole spine following. */
  headbang(bar, beat, energy) {
    const snap = Math.pow(Math.max(0, 1 - beat * 1.8), 1.4);
    const drive = 0.6 + energy * 0.8;
    return {
      bob: -snap * 0.06 * drive,
      sway: 0,
      turn: 0,
      spineBend: (10 + snap * 46) * DEG * drive,
      spineTwist: 0,
      head: { swing: (14 + snap * 60) * DEG * drive, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-30 - snap * 40) * DEG, lift: (55 + snap * 20) * DEG, elbow: 100 * DEG },
        { swing: (-30 - snap * 40) * DEG, lift: (-55 - snap * 20) * DEG, elbow: 100 * DEG },
      ],
      legs: [
        { swing: (16 + snap * 12) * DEG, lift: 12 * DEG, knee: (26 + snap * 24) * DEG },
        { swing: (16 + snap * 12) * DEG, lift: -12 * DEG, knee: (26 + snap * 24) * DEG },
      ],
    };
  },

  /** Shimmy: fast shoulder shake over still hips. */
  shimmy(bar, beat, energy) {
    // Deliberately much faster than the bar: the contrast between quick
    // shoulders and a steady base is what makes it read as a shimmy.
    const shake = Math.sin(bar * Math.PI * 16);
    const drive = 0.5 + energy * 0.7;
    return {
      bob: 0,
      sway: Math.sin(bar * Math.PI * 2) * 0.05,
      turn: shake * 10 * DEG,
      spineBend: 4 * DEG,
      spineTwist: shake * 26 * DEG * drive,
      head: { swing: 0, lift: -shake * 8 * DEG },
      travel: 0,
      arms: [
        { swing: (-58 + shake * 26) * DEG, lift: (52 + shake * 18) * DEG * drive, elbow: 88 * DEG },
        { swing: (-58 - shake * 26) * DEG, lift: (-52 + shake * 18) * DEG * drive, elbow: 88 * DEG },
      ],
      legs: [
        { swing: 12 * DEG, lift: 11 * DEG, knee: 22 * DEG },
        { swing: 12 * DEG, lift: -11 * DEG, knee: 22 * DEG },
      ],
    };
  },

  /** Kick: a held stance, then one leg thrown out on the beat. */
  kick(bar, beat, energy) {
    const phase = bar * 2 % 1;
    const swingOut = Math.pow(Math.max(0, 1 - Math.abs(phase - 0.25) * 5), 1.3);
    const side = bar < 0.5 ? 0 : 1;
    const drive = 0.6 + energy * 0.7;
    return {
      bob: -swingOut * 0.05,
      sway: (side === 0 ? -1 : 1) * 0.07,
      turn: (side === 0 ? -1 : 1) * 18 * DEG,
      spineBend: -swingOut * 18 * DEG,
      spineTwist: (side === 0 ? 1 : -1) * swingOut * 20 * DEG,
      head: { swing: -8 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: (-60 - swingOut * 50) * DEG, lift: 40 * DEG, elbow: 70 * DEG },
        { swing: (-60 + swingOut * 30) * DEG, lift: -40 * DEG, elbow: 70 * DEG },
      ],
      legs: [
        { swing: (side === 0 ? swingOut * 75 : 12) * DEG * drive, lift: 10 * DEG,
          knee: (side === 0 ? 10 : 22) * DEG },
        { swing: (side === 1 ? swingOut * 75 : 12) * DEG * drive, lift: -10 * DEG,
          knee: (side === 1 ? 10 : 22) * DEG },
      ],
    };
  },

  /** Slide: gliding sideways with the body angled into the travel. */
  slide(bar, beat, energy) {
    const direction = Math.sin(bar * Math.PI * 2);
    const drive = 0.6 + energy * 0.6;
    return {
      bob: -Math.abs(direction) * 0.03,
      sway: direction * 0.12 * drive,
      turn: direction * 40 * DEG,
      spineBend: 10 * DEG,
      spineTwist: -direction * 24 * DEG,
      head: { swing: -6 * DEG, lift: direction * 14 * DEG },
      travel: direction * 1.1 * drive,
      arms: [
        { swing: (-80 - direction * 40) * DEG, lift: (60 + direction * 25) * DEG, elbow: 40 * DEG },
        { swing: (-80 + direction * 40) * DEG, lift: (-60 + direction * 25) * DEG, elbow: 40 * DEG },
      ],
      legs: [
        { swing: (20 + direction * 28) * DEG * drive, lift: (14 + direction * 10) * DEG,
          knee: (26 - direction * 14) * DEG },
        { swing: (20 - direction * 28) * DEG * drive, lift: (-14 + direction * 10) * DEG,
          knee: (26 + direction * 14) * DEG },
      ],
    };
  },

  /** Low sway for quiet passages. */
  // --- Named dances --------------------------------------------------------
  //
  // Everything above this point is a *character* of movement - a march, a
  // groove, a reach. What follows are actual named dances, because a figure
  // doing something an audience can name reads completely differently from one
  // doing generic energetic motion. Recognition is the whole effect.
  //
  // Each is written to its own defining mechanic rather than to a general
  // impression: the Twist is counter-rotation between hips and shoulders, the
  // Charleston is heels kicking back on the offbeat, the Running Man is a foot
  // sliding back under a lifted knee. Get the mechanic and the dance reads even
  // on a stick figure; get only the energy and none of them do.

  /** Moonwalk: gliding backwards while appearing to walk forwards. */
  moonwalk(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.5;
    // One leg stays straight with the heel up while the other slides back flat.
    // The illusion is entirely in the contrast between the two.
    const slide = Math.sin(bar * Math.PI * 4);
    return {
      bob: -Math.abs(slide) * 0.030,
      sway: s * 0.06,
      turn: -18 * DEG,
      spineBend: 6 * DEG,
      spineTwist: s * 10 * DEG,
      head: { swing: 6 * DEG, lift: s * 6 * DEG },
      // Negative: the whole point is travelling the opposite way to the walk.
      travel: -0.34 * drive,
      arms: [
        { swing: (-26 - s * 20) * DEG, lift: 20 * DEG, elbow: (40 + s * 10) * DEG },
        { swing: (-26 + s * 20) * DEG, lift: 20 * DEG, elbow: (40 - s * 10) * DEG },
      ],
      legs: [
        { swing: (10 + slide * 30) * DEG * drive, lift: 3 * DEG,
          knee: (10 + Math.max(0, slide) * 30) * DEG },
        { swing: (10 - slide * 30) * DEG * drive, lift: -3 * DEG,
          knee: (10 + Math.max(0, -slide) * 30) * DEG },
      ],
    };
  },

  /** The Twist: hips and shoulders counter-rotating, heels grinding. */
  twist(bar, beat, energy) {
    // Twice a bar, because the Twist is a fast alternation rather than a sway.
    const s = Math.sin(bar * Math.PI * 4);
    const drive = 0.75 + energy * 0.6;
    return {
      bob: -Math.abs(s) * 0.045 * drive,
      sway: s * 0.05,
      // The defining feature: the shoulders go one way as the hips go the other.
      turn: s * 26 * DEG * drive,
      spineBend: 8 * DEG,
      spineTwist: -s * 34 * DEG * drive,
      head: { swing: 8 * DEG, lift: -s * 8 * DEG },
      travel: 0,
      // Elbows stay bent and low, hands tracking the hips like towelling off.
      arms: [
        { swing: (-52 - s * 26) * DEG * drive, lift: (30 + s * 10) * DEG, elbow: 78 * DEG },
        { swing: (-52 + s * 26) * DEG * drive, lift: (30 - s * 10) * DEG, elbow: 78 * DEG },
      ],
      legs: [
        { swing: 12 * DEG, lift: (10 + s * 6) * DEG, knee: (26 + s * 10) * DEG },
        { swing: 12 * DEG, lift: (-10 + s * 6) * DEG, knee: (26 - s * 10) * DEG },
      ],
    };
  },

  /** Charleston: heels kicking back, arms swinging opposite the legs. */
  charleston(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const kick = Math.sin(bar * Math.PI * 4);
    const drive = 0.8 + energy * 0.7;
    return {
      bob: attack(beat) * 0.05 * drive,
      sway: s * 0.07,
      turn: s * 16 * DEG,
      spineBend: -6 * DEG,
      spineTwist: -s * 18 * DEG,
      head: { swing: -8 * DEG, lift: s * 10 * DEG },
      travel: s * 0.10,
      // Arms swing opposite the legs, elbows loose and high - the twenties look.
      arms: [
        { swing: (-58 + s * 62) * DEG * drive, lift: (26 + s * 14) * DEG, elbow: 64 * DEG },
        { swing: (-58 - s * 62) * DEG * drive, lift: (26 - s * 14) * DEG, elbow: 64 * DEG },
      ],
      // Heels flick backwards rather than the knees lifting forwards, which is
      // what separates a Charleston from a march.
      legs: [
        { swing: (14 - Math.max(0, kick) * 46) * DEG * drive, lift: 12 * DEG,
          knee: (20 + Math.max(0, kick) * 70) * DEG },
        { swing: (14 - Math.max(0, -kick) * 46) * DEG * drive, lift: -12 * DEG,
          knee: (20 + Math.max(0, -kick) * 70) * DEG },
      ],
    };
  },

  /** Running Man: knee lifts as the opposite foot slides back. */
  runningman(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 4);
    const drive = 0.85 + energy * 0.8;
    return {
      bob: -Math.abs(s) * 0.05 * drive,
      sway: s * 0.05,
      turn: s * 10 * DEG,
      spineBend: 10 * DEG,
      spineTwist: -s * 14 * DEG,
      head: { swing: 10 * DEG, lift: 0 },
      travel: 0,
      // Arms pump as if running, opposite to the legs.
      arms: [
        { swing: (-70 + s * 44) * DEG * drive, lift: 16 * DEG, elbow: 88 * DEG },
        { swing: (-70 - s * 44) * DEG * drive, lift: 16 * DEG, elbow: 88 * DEG },
      ],
      // One knee drives up while the other leg extends back - the two never
      // meet in the middle, which is what sells the illusion of running in place.
      legs: [
        { swing: (-34 * Math.max(0, s) + 40 * Math.max(0, -s)) * DEG * drive,
          lift: 5 * DEG, knee: (26 + Math.max(0, s) * 66) * DEG },
        { swing: (-34 * Math.max(0, -s) + 40 * Math.max(0, s)) * DEG * drive,
          lift: -5 * DEG, knee: (26 + Math.max(0, -s) * 66) * DEG },
      ],
    };
  },

  /** The Dougie: a lean and shoulder roll with a hand brushing the head. */
  dougie(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.55;
    return {
      bob: -Math.abs(s) * 0.030,
      sway: s * 0.16 * drive,
      turn: s * 22 * DEG,
      spineBend: 4 * DEG,
      // The lean is the move. Shoulders roll across the body rather than the
      // arms doing anything energetic.
      spineTwist: s * 30 * DEG * drive,
      head: { swing: 4 * DEG, lift: s * 16 * DEG },
      travel: 0,
      arms: [
        // One hand up brushing past the head, the other loose at the hip.
        { swing: (-126 + s * 16) * DEG, lift: 46 * DEG, elbow: 96 * DEG },
        { swing: (-24 - s * 18) * DEG, lift: 22 * DEG, elbow: 52 * DEG },
      ],
      legs: [
        { swing: (10 + s * 8) * DEG, lift: 9 * DEG, knee: (18 + Math.max(0, -s) * 16) * DEG },
        { swing: (10 - s * 8) * DEG, lift: -9 * DEG, knee: (18 + Math.max(0, s) * 16) * DEG },
      ],
    };
  },

  /** Gangnam Style: crossed lasso arms over a bouncing horse-riding step. */
  gangnam(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 4);
    const drive = 0.9 + energy * 0.8;
    return {
      // The bounce is constant and vertical - the horse-riding half of it.
      bob: (attack(beat) * 0.10 - 0.02) * drive,
      sway: s * 0.05,
      turn: s * 12 * DEG,
      spineBend: -4 * DEG,
      spineTwist: s * 12 * DEG,
      head: { swing: -10 * DEG, lift: s * 6 * DEG },
      travel: s * 0.12,
      arms: [
        // One arm crosses low in front, the other swings the lasso overhead.
        { swing: -150 * DEG, lift: (24 + s * 26) * DEG, elbow: 42 * DEG },
        { swing: -44 * DEG, lift: -20 * DEG, elbow: 92 * DEG },
      ],
      legs: [
        { swing: (16 + s * 14) * DEG * drive, lift: 8 * DEG, knee: (30 + s * 16) * DEG },
        { swing: (16 - s * 14) * DEG * drive, lift: -8 * DEG, knee: (30 - s * 16) * DEG },
      ],
    };
  },

  /** Macarena: the four-count arm sequence, hips rolling underneath. */
  macarena(bar, beat, energy) {
    // Four distinct positions across the bar rather than a continuous curve -
    // the Macarena is a sequence, and a smooth blend would erase it.
    const stage = Math.floor(bar * 4) % 4;
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.75 + energy * 0.5;
    // Arms out, then crossed to the shoulders, then to the head, then the hips.
    const swings = [-92, -108, -140, -60];
    const lifts = [54, 18, 30, 26];
    const elbows = [16, 96, 104, 74];
    return {
      bob: -Math.abs(s) * 0.024,
      sway: s * 0.14 * drive,
      turn: s * 12 * DEG,
      spineBend: 4 * DEG,
      spineTwist: -s * 14 * DEG,
      head: { swing: 4 * DEG, lift: s * 8 * DEG },
      travel: 0,
      arms: [
        { swing: swings[stage] * DEG, lift: lifts[stage] * DEG, elbow: elbows[stage] * DEG },
        { swing: swings[(stage + 3) % 4] * DEG, lift: lifts[(stage + 3) % 4] * DEG,
          elbow: elbows[(stage + 3) % 4] * DEG },
      ],
      legs: [
        { swing: (10 + s * 6) * DEG, lift: 8 * DEG, knee: (16 + Math.max(0, -s) * 14) * DEG },
        { swing: (10 - s * 6) * DEG, lift: -8 * DEG, knee: (16 + Math.max(0, s) * 14) * DEG },
      ],
    };
  },

  /** Vogue: sharp geometric arm frames snapping around the head. */
  vogue(bar, beat, energy) {
    // Held positions with hard changes between them, because voguing is posing.
    const stage = Math.floor(bar * 4) % 4;
    const drive = 0.8 + energy * 0.5;
    const swings = [-158, -96, -150, -70];
    const lifts = [40, 76, -10, 60];
    return {
      bob: -attack(beat) * 0.035 * drive,
      sway: (stage % 2 === 0 ? 0.10 : -0.10) * drive,
      turn: (stage < 2 ? 24 : -24) * DEG,
      spineBend: (stage === 1 ? -14 : 6) * DEG,
      spineTwist: (stage < 2 ? -20 : 20) * DEG,
      head: { swing: 12 * DEG, lift: (stage < 2 ? 18 : -18) * DEG },
      travel: 0,
      // The frame: both arms held at hard angles around the face.
      arms: [
        { swing: swings[stage] * DEG, lift: lifts[stage] * DEG, elbow: 100 * DEG },
        { swing: swings[(stage + 2) % 4] * DEG, lift: lifts[(stage + 2) % 4] * DEG,
          elbow: 100 * DEG },
      ],
      legs: [
        { swing: 14 * DEG, lift: 14 * DEG, knee: 18 * DEG },
        { swing: 8 * DEG, lift: -14 * DEG, knee: 30 * DEG },
      ],
    };
  },

  /** Cabbage Patch: fists circling together in front of the chest. */
  cabbagepatch(bar, beat, energy) {
    const around = bar * Math.PI * 2;
    const drive = 0.75 + energy * 0.6;
    return {
      bob: -Math.abs(Math.sin(around)) * 0.03,
      sway: Math.cos(around) * 0.10 * drive,
      turn: Math.cos(around) * 18 * DEG,
      spineBend: 8 * DEG,
      spineTwist: -Math.cos(around) * 20 * DEG,
      head: { swing: 6 * DEG, lift: Math.sin(around) * 8 * DEG },
      travel: 0,
      // Both hands travel the same circle together, elbows fixed and wide.
      arms: [
        { swing: (-84 + Math.sin(around) * 30) * DEG * drive,
          lift: (34 + Math.cos(around) * 16) * DEG, elbow: 92 * DEG },
        { swing: (-84 + Math.sin(around) * 30) * DEG * drive,
          lift: (34 - Math.cos(around) * 16) * DEG, elbow: 92 * DEG },
      ],
      legs: [
        { swing: (12 + Math.cos(around) * 8) * DEG, lift: 8 * DEG, knee: 22 * DEG },
        { swing: (12 - Math.cos(around) * 8) * DEG, lift: -8 * DEG, knee: 22 * DEG },
      ],
    };
  },

  /** The Sprinkler: one arm sweeping round, the other cocked behind the head. */
  sprinkler(bar, beat, energy) {
    // Sweeps out slowly and snaps back, exactly like the garden sprinkler it is
    // named after. The asymmetry between the two is the joke and the mechanic.
    const p = bar % 1;
    const sweep = p < 0.75 ? p / 0.75 : 1 - (p - 0.75) / 0.25;
    const drive = 0.8 + energy * 0.6;
    return {
      bob: -Math.abs(Math.sin(bar * Math.PI * 2)) * 0.028,
      sway: (sweep - 0.5) * 0.14 * drive,
      turn: (sweep - 0.5) * 54 * DEG * drive,
      spineBend: 6 * DEG,
      spineTwist: (0.5 - sweep) * 26 * DEG,
      head: { swing: 6 * DEG, lift: (sweep - 0.5) * 20 * DEG },
      travel: 0,
      arms: [
        // The straight sweeping arm.
        //
        // The sweep stops well short of the joint's limit on purpose. Lift is
        // amplified harder than any other angle - `reach * 1.25` - so a pose
        // authored near the 105 degree stop arrives past it and pins there, and
        // a pinned arm stops sweeping altogether, which is the entire move. 52
        // degrees of authored travel is about 85 once amplified.
        { swing: -94 * DEG, lift: (8 + sweep * 52) * DEG * drive, elbow: 22 * DEG },
        // The cocked one, held behind the head throughout.
        //
        // Kept to -108 rather than the -142 it was first written at, for a
        // reason worth knowing before authoring any new move: `from()` scales a
        // pose's distance from rest by `reach`, which runs to about 1.7, so an
        // arm swing authored past roughly -105 degrees lands beyond -190 and
        // `softClamp` asymptotes it to within a degree of the -170 stop. The
        // joint is not technically pinned - it still responds - but it has
        // nowhere left to travel, which looks identical on screen.
        { swing: -108 * DEG, lift: 34 * DEG, elbow: 92 * DEG },
      ],
      legs: [
        { swing: 12 * DEG, lift: 10 * DEG, knee: 20 * DEG },
        { swing: 12 * DEG, lift: -10 * DEG, knee: 24 * DEG },
      ],
    };
  },

  /** Disco point: alternating diagonal stabs, hip to opposite corner. */
  discopoint(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const hit = attack(beat);
    const drive = 0.85 + energy * 0.8;
    return {
      bob: -hit * 0.05 * drive,
      sway: -s * 0.13 * drive,
      turn: -s * 24 * DEG,
      spineBend: -8 * DEG,
      spineTwist: s * 26 * DEG * drive,
      head: { swing: -hit * 14 * DEG, lift: s * 14 * DEG },
      travel: 0,
      arms: [
        // One arm stabs high across the body while the other drops to the hip,
        // and they trade every bar.
        { swing: (-150 + Math.max(0, -s) * 120) * DEG * drive,
          lift: (44 + s * 20) * DEG, elbow: (14 + Math.max(0, -s) * 60) * DEG },
        { swing: (-150 + Math.max(0, s) * 120) * DEG * drive,
          lift: (44 - s * 20) * DEG, elbow: (14 + Math.max(0, s) * 60) * DEG },
      ],
      legs: [
        { swing: (14 + s * 12) * DEG * drive, lift: 12 * DEG, knee: (22 - s * 8) * DEG },
        { swing: (14 - s * 12) * DEG * drive, lift: -12 * DEG, knee: (22 + s * 8) * DEG },
      ],
    };
  },

  /** Two-step: side, together, side - the club default. */
  twostep(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.6;
    return {
      bob: -attack(beat) * 0.035 * drive,
      sway: s * 0.15 * drive,
      turn: s * 14 * DEG,
      spineBend: 5 * DEG,
      spineTwist: -s * 16 * DEG,
      head: { swing: 5 * DEG, lift: s * 10 * DEG },
      travel: s * 0.16 * drive,
      arms: [
        { swing: (-46 - s * 22) * DEG * drive, lift: (24 + s * 10) * DEG, elbow: 70 * DEG },
        { swing: (-46 + s * 22) * DEG * drive, lift: (24 - s * 10) * DEG, elbow: 70 * DEG },
      ],
      // The trailing foot closes to the leading one rather than passing it.
      legs: [
        { swing: (12 + Math.max(0, s) * 22) * DEG * drive, lift: (10 + s * 8) * DEG,
          knee: (18 + Math.max(0, -s) * 12) * DEG },
        { swing: (12 + Math.max(0, -s) * 22) * DEG * drive, lift: (-10 + s * 8) * DEG,
          knee: (18 + Math.max(0, s) * 12) * DEG },
      ],
    };
  },

  /** Melbourne shuffle: fast heel-toe running steps, arms low and tight. */
  shuffle(bar, beat, energy) {
    // Twice the rate of an ordinary step: the shuffle is defined by being faster
    // than the music appears to demand.
    const s = Math.sin(bar * Math.PI * 8);
    const drive = 0.9 + energy * 0.9;
    return {
      bob: -Math.abs(s) * 0.035 * drive,
      sway: s * 0.04,
      turn: s * 8 * DEG,
      spineBend: 10 * DEG,
      spineTwist: -s * 10 * DEG,
      head: { swing: 8 * DEG, lift: 0 },
      travel: Math.sin(bar * Math.PI * 2) * 0.20 * drive,
      // Arms stay low and close - all the work is below the waist.
      arms: [
        { swing: (-30 - s * 16) * DEG, lift: 20 * DEG, elbow: 62 * DEG },
        { swing: (-30 + s * 16) * DEG, lift: 20 * DEG, elbow: 62 * DEG },
      ],
      legs: [
        { swing: (6 + s * 40) * DEG * drive, lift: 6 * DEG, knee: (14 + Math.max(0, s) * 40) * DEG },
        { swing: (6 - s * 40) * DEG * drive, lift: -6 * DEG, knee: (14 + Math.max(0, -s) * 40) * DEG },
      ],
    };
  },

  /** Y.M.C.A.: the four letters, one per beat. */
  ymca(bar, beat, energy) {
    const letter = Math.floor(bar * 4) % 4;
    const drive = 0.85 + energy * 0.6;
    // Y: both arms up and out. M: elbows down, hands to shoulders. C: both arms
    // swung to one side. A: arms up and together over the head.
    //
    // Every swing here stays inside about -105 degrees, and the elbows clear of
    // both stops. See the note in `sprinkler`: `from()` multiplies a pose's
    // distance from rest by up to 1.7, so anything authored nearer the limits
    // arrives with no travel left and the letters stop being distinguishable
    // from one another - which for this move is the entire point of it.
    const left = [
      { swing: -102, lift: 58, elbow: 22 },
      { swing: -92, lift: 28, elbow: 92 },
      { swing: -100, lift: 68, elbow: 44 },
      { swing: -104, lift: 14, elbow: 24 },
    ][letter];
    const right = [
      { swing: -102, lift: 58, elbow: 22 },
      { swing: -92, lift: 28, elbow: 92 },
      { swing: -74, lift: -30, elbow: 74 },
      { swing: -104, lift: 14, elbow: 24 },
    ][letter];
    return {
      bob: attack(beat) * 0.06 * drive,
      sway: (letter === 2 ? 0.12 : 0) * drive,
      turn: (letter === 2 ? 20 : 0) * DEG,
      spineBend: -10 * DEG,
      spineTwist: (letter === 2 ? -16 : 0) * DEG,
      head: { swing: -12 * DEG, lift: 0 },
      travel: 0,
      arms: [
        { swing: left.swing * DEG, lift: left.lift * DEG, elbow: left.elbow * DEG },
        { swing: right.swing * DEG, lift: right.lift * DEG, elbow: right.elbow * DEG },
      ],
      legs: [
        { swing: 14 * DEG, lift: 12 * DEG, knee: 18 * DEG },
        { swing: 14 * DEG, lift: -12 * DEG, knee: 18 * DEG },
      ],
    };
  },

  /** Salsa basic: a forward-back rock step with the hips leading. */
  salsa(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const quick = Math.sin(bar * Math.PI * 4);
    const drive = 0.75 + energy * 0.6;
    return {
      bob: -Math.abs(quick) * 0.030 * drive,
      // Cuban motion: the hips do most of the work, well ahead of the feet.
      sway: s * 0.18 * drive,
      turn: s * 20 * DEG,
      spineBend: 4 * DEG,
      spineTwist: -s * 24 * DEG * drive,
      head: { swing: 4 * DEG, lift: s * 12 * DEG },
      travel: 0,
      // Frame held: elbows out, forearms forward, as if holding a partner.
      arms: [
        { swing: -80 * DEG, lift: (46 + s * 8) * DEG, elbow: 88 * DEG },
        { swing: -80 * DEG, lift: (46 - s * 8) * DEG, elbow: 88 * DEG },
      ],
      legs: [
        { swing: (12 + quick * 30) * DEG * drive, lift: 9 * DEG,
          knee: (18 + Math.max(0, -quick) * 20) * DEG },
        { swing: (12 - quick * 30) * DEG * drive, lift: -9 * DEG,
          knee: (18 + Math.max(0, quick) * 20) * DEG },
      ],
    };
  },
  /**
   * Gentle weight shift, for passages that are quiet but still playing.
   *
   * The move the theme tables had been naming for some time without anyone
   * having authored it - `THEME_ROUTINES` listed `sway` for romance and
   * melancholy, `MOVES` did not have it, and the lookup threw.
   *
   * It exists because the only alternative for a quiet section was `idle`, which
   * is small enough that figures read as having stopped altogether. Measured
   * across the 46 cached scores, 28 of 431 sections fall below the old cutoff,
   * and only 9 of those are near-silent enough for stillness to be right; the
   * other 19 are quiet passages that simply froze.
   *
   * Everything is driven from the hips, because that is what a sway is: a weight
   * transfer the rest of the body follows. The arms hang and drift rather than
   * gesturing, and the knees soften alternately to take the load - the near leg
   * straightens as the hips ride over it while the far one bends.
   */
  sway(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    const drive = 0.7 + energy * 0.5;
    return {
      bob: -swell(beat) * 0.018 - Math.abs(s) * 0.012,
      sway: s * 0.16 * drive,
      turn: s * 10 * DEG,
      spineBend: 3 * DEG,
      // Shoulders counter the hips, which is what keeps a sway balanced rather
      // than leaning.
      spineTwist: -s * 12 * DEG,
      head: { swing: 4 * DEG, lift: s * 10 * DEG },
      // No travel at all. A quiet section that wanders across the stage reads as
      // restlessness, which is the opposite of what this is for.
      travel: 0,
      arms: [
        { swing: (-22 - s * 16) * DEG * drive, lift: (14 + s * 8) * DEG,
          elbow: (34 + s * 14) * DEG },
        { swing: (-22 + s * 16) * DEG * drive, lift: (14 - s * 8) * DEG,
          elbow: (34 - s * 14) * DEG },
      ],
      legs: [
        { swing: (10 + s * 8) * DEG, lift: 7 * DEG,
          knee: (16 + Math.max(0, -s) * 14) * DEG },
        { swing: (10 - s * 8) * DEG, lift: -7 * DEG,
          knee: (16 + Math.max(0, s) * 14) * DEG },
      ],
    };
  },

  idle(bar, beat, energy) {
    const s = Math.sin(bar * Math.PI * 2);
    return {
      bob: -swell(beat) * 0.02,
      sway: s * 0.05,
      turn: s * 12 * DEG,
      spineBend: 3 * DEG,
      spineTwist: -s * 8 * DEG,
      head: { swing: s * 7 * DEG, lift: 0 },
      travel: s * 0.10,
      arms: [
        { swing: (-14 - s * 12) * DEG, lift: 12 * DEG, elbow: (28 + s * 12) * DEG },
        { swing: (-14 + s * 12) * DEG, lift: -12 * DEG, elbow: (28 - s * 12) * DEG },
      ],
      legs: [
        { swing: (8 + s * 6) * DEG, lift: 5 * DEG, knee: 12 * DEG },
        { swing: (8 - s * 6) * DEG, lift: -5 * DEG, knee: 12 * DEG },
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
 * Stands in for the language-model choreography pass. Once `score.choreography`
 * exists it takes precedence, and this becomes the fallback. Worth noting that
 * for every track analysed so far this *is* the choreography: none of the cached
 * scores carry lyrics, so the theme-driven path has never run.
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
 * from 117.3 degrees early in the phrase to 128.2 at its peak, and the legs from
 * 78.4 to 88.9 - about 9% and 13%. Deliberately modest. Pushing the range wider
 * makes the figures visibly pulse in and out rather than reading as a phrase
 * that grows, which is a worse artefact than the flatness it replaced.
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

/**
 * Routines chosen by what a section's lyrics are about.
 *
 * This is the point of transcribing at all. Audio features say how loud and
 * bright a passage is; they cannot distinguish a defiant chorus from a jubilant
 * one at the same volume. The theme can, and that difference is the whole
 * character of the dance.
 *
 * Falls back to the energy-based routines below whenever there are no lyrics,
 * which covers every instrumental and every track where transcription was
 * unavailable.
 */
const THEME_ROUTINES = {
  motion: [
    ['run', 'run', 'slide', 'march'],
    ['march', 'run', 'kick', 'slide'],
  ],
  romance: [
    ['sway', 'wave', 'step', 'sing'],
    ['wave', 'sway', 'sing', 'step'],
  ],
  defiance: [
    ['march', 'point', 'headbang', 'kick'],
    ['headbang', 'point', 'march', 'jump'],
  ],
  celebration: [
    ['reach', 'jump', 'clap', 'floss'],
    ['clap', 'reach', 'shimmy', 'jump'],
  ],
  melancholy: [
    ['idle', 'sway', 'wave', 'idle'],
    ['sway', 'idle', 'sing', 'sway'],
  ],
  aspiration: [
    ['reach', 'wave', 'reach', 'spin'],
    ['spin', 'reach', 'sing', 'wave'],
  ],
};

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
 * identical figures into a group with a front person. On quiet sections nobody
 * takes lead, because a ballad with a hype man behind it reads as wrong.
 *
 * @param {string} sectionMove Move chosen for the section.
 * @param {number} dancerIndex
 * @param {object} section
 * @returns {string}
 */
function moveForDancer(sectionMove, dancerIndex, section) {
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
    // The lead alternates between singing and joining in, so it is not static.
    return section.index % 3 === 2 ? sectionMove : 'sing';
  }

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
const SHOTS = [
  {
    name: 'wide', position: [0, 2.2, -9.5], look: [0, 1.0, 0], target: null,
    drift: { amp: [1.6, 0.35, 0.8], period: [17, 11, 23] },
  },
  {
    name: 'low hero', position: [-2.6, 0.55, -4.2], look: [0, 1.1, 0], target: 'pick',
    drift: { amp: [1.1, 0.20, 0.9], period: [13, 9, 19] },
  },
  {
    name: 'crane', position: [3.2, 5.4, -7.0], look: [0, 0.9, 0], target: null,
    drift: { amp: [2.2, 1.4, 1.2], period: [21, 15, 26] },
  },
  {
    name: 'close', position: [1.2, 1.5, -2.9], look: [0, 1.3, 0], target: 'pick',
    drift: { amp: [0.8, 0.35, 0.6], period: [11, 8, 14] },
  },
  {
    name: 'floor', position: [0, 0.25, -5.0], look: [0, 1.4, 0], target: null,
    drift: { amp: [2.4, 0.12, 0.5], period: [19, 23, 17] },
  },
  {
    name: 'sidelong', position: [-7.5, 1.6, 0.5], look: [0, 1.1, 0], target: null,
    drift: { amp: [0.9, 0.5, 2.6], period: [24, 13, 18] },
  },
  {
    name: 'overhead', position: [0.5, 7.5, -3.0], look: [0, 0.6, 0], target: null,
    drift: { amp: [1.8, 0.9, 1.8], period: [27, 19, 22] },
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
    this.energy += (lanes.energy[frame] - this.energy) * 0.09;
    this.punch += (lanes.punch[frame] - this.punch) * 0.45;

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
      this.formation = section.index % FORMATIONS.length;

      // Lyrics take precedence when present. When absent - every instrumental,
      // and any track where transcription was unavailable - a stand-in is
      // derived from the audio so the choreography still has valence, arousal
      // and density to work with rather than falling back to a single default
      // routine. Brightness maps to valence and flux to arousal, the same
      // mapping the shared lane reader uses.
      const mood = score.lyrics?.sections?.[section.index] ?? {
        valence: (section.brightness_mean - 0.45) * 1.4,
        arousal: Math.min(1, section.energy_mean * 1.3),
        density: section.energy_mean * 3,
        theme: null,
        keywords: [],
      };
      this.mood = mood;

      const planned = score.choreography?.sections?.[section.index];
      this.routine = routineForSection(section, planned);
      this.phraseKey = null;
      if (planned?.palette?.length === 2) this.palette = planned.palette;
      this.pickShot(section.index);
    }

    const { tempo_bpm: bpm, meter, beats } = score.timing;
    const interval = 60 / (bpm > 0 ? bpm : 120);
    const origin = beats.length ? beats[0] : 0;
    const beatCount = Math.max(0, playbackSec - origin) / interval;
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

  /**
   * Choose the routine for the current section from its lyric theme.
   *
   * Entries are validated against {@link MOVES} before being returned. They were
   * not, and the romance and melancholy routines both named `sway` at a point
   * when no such move existed - `MOVES.sway` came back undefined and the
   * renderer threw on the next frame. An exception here is not cosmetic: the
   * render guard in `main.js` disables Stick Men for the rest of the session, so
   * one bad name in a table takes the whole visualisation off the menu. Unlike
   * `routineForSection`, which already filtered, this path fed `updatePhrase`
   * directly.
   *
   * `sway` is now a real move, so those two routines pass intact. The filter
   * stays regardless: these tables are edited by hand and the failure mode is
   * far too expensive for the check to be worth removing.
   *
   * @param {object} section
   * @returns {string[]|null} Move names, or null to fall back to the section
   *   routine.
   */
  routineFor(section) {
    void section;
    const themed = this.mood?.theme ? THEME_ROUTINES[this.mood.theme] : null;
    if (!themed) return null;
    // Arousal picks between the calmer and busier variant of the theme, so a
    // quiet romantic verse and a soaring romantic chorus differ.
    const variant = themed[this.mood.arousal > 0.35 ? 1 : 0];
    const valid = variant.filter((move) => MOVES[move]);
    return valid.length > 0 ? valid : null;
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
    const routine = this.routineFor(this.section) ?? this.routine;
    this.move = routine[phraseIndex % routine.length];

    const calm = this.section.energy_mean < QUIET_ENERGY;
    for (const dancer of this.dancers) {
      dancer.move = moveForDancer(this.move, dancer.index, this.section);
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
   * Choose a camera setup for a section.
   *
   * The shot is only a *destination*; the camera eases toward it, so sections
   * flow into each other rather than cutting.
   */
  pickShot(sectionIndex) {
    this.shot = SHOTS[sectionIndex % SHOTS.length];
    this.shotTarget = this.shot.target === 'pick'
      ? sectionIndex % this.dancers.length
      : null;
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

    this.camera.position = easeVec(this.camera.position, wantedPosition, 0.55, deltaSec);
    this.camera.look = easeVec(this.camera.look, wantedLook, 1.1, deltaSec);
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
    const offset = dancer.beatOffset + dancer.canon * spread;
    const dancerBeat = beatCount + offset;
    const bar = (dancerBeat / meter) % 1;
    const beat = dancerBeat % 1;

    // Connecting movement at the head of a phrase. Counted in beats rather than
    // seconds so it scales with tempo: two beats of connector is two beats of
    // connector whether the track is 90bpm or 160.
    if (dancer.transitionBeats > 0) {
      dancer.transitionBeats -= deltaSec / (60 / (this.bpm > 0 ? this.bpm : 120));
    }
    const connecting = dancer.transitionBeats > 0;

    const moveName = connecting ? dancer.connector : (dancer.move ?? this.move);
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
      const groove = 0.55 + this.energy * 0.65;
      target.bob -= downbeat * 0.045 * groove;
      target.sway += weight * 0.055 * groove;
      target.spineTwist -= weight * 5 * DEG * groove;
      target.legs[0].knee += Math.max(0, weight) * 8 * DEG * groove;
      target.legs[1].knee += Math.max(0, -weight) * 8 * DEG * groove;
    }

    // Arm flourish, layered on whatever the move specifies.
    //
    // Several moves hold one arm still by design - the mic hand in `sing` is the
    // clearest case - and because the lead sings for most of a track, that arm
    // read as dead. Measured across two minutes, arm 0 varied by 40 degrees of
    // lift against arm 1's 101.
    //
    // This adds a continuous, independently-phased motion to both arms, so
    // neither can ever be static regardless of what the pose asks for. The two
    // sides use different rates so they never mirror each other, which is what
    // makes the motion look like dancing rather than calisthenics.
    const flourishClock = beatCount * 0.5 + offset * 6.28;
    // Limb travel takes the energy that used to go into vertical launch: a
    // dancer at full tilt moves their arms and hips further, not higher.
    // Lyric valence scales the whole performance. Bleak words make the figures
    // move smaller and stay lower; elated ones open them up. Neutral or absent
    // lyrics leave this at 1, so nothing changes for instrumentals.
    const valence = this.mood?.valence ?? 0;
    const spirit = 1 + valence * 0.22;
    // Delivery speed drives it too: a dense rap verse should look busier than a
    // sparse one at the same loudness.
    const wordy = Math.min(1, (this.mood?.density ?? 0) / 4);

    // Named `amplitude`, not `swell`: the module-level `swell()` is a 0-1-0
    // curve and this is a scalar multiplier. Shadowing it here meant any use of
    // `swell(bar)` inside this method would have thrown "not a function".
    //
    // Scaled by the phrase arc, which is what gives a routine somewhere to go.
    // Without it every bar of a phrase was performed at identical size, so a
    // move could only ever repeat - the movement had rhythm but no shape.
    const amplitude = (0.95 + this.energy * 2.05 + wordy * 0.35)
      * spirit * arc.intensity;

    // Separate, smaller gain for the flourishes.
    //
    // `amplitude` reaches about 2.4 on a loud section at the peak of a phrase,
    // and the flourish terms below are written in degrees that already assume a
    // gain near 1. Multiplied out, the elbow flourish alone swung +/-79 degrees
    // across a joint whose entire range is 107 - so it could not help but drive
    // the joint into its limit, and it did so on 24% of frames even after the
    // limits were softened. Compressing the top of the range keeps loud
    // passages bigger than quiet ones without letting the accent outgrow the
    // body it is decorating.
    const flourishGain = Math.min(amplitude, 1.05 + Math.tanh(amplitude - 1.05) * 0.55);

    // The flourish is locked to the bar rather than free-running, so the motion
    // repeats as a pattern the eye can follow instead of wandering. A cycle that
    // does not close on a musical boundary reads as drift; one that does reads
    // as choreography.
    const barPhase = (beatCount / 4 + offset) % 1;
    const patterned = Math.sin(barPhase * Math.PI * 2);
    const patternedHalf = Math.sin(barPhase * Math.PI * 4);

    // The five endpoints - two hands, two feet, the head - are what a viewer
    // actually reads as the shape of a dance. Driving them on separate,
    // incommensurate cycles means the figure forms new silhouettes continuously
    // instead of cycling through the same handful of poses.
    //
    // Each endpoint gets its own reach envelope: a slow swell that moves it
    // toward and away from the body independently of what its limb is doing, so
    // an arm can extend fully while the other folds in.
    // The parameter is `seed`, not `offset`: an enclosing `offset` now carries
    // this figure's canon displacement, and a parameter of the same name would
    // silently hide it from every call made here.
    const envelope = (rate, seed) => 0.5 + 0.5
      * Math.sin(flourishClock * rate + seed)
      * Math.sin(flourishClock * rate * 0.37 + seed * 1.7);

    // Choreographic figures.
    //
    // Moves define a pose per bar; what was missing is *structure across bars* -
    // the repeating, resolving shapes a routine is actually built from. Each
    // figure below is a closed mathematical form evaluated over the phrase, so
    // the motion is guaranteed to return to where it started and therefore reads
    // as deliberate rather than as drift.
    //
    // The three are chosen to be geometrically distinct, so they cannot blur
    // into one another: a figure-eight crosses the body, a circle sweeps around
    // it, and a pendulum swings across it. Which one is running comes from the
    // phrase index, so it changes on musical boundaries.
    const phraseT = ((beatCount / (4 * PHRASE_BARS)) + offset) % 1;
    const figure = (this.phraseIndex + dancer.index) % 3;
    const tau = phraseT * Math.PI * 2;

    // Each returns a reach and a height offset for the arms, in radians.
    let figureReach;
    let figureLift;
    if (figure === 0) {
      // Lemniscate - a figure of eight. The arms cross the midline twice per
      // phrase, which is the single most legible "dance" shape there is.
      const d = 1 + Math.sin(tau) ** 2;
      figureReach = (Math.cos(tau) / d) * 46 * DEG;
      figureLift = (Math.sin(tau) * Math.cos(tau) / d) * 62 * DEG;
    } else if (figure === 1) {
      // Circle, traced at a phase offset per arm so they chase each other.
      figureReach = Math.cos(tau) * 38 * DEG;
      figureLift = Math.sin(tau) * 48 * DEG;
    } else {
      // Pendulum: a swing that slows at each extreme and holds there, which is
      // what gives a movement its accent.
      const swing = Math.sin(tau);
      figureReach = Math.sign(swing) * Math.abs(swing) ** 0.6 * 52 * DEG;
      figureLift = Math.cos(tau * 2) * 30 * DEG;
    }

    // Weight shift.
    //
    // The single largest thing missing from the movement. A dancer is always
    // standing on one foot more than the other, and everything follows from
    // that: the hips ride over the supporting leg, that leg straightens to carry
    // the load, the free leg bends and lightens, and the shoulders counter-rotate
    // to stay balanced. Without it the figure is symmetrical at every instant,
    // which is why it read as a mechanism rather than a body.
    //
    // Support alternates every two beats - the pulse a dancer actually shifts
    // on, rather than every beat which reads as marching.
    const shiftPhase = (beatCount / 2 + offset) % 1;
    // Smoothstep rather than a sine: the transfer happens over part of the
    // cycle and then holds, which is how weight actually moves.
    const raw = Math.sin(shiftPhase * Math.PI * 2);
    const weight = Math.sign(raw) * Math.min(1, Math.abs(raw) * 1.6);
    // +1 means weight on side 0, -1 on side 1. Written into a pair the dancer
    // already owns rather than a fresh array, because `drawDancer` needs it to
    // decide which foot is carrying the figure and may therefore be planted.
    dancer.support[0] = (1 + weight) / 2;
    dancer.support[1] = (1 - weight) / 2;

    // Preparation before each accent, scaled by how much of an accent there is
    // to prepare for. A silent passage should not have the figures bracing for
    // impacts that never arrive, which is what an unscaled term would produce.
    const prep = anticipate(beat) * (0.2 + this.punch * 0.8);

    const armFlourish = [0, 1].map((side) => {
      const mirror = side === 0 ? 1 : -1;
      const phase = flourishClock * (side === 0 ? 1.0 : 0.83) + side * 2.1;
      // Reach envelope per hand, so the two are rarely at the same extension.
      const extend = envelope(0.29 + side * 0.11, side * 2.6);
      return {
        extend,
        // Two components: a bar-locked pattern that gives the movement shape,
        // and a slower free drift so the pattern is never mechanically exact.
        swing: (patterned * 26 * mirror + Math.sin(phase * 0.61) * 14) * DEG * flourishGain,
        lift: (patternedHalf * 30 + Math.sin(phase * 0.44 + 1.1) * 16) * DEG * flourishGain,
        // Straightening and folding is what makes a gesture read as a *reach*
        // rather than a wave. Driven by the envelope, not by the pose.
        elbow: (patterned * 20 * mirror + Math.sin(phase * 0.77) * 12
          - (extend - 0.5) * 46) * DEG * flourishGain,
      };
    });

    // Feet, on their own envelopes. Without these the legs only ever step,
    // which is why the lower half looked static next to the arms.
    const legFlourish = [0, 1].map((side) => {
      const mirror = side === 0 ? 1 : -1;
      const extend = envelope(0.23 + side * 0.09, 1.3 + side * 2.1);
      const phase = flourishClock * (side === 0 ? 0.91 : 1.07) + side * 1.6;
      return {
        swing: (patternedHalf * 16 * mirror + Math.sin(phase * 0.53) * 11) * DEG * flourishGain,
        lift: (patterned * 13 * mirror + Math.sin(phase * 0.67) * 8) * DEG * flourishGain,
        knee: (Math.sin(phase * 0.83) * 16 - (extend - 0.5) * 40) * DEG * flourishGain,
      };
    });

    // Hips and shoulders get their own, so the whole body is involved rather
    // than only the limbs - which is most of what separates dancing from
    // gesturing.
    const bodyFlourish = {
      sway: (patterned * 0.09 + Math.sin(flourishClock * 0.53) * 0.04) * amplitude,
      turn: (patterned * 22 + Math.sin(flourishClock * 0.37) * 10) * DEG * amplitude,
      twist: (patternedHalf * 26 + Math.sin(flourishClock * 0.71) * 12) * DEG * amplitude,
      // A shallow bounce on the beat, not a leap.
      //
      // This was scaled by `amplitude`, which reaches 2.6 at high energy - so the
      // figures launched off the floor with nothing bringing them down in any
      // controlled way, which read as twitching rather than dancing. Dancers
      // stay grounded and move mostly in the hips and limbs; vertical travel is
      // punctuation, not the substance.
      //
      // The second term is the preparation: the hips sink slightly in the last
      // quarter-beat before an accent, so the figure gathers itself and then
      // meets the beat rather than being knocked into motion by it. It is
      // subtracted from a value that is already negative-going, so preparation
      // and the bounce it precedes work in the same direction.
      bob: -Math.abs(Math.sin(beatCount * Math.PI)) * 0.030 - prep * 0.045,
      // Folding into the preparation as well: a body that dips without its spine
      // following reads as the hips dropping out from under a rigid torso.
      prepBend: prep * 7 * DEG,
    };

    // Head performance, layered on top of whatever the move specifies.
    //
    // Moves set the head mainly to punctuate their own gesture, so across a
    // routine it barely moves. A continuous lane driven by the music - nodding
    // to the beat, scanning slowly, tilting into the phrase - gives the figures
    // something alive above the shoulders regardless of what their limbs are
    // doing. Rates are incommensurate so the pattern never visibly loops.
    const headClock = beatCount * 0.25 + offset * 6.28;
    const nod = attack(beat) * (0.35 + this.punch * 0.5);
    const headSwell = 0.85 + this.energy * 1.2;
    const headExtra = {
      swing: (Math.sin(headClock * 0.71) * 16
        + Math.sin(headClock * 0.29 + 2.2) * 9 - nod * 20) * DEG * headSwell,
      lift: (Math.sin(headClock * 0.43 + 1.7) * 22
        + Math.sin(headClock * 1.13) * 9) * DEG * headSwell,
    };

    // Amplify *movement*, not absolute angle.
    //
    // Multiplying the raw values was wrong and produced exactly the complaint
    // that limbs sit behind the head: an arm held at -128 degrees for a
    // microphone became -256 at high energy, wrapping right around the body.
    // Scaling the deviation from a neutral stance instead exaggerates gestures
    // while leaving held positions where the pose intended them.
    // The phrase arc has to reach *this* factor, not only the flourish terms.
    //
    // Scaling `amplitude` alone was measured and does almost nothing: the
    // flourishes are added on top of the move's own angles, and those angles are
    // amplified here instead. With only the flourish scaled, hand travel across
    // a phrase stayed flat within noise - 0.164 to 0.209 with no discernible
    // shape - because the dominant term was not being shaped at all.
    // Half the arc, not all of it.
    //
    // `amplitude` above is already scaled by the full phrase intensity, and it
    // drives the flourish that is *added* to whatever this produces. Scaling
    // both by the same factor compounds: at the peak of a phrase on a loud
    // section the two together pushed authored poses roughly two and a half
    // times past what was written, which is what drove the joints onto their
    // limits and folded the figures into a single black mass.
    const reach = (1.30 + this.energy * 0.55) * (1 + (arc.intensity - 1) * 0.5);
    const from = (value, rest) => rest + (value - rest) * reach;

    const amplified = {
      ...target,
      // Vertical travel is clamped hard. A move's own bob is a fraction of a
      // body height by design, but multiplying it by the amplification factor
      // turned a small hop into a launch.
      // Riding over the supporting foot lowers the body slightly, as taking the
      // load compresses the standing leg.
      bob: clamp(
        target.bob * Math.min(reach, 1.15) + bodyFlourish.bob
          + Math.abs(weight) * 0.012,
        LIMITS.bob,
      ),
      // Hips travel toward the supporting side. This is the visible half of the
      // weight shift and the reason the figure looks planted rather than
      // hovering.
      sway: target.sway * reach + bodyFlourish.sway + weight * 0.10,
      turn: from(target.turn, 0) + bodyFlourish.turn,
      spineBend: softClamp(
        from(target.spineBend, 4 * DEG) + bodyFlourish.prepBend, LIMITS.spine,
      ),
      // Shoulders counter-rotate against the hips, which is what keeps a shifting
      // body balanced and reads as ease rather than stiffness.
      spineTwist: softClamp(
        from(target.spineTwist, 0) + bodyFlourish.twist - weight * 11 * DEG,
        LIMITS.spine,
      ),
      head: {
        swing: softClamp(from(target.head.swing, 0) + headExtra.swing, LIMITS.head),
        lift: softClamp(from(target.head.lift, 0) + headExtra.lift, LIMITS.head),
      },
      arms: target.arms.map((arm, side) => ({
        swing: softClamp(
          from(arm.swing, REST.armSwing) + armFlourish[side].swing, LIMITS.armSwing,
        ),
        // Lift is exaggerated harder than the rest: getting arms away from the
        // torso is what makes a pose readable at a distance.
        lift: softClamp(
          repel(
            REST.armLift + (arm.lift - REST.armLift) * (reach * 1.25)
              + armFlourish[side].lift,
            dancer.pose.arms[side].lift,
            MIN_ARM_SPREAD, dancer.tuck.arms[side], deltaSec,
          ),
          LIMITS.armLift,
        ),
        // The accent is applied around the rest value rather than added on top,
        // so a large flourish opens the arm as often as it closes it. Purely
        // additive, it only ever bent the elbow further shut.
        // Bend is barely amplified, unlike every other joint.
        //
        // Amplifying a fold is backwards. `fromLegacy` maps bend to reach
        // inversely - the more an elbow is folded, the shorter the arm gets and
        // the closer the hand sits to the shoulder - so scaling bend by the
        // usual factor makes a gesture *smaller* while spending the joint's
        // whole range doing it. A move authoring 80 degrees of bend came out at
        // 142, past the 112 limit, so it pinned there with the hand tucked into
        // the chest: measured at 27% of all frames, and the single largest
        // reason the figures rendered as one black mass.
        //
        // Capped the way `bob` is. A bigger gesture is a straighter arm reaching
        // further, which the swing and lift terms above already deliver.
        elbow: softClamp(
          REST.elbow + (arm.elbow - REST.elbow) * Math.min(reach, 1.12)
            + armFlourish[side].elbow * 0.45,
          LIMITS.elbow,
        ),
      })),
      legs: target.legs.map((leg, side) => ({
        swing: softClamp(
          from(leg.swing, REST.legSwing) + legFlourish[side].swing, LIMITS.legSwing,
        ),
        lift: softClamp(
          repel(
            REST.legLift + (leg.lift - REST.legLift) * (reach * 1.15)
              + legFlourish[side].lift,
            dancer.pose.legs[side].lift,
            MIN_LEG_SPREAD, dancer.tuck.legs[side], deltaSec,
          ),
          LIMITS.legLift,
        ),
        knee: softClamp(
          from(leg.knee, REST.knee) + legFlourish[side].knee, LIMITS.knee,
        ),
      })),
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

    dancer.facing = pose.turn * dancer.mirror;
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
    // Taller, with the extra height in the legs and spine rather than in the
    // head - lengthening everything uniformly just scales the figure up, where
    // longer limbs against the same head give a genuinely taller silhouette.
    const hipHeight = 1.16 * s;
    const spineLen = 0.52 * s;
    const shoulderHalf = 0.20 * s;
    const upperArm = 0.36 * s;
    const foreArm = 0.34 * s;
    const thigh = 0.56 * s;
    const shin = 0.54 * s;

    const yaw = dancer.facing;
    const root = [dancer.x + pose.sway * Math.cos(yaw), hipHeight + pose.bob, dancer.z];
    const toWorld = (local) => add(root, rotY(local, yaw));

    // How tall this figure is on screen right now, which everything scales from.
    const pRoot = this.project(root, width, height);
    const worldHeight = thigh + shin + spineLen + 0.42 * s;
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

    pose.arms.forEach((arm, side) => {
      const sign = side === 0 ? 1 : -1;
      const shoulder = add(chest, rotY([sign * shoulderHalf, 0, 0], chestYaw));
      // Lift is amplified and the forearm bends *against* the upper arm rather
      // than continuing its arc. Adding the elbow to the swing curled the hand
      // back toward the head, which is why arms never appeared to extend.
      const swing = arm.swing;
      const lift = arm.lift * 1.75;
      const aimed = fromLegacy(swing, lift * sign, arm.elbow);
      // Elbows break backward, both of them.
      //
      // The bend used to be `sign`, i.e. mirrored per side - so one elbow bent
      // backward and the other forward, and neither was reliably anatomical.
      // Both arms bend the same way relative to the body, which is what stops
      // the joints looking inverted.
      const solved = limb(
        // Negative: an elbow protrudes *behind* the line from shoulder to hand.
        // Positive put it in front, which is why arms appeared to bend the wrong
        // way at every pose.
        aimed.elevation, aimed.azimuth, aimed.extend, upperArm, foreArm, -1,
      );
      const elbow = add(shoulder, rotY(solved.joint, chestYaw));
      let hand = add(shoulder, rotY(solved.end, chestYaw));
      hand = this.applyLag(dancer.lag.hands, side, hand, deltaSec, 8 * dancer.looseness);
      bones.push({ a: shoulder, b: elbow, w: limbPx });
      bones.push({ a: elbow, b: hand, w: limbPx * 0.95 });
    });

    const legSpan = thigh + shin;
    pose.legs.forEach((leg, side) => {
      const sign = side === 0 ? 1 : -1;
      const hip = add(root, rotY([sign * shoulderHalf * 0.62, 0, 0], yaw));
      // Legs spread wider too, so a stance reads as a stance.
      const freeAim = fromLegacy(leg.swing, leg.lift * sign * 1.35, leg.knee);

      // Where the foot would go if it were merely pointed, which is what the
      // pose tables describe and what planting decisions are measured from.
      const freeSolved = limb(
        freeAim.elevation, freeAim.azimuth, freeAim.extend, thigh, shin, 1,
      );
      const freeFoot = add(hip, rotY(freeSolved.end, yaw));

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
        14 * dancer.looseness + dancer.plant[side].strength * 400,
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
    if (!plant.held && load > 0.62) {
      // Pinned where the foot actually is, *not* at floor level.
      //
      // Snapping the plant to y=0 is the obvious thing and it does not work:
      // this rig's legs cannot reach the floor. Measured from the proportions in
      // `drawDancer`, the hip sits at 1.160 build units and a leg spans
      // 0.56 + 0.54 = 1.100, of which `limb()` will only ever extend 98% - so the
      // furthest a foot can get from the hip is 1.078, and the floor is 0.082
      // beyond it. A plant at y=0 would be unreachable on the frame it was made,
      // release immediately, and pin nothing ever.
      //
      // Holding the foot's own position sidesteps the question: it is reachable
      // by construction, because the foot is already there.
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
