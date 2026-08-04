import assert from 'node:assert/strict';
import { ByteBoundedCache } from '../server/cache.js';

// A controllable clock, for the same reason the renderer tests use one: TTL
// behaviour driven by the wall clock is either untestable or slow.
let now = 0;
const make = (options) => new ByteBoundedCache({
  sizeOf: (value) => value.length,
  now: () => now,
  ...options,
});

// --- Basic storage ---------------------------------------------------------
const basic = make({ maxBytes: 100 });
assert.equal(basic.get('missing'), null, 'an absent key must not be a hit');
basic.set('a', 'x'.repeat(10));
assert.equal(basic.get('a').length, 10, 'stored value did not come back');
assert.equal(basic.bytes, 10, 'byte accounting is wrong after one store');
assert.equal(basic.size, 1);

// Re-storing a key must replace it, not double-count its bytes. Getting this
// wrong lets the tracked total drift above the real one until the cache
// evicts everything and never serves a hit again.
basic.set('a', 'y'.repeat(30));
assert.equal(basic.bytes, 30, 're-storing a key double-counted its bytes');
assert.equal(basic.size, 1, 're-storing a key created a second entry');

// --- Eviction --------------------------------------------------------------
const evicting = make({ maxBytes: 100 });
evicting.set('a', 'a'.repeat(40));
evicting.set('b', 'b'.repeat(40));
evicting.set('c', 'c'.repeat(40));
assert.equal(evicting.size, 2, 'budget was exceeded without evicting');
assert.ok(evicting.bytes <= 100, `budget overrun: ${evicting.bytes}`);
assert.equal(evicting.get('a'), null, 'the oldest entry should have gone first');
assert.ok(evicting.get('c'), 'the newest entry must survive its own store');

// Eviction is least-recently-USED, not least-recently-stored: touching an old
// entry must protect it. Without this a burst of one-off avatars would evict
// the cover art shown on every panel open.
const lru = make({ maxBytes: 100 });
lru.set('a', 'a'.repeat(40));
lru.set('b', 'b'.repeat(40));
lru.get('a');
lru.set('c', 'c'.repeat(40));
assert.ok(lru.get('a'), 'a recently used entry was evicted');
assert.equal(lru.get('b'), null, 'the least recently used entry should have gone');

// An entry larger than the whole budget is still served at least once, rather
// than being stored and immediately thrown away.
const oversized = make({ maxBytes: 10 });
oversized.set('big', 'x'.repeat(50));
assert.ok(oversized.get('big'), 'an oversized entry evicted itself');

// --- Expiry ----------------------------------------------------------------
const expiring = make({ maxBytes: 100, ttlMs: 1000 });
expiring.set('a', 'a'.repeat(10));
now = 999;
assert.ok(expiring.get('a'), 'entry expired early');
now = 1001;
assert.equal(expiring.get('a'), null, 'entry outlived its TTL');
assert.equal(expiring.bytes, 0, 'expiry did not reclaim the bytes');
assert.equal(expiring.size, 0, 'expiry did not remove the entry');

// No TTL means never expiring, which is what the score cache relies on: a
// changed score arrives under a different scoreId rather than replacing one.
const permanent = make({ maxBytes: 100 });
permanent.set('a', 'a'.repeat(10));
now = 1e12;
assert.ok(permanent.get('a'), 'an entry without a TTL expired');

console.log('response cache: 14/14 pass (byte budget, LRU order, expiry)');
