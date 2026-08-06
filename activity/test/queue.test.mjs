import assert from 'node:assert/strict';
import { Queue } from '../server/queue.js';

const track = (n) => ({ title: `T${n}`, providerId: `id${n}`, durationSec: 100 });
const titles = (q) => q.tracks.map((t) => t.title).join(',');

// --- basics -----------------------------------------------------------------
let q = new Queue();
assert.equal(q.current(), null, 'empty queue has no current track');
assert.equal(q.next(), null, 'next on empty queue is null');
q.add([track(1), track(2), track(3)]);
assert.equal(q.current().title, 'T1', 'first add becomes current');
assert.equal(q.upcoming().length, 2);
assert.equal(q.next().title, 'T2');
assert.equal(q.next().title, 'T3');
assert.equal(q.next(), null, 'queue ends with loop off');
console.log('basics: 6/6 pass');

// --- loop modes -------------------------------------------------------------
q = new Queue();
q.add([track(1), track(2)]);
q.setLoop('track');
assert.equal(q.next().title, 'T1', 'loop:track repeats on natural end');
assert.equal(q.next().title, 'T1', 'and keeps repeating');
assert.equal(q.next(true).title, 'T2', 'manual skip escapes loop:track');

q = new Queue();
q.add([track(1), track(2)]);
q.setLoop('queue');
q.next(); // T2
assert.equal(q.next().title, 'T1', 'loop:queue wraps to the start');

q = new Queue();
q.add([track(1)]);
assert.equal(q.cycleLoop(), 'track');
assert.equal(q.cycleLoop(), 'queue');
assert.equal(q.cycleLoop(), 'off', 'cycle returns to off');
console.log('loop modes: 7/7 pass');

// --- history and previous ---------------------------------------------------
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next(); q.next();                       // now on T3
assert.equal(q.current().title, 'T3');
assert.equal(q.previous().title, 'T2', 'previous steps back through history');
assert.equal(q.previous().title, 'T1');
assert.equal(q.previous().title, 'T1', 'previous at the start restarts current');
console.log('history: 4/4 pass');

// --- addNext and remove -----------------------------------------------------
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.addNext(track(9));
assert.equal(titles(q), 'T1,T9,T2,T3', 'addNext inserts after current');
q.remove(0);
assert.equal(titles(q), 'T9,T2,T3');
assert.equal(q.current().title, 'T9', 'removing a track before current shifts index');
console.log('insertion/removal: 3/3 pass');

// --- shuffle ----------------------------------------------------------------
q = new Queue();
q.add(Array.from({ length: 30 }, (_, i) => track(i)));
const before = q.current().title;
q.shuffle();
assert.equal(q.current().title, before, 'shuffle must not move the current track');
assert.equal(q.length, 30, 'shuffle must not lose tracks');

// Re-shuffling must actually produce a different order, or "shuffle again"
// silently does nothing.
const orders = new Set();
for (let i = 0; i < 8; i++) { q.shuffle(); orders.add(titles(q)); }
assert.ok(orders.size > 1, 'repeated shuffles produced identical orders');

// Every track must survive, exactly once.
const seen = new Set(q.tracks.map((t) => t.title));
assert.equal(seen.size, 30, 'shuffle duplicated or dropped tracks');
console.log(`shuffle: 4/4 pass (${orders.size} distinct orders from 8 shuffles)`);

// --- serialisation ----------------------------------------------------------
q = new Queue();
q.add([track(1), track(2), track(3)]);
const json = q.toJSON();
assert.equal(json.current.title, 'T1');
assert.equal(json.total, 3);
assert.equal(json.upcoming[0].position, 1, 'upcoming positions are queue indices');
assert.equal(json.loop, 'off');
console.log('serialisation: 4/4 pass');

// --- /clear semantics: keep the playing track, drop the rest -----------------
q = new Queue();
q.add([track(1), track(2), track(3), track(4)]);
q.next();                                  // playing T2
q.tracks.length = q.index + 1;             // what /clear does
assert.equal(q.current().title, 'T2', 'clear keeps the playing track');
assert.equal(q.upcoming().length, 0, 'clear drops everything upcoming');
assert.equal(q.length, 2, 'history before the current track is preserved');

// --- /remove position mapping -----------------------------------------------
q = new Queue();
q.add([track(1), track(2), track(3), track(4)]);
q.next();                                  // playing T2, upcoming = T3, T4
// /queue lists upcoming from 1, so position 1 must map to T3.
assert.equal(q.remove(q.index + 1).title, 'T3', 'position 1 removes the next track');
assert.equal(q.current().title, 'T2', 'removing an upcoming track leaves current alone');
assert.equal(q.remove(q.index + 5), null, 'out-of-range removal is rejected');
console.log('clear/remove semantics: 6/6 pass');

