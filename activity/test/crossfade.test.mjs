import assert from 'node:assert/strict';
import { GuildPlayer, transitionArgs, MAX_CROSSFADE_SEC } from '../server/player.js';

// --- The ffmpeg invocation ---------------------------------------------------
// This is the part that is both easy to get subtly wrong and impossible to
// notice going wrong from the outside: a transition with the fade the wrong
// length, or the inputs the wrong way round, still produces audio.
{
  const faded = transitionArgs({
    fromPath: 'a.webm', toPath: 'b.webm', position: 178.5, fade: 6,
  });

  // Order matters to `acrossfade`: it takes the tail of input 0 and the head of
  // input 1. Reversed, every transition would play the end of the *next* track
  // fading into the start of the one already finishing.
  const inputs = faded.reduce(
    (found, arg, i) => (arg === '-i' ? [...found, faded[i + 1]] : found), [],
  );
  assert.deepEqual(inputs, ['a.webm', 'b.webm'], 'the two inputs are the wrong way round');

  const filter = faded[faded.indexOf('-filter_complex') + 1];
  assert.match(filter, /acrossfade=d=6\.000/, 'the fade is not the requested length');
  assert.match(filter, /c1=tri:c2=tri/, 'the fade curves are not equal-gain');

  // -ss must come before its -i or ffmpeg decodes from the start of the file
  // and the transition arrives late by however long the track has been playing.
  assert.ok(faded.indexOf('-ss') < faded.indexOf('-i'),
    'the seek is not an input option, so it decodes the whole track first');
  assert.equal(faded[faded.indexOf('-ss') + 1], '178.5');

  // Raw s16le at 48k stereo, which is what StreamType.Raw promises the player.
  // Anything else is silence or noise, not an error.
  assert.deepEqual(
    faded.slice(faded.indexOf('-f')),
    ['-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
  );

  // Zero is a gapless join, which is a different filter and not a zero-length
  // fade: `acrossfade` rejects d=0.
  const gapless = transitionArgs({
    fromPath: 'a.webm', toPath: 'b.webm', position: 1, fade: 0,
  });
  const gaplessFilter = gapless[gapless.indexOf('-filter_complex') + 1];
  assert.match(gaplessFilter, /concat=n=2:v=0:a=1/, 'a gapless join used a fade');
  assert.doesNotMatch(gaplessFilter, /acrossfade/);

  console.log('transition ffmpeg args: 8/8 pass (input order, fade length, raw output)');
}

// --- The setting -------------------------------------------------------------
{
  const player = new GuildPlayer('g');

  // Off is the absence of a length, not a length of zero: zero is a real
  // setting that joins tracks with no fade.
  assert.equal(player.smoothTransitions, false, 'transitions are on by default');
  assert.equal(player.setCrossfade(0), 0);
  assert.equal(player.smoothTransitions, true, 'a gapless join did not turn joining on');

  assert.equal(player.setCrossfade(6), 6);
  assert.equal(player.setCrossfade(999), MAX_CROSSFADE_SEC, 'the slider ceiling is not enforced');

  assert.equal(player.setCrossfade(null), 0);
  assert.equal(player.smoothTransitions, false, 'null did not turn joining off');
  assert.equal(player.setCrossfade(-1), 0);
  assert.equal(player.smoothTransitions, false, 'the off position did not turn joining off');
  assert.equal(player.setCrossfade(NaN), 0);
  assert.equal(player.smoothTransitions, false, 'a nonsense value left joining on');

  // The snapshot carries the setting so a viewer opening the menu sees where
  // the slider actually is, and distinguishes off from gapless.
  player.setCrossfade(null);
  assert.equal(player.snapshot().crossfadeSec, null);
  player.setCrossfade(0);
  assert.equal(player.snapshot().crossfadeSec, 0, 'gapless is reported as off');

  player.setCrossfade(null);
  console.log('crossfade setting: 11/11 pass (off is not zero, ceiling, snapshot)');
}

// --- Arming ------------------------------------------------------------------
// A track with no known length has no "near the end" to detect. Live streams
// and anything the provider gave no duration for land here, and must not arm a
// watcher that can never fire.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(5);

  player.decks.queue.add({ provider: 'p', providerId: '1', title: 'A', durationSec: 0 });
  player.decks.queue.index = 0;
  player.armTransition();
  assert.equal(player.transitionTimer, null, 'a track with no duration armed a watcher');

  player.decks.queue.tracks[0].durationSec = 200;
  player.armTransition();
  assert.notEqual(player.transitionTimer, null, 'a track with a duration armed nothing');

  // Turning the setting off stops the watcher rather than leaving it spinning.
  player.setCrossfade(null);
  player.armTransition();
  assert.equal(player.transitionTimer, null, 'the watcher survived the setting going off');

  player.cancelTransition();
  console.log('transition arming: 3/3 pass (needs a duration and a setting)');
}

