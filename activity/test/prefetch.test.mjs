import assert from 'node:assert/strict';
import { GuildPlayer } from '../server/player.js';

/**
 * Fetching the next track ahead of time.
 *
 * Skipping used to cost a whole download before the control endpoint could
 * answer, because advancing starts the next track and starting a track is what
 * fetches it. These check the scheduling, not the download: that the right
 * track is fetched, that it happens once, and that a failure is harmless.
 */
const track = (n) => ({
  provider: 'youtube', providerId: `id${n}`, title: `T${n}`,
  url: `https://example.invalid/${n}`, durationSec: 100,
});

// --- it fetches the NEXT track, not the one playing -------------------------
{
  const player = new GuildPlayer('g1');
  const asked = [];
  player.loadAudio = async (t) => { asked.push(t.providerId); return `/tmp/${t.providerId}.m4a`; };
  player.queue.add([track(1), track(2), track(3)]);

  player.prefetchUpcoming();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['id2'], 'the track after the current one is fetched');
}

// --- it does not start the same fetch twice ---------------------------------
{
  const player = new GuildPlayer('g2');
  const asked = [];
  let release;
  const pending = new Promise((r) => { release = r; });
  player.loadAudio = async (t) => { asked.push(t.providerId); await pending; return 'x'; };
  player.queue.add([track(1), track(2)]);

  // `startCurrent` runs on every track change, so this is called repeatedly;
  // without the guard a long queue would have several downloads in flight.
  player.prefetchUpcoming();
  player.prefetchUpcoming();
  player.prefetchUpcoming();
  assert.deepEqual(asked, ['id2'], `one fetch, not ${asked.length}`);

  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Once it has settled the guard clears, so a later track can be fetched.
  player.queue.next(true);
  player.prefetchUpcoming();
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 1, 'nothing upcoming after the last track');
}

// --- a failed prefetch is swallowed -----------------------------------------
{
  const player = new GuildPlayer('g3');
  player.loadAudio = async () => { throw new Error('yt-dlp exploded'); };
  player.queue.add([track(1), track(2)]);
  player.prefetchUpcoming();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(player.prefetching, null, 'the guard is released after a failure');
}

// --- nothing to do cases ----------------------------------------------------
{
  const player = new GuildPlayer('g4');
  let called = 0;
  player.loadAudio = async () => { called++; return 'x'; };
  // Nothing queued at all.
  player.prefetchUpcoming();
  // Only the current track, nothing after it.
  player.queue.add(track(1));
  player.prefetchUpcoming();
  await new Promise((r) => setImmediate(r));
  assert.equal(called, 0, 'nothing is fetched when there is no next track');
}

// --- releaseAudio keeps the file, so going back is free ---------------------
{
  const player = new GuildPlayer('g5');
  player.audioPath = '/tmp/kept.m4a';
  player.releaseAudio();
  assert.equal(player.audioPath, null, 'the player lets go of the path');
  // The file itself is left for the cache to manage; deleting it here is what
  // made every "previous" re-download a track that was on disk seconds earlier.
}
console.log('prefetch: 6/6 pass (fetches the next track, once, and fails quietly)');
