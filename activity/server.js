/**
 * Visualiser server: Discord bot + Activity host + score cache.
 *
 * One process does three jobs:
 *   - Runs the bot that handles /play and launches the Activity.
 *   - Serves the Activity client and exchanges its OAuth code.
 *   - Resolves tracks, analyses them, and caches the resulting VisualScore.
 *
 * Playback and analysis use the same temporary audio file. Provider adapters
 * obtain that file with yt-dlp, the voice player transmits it to Discord, and
 * the analyser deletes it when playback moves on. This behaviour is important
 * to describe accurately because provider terms and media rights still apply.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  ChannelType, InviteTargetType, MessageFlags, Events,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, AttachmentBuilder,
} from 'discord.js';
import {
  resolveTrack, fetchAudio, searchTracks, checkYtDlp, describeLink, PROVIDERS,
  licensingPosture,
} from './server/providers.js';
import { getPlayer, findPlayerByChannel, stopAll, logVoiceDependencies } from './server/player.js';
import { fetchClip, discard, uploadLimit, isEmbeddable, probe } from './server/embeds.js';
import { Favourites, avatarUrl } from './server/favourites.js';
import { Playlists, SLOTS } from './server/playlists.js';
import { TrafficSummary, requestLogger, logger } from './server/log.js';
import { AnalyserWorker } from './server/analyser.js';
import { TokenVerifier, AuthError, bearerToken } from './server/auth.js';
import { ArtistInfo } from './server/artistinfo.js';
import { fetchProxiedImage, ImageProxyError } from './server/imageproxy.js';
import { scoreCache, imageCache } from './server/cache.js';
import { loadConfig } from './server/config.js';
import { creditedArtists } from './client/artists.js';

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
  PORT, CACHE_DIR, PYTHON_BIN, VISUALCORE_PATH, CLIENT_DIR,
} = loadConfig(process.env);

// --- Analysis ---------------------------------------------------------------

/**
 * Persistent analysis worker.
 *
 * One long-lived Python process rather than one per track: spawning per track
 * measured 9-10 seconds on a four-minute file against 2.3-3.4 seconds warm, the
 * difference being numba JIT work that is not cached between processes.
 */
const analyser = new AnalyserWorker({
  pythonBin: PYTHON_BIN,
  visualcorePath: VISUALCORE_PATH,
});

/**
 * Second worker, for lyrics only.
 *
 * Transcription runs 10-30 seconds against the provisional score's 0.21, and a
 * worker serves one request at a time - so on a single worker a transcription
 * that had already started held the next track's first frame behind it. It is
 * in flight through roughly the first half-minute of every uncached track,
 * which is precisely when someone skips, so this was the common case rather
 * than the rare one.
 *
 * Deliberately not warmed at boot, unlike the main worker. Its cost is loading
 * the faster-whisper model, which is only worth paying if lyrics are actually
 * requested - and `TRANSCRIBE_LYRICS` may be off, or the dependency absent, in
 * which case this process is never spawned at all.
 */
const lyricsAnalyser = new AnalyserWorker({
  pythonBin: PYTHON_BIN,
  visualcorePath: VISUALCORE_PATH,
  label: 'lyrics',
});

/**
 * Version of the Python analyser, read once at boot.
 *
 * Part of the score cache key, so improving the analyser automatically
 * invalidates old scores rather than serving stale results forever.
 * @type {string}
 */
let analyserVersion = 'unknown';

/** Ask the analyser for its version. Called during warm-up. */
function readAnalyserVersion() {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, ['-c',
      'import visualcore; print(visualcore.ANALYSER_VERSION)'], {
      env: { ...process.env, PYTHONPATH: VISUALCORE_PATH },
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve('unknown'));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : 'unknown'));
  });
}

/**
 * Analyse a track in the background and attach the score when ready.
 *
 * Playback starts immediately; a full-track analysis takes tens of seconds and
 * making users wait for it before hearing anything would be the wrong trade.
 * The Activity polls and begins rendering the moment the score lands.
 *
 * @param {import('./server/player.js').GuildPlayer} player
 * @param {object} track
 * @param {string} audioPath
 */
