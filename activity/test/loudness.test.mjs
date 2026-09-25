import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseEbur128, parseLeadIn, gainDb, gainFilter, measureLoudness, LoudnessCache,
  TARGET_LUFS, CEILING_DB, MAX_LIMITING_DB, MAX_BOOST_DB, LIMITER,
} from '../server/loudness.js';

// --- Reading ffmpeg's summary ------------------------------------------------
// Captured from ffmpeg 8.0.1 on a cached track. The summary has five lines that
// end in LUFS, and only `I:` is the integrated loudness: the thresholds and the
// loudness-range bounds would parse as a loudness just as happily.
const SUMMARY = `[Parsed_ebur128_0 @ 00000284f74e7740] Summary:

  Integrated loudness:
    I:          -9.0 LUFS
    Threshold: -19.0 LUFS

  Loudness range:
    LRA:         3.0 LU
    Threshold: -29.0 LUFS
    LRA low:   -10.2 LUFS
    LRA high:   -7.3 LUFS

  True peak:
    Peak:        1.1 dBFS
`;
assert.deepEqual(parseEbur128(SUMMARY), { lufs: -9.0, truePeak: 1.1 });

// Silence reports -70 LUFS and a peak of -inf. Neither is a loudness to match,
// and matching to it would boost a silent file by the maximum.
assert.equal(parseEbur128(SUMMARY.replace('-9.0 LUFS', '-70.0 LUFS')), null,
  'silence was read as a loudness');
assert.equal(parseEbur128(SUMMARY.replace('1.1 dBFS', '-inf dBFS')), null,
  'a -inf peak was read as a number');
assert.equal(parseEbur128('ffmpeg: file not found'), null);

// The last summary wins: a per-filter summary printed earlier must not.
assert.deepEqual(parseEbur128(`${SUMMARY.replace('-9.0', '-30.0')}\n${SUMMARY}`),
  { lufs: -9.0, truePeak: 1.1 });
console.log('ebur128 summary: 6/6 pass (integrated only, silence and -inf rejected)');

// --- The opening silence -------------------------------------------------------
assert.equal(parseLeadIn('[silencedetect @ 0] silence_start: 0\n[silencedetect @ 0] silence_end: 2.454512 | silence_duration: 2.454512'), 2.455);
// A silence two minutes in is a break, not a lead-in. Skipping to its end would
// drop most of the song.
assert.equal(parseLeadIn('silence_start: 208.228005\nsilence_end: 208.584853'), 0,
  'a silence in the middle of the track was taken for the opening');
// A file that never stops being silent has no end to skip to.
assert.equal(parseLeadIn('silence_start: 0'), 0);
assert.equal(parseLeadIn(''), 0);
// Capped: a very long opening is left mostly alone rather than guessed at.
assert.equal(parseLeadIn('silence_start: 0\nsilence_end: 45.1'), 10);
console.log('lead-in: 5/5 pass (opening only, capped)');

// --- The gain rule ---------------------------------------------------------------
// The loudest cached track, -3.6 LUFS: turned down the whole way to the target.
assert.equal(gainDb({ lufs: -3.6, truePeak: 3.4 }), -10.4);
// The median cached track: about 4.6 dB down.
assert.equal(gainDb({ lufs: -9.4, truePeak: 1.3 }), -4.6);
// Quiet and dynamic, peaks already near full scale: raised only as far as
// costs MAX_LIMITING_DB of limiting on the loudest peak, not to the target.
{
  const quiet = { lufs: -22, truePeak: -0.5 };
  const gain = gainDb(quiet);
  assert.ok(gain < TARGET_LUFS - quiet.lufs, 'a dynamic track was boosted into heavy limiting');
  assert.ok(Math.abs(quiet.truePeak + gain - CEILING_DB - MAX_LIMITING_DB) < 0.01,
    `the loudest peak would take ${(quiet.truePeak + gain - CEILING_DB).toFixed(2)} dB of limiting`);
}
// Near-silent material is capped outright.
assert.equal(gainDb({ lufs: -40, truePeak: -30 }), MAX_BOOST_DB);
// Nothing known, nothing applied.
assert.equal(gainDb(null), 0);
assert.equal(gainFilter(-4.6), 'volume=-4.60dB');
assert.equal(gainFilter(NaN), 'volume=0.00dB');
// The limiter must not normalise the stream back up to its ceiling, which
// would undo the matching, and must sit below full scale for the codec.
assert.match(LIMITER, /level=disabled/);
assert.match(LIMITER, /limit=0\.79/);
console.log('gain rule: 9/9 pass (down to target, peak-capped boost, silence capped)');

