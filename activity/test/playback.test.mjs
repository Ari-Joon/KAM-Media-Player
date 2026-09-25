import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioPlayerStatus } from '@discordjs/voice';
import { GuildPlayer, playbackArgs, transitionArgs } from '../server/player.js';
import { measureLoudness, gainDb, TARGET_LUFS } from '../server/loudness.js';

// End to end: real ffmpeg, real Ogg Opus, a real discord.js AudioPlayer. The
// unit tests prove the arguments are right; these prove what they produce,
// because every surviving bug in this area has been one the arguments looked
// fine for.

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.log('playback end to end: skipped (ffmpeg not on PATH)');
  process.exit(0);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = mkdtempSync(path.join(os.tmpdir(), 'kam-playback-'));

/**
 * Write a stereo tone to a float WAV, which keeps samples above full scale -
 * the point of the hot one.
 */
function tone(name, { freq = 440, peak = 0.3, seconds = 20, silence = 0 } = {}) {
  const file = path.join(dir, `${name}.wav`);
  // Commas escaped: a lavfi source is parsed as a filter graph.
  const expr = `if(lt(t\\,${silence})\\,0\\,${peak}*sin(2*PI*${freq}*t))`;
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `aevalsrc=${expr}|${expr}:s=48000:d=${seconds + silence}`, '-c:a', 'pcm_f32le', file]);
  assert.equal(made.status, 0, `could not generate ${name}: ${made.stderr}`);
  return file;
}

/** Run a player's ffmpeg arguments into a file and decode the result to floats. */
function render(args) {
  const out = path.join(dir, `render-${Math.random().toString(36).slice(2)}.opus`);
  const ran = spawnSync('ffmpeg', [...args.slice(0, -1), out]);
  assert.equal(ran.status, 0, `the chain failed: ${ran.stderr}`);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'f32le',
    '-ar', '48000', '-ac', '2', 'pipe:1'], { maxBuffer: 1 << 28 });
  const bytes = decoded.stdout;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

const peakOf = (samples, from = 0, to = samples.length) => {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
};
const rmsOf = (samples, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
};

const files = {
  A: tone('a', { freq: 440 }),
  B: tone('b', { freq: 554 }),
  C: tone('c', { freq: 659 }),
};

/** A player over tracks A, B, C with injectable download delays. */
function playerFor(titles, delays = {}) {
  const player = new GuildPlayer('test');
  for (const title of titles) {
    player.decks.queue.add({ provider: 'p', providerId: title, title, durationSec: 20 });
  }
  player.decks.queue.index = 0;
  const started = [];
  let ended = 0;
  player.loadAudio = async (track) => {
    await wait(delays[track.title] ?? 0);
    return files[track.title];
  };
  player.onTrackStart = (track) => started.push(track.title);
  player.onQueueEnd = () => { ended += 1; };
  return { player, started, ended: () => ended };
}

