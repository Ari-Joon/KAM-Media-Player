/**
 * Loudness matching: every track is brought to the same integrated loudness
 * before it reaches the encoder, and a limiter catches whatever peaks remain.
 *
 * ## Why a limiter on its own was not enough
 *
 * Most YouTube uploads decode *above* full scale. Lossy AAC overshoots the
 * master it was made from, so the decoded float signal routinely exceeds 1.0.
 * Measured over the 29 tracks in the cache on 25 September 2026: 22 of them
 * decoded above full scale, the worst peaking at +3.31 dBFS with 1.95% of its
 * samples over. YouTube's own player never clips these, because it plays them
 * turned down to its loudness target in a float pipeline. We decoded them at
 * unity gain, and on the seek and gapless paths through 16-bit PCM, which
 * hard-clipped 423,815 samples of that one track - audible distortion for
 * every listener, whatever their volume.
 *
 * The encoder makes it worse. Opus overshoots in turn, so what a listener's
 * client decodes is hotter than what was sent. Each strategy below was run
 * through the real chain - ffmpeg into libopus at 96 kbps, then decoded -
 * across all 29 tracks:
 *
 * | strategy                  | tracks over 0 dBFS | worst peak | spread  |
 * |---------------------------|--------------------|------------|---------|
 * | unity gain (as shipped)   | 24/29              | +4.95 dBFS | 11.1 LU |
 * | limiter only, -1 dBFS     | 22/29              | +2.53 dBFS |  9.6 LU |
 * | match to -12 LUFS + limit |  7/29              | +0.86 dBFS |  0.8 LU |
 * | match to -14 LUFS + limit |  1/29              | +0.47 dBFS |  0.2 LU |
 * | the rule in this module   |  0/29              | -0.28 dBFS |  0.5 LU |
 *
 * A limiter alone still clipped 22 tracks after encoding and was taking more
 * than 1 dB off the signal for 8.9% of the time, heavily on 15 of them: it
 * could only stop the clipping by squashing the music. Turning loud tracks
 * down first is what leaves the codec room to overshoot into.
 *
 * "Spread" is the gap between the quietest and loudest track once played.
 * Unmatched it was 11.1 LU - a crossfade between the extremes was an 11 dB
 * lurch rather than a blend, which is a large part of why transitions did not
 * sound like a mix.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('loudness');

/**
 * Integrated loudness every track is brought to, in LUFS.
 *
 * -14 is what YouTube, Spotify and Tidal normalise to, and the measurement
 * above says why it is the right number here rather than a convention: modern
 * masters carry 8 to 13 dB between their loudness and their peaks, so at -14
 * nearly all of them land with their peaks below the ceiling and the limiter
 * has nothing to do. At -12, 7 of 29 tracks still clipped after encoding.
 *
 * The cost is level: the median cached track was -9.4 LUFS, so a typical song
 * now plays about 4.6 dB quieter than before. Every listener can raise the bot
 * in Discord, and every track now arrives at the same level.
 */
export const TARGET_LUFS = -14;

/**
 * The limiter's ceiling, in dBFS.
 *
 * Below 0 because the encoder overshoots whatever it is given, and a limited
 * peak - flattened - is exactly the shape that overshoots most. A grid over
 * the tracks most at risk found -2 the only ceiling with no sample over full
 * scale after decoding under both boost rules tried, with 0.28 dB to spare;
 * at -1 and -1.5 the result flickered between zero and a handful of samples,
 * which is codec noise, and a margin is what makes it stop mattering.
 */
export const CEILING_DB = -2;

/**
 * The most the limiter is ever asked to take off a peak, in dB.
 *
 * A quiet, dynamic recording - acoustic, classical - can sit well below the
 * target with its peaks already near full scale. Boosting it all the way would
 * hand the limiter a job measured in whole decibels on every transient, which
 * is audible as the music being squashed. This caps that: such a track is
 * brought up only as far as costs at most 3 dB of limiting, and simply plays a
 * little under the target instead.
 */
export const MAX_LIMITING_DB = 3;

/**
 * An outright cap on boosting, in dB, for material the peak rule cannot judge:
 * a near-silent upload would otherwise be raised by tens of decibels.
 */
export const MAX_BOOST_DB = 12;

/** Below this the measurement is of silence or noise, not of music. */
const MIN_MEASURABLE_LUFS = -60;

/**
 * Level below which the opening of a file counts as silence, and the longest
 * such opening a transition will skip, in seconds.
 *
 * Absolute rather than relative because the target is dead air - digital
 * silence and the hiss before a video's music starts - not a quiet intro,
 * which is part of the song. Checked against the analyser on four cached
 * tracks: 2.45 s here against 2.43 s from the score's energy lane, 0.22
 * against 0.20, 0.33 against 0.33, and no lead-in on a track whose first
 * audible frame the score puts at 0.07 s, under the 0.1 s minimum. The cap
 * leaves a deliberately long silence mostly alone rather than guessing at it.
 */
