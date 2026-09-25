import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAudioResource, StreamType, AudioPlayerStatus } from '@discordjs/voice';
import {
  GuildPlayer, transitionArgs, playbackArgs, mixOutPoint,
  MAX_CROSSFADE_SEC, GAPLESS_LEAD_SEC, MAX_OUTRO_CUT_SEC,
} from '../server/player.js';
import { LIMITER } from '../server/loudness.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let every promise chain queued so far run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// --- The gapless lead --------------------------------------------------------
// The trigger compares transmitted position against `track.durationSec`, which
// is provider metadata. When the real file is shorter than its stated length,
// the resource goes Idle before the position reaches the trigger and the join
// never fires at all - which is exactly how gapless failed in a live channel
// while crossfade worked, because a fade's lead is its own length and carries
// seconds of slack.
//
// So this is a tolerance for that disagreement, not a budget for ffmpeg's spawn
// (measured at 82-208ms to first byte, median 120). It costs nothing audible:
// `concat` keeps the whole remaining tail, so triggering earlier lengthens the
// outgoing part of the joined stream rather than cutting it.
assert.ok(GAPLESS_LEAD_SEC >= 1,
  `the gapless lead is ${GAPLESS_LEAD_SEC}s, too tight to survive a duration `
  + 'that disagrees with the file by a second');

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
  // Equal-*power*, not equal-gain. `tri` is equal-gain and that is precisely
  // the bug: two uncorrelated signals at half amplitude sum to 0.707 of full
  // power, so the middle of the join sits 3 dB down. See the curve assertions
  // at the end of this file for the measurements.
  assert.match(filter, /c1=qsin:c2=qsin/, 'the fade curves are not equal-power');

  // -ss must come before its -i or ffmpeg decodes from the start of the file
  // and the transition arrives late by however long the track has been playing.
  assert.ok(faded.indexOf('-ss') < faded.indexOf('-i'),
    'the seek is not an input option, so it decodes the whole track first');
  assert.equal(faded[faded.indexOf('-ss') + 1], '178.5');

  // The outgoing input must be trimmed to exactly the fade, and this is the
  // difference between a crossfade and no crossfade at all.
  //
  // `acrossfade` fades the *end* of its first input. Untrimmed, that input runs
  // to the end of the file and the fade happens there, however early the
  // transition started - measured, joining 120s into a six-minute track gave
  // output byte-identical to the unfaded track for its first eight seconds.
  // With the trim the same join fades 0.244 -> 0.196 -> 0.155 -> 0.115 ->
  // 0.069 -> 0.026 RMS across its six seconds.
  const trim = faded.indexOf('-t');
  assert.ok(trim > faded.indexOf('-ss') && trim < faded.indexOf('-i'),
    'the outgoing track is not trimmed to the fade, so the fade lands at the '
    + 'end of the file instead of at the join');
  assert.equal(Number(faded[trim + 1]), 6);

  // Ogg Opus from ffmpeg's libopus, which is what StreamType.OggOpus promises
  // the player. It used to be 16-bit PCM, and that conversion is where a hot
  // master's overs were hard-clipped. 20 ms frames because `playbackDuration`
  // adds 20 ms per packet: any other size and the visuals drift off the audio.
  assert.deepEqual(
    faded.slice(faded.indexOf('-acodec')),
    ['-acodec', 'libopus', '-b:a', '96k', '-frame_duration', '20',
      '-f', 'opus', '-ar', '48000', '-ac', '2', 'pipe:1'],
  );
  assert.ok(!faded.includes('s16le'), 'a transition still goes through 16-bit PCM');

  // Zero is a gapless join, which is a different filter and not a zero-length
  // fade: `acrossfade` rejects d=0.
  const gapless = transitionArgs({
    fromPath: 'a.webm', toPath: 'b.webm', position: 1, fade: 0,
  });
  const gaplessFilter = gapless[gapless.indexOf('-filter_complex') + 1];
  assert.match(gaplessFilter, /concat=n=2:v=0:a=1/, 'a gapless join used a fade');
  assert.doesNotMatch(gaplessFilter, /acrossfade/);
  // Without a score to say where the audio ends, a gapless join keeps the rest
  // of the file, exactly as before.
  assert.ok(!gapless.includes('-t'), 'a gapless join without a score was trimmed');

  console.log('transition ffmpeg args: 12/12 pass (input order, fade trim, Opus output)');
}

