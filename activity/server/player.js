/**
 * Voice playback: streams audio into a voice channel, owns the queue, and is the
 * authoritative source of playback position.
 *
 * ## The clock
 *
 * Because the server decodes and transmits the audio itself,
 * `AudioResource.playbackDuration` counts milliseconds actually sent to Discord.
 * That is a measurement, not an estimate, and it is what makes exact visual sync
 * possible. Adding `seekOffsetSec` gives the true position after a seek, since
 * `playbackDuration` restarts from zero whenever a new resource begins.
 *
 * ## Seeking
 *
 * Seeking recreates the audio resource with ffmpeg started at an offset
 * (`-ss`). There is no way to seek an in-flight Opus stream, so this is the
 * standard approach: cheap, because the file is already local.
 *
 * Pure-JS dependencies throughout - `opusscript` rather than `@discordjs/opus`,
 * and Node's built-in AES-256-GCM - so no native build tools are needed on
 * Windows. Slower than native, and irrelevant at one stream per guild.
 */

import { spawn } from 'node:child_process';
import {
  generateDependencyReport,
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { DeckSet } from './decks.js';
import { LIMITER, gainDb, gainFilter } from './loudness.js';

/** @type {Map<string, GuildPlayer>} */
const players = new Map();

/**
 * How many recently played tracks to remember per player.
 *
 * Fifteen. This was seven, on the reasoning that the panel under the search box
 * is a convenience rather than a history and should never become a list to
 * scroll. In use the opposite complaint came first: a session runs longer than
 * seven tracks and "what was that one" reaches further back than the panel did.
 * The client renders whatever the snapshot carries and imposes no cap of its
 * own, so this constant is the only thing that decides the length.
 */
const RECENT_TRACKS = 15;

/**
 * Longest crossfade the slider offers, in seconds.
 *
 * Past about this the outgoing track is still clearly present a third of a
 * phrase into the incoming one, which stops reading as a transition and starts
 * reading as two songs playing at once.
 */
export const MAX_CROSSFADE_SEC = 12;

/**
 * How early a gapless join is prepared, in seconds.
 *
 * A crossfade schedules itself its own length before the end. A gapless join
 * has no length, so it needs a lead of its own or there is nothing left of the
 * outgoing track to hand to ffmpeg.
 *
 * ## Why this is seconds and not milliseconds
 *
 * It was 0.4s, sized against how long ffmpeg takes to start: measured over ten
 * runs, first audio byte arrives 82-208ms after spawn (median 120), so 400ms
 * looked like ample margin. Gapless still did not work while crossfade did, and
 * the spawn was never the binding constraint.
 *
 * The trigger compares `positionSec()` - audio actually transmitted - against
 * `track.durationSec`, which is *provider metadata*. The two disagree by a
 * second or more routinely, and when the real file is shorter than its stated
 * length the resource goes Idle before the position ever reaches
 * `duration - 0.4`. The transition simply never fires and the old ending runs,
 * gap and all. A crossfade hid this completely: its lead is its own length, so
 * a five-second fade carries five seconds of slack.
 *
 * Three seconds is that slack, made explicit. It costs nothing audible, because
 * `concat` keeps the whole remaining tail - triggering earlier lengthens the
 * outgoing part of the joined stream rather than cutting it.
 */
export const GAPLESS_LEAD_SEC = 3;

/**
 * How often the transition check runs, in milliseconds.
 *
 * Driven off `positionSec()` rather than a `setTimeout` aimed at the end of the
 * track, because a timeout is a wall clock: it keeps counting while playback is
 * paused, and it fires at a position the track is no longer at once anyone has
 * seeked. Polling asks the only question that matters - how much of this track
 * has actually been transmitted - and answers it correctly in both cases.
 *
 * 100ms is a tenth of the poll the Activity already runs, and the check is a
 * subtraction.
 */
const TRANSITION_TICK_MS = 100;

/**
 * How long the outro of a track may be cut short to put the fade on music
 * rather than on the song's own fade-out, in seconds.
 *
 * The fade used to end where the track stopped being audible, which puts all
 * of it over the song's natural decay: the outgoing track is already fading on
 * its own, and there is little of it left to blend. Measured over every
 * ordered pair of the 22 fully analysed tracks in the cache (462 joins), the
 * share of a 6 s fade in which *both* songs sat at half their typical level or
 * more - an audible blend rather than one song over the other's silence:
 *
 * | fade point                                  |  2 s |  6 s | 12 s |
 * |---------------------------------------------|------|------|------|
 * | end of the file (what actually shipped)     |   0% |   6% |  19% |
 * | audible end (what the code intended)        |   6% |  20% |  35% |
 * | outro start, capped at 8 s, next from 0     |  17% |  38% |  48% |
 * | ...and the next track's silence skipped     |  34% |  46% |  53% |
 *
 * The first row is why the slider seemed to make no difference: a 2 s fade
 * sat entirely inside the trailing silence, median 2.8 s and up to 8.8 s. The
 * cap keeps a long quiet coda mostly intact - it costs 2.8 s of outro on
 * average and never more than 8.
 */
export const MAX_OUTRO_CUT_SEC = 8;

/**
 * Energy below which a frame counts as silence. Lane values are normalised
 * 0-1 and rounded to 3 dp, so the floor has to sit above the rounding.
 */
const SILENCE_FLOOR = 0.02;

/**
 * Where to let go of the outgoing track, from its score.
 *
 * A crossfade lets go where the outro starts falling - the last second at
 * half the track's typical level or more - so the fade is spent on music; see
 * {@link MAX_OUTRO_CUT_SEC}. A gapless join lets go at the audible end, keeping
 * the whole natural fade-out and dropping only the dead air after it, which is
 * the gap a gapless join exists to remove.
 *
 * Falls back to the stated duration whenever the score cannot answer: a
 * partial score covers only the opening of the track, so its lane ends long
 * before the music does and trusting it would cut every track short.
 *
 * Exported and pure so the placement can be tested against real scores.
 *
 * @param {object|null} score The outgoing track's VisualScore.
 * @param {number} stated The provider's duration, in seconds.
 * @param {boolean} crossfade True for a crossfade, false for a gapless join.
 * @returns {{at: number, fromScore: boolean}}
 */
export function mixOutPoint(score, stated, crossfade) {
  const lanes = score?.lanes;
  if (!score || score.analysis?.is_partial || !lanes?.fps
      || !Array.isArray(lanes.energy) || lanes.energy.length === 0) {
    return { at: stated, fromScore: false };
  }
  const { energy, fps } = lanes;

  let last = -1;
  for (let i = energy.length - 1; i >= 0; i--) {
    if (energy[i] > SILENCE_FLOOR) {
      last = i;
      break;
    }
  }
  if (last < 0) return { at: stated, fromScore: false };
  let at = (last + 1) / fps;

  if (crossfade) {
    const audible = [];
    for (const value of energy) if (value > SILENCE_FLOOR) audible.push(value);
    audible.sort((a, b) => a - b);
    const typical = audible[Math.floor(audible.length / 2)];

    // A one-second average, so a single quiet beat in the last chorus does not
    // read as the outro beginning.
    const half = Math.max(1, Math.round(fps / 2));
    const prefix = new Float64Array(energy.length + 1);
    for (let i = 0; i < energy.length; i++) prefix[i + 1] = prefix[i] + energy[i];
    const mean = (i) => {
      const from = Math.max(0, i - half);
      const to = Math.min(energy.length, i + half);
      return (prefix[to] - prefix[from]) / (to - from);
    };

    let outro = last;
    while (outro > 0 && mean(outro) < typical * 0.5) outro -= 1;
    at = Math.max((outro + 1) / fps, at - MAX_OUTRO_CUT_SEC);
  }

  // Never past the stated end, and never so early that a bad analysis costs
  // the track a recognisable amount of itself.
  return { at: Math.max(stated * 0.75, Math.min(stated, at)), fromScore: true };
}

/**
 * How every decoder hands its audio to discord.js: Ogg Opus, encoded by
 * ffmpeg's own libopus.
 *
 * ## One encoder, whichever way a track started
 *
 * A track used to reach listeners through one of two encoders depending on
 * how it began. A normal start went through discord.js's own ffmpeg, which on
 * a build with libopus encodes straight from the decoder's float output. A
 * seek or a transition came through our ffmpeg as 16-bit PCM and was encoded
 * by opusscript, a WebAssembly build of the same codec, on the Node event
 * loop. The 16-bit step is where overs were hard-clipped - 423,815 samples of
 * the worst cached track - so a song could sound clean until someone seeked,
 * and distort after.
 *
 * Every path now ends here: no 16-bit stage, the same encoder however a track
 * began, and the encoding done in ffmpeg's process rather than in the one that
 * also serves the Activity.
 *
 * `-b:a 96k` and `-frame_duration 20` are ffmpeg's defaults, written out
 * because two things depend on them. 96k is what normal playback always sent.
 * And `playbackDuration`, the clock every visualisation follows, adds 20 ms
 * for each packet it reads: any other frame size and the visuals would drift
 * from the audio by the ratio.
 */
const OPUS_OUTPUT = [
  '-acodec', 'libopus', '-b:a', '96k', '-frame_duration', '20',
  '-f', 'opus', '-ar', '48000', '-ac', '2',
  'pipe:1',
];

/**
 * Build the ffmpeg invocation that plays one track from an offset.
 *
 * Exported and pure so the chain every listener hears can be tested - above
 * all, that no path reaches the encoder without the limiter.
 *
 * @param {object} options
 * @param {string} options.file Audio file.
 * @param {number} [options.position] Where to start, in seconds.
 * @param {number} [options.gain] Loudness-matching gain, in dB.
 * @returns {string[]}
 */
export function playbackArgs({ file, position = 0, gain = 0 }) {
  return [
    '-nostdin', '-loglevel', 'error',
    // Before -i, so this is a container-index seek rather than a decode from
    // the start of the file: near-instant however far in it lands.
    ...(position > 0 ? ['-ss', String(position)] : []),
    '-i', file,
    '-af', `${gainFilter(gain)},${LIMITER}`,
    ...OPUS_OUTPUT,
  ];
}

/**
 * Build the ffmpeg invocation that joins two tracks into one stream.
 *
 * Exported and pure so the filter graph can be tested. It is the part that is
 * both easy to get subtly wrong and impossible to notice going wrong from the
 * outside: a transition with the wrong fade length, or with the inputs the
 * wrong way round, still produces audio.
 *
 * ## Measured against real ffmpeg
 *
 * Two 20-second tones, joined at a position of 14s so six seconds of tail
 * remain. A six-second crossfade produced exactly 20.000s of output
 * (tail + incoming - fade = 6 + 20 - 6) and a gapless join exactly 26.000s
 * (6 + 20), both at exit 0 - which is what confirms `-ss` is being read as an
 * input option rather than decoding the whole file first.
 *
 * ## The curve is equal-power
 *
 * `qsin` on both sides. `tri` is a linear, equal-gain fade, and crossing two
 * uncorrelated signals linearly puts each at half amplitude in the middle,
 * which sums to 0.707 of full power - the textbook 3 dB hole, and two
 * different songs are uncorrelated for practical purposes. Measured on two
 * uncorrelated pink-noise sources with a 6 s fade, level at the centre of the
 * join against the same sources alone:
 *
 *   tri -3.00 dB, qsin -0.20 dB, hsin -2.77 dB, esin -7.78 dB
 *
 * On a real pair from the cache, with only the curve changed, mid-fade RMS was
 * 0.13983 under `tri` and 0.19611 under `qsin`: the join holds 2.93 dB more
 * level. That sag in the middle was what "the crossfade is not smooth" sounded
 * like.
 *
 * ## Each track is matched before they meet
 *
 * The gain is applied to each input separately, ahead of the join. Matching
 * after the mix would apply one gain to two songs that need different ones,
 * and a crossfade from a -3.6 LUFS track into a -14.7 LUFS one - both in the
 * cache - would still be an 11 dB lurch. The limiter comes after the join,
 * because two songs at equal power still sum above either on a shared
 * transient; it is the one every path ends in.
 *
 * @param {object} options
 * @param {string} options.fromPath Outgoing track's file.
 * @param {string} options.toPath Incoming track's file.
 * @param {number} options.position Where the outgoing track is now, in seconds.
 * @param {number} options.fade Crossfade length in seconds; 0 joins gaplessly.
 * @param {number} [options.fromLength] How much of the outgoing track a
 *   gapless join takes, in seconds. A crossfade always takes exactly its fade.
 *   Left out, the join keeps the rest of the file.
 * @param {number} [options.toOffset] Where the incoming track starts, in
 *   seconds: past the silence it opens with.
 * @param {number} [options.fromGain] Outgoing track's loudness gain, in dB.
 * @param {number} [options.toGain] Incoming track's loudness gain, in dB.
 * @returns {string[]}
 */
export function transitionArgs({
  fromPath, toPath, position, fade, fromLength, toOffset = 0, fromGain = 0, toGain = 0,
}) {
  const inputs = `[0:a]${gainFilter(fromGain)}[a0];[1:a]${gainFilter(toGain)}[a1];`;
  const join = fade > 0
    ? `[a0][a1]acrossfade=d=${fade.toFixed(3)}:c1=qsin:c2=qsin`
    : '[a0][a1]concat=n=2:v=0:a=1';
  const take = fade > 0 ? fade : fromLength;

  return [
    '-nostdin', '-loglevel', 'error',
    // Before -i, so this is a container-index seek rather than a decode from
    // the start of the file - the same reason `playbackArgs` puts it there.
    '-ss', String(position),
    // Trimmed to exactly the fade, and this is not an optimisation.
    //
    // `acrossfade` fades the *end* of its first input. Left untrimmed that
    // input runs to the end of the file, so the fade happens there - however
    // early the transition was started. Measured: joining at 120s into a
    // six-minute track produced output byte-identical to the unfaded track for
    // its first eight seconds, because the fade was still 247 seconds away.
    //
    // Trimming makes the fade begin at the join by construction, which is also
    // what makes `startsAtSec = 0` true for the incoming track's clock. A
    // gapless join is trimmed at the audible end for the same reason: `concat`
    // starts the next track wherever the first input stops, and the clock's
    // handover offset is only right if that is where it was told.
    ...(take > 0 ? ['-t', take.toFixed(3)] : []),
    '-i', fromPath,
    // The incoming track's opening silence is skipped: during a join it is a
    // gap in the middle of the fade, or at the head of a gapless one.
    ...(toOffset > 0 ? ['-ss', toOffset.toFixed(3)] : []),
    '-i', toPath,
    '-filter_complex', `${inputs}${join},${LIMITER}[out]`,
    '-map', '[out]',
    ...OPUS_OUTPUT,
  ];
}

/**
 * Start an ffmpeg that feeds the player, with its stderr drained.
 *
 * Draining matters more than it looks. Nothing read these processes' stderr,
 * and a pipe nobody reads holds 64 KB before the writer blocks: a damaged file
 * that logs an error for every frame would stall its own playback mid-song.
 * The tail is kept so an unexpected exit can say why.
 *
 * @param {string[]} args
 * @param {string} label For the log.
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnDecoder(args, label) {
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  ffmpeg.stderr.on('data', (chunk) => {
    tail = (tail + chunk).slice(-2048);
  });
  ffmpeg.on('error', (error) => console.error(`[${label}] ffmpeg:`, error.message));
  ffmpeg.on('close', (code, signal) => {
    // Killed on purpose by every skip, seek and join; only an exit nobody asked
    // for is worth a line.
    if (code && signal !== 'SIGKILL') {
      console.error(`[${label}] ffmpeg exited ${code}: ${tail.trim().split('\n').pop() ?? ''}`);
    }
  });
  return ffmpeg;
}

export class GuildPlayer {
  /** @param {string} guildId */
  constructor(guildId) {
    this.guildId = guildId;
    this.channelId = null;
    /** Up to three parallel playlists for collaborative sessions. */
    this.decks = new DeckSet();

    /** Score for the current track, or null while analysis runs. */
    this.score = null;
    this.analysing = false;
    /** Local audio file for the current track. */
    this.audioPath = null;
    /** Seconds skipped by the last seek, added to the transmitted duration. */
    this.seekOffsetSec = 0;

    /**
     * How long one track fades into the next, in seconds. 0 is a gapless join.
     *
     * Room-wide rather than per-viewer, like every other transport setting:
     * there is one stream and everyone hears it.
     */
    this.crossfadeSec = 0;
    /** Whether transitions are joined at all, gapless or faded. */
    this.smoothTransitions = false;

    /**
     * Local file for the track fetched ahead, so a transition has something to
     * fade into without waiting for a download.
     *
     * `prefetchUpcoming` was already fetching it and throwing the path away.
     * It carries the track's loudness gain and opening silence too, measured
     * before the track is marked ready, so a transition never waits on a
     * measurement at the moment it has to start.
     * @type {{key: string, path: string, gain?: number, leadInSec?: number}|null}
     */
    this.prefetched = null;

    /** Interval that watches for the transition point. @type {any} */
    this.transitionTimer = null;
    /**
     * A handover not yet made, or null.
     *
     * Holds the offset within the joined resource at which the incoming track
     * starts, so the queue advances - and the clock switches over - at the right
     * moment rather than on a wall-clock guess. Cleared the instant the handover
     * happens, because a stale one here stops the *next* transition ever arming.
     * @type {{startsAtSec: number, handoverAtSec: number, trackKey?: string,
     *   toGain?: number, toOffsetSec?: number}|null}
     */
    this.transition = null;
    /**
     * The ffmpeg currently feeding the player, if any.
     *
     * Tracked separately from {@link transition} because the two have different
     * lifetimes: the handover is over in a fraction of a second, while the
     * decoder behind it goes on producing the whole of the incoming track. Left
     * unkilled, every skip during a joined stream leaks a process that decodes
     * a song nobody is listening to.
     * @type {any}
     */
    this.decoder = null;

    /**
     * Loudness-matching gain for the track now playing, in dB, so a seek
     * restarts it at the same level rather than at unity.
     */
    this.gainDb = 0;

    /**
     * Counts every deliberate change to what is playing.
     *
     * Starting a track awaits a download and a measurement, and two starts can
     * overlap: skip twice quickly and both are in flight. Whichever finished
     * last used to win, so a slow first download could play its song under the
     * second one's title. A start that sees this move while it waited stands
     * down instead. Stopping moves it too, which is what stops a download that
     * lands after /stop from starting the song anyway.
     */
    this.generation = 0;

    /** Last fade point computed, keyed on the score it came from. */
    this.mixOutMemo = null;

    /**
     * Supplied by the server: given a track, download its audio and return the
     * path. Injected rather than imported so this module stays free of provider
     * and filesystem policy.
     * @type {null | ((track: object) => Promise<string>)}
     */
    this.loadAudio = null;

    /**
     * Supplied by the server: a track's loudness, true peak and opening
     * silence, cached per track. Optional - without it every track plays at
     * unity gain through the limiter, which is the old behaviour less the
     * clipping.
     * @type {null | ((track: object, audioPath: string) =>
     *   Promise<{lufs: number, truePeak: number, leadInSec?: number}|null>)}
     */
    this.measureLoudness = null;
    /** Identity of the track being fetched ahead, so only one runs at a time. */
    this.prefetching = null;

    /**
     * Called after a new track starts, so the server can analyse it.
     * @type {null | ((track: object, audioPath: string) => void)}
     */
    this.onTrackStart = null;

    /**
     * Called when a prefetched track's audio lands on disk.
     *
     * Separate from {@link onTrackStart} because it fires while the *previous*
     * track is still playing, so anything it triggers must not touch the
     * player's visible state. It exists so the analyser can have a score ready
     * before the track is audible rather than starting once it already is.
     *
     * @type {((track: object, audioPath: string) => void)|null}
     */
    this.onPrefetch = null;

    /**
     * Called when nothing is left to play, so the channel can be told rather
     * than the music simply stopping with no explanation.
     * @type {null | (() => void)}
     */
    this.onQueueEnd = null;

    this.player = createAudioPlayer({
      behaviors: {
        // Keep playing when no one is subscribed: the Activity may still be
        // open, and stopping would desync anyone who rejoins.
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: 250,
      },
    });

    this.player.on('error', (error) => {
      console.error(`[voice ${guildId}] ${error.message}`);
      // A decode failure should skip the bad track, not wedge the queue.
      this.advance(true).catch(() => {});
    });

    /** The resource currently expected to be playing. */
    this.currentResource = null;

    // Identity comparison rather than a flag: the previous design set
    // `expectIdle = true` and cleared it synchronously, while the Idle event it
    // was guarding arrives asynchronously - so a seek or a track change could
    // trigger a spurious advance and skip a song.
    //
    // The comparison only protects anything when a resource is disowned
    // *before* the decoder feeding it is killed, which is `retireAudio`'s job.
    // Killing first let the drained stream arrive here still marked as ours.
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status !== oldState.status) {
        console.log(`[voice ${guildId}] ${oldState.status} -> ${newState.status}`);
      }
      if (newState.status !== AudioPlayerStatus.Idle) return;
      if (oldState.status === AudioPlayerStatus.Idle) return;
      // Only the resource we started should advance the queue when it ends.
      if (oldState.resource !== this.currentResource) return;
      this.currentResource = null;
      this.advance(false).catch((error) => {
        console.error(`[voice ${guildId}] advance failed:`, error.message);
      });
    });
  }

  /**
   * The active deck's queue.
   *
   * A read-through accessor rather than a rename: playback always draws from
   * whichever deck is selected, and keeping the name means the queue logic and
   * its call sites are untouched by decks existing.
   *
   * @returns {import('./queue.js').Queue}
   */
  get queue() {
    return this.decks.queue;
  }

  /**
   * Join a voice channel and subscribe the player.
   *
   * @param {import('discord.js').VoiceBasedChannel} channel
   */
  async connect(channel) {
    const existing = getVoiceConnection(this.guildId);
    if (existing && this.channelId === channel.id) {
      existing.subscribe(this.player);
      return;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    // Discord occasionally moves connections; resume rather than dying.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connection.subscribe(this.player);
    this.channelId = channel.id;
  }

  /**
   * Start the queue's current track.
   *
   * @returns {Promise<object|null>} The track that started.
   */
  async startCurrent() {
    const track = this.queue.current();
    if (!track) return null;

    this.retireAudio();
    const generation = this.generation;
    this.releaseAudio();
    this.score = null;
    this.seekOffsetSec = 0;

    const audioPath = await this.loadAudio(track);
    const { gain } = await this.levelsFor(track, audioPath);
    // Superseded while it waited: a newer start, a skip or a stop owns the
    // player now, and playing this would put one song under another's title.
    if (generation !== this.generation) return this.queue.current();

    // Recorded once the audio is certain to start, not before the download: a
    // start that was superseded was never heard.
    this.rememberPlayed(track);
    this.audioPath = audioPath;
    this.gainDb = gain;
    // Our own decoder rather than handing discord.js the file, so this path
    // gets the same loudness matching and limiter as every other.
    this.decoder = spawnDecoder(playbackArgs({ file: audioPath, gain }), `voice ${this.guildId}`);
    const resource = createAudioResource(this.decoder.stdout, { inputType: StreamType.OggOpus });
    this.currentResource = resource;
    this.player.play(resource);

    this.onTrackStart?.(track, this.audioPath);
    // Deliberately not awaited: the point is that it happens during playback.
    this.prefetchUpcoming();
    this.armTransition();
    return track;
  }

  /**
   * Watch for the point at which the next track should start coming in.
   *
   * ## Why this is not a timeout
   *
   * The obvious implementation aims a `setTimeout` at `duration - fade`. That
   * is a wall clock, and playback is not: the timer keeps counting through a
   * pause and fires at a position the track left long ago after a seek. Polling
   * the transmitted position asks the only question that matters and is right
   * in both cases.
   */
  armTransition() {
    this.stopTransitionTimer();
    if (!this.smoothTransitions) return;

    const track = this.queue.current();
    const stated = Number(track?.durationSec) || 0;
    // Without a duration there is no "near the end" to detect, so the track
    // ends the way it always did. Live streams and anything the provider gave
    // no length for land here.
    if (stated <= 0) return;

    // The stated length goes in, not a fade point. Where the fade belongs
    // depends on the score, and the score does not exist yet: `onTrackStart`
    // has only just asked for it, and even a cache hit is a file read away.
    // This used to compute the point here, once, against that null score - so
    // every transition was aimed at the end of the *file*, trailing silence and
    // all, and the audible-end logic never ran outside a seek. The watcher now
    // asks on every tick, and picks the score up the moment it lands.
    this.transitionTimer = setInterval(() => {
      this.checkTransition(stated).catch((error) => {
        console.error(`[voice ${this.guildId}] transition failed:`, error.message);
        this.cancelTransition();
      });
    }, TRANSITION_TICK_MS);
  }

  /**
   * Where to let go of the current track, from its score when there is one.
   *
   * Memoised on the score object: the watcher asks ten times a second, and the
   * answer only changes when the provisional score is replaced by the full one
   * or the setting moves between crossfade and gapless.
   *
   * @param {number} stated The provider's duration, in seconds.
   * @returns {{at: number, fromScore: boolean}}
   */
  mixOutSec(stated) {
    const crossfade = this.crossfadeSec > 0;
    const memo = this.mixOutMemo;
    if (memo && memo.score === this.score && memo.crossfade === crossfade
        && memo.stated === stated) {
      return memo.value;
    }
    const value = mixOutPoint(this.score, stated, crossfade);
    this.mixOutMemo = { score: this.score, crossfade, stated, value };
    return value;
  }

  /**
   * The loudness gain and opening silence for a track. Never throws.
   *
   * @param {object} track
   * @param {string} audioPath
   * @returns {Promise<{gain: number, leadInSec: number}>}
   */
  async levelsFor(track, audioPath) {
    if (!this.measureLoudness) return { gain: 0, leadInSec: 0 };
    try {
      const measured = await this.measureLoudness(track, audioPath);
      return { gain: gainDb(measured), leadInSec: measured?.leadInSec ?? 0 };
    } catch {
      return { gain: 0, leadInSec: 0 };
    }
  }

  stopTransitionTimer() {
    if (this.transitionTimer) clearInterval(this.transitionTimer);
    this.transitionTimer = null;
  }

  /**
   * Drop any pending or in-flight transition's bookkeeping.
   *
   * Only the bookkeeping. This used to kill the decoder too, which was right
   * while the decoder could only be a transition's - and wrong once a seek or a
   * completed join left the rest of the song playing through it: switching
   * transitions off killed the song and started the next. Stopping audio is
   * {@link retireAudio}'s job, because it has to disown the resource first.
   */
  cancelTransition() {
    this.stopTransitionTimer();
    this.transition = null;
  }

  /**
   * Stop whatever is feeding the player, on purpose.
   *
   * Anything that changes what is playing comes through here: a skip, a seek,
   * a jump, a new track or a stop. Each invalidates a transition scheduled
   * against the track that was playing, and each has to take the old audio
   * away without the player mistaking that for the track ending by itself.
   *
   * ## The order is the fix
   *
   * The resource is disowned *before* its decoder is killed. Killing ends the
   * stream; the player drains it and goes Idle a few frames later; and the
   * Idle handler advances the queue for any resource still marked as the one
   * playing. `advance` and `startCurrent` used to kill first and only replace
   * the resource after awaiting a download, so that stale Idle landed in the
   * gap and advanced the queue a second time.
   *
   * Measured with a real AudioPlayer and a 500 ms download standing in for a
   * fetch: skipping from A in a queue of A, B, C started B and then C;
   * skipping on the last track announced the end of the queue twice - the
   * doubled "Queue finished" seen in a live channel; and switching transitions
   * off mid-song killed the song and started the next. Every track after a
   * seek or a join played through our own decoder and was exposed, which with
   * crossfade on is every track after the first.
   */
  retireAudio() {
    this.generation += 1;
    this.currentResource = null;
    this.cancelTransition();
    this.killDecoder();
  }

  /**
   * Stop whichever ffmpeg is feeding the player.
   *
   * Each one is a full decode of an entire song, so leaving them running is not
   * a tidiness point: skipping through a queue with transitions on would pile up
   * one decoder per skip, all of them working.
   */
  killDecoder() {
    if (!this.decoder) return;
    try {
      this.decoder.kill('SIGKILL');
    } catch {
      // Already gone, which is the outcome this wanted anyway.
    }
    this.decoder = null;
  }

  /**
   * One tick of the transition watcher.
   *
   * Does two jobs, in this order: hand over the clock when a transition already
   * running reaches the incoming track, and start one when the outgoing track
   * gets near enough to its end.
   *
   * @param {number} stated The outgoing track's stated length, in seconds.
   */
  async checkTransition(stated) {
    if (this.transition) {
      // `playbackDuration` counts from the start of the joined resource, and
      // the incoming track begins at a known offset within it. Reaching that
      // offset is the moment the queue moves on.
      const elapsed = (this.player.state.resource?.playbackDuration ?? 0) / 1000;
      // `handoverAtSec`, not `startsAtSec`: see where the transition is built.
      // Falls back for a transition set without one, which is how the older
      // tests construct it.
      const handover = this.transition.handoverAtSec ?? this.transition.startsAtSec;
      if (elapsed >= handover) this.completeTransition();
      return;
    }

    const lead = this.crossfadeSec > 0 ? this.crossfadeSec : GAPLESS_LEAD_SEC;
    const position = this.positionSec();
    let mixOut = this.mixOutSec(stated);
    // Seeked past where the fade would have begun: someone chose to hear the
    // outro. Letting go at the audible end instead keeps the watcher from
    // cutting straight to the next track the moment it notices.
    if (mixOut.fromScore && position > mixOut.at) {
      mixOut = mixOutPoint(this.score, stated, false);
    }
    if (position < mixOut.at - lead) {
      // The prefetch used to be kicked off only on a track change, so a track
      // queued *during* playback was never fetched and `startTransition` bailed
      // silently on the file not being on disk. Queueing the next song while
      // the current one plays is the normal way the queue gets used, which is
      // why the crossfade appeared to work only sometimes. This is idempotent -
      // it returns immediately once the file is there.
      this.prefetchUpcoming();
      return;
    }

    // Only one attempt per track. Whether it succeeds or gives up, the watcher
    // stops here - a failed attempt retried every tick would spawn a decoder
    // ten times a second for the rest of the track.
    this.stopTransitionTimer();
    await this.startTransition(stated, mixOut);
  }

  /**
   * Join the outgoing track to the incoming one in a single stream.
   *
   * ## Why one resource covers two tracks
   *
   * An `AudioPlayer` plays one resource at a time, and a voice connection
   * subscribes to one player - so there is no arrangement of the discord.js
   * pieces that has two tracks audible at once. The mixing has to happen before
   * the player sees it, and ffmpeg already does exactly this: `acrossfade`
   * takes the tail of one input and the head of another and returns one stream.
   *
   * The resource that results spans a track boundary, which sounds like it
   * should break the clock the visuals depend on. It does not, because the
   * boundary is at a known offset: `acrossfade` puts the incoming track's zero
   * at the start of the fade, and `concat` puts it at the end of the outgoing
   * tail. Either way `playbackDuration` minus that offset is the incoming
   * track's true position - still a measurement of audio actually transmitted,
   * which is the property that made the clock trustworthy in the first place.
   *
   * @param {number} stated The outgoing track's stated length, in seconds.
   * @param {{at: number, fromScore: boolean}} [mixOut] Where to let go of it.
   */
  async startTransition(stated, mixOut = { at: stated, fromScore: false }) {
    // The same lookup `prefetchUpcoming` uses, deliberately: the only file this
    // can join to is the one the prefetch decided to fetch.
    const next = this.queue.upcoming()[0];
    // Nothing to join to. The track ends and the Idle handler does whatever it
    // would have done anyway, including rolling onto another deck.
    if (!next?.providerId) return;

    const key = `${next.provider}:${next.providerId}`;
    // Only a file already on disk. Downloading here would stall the transition
    // past the end of the outgoing track, which is worse than the gap this
    // exists to remove.
    //
    // Every branch here logs. All three used to return in silence, so a
    // transition that did not happen produced no output whatsoever and the
    // only available report was "sometimes it doesn't activate" - accurate,
    // and impossible to act on.
    if (this.prefetched?.key !== key) {
      console.log(`[voice ${this.guildId}] no transition: "${next.title}" is `
        + `not downloaded yet (${this.prefetching === key
          ? 'still fetching' : 'no fetch in flight'})`);
      return;
    }
    const { path: nextPath, gain: toGain = 0, leadInSec = 0 } = this.prefetched;
    if (!this.audioPath) {
      console.log(`[voice ${this.guildId}] no transition: the outgoing track `
        + 'has no file on disk');
      return;
    }

    const position = this.positionSec();
    const tail = Math.max(0, mixOut.at - position);
    const fade = this.crossfadeSec;
    // A fade cannot be longer than what is left to fade out of. Near the end of
    // a track shorter than the setting, this shortens it rather than refusing.
    const effective = Math.min(fade, tail);
    // A gapless join takes the tail only up to the audible end, when the score
    // found one, so the trailing silence is not part of the join. Without a
    // score it keeps the rest of the file, as it always did: `tail` is then
    // measured from provider metadata, and trimming to that could cut real
    // audio or leave the handover offset out by however far the metadata is.
    const fromLength = mixOut.fromScore ? tail : undefined;

    // Whatever was feeding the player is replaced in this same tick, so the
    // old resource cannot go Idle in between and advance the queue.
    this.killDecoder();
    this.decoder = spawnDecoder(transitionArgs({
      fromPath: this.audioPath, toPath: nextPath, position, fade: effective,
      fromLength, toOffset: leadInSec, fromGain: this.gainDb, toGain,
    }), `voice ${this.guildId}`);
    const resource = createAudioResource(this.decoder.stdout, { inputType: StreamType.OggOpus });

    // Two different moments, and conflating them is what made the title wrong.
    //
    // `startsAtSec` is where the incoming track's zero sits inside the joined
    // resource, and the clock needs it: `acrossfade` puts that zero at the
    // start of the fade, `concat` puts it after the outgoing tail.
    //
    // `handoverAtSec` is when the incoming track becomes the one being heard,
    // which is what the title and the queue should follow. Under a crossfade
    // those are not the same instant. Handing over at `startsAtSec` flipped the
    // title the moment the fade began, so a 12 s crossfade spent its whole
    // length naming a song that was still fading in, while the outgoing track
    // was the louder of the two for the first half of it.
    //
    // Half the fade, because the curve is equal-power: `qsin` has the two
    // tracks at equal level exactly at the midpoint, so that is the moment the
    // incoming track takes over. A gapless join has no overlap at all, so its
    // handover stays where the audio actually changes.
    this.transition = {
      startsAtSec: effective > 0 ? 0 : tail,
      handoverAtSec: effective > 0 ? effective / 2 : tail,
      // Which track's audio is actually inside the joined resource. The queue
      // can be edited while the join plays, and without this the handover
      // advances to whatever is next *now* and attributes this audio to it.
      trackKey: key,
      toGain,
      // Where the incoming track's own clock starts inside its file: past the
      // silence the join skipped. The visuals index the score by this clock,
      // so an offset left at zero would run them behind the audio by exactly
      // the silence that was cut.
      toOffsetSec: leadInSec,
    };

    this.currentResource = resource;
    this.player.play(resource);
    // Position is now measured against the joined resource, and the outgoing
    // track's own offset within it is where it was when the join began.
    this.seekOffsetSec = position;

    console.log(`[voice ${this.guildId}] ${effective > 0
      ? `crossfading ${effective.toFixed(1)}s into` : 'joining'} "${next.title}"`);

    // Restart the watcher: it now has the handover to detect.
    this.transitionTimer = setInterval(() => {
      this.checkTransition(stated).catch(() => {});
    }, TRANSITION_TICK_MS);
  }

  /**
   * Hand the queue and the clock over to the incoming track.
   *
   * No audio starts here - it is already playing, inside the joined resource.
   * This is the bookkeeping that makes everything downstream agree about which
   * track that is: the queue advances, the score is dropped so the analyser
   * builds the incoming one's, and `seekOffsetSec` goes to the negative of the
   * boundary offset so `positionSec` reports the new track's own position.
   */
  completeTransition() {
    const startsAtSec = this.transition?.startsAtSec ?? 0;
    const toOffsetSec = this.transition?.toOffsetSec ?? 0;
    const toGain = this.transition?.toGain ?? 0;
    const joined = this.transition?.trackKey ?? null;

    // The queue can be edited while a join is playing. If the track that is
    // about to become current is no longer the one whose audio is in the
    // resource, handing over would attribute this audio to a different song:
    // the title would name it, and `onTrackStart` would hand the analyser that
    // track paired with this file. The score is cached by track, so that
    // mis-pairing does not pass when the song ends - it persists, and every
    // later play of that track gets another song's beats and sections.
    //
    // Measured before this guard: crossfading into B and removing B mid-fade
    // left the title reading C, `audioPath` pointing at B's file, and the
    // analyser called as ("C", "/cache/B.m4a").
    //
    // Killing the decoder ends the resource, which puts the player Idle and
    // sends it through `advance` - the ordinary path, which starts whatever is
    // genuinely next from its own file. That costs a gap, which is the right
    // trade for audio that is labelled correctly.
    if (joined) {
      const upcoming = this.queue.upcoming()[0];
      const actual = upcoming ? `${upcoming.provider}:${upcoming.providerId}` : null;
      if (actual !== joined) {
        console.log(`[voice ${this.guildId}] the queue changed under a join `
          + `(expected ${joined}, found ${actual ?? 'nothing'}); starting the `
          + 'next track cleanly instead of mislabelling this audio');
        this.transition = null;
        this.stopTransitionTimer();
        this.prefetched = null;
        this.killDecoder();
        return;
      }
    }
    // Cleared before anything below can return early, and before the timer is
    // re-armed. A handover left standing here is not untidiness: to
    // `checkTransition` a non-null transition means "still waiting to hand
    // over", so it returns on every tick - the next track would never arm one,
    // and every transition after this one would be a hard cut.
    this.transition = null;
    this.stopTransitionTimer();

    const track = this.queue.next(false);
    if (!track) {
      // The queue emptied under us between arming and arriving. The joined
      // resource still has the incoming audio in it, so let it play out; the
      // Idle handler will find nothing left and end the session properly.
      return;
    }

    this.rememberPlayed(track);
    this.score = null;
    // Subtracting the boundary rather than zeroing: `playbackDuration` keeps
    // counting from the start of the joined resource, so the new track's
    // position is that count minus where it began.
    // `|| 0` only to turn -0 into 0. A crossfade has no lead, so negating its
    // zero offset leaves a negative zero sitting in the player's state, which
    // is numerically fine and confusing to read in a log.
    //
    // Plus the silence the join skipped: the incoming track began that far
    // into its own file.
    this.seekOffsetSec = (toOffsetSec - startsAtSec) || 0;
    // So a seek on the new track restarts it at its own level.
    this.gainDb = toGain;

    // The incoming track's audio is inside the joined resource, so there is no
    // new file to load - but the analyser still needs a path, and the prefetch
    // is what put one on disk.
    const path = this.prefetched?.path ?? null;
    if (path) {
      this.audioPath = path;
      this.onTrackStart?.(track, path);
    }
    this.prefetched = null;
    this.prefetchUpcoming();
    // The next transition is armed against the *new* track's length.
    this.armTransition();
  }

  /**
   * Fetch the next track's audio while this one plays.
   *
   * Skipping used to cost a whole download before the button could answer,
   * because `advance` starts the next track and starting a track is what
   * fetches it. There are typically minutes of playback going spare in which to
   * do that work instead, and the downloader now reuses whatever is already on
   * disk - so by the time anyone presses skip the file is usually there and the
   * change is immediate.
   *
   * Failures are swallowed on purpose. This is speculative work: if the track
   * turns out to be unfetchable, that should surface when someone actually
   * asks for it, with the error that route already reports, rather than as a
   * mysterious log line during the previous song.
   */
  prefetchUpcoming() {
    if (!this.loadAudio) return;
    const next = this.queue.upcoming()[0];
    if (!next?.providerId) return;

    const key = `${next.provider}:${next.providerId}`;
    // Already on disk. This has to be checked as well as `prefetching`, because
    // the transition watcher now calls this every tick: without it, each tick
    // after a completed fetch would start the same download again.
    if (this.prefetched?.key === key) return;
    // One at a time, and never the same track twice: `startCurrent` runs on
    // every track change, and without this a long queue would start a fetch per
    // change and have several running at once.
    if (this.prefetching === key) return;
    this.prefetching = key;

    Promise.resolve(this.loadAudio(next))
      // The path is kept now, not discarded. A transition has to hand ffmpeg a
      // real file at the moment it starts, and this is the only place that
      // knows one is already on disk - the alternative is a download inside the
      // transition, which would stall past the end of the outgoing track.
      .then(async (path) => {
        if (!path || this.prefetching !== key) return;
        // Measured before the track is marked ready, so the join can be spawned
        // in the same tick it is decided rather than waiting on ffmpeg.
        const { gain, leadInSec } = await this.levelsFor(next, path);
        if (this.prefetching !== key) return;
        this.prefetched = { key, path, gain, leadInSec };
        // The file is on disk well before the track is heard, so the analysis
        // can happen now instead of at the handover - where it left the
        // incoming track playing with no visuals while it ran.
        this.onPrefetch?.(next, path);
      })
      .catch(() => {})
      .finally(() => {
        if (this.prefetching === key) this.prefetching = null;
      });
  }

  /**
   * Move to the next track and start it.
   *
   * @param {boolean} manual True when a user pressed skip.
   * @returns {Promise<object|null>} The new track, or null when the queue ends.
   */
  async advance(manual) {
    // A skip lands here with a transition possibly already mixing the *next*
    // track in. Retired before the queue moves rather than after a download:
    // see `retireAudio` for the double advance the other order caused.
    this.retireAudio();
    let next = this.queue.next(manual);

    // A deck running dry while others still hold tracks would leave the room in
    // silence during a shared session, so playback rolls onto the next deck
    // that has something queued.
    if (!next) {
      const continuation = this.decks.nextNonEmpty();
      if (continuation !== null) {
        this.decks.switchTo(continuation);
        if (this.queue.index < 0) this.queue.index = 0;
        next = this.queue.current();
      }
    }

    if (!next) {
      // Stopped outright. Otherwise a skip on the last track left the song
      // playing and announced the end of the queue again when it finished.
      this.player.stop(true);
      this.releaseAudio();
      this.score = null;
      this.onQueueEnd?.();
      return null;
    }
    return this.startCurrent();
  }

  /** Step back and start the previous track. @returns {Promise<object|null>} */
  async previous() {
    this.queue.previous();
    return this.startCurrent();
  }

  /**
   * Jump to a queue position and start it.
   *
   * @param {number} position
   * @returns {Promise<object|null>}
   */
  async jumpTo(position) {
    if (!this.queue.jumpTo(position)) return null;
    return this.startCurrent();
  }

  /**
   * Restart the current track at an offset.
   *
   * @param {number} seconds Target position.
   * @returns {boolean} False when there is nothing to seek.
   */
  seek(seconds) {
    if (!this.audioPath) return false;
    const target = Math.max(0, seconds);

    // A transition was scheduled against a position this track is no longer at,
    // and an in-flight one is mixing in a track the user has just seeked away
    // from. Both are stale the moment a seek lands.
    this.retireAudio();

    // At the track's own loudness gain, through the same limiter as a normal
    // start. This path was 16-bit PCM before, which is where a hot master's
    // overs were hard-clipped - the same song clean until someone seeked.
    // Tracked so the next thing to replace the resource kills it: scrubbing the
    // bar spawns one of these per drop.
    this.decoder = spawnDecoder(
      playbackArgs({ file: this.audioPath, position: target, gain: this.gainDb }),
      `voice ${this.guildId}`,
    );
    const resource = createAudioResource(this.decoder.stdout, { inputType: StreamType.OggOpus });
    this.currentResource = resource;
    this.player.play(resource);
    this.seekOffsetSec = target;
    // Re-armed against the seeked-to position, so seeking into the last few
    // seconds of a track still transitions rather than falling off the end.
    this.armTransition();
    return true;
  }

  /**
   * Set how long one track takes to fade into the next.
   *
   * A single control for both behaviours the slider offers: any positive value
   * is a crossfade of that length, and zero is a gapless join. "Off" is not a
   * position on the slider - it is the setting being absent, which is what
   * `smoothTransitions` records.
   *
   * Takes effect on the current track, not only the next one: re-arming here
   * means dragging the slider mid-song changes how *that* song ends.
   *
   * @param {number|null} seconds Null or a negative value turns joining off.
   * @returns {number} The value actually stored.
   */
  setCrossfade(seconds) {
    // `null` is tested before the conversion, not after: `Number(null)` is 0,
    // and 0 is a real setting here - a gapless join. Converting first turned
    // every "off" into "join every track with no fade", which is the one
    // outcome the caller definitely did not ask for.
    const value = seconds === null || seconds === undefined ? NaN : Number(seconds);
    if (!Number.isFinite(value) || value < 0) {
      this.smoothTransitions = false;
      this.crossfadeSec = 0;
      // A join already mixing is left to finish: its handover still has to
      // happen, or the queue would never move on while the next song plays.
      // Nothing is killed. This used to kill the decoder, which after any seek
      // or completed join is the one carrying the song, so switching
      // transitions off skipped the track.
      if (!this.transition) this.stopTransitionTimer();
      console.log(`[voice ${this.guildId}] transitions off`);
      return 0;
    }
    this.smoothTransitions = true;
    this.crossfadeSec = Math.min(MAX_CROSSFADE_SEC, value);
    // Logged because there is no other way to tell a setting that never arrived
    // from one that arrived and did nothing - and those two have completely
    // different causes. Without this the only evidence is the absence of a
    // transition line, which both produce.
    console.log(`[voice ${this.guildId}] transitions ${this.crossfadeSec > 0
      ? `crossfade ${this.crossfadeSec}s` : 'gapless'}`);
    // Only the pending transition is dropped. One already mixing is audible
    // right now, and cutting it to apply a new length would be a jump - exactly
    // the thing the setting exists to remove.
    if (!this.transition) this.armTransition();
    return this.crossfadeSec;
  }

  /** @returns {boolean} True if playback was paused. */
  pause() {
    return this.player.pause(true);
  }

  /** @returns {boolean} True if playback resumed. */
  resume() {
    return this.player.unpause();
  }

  /**
   * Current playback position in seconds.
   *
   * `playbackDuration` restarts at zero for each resource, so a seek offset is
   * added back to recover the true position within the track.
   */
  positionSec() {
    const state = this.player.state;
    if (state.status === AudioPlayerStatus.Idle) return 0;
    return this.seekOffsetSec + (state.resource?.playbackDuration ?? 0) / 1000;
  }

  /** @returns {boolean} */
  isPlaying() {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  /** @returns {boolean} */
  isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused
      || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  /** Stop playback, clear the queue and leave the channel. */
  stop() {
    this.retireAudio();
    this.prefetched = null;
    this.player.stop(true);
    this.releaseAudio();
    for (const deck of this.decks.decks) deck.queue.clear();
    this.score = null;
    getVoiceConnection(this.guildId)?.destroy();
    this.channelId = null;
  }

  /** Delete the temporary audio file for the finished track. */
  releaseAudio() {
    // The file is kept, not deleted.
    //
    // Deleting it here threw away the one thing that makes going back
    // instant, and it fought the 3GB least-recently-used cache the download
    // path already maintains: every skip backwards re-fetched a track that had
    // been on disk seconds earlier. Letting the cache do its job means
    // "previous" is usually free, and the budget still bounds the directory.
    this.audioPath = null;
  }

  /**
   * Stable identity for the score currently loaded, or null if there is none.
   *
   * Two flags form part of the identity so the client refetches when a
   * provisional score is upgraded to the full one, and again when the
   * transcription pass adds lyrics to an already-full score.
   *
   * Shared by `snapshot()` and the `/api/score` route so the id the client is
   * told to expect and the id the response is cached and tagged under cannot
   * drift apart - if they did, viewers would be served a stale score forever,
   * because the client only refetches when the id changes.
   *
   * @returns {string|null}
   */
  scoreId() {
    if (!this.score) return null;
    const track = this.queue.current();
    return `${track?.provider}-${track?.providerId}`
      + `-${this.score.analysis?.is_partial ? 'q' : 'f'}`
      + `${this.score.lyrics ? 'L' : ''}`;
  }

  /**
   * Lightweight state for the Activity, polled once a second.
   *
   * Deliberately excludes the score. A full-track score is around a megabyte of
   * JSON - 6,000 frames across seven lanes - and serialising that every second
   * blocked the event loop hard enough to disturb the audio player's 20ms packet
   * timer, which was audible as the track drifting faster and slower and as a
   * laggy pause button. The client fetches the score separately, once, whenever
   * `scoreId` changes.
   *
   * @returns {object}
   */
  snapshot() {
    const track = this.queue.current();
    return {
      track,
      scoreId: this.scoreId(),
      analysing: this.analysing,
      positionSec: this.positionSec(),
      durationSec: track?.durationSec ?? 0,
      playing: this.isPlaying(),
      paused: this.isPaused(),
      // So a viewer opening the settings menu sees where the slider actually
      // is, rather than where their own browser last left it - the setting is
      // room-wide and anyone can have moved it.
      crossfadeSec: this.smoothTransitions ? this.crossfadeSec : null,
      queue: this.queue.toJSON(),
      decks: this.decks.toJSON(),
      recent: this.recent ?? [],
    };
  }

  /**
   * Keep the last few tracks that actually started playing.
   *
   * So a song can be found again without retyping it - the case being someone
   * who has just heard something, did not favourite it at the time, and now
   * wants it in a playlist. Recorded at the point audio starts rather than when
   * a track is queued, because a queued track that was skipped past was never
   * really heard and is not what anyone is looking for.
   *
   * Held in memory only. It is a convenience for the current session, not a
   * listening history, and writing one to disk would turn a small feature into
   * a record of what a room plays.
   *
   * @param {object} track
   */
  rememberPlayed(track) {
    if (!this.recent) this.recent = [];
    const key = `${track.provider}:${track.providerId}`;
    // Replaying something moves it to the front rather than duplicating it.
    this.recent = this.recent.filter(
      (entry) => `${entry.provider}:${entry.providerId}` !== key,
    );
    this.recent.unshift({
      provider: track.provider,
      providerId: track.providerId,
      title: track.title,
      artist: track.artist ?? null,
      durationSec: track.durationSec ?? 0,
      thumbnail: track.thumbnail ?? null,
    });
    if (this.recent.length > RECENT_TRACKS) this.recent.length = RECENT_TRACKS;
  }
}

/**
 * Log the voice toolchain at boot.
 *
 * Silent playback is almost always a missing Opus encoder, a missing encryption
 * library or an ffmpeg that cannot be found - none of which raise an error, they
 * just produce no sound. Printing the report turns a mystery into a line of
 * output.
 */
export function logVoiceDependencies() {
  const report = generateDependencyReport();
  const opus = /- (@discordjs\/opus|opusscript): (?!not found)/.test(report);
  const encryption = /- (sodium-native|sodium|libsodium-wrappers|@stablelib|@noble)[^:]*: (?!not found)/
    .test(report) || /aes-256-gcm: yes/.test(report);
  const ffmpeg = /FFmpeg\n- version: (?!not found)/.test(report);

  console.log(`voice: opus=${opus ? 'ok' : 'MISSING'} `
    + `encryption=${encryption ? 'ok' : 'MISSING'} `
    + `ffmpeg=${ffmpeg ? 'ok' : 'MISSING'}`);

  if (!opus || !encryption || !ffmpeg) {
    console.log('--- voice dependency report ---');
    console.log(report);
  }
}

/** Get or create the player for a guild. @param {string} guildId */
export function getPlayer(guildId) {
  let player = players.get(guildId);
  if (!player) {
    player = new GuildPlayer(guildId);
    players.set(guildId, player);
  }
  return player;
}

/**
 * Find the player attached to a voice channel.
 *
 * The Activity knows its channel but not its guild, so lookups arrive by
 * channel ID.
 *
 * @param {string} channelId
 * @returns {GuildPlayer|undefined}
 */
export function findPlayerByChannel(channelId) {
  for (const player of players.values()) {
    if (player.channelId === channelId) return player;
  }
  return undefined;
}

/** Stop every player, so the bot leaves channels cleanly on shutdown. */
export function stopAll() {
  for (const player of players.values()) player.stop();
}
