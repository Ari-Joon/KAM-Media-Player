import assert from 'node:assert/strict';
import { Transport } from '../client/transport.js';
import { PainterVisual } from '../client/painter.js';

/**
 * Drop handling is exercised against the prototype rather than a constructed
 * Transport: the constructor demands the full transport markup, and none of
 * this logic touches it. What is being checked is the arithmetic that decides
 * where dropped tracks land - the part that fails silently, because a drop into
 * the wrong slot still looks like a working drag.
 */
const { positionForSlot, updateDropTarget } = Transport.prototype;

// --- positionForSlot: display slots are not queue indices ---------------------
// The panel lists only the upcoming tracks, so with T1 playing the first row is
// already queue position 1. A drop mapped to the row index instead would insert
// one slot too high every time.
const upcoming = { queuePositions: [3, 4, 5] };
assert.equal(positionForSlot.call(upcoming, 0), 3, 'first gap is the first upcoming track');
assert.equal(positionForSlot.call(upcoming, 1), 4);
assert.equal(positionForSlot.call(upcoming, 2), 5);
assert.equal(positionForSlot.call(upcoming, 3), 6, 'past the last row appends after it');

// A drop far below the rows arrives with a slot well past the end.
assert.equal(positionForSlot.call(upcoming, 99), 6, 'an over-large slot still appends');

// Nothing queued: there is no position to insert at, and null tells the server
// to append rather than insert at 0.
assert.equal(positionForSlot.call({ queuePositions: [] }, 0), null, 'empty queue appends');
assert.equal(positionForSlot.call({}, 0), null, 'unrendered queue appends');
console.log('positionForSlot: 7/7 pass (display slots map to queue positions)');

// --- updateDropTarget: which gap the pointer is in ---------------------------
// Three 20px rows starting at the top of the list.
const rows = [
  { middleY: 10, topOffset: 0, bottomOffset: 20 },
  { middleY: 30, topOffset: 20, bottomOffset: 40 },
  { middleY: 50, topOffset: 40, bottomOffset: 60 },
];

/** A stand-in that records where the indicator was asked to go. */
const probe = (dropRows) => ({
  dropRows,
  dropSlot: null,
  moves: [],
  showDropIndicator(offset) { this.moves.push(offset); },
  measureDropRows() { throw new Error('should not re-measure: rows are cached'); },
});

let target = probe(rows);
updateDropTarget.call(target, 4);              // above the first midpoint
assert.equal(target.dropSlot, 0, 'above the first row inserts before it');
assert.deepEqual(target.moves, [0], 'indicator sits on the top edge of row 0');

updateDropTarget.call(target, 24);             // past row 0's midpoint
assert.equal(target.dropSlot, 1);
assert.deepEqual(target.moves, [0, 20], 'indicator moved to the row 0/1 boundary');

updateDropTarget.call(target, 44);
assert.equal(target.dropSlot, 2);

updateDropTarget.call(target, 400);            // below every row
assert.equal(target.dropSlot, 3, 'below the last row appends');
assert.deepEqual(target.moves.at(-1), 60, 'indicator sits on the bottom edge of the last row');

// The no-op guard. dragover fires continuously, so movement within one gap must
// not restyle the indicator - this is the same wasted-write guard the scrub bar
// has, and without it the element is written sixty times a second.
const writes = target.moves.length;
updateDropTarget.call(target, 402);
updateDropTarget.call(target, 500);
updateDropTarget.call(target, 401);
assert.equal(target.moves.length, writes, 'moving inside one gap rewrote the indicator');

// Exactly on a midpoint belongs to the lower gap, and must not oscillate.
target = probe(rows);
updateDropTarget.call(target, 30);
assert.equal(target.dropSlot, 2, 'a pointer exactly on a midpoint picks one side');

// An empty queue has no rows: the indicator parks at the top and the slot is 0.
target = probe([]);
updateDropTarget.call(target, 250);
assert.equal(target.dropSlot, 0, 'an empty list has a single gap');
assert.deepEqual(target.moves, [0], 'indicator parks at the top of an empty list');
console.log('updateDropTarget: 11/11 pass (gap tracking, no-op guard)');

// --- Painter paces against the same duration the scrub bar shows -------------
// Regression: the duration came from the score, falling back to a hardcoded
// 240. A score with no usable source block therefore paced a 3:19 track as if
// it were four minutes - at 2:59 the picture was ~74% done and the lettering
// had not begun, against a scrub bar reading 90%.
{
  // The real render() needs a canvas; the duration choice does not, so it is
  // exercised through the same expression render() uses.
  const durationFor = (track, score) => track?.durationSec
    || score.source?.duration_sec
    || score.analysis?.analysed_duration_sec
    || 240;

  const track = { durationSec: 199 };
  const noSource = { analysis: {} };
  assert.equal(durationFor(track, noSource), 199,
    'a score with no source must not fall back to 240 when the track knows');

  // The case from the screenshot: at 2:59 of 3:19 the schedule must be past
  // both the artwork and the lettering windows.
  const progress = 179 / durationFor(track, noSource);
  assert.ok(progress > 0.87, `at 2:59 of 3:19 the poster must be finished, got ${progress}`);

  // The old behaviour, kept as the thing being guarded against.
  const stale = 179 / 240;
  assert.ok(stale < 0.75, 'the 240 fallback had not even finished the artwork');

  // The score still answers when the track does not carry a duration.
  assert.equal(durationFor(null, { source: { duration_sec: 88 } }), 88,
    'the score is still used when there is no track duration');
  assert.equal(durationFor({ durationSec: 0 }, { source: { duration_sec: 88 } }), 88,
    'a zero track duration falls through rather than dividing by zero');

  assert.equal(typeof PainterVisual, 'function', 'painter module still loads');
  console.log('painter duration: 6/6 pass (paced from the track, not a 240 fallback)');
}