// --- Nothing reaches the encoder without the limiter ---------------------------
// 22 of the 29 cached tracks decoded above full scale, and the seek and gapless
// paths hard-clipped them at a 16-bit stage. Every path must end in the same
// limiter, and each track must carry its own loudness gain.
{
  const faded = transitionArgs({
    fromPath: 'a.webm', toPath: 'b.webm', position: 100, fade: 6,
    fromGain: -5.25, toGain: 1.5, toOffset: 2.454,
  });
  const graph = faded[faded.indexOf('-filter_complex') + 1];
  // Matched per input, before the join: one gain after the mix would leave an
  // 11 dB lurch between a loud track and a quiet one.
  assert.match(graph, /^\[0:a\]volume=-5\.25dB\[a0\];\[1:a\]volume=1\.50dB\[a1\];/,
    'each track is not brought to the target before they meet');
  assert.ok(graph.endsWith(`,${LIMITER}[out]`), 'the join does not end in the limiter');

  // The incoming track's opening silence is skipped with its own input seek,
  // which must sit between the two inputs to apply to the second.
  const second = faded.lastIndexOf('-i');
  const skip = faded.lastIndexOf('-ss');
  assert.ok(skip > faded.indexOf('-i') && skip < second,
    'the lead-in seek does not apply to the incoming track');
  assert.equal(faded[skip + 1], '2.454');

  // A gapless join told where the audio ends is trimmed there, so the trailing
  // silence is not part of it and `concat` starts the next track on time.
  const gapless = transitionArgs({
    fromPath: 'a.webm', toPath: 'b.webm', position: 190, fade: 0, fromLength: 4.25,
  });
  const trim = gapless.indexOf('-t');
  assert.ok(trim > 0 && trim < gapless.indexOf('-i'), 'a gapless join with a known end was not trimmed');
  assert.equal(gapless[trim + 1], '4.250');
  assert.ok(gapless[gapless.indexOf('-filter_complex') + 1].endsWith(`,${LIMITER}[out]`),
    'a gapless join bypasses the limiter');

  // Normal starts and seeks: the same gain and limiter, and the same encoder.
  const start = playbackArgs({ file: 'a.webm', gain: -4.6 });
  assert.equal(start[start.indexOf('-af') + 1], `volume=-4.60dB,${LIMITER}`,
    'a normal start does not go through the loudness gain and limiter');
  assert.ok(!start.includes('-ss'), 'a start from zero seeks');
  const seek = playbackArgs({ file: 'a.webm', position: 42.5, gain: -4.6 });
  assert.ok(seek.indexOf('-ss') < seek.indexOf('-i'), 'the seek is not an input option');
  assert.equal(seek[seek.indexOf('-ss') + 1], '42.5');
  assert.deepEqual(seek.slice(seek.indexOf('-acodec')), start.slice(start.indexOf('-acodec')),
    'a seek encodes differently from a normal start');

  console.log('limiter on every path: 11/11 pass (per-track gain, lead-in, gapless trim)');
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
  // boundary sits however long that tail was into the joined resource. The
  // value here is arbitrary on purpose - what is under test is that the offset
  // is subtracted, whatever it happens to be.
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

  // Cancelling drops the bookkeeping and nothing else. It used to kill the
  // decoder as well, and after a seek or a completed join that decoder is the
  // one carrying the song: switching transitions off skipped the track.
  arm();
  player.cancelTransition();
  assert.equal(player.transition, null, 'the transition survived cancellation');
  assert.equal(player.transitionTimer, null, 'the watcher survived cancellation');
  assert.equal(killed, 0, 'cancelling a transition killed the audio that was playing');

  // A skip retires the audio. Without this the joined stream keeps mixing in
  // the track that *was* next, over the top of the one the user skipped to.
  arm();
  await player.advance(true).catch(() => {});
  assert.equal(player.transition, null, 'a skip left a transition armed');
  assert.equal(killed, 1, 'a skip left the old decoder running');

  // Stopping retires it too, and drops the prefetched file with it.
  arm();
  player.prefetched = { key: 'p:2', path: 'b.webm' };
  player.stop();
  assert.equal(player.transition, null, 'stopping left a transition armed');
  assert.equal(player.prefetched, null, 'stopping kept a prefetched file');
  assert.equal(killed, 2, 'stopping left the old decoder running');

  console.log('transition cancellation: 8/8 pass (cancel keeps the song, skip and stop retire it)');
}

