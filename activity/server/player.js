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
import { createReadStream } from 'node:fs';
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

/** @type {Map<string, GuildPlayer>} */
const players = new Map();

/**
 * How many recently played tracks to remember per player.
 *
 * Seven, because the panel that shows them is a convenience under the search
 * box rather than a history: enough to cover a session's worth of "what was
 * that one", short enough that it never becomes a list to scroll.
 */
const RECENT_TRACKS = 7;

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
 * input option rather than decoding the whole file first. Peak level through
 * the fade went 0.087 at the start, 0.078 in the middle, 0.088 after: a slight
 * dip and no bump, which is the equal-gain behaviour `tri` is chosen for.
 *
 * @param {object} options
 * @param {string} options.fromPath Outgoing track's file.
 * @param {string} options.toPath Incoming track's file.
 * @param {number} options.position Where the outgoing track is now, in seconds.
 * @param {number} options.fade Crossfade length in seconds; 0 joins gaplessly.
 * @returns {string[]}
 */
export function transitionArgs({ fromPath, toPath, position, fade }) {
  const filter = fade > 0
    // `tri` on both sides: equal-gain rather than equal-power. Equal-power
    // holds the sum roughly constant, which is right for uncorrelated material
    // and wrong here - two tracks at similar loudness sum to an audible bump in
    // the middle of every transition.
    //
    // The limiter is not optional. Modern masters peak within a whisker of full
    // scale, so two of them at half gain reach it exactly and any correlation
    // goes over: measured on two cached tracks, the fade peaked at 1.0000 with
    // six samples pinned at full scale, which is audible as a crackle right in
    // the middle of the transition. At limit 0.97 the peak lands at 0.9742 with
    // none pinned, and RMS moves 0.1543 to 0.1534 - a twentieth of a percent,
    // so it costs no loudness worth hearing.
    //
    // `level=disabled` stops alimiter normalising the whole stream up to its
    // ceiling, which would make every track after a transition louder than it
    // was before one.
    ? `[0:a][1:a]acrossfade=d=${fade.toFixed(3)}:c1=tri:c2=tri,`
      + 'alimiter=limit=0.97:attack=5:release=50:level=disabled[out]'
    // `concat` plays one track then the other and never sums them, so there is
    // nothing here that can clip.
    : '[0:a][1:a]concat=n=2:v=0:a=1[out]';

  return [
    '-loglevel', 'error',
    // Before -i, so this is a container-index seek rather than a decode from
    // the start of the file - the same reason `seek()` puts it there.
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
    // what makes `startsAtSec = 0` true for the incoming track's clock.
    ...(fade > 0 ? ['-t', fade.toFixed(3)] : []),
    '-i', fromPath,
    '-i', toPath,
    '-filter_complex', filter,
    '-map', '[out]',
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ];
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
     * @type {{key: string, path: string}|null}
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
     * @type {{startsAtSec: number}|null}
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
     * Supplied by the server: given a track, download its audio and return the
     * path. Injected rather than imported so this module stays free of provider
     * and filesystem policy.
     * @type {null | ((track: object) => Promise<string>)}
     */
    this.loadAudio = null;
    /** Identity of the track being fetched ahead, so only one runs at a time. */
    this.prefetching = null;

    /**
     * Called after a new track starts, so the server can analyse it.
     * @type {null | ((track: object, audioPath: string) => void)}
     */
    this.onTrackStart = null;

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

    this.cancelTransition();
    this.rememberPlayed(track);
    this.releaseAudio();
    this.score = null;
    this.seekOffsetSec = 0;

    this.audioPath = await this.loadAudio(track);

    const resource = createAudioResource(createReadStream(this.audioPath), {
      inputType: StreamType.Arbitrary,
    });
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
    // Only a crossfade wants the audible end. A gapless join plays the outgoing
    // track through to its real end and then continues, so trimming its outro
    // would be removing part of the song for no reason - and it would put the
    // handover offset out by the length of that outro, because `concat` keeps
    // audio the audible end says is not there.
    const duration = this.crossfadeSec > 0 ? this.audibleEndSec(stated) : stated;

    this.transitionTimer = setInterval(() => {
      this.checkTransition(duration).catch((error) => {
        console.error(`[voice ${this.guildId}] transition failed:`, error.message);
        this.cancelTransition();
      });
    }, TRANSITION_TICK_MS);
  }

  /**
   * Where the track stops being audible, rather than where its file ends.
   *
   * ## Why a crossfade against the stated duration is inaudible
   *
   * Almost every produced track ends by decaying to silence, and fading the
   * last few seconds before the stated end means fading that decay - so there
   * is nothing left of the outgoing track to cross with. Measured on a real
   * pair from the cache: the last six seconds of the outgoing track run 0.021,
   * 0.010, 0.005, 0.002, 0.0002, 0.000 RMS. By two seconds in it is already a
   * fiftieth of its level, and the "crossfade" is silence fading into the next
   * song - which is exactly what a hard skip sounds like.
   *
   * The energy lane already knows where the music stops. Walking back from the
   * end to the last frame above the floor puts the fade over material that is
   * actually playing, so the two tracks genuinely overlap.
   *
   * Falls back to the stated duration whenever the score cannot answer: a
   * partial score covers only the opening of the track, so its lane ends long
   * before the music does and trusting it would cut every track short.
   *
   * @param {number} stated The provider's duration, in seconds.
   * @returns {number}
   */
  audibleEndSec(stated) {
    const lanes = this.score?.lanes;
    if (this.score?.analysis?.is_partial) return stated;
    if (!lanes?.fps || !Array.isArray(lanes.energy) || lanes.energy.length === 0) {
      return stated;
    }
    // Lane values are normalised 0-1 and rounded to 3dp, so the floor has to
    // sit above the rounding rather than at zero.
    const FLOOR = 0.02;
    for (let i = lanes.energy.length - 1; i >= 0; i--) {
      if (lanes.energy[i] > FLOOR) {
        const end = (i + 1) / lanes.fps;
        // Never past the stated end, and never so early that the track would
        // lose a recognisable amount of itself to a bad analysis.
        return Math.max(stated * 0.75, Math.min(stated, end));
      }
    }
    return stated;
  }

  /** Stop the watcher without disturbing a transition already under way. */
  stopTransitionTimer() {
    if (this.transitionTimer) clearInterval(this.transitionTimer);
    this.transitionTimer = null;
  }

  /**
   * Abandon any pending or in-flight transition.
   *
   * Anything that changes what is playing has to call this: a skip, a seek, a
   * jump or a stop all invalidate a transition that was scheduled against a
   * track that is no longer the one playing. Leaving one armed would splice the
   * previous track's successor into whatever the user actually asked for.
   */
  cancelTransition() {
    this.stopTransitionTimer();
    this.transition = null;
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
   * @param {number} duration Length of the outgoing track, in seconds.
   */
  async checkTransition(duration) {
    if (this.transition) {
      // `playbackDuration` counts from the start of the joined resource, and
      // the incoming track begins at a known offset within it. Reaching that
      // offset is the moment the queue moves on.
      const elapsed = (this.player.state.resource?.playbackDuration ?? 0) / 1000;
      if (elapsed >= this.transition.startsAtSec) this.completeTransition();
      return;
    }

    const lead = this.crossfadeSec > 0 ? this.crossfadeSec : GAPLESS_LEAD_SEC;
    if (this.positionSec() < duration - lead) return;

    // Only one attempt per track. Whether it succeeds or gives up, the watcher
    // stops here - a failed attempt retried every tick would spawn a decoder
    // ten times a second for the rest of the track.
    this.stopTransitionTimer();
    await this.startTransition(duration);
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
   * @param {number} duration Length of the outgoing track, in seconds.
   */
  async startTransition(duration) {
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
    if (this.prefetched?.key !== key) return;
    const nextPath = this.prefetched.path;
    if (!this.audioPath) return;

    const position = this.positionSec();
    const tail = Math.max(0, duration - position);
    const fade = this.crossfadeSec;
    // A fade cannot be longer than what is left to fade out of. Near the end of
    // a track shorter than the setting, this shortens it rather than refusing.
    const effective = Math.min(fade, tail);

    // Whatever was feeding the player is about to be replaced.
    this.killDecoder();
    const ffmpeg = spawn('ffmpeg', transitionArgs({
      fromPath: this.audioPath, toPath: nextPath, position, fade: effective,
    }));
    ffmpeg.on('error', (error) => console.error('[transition] ffmpeg:', error.message));
    this.decoder = ffmpeg;

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    // The incoming track's zero: immediate under a crossfade, after the
    // outgoing tail under a gapless join.
    this.transition = { startsAtSec: effective > 0 ? 0 : tail };

    this.currentResource = resource;
    this.player.play(resource);
    // Position is now measured against the joined resource, and the outgoing
    // track's own offset within it is where it was when the join began.
    this.seekOffsetSec = position;

    console.log(`[voice ${this.guildId}] ${effective > 0
      ? `crossfading ${effective.toFixed(1)}s into` : 'joining'} "${next.title}"`);

    // Restart the watcher: it now has the handover to detect.
    this.transitionTimer = setInterval(() => {
      this.checkTransition(duration).catch(() => {});
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
    this.seekOffsetSec = -startsAtSec || 0;

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
      .then((path) => {
        if (path && this.prefetching === key) this.prefetched = { key, path };
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
    // track in. `startCurrent` cancels it too, but the queue-end branch below
    // returns before reaching it.
    this.cancelTransition();
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
    this.cancelTransition();

    // ffmpeg decodes from the offset and emits raw PCM; -ss before -i seeks by
    // container index, which is near-instant.
    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-ss', String(target),
      '-i', this.audioPath,
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      'pipe:1',
    ]);
    ffmpeg.on('error', (error) => console.error('[seek] ffmpeg:', error.message));
    // Tracked so the next thing to replace the resource kills it. Scrubbing the
    // bar spawns one of these per drop, and before this they all kept decoding.
    this.decoder = ffmpeg;

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
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
      this.cancelTransition();
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
    this.cancelTransition();
    this.prefetched = null;
    this.currentResource = null;
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