async function attachScore(player, track, audioPath) {
  const cachePath = path.join(
    CACHE_DIR, `${track.provider}-${track.providerId}-a${analyserVersion}.json`,
  );

  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    player.score = cached;
    player.analysing = false;
    log.debug(`score cache hit: ${track.title}`);
    return;
  } catch {
    // Normal for a track nobody has played before.
  }

  player.analysing = true;
  const startedAt = Date.now();

  // Provisional score from the opening of the track. Measured at 0.21s against
  // 2.46s for a full four-minute analysis, so visuals appear almost at once
  // rather than after a wait that felt like buffering.
  try {
    const quick = await analyser.analyse(audioPath, track, QUICK_ANALYSIS_SEC);
    if (player.queue.current()?.providerId === track.providerId && !player.score) {
      player.score = quick;
      console.log(`provisional score for "${track.title}" in `
        + `${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
    }
  } catch (error) {
    console.error('quick analysis failed:', error.message);
  }

  try {
    const score = await analyser.analyse(audioPath, track);
    // Discard if the user has since moved on, so a slow analysis cannot
    // overwrite the score of whatever is playing now.
    if (player.queue.current()?.providerId === track.providerId) player.score = score;

    // Cached before the lyrics pass is started, not after, so the two writes to
    // this path cannot race. The transcription takes tens of seconds and will
    // rewrite the file when it lands.
    await writeFile(cachePath, JSON.stringify(score));
    console.log(
      `analysed "${track.title}" in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: `
      + `${score.timing.tempo_bpm} BPM, ${score.sections.length} sections`,
    );

    // Third pass: lyrics.
    //
    // Deliberately last and not awaited. Transcription runs ten to thirty
    // seconds, so making it part of the main analysis would delay every
    // visualisation for something most of them do not need. Renderers already
    // handle a score without lyrics, so this upgrades the score in place and
    // the client picks it up on its next poll.
    if (TRANSCRIBE_LYRICS) {
      // Its own worker: see the note where `lyricsAnalyser` is created. On the
      // shared worker this pass blocked the next track's provisional score for
      // its full 10-30 seconds once it had started, and no amount of queue
      // ordering could fix that.
      lyricsAnalyser.analyse(audioPath, track, null, true)
        .then(async (withLyrics) => {
          if (!withLyrics?.lyrics) return;

          // Cached even when the room has moved on. The transcription belongs
          // to *this* track, not to whatever is playing now, and the cache-hit
          // branch at the top of this function returns before the lyrics pass -
          // so a score written without them never gets them again. That is why
          // every one of the cached scores on disk had none, despite
          // transcription being enabled the whole time.
          try {
            await writeFile(cachePath, JSON.stringify(withLyrics));
          } catch (error) {
            console.error('lyrics cache write failed:', error.message);
          }

          const overall = withLyrics.lyrics.overall;
          console.log(`lyrics for "${track.title}": ${withLyrics.lyrics.words.length} words, `
            + `theme ${overall.theme ?? 'none'}, valence ${overall.valence}`);

          // Only the live score is guarded on the track still being current.
          if (player.queue.current()?.providerId !== track.providerId) return;
          player.score = withLyrics;
        })
        .catch((error) => console.error('lyrics pass failed:', error.message));
    }
  } catch (error) {
    console.error(`analysis failed for "${track.title}":`, error.message);
  } finally {
    player.analysing = false;
  }
}

// --- Discord bot ------------------------------------------------------------

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/** Shared favourites, persisted under the cache directory. */
/**
 * Seconds of a track analysed for the provisional score.
 *
 * Long enough for a stable tempo and a couple of sections, short enough to
 * return in a fifth of a second.
 */
const QUICK_ANALYSIS_SEC = 45;

/**
 * Whether to transcribe lyrics.
 *
 * Off unless `faster-whisper` is installed, since it is a large optional
 * dependency. Set `TRANSCRIBE_LYRICS=0` to disable it even when present.
 */
const TRANSCRIBE_LYRICS = process.env.TRANSCRIBE_LYRICS !== '0';

const favourites = new Favourites(CACHE_DIR);
await favourites.load();

const playlists = new Playlists(CACHE_DIR);
await playlists.load();

/**
 * Scopes for the console.
 *
 * Kept short and lowercase so the scope column stays narrow and scannable -
 * the point of the column is that you can find the subsystem you care about
 * without reading the messages.
 */
const log = logger('server');
const licence = logger('licensing');
const voice = logger('voice');

/** Group-size lookups, cached to disk and rate limited. */
const artistInfo = new ArtistInfo(CACHE_DIR);
await artistInfo.load();

/**
 * Work out the cast size for a track and attach it.
 *
 * Runs in the background after playback starts: a group lookup costs two
 * rate-limited requests, so a collaboration can take several seconds. The
 * visualiser falls back to parsing the title until this lands, then upgrades.
 *
 * @param {import('./server/player.js').GuildPlayer} player
 * @param {object} track
 */
async function attachPerformerCount(player, track) {
  try {
    const names = creditedArtists(track.title, track.artist);
    if (names.length === 0) return;
    const count = await artistInfo.countPerformers(names);
    // Discard if the track moved on while we were waiting.
    if (player.queue.current()?.providerId !== track.providerId) return;
    player.queue.current().performerCount = count;
    console.log(`cast for "${track.title}": ${count} from ${names.join(', ')}`);
  } catch (error) {
    console.error('artist lookup failed:', error.message);
  }
}

/** KAM gold, used across every embed. */
const BRAND = 0xffd21a;

/** Format seconds as m:ss, or "live" when unknown. */
function clock(seconds) {
  if (!seconds || seconds <= 0) return 'live';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

/** Symbols for the current loop mode. */
const LOOP_LABEL = { off: 'off', track: 'this track', queue: 'the queue' };

/**
 * Build the now-playing embed.
 *
 * @param {object} track Current track.
 * @param {import('./server/player.js').GuildPlayer} player
 * @param {string|null} link Activity invite URL.
 * @returns {EmbedBuilder}
 */
function nowPlayingEmbed(track, player, link) {
  const queue = player.queue;
  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setAuthor({ name: 'KAM Media Player' })
    .setTitle(track.title)
    .setURL(track.url ?? null)
    .addFields(
      { name: 'Artist', value: track.artist ?? 'Unknown', inline: true },
      { name: 'Length', value: clock(track.durationSec), inline: true },
      { name: 'Source', value: track.provider, inline: true },
    );

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  const upcoming = queue.upcoming();
  if (upcoming.length > 0) {
    embed.addFields({
      name: `Up next (${upcoming.length} queued)`,
      value: upcoming.slice(0, 3)
        .map((item, index) => `${index + 1}. ${item.title}`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  const flags = [];
  if (queue.loop !== 'off') flags.push(`loop: ${LOOP_LABEL[queue.loop]}`);
  if (queue.shuffled) flags.push('shuffled');
  embed.setFooter({
    text: flags.length ? flags.join(' · ') : 'Open the Activity for live visuals',
  });

  if (link) embed.setDescription(`[Open the visualiser](${link})`);
  return embed;
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track, or add it to the queue')
    .addStringOption((option) => option
      .setName('track')
      .setDescription('Song name, or a YouTube / SoundCloud link')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('playlist')
      .setDescription('Which playlist to add to (name or number)')
      .setRequired(false)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track'),
  new SlashCommandBuilder().setName('back').setDescription('Go back to the previous track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming tracks'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a queued track by its number in /queue')
    .addIntegerOption((option) => option
      .setName('position').setDescription('Number shown in /queue')
      .setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear the upcoming tracks, keeping what is playing'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current track'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and leave the channel'),
  new SlashCommandBuilder().setName('visuals').setDescription('Open the visualiser'),
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Post a TikTok, Instagram, X or Shorts link so it plays in chat')
    .addStringOption((option) => option
      .setName('link').setDescription('The video link').setRequired(true))
    .addBooleanOption((option) => option
      .setName('spoiler').setDescription('Hide it behind a spoiler')),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage the session playlists')
    .addSubcommand((sub) => sub
      .setName('new').setDescription('Start another playlist (up to 3)')
      .addStringOption((option) => option
        .setName('name').setDescription('What to call it').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('switch').setDescription('Choose which playlist plays next')
      .addStringOption((option) => option
        .setName('playlist').setDescription('Name or number').setRequired(true))
      .addBooleanOption((option) => option
        .setName('now').setDescription('Jump to it immediately')))
    .addSubcommand((sub) => sub
      .setName('list').setDescription('Show all playlists'))
    .addSubcommand((sub) => sub
      .setName('shuffle').setDescription('Shuffle one playlist')
      .addStringOption((option) => option
        .setName('playlist').setDescription('Name or number').setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('delete').setDescription('Remove a playlist')
      .addStringOption((option) => option
        .setName('playlist').setDescription('Name or number').setRequired(true))),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop mode')
    .addStringOption((option) => option
      .setName('mode').setDescription('What to loop').setRequired(false)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'this track', value: 'track' },
        { name: 'the queue', value: 'queue' },
      )),
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a position in the current track')
    .addIntegerOption((option) => option
      .setName('seconds').setDescription('Position in seconds').setRequired(true)),
];

/**
 * Create an invite that launches the Activity in a voice channel.
 *
 * A bot cannot open an Activity directly; `EmbeddedApplication` is the invite
 * target type that makes a link do it.
 */
async function activityInvite(channel) {
  const invite = await channel.createInvite({
    targetType: InviteTargetType.EmbeddedApplication,
    targetApplication: DISCORD_CLIENT_ID,
    maxAge: 3600,
  });
  return invite.url;
}

/**
 * Search results awaiting a choice, keyed by the interaction that produced them.
 *
 * A select option's `value` is capped at 100 characters, so the track cannot
 * ride inside it - an earlier version tried and failed on every search. Results
 * are therefore held here and the option carries only an index.
 *
 * Entries expire because a user who never picks one would otherwise leak a few
 * kilobytes per abandoned search, forever.
 *
 * @type {Map<string, {results: object[], deckRef: string|null, expiresAt: number}>}
 */
const pendingSearches = new Map();

/** How long an unanswered search stays resolvable. */
const SEARCH_TTL_MS = 5 * 60 * 1000;

/** Drop expired searches. Called whenever a new one is stored. */
function prunePendingSearches() {
  const now = Date.now();
  for (const [key, entry] of pendingSearches) {
    if (entry.expiresAt <= now) pendingSearches.delete(key);
  }
}

/**
 * Wire a player to the provider layer.
 *
 * The player holds no provider or filesystem policy of its own; it calls these
 * to fetch audio and to report that a track has begun.
 */
function preparePlayer(player, channel = null) {
  player.loadAudio = (track) => fetchAudio(track, CACHE_DIR);
  player.onTrackStart = (track, audioPath) => {
    attachScore(player, track, audioPath);
    // Not awaited: the cast size is a refinement, not a prerequisite.
    attachPerformerCount(player, track);
  };

  // Remember where to post, so the end of a queue is announced in the channel
  // the request came from rather than vanishing silently.
  if (channel) player.textChannel = channel;
  player.onQueueEnd = () => {
    player.textChannel?.send('Queue finished. `/play` to add something else.')
      .catch(() => {});
  };
  return player;
}

/**
 * Queue a track and start playback if idle.
 *
 * @returns {Promise<{track: object, queued: boolean}>} `queued` is true when it
 *   was appended behind something already playing.
 */
async function enqueue(player, voiceChannel, track, deckRef = null, addedBy = null) {
  await player.connect(voiceChannel);

  const deck = player.decks.resolve(deckRef);
  if (!deck) throw new Error(`No playlist called "${deckRef}".`);

  // Attribution matters in a shared session: people want to know whose track
  // is playing, and it costs one field.
  const entry = { ...track, addedBy };
  const wasIdle = player.queue.current() === null;
  deck.queue.add(entry);

  // Start only if the active deck was the one that gained a track; adding to a
  // different playlist should never hijack what the room is listening to.
  const isActiveDeck = deck === player.decks.active;
  if (wasIdle && isActiveDeck) await player.startCurrent();

  return { track: entry, deck, queued: !(wasIdle && isActiveDeck) };
}

bot.on(Events.InteractionCreate, async (interaction) => {
  // --- Search result chosen from the dropdown -------------------------------
  if (interaction.isStringSelectMenu()
      && interaction.customId.startsWith('play-select')) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.update({ content: 'You left the voice channel.', components: [] });
    }
    await interaction.deferUpdate();
    try {
      const searchId = interaction.customId.split(':')[1];
      const pending = pendingSearches.get(searchId);
      if (!pending) {
        return interaction.editReply({
          content: 'That search expired. Run /play again.',
          components: [], embeds: [],
        });
      }
      pendingSearches.delete(searchId);

      const track = pending.results[Number(interaction.values[0])];
      if (!track) {
        return interaction.editReply({
          content: 'That result is no longer available.', components: [], embeds: [],
        });
      }
      const deckRef = pending.deckRef;
      const player = preparePlayer(getPlayer(interaction.guildId), interaction.channel);
      const { queued, deck } = await enqueue(
        player, voiceChannel, track, deckRef, interaction.user.username,
      );
      const link = await activityInvite(voiceChannel).catch(() => null);

      // Replace the private picker, then announce to the channel so everyone
      // sees what was added without having seen the search.
      await interaction.editReply({
        content: `Added **${track.title}** to **${deck.name}**.`,
        components: [],
        embeds: [],
      });
      return interaction.followUp({
        content: queued ? `Queued in **${deck.name}**.` : null,
        embeds: [nowPlayingEmbed(track, player, link)],
      });
    } catch (error) {
      console.error(error);
      return interaction.editReply({ content: error.message, components: [], embeds: [] });
    }
  }

  // --- Search cancelled -----------------------------------------------------
  if (interaction.isButton() && interaction.customId.startsWith('play-cancel')) {
    pendingSearches.delete(interaction.customId.split(':')[1]);
    return interaction.update({
      content: 'Cancelled. Run /play again whenever you like.',
      components: [],
      embeds: [],
    });
  }

  if (!interaction.isChatInputCommand()) return;

  // Embedding is unrelated to playback, so it runs before the voice-channel
  // requirement that every other command needs.
  if (interaction.commandName === 'embed') {
    const link = interaction.options.getString('link').trim();
    if (!isEmbeddable(link)) {
      return interaction.reply({
        content: 'That does not look like a supported video link. TikTok, '
          + 'Instagram, X, Reddit, Facebook and YouTube Shorts all work.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();
    let clip = null;
    try {
      const limit = uploadLimit(interaction.guild?.premiumTier ?? 0);
      clip = await fetchClip(link, CACHE_DIR, limit);

      const spoiler = interaction.options.getBoolean('spoiler') ?? false;
      const name = `${spoiler ? 'SPOILER_' : ''}clip.mp4`;
      const attachment = new AttachmentBuilder(clip.filePath, { name });

      const stats = [];
      if (clip.info.viewCount) stats.push(`${clip.info.viewCount.toLocaleString()} views`);
      if (clip.info.likeCount) stats.push(`${clip.info.likeCount.toLocaleString()} likes`);

      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setAuthor({ name: clip.info.extractor })
        .setTitle(clip.info.title.slice(0, 250))
        .setURL(clip.info.webpageUrl)
        .setFooter({
          text: [
            clip.info.uploader,
            clock(clip.info.durationSec),
            `${(clip.sizeBytes / 1024 / 1024).toFixed(1)} MB`,
            clip.transcoded ? 'compressed to fit' : null,
            ...stats,
          ].filter(Boolean).join(' · '),
        });

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`View on ${clip.info.extractor}`)
          .setStyle(ButtonStyle.Link)
          .setURL(clip.info.webpageUrl),
      );

      await interaction.editReply({ embeds: [embed], files: [attachment], components: [buttons] });
    } catch (error) {
      console.error('embed failed:', error.message);
      await interaction.editReply(error.message.slice(0, 1900));
    } finally {
      // The file exists only long enough to reach Discord.
      if (clip) await discard(clip.filePath);
    }
    return;
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    return interaction.reply({
      content: 'Join a voice channel first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const player = preparePlayer(getPlayer(interaction.guildId), interaction.channel);
  const queue = player.queue;

  try {
    switch (interaction.commandName) {
      case 'play': {
        const query = interaction.options.getString('track');

        // A link is unambiguous; free text gets a choice of five, because a
        // single best match too often picks a cover or a sped-up edit.
        const isLink = /^https?:\/\//i.test(query.trim());

        // The picker is ephemeral: it is scratch UI for one person, and posting
        // five options plus a dropdown into a shared channel is noise everyone
        // else has to scroll past.
        await interaction.deferReply(isLink ? {} : { flags: MessageFlags.Ephemeral });
        const deckRef = interaction.options.getString('playlist');
        if (isLink) {
          const track = await resolveTrack(query);
          const { queued, deck } = await enqueue(
            player, voiceChannel, track, deckRef, interaction.user.username,
          );
          const link = await activityInvite(voiceChannel).catch(() => null);
          return interaction.editReply({
            content: queued ? `Added to **${deck.name}**.` : null,
            embeds: [nowPlayingEmbed(track, player, link)],
          });
        }

        const results = await searchTracks(query, 5);

        prunePendingSearches();
        pendingSearches.set(interaction.id, {
          results, deckRef, expiresAt: Date.now() + SEARCH_TTL_MS,
        });

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`play-select:${interaction.id}`)
          .setPlaceholder('Choose a track')
          .addOptions(results.map((track, index) => ({
            // Discord caps label, description and value at 100 characters each.
            label: track.title.slice(0, 100),
            description: `${track.artist} · ${clock(track.durationSec)}`.slice(0, 100),
            value: String(index),
            emoji: ['1\u20E3', '2\u20E3', '3\u20E3', '4\u20E3', '5\u20E3'][index],
          })));

        const cancel = new ButtonBuilder()
          .setCustomId(`play-cancel:${interaction.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary);

        return interaction.editReply({
          content: `**${results.length} results for "${query}"** — only you can see this.`,
          components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(cancel),
          ],
        });
      }

      case 'skip': {
        const next = await player.advance(true);
        return interaction.reply(next
          ? { embeds: [nowPlayingEmbed(next, player, null)] }
          : 'Queue finished.');
      }

      case 'back': {
        const previous = await player.previous();
        return interaction.reply(previous
          ? { embeds: [nowPlayingEmbed(previous, player, null)] }
          : 'Nothing to go back to.');
      }

      case 'pause':
        return interaction.reply(player.pause() ? 'Paused.' : 'Nothing is playing.');

      case 'resume':
        return interaction.reply(player.resume() ? 'Resumed.' : 'Nothing to resume.');

      case 'shuffle':
        queue.shuffle();
        return interaction.reply(`Shuffled ${queue.upcoming().length} upcoming tracks.`);

      case 'loop': {
        const mode = interaction.options.getString('mode');
        const now = mode ? queue.setLoop(mode) : queue.cycleLoop();
        return interaction.reply(`Looping ${LOOP_LABEL[now]}.`);
      }

      case 'seek': {
        const seconds = interaction.options.getInteger('seconds');
        return interaction.reply(player.seek(seconds)
          ? `Jumped to ${clock(seconds)}.`
          : 'Nothing is playing.');
      }

      case 'queue': {
        const current = queue.current();
        if (!current) return interaction.reply('The queue is empty.');
        const upcoming = queue.upcoming();
        const embed = new EmbedBuilder()
          .setColor(BRAND)
          .setTitle('Queue')
          .setDescription(
            `**Now:** ${current.title}\n\n`
            + (upcoming.length
              ? upcoming.slice(0, 15).map((track, index) =>
                  `\`${String(index + 1).padStart(2)}\` ${track.title} · ${clock(track.durationSec)}`)
                .join('\n')
              : '_Nothing queued._'),
          )
          .setFooter({
            text: `${queue.length} tracks · loop ${LOOP_LABEL[queue.loop]}`
              + (queue.shuffled ? ' · shuffled' : ''),
          });
        return interaction.reply({ embeds: [embed] });
      }

      case 'remove': {
        const position = interaction.options.getInteger('position');
        // /queue numbers upcoming tracks from 1, which is offset from the
        // absolute queue index the engine uses.
        const absolute = queue.index + position;
        const removed = queue.remove(absolute);
        return interaction.reply(removed
          ? `Removed **${removed.title}**.`
          : `There is no track at position ${position}.`);
      }

      case 'clear': {
        const removed = queue.upcoming().length;
        if (removed === 0) return interaction.reply('Nothing queued to clear.');
        queue.tracks.length = queue.index + 1;
        return interaction.reply(
          `Cleared ${removed} upcoming track${removed === 1 ? '' : 's'}. `
          + 'What is playing continues.',
        );
      }

      case 'nowplaying': {
        const current = queue.current();
        if (!current) return interaction.reply('Nothing is playing.');
        const link = await activityInvite(voiceChannel).catch(() => null);
        return interaction.reply({ embeds: [nowPlayingEmbed(current, player, link)] });
      }

      case 'playlist': {
        const decks = player.decks;
        switch (interaction.options.getSubcommand()) {
          case 'new': {
            const index = decks.create(
              interaction.options.getString('name'), interaction.user.username,
            );
            return interaction.reply(
              `Created **${decks.decks[index].name}** (playlist ${index}). `
              + `Add to it with \`/play <track> playlist:${index}\`.`,
            );
          }
          case 'switch': {
            const reference = interaction.options.getString('playlist');
            const target = decks.resolve(reference);
            if (!target) return interaction.reply(`No playlist called "${reference}".`);
            const immediate = interaction.options.getBoolean('now') ?? false;
            decks.switchTo(decks.decks.indexOf(target), immediate);
            if (immediate) await player.startCurrent();
            return interaction.reply(immediate
              ? `Now playing from **${target.name}**.`
              : `Next track will come from **${target.name}**.`);
          }
          case 'shuffle': {
            const target = decks.resolve(interaction.options.getString('playlist'));
            if (!target) return interaction.reply('No such playlist.');
            target.queue.shuffle();
            return interaction.reply(
              `Shuffled **${target.name}** (${target.queue.upcoming().length} upcoming).`,
            );
          }
          case 'delete': {
            const reference = interaction.options.getString('playlist');
            const target = decks.resolve(reference);
            if (!target) return interaction.reply(`No playlist called "${reference}".`);
            const removed = decks.remove(decks.decks.indexOf(target));
            return interaction.reply(removed
              ? `Deleted **${target.name}**.`
              : `Cleared **${target.name}** (the last playlist is kept).`);
          }
          default: {
            const embed = new EmbedBuilder()
              .setColor(BRAND)
              .setTitle('Session playlists')
              .setDescription(decks.decks.map((deck, index) => {
                const marker = index === decks.activeIndex ? '\u25B6' : '\u2003';
                const flags = [];
                if (deck.queue.loop !== 'off') flags.push(`loop ${deck.queue.loop}`);
                if (deck.queue.shuffled) flags.push('shuffled');
                return `${marker} \`${index}\` **${deck.name}** — `
                  + `${deck.queue.length} tracks`
                  + (deck.createdBy ? ` · by ${deck.createdBy}` : '')
                  + (flags.length ? ` · ${flags.join(', ')}` : '');
              }).join('\n'))
              .setFooter({
                text: `${decks.totalTracks} tracks across `
                  + `${decks.decks.length}/${decks.toJSON().maxDecks} playlists`,
              });
            return interaction.reply({ embeds: [embed] });
          }
        }
      }

      case 'stop':
        player.stop();
        return interaction.reply('Stopped and left the channel.');

      case 'visuals':
        return interaction.reply(await activityInvite(voiceChannel));

      default:
        return interaction.reply('Unknown command.');
    }
  } catch (error) {
    console.error(error);
    const message = error.message?.slice(0, 1900) ?? 'Something went wrong.';
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: message, components: [], embeds: [] });
    }
    return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
});

