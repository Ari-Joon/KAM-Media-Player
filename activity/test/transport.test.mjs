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

// --- The marquee must not mask the start of a parked title -------------------
//
// Called against the prototype, like the drop arithmetic above: none of this
// needs the full transport markup, only a title and its window.
//
// The fault was that the fade mask was applied on the scrolling path only,
// *after* the pause check returned early. So a title parked at its beginning
// kept the leading fade that had been applied while it was scrolling, and its
// first characters stayed hidden for the whole hold. Clicking the title is the
// worst case, because that is what sets the longest hold - the name was eaten
// at exactly the moment somebody asked to read it.
{
  const { tickMarquee } = Transport.prototype;

  const makeWindow = () => {
    const classes = new Set();
    return {
      clientWidth: 100,
      classList: {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        has: (name) => classes.has(name),
      },
    };
  };

  const scrolledFor = (marquee, frames) => {
    const titleWindow = makeWindow();
    const title = { scrollWidth: 300, style: {} };
    const self = { elements: { title, titleWindow }, marquee };
    for (let i = 0; i < frames; i += 1) tickMarquee.call(self, 1 / 60);
    return { scrolled: titleWindow.classList.has('scrolled'), transform: title.style.transform };
  };

  // Parked at the start and held, which is the state a click produces.
  const clicked = scrolledFor({ offset: 0, paused: 4 }, 1);
  assert.equal(clicked.scrolled, false,
    'a title held at its start must not carry the leading fade');
  assert.equal(clicked.transform, 'translateX(0px)');

  // Once it has scrolled away, the leading fade is right - that is what stops
  // the text appearing to slide out from under a hard edge.
  const moved = scrolledFor({ offset: 0, paused: 0 }, 60);
  assert.equal(moved.scrolled, true, 'a scrolled title fades at both edges');

  // Held mid-scroll: still faded, because it is still away from the start.
  const heldAway = scrolledFor({ offset: 40, paused: 2 }, 1);
  assert.equal(heldAway.scrolled, true);
  assert.equal(heldAway.transform, 'translateX(-40px)');

  // A title that fits never scrolls and never fades.
  {
    const titleWindow = makeWindow();
    const title = { scrollWidth: 90, style: {} };
    const self = { elements: { title, titleWindow }, marquee: { offset: 0, paused: 0 } };
    tickMarquee.call(self, 1 / 60);
    assert.equal(titleWindow.classList.has('scrolled'), false);
  }

  console.log('title marquee: 5/5 pass (a parked title is never masked at its start)');
}

// --- Touch selection mode ----------------------------------------------------
// Multi-select was ctrl-click and shift-click only, so on a phone the batched
// remove could not be reached at all. A long press on a queue row enters a mode
// where taps select, and the selection bar is the way out.
//
// Exercised against the prototype for the same reason the drop arithmetic is:
// the constructor demands the whole transport markup, and none of this state
// machine touches it.
{
  const { claimQueueLongPress, toggleQueueSelection, clearQueueSelection,
    updateQueueSelectionBar } = Transport.prototype;

  /** A Transport with just the fields this state machine reads. */
  const makeSelf = () => ({
    queueSelection: new Set(),
    queueAnchor: null,
    queueTouchSelect: false,
    queueSignature: 'stale',
    lastDecks: null,
    elements: {
      queueSelectionBar: { hidden: true },
      queueSelectionCount: { textContent: '' },
    },
  });

  /** A DOM row stand-in: `closest` is the only thing the claim uses. */
  const row = (match) => ({ closest: (selector) => (match ? { dataset: match } : null) });

  // A long press outside the queue must not be claimed - everywhere else it is
  // the only way to reach "play next" and "add to playlist" on a phone.
  const elsewhere = makeSelf();
  assert.equal(claimQueueLongPress.call(elsewhere, row(null)), false,
    'a long press outside the queue was taken from the track menu');
  assert.equal(elsewhere.queueTouchSelect, false);

  // A row with no usable position is not a row to select. Without this the mode
  // would be entered with NaN in the selection, which no track can ever match -
  // so the bar would offer a Remove that silently removed nothing.
  assert.equal(claimQueueLongPress.call(makeSelf(), row({ position: 'nonsense' })), false,
    'an unparseable position entered selection mode anyway');

  const self = makeSelf();
  assert.equal(claimQueueLongPress.call(self, row({ position: '4' })), true,
    'a long press on a queue row was not claimed');
  assert.equal(self.queueTouchSelect, true, 'the long press did not enter selection mode');
  // The pressed row has to be selected, not merely armed: an empty selection
  // leaves the bar hidden, and the bar is the only thing that says the mode is
  // running or offers a way out of it.
  assert.deepEqual([...self.queueSelection], [4], 'the pressed row was not selected');
  assert.equal(self.queueAnchor, 4);
  assert.equal(self.queueSignature, null, 'the queue was not marked for a rebuild');

  // Taps build the selection, and tapping a selected row takes it back out.
  toggleQueueSelection.call(self, 7);
  assert.deepEqual([...self.queueSelection].sort((a, b) => a - b), [4, 7]);
  toggleQueueSelection.call(self, 4);
  assert.deepEqual([...self.queueSelection], [7], 'tapping a selected row did not deselect it');

  // The bar names the mode. It is the only signal on a touch device that taps
  // have stopped playing tracks, so counting alone is not enough.
  updateQueueSelectionBar.call(self);
  assert.equal(self.elements.queueSelectionBar.hidden, false);
  assert.match(self.elements.queueSelectionCount.textContent, /tap to add/,
    'the bar did not say that taps are now selecting');

  // Cancel is the exit.
  clearQueueSelection.call(self);
  assert.equal(self.queueTouchSelect, false, 'cancelling left the mode running');
  assert.equal(self.queueSelection.size, 0);

  // Emptying the selection by any other route ends the mode too. Left on, the
  // next tap would select instead of playing with nothing on screen saying so.
  const emptied = makeSelf();
  emptied.queueTouchSelect = true;
  updateQueueSelectionBar.call(emptied);
  assert.equal(emptied.queueTouchSelect, false,
    'an empty selection left touch mode running with no visible bar');
  assert.equal(emptied.elements.queueSelectionBar.hidden, true);

  // With a mouse the bar keeps its plain label: ctrl-click selecting does not
  // change what a plain click does, and saying "tap to add" there would be a lie.
  const mouse = makeSelf();
  mouse.queueSelection.add(2);
  updateQueueSelectionBar.call(mouse);
  assert.equal(mouse.elements.queueSelectionCount.textContent, '1 selected');

  console.log('queue touch selection: 14/14 pass (long press enters, taps toggle, the bar exits)');
}
