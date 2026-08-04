import assert from 'node:assert/strict';
import { DeckSet, MAX_DECKS } from '../server/decks.js';

const track = (n) => ({ title: `T${n}`, providerId: `id${n}`, durationSec: 100 });

// --- creation and limits ----------------------------------------------------
let set = new DeckSet();
assert.equal(set.decks.length, 1, 'starts with one deck');
assert.equal(set.active.name, 'Main');
set.create('House', 'arian');
set.create('Rap', 'sam');
assert.equal(set.decks.length, 3);
assert.throws(() => set.create('Fourth'), /Only 3 playlists/, 'enforces the limit');
console.log(`creation: 5/5 pass (max ${MAX_DECKS})`);

// --- independence -----------------------------------------------------------
set = new DeckSet();
set.create('B');
set.decks[0].queue.add([track(1), track(2)]);
set.decks[1].queue.add([track(3)]);
assert.equal(set.decks[0].queue.length, 2, 'decks hold separate tracks');
assert.equal(set.decks[1].queue.length, 1);
assert.equal(set.totalTracks, 3);

// Loop and shuffle state must not leak between decks.
set.decks[0].queue.setLoop('queue');
assert.equal(set.decks[1].queue.loop, 'off', 'loop mode is per deck');
set.decks[0].queue.shuffle();
assert.equal(set.decks[1].queue.shuffled, false, 'shuffle state is per deck');
console.log('independence: 5/5 pass');

// --- switching --------------------------------------------------------------
set = new DeckSet();
set.create('B');
set.decks[0].queue.add([track(1)]);
set.decks[1].queue.add([track(2)]);
assert.equal(set.queue.current().title, 'T1', 'active deck feeds playback');
set.switchTo(1);
assert.equal(set.queue.current().title, 'T2', 'switch changes the active queue');
assert.equal(set.switchTo(9), null, 'out-of-range switch is rejected');
assert.equal(set.activeIndex, 1, 'a rejected switch leaves the active deck alone');
console.log('switching: 4/4 pass');

// --- resolve by index or name ----------------------------------------------
set = new DeckSet('Main');
set.create('House Set');
assert.equal(set.resolve(0).name, 'Main');
assert.equal(set.resolve('1').name, 'House Set', 'numeric strings resolve by index');
assert.equal(set.resolve('house set').name, 'House Set', 'name match is case-insensitive');
assert.equal(set.resolve(null).name, 'Main', 'null resolves to the active deck');
assert.equal(set.resolve('nope'), null);
console.log('resolve: 5/5 pass');

// --- removal ----------------------------------------------------------------
set = new DeckSet();
set.create('B'); set.create('C');
set.switchTo(2);
set.remove(0);
assert.equal(set.decks.length, 2);
assert.equal(set.activeIndex, 1, 'removing an earlier deck shifts the active index');
set.remove(1); set.remove(0);
assert.equal(set.decks.length, 1, 'the last deck is never removed');
set.decks[0].queue.add(track(1));
assert.equal(set.remove(0), false, 'removing the last deck clears it instead');
assert.equal(set.decks[0].queue.length, 0);
console.log('removal: 5/5 pass');

// --- finding somewhere to continue ------------------------------------------
set = new DeckSet();
set.create('B'); set.create('C');
assert.equal(set.nextNonEmpty(), null, 'nothing to continue to when all are empty');
set.decks[2].queue.add([track(1), track(2)]);
assert.equal(set.nextNonEmpty(), 2, 'finds a deck with upcoming tracks');
console.log('continuation: 2/2 pass');

// --- serialisation ----------------------------------------------------------
set = new DeckSet('Main');
set.create('House', 'arian');
set.decks[0].queue.add([track(1), track(2)]);
const json = set.toJSON();
assert.equal(json.decks.length, 2);
assert.equal(json.decks[0].active, true);
assert.equal(json.decks[1].createdBy, 'arian', 'attribution survives serialisation');
assert.equal(json.decks[0].total, 2);
assert.equal(json.maxDecks, 3);
console.log('serialisation: 5/5 pass');

// --- A finished deck must not be its own continuation ------------------------
// Regression: nextNonEmpty() wrapped all the way round to the active deck, so a
// single-track deck endlessly offered itself as somewhere to continue.
set = new DeckSet();
set.decks[0].queue.add(track(1));
set.decks[0].queue.next();                 // played out
assert.equal(set.nextNonEmpty(), null, 'a lone finished deck offers no continuation');

// With a second deck holding tracks, continuation is correct.
set = new DeckSet();
set.create('B');
set.decks[0].queue.add(track(1));
set.decks[0].queue.next();
set.decks[1].queue.add([track(2), track(3)]);
assert.equal(set.nextNonEmpty(), 1, 'another deck with tracks is found');

// And an empty second deck must not be offered.
set = new DeckSet();
set.create('B');
set.decks[0].queue.add(track(1));
set.decks[0].queue.next();
assert.equal(set.nextNonEmpty(), null, 'empty decks are skipped');
console.log('self-continuation regression: 3/3 pass');