// --- HTTP -------------------------------------------------------------------

const app = express();

// Scores are around 650KB of JSON and gzip to about 160KB - a 75% reduction on
// the single largest transfer the Activity makes, which is most of why visuals
// took a while to appear. Express does not compress by default.
app.use(compression());
// Activity commands are tiny JSON objects. A low ceiling rejects accidental or
// hostile large bodies before Express allocates them in memory.
app.use(express.json({ limit: '32kb' }));

// Request logging. Without this the server is silent when Discord fails to
// fetch the Activity, which makes "it didn't launch" impossible to diagnose:
// no log line at all means Discord never reached us, which points at the URL
// mapping rather than at the app.
/**
 * Per-address rate limiting for the routes that cost something.
 *
 * Search spends YouTube quota, the image proxy makes outbound requests, and the
 * control routes move audio. Without a limit, one misbehaving client - or one
 * page left refreshing in a background tab - can exhaust a day's search
 * allowance for everyone in the guild.
 *
 * A fixed window rather than a token bucket: it is a few lines, has no
 * dependencies, and the failure mode of a fixed window (a burst straddling a
 * boundary) is harmless here.
 *
 * @type {Map<string, {count: number, resetAt: number}>}
 */
const rateBuckets = new Map();

/**
 * Middleware factory.
 *
 * @param {number} limit Requests allowed per window.
 * @param {number} windowMs Window length.
 * @returns {Function} Express middleware.
 */