try {
  // --- The clock runs at real time ------------------------------------------------
  // `playbackDuration` adds 20 ms per packet read, and every visualisation is
  // indexed by it. Ogg Opus from ffmpeg must therefore arrive in 20 ms frames:
  // at 40 ms the visuals would run at half speed against the audio.
  {
    const { player } = playerFor(['A']);
    await player.startCurrent();
    await wait(1000);
    const first = player.positionSec();
    await wait(2000);
    const rate = (player.positionSec() - first) / 2;
    assert.ok(Math.abs(rate - 1) < 0.06,
      `the clock ran at ${rate.toFixed(3)}x real time on the new decoder`);
    assert.ok(player.decoder, 'a normal start did not go through our own decoder');
    player.stop();
    console.log(`clock: 2/2 pass (${rate.toFixed(3)}x real time on Ogg Opus)`);
  }

  // --- A skip moves exactly one track -----------------------------------------------
  // Measured before the fix, with the same 500 ms download: this started B and
  // then C, because the killed decoder's Idle arrived while B was downloading
  // and the handler still took it for A ending by itself.
  {
    const { player, started } = playerFor(['A', 'B', 'C'], { B: 500 });
    await player.startCurrent();
    await wait(400);
    await player.advance(true);
    await wait(1200);
    assert.deepEqual(started, ['A', 'B'], `a single skip started ${started.slice(1).join(' then ')}`);
    assert.equal(player.queue.current().title, 'B');
    player.stop();
  }

  // --- The end of the queue is announced once, and the music stops --------------------
  // Measured before: announced twice, the doubled "Queue finished" seen in a
  // live channel.
  {
    const run = playerFor(['A']);
    await run.player.startCurrent();
    await wait(400);
    await run.player.advance(true);
    await wait(800);
    assert.equal(run.ended(), 1, `the end of the queue was announced ${run.ended()} times`);
    assert.equal(run.player.player.state.status, AudioPlayerStatus.Idle,
      'a skip on the last track left the song playing');
    run.player.stop();
  }

  // --- Switching transitions off does not skip the song --------------------------------
  // Measured before: this killed the decoder carrying the song, and the Idle
  // that followed started the next track.
  {
    const { player, started } = playerFor(['A', 'B']);
    player.setCrossfade(6);
    await player.startCurrent();
    await wait(400);
    player.seek(2);
    await wait(300);
    player.setCrossfade(null);
    await wait(800);
    assert.deepEqual(started, ['A'], 'switching transitions off skipped the song');
    assert.equal(player.player.state.status, AudioPlayerStatus.Playing,
      'switching transitions off stopped the song');
    player.stop();
  }

  // --- Overlapping starts: the newest wins -----------------------------------------------
  // Two skips in quick succession, the first download slower than the second.
  // Whichever start finished last used to play, so B's audio could land under
  // C's title.
  {
    const { player, started } = playerFor(['A', 'B', 'C'], { B: 700, C: 50 });
    await player.startCurrent();
    await wait(300);
    const first = player.advance(true);
    await wait(30);
    await player.advance(true);
    await first;
    await wait(900);
    assert.deepEqual(started, ['A', 'C'], `overlapping skips played ${started.slice(1).join(', ')}`);
    assert.equal(player.audioPath, files.C, 'the audio playing is not the track named');
    player.stop();
  }

  // --- A stop during a download holds ------------------------------------------------------
  {
    const { player, started } = playerFor(['A', 'B'], { B: 500 });
    await player.startCurrent();
    await wait(300);
    const pending = player.advance(true);
    await wait(50);
    player.stop();
    await pending;
    await wait(700);
    assert.deepEqual(started, ['A'], 'a download that landed after a stop started playing anyway');
    assert.equal(player.player.state.status, AudioPlayerStatus.Idle);
    console.log('queue control: 10/10 pass (one skip, one announcement, off keeps the song, newest start wins, stop holds)');
  }

  // --- Nothing leaves over full scale ----------------------------------------------------------
  // A tone at +3 dBFS, hotter than the worst cached track, with no loudness
  // measurement at all: the limiter alone must hold it under full scale after a
  // real Opus round trip.
  {
    const hot = tone('hot', { peak: 1.4125, seconds: 6 });
    const unmatched = render(playbackArgs({ file: hot, gain: 0 }));
    const peak = peakOf(unmatched);
    assert.ok(peak < 1, `a +3 dBFS source left at ${(20 * Math.log10(peak)).toFixed(2)} dBFS`);

    // With its measured gain it lands on the target instead of on the limiter.
    const measured = await measureLoudness(hot);
    const matched = render(playbackArgs({ file: hot, gain: gainDb(measured) }));
    const out = path.join(dir, 'matched.wav');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2',
      '-i', 'pipe:0', out], { input: Buffer.from(matched.buffer, matched.byteOffset, matched.byteLength) });
    const again = await measureLoudness(out);
    assert.ok(Math.abs(again.lufs - TARGET_LUFS) < 0.5,
      `a matched track played at ${again.lufs} LUFS, not ${TARGET_LUFS}`);
    console.log(`limiter: 2/2 pass (+3 dBFS in, ${(20 * Math.log10(peak)).toFixed(2)} dBFS out; matched to ${again.lufs} LUFS)`);
  }

  // --- A crossfade between a loud and a quiet track is level ------------------------------------
  // One track 17 dB hotter than the other, as the extremes of the cache are.
  // Matched before they meet, the two sides of the join should sit within a
  // decibel of each other; unmatched they were the whole 17 dB apart.
  {
    const loud = tone('loud', { peak: 0.7, seconds: 12 });
    const quiet = tone('quiet', { freq: 554, peak: 0.1, seconds: 12, silence: 1.5 });
    const [l, q] = [await measureLoudness(loud), await measureLoudness(quiet)];
    assert.ok(Math.abs(q.leadInSec - 1.5) < 0.05, 'the quiet track\'s opening silence was not found');

    const joined = render(transitionArgs({
      fromPath: loud, toPath: quiet, position: 6, fade: 4,
      toOffset: q.leadInSec, fromGain: gainDb(l), toGain: gainDb(q),
    }));
    const second = 48000 * 2;
    const before = rmsOf(joined, 0, second / 4);                    // outgoing, fade just begun
    const after = rmsOf(joined, 6 * second, 8 * second);            // incoming, alone
    const gap = Math.abs(20 * Math.log10(before / after));
    assert.ok(gap < 1, `the two sides of the join differ by ${gap.toFixed(2)} dB`);
    // The silence is gone from the join: 4 s of fade plus 8 s more of the
    // incoming tone is 12 s. Left in, the 1.5 s of silence makes it 13.5 s.
    const length = joined.length / second;
    assert.ok(Math.abs(length - 12) < 0.1,
      `the join ran ${length.toFixed(2)} s, so the incoming track's silence is still in it`);
    assert.ok(peakOf(joined) < 1, 'the join went over full scale');

    // Gapless, trimmed at a known end: the next track starts exactly there.
    const gapless = render(transitionArgs({
      fromPath: loud, toPath: quiet, position: 8, fade: 0, fromLength: 3,
      toOffset: q.leadInSec, fromGain: gainDb(l), toGain: gainDb(q),
    }));
    const seconds = gapless.length / second;
    assert.ok(Math.abs(seconds - 15) < 0.1,
      `a 3 s tail joined to 12 s of music ran ${seconds.toFixed(2)} s, so silence got in`);
    console.log(`joins: 6/6 pass (sides ${gap.toFixed(2)} dB apart, silence skipped, gapless exact)`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