const LEAD_IN_THRESHOLD_DB = -50;
const MAX_LEAD_IN_SEC = 10;

/**
 * Read integrated loudness and true peak out of ffmpeg's `ebur128` summary.
 *
 * Takes the *last* summary block, since the per-filter summaries print at
 * exit, and anchors on `I:` and `Peak:` specifically - the summary has several
 * other lines ending in LUFS, and the loudness-range thresholds would parse as
 * a loudness just as happily.
 *
 * @param {string} stderr ffmpeg's stderr.
 * @returns {{lufs: number, truePeak: number, leadInSec?: number}|null} Null for silence or junk.
 */
export function parseEbur128(stderr) {
  const at = String(stderr).lastIndexOf('Summary:');
  if (at < 0) return null;
  const summary = stderr.slice(at);
  const lufs = Number(/\bI:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  // Silence reports `-inf dBFS`, which does not match and becomes NaN here.
  const truePeak = Number(/\bPeak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
  if (!Number.isFinite(lufs) || !Number.isFinite(truePeak)) return null;
  if (lufs < MIN_MEASURABLE_LUFS) return null;
  return { lufs, truePeak };
}

/**
 * How much silence a file opens with, from ffmpeg's `silencedetect` lines.
 *
 * Only a silence that starts at the very beginning counts. The first silence
 * reported can be anywhere - a break two minutes in - and skipping to the end
 * of that would drop most of the song.
 *
 * @param {string} stderr The *start* of ffmpeg's stderr, where these appear.
 * @returns {number} Seconds, 0 when the file opens with sound.
 */
export function parseLeadIn(stderr) {
  const start = /silence_start:\s*(-?[\d.e-]+)/.exec(String(stderr));
  if (!start || Number(start[1]) > 0.05) return 0;
  const end = /silence_end:\s*([\d.]+)/.exec(String(stderr).slice(start.index));
  if (!end) return 0;
  const seconds = Math.min(MAX_LEAD_IN_SEC, Number(end[1]));
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : 0;
}

/**
 * The gain that brings a measured track to the target, in dB.
 *
 * One rule, three limits. Loud tracks are turned down to the target. Quiet ones
 * are raised towards it, but only as far as leaves the limiter at most
 * {@link MAX_LIMITING_DB} of work on the loudest peak, and never by more than
 * {@link MAX_BOOST_DB}. The same peak cap also applies on the way down, which
 * turns a track with unusually hot peaks down slightly further rather than
 * letting the limiter flatten them.
 *
 * @param {{lufs: number, truePeak: number, leadInSec?: number}|null} measurement
 * @returns {number} Gain in dB; 0 when nothing is known.
 */
export function gainDb(measurement) {
  if (!measurement) return 0;
  const toTarget = TARGET_LUFS - measurement.lufs;
  const peakRoom = CEILING_DB - measurement.truePeak + MAX_LIMITING_DB;
  const gain = Math.min(toTarget, peakRoom, MAX_BOOST_DB);
  return Math.round(gain * 100) / 100;
}

/**
 * The limiter every playback path ends in.
 *
 * `level=disabled` stops alimiter normalising the whole stream up to its
 * ceiling, which would undo the loudness matching entirely. `latency=1`
 * compensates for the lookahead, so the output is not shifted 5 ms against the
 * input and the final 5 ms of a track are flushed rather than dropped.
 */
export const LIMITER = `alimiter=limit=${(10 ** (CEILING_DB / 20)).toFixed(4)}`
  + ':attack=5:release=50:level=disabled:latency=1';

/**
 * ffmpeg's gain filter for a track.
 *
 * @param {number} gain In dB.
 * @returns {string}
 */
export function gainFilter(gain) {
  const value = Number.isFinite(gain) ? gain : 0;
  return `volume=${value.toFixed(2)}dB`;
}

/**
 * Measure a file's integrated loudness, true peak and opening silence with
 * ffmpeg, in one decode.
 *
 * Never throws. A failure here must not stop a track playing - it plays at
 * unity gain through the limiter, which is what every track did before this
 * existed, less the clipping.
 *
 * Measured at 0.43 s median and 0.67 s at worst for a whole song across the
 * cache, which is why it can run at prefetch time without anyone waiting on
 * it, and costs well under a second on the rare first play of an uncached
 * track.
 *
 * @param {string} audioPath
 * @param {object} [options]
 * @param {string} [options.ffmpeg] Binary to run.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{lufs: number, truePeak: number, leadInSec: number}|null>}
 */
export function measureLoudness(audioPath, { ffmpeg = 'ffmpeg', timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let head = '';
    let tail = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn(ffmpeg, [
        '-nostdin', '-nostats', '-hide_banner',
        '-i', audioPath,
        '-af', 'ebur128=peak=true:framelog=quiet,'
          + `silencedetect=n=${LEAD_IN_THRESHOLD_DB}dB:d=0.1`,
        '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      log.debug(`could not start ffmpeg: ${error.message}`);
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      log.debug(`timed out measuring ${path.basename(audioPath)}`);
      finish(null);
    }, timeoutMs);

    // Two windows rather than the whole stream. The opening silence is
    // reported first and the loudness summary last, and a corrupt file can log
    // an error per frame for the length of the song in between.
    child.stderr.on('data', (chunk) => {
      if (head.length < 8_192) head += chunk;
      tail = (tail + chunk).slice(-16_384);
    });
    child.on('error', (error) => {
      log.debug(`ffmpeg failed: ${error.message}`);
      finish(null);
    });
    child.on('close', () => {
      const measured = parseEbur128(tail);
      finish(measured && { ...measured, leadInSec: parseLeadIn(head) });
    });
  });
}

/**
 * Measurements per track, kept in memory and on disk.
 *
 * On disk because a song is measured once for its lifetime in the cache, not
 * once per play, and in its own directory because both cache pruners work by
 * file name at the top level: the audio pruner deletes by extension and the
 * score pruner by `-a<version>.json`, and neither looks inside a subdirectory.
 */
export class LoudnessCache {
  /**
   * @param {string} directory The cache root; measurements go in `loudness/`.
   * @param {(audioPath: string) => Promise<{lufs: number, truePeak: number, leadInSec?: number}|null>} [measure]
   */
  constructor(directory, measure = measureLoudness) {
    this.directory = path.join(directory, 'loudness');
    this.measure = measure;
    /** @type {Map<string, {lufs: number, truePeak: number, leadInSec?: number}|null>} */
    this.known = new Map();
    /**
     * Measurements under way, so the prefetch and the start of the same track
     * share one ffmpeg rather than racing two.
     * @type {Map<string, Promise<{lufs: number, truePeak: number, leadInSec?: number}|null>>}
     */
    this.pending = new Map();
  }

  /**
   * @param {{provider: string, providerId: string}} track
   * @returns {string}
   */
  static key(track) {
    return `${track.provider}-${track.providerId}`;
  }

  /**
   * The measurement for a track, measuring it if it is not already known.
   *
   * @param {{provider: string, providerId: string}} track
   * @param {string} audioPath
   * @returns {Promise<{lufs: number, truePeak: number, leadInSec?: number}|null>}
   */
  async get(track, audioPath) {
    const key = LoudnessCache.key(track);
    if (this.known.has(key)) return this.known.get(key);
    if (this.pending.has(key)) return this.pending.get(key);

    const work = this.lookup(key, audioPath).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  /**
   * @param {string} key
   * @param {string} audioPath
   * @returns {Promise<{lufs: number, truePeak: number, leadInSec?: number}|null>}
   */
  async lookup(key, audioPath) {
    const file = path.join(this.directory, `${key}.json`);
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (Number.isFinite(stored?.lufs) && Number.isFinite(stored?.truePeak)) {
        const value = {
          lufs: stored.lufs,
          truePeak: stored.truePeak,
          leadInSec: Number.isFinite(stored.leadInSec) ? stored.leadInSec : 0,
        };
        this.known.set(key, value);
        return value;
      }
    } catch {
      // Not measured before, which is the case this exists for.
    }

    const started = Date.now();
    const value = await this.measure(audioPath);
    // A failed measurement is remembered for this run only. Written to disk it
    // would pin the track at unity gain for good over what may have been a
    // transient failure.
    this.known.set(key, value);
    if (!value) return null;

    log.debug(`${key}: ${value.lufs.toFixed(1)} LUFS, peak ${value.truePeak.toFixed(1)} dBTP, `
      + `gain ${gainDb(value).toFixed(1)} dB, opens with ${value.leadInSec.toFixed(2)} s `
      + `of silence (measured in ${Date.now() - started} ms)`);
    try {
      await mkdir(this.directory, { recursive: true });
      // Written then renamed, so a crash mid-write leaves no half-file that
      // would parse as garbage on the next boot.
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ ...value, measuredAt: new Date().toISOString() }));
      await rename(temp, file);
    } catch (error) {
      log.debug(`could not store ${key}: ${error.message}`);
    }
    return value;
  }
}
