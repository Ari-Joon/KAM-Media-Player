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
    return track;
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

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    this.currentResource = resource;
    this.player.play(resource);
    this.seekOffsetSec = target;
    return true;
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