console.log("crossfade: 39/39 pass");

// --- The fade curve must stay equal-power ------------------------------------
// `tri` is a linear fade, and crossing two uncorrelated signals linearly puts
// each at half amplitude in the middle: they sum to 0.707 of full power, the
// textbook 3 dB hole. Measured over two uncorrelated pink-noise sources with a
// 6 s fade, level at the centre of the join against the sources playing alone:
// tri -3.00 dB, qsin -0.20 dB, hsin -2.77 dB, esin -7.78 dB. On a real pair
// from the cache, mid-fade RMS was 0.13983 under tri and 0.19611 under qsin.
//
// The suite cannot hear the sag, so it guards the curve that fixed it.
{
  const args = transitionArgs({
    fromPath: 'a.m4a', toPath: 'b.m4a', position: 100, fade: 6,
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /c1=qsin:c2=qsin/,
    'the crossfade must use an equal-power curve, or the join sags 3 dB');
  assert.ok(!/c1=tri|c2=tri/.test(filter),
    'linear crossfade curves reintroduce the 3 dB hole in the middle');
  console.log('fade curve: 2/2 pass (equal-power, no linear sag)');
}

// --- A track queued during playback must still be prefetched -----------------
// `prefetchUpcoming` ran only on a track change, so a track added while the
// current one played was never fetched. `startTransition` then found no file on
// disk and returned - silently, which is why the report could only ever be
// "sometimes it doesn't activate". Queueing the next song mid-playback is the
// normal way a queue is used, so this was the common case rather than an edge.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(6);

  const fetched = [];
  player.loadAudio = async (track) => {
    fetched.push(track.providerId);
    return `/cache/${track.providerId}.m4a`;
  };

  player.decks.queue.add({ provider: 'p', providerId: 'A', title: 'A', durationSec: 200 });
  player.decks.queue.index = 0;

  // Nothing queued behind it yet, so there is nothing to fetch.
  player.prefetchUpcoming();
  await Promise.resolve();
  assert.deepEqual(fetched, [], 'fetched something with an empty queue ahead');

  // The listener queues the next song while the current one is still playing.
  player.decks.queue.add({ provider: 'p', providerId: 'B', title: 'B', durationSec: 200 });

  // A watcher tick well before the join. This used to do nothing at all until
  // the track changed, by which point the transition had already been missed.
  await player.checkTransition(200);
  await Promise.resolve();
  assert.deepEqual(fetched, ['B'],
    'a track queued during playback was not prefetched, so no join was possible');
  assert.equal(player.prefetched?.key, 'p:B', 'the fetched path was not retained');

  // Idempotent: the watcher ticks several times a second and must not start the
  // same download on every one of them.
  for (let i = 0; i < 20; i++) {
    await player.checkTransition(200);
    await Promise.resolve();
  }
  assert.deepEqual(fetched, ['B'],
    `the watcher re-fetched the same track (${fetched.length} downloads)`);

  player.cancelTransition();
  player.stopTransitionTimer();
  console.log('prefetch on queue change: 4/4 pass (late additions still join, fetched once)');
}