// --- The replay bug: a finished queue must not look like a fresh one ---------
// Regression: one track played, ended, and `index === -1` made upcoming()
// return every track again, so playback restarted forever.
q = new Queue();
q.add(track(1));
assert.equal(q.current().title, 'T1');
assert.equal(q.next(), null, 'single track ends the queue');
assert.equal(q.ended, true, 'the queue is marked finished');
assert.equal(q.upcoming().length, 0, 'a finished queue has nothing upcoming');

// Three tracks, played out: same must hold.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next(); q.next();
assert.equal(q.next(), null);
assert.equal(q.upcoming().length, 0, 'exhausted queue reports nothing upcoming');

// Queueing after the end resumes at the NEW track, not back at the top.
q = new Queue();
q.add([track(1), track(2)]);
q.next(); q.next();                        // finished
q.add(track(9));
assert.equal(q.current().title, 'T9', 'adding after the end plays the new track');
assert.equal(q.ended, false, 'and clears the finished flag');

// previous() must un-finish the queue so playback can continue.
q = new Queue();
q.add([track(1), track(2)]);
q.next(); q.next();
assert.equal(q.previous().title, 'T2', 'previous works after the queue ended');
assert.equal(q.ended, false);
console.log('replay regression: 9/9 pass');

// --- move(): the index must follow the music, not the array -----------------
q = new Queue();
q.add([track(1), track(2), track(3), track(4)]);
q.next();                                   // playing T2, index 1

// Moving an upcoming track around must not disturb playback.
q.move(3, 2);
assert.equal(titles(q), 'T1,T2,T4,T3');
assert.equal(q.current().title, 'T2', 'reordering upcoming leaves current alone');

// Moving something from before the playhead to after it shifts the index back.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next();                                   // playing T2, index 1
q.move(0, 2);
assert.equal(titles(q), 'T2,T3,T1');
assert.equal(q.current().title, 'T2', 'index followed the track across the move');

// Moving something from after the playhead to before it shifts the index on.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next();                                   // playing T2, index 1
q.move(2, 0);
assert.equal(titles(q), 'T3,T1,T2');
assert.equal(q.current().title, 'T2', 'index still points at the playing track');

// Moving the playing track itself takes the index with it.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next();                                   // playing T2
q.move(1, 2);
assert.equal(q.current().title, 'T2', 'the playing track keeps playing');
assert.equal(q.index, 2);

assert.equal(q.move(-1, 0), null, 'invalid source rejected');
assert.equal(q.move(0, 99), null, 'invalid target rejected');

// Serialised upcoming entries must carry identity, or the client cannot detect
// a shuffle.
q = new Queue();
q.add([track(1), track(2)]);
assert.ok(q.toJSON().upcoming[0].providerId, 'upcoming entries expose providerId');
console.log('move/reorder: 11/11 pass');

// --- insertAt(): dropping a selection between two rows -----------------------
// The queue panel's drop indicator points at a gap between rows, so the tracks
// have to land in that gap - anything else makes the indicator a lie.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next();                                   // playing T2, index 1
q.insertAt(2, [track(8), track(9)]);
assert.equal(titles(q), 'T1,T2,T8,T9,T3', 'tracks land at the requested gap');
assert.equal(q.current().title, 'T2', 'inserting below the playhead leaves it alone');

// Inserting above the playhead must carry the index with it, or playback jumps
// to whichever track slid into the old slot.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next();                                   // playing T2, index 1
q.insertAt(0, [track(8), track(9)]);
assert.equal(titles(q), 'T8,T9,T1,T2,T3');
assert.equal(q.current().title, 'T2', 'index followed the playing track');

// Inserting exactly at the playhead counts as above it: the playing track is
// pushed down, so the index must move too.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next();                                   // playing T2, index 1
q.insertAt(1, track(8));
assert.equal(titles(q), 'T1,T8,T2,T3');
assert.equal(q.current().title, 'T2', 'insert at the playhead does not steal playback');

// A stale position from a client must clamp rather than throw or scatter.
q = new Queue();
q.add([track(1), track(2)]);
assert.equal(q.insertAt(99, track(8)), 2, 'a position past the end clamps to the end');
assert.equal(titles(q), 'T1,T2,T8');
assert.equal(q.insertAt(-5, track(7)), 0, 'a negative position clamps to the start');
assert.equal(titles(q), 'T7,T1,T2,T8');
assert.equal(q.insertAt(0, []), -1, 'an empty batch is a no-op');

