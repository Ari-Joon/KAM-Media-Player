/**
 * Provider layer: resolve a request to a track, and fetch its full audio.
 *
 * ## Why full files rather than streams
 *
 * Audio is downloaded to a temporary file before playback starts, instead of
 * piping a live stream into the voice connection. That costs a few seconds of
 * latency and buys three things that matter more:
 *
 * 1. **Analysis and playback see identical audio.** The score is computed from
 *    the exact file being played, so beat positions line up perfectly. The
 *    previous design analysed a 30-second preview of a *different* master and
 *    could never recover the phase.
 * 2. **The whole track is analysed**, so sections and lanes cover the real
 *    structure rather than looping an excerpt.
 * 3. **Robustness.** A stalled network stream mid-song is a dead playback; a
 *    stalled download simply fails before anything starts.
 *
 * ## On YouTube
 *
 * `yt-dlp` extraction violates YouTube's Terms of Service. Enforcement has
 * historically targeted scale - the cease-and-desists that ended Groovy and
 * Rythm landed at tens of millions of servers - so a private bot carries little
 * practical risk while a distributed commercial one carries a lot.
 *
 * The provider interface exists so this is a one-line decision rather than a
 * rewrite: delete `youtube` from {@link PROVIDERS} and the rest of the system
 * continues on SoundCloud alone, which serves streams under its documented API
 * terms and is safe to ship commercially.
 */

import { spawn } from 'node:child_process';
import { mkdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseYouTubeId } from './resolve.js';

const { YOUTUBE_API_KEY, YTDLP_BIN = 'yt-dlp' } = process.env;

/** Hard ceiling on track length, to bound disk and analysis time. */
const MAX_DURATION_SEC = 12 * 60;

/**
 * Run a command to completion, collecting stdout.
 *
 * @param {string} command Executable name or path.
 * @param {string[]} args Arguments.
 * @param {number} [timeoutMs] Kill the process after this long.
 * @returns {Promise<string>} Trimmed stdout.
 * @throws {Error} If the process fails, is missing, or times out.
 */
function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT'
        ? new Error(`${command} is not installed or not on PATH.`)
        : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim().split('\n').pop() || `${command} exited ${code}`));
    });
  });
}

// --- YouTube ----------------------------------------------------------------

/**
 * Resolve free text or a link to a YouTube track.
 *
 * A pasted link uses `videos.list` at 1 quota unit; free text needs
 * `search.list` at 100, against a daily allowance of roughly 100 searches.
 *
 * @param {string} input Anything the user typed.
 * @returns {Promise<object>} Track descriptor.
 */
async function resolveYouTube(input) {
  const videoId = parseYouTubeId(input);
  const url = new URL(videoId
    ? 'https://www.googleapis.com/youtube/v3/videos'
    : 'https://www.googleapis.com/youtube/v3/search');

  url.search = new URLSearchParams(videoId
    ? { part: 'snippet,contentDetails', id: videoId, key: YOUTUBE_API_KEY }
    : {
        part: 'snippet', q: input, type: 'video', videoEmbeddable: 'true',
        videoCategoryId: '10', maxResults: '1', key: YOUTUBE_API_KEY,
      }).toString();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'The YouTube quota is used up for today. It resets at midnight Pacific.'
      : `YouTube lookup failed (${response.status}).`);
  }

  const { items = [] } = await response.json();
  if (items.length === 0) {
    throw new Error(videoId
      ? 'That video is unavailable, private or region-locked.'
      : `Nothing found for "${input}".`);
  }

  const id = videoId ?? items[0].id.videoId;
  return {
    provider: 'youtube',
    providerId: id,
    title: items[0].snippet.title,
    artist: items[0].snippet.channelTitle,
    url: `https://www.youtube.com/watch?v=${id}`,
    durationSec: parseIsoDuration(items[0].contentDetails?.duration),
  };
}

/**
 * Parse an ISO 8601 duration such as `PT3M22S` into seconds.
 *
 * @param {string|undefined} iso
 * @returns {number} Seconds, or 0 when absent (search results omit it).
 */
function parseIsoDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const [, h = 0, m = 0, s = 0] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Download a YouTube track's audio to disk via yt-dlp.
 *
 * @param {object} track Track descriptor from {@link resolveYouTube}.
 * @param {string} directory Destination directory.
 * @returns {Promise<string>} Path to the downloaded audio file.
 */
async function fetchYouTubeAudio(track, directory) {
  const target = path.join(directory, `${track.providerId}.m4a`);
  await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--no-playlist',
    // Prefer m4a: it decodes cleanly in librosa via ffmpeg and needs no
    // remuxing before Discord's encoder sees it.
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--audio-quality', '0',
    '-o', target,
    track.url,
  ]);
  return target;
}