function rateLimit(limit, windowMs) {
  return (request, response, next) => {
    const key = `${request.path}:${request.ip}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      response.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return response.status(429).json({ error: 'Too many requests. Slow down a moment.' });
    }

    // Opportunistic sweep: without it the map grows with every distinct address.
    if (rateBuckets.size > 5000) {
      for (const [id, entry] of rateBuckets) {
        if (entry.resetAt <= now) rateBuckets.delete(id);
      }
    }
    next();
  };
}

/**
 * Request logging.
 *
 * Every request used to print a line. The Activity polls `/api/now-playing`
 * about twice a second per viewer and fetches an `/api/image` for every avatar
 * and every piece of cover art, so one person watching one track produced a
 * continuous scroll and pushed anything that mattered off the screen within
 * seconds. Worse, a poll loop failing every single time looked much the same as
 * one succeeding - both were just lines going past.
 *
 * Now the routine successful traffic is counted and reported once a minute,
 * and anything unusual - a failure, something slow, anything that is not part
 * of the polling loop - prints immediately. `LOG_LEVEL=debug` brings back the
 * per-request line.
 */
const traffic = new TrafficSummary().start();
app.use(requestLogger(traffic));

/**
 * Health check. Fetch this through the tunnel to prove Discord's route works:
 * if the browser shows JSON but the Activity still fails, the problem is the
 * URL mapping or the app config, not connectivity.
 */
app.get('/healthz', (request, response) => {
  response.json({
    ok: true,
    analyserVersion,
    clientDir: CLIENT_DIR,
    uptimeSec: Math.round(process.uptime()),
    // Whether this deployment is on a licensed provider path. Exposed so the
    // answer to "may we run this publicly" is a request rather than an audit of
    // whichever environment variables happen to be set on the host.
    licensing: licensingPosture(),
  });
});

/**
 * Exchange the Activity's OAuth code for an access token.
 * The client secret stays here and never reaches the browser.
 */
app.post('/api/token', async (request, response) => {
  try {
    const discordResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: request.body.code,
      }),
    });
    const { access_token: accessToken } = await discordResponse.json();
    if (!accessToken) return response.status(401).json({ error: 'Token exchange failed.' });
    response.json({ access_token: accessToken });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Token exchange failed.' });
  }
});

/**
 * What a voice channel is playing, and exactly where in the track it is.
 *
 * `positionSec` comes from the audio player's transmitted-frame count, so it is
 * measured rather than estimated. `score` is null while analysis is still
 * running - the client polls and starts rendering when it appears.
 */
app.get('/api/now-playing/:channelId', (request, response) => {
  const player = findPlayerByChannel(request.params.channelId);
  if (!player?.queue.current()) {
    return response.status(404).json({ error: 'Nothing playing.' });
  }

  // The star, filled in for whoever is asking.
  //
  // The client has always sent `?userId=`, and this route has always thrown it
  // away and answered with a bare snapshot - so `favourited` arrived only on
  // the replies to button presses. The star was therefore correct right after
  // you pressed something and wrong from the next track change onwards, which
  // is exactly how it was reported: "sometimes a favourited song doesn't have
  // the star highlighted".
  //
  // The id is asserted by the caller, not verified. That is acceptable here and
  // nowhere that writes: it decides whether one star is drawn filled, and the
  // worst a forged id achieves is learning whether that user has favourited the
  // track currently playing in a channel they can already see. The poll is
  // deliberately unauthenticated - it runs twice a second per viewer - and
  // every route that changes anything takes its identity from the token
  // instead. See `authorise`.
  const viewerId = typeof request.query.userId === 'string' ? request.query.userId : null;
  response.json(withFavourite(player, viewerId));
});

/** Resolves OAuth tokens to the Discord user that owns them. */
const tokens = new TokenVerifier();

/**
 * Establish who is making a request, and that they belong here.
 *
 * Three separate questions, and the endpoints need different combinations:
 *
 *   1. Who are you?          - the bearer token, verified against Discord.
 *   2. Are you in this server? - checked through the bot, so a valid token
 *      from an unrelated Discord account cannot touch this guild.
 *   3. Are you in this room?   - for anything that changes what the channel is
 *      hearing. The Activity only runs inside a voice channel, so this costs a
 *      legitimate user nothing, and it stops someone who merely shares a guild
 *      from pausing a room they are not in.
 *
 * @param {import('express').Request} request
 * @param {object} [options]
 * @param {string} [options.guildId] Require membership of this guild.
 * @param {object} [options.voiceChannel] Require presence in this channel.
 * @returns {Promise<{id: string, username: string, avatar: string|null}>}
 */
async function authorise(request, { guildId = null, voiceChannel = null } = {}) {
  const user = await tokens.verify(bearerToken(request));

  const targetGuild = guildId ?? voiceChannel?.guild?.id ?? null;
  if (targetGuild) {
    try {
      const guild = await bot.guilds.fetch(targetGuild);
      await guild.members.fetch(user.id);
    } catch {
      throw new AuthError(403, 'You are not a member of that server.');
    }
  }

  // `members` on a voice channel is who is *connected* to it, which is exactly
  // the question being asked.
  if (voiceChannel && !voiceChannel.members?.has(user.id)) {
    throw new AuthError(403, 'Join the voice channel first.');
  }

  return user;
}

/**
 * Answer an {@link AuthError} properly, and anything else as a 500.
 *
 * Kept in one place so no route can accidentally leak an internal message to a
 * caller who failed to authenticate.
 */
function sendAuthError(response, error, context) {
  if (error instanceof AuthError) {
    // Logged, not silent. A refusal is the operator's business: "the button
    // does nothing" and "the server refused you" look identical from the
    // client, and without this line neither end says which it was.
    console.log(`${context}: refused (${error.status}) ${error.message}`);
    return response.status(error.status).json({ error: error.message });
  }
  console.error(`${context}:`, error.message);
  return response.status(500).json({ error: 'Something went wrong.' });
}

/** Serialise a score once and remember it; see `server/cache.js` for why. */
function serialiseScore(scoreId, score) {
  const cached = scoreCache.get(scoreId);
  if (cached) return cached;

  const body = JSON.stringify(score);
  scoreCache.set(scoreId, body);
  return body;
}

/**
 * The score for whatever is playing.
 *
 * Served on its own so the once-a-second state poll stays small. A score never
 * changes once analysed, so it carries a strong ETag of its `scoreId`: a viewer
 * who reloads or rejoins revalidates in a few bytes rather than re-downloading a
 * megabyte. The ETag is set explicitly rather than left to Express, which would
 * otherwise hash the whole body on every response to generate one.
 */
app.get('/api/score/:channelId', (request, response) => {
  const player = findPlayerByChannel(request.params.channelId);
  if (!player?.score) return response.status(404).json({ error: 'No score yet.' });

  const scoreId = player.scoreId();
  const etag = `"${scoreId}"`;
  // Private, not public: a score is tied to whatever this channel is playing and
  // should not be held by a shared proxy under this URL.
  response.set('ETag', etag);
  response.set('Cache-Control', 'private, max-age=3600');
  if (request.headers['if-none-match'] === etag) return response.status(304).end();

  response.type('application/json').send(serialiseScore(scoreId, player.score));
});

/**
 * Proxy an image through this origin, serving repeats from memory.
 *
 * Activities are sandboxed behind Discord's proxy and cannot load images from
 * arbitrary external hosts - avatars and album art simply failed to appear.
 * Serving them from our own origin, which is already trusted, sidesteps that
 * entirely and needs no URL mappings.
 *
 * The cache is deliberately here rather than inside `fetchProxiedImage`, which
 * stays a pure function of its URL and its injected fetch - that is what lets
 * the unit tests drive the same URL through different stubbed responses.
 */
app.get('/api/image', rateLimit(300, 60_000), async (request, response) => {
  const source = String(request.query.url ?? '');

  const hit = imageCache.get(source);
  if (hit) {
    response.set('Content-Type', hit.contentType);
    response.set('Cache-Control', 'public, max-age=86400');
    return response.send(hit.body);
  }

  try {
    const image = await fetchProxiedImage(source);
    // Only reached for an allowlisted host that returned a real image, so a
    // rejected URL can never occupy the cache.
    imageCache.set(source, image);
    response.set('Content-Type', image.contentType);
    // Avatars and cover art effectively never change; cache them hard so the
    // panel does not refetch on every open.
    response.set('Cache-Control', 'public, max-age=86400');
    response.send(image.body);
  } catch (error) {
    if (error instanceof ImageProxyError) return response.status(error.status).end();
    console.error('image proxy failed:', error.message);
    response.status(502).end();
  }
});

/**
 * Play a favourite, joining the voice channel if the bot is not already in it.
 *
 * The generic control endpoint requires an existing player attached to the
 * channel, so clicking a favourite while nothing was playing returned 404 and
 * appeared to do nothing. This resolves the channel through the bot instead.
 */
app.post('/api/favourites/:guildId/play', rateLimit(60, 60_000), async (request, response) => {
  await favourites.load();
  const { guildId } = request.params;
  const { channelId, index } = request.body ?? {};

  // Identified by provider and id, never by list position. The client filters
  // and sorts its own view, so an index into *its* list meant nothing here - it
  // was resolved against the unfiltered list and played the wrong song.
  const { provider, providerId } = request.body ?? {};
  const entry = favourites.list(guildId).find(
    (candidate) => candidate.provider === provider && candidate.providerId === providerId,
  ) ?? (Number.isInteger(index) ? favourites.list(guildId)[index] : null);
  if (!entry) return response.status(400).json({ error: 'No such favourite.' });

  try {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) {
      return response.status(400).json({ error: 'Not a voice channel.' });
    }

    // Playing a favourite interrupts the room when nothing is queued, so it is
    // held to the same bar as the transport.
    const viewer = await authorise(request, { voiceChannel: channel });

    const player = preparePlayer(getPlayer(guildId));
    await player.connect(channel);

    const wasIdle = player.queue.current() === null;
    player.queue.add({ ...entry, addedBy: entry.addedBy?.[0]?.username ?? null });
    // Starting only when nothing was playing already means a dropped batch
    // appends in order rather than each track interrupting the last.
    if (wasIdle) await player.startCurrent();

    response.json(withFavourite(player, viewer.id));
  } catch (error) {
    sendAuthError(response, error, 'play favourite failed');
  }
});

/**
 * A guild's favourites, with avatar URLs resolved for display.
 *
 * Keyed by guild rather than channel: the list belongs to the server, so it is
 * the same whichever voice channel you are in.
 */
/**
 * A player snapshot including whether the current track is favourited.
 *
 * Every response that can change what is playing must carry this. Previously
 * only `/api/now-playing` did, so any transport action returned a snapshot
 * without it, the client skipped its update, and the star kept the previous
 * track's state - which made every new song look already-favourited.
 *
 * @param {import('./server/player.js').GuildPlayer} player
 * @returns {object}
 */
function withFavourite(player, userId = null) {
  const snapshot = player.snapshot();
  snapshot.favourited = favourites.has(player.guildId, snapshot.track, userId);
  snapshot.favouritedByAnyone = favourites.has(player.guildId, snapshot.track);
  return snapshot;
}

/**
 * Cached avatar lookups, so repeated panel opens do not hammer Discord.
 * @type {Map<string, {url: string|null, at: number}>}
 */
const avatarCache = new Map();
const AVATAR_TTL_MS = 30 * 60 * 1000;

/**
 * Largest number of avatars held at once.
 *
 * The TTL was checked on read but entries were never removed, so the map grew
 * with every distinct user forever. On a private server that is a rounding
 * error; across thousands of guilds it is a slow leak.
 */
const AVATAR_CACHE_MAX = 2000;

/** Drop expired avatars, and the oldest entries if the cache is still too big. */
function pruneAvatarCache() {
  const now = Date.now();
  for (const [id, entry] of avatarCache) {
    if (now - entry.at >= AVATAR_TTL_MS) avatarCache.delete(id);
  }
  if (avatarCache.size <= AVATAR_CACHE_MAX) return;
  // Map iterates in insertion order, so the first keys are the oldest.
  const excess = avatarCache.size - AVATAR_CACHE_MAX;
  let removed = 0;
  for (const id of avatarCache.keys()) {
    avatarCache.delete(id);
    if (++removed >= excess) break;
  }
}

/**
 * Resolve a user's current avatar through the bot.
 *
 * Storing the avatar hash at favourite time was not enough: entries saved before
 * avatars were recorded have none, and anyone who changes their picture keeps
 * the old one forever. Asking Discord means the image is always the user's
 * actual current avatar, and it works retroactively for every existing entry.
 *
 * @param {string|null} userId
 * @returns {Promise<string|null>}
 */
async function resolveAvatar(userId) {
  if (!userId) return null;

  const cached = avatarCache.get(userId);
  if (cached && Date.now() - cached.at < AVATAR_TTL_MS) return cached.url;

  try {
    const user = await bot.users.fetch(userId);
    const url = user.displayAvatarURL({ extension: 'png', size: 64 });
    avatarCache.set(userId, { url, at: Date.now() });
    pruneAvatarCache();
    return url;
  } catch {
    // Unknown or deleted user: fall back to the stored hash, then to nothing.
    avatarCache.set(userId, { url: null, at: Date.now() });
    return null;
  }
}

/**
 * A guild's favourites, with every contributor's avatar resolved.
 *
 * Contributors are returned alongside the list so the client can build the
 * per-user folders without a second request or having to derive them itself.
 */
app.get('/api/favourites/:guildId', async (request, response) => {
  await favourites.load();
  const { guildId } = request.params;

  const entries = await Promise.all(
    favourites.list(guildId).map(async (entry) => ({
      ...entry,
      latestAt: Favourites.latestAt(entry),
      addedBy: await Promise.all((entry.addedBy ?? []).map(async (who) => ({
        ...who,
        avatarUrl: (await resolveAvatar(who.id)) ?? avatarUrl(who),
      }))),
    })),
  );

  const contributors = await Promise.all(
    favourites.contributors(guildId).map(async (person) => ({
      ...person,
      avatarUrl: (await resolveAvatar(person.id)) ?? avatarUrl(person),
    })),
  );

  response.json({ favourites: entries, contributors });
});

/**
 * Add or remove a favourite.
 *
 * The track defaults to whatever is playing in the given channel, so the star
 * button needs to send nothing but its own identity.
 */
app.post('/api/favourites/:guildId', rateLimit(60, 60_000), async (request, response) => {
  await favourites.load();
  const { guildId } = request.params;
  const { action, channelId, track } = request.body ?? {};

  let user;
  try {
    // The identity is taken from the verified token and nowhere else. It used
    // to come from a `user` object in the body, so a crafted request could
    // attribute a favourite to someone who had never heard the song - and
    // remove one on their behalf too.
    user = await authorise(request, { guildId });
  } catch (error) {
    return sendAuthError(response, error, 'favourite auth failed');
  }

  const player = channelId ? findPlayerByChannel(channelId) : null;
  // A client-supplied `track` is only ever used to *identify* an existing
  // favourite or the playing track; it is never stored, so it cannot smuggle a
  // url into the store and from there into the queue.
  const current = player?.queue.current();
  const subject = track
    ? resolveKnownTrack(guildId, track) ?? (
      current && current.provider === track.provider
        && current.providerId === track.providerId ? current : null)
    : current;
  if (!subject) return response.status(400).json({ error: 'Nothing to favourite.' });

  if (action === 'remove') {
    // Only this user's claim is removed; others keep the track in their folder.
    favourites.remove(guildId, subject.provider, subject.providerId, user.id);
    return response.json({
      removed: true,
      favourited: favourites.has(guildId, subject, user.id),
    });
  }

  const { added } = favourites.add(guildId, subject, user);
  response.json({ added, favourited: true });
});

/**
 * What the asking user may see of a guild's playlists.
 *
 * Authenticated rather than open, and not because the contents are secret -
 * the public ones are not. It is because the response is *shaped by who is
 * asking*: it contains the caller's own private playlist. An unauthenticated
 * version of this route could not know whose private slot to include, and any
 * scheme where the client says who it is hands every private playlist to
 * anyone who can guess a user ID.
 */
app.get('/api/playlists/:guildId', async (request, response) => {
  const { guildId } = request.params;
  try {
    const viewer = await authorise(request, { guildId });
    const view = playlists.forViewer(guildId, viewer);

    const others = await Promise.all(view.others.map(async (entry) => ({
      ...entry,
      user: {
        ...entry.user,
        avatarUrl: (await resolveAvatar(entry.user.id)) ?? avatarUrl(entry.user),
      },
    })));

    response.json({ ...view, others });
  } catch (error) {
    sendAuthError(response, error, 'playlist read failed');
  }
});

/**
 * Add to, remove from, or rename one of the caller's own playlists.
 *
 * One endpoint with an action, matching `/api/control`. Every action operates
 * on the *caller's* playlists and no one else's: the user ID comes from the
 * verified token and is never read from the body, so there is no request shape
 * that edits another person's collection.
 */
app.post('/api/playlists/:guildId', rateLimit(60, 60_000), async (request, response) => {
  const { guildId } = request.params;
  const { action, slot, track, name } = request.body ?? {};

  if (!SLOTS.includes(slot)) {
    return response.status(400).json({ error: 'No such playlist.' });
  }

  let user;
  try {
    user = await authorise(request, { guildId });
  } catch (error) {
    return sendAuthError(response, error, 'playlist auth failed');
  }

  try {
    if (action === 'rename') {
      const { name: applied } = playlists.rename(guildId, user, slot, name);
      return response.json({ renamed: true, name: applied });
    }

    if (action === 'remove') {
      if (!track?.provider || !track?.providerId) {
        return response.status(400).json({ error: 'No track given.' });
      }
      const { removed } = playlists.remove(
        guildId, user.id, slot, track.provider, track.providerId,
      );
      return response.json({ removed });
    }

    if (action === 'add') {
      // Identity in, descriptor out - the same rule the queue follows. What the
      // caller sent only *names* a track; the descriptor stored is the one the
      // server already resolved, so a playlist cannot become a way to smuggle a
      // url into the queue by way of `resolveKnownTrack`.
      const subject = resolveKnownTrack(guildId, track);
      if (!subject) {
        return response.status(400).json({
          error: 'That track is no longer available. Search for it again.',
        });
      }
      const { added, reason } = playlists.add(guildId, user, slot, subject);
      return response.json({ added, reason: reason ?? null });
    }

    return response.status(400).json({ error: 'Unknown action.' });
  } catch (error) {
    console.error('playlist write failed:', error.message);
    response.status(500).json({ error: 'Something went wrong.' });
  }
});

/**
 * Search for tracks from inside the Activity.
 *
 * Mirrors what `/play` does in chat, including the fallback chain for links:
 *
 *   1. Resolve the link directly with the provider that owns it.
 *   2. If that fails - wrong site, private video, region lock - read whatever
 *      title the page exposes and search the providers we *can* play from.
 *   3. If it is not a link at all, search directly.
 *
 * Step 2 is the useful one: a link to something unplayable still names the
 * track, and finding that song elsewhere is almost always what the person
 * wanted.
 */
app.get('/api/search', rateLimit(20, 60_000), async (request, response) => {
  const query = String(request.query.q ?? '').trim();
  if (query.length < 2) return response.json({ results: [] });

  const isLink = /^https?:\/\//i.test(query);

  if (isLink) {
    // Services whose audio cannot be played from here: Apple Music, Spotify,
    // Deezer and Tidal all either have no extractable stream or forbid
    // synchronising theirs. The link still names the song, so it is identified
    // and the track is found on a provider we can play - which is what someone
    // pasting it actually wants.
    if (/music\.apple\.com|open\.spotify\.com|deezer\.com|tidal\.com/i.test(query)) {
      try {
        const described = await describeLink(query);
        const results = (await searchTracks(described, 5)).map(rememberTrack);
        return response.json({ results, source: 'identified', identified: described });
      } catch (error) {
        return response.status(404).json({
          error: `Could not read that link: ${error.message}`,
        });
      }
    }

    try {
      const track = rememberTrack(await resolveTrack(query));
      return response.json({ results: [track], source: 'link' });
    } catch (error) {
      console.log(`link resolve failed (${error.message}); trying to identify it`);

      // Direct extraction failed - a private SoundCloud track, a region block, a
      // broken transcoding. The page usually still names the song, so identify
      // it and look elsewhere rather than giving up.
      try {
        const described = await describeLink(query);
        const results = (await searchTracks(described, 5)).map(rememberTrack);
        if (results.length > 0) {
          return response.json({ results, source: 'identified', identified: described });
        }
      } catch {
        // Fall through to the generic probe below.
      }
    }

    // Ask yt-dlp what the page is called, then search for that instead.
    try {
      const info = await probe(query);
      const terms = [info.title, info.uploader].filter(Boolean).join(' ');
      const results = (await searchTracks(terms, 5)).map(rememberTrack);
      return response.json({ results, source: 'identified', identified: info.title });
    } catch {
      return response.status(404).json({
        error: 'That link could not be played or identified. Try searching by name.',
      });
    }
  }

  try {
    const results = (await searchTracks(query, 5)).map(rememberTrack);
    response.json({ results, source: 'search' });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

/**
 * Queue a track chosen from the Activity's search.
 *
 * Takes the whole descriptor rather than an index, for the same reason
 * favourites do: the client's list is its own, and positions do not survive the
 * round trip.
 */
/**
 * Most tracks a single request may enqueue.
 *
 * Dragging a multiple selection out of the favourites panel sends one request
 * carrying every track, so this is the only bound on how much work one call can
 * ask for. The rate limiter counts requests, not tracks, and would happily let
 * thirty requests of ten thousand tracks each through.
 */
const MAX_QUEUE_BATCH = 50;

/**
 * Track descriptors the server has itself produced, by identity.
 *
 * The queue endpoint used to take a whole track object from the client and put
 * it in the queue verbatim - including its `url`, which `fetchYouTubeAudio`
 * hands straight to yt-dlp. That is an unauthenticated request causing this
 * server to download an address chosen by the caller, and no amount of
 * authentication makes it acceptable, because a legitimate user should not be
 * able to do it either.
 *
 * So the client now sends identity only, and the descriptor is recovered from
 * something the server already vouched for: a search result it returned, or a
 * favourite it stored. Anything else is refused.
 */
const resolvedTracks = new Map();
const RESOLVED_TTL_MS = 30 * 60 * 1000;
const RESOLVED_MAX = 500;

/** Remember a descriptor this server produced, so it can be queued later. */
function rememberTrack(track) {
  if (!track?.provider || !track?.providerId) return track;
  resolvedTracks.set(`${track.provider}:${track.providerId}`, { track, at: Date.now() });
  if (resolvedTracks.size > RESOLVED_MAX) {
    const now = Date.now();
    for (const [key, entry] of resolvedTracks) {
      if (now - entry.at >= RESOLVED_TTL_MS) resolvedTracks.delete(key);
    }
    // Still too many: drop oldest first, which Map's insertion order gives us.
    let excess = resolvedTracks.size - RESOLVED_MAX;
    for (const key of resolvedTracks.keys()) {
      if (excess-- <= 0) break;
      resolvedTracks.delete(key);
    }
  }
  return track;
}

/**
 * Recover a full descriptor for a track the client asked to queue.
 *
 * @param {string} guildId Guild whose favourites may be drawn on.
 * @param {{provider: string, providerId: string}} wanted
 * @returns {object|null} The descriptor, or null if this server never issued it.
 */
function resolveKnownTrack(guildId, wanted) {
  if (!wanted?.provider || !wanted?.providerId) return null;
  const key = `${wanted.provider}:${wanted.providerId}`;

  const remembered = resolvedTracks.get(key);
  if (remembered && Date.now() - remembered.at < RESOLVED_TTL_MS) return remembered.track;

  // Favourites are full descriptors by design, and outlive any cache.
  const favourite = favourites.list(guildId).find(
    (entry) => `${entry.provider}:${entry.providerId}` === key,
  );
  if (favourite) {
    const { addedBy, addedAt, ...track } = favourite;
    return track;
  }

  // Playlists are full descriptors too, and they are the longest-lived
  // collection in the product - a track saved months ago has long since fallen
  // out of `resolvedTracks` and may never have been a favourite. Without this,
  // a playlist would visibly hold tracks that could not be played, and the
  // private slot would be the one that broke, because nobody else's favourite
  // would happen to cover it.
  return playlists.findTrack(guildId, wanted.provider, wanted.providerId);
}

app.post('/api/queue/:channelId', rateLimit(30, 60_000), async (request, response) => {
  const { channelId } = request.params;
  const { track, tracks, deck: deckRef, at, playlist } = request.body ?? {};

  // Accepts either one track or a batch.
  //
  // A multiple selection is added in a single request rather than one per
  // track. That is not only fewer round trips: each of these fetches the
  // channel, prepares the player and connects to voice, so ten separate calls
  // would repeat all of that ten times and interleave ten writes to the queue
  // while the voice player is running.
  const asked = (Array.isArray(tracks) ? tracks : [track])
    .filter((entry) => entry?.provider && entry?.providerId);

  // A playlist is named, not sent. The caller says whose playlist and which
  // slot; the tracks and the name come from the server's own store. Sending the
  // tracks would work equally well for queueing them, but the *label* stamped
  // on each one would then be whatever the client claimed - so anybody could
  // fill a room's queue with tracks captioned as somebody else's playlist.
  if (asked.length === 0 && !playlist) {
    return response.status(400).json({ error: 'No track given.' });
  }
  if (asked.length > MAX_QUEUE_BATCH) {
    return response.status(413).json({ error: `At most ${MAX_QUEUE_BATCH} tracks at once.` });
  }

  try {
    const player = findPlayerByChannel(channelId);
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) {
      return response.status(400).json({ error: 'Not a voice channel.' });
    }

    // Queueing changes what the room will hear, so it needs a real identity in
    // the real channel - not a `user` object the caller wrote themselves.
    const user = await authorise(request, { voiceChannel: channel });

    // Identity in, descriptor out. Nothing the caller sent is played.
    let batch;
    /** Stamped on every track from a playlist, so the queue can group them. */
    let source = null;

    if (playlist) {
      const ownerId = String(playlist.ownerId ?? user.id);
      const slot = playlist.slot;
      if (!SLOTS.includes(slot)) {
        return response.status(400).json({ error: 'No such playlist.' });
      }
      // Somebody else's private playlist is not queueable by naming it. The
      // read endpoint never discloses one, but "never sent" and "refused when
      // asked for directly" are different guarantees, and this is the one that
      // holds even if the first is ever weakened.
      if (slot === 'private' && ownerId !== user.id) {
        return response.status(403).json({ error: 'That playlist is private.' });
      }
      const record = playlists.get(channel.guild.id, ownerId);
      const chosen = record?.[slot];
      if (!chosen || chosen.tracks.length === 0) {
        return response.status(400).json({ error: 'That playlist is empty.' });
      }
      if (chosen.tracks.length > MAX_QUEUE_BATCH) {
        return response.status(413).json({ error: `At most ${MAX_QUEUE_BATCH} tracks at once.` });
      }
      batch = chosen.tracks.map(({ savedAt, ...entry }) => entry);
      source = {
        // Identifies the block, and changes if the playlist is renamed - which
        // is right: a rename mid-queue should not merge two different blocks.
        id: `${ownerId}:${slot}`,
        name: chosen.name,
        ownerId,
        ownerName: record.user?.username ?? 'someone',
        visibility: slot,
      };
    } else {
      batch = asked.map((entry) => resolveKnownTrack(channel.guild.id, entry));
      if (batch.some((entry) => !entry)) {
        return response.status(400).json({
          error: 'Those tracks are no longer available. Search for them again.',
        });
      }
    }

    const target = preparePlayer(player ?? getPlayer(channel.guild.id));
    await target.connect(channel);

    // Tracks land in the deck the panel was showing, which is not necessarily
    // the one playing. Someone browsing another deck and dropping into it is
    // building a set for later; diverting the room's music would be wrong.
    const deck = target.decks.resolve(deckRef ?? null);
    if (!deck) return response.status(400).json({ error: 'No such playlist.' });

    const prepared = batch.map((entry) => ({
      ...entry,
      addedBy: user?.username ?? null,
      ...(source ? { source } : {}),
    }));

    // Whether the player was idle is read once, before anything is added. Asking
    // after the first track would report a queue that is no longer empty, so a
    // batch dropped onto a stopped player would sit there without starting.
    const wasIdle = target.queue.current() === null;

    // A drop carries the position the insertion indicator was pointing at;
    // everything else appends.
    if (Number.isFinite(at)) deck.queue.insertAt(at, prepared);
    else deck.queue.add(prepared);

    // Only start if the tracks went into the deck that actually feeds playback.
    // Starting otherwise would play the active deck's current track, which is
    // not what was dropped and not what anyone asked for.
    if (wasIdle && deck === target.decks.active) await target.startCurrent();

    response.json(withFavourite(target, user.id));
  } catch (error) {
    sendAuthError(response, error, 'queue from activity failed');
  }
});

/**
 * Transport control from the Activity.
 *
 * One endpoint rather than a route per verb: the client sends an action name,
 * which keeps the surface small and means adding a control is a case label
 * rather than a new route.
 */
app.post('/api/control/:channelId', rateLimit(120, 60_000), async (request, response) => {
  const player = findPlayerByChannel(request.params.channelId);
  if (!player) return response.status(404).json({ error: 'Nothing playing.' });

  const { action, value } = request.body ?? {};
  let viewer;
  try {
    // Transport control changes what everyone in the channel hears, so it is
    // the strictest case: a verified identity, connected to this very channel.
    const channel = await bot.channels.fetch(request.params.channelId);
    viewer = await authorise(request, { voiceChannel: channel });
  } catch (error) {
    return sendAuthError(response, error, 'control auth failed');
  }

  try {
    switch (action) {
      case 'pause': player.pause(); break;
      case 'resume': player.resume(); break;
      case 'toggle':
        if (player.isPaused()) player.resume();
        else player.pause();
        break;
      case 'next': await player.advance(true); break;
      case 'previous': await player.previous(); break;
      case 'seek': player.seek(Number(value) || 0); break;
      case 'jump': await player.jumpTo(Number(value) || 0); break;
      case 'shuffle': player.queue.shuffle(); break;
      case 'loop': player.queue.setLoop(value ?? player.queue.cycleLoop()); break;
      case 'stop': player.stop(); break;
      case 'playFavourite': {
        // Favourites hold a full track descriptor, so playing one needs no
        // search and spends no YouTube quota. Matched by identity, not index.
        const entry = favourites.list(player.guildId).find(
          (candidate) => candidate.provider === value?.provider
            && candidate.providerId === value?.providerId,
        );
        if (!entry) return response.status(400).json({ error: 'No such favourite.' });
        preparePlayer(player);
        const wasIdle = player.queue.current() === null;
        player.queue.add({ ...entry, addedBy: entry.addedBy?.username ?? null });
        if (wasIdle) await player.startCurrent();
        break;
      }
      case 'switchDeck': {
        const index = Number(value);
        if (!player.decks.switchTo(index)) {
          return response.status(400).json({ error: 'No such playlist.' });
        }
        break;
      }
      case 'move': {
        // `value` carries both indices, since a reorder needs two.
        const deck = player.decks.resolve(value?.deck ?? null);
        if (!deck) return response.status(400).json({ error: 'No such playlist.' });
        deck.queue.move(Number(value?.from), Number(value?.to));
        break;
      }
      case 'jumpDeck': {
        // Jump within a specific deck, making it active first so playback
        // actually follows the click.
        const index = Number(value?.deck);
        if (Number.isFinite(index) && index >= 0) player.decks.switchTo(index);
        await player.jumpTo(Number(value?.position));
        break;
      }
      case 'removeTrack': {
        const deck = player.decks.resolve(value?.deck ?? null);
        if (!deck) return response.status(400).json({ error: 'No such playlist.' });
        deck.queue.remove(Number(value?.position));
        break;
      }
      case 'removeTracks': {
        const deck = player.decks.resolve(value?.deck ?? null);
        if (!deck) return response.status(400).json({ error: 'No such playlist.' });

        // Descending, always. Removing a position shifts everything below it up
        // by one, so ascending removal deletes the wrong tracks from the second
        // onwards - and does it silently, because every index is still valid.
        // Sorted here rather than trusting the client to have done it.
        const positions = [...new Set(
          (Array.isArray(value?.positions) ? value.positions : [])
            .map(Number).filter(Number.isFinite),
        )].sort((a, b) => b - a);

        if (positions.length === 0) {
          return response.status(400).json({ error: 'No tracks given.' });
        }
        for (const position of positions) deck.queue.remove(position);
        break;
      }
      case 'shuffleDeck': {
        const deck = player.decks.resolve(Number(value));
        if (!deck) return response.status(400).json({ error: 'No such playlist.' });
        deck.queue.shuffle();
        break;
      }
      default:
        return response.status(400).json({ error: `Unknown action "${action}".` });
    }
    response.json(withFavourite(player, viewer.id));
  } catch (error) {
    console.error('control failed:', error.message);
    response.status(500).json({ error: error.message });
  }
});

app.use(express.static(CLIENT_DIR));

app.listen(PORT, () => {
  log.info(`listening on :${PORT}`);
  // Stated once at boot, in the same place every time. The previous single
  // line about SoundCloud scrolled past among the provider and voice logs, and
  // "which terms is this deployment operating under" is not something anyone
  // should have to go looking for.
  const posture = licensingPosture();
  licence.info(`soundcloud=${posture.soundcloud} youtube=${posture.youtube}`);
  licence.info(posture.note);
});

// Register the slash command against every guild the bot joins. Guild-scoped
// registration appears instantly; global registration can take an hour.
const rest = new REST().setToken(DISCORD_BOT_TOKEN);

/**
 * Register /play in one guild.
 *
 * Guild-scoped registration appears instantly, where global registration can
 * take an hour to propagate - worth it while iterating.
 *
 * @param {string} guildId
 */
async function registerCommands(guildId) {
  try {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId),
      { body: commands.map((command) => command.toJSON()) },
    );
    return true;
  } catch (error) {
    // Registration failing silently is worse than crashing: commands simply
    // never appear and there is nothing in the log to explain why.
    console.error(
      `Command registration failed for guild ${guildId}: ${error.message}`
      + (error.code === 50001
        ? ' - the bot needs the applications.commands scope. Re-invite it.'
        : ''),
    );
    return false;
  }
}

/**
 * Pre-import the analyser and verify the toolchain at boot.
 *
 * librosa's lazy imports and numba's JIT add roughly 35 seconds to the first
 * analysis in a fresh process; paying it here moves that cost off the first
 * user's request. The yt-dlp check is deliberately at startup too, so a missing
 * binary is reported in the boot log rather than discovered as a confusing
 * failure on somebody's first `/play`.
 */
async function warmAnalyser() {
  const startedAt = Date.now();

  // Starting the worker now means the first /play pays no JIT cost at all.
  analyser.start();
  analyserVersion = await readAnalyserVersion();
  console.log(
    `Analyser worker started in ${((Date.now() - startedAt) / 1000).toFixed(1)}s `
    + `(version ${analyserVersion}; score cache keyed to it)`,
  );

  const ytdlp = await checkYtDlp();
  console.log(ytdlp
    ? `yt-dlp ${ytdlp} found (providers: ${Object.keys(PROVIDERS).join(', ')})`
    : 'yt-dlp NOT found - provider playback will fail. Install it with '
      + '`winget install yt-dlp.yt-dlp`.');
}

bot.once(Events.ClientReady, async () => {
  logVoiceDependencies();
  const results = await Promise.all([...bot.guilds.cache.keys()].map(registerCommands));
  const registered = results.filter(Boolean).length;
  log.info(`bot ready as ${bot.user.tag} in ${bot.guilds.cache.size} guild(s)`);
  console.log(
    `Registered ${commands.length} commands in ${registered} guild(s): `
    + commands.map((command) => `/${command.name}`).join(' '),
  );
  warmAnalyser();
});

// Without this, a server that invites the bot after startup never sees /play.
bot.on(Events.GuildCreate, (guild) => registerCommands(guild.id));

/**
 * How long the bot stays in an empty channel before leaving.
 *
 * Not immediate on purpose: people drop out of voice for a few seconds all the
 * time - reconnecting, switching devices, being moved - and tearing down
 * playback each time would be worse than lingering briefly.
 */
const EMPTY_CHANNEL_GRACE_MS = 90_000;

/** @type {Map<string, NodeJS.Timeout>} Pending departures, keyed by guild. */
const leaveTimers = new Map();

/** Cancel a scheduled departure. */
function cancelLeave(guildId) {
  const timer = leaveTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    leaveTimers.delete(guildId);
  }
}

/**
 * Leave a voice channel once everybody else has gone.
 *
 * Sitting alone in an empty channel holds an audio stream nobody hears, keeps
 * the bot looking busy, and - as found the hard way - reads as broken behaviour
 * worth kicking the bot over.
 */
bot.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild?.id ?? newState.guild?.id;
  if (!guildId) return;

  const player = findPlayerByChannel(oldState.channelId)
    ?? findPlayerByChannel(newState.channelId);
  if (!player?.channelId) return;

  const channel = oldState.guild.channels.cache.get(player.channelId);
  if (!channel) return;

  const humans = channel.members.filter((member) => !member.user.bot).size;

  if (humans > 0) {
    cancelLeave(guildId);
    return;
  }

  if (leaveTimers.has(guildId)) return;
  voice.info(`${guildId}: channel empty; leaving in `
    + `${EMPTY_CHANNEL_GRACE_MS / 1000}s unless someone returns.`);

  leaveTimers.set(guildId, setTimeout(() => {
    leaveTimers.delete(guildId);
    const stillEmpty = channel.members.filter((member) => !member.user.bot).size === 0;
    if (stillEmpty) {
      voice.info(`${guildId}: left an empty channel.`);
      player.stop();
    }
  }, EMPTY_CHANNEL_GRACE_MS));
});

/**
 * Survive faults that would otherwise stop the whole bot.
 *
 * Node exits the process on an unhandled rejection, so a single failure in one
 * guild - a Discord API hiccup, a provider timing out, a listener that throws -
 * silently takes playback down for every server at once. That is acceptable in a
 * script and unacceptable in something other people rely on.
 *
 * These handlers log and continue. An uncaught exception is genuinely more
 * dangerous, because the process may be in an inconsistent state afterwards, so
 * it is logged and given a moment to flush before exiting - a supervisor
 * (systemd, Docker, Fly) then restarts cleanly rather than the process limping
 * on in an unknown condition.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (continuing):',
    reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (restarting):', error.stack ?? error);
  try {
    stopAll();
    analyser.stop();
    lyricsAnalyser.stop();
  } catch {
    // Already broken; nothing useful to do but leave.
  }
  // A non-zero code tells a supervisor this was a fault, not a clean stop.
  setTimeout(() => process.exit(1), 250).unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('Shutting down; leaving voice channels.');
    stopAll();
    analyser.stop();
    // Killed too, or a transcription keeps a Python process alive after the
    // server has gone and the port stays held on the next start.
    lyricsAnalyser.stop();
    process.exit(0);
  });
}

bot.login(DISCORD_BOT_TOKEN).catch((error) => {
  // A bad token otherwise surfaces as an unhandled rejection and a wall of
  // internal stack frames, which says nothing about what to fix.
  console.error(
    error.message?.includes('token')
      ? 'Discord rejected the bot token. Reset it in the Developer Portal '
        + '(Bot -> Reset Token) and update DISCORD_BOT_TOKEN in .env.'
      : `Could not connect to Discord: ${error.message}`,
  );
  process.exit(1);
});