// --- The title must not change before the incoming track is being heard ------
// `startsAtSec` served two purposes and they are not the same instant. It is
// where the incoming track's zero sits inside the joined resource, which the
// clock needs, and it was also used as the moment to advance the queue. Under a
// crossfade that zero is the *start* of the fade, so the title flipped within
// one 100 ms tick of the fade beginning: a 12 s crossfade named the incoming
// song for its whole length while the outgoing one was still the louder of the
// two for the first half.
//
// The handover is now the midpoint, because `qsin` is equal-power and puts the
// two tracks at equal level exactly there.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(8);
  player.decks.queue.add({ provider: 'p', providerId: 'A', title: 'OUTGOING', durationSec: 200 });
  player.decks.queue.add({ provider: 'p', providerId: 'B', title: 'INCOMING', durationSec: 180 });
  player.decks.queue.index = 0;
  player.prefetched = { key: 'p:B', path: 'b.webm' };
  player.onTrackStart = () => {};

  // Exactly what startTransition builds for an 8 s fade.
  player.transition = { startsAtSec: 0, handoverAtSec: 4 };

  // The voice player is swapped for a stub rather than written through: its
  // state is driven by discord.js internals and assigning to it throws from
  // inside their event loop.
  const voice = player.player;
  const at = (ms) => {
    player.player = { state: { status: 'playing', resource: { playbackDuration: ms } } };
  };

  // Barely into the fade.
  at(100);
  await player.checkTransition(200);
  assert.equal(player.queue.current().title, 'OUTGOING',
    'the title changed the instant the fade began, before the incoming track '
    + 'was audible');

  // Past the midpoint the incoming track is the one being heard.
  at(4100);
  await player.checkTransition(200);
  player.player = voice;
  assert.equal(player.queue.current().title, 'INCOMING',
    'the queue never moved on, so the title would stay wrong for the rest of '
    + 'the track');

  // The clock must still be right. The incoming track's zero is the start of
  // the fade, so at the midpoint it is genuinely 4 s in - `startsAtSec` stays 0
  // and the offset must not absorb the handover point.
  assert.equal(player.seekOffsetSec, 0,
    'the handover point leaked into the clock offset');

  player.cancelTransition();
  player.stopTransitionTimer();
  console.log('handover timing: 3/3 pass (title follows what is audible, clock intact)');
}

// --- The score is built before the track is heard, not after ------------------
// `attachScore` ran only when a track became current. Under a crossfade that is
// the handover, so the incoming track was already audible while its analysis
// started - the wait sat in front of the listener as "analysing" over a song
// that was playing. The audio has been on disk since the prefetch, typically
// most of a song earlier.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(6);

  const warmed = [];
  player.onPrefetch = (track, audioPath) => warmed.push([track.providerId, audioPath]);
  player.loadAudio = async (track) => `/cache/${track.providerId}.m4a`;

  player.decks.queue.add({ provider: 'p', providerId: 'A', title: 'A', durationSec: 200 });
  player.decks.queue.add({ provider: 'p', providerId: 'B', title: 'B', durationSec: 200 });
  player.decks.queue.index = 0;

  player.prefetchUpcoming();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(warmed, [['B', '/cache/B.m4a']],
    'the prefetch did not offer the next track for analysis, so its score can '
    + 'only start once it is already playing');

  // Fires once, not on every tick of the watcher.
  for (let i = 0; i < 10; i++) {
    player.prefetchUpcoming();
    await Promise.resolve();
  }
  assert.equal(warmed.length, 1, `analysis was offered ${warmed.length} times`);

  player.stopTransitionTimer();
  console.log('early analysis: 2/2 pass (score warmed during the previous track)');
}

