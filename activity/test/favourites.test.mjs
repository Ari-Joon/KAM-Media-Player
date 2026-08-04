import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { Favourites, avatarUrl } from '../server/favourites.js';

const dir = '/tmp/kam-fav-test';
await rm(dir, { recursive: true, force: true });

const track = (n) => ({ provider: 'youtube', providerId: `id${n}`, title: `T${n}`,
  artist: 'A', url: 'u', durationSec: 100 });
const arian = { id: '111', username: 'arian', avatar: 'a1' };
const sam = { id: '222', username: 'sam', avatar: 'b2' };

const store = new Favourites(dir);
await store.load();

// --- multiple users on one track -------------------------------------------
assert.equal(store.add('g1', track(1), arian).added, true, 'first user adds');
assert.equal(store.add('g1', track(1), arian).added, false, 'same user again is a no-op');
assert.equal(store.add('g1', track(1), sam).added, true, 'second user adds to the same track');
assert.equal(store.list('g1').length, 1, 'still one track, not two');
assert.equal(store.list('g1')[0].addedBy.length, 2, 'both users recorded');
console.log('multi-user: 5/5 pass');

// --- per-user membership ----------------------------------------------------
assert.equal(store.has('g1', track(1)), true, 'track is favourited by someone');
assert.equal(store.has('g1', track(1), '111'), true, 'arian favourited it');
assert.equal(store.has('g1', track(1), '999'), false, 'a stranger did not');

// One person un-favouriting must not delete it for the other.
store.remove('g1', 'youtube', 'id1', '111');
assert.equal(store.list('g1').length, 1, 'track survives one user removing it');
assert.equal(store.has('g1', track(1), '111'), false, 'arian no longer has it');
assert.equal(store.has('g1', track(1), '222'), true, 'sam still does');

// The last user leaving removes it entirely.
store.remove('g1', 'youtube', 'id1', '222');
assert.equal(store.list('g1').length, 0, 'empty entry is dropped');
console.log('per-user removal: 6/6 pass');

// --- contributors -----------------------------------------------------------
store.add('g1', track(2), arian);
store.add('g1', track(3), arian);
store.add('g1', track(3), sam);
const people = store.contributors('g1');
assert.equal(people.length, 2);
assert.equal(people[0].username, 'arian', 'busiest contributor first');
assert.equal(people[0].count, 2);
assert.equal(people[1].count, 1);
console.log('contributors: 4/4 pass');

// --- migration from the old single-user shape -------------------------------
// A directory of its own: the store above has writes queued against `dir`, and
// whichever landed last decided whether this fixture survived - which made the
// test fail perhaps one run in three.
const migrationDir = `${dir}-migration`;
await rm(migrationDir, { recursive: true, force: true });
await mkdir(migrationDir, { recursive: true });
await writeFile(`${migrationDir}/favourites.json`, JSON.stringify({
  g9: [{
    provider: 'youtube', providerId: 'old1', title: 'Legacy', artist: 'A',
    durationSec: 60, addedBy: { id: '111', username: 'arian', avatar: 'a1' },
    addedAt: '2026-01-01T00:00:00.000Z',
  }],
}));
const migrated = new Favourites(migrationDir);
await migrated.load();
const legacy = migrated.list('g9')[0];
assert.ok(Array.isArray(legacy.addedBy), 'old single record became a list');
assert.equal(legacy.addedBy[0].username, 'arian', 'attribution survived migration');
assert.equal(migrated.has('g9', { provider: 'youtube', providerId: 'old1' }, '111'), true,
  'migrated entry is still owned by its user');
console.log('migration: 3/3 pass');

// --- avatars ----------------------------------------------------------------
assert.ok(avatarUrl(arian).includes('a1'));
assert.ok(avatarUrl({ id: '1532123802216169734', avatar: null }).includes('embed/avatars/'));
assert.equal(avatarUrl(null), null);
console.log('avatars: 3/3 pass');

await store.persist();
await migrated.persist();
await rm(dir, { recursive: true, force: true });
await rm(migrationDir, { recursive: true, force: true });
await rm(migrationDir, { recursive: true, force: true });
