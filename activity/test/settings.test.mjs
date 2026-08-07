import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlayerSettings } from '../server/settings.js';
import { GuildPlayer } from '../server/player.js';

const directory = await mkdtemp(path.join(tmpdir(), 'kam-settings-'));

try {
  // --- Round trip ------------------------------------------------------------
  {
    const store = new PlayerSettings(directory);
    await store.load();
    assert.deepEqual(store.get('g'), {}, 'a guild with no settings is not empty');

    await store.set('g', 'crossfadeSec', 6);
    await store.set('h', 'crossfadeSec', 0);

    // A second instance reads what the first wrote, which is the whole point:
    // the restart is what this exists to survive.
    const reopened = new PlayerSettings(directory);
    await reopened.load();
    assert.equal(reopened.get('g').crossfadeSec, 6, 'the setting did not survive a reload');
    // Zero is a real setting - a gapless join - and must not be lost to a
    // falsy check anywhere between here and the player.
    assert.equal(reopened.get('h').crossfadeSec, 0, 'a gapless join was not stored');
    assert.deepEqual(reopened.get('nobody'), {});

    // Guilds do not tread on each other.
    await reopened.set('g', 'crossfadeSec', 9);
    assert.equal(reopened.get('h').crossfadeSec, 0, 'one guild overwrote another');
  }

  // --- Turning it off --------------------------------------------------------
  // Off is what a fresh player already is, so it removes the key rather than
  // storing a value. Writing "off" and writing nothing must apply identically,
  // and a guild that has never chosen anything should not gain a record.
  {
    const store = new PlayerSettings(directory);
    await store.load();
    await store.set('g', 'crossfadeSec', null);
    assert.equal(store.get('g').crossfadeSec, undefined, 'off left a value behind');

    const raw = JSON.parse(await readFile(path.join(directory, 'player-settings.json'), 'utf8'));
    assert.ok(!('crossfadeSec' in (raw.g ?? {})), 'off was written to disk anyway');
  }

  // --- Applied to a player ---------------------------------------------------
  // The store holds a number; what matters is that the player ends up in the
  // state that number describes, including the on/off flag the number alone
  // does not carry.
  {
    const store = new PlayerSettings(directory);
    await store.load();
    await store.set('g', 'crossfadeSec', 7);

    const player = new GuildPlayer('g');
    assert.equal(player.smoothTransitions, false, 'a fresh player starts with transitions on');

    const stored = store.get('g');
    if (stored.crossfadeSec !== undefined) player.setCrossfade(stored.crossfadeSec);
    assert.equal(player.crossfadeSec, 7);
    assert.equal(player.smoothTransitions, true, 'a stored length did not turn joining on');
    assert.equal(player.snapshot().crossfadeSec, 7, 'the slider would not show the stored value');

    // And a stored gapless join, which is the case a falsy check breaks.
    await store.set('g', 'crossfadeSec', 0);
    const gapless = new GuildPlayer('g2');
    const value = store.get('g').crossfadeSec;
    if (value !== undefined) gapless.setCrossfade(value);
    assert.equal(gapless.smoothTransitions, true,
      'a stored gapless join was read as no setting at all');
    assert.equal(gapless.snapshot().crossfadeSec, 0);

    player.cancelTransition();
    gapless.cancelTransition();
  }

  // --- A corrupt store is not a failed boot ---------------------------------
  // These are conveniences. Losing them costs one slider being re-set, which is
  // not worth refusing to start the server over.
  {
    await writeFile(path.join(directory, 'player-settings.json'), '{ not json');
    const store = new PlayerSettings(directory);
    await store.load();
    assert.deepEqual(store.get('g'), {}, 'a corrupt store was not treated as empty');
  }

  console.log('player settings: 13/13 pass (round trip, off removes, applied to a player)');
} finally {
  await rm(directory, { recursive: true, force: true });
}