// --- SoundCloud -------------------------------------------------------------

/**
 * Resolve a SoundCloud link or search phrase.
 *
 * Uses yt-dlp rather than SoundCloud's REST API, for two concrete reasons:
 *
 * 1. **Auth.** `client_id` as a query parameter was deprecated in 2021; the API
 *    now requires an OAuth `client_credentials` token that expires every six
 *    hours and must be refreshed. Every client is treated as confidential, so a
 *    secret is mandatory too.
 * 2. **Streams.** SoundCloud retired MP3 and Opus transcodings in favour of AAC
 *    over HLS at the end of 2025. The old `stream_url` field no longer yields
 *    playable audio, so a client would have to consume HLS playlists itself.
 *
 * yt-dlp already solves both, needs no credentials, and is the same tool the
 * YouTube path uses. The trade-off is honest and worth stating: this is
 * extraction rather than sanctioned API use, so it does not carry the
 * "commercially defensible" property the official API would. Restoring that
 * means implementing the token flow and HLS handling above.
 *
 * @param {string} input A soundcloud.com URL, or free text to search.
 * @returns {Promise<object>} Track descriptor.
 */
async function resolveSoundCloud(input) {
  const isLink = /soundcloud\.com\//i.test(input);
  // `scsearch1:` asks yt-dlp to search SoundCloud and return the top hit.
  const target = isLink ? input : `scsearch1:${input}`;

  const raw = await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--no-playlist', '--dump-single-json', target,
  ], 60_000);

  const info = JSON.parse(raw);
  // A search returns a playlist wrapper; a direct link returns the track.
  const track = info.entries?.[0] ?? info;
  if (!track?.id) throw new Error(`No SoundCloud track found for "${input}".`);

  return {
    provider: 'soundcloud',
    providerId: String(track.id),
    title: track.title ?? 'Untitled',
    artist: track.uploader ?? track.uploader_id ?? 'Unknown',
    url: track.webpage_url ?? input,
    durationSec: Math.round(track.duration ?? 0),
    thumbnail: track.thumbnail ?? null,
  };
}

/**
 * Search SoundCloud for several candidates.
 *
 * Useful as a fallback when the YouTube quota is exhausted: SoundCloud has no
 * per-day search allowance to run out of.
 *
 * @param {string} query Free text.
 * @param {number} [limit] Results to return.
 * @returns {Promise<object[]>} Track descriptors.
 */
export async function searchSoundCloud(query, limit = 5) {
  const raw = await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--flat-playlist', '--dump-single-json',
    `scsearch${limit}:${query}`,
  ], 60_000);

  const info = JSON.parse(raw);
  const entries = info.entries ?? [];
  if (entries.length === 0) throw new Error(`Nothing found on SoundCloud for "${query}".`);

  return entries.map((track) => ({
    provider: 'soundcloud',
    providerId: String(track.id),
    title: track.title ?? 'Untitled',
    artist: track.uploader ?? 'Unknown',
    url: track.url ?? track.webpage_url,
    durationSec: Math.round(track.duration ?? 0),
    thumbnail: track.thumbnails?.[0]?.url ?? null,
  }));
}

/**
 * Download a SoundCloud track's audio.
 *
 * yt-dlp handles the HLS/AAC transcoding SoundCloud now serves, which a plain
 * HTTP fetch of a stream URL cannot.
 *
 * @param {object} track Track descriptor.
 * @param {string} directory Destination directory.
 * @returns {Promise<string>} Path to the downloaded audio file.
 */
async function fetchSoundCloudAudio(track, directory) {
  const target = path.join(directory, `sc-${track.providerId}.m4a`);
  await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--no-playlist',
    '-f', 'bestaudio',
    '--audio-quality', '0',
    '-o', target,
    track.url,
  ]);
  return target;
}

// --- Registry ---------------------------------------------------------------

/**
 * Available providers.
 *
 * Removing `youtube` from this object is the entire change needed to make the
 * bot commercially distributable - nothing else in the codebase references it
 * directly.
 */
export const PROVIDERS = {
  soundcloud: {
    resolve: resolveSoundCloud,
    fetchAudio: fetchSoundCloudAudio,
    matches: (input) => /soundcloud\.com\//i.test(input),
  },
  youtube: {
    resolve: resolveYouTube,
    fetchAudio: fetchYouTubeAudio,
    matches: (input) => /youtu\.?be/i.test(input) || parseYouTubeId(input) !== null,
  },
};