// --- The clock across a track boundary ---------------------------------------
// One resource spans two tracks, which is the part that sounds like it should
// break the position clock. It does not, because the boundary sits at a known
// offset inside the resource - but only if `completeTransition` subtracts it.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(0);
  player.decks.queue.add({ provider: 'p', providerId: '1', title: 'A', durationSec: 200 });
  player.decks.queue.add({ provider: 'p', providerId: '2', title: 'B', durationSec: 180 });
  player.decks.queue.index = 0;

  // A gapless join starts the incoming track after the outgoing tail, so the
  // boundary is 0.4s into the joined resource.
  player.transition = { startsAtSec: 0.4 };
  player.prefetched = { key: 'p:2', path: 'b.webm' };
  player.onTrackStart = () => {};

  player.completeTransition();

  assert.equal(player.queue.current().title, 'B', 'the queue did not move on');
  assert.equal(player.seekOffsetSec, -0.4,
    'the boundary offset was not subtracted, so the new track starts 0.4s ahead of itself');

  // Read through a stand-in rather than by writing to the real AudioPlayer:
  // assigning its `state` runs discord.js's own transition logic, which is not
  // what is under test here.
  const positionWith = (offset, ms) => GuildPlayer.prototype.positionSec.call({
    seekOffsetSec: offset,
    player: { state: { status: 'playing', resource: { playbackDuration: ms } } },
  });

  // 3.4s of the joined resource transmitted is 3.0s into the incoming track.
  assert.ok(Math.abs(positionWith(player.seekOffsetSec, 3400) - 3) < 1e-9,
    `position across the boundary is wrong: ${positionWith(player.seekOffsetSec, 3400)}`);
  // And the instant the boundary is crossed, the new track is at zero.
  assert.ok(Math.abs(positionWith(player.seekOffsetSec, 400)) < 1e-9,
    'the new track did not start from zero');

  // A crossfade has no lead: the incoming track is audible from the first
  // sample, so its zero is the resource's zero.
  const fader = new GuildPlayer('h');
  fader.setCrossfade(8);
  fader.decks.queue.add({ provider: 'p', providerId: '1', title: 'A', durationSec: 200 });
  fader.decks.queue.add({ provider: 'p', providerId: '2', title: 'B', durationSec: 180 });
  fader.decks.queue.index = 0;
  fader.transition = { startsAtSec: 0 };
  fader.prefetched = { key: 'p:2', path: 'b.webm' };
  fader.onTrackStart = () => {};
  fader.completeTransition();
  assert.equal(fader.seekOffsetSec, 0);
  assert.equal(positionWith(fader.seekOffsetSec, 8000), 8,
    'a crossfaded track reports the wrong position');

  // The handover must be cleared once made. `checkTransition` reads a non-null
  // transition as "still waiting to hand over" and returns on every tick, so
  // one left standing here does not merely leak - the next track never arms a
  // transition at all, and every join after the first is a hard cut. That fails
  // silently: the first transition works perfectly and nobody looks again.
  assert.equal(player.transition, null, 'the handover was not cleared once made');
  assert.notEqual(player.transitionTimer, null,
    'no watcher was armed for the track that just came in');

  player.cancelTransition();
  fader.cancelTransition();
  console.log('boundary clock: 7/7 pass (offset subtracted, both join kinds, re-arms)');
}

// --- Cancellation ------------------------------------------------------------
// Anything that changes what is playing invalidates a transition scheduled
// against a track that is no longer the one playing. Left armed, it would
// splice the previous track's successor into whatever was actually asked for.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(5);
  player.decks.queue.add({ provider: 'p', providerId: '1', title: 'A', durationSec: 200 });
  player.decks.queue.index = 0;

  let killed = 0;
  const arm = () => {
    player.armTransition();
    player.transition = { startsAtSec: 0 };
    player.decoder = { kill: () => { killed += 1; } };
  };

  arm();
  player.cancelTransition();
  assert.equal(player.transition, null, 'the transition survived cancellation');
  assert.equal(player.transitionTimer, null, 'the watcher survived cancellation');
  assert.equal(killed, 1, 'the decoder was left running for a track nobody will hear');

  // A skip cancels. Without this the joined stream keeps mixing in the track
  // that *was* next, over the top of the one the user skipped to.
  arm();
  await player.advance(true).catch(() => {});
  assert.equal(player.transition, null, 'a skip left a transition armed');
  assert.equal(killed, 2);

  // Stopping cancels, and drops the prefetched file with it.
  arm();
  player.prefetched = { key: 'p:2', path: 'b.webm' };
  player.stop();
  assert.equal(player.transition, null, 'stopping left a transition armed');
  assert.equal(player.prefetched, null, 'stopping kept a prefetched file');
  assert.equal(killed, 3);

  console.log('transition cancellation: 8/8 pass (cancel, skip, stop)');
}

console.log("crossfade: 37/37 pass");