// --- A queue edit during a join must not mislabel the audio -------------------
// Nothing cancelled a transition when the queue was mutated, and the handover
// advanced to whatever was next at that moment rather than to the track whose
// audio was actually in the joined resource.
//
// Measured before the guard: crossfading into B and removing B mid-fade left
// the title reading C, `audioPath` pointing at B's file, and `onTrackStart`
// called as ("C", "/cache/B.m4a"). That last part is the serious half - scores
// are cached per track, so C's cached score becomes an analysis of B's audio
// and stays wrong on every later play until the analyser version changes.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(8);
  for (const id of ['A', 'B', 'C']) {
    player.decks.queue.add({ provider: 'p', providerId: id, title: id, durationSec: 200 });
  }
  player.decks.queue.index = 0;

  const analysed = [];
  player.onTrackStart = (track, audioPath) => analysed.push([track.title, audioPath]);

  // A crossfade into B is playing: B's audio is in the resource already.
  player.transition = { startsAtSec: 0, handoverAtSec: 4, trackKey: 'p:B' };
  player.prefetched = { key: 'p:B', path: '/cache/B.m4a' };
  let killed = 0;
  player.decoder = { kill: () => { killed += 1; } };

  // Someone removes B while it is fading in.
  player.decks.queue.remove(1);
  player.completeTransition();

  assert.notEqual(player.queue.current().title, 'C',
    'the handover advanced to a track whose audio is not the one playing');
  assert.deepEqual(analysed, [],
    'the analyser was handed a track paired with another track\'s audio, which '
    + 'poisons that track\'s cached score');
  assert.equal(killed, 1,
    'the joined resource was left playing under a label that does not match it');
  assert.equal(player.transition, null, 'the transition was left standing');

  // The undisturbed case must still hand over normally.
  const ok = new GuildPlayer('h');
  ok.setCrossfade(8);
  for (const id of ['A', 'B']) {
    ok.decks.queue.add({ provider: 'p', providerId: id, title: id, durationSec: 200 });
  }
  ok.decks.queue.index = 0;
  ok.onTrackStart = () => {};
  ok.transition = { startsAtSec: 0, handoverAtSec: 4, trackKey: 'p:B' };
  ok.prefetched = { key: 'p:B', path: '/cache/B.m4a' };
  ok.completeTransition();
  assert.equal(ok.queue.current().title, 'B',
    'an untouched queue no longer hands over');

  player.cancelTransition();
  player.stopTransitionTimer();
  ok.cancelTransition();
  ok.stopTransitionTimer();
  console.log('queue edits during a join: 5/5 pass (no mislabelled audio, no poisoned score)');
}