// Dropping onto a stopped queue starts from what was dropped, matching add().
q = new Queue();
q.add([track(1), track(2)]);
q.next(); q.next();                         // finished
q.insertAt(0, track(9));
assert.equal(q.current().title, 'T9', 'insert after the end plays the new track');
assert.equal(q.ended, false, 'and clears the finished flag');

// History indices shift too, or previous() steps back to the wrong track.
q = new Queue();
q.add([track(1), track(2), track(3)]);
q.next(); q.next();                         // played T1, T2; now on T3
q.insertAt(0, track(8));                    // everything shifts down one
assert.equal(titles(q), 'T8,T1,T2,T3');
assert.equal(q.previous().title, 'T2', 'history followed the insertion');
assert.equal(q.previous().title, 'T1', 'and stays correct further back');
console.log('insertAt: 15/15 pass');

// --- Play history ------------------------------------------------------------
//
// Read from the play history rather than by walking back from the index, and
// the difference only shows after a jump: what was *played* and what sits above
// the playhead are then two different lists, and only the first is what
// "recently played" means.
{
  const q = new Queue();
  q.add([
    { providerId: 'a', title: 'A' }, { providerId: 'b', title: 'B' },
    { providerId: 'c', title: 'C' }, { providerId: 'd', title: 'D' },
  ]);

  assert.deepEqual(q.recentlyPlayed().map((t) => t.providerId), [],
    'nothing has been played yet');

  q.next(true);            // A -> B
  q.next(true);            // B -> C
  assert.deepEqual(q.recentlyPlayed().map((t) => t.providerId), ['b', 'a'],
    'most recent first');

  q.jumpTo(0);                // back to A, which is a play of A
  assert.equal(q.recentlyPlayed()[0].providerId, 'c',
    'the track jumped away from is the most recent');

  // Positions come back with each entry, or an entry could not be jumped to.
  assert.equal(q.recentlyPlayed()[0].position, 2);

  // Capped, and never the same track twice - a loop would otherwise fill the
  // whole list with one song.
  const looped = new Queue();
  looped.add([{ providerId: 'x', title: 'X' }, { providerId: 'y', title: 'Y' }]);
  for (let i = 0; i < 6; i += 1) looped.next(true);
  const ids = looped.recentlyPlayed().map((t) => t.providerId);
  assert.ok(ids.length <= 3);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');

  // The end of the queue is exactly when history matters most, so the track
  // that just finished has to be in it.
  const ending = new Queue();
  ending.add([{ providerId: 'last', title: 'Last' }]);
  ending.next(true);
  assert.equal(ending.ended, true);
  assert.deepEqual(ending.recentlyPlayed().map((t) => t.providerId), ['last'],
    'the finished track is reachable once the queue has ended');

  assert.ok(Array.isArray(ending.toJSON().played), 'serialised for the client');
  console.log('play history: 8/8 pass (order, positions, dedupe, end of queue)');
}

// --- Shuffle is a toggle on the bar ------------------------------------------
//
// It could only ever light up before: `shuffled` was set true and nothing set
// it false, so the chip stayed on for the rest of the session however many
// times it was pressed. Turning it off has to mean something, which means the
// order before shuffling has to be kept.
{
  const q = new Queue();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  q.add(ids.map((providerId) => ({ providerId, title: providerId })));

  assert.equal(q.toggleShuffle(), true, 'first press shuffles');
  assert.equal(q.shuffled, true);

  assert.equal(q.toggleShuffle(), false, 'second press turns it off');
  assert.equal(q.shuffled, false);
  assert.deepEqual(q.tracks.map((t) => t.providerId), ids, 'the original order is back');

  // Tracks added while shuffled keep their place; tracks removed stay removed.
  q.toggleShuffle();
  q.add([{ providerId: 'g', title: 'g' }]);
  q.remove(q.tracks.findIndex((t) => t.providerId === 'c'));
  q.toggleShuffle();
  const after = q.tracks.map((t) => t.providerId);
  assert.ok(!after.includes('c'), 'a removed track is not resurrected');
  assert.ok(after.includes('g'), 'a track added while shuffled survives');
  assert.equal(new Set(after).size, after.length, 'no duplicates');

  // Whatever is playing keeps playing across a restore.
  const q2 = new Queue();
  q2.add(ids.map((providerId) => ({ providerId, title: providerId })));
  q2.next(true);
  q2.next(true);
  const playing = q2.current().providerId;
  q2.toggleShuffle();
  q2.toggleShuffle();
  assert.equal(q2.current().providerId, playing, 'the playhead follows the music');

  console.log('shuffle toggle: 9/9 pass (restores order, keeps edits, holds the playhead)');
}