/** Provider tried for free-text searches when no link is recognised. */
export const DEFAULT_PROVIDER = 'youtube';

/**
 * Resolve user input to a track, choosing a provider by link shape.
 *
 * @param {string} input Anything the user typed after /play.
 * @param {string} [fallback] Provider for plain search terms.
 * @returns {Promise<object>} Track descriptor.
 * @throws {Error} If nothing matches or the track is too long.
 */
export async function resolveTrack(input, fallback = DEFAULT_PROVIDER) {
  const name = Object.keys(PROVIDERS).find((key) => PROVIDERS[key].matches(input))
    ?? fallback;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Provider "${name}" is not available.`);

  const track = await provider.resolve(input);
  if (track.durationSec > MAX_DURATION_SEC) {
    throw new Error(
      `That track is ${Math.round(track.durationSec / 60)} minutes long; the `
      + `limit is ${MAX_DURATION_SEC / 60}.`,
    );
  }
  return track;
}

/**
 * Download a track's audio, reusing an existing file when present.
 *
 * @param {object} track Track descriptor.
 * @param {string} directory Destination directory.
 * @returns {Promise<string>} Path to the audio file.
 */
export async function fetchAudio(track, directory) {
  await mkdir(directory, { recursive: true });
  const provider = PROVIDERS[track.provider];
  if (!provider) throw new Error(`Provider "${track.provider}" is not available.`);

  const target = await provider.fetchAudio(track, directory);
  const info = await stat(target).catch(() => null);
  if (!info || info.size < 1024) {
    await unlink(target).catch(() => {});
    throw new Error('The downloaded audio file was empty.');
  }
  return target;
}

/**
 * Search a provider for several candidates, so the user can choose.
 *
 * A single "best match" is wrong often enough to be annoying - covers, live
 * versions and sped-up edits all outrank the studio original for some queries.
 *
 * @param {string} query Free text.
 * @param {number} [limit] Results to return.
 * @returns {Promise<object[]>} Track descriptors.
 */
export async function searchTracks(query, limit = 5) {
  if (!YOUTUBE_API_KEY) return searchSoundCloud(query, limit);

  try {
    return await searchYouTube(query, limit);
  } catch (error) {
    // Quota exhaustion is the common failure and it lasts until midnight
    // Pacific. Falling back keeps the bot usable rather than dead for hours.
    if (/quota/i.test(error.message)) {
      console.log('YouTube quota exhausted; searching SoundCloud instead.');
      return searchSoundCloud(query, limit);
    }
    throw error;
  }
}

/**
 * Search YouTube for several candidates.
 *
 * @param {string} query Free text.
 * @param {number} [limit] Results to return.
 * @returns {Promise<object[]>} Track descriptors.
 */
async function searchYouTube(query, limit = 5) {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    part: 'snippet', q: query, type: 'video', videoEmbeddable: 'true',
    videoCategoryId: '10', maxResults: String(limit), key: YOUTUBE_API_KEY,
  }).toString();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'The YouTube quota is used up for today. It resets at midnight Pacific.'
      : `YouTube search failed (${response.status}).`);
  }

  const { items = [] } = await response.json();
  if (items.length === 0) throw new Error(`Nothing found for "${query}".`);

  // search.list omits durations, so they are fetched in one extra call
  // (1 quota unit) rather than one per result.
  const ids = items.map((item) => item.id.videoId).join(',');
  const details = new URL('https://www.googleapis.com/youtube/v3/videos');
  details.search = new URLSearchParams({
    part: 'contentDetails', id: ids, key: YOUTUBE_API_KEY,
  }).toString();

  const durations = new Map();
  try {
    const detailResponse = await fetch(details);
    if (detailResponse.ok) {
      const payload = await detailResponse.json();
      for (const item of payload.items ?? []) {
        durations.set(item.id, parseIsoDuration(item.contentDetails?.duration));
      }
    }
  } catch {
    // Durations are cosmetic; a failure here should not block playback.
  }

  return items.map((item) => ({
    provider: 'youtube',
    providerId: item.id.videoId,
    title: item.snippet.title,
    artist: item.snippet.channelTitle,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    durationSec: durations.get(item.id.videoId) ?? 0,
    thumbnail: item.snippet.thumbnails?.medium?.url ?? null,
  }));
}

/**
 * Check that yt-dlp is present, so the failure is reported at boot rather than
 * on a user's first request.
 *
 * @returns {Promise<string|null>} Version string, or null if unavailable.
 */
export async function checkYtDlp() {
  try {
    return await run(YTDLP_BIN, ['--version'], 15_000);
  } catch {
    return null;
  }
}