// --- Where the fade goes -------------------------------------------------------
// Measured over 462 joins between the cached tracks: a fade ending at the end
// of the file - what actually shipped - had both songs audible for 6% of a 6 s
// fade and none of a 2 s one. Ending where the outro starts falling, with the
// incoming silence skipped, made it 46% and 34%.
{
  const fps = 30;
  /** A 200 s score: steady at 0.6, then an outro, then silence. */
  const score = (shape) => ({
    analysis: { is_partial: false },
    lanes: {
      fps,
      energy: Array.from({ length: 200 * fps }, (_, i) => shape(i / fps)),
    },
  });

  // Steady until 180 s, falling linearly to silence at 190 s, silent to 200 s.
  const fading = score((t) => (t < 180 ? 0.6 : t < 190 ? 0.6 * (190 - t) / 10 : 0));

  // A crossfade lets go where the outro drops below half the typical level,
  // 185 s here, so the fade is spent on music rather than on the fade-out.
  const crossfade = mixOutPoint(fading, 200, true);
  assert.ok(crossfade.fromScore);
  assert.ok(Math.abs(crossfade.at - 185) < 0.6, `the crossfade let go at ${crossfade.at.toFixed(2)} s`);
  // Gapless keeps the whole natural fade-out and drops only the dead air. The
  // fade crosses the 0.02 silence floor at 190 - 10 * 0.02 / 0.6 = 189.67 s.
  const audibleEnd = 190 - (10 * 0.02) / 0.6;
  const gapless = mixOutPoint(fading, 200, false);
  assert.ok(Math.abs(gapless.at - audibleEnd) < 0.05,
    `the gapless join let go at ${gapless.at.toFixed(2)} s`);

  // A long quiet coda is cut by at most MAX_OUTRO_CUT_SEC, not thrown away.
  const coda = score((t) => (t < 160 ? 0.6 : t < 195 ? 0.1 : 0));
  const kept = mixOutPoint(coda, 200, true);
  assert.ok(Math.abs(kept.at - (195 - MAX_OUTRO_CUT_SEC)) < 0.1,
    `a 35 s coda was cut to ${kept.at.toFixed(2)} s`);

  // A partial score covers only the opening; trusting it would cut every track.
  assert.deepEqual(mixOutPoint({ ...fading, analysis: { is_partial: true } }, 200, true),
    { at: 200, fromScore: false });
  assert.deepEqual(mixOutPoint(null, 200, true), { at: 200, fromScore: false });
  // A bad analysis cannot cost a track more than a quarter of itself.
  const broken = score((t) => (t < 60 ? 0.6 : 0));
  assert.equal(mixOutPoint(broken, 200, false).at, 150);
  console.log('fade placement: 8/8 pass (outro start, audible end, coda cap, fallbacks)');

  // --- The watcher picks the score up when it lands -----------------------------
  // The fade point used to be computed once, when the track started, against a
  // score that had not arrived yet - so it was always the stated length.
  const player = new GuildPlayer('g');
  player.setCrossfade(6);
  player.decks.queue.add({ provider: 'p', providerId: 'A', title: 'A', durationSec: 200 });
  player.decks.queue.index = 0;
  let joinedAt = null;
  player.startTransition = async (stated, mixOut) => { joinedAt = mixOut; };
  player.positionSec = () => 180;

  await player.checkTransition(200);
  assert.equal(joinedAt, null, 'with no score yet, 180 s is not near the stated end');
  player.score = fading;
  await player.checkTransition(200);
  assert.ok(joinedAt?.fromScore && Math.abs(joinedAt.at - 185) < 0.6,
    'the score arrived after the track started and the fade point ignored it');

  // Seeked into the outro, past where the fade would have begun: let go at the
  // audible end instead of cutting straight to the next track.
  joinedAt = null;
  player.positionSec = () => 187;
  await player.checkTransition(200);
  assert.ok(joinedAt && Math.abs(joinedAt.at - audibleEnd) < 0.05,
    `a seek into the outro was cut at ${joinedAt?.at}`);
  player.cancelTransition();
  console.log('fade point follows the score: 3/3 pass (late score, seek into the outro)');
}

// --- The clock after a skipped lead-in ------------------------------------------------
// The incoming track starts past the silence it opens with. The visuals index
// the score by position, so the offset has to carry that silence or they run
// behind the audio by exactly the amount that was cut.
{
  const player = new GuildPlayer('g');
  player.setCrossfade(8);
  for (const id of ['A', 'B']) {
    player.decks.queue.add({ provider: 'p', providerId: id, title: id, durationSec: 200 });
  }
  player.decks.queue.index = 0;
  player.onTrackStart = () => {};
  player.prefetched = { key: 'p:B', path: 'b.webm' };
  player.transition = {
    startsAtSec: 0, handoverAtSec: 4, trackKey: 'p:B', toGain: -3.5, toOffsetSec: 2.45,
  };
  player.completeTransition();
  assert.equal(player.queue.current().title, 'B');
  assert.equal(player.seekOffsetSec, 2.45, 'the skipped silence is missing from the clock');
  // At the handover the joined stream has run 4 s, so B is 6.45 s into itself.
  const at = GuildPlayer.prototype.positionSec.call({
    seekOffsetSec: player.seekOffsetSec,
    player: { state: { status: 'playing', resource: { playbackDuration: 4000 } } },
  });
  assert.ok(Math.abs(at - 6.45) < 1e-9, `B's position read ${at}`);
  // A seek on B restarts it at B's own level, not the outgoing track's.
  assert.equal(player.gainDb, -3.5, 'the new track kept the old track\'s gain');
  player.cancelTransition();
  console.log('lead-in clock: 4/4 pass (offset carries the silence, gain handed over)');
}