// --- Against real ffmpeg -----------------------------------------------------------
// BS.1770 defines its scale so that a stereo 997 Hz sine reads its own peak
// level in LUFS: at -10 dBFS in both channels it should measure -10 LUFS with
// a true peak of -10 dBTP. 1.5 s of silence ahead of it is the lead-in.
const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
if (!ffmpegOk) {
  console.log('loudness against ffmpeg: skipped (ffmpeg not on PATH)');
} else {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kam-loudness-'));
  try {
    const file = path.join(dir, 'tone.wav');
    // Commas escaped: a lavfi source is parsed as a filter graph, where a bare
    // comma starts the next filter.
    const tone = 'if(lt(t\\,1.5)\\,0\\,0.316228*sin(2*PI*997*t))';
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `aevalsrc=${tone}|${tone}:s=48000:d=11.5`, file]);

    const measured = await measureLoudness(file);
    assert.ok(measured, 'a plain tone could not be measured');
    assert.ok(Math.abs(measured.lufs - -10) < 0.3, `a -10 dBFS tone read ${measured.lufs} LUFS`);
    assert.ok(Math.abs(measured.truePeak - -10) < 0.3, `its true peak read ${measured.truePeak}`);
    assert.ok(Math.abs(measured.leadInSec - 1.5) < 0.05,
      `1.5 s of opening silence read as ${measured.leadInSec} s`);

    // A missing file resolves to null rather than throwing, so a failed
    // measurement can never stop a track from playing.
    assert.equal(await measureLoudness(path.join(dir, 'missing.wav')), null);

    // --- The cache ---------------------------------------------------------------
    let calls = 0;
    const counted = async (audioPath) => {
      calls += 1;
      return measureLoudness(audioPath);
    };
    const track = { provider: 'test', providerId: 'tone' };
    const cache = new LoudnessCache(dir, counted);
    // The prefetch and the start of the same track ask at once: one ffmpeg.
    const [a, b] = await Promise.all([cache.get(track, file), cache.get(track, file)]);
    assert.equal(calls, 1, `two simultaneous requests ran ${calls} measurements`);
    assert.deepEqual(a, b);
    await cache.get(track, file);
    assert.equal(calls, 1, 'a known track was measured again');

    // Kept on disk, in its own directory where neither cache pruner looks.
    assert.deepEqual(readdirSync(path.join(dir, 'loudness')), ['test-tone.json']);
    const fresh = new LoudnessCache(dir, async () => { throw new Error('must not measure'); });
    assert.deepEqual(await fresh.get(track, file), a, 'a stored measurement was not reused');

    // A failure is not written down, so a transient one cannot pin a track at
    // unity gain for good.
    const failing = new LoudnessCache(dir, async () => null);
    assert.equal(await failing.get({ provider: 'test', providerId: 'bad' }, file), null);
    assert.ok(!readdirSync(path.join(dir, 'loudness')).includes('test-bad.json'),
      'a failed measurement was stored');

    // A half-written file from a crash is ignored and replaced, not trusted.
    writeFileSync(path.join(dir, 'loudness', 'test-torn.json'), '{"lufs": -9.');
    const torn = new LoudnessCache(dir, counted);
    assert.ok(await torn.get({ provider: 'test', providerId: 'torn' }, file),
      'a torn cache file stopped the track being measured');
    console.log('loudness against ffmpeg: 12/12 pass (-10 dBFS tone reads -10 LUFS, 1.5 s lead-in, cache)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
