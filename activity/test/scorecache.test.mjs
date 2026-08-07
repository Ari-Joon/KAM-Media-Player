import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneScoreCache, scoreVersion } from '../server/scorecache.js';

const directory = await mkdtemp(path.join(tmpdir(), 'kam-scores-'));

try {
  // --- What counts as a score --------------------------------------------------
  // This decides what gets deleted, so it is the part worth being exact about.
  // Audio, favourites and the settings store share the directory, and none of
  // them may ever match.
  assert.equal(scoreVersion('youtube-abc123-a1.4.0.json'), '1.4.0');
  assert.equal(scoreVersion('soundcloud-999-aunknown.json'), 'unknown');
  assert.equal(scoreVersion('favourites.json'), null, 'the favourites store looked like a score');
  assert.equal(scoreVersion('player-settings.json'), null, 'the settings store looked like a score');
  assert.equal(scoreVersion('yt-abc123.m4a'), null, 'an audio file looked like a score');
  assert.equal(scoreVersion('.last-tunnel-host'), null);

  // --- Superseded versions go, the live one stays ------------------------------
  {
    const write = (name, size) => writeFile(path.join(directory, name), 'x'.repeat(size));
    await write('youtube-aaa-a1.1.0.json', 100);
    await write('youtube-aaa-a1.3.0.json', 100);
    await write('youtube-aaa-a1.4.0.json', 100);
    await write('youtube-bbb-a1.3.0.json', 100);
    await write('youtube-bbb-a1.4.0.json', 100);
    // Files that share the directory and must survive untouched.
    await write('favourites.json', 50);
    await write('player-settings.json', 50);
    await write('yt-aaa.m4a', 500);

    const result = await pruneScoreCache(directory, '1.4.0');
    assert.equal(result.staleCount, 3, 'superseded scores were not all removed');
    assert.equal(result.staleBytes, 300);
    assert.equal(result.freed, 0, 'the budget trimmed files it did not need to');

    const left = (await readdir(directory)).sort();
    assert.deepEqual(left, [
      'favourites.json', 'player-settings.json',
      'youtube-aaa-a1.4.0.json', 'youtube-bbb-a1.4.0.json', 'yt-aaa.m4a',
    ], `wrong files survived: ${left.join(', ')}`);
  }

  // --- The budget trims oldest first -------------------------------------------
  {
    const scores = await mkdtemp(path.join(tmpdir(), 'kam-scores-budget-'));
    try {
      // Three live scores of 100 bytes, with distinct modification times.
      for (const [name, ageSec] of [['old', 300], ['mid', 200], ['new', 100]]) {
        const full = path.join(scores, `youtube-${name}-a2.0.0.json`);
        await writeFile(full, 'x'.repeat(100));
        const when = new Date(Date.now() - ageSec * 1000);
        await utimes(full, when, when);
      }

      // A budget of 250 must drop exactly one, and it must be the oldest -
      // modification time rather than access time, because `noatime` mounts
      // stop maintaining the latter and these files are written once.
      const result = await pruneScoreCache(scores, '2.0.0', 250);
      assert.equal(result.freed, 100, 'the budget freed the wrong amount');
      assert.equal(result.liveBytes, 200);

      const left = (await readdir(scores)).sort();
      assert.deepEqual(left, ['youtube-mid-a2.0.0.json', 'youtube-new-a2.0.0.json'],
        `the budget kept the wrong scores: ${left.join(', ')}`);
    } finally {
      await rm(scores, { recursive: true, force: true });
    }
  }

  // --- Nothing to do is not an error -------------------------------------------
  {
    const empty = await mkdtemp(path.join(tmpdir(), 'kam-scores-empty-'));
    try {
      const result = await pruneScoreCache(empty, '1.4.0');
      assert.deepEqual(result, { staleCount: 0, staleBytes: 0, freed: 0, liveBytes: 0 });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    // A directory that is not there at all: this runs at boot, before anything
    // has necessarily created the cache.
    const gone = await pruneScoreCache(path.join(directory, 'nope'), '1.4.0');
    assert.equal(gone.staleCount, 0);
  }

  console.log('score cache: 14/14 pass (superseded dropped, budget by age, neighbours safe)');
} finally {
  await rm(directory, { recursive: true, force: true });
}
