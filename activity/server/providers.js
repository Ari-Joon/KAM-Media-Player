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
 * ## Provider policy
 *
 * yt-dlp is not an official playback API. YouTube prohibits downloading or
 * separating audio in API clients, and SoundCloud's terms prohibit stream
 * ripping and alternative aggregated listening services. These adapters are
 * therefore experimental development integrations for media the operator is
 * authorised to use, not evidence that a public service is licensed.
 */

import { spawn } from 'node:child_process';
import { mkdir, unlink, stat, readdir } from 'node:fs/promises';
import { SoundCloudApi } from './soundcloud.js';
import path from 'node:path';
import { parseYouTubeId } from './resolve.js';

const {
  YOUTUBE_API_KEY, YTDLP_BIN = 'yt-dlp',
  SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET, FFMPEG_BIN = 'ffmpeg',
} = process.env;

/**
 * SoundCloud through their official API, when credentials are configured.
 *
 * This is the licensed path: their developer terms permit streaming, where
 * extraction breaches them. Where it is available it is used in preference to
 * yt-dlp for every SoundCloud operation - resolve, search and audio - and the
 * extraction path remains only as a fallback for deployments without
 * credentials.
 */
const soundcloudApi = new SoundCloudApi(SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET);

if (soundcloudApi.available) {
  console.log('soundcloud: using the official API (licensed streaming)');
} else {
  console.log('soundcloud: no API credentials set, falling back to extraction. '
    + 'See MEDIA_POLICY.md - the official API is the only path suitable for a '
    + 'deployment you intend to operate commercially.');
}

/**
 * Which provider paths this deployment is actually using, and whether they are
 * licensed.
 *
 * Reported by `/healthz` and printed at boot. The point is that "are we allowed
 * to run this publicly" should be answerable by looking, not by reading source
 * and remembering which environment variables were set on the host. A silent
 * fallback to extraction is exactly how a deployment ends up breaching terms
 * without anyone noticing.
 *
 * @returns {{soundcloud: string, youtube: string, licensed: boolean, note: string}}
 */
export function licensingPosture() {
  const soundcloud = soundcloudApi.available ? 'official-api' : 'extraction';
  // YouTube audio has no sanctioned path at all: the Data API permits search
  // and forbids downloading. There is no configuration that makes it licensed.
  const youtube = YOUTUBE_API_KEY ? 'search-api + extraction' : 'extraction';
  const licensed = soundcloudApi.available;
  return {
    soundcloud,
    youtube,
    licensed,
    note: licensed
      ? 'SoundCloud is on the licensed path. YouTube audio is not, and cannot be '
        + 'made so - remove it before any public or paid deployment.'
      : 'No licensed audio path is active. Suitable for private self-hosted use '
        + 'only. See MEDIA_POLICY.md.',
  };
}

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
  if (!YOUTUBE_API_KEY) {
    throw new Error(
      'YouTube lookup is disabled because YOUTUBE_API_KEY is not configured. '
      + 'Use a SoundCloud link or add a key for development.',
    );
  }
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
  return download(track.url, directory, `yt-${track.providerId}`,
    'bestaudio[ext=m4a]/bestaudio');
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
 * yt-dlp already solves both and needs no credentials, but extraction is not a
 * sanctioned API playback path. It must not be represented as a licensed
 * public integration. See MEDIA_POLICY.md.
 *
 * @param {string} input A soundcloud.com URL, or free text to search.
 * @returns {Promise<object>} Track descriptor.
 */
async function resolveSoundCloud(input) {
  const isLink = /soundcloud\.com\//i.test(input);

  // The official API first, whenever it is configured.
  if (soundcloudApi.available) {
    try {
      if (isLink) return await soundcloudApi.resolve(input);
      const [first] = await soundcloudApi.search(input, 1);
      if (first) return first;
    } catch (error) {
      // A credential or availability problem should not make the track
      // unplayable when extraction would still work, so this falls through
      // rather than throwing - but it is logged, because a deployment relying
      // on the licensed path needs to know it is not being used.
      console.error(`soundcloud api: ${error.message}; falling back to extraction`);
    }
  }

  // `scsearch1:` asks yt-dlp to search SoundCloud and return the top hit.
  const target = isLink ? input : `scsearch1:${input}`;

  // SoundCloud fails intermittently rather than consistently: its API rate
  // limits per address, occasionally 500s, and sometimes serves a track's
  // metadata while refusing its stream. A single attempt therefore looked like
  // "sometimes it works and sometimes it doesn't". Two retries with a growing
  // pause turn nearly all of those into successes.
  let raw = null;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = await run(YTDLP_BIN, [
        '--quiet', '--no-warnings', '--no-playlist', '--dump-single-json',
        // Retrying inside yt-dlp as well: its own backoff handles the
        // transient 5xx responses without paying for a fresh process.
        '--retries', '3', '--extractor-retries', '3',
        target,
      ], 60_000);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
  }

  if (raw === null) {
    throw new Error(
      `SoundCloud did not respond after three attempts: ${lastError?.message ?? 'unknown'}`,
    );
  }

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
/**
 * Read a Spotify track's title and artist.
 *
 * Spotify audio cannot be played here - their terms prohibit synchronising their
 * streams with other media, and there is no extractable audio. What a link does
 * carry is the identity of the song, and that is enough: the track is found on a
 * provider we can actually play.
 *
 * Uses the public oEmbed endpoint, which needs no credentials and returns the
 * title as "Artist - Song" for a track.
 *
 * @param {string} url A Spotify track URL.
 * @returns {Promise<string>} Search terms describing the track.
 */
/**
 * Read a track's title and artist from a link we cannot play directly.
 *
 * Apple Music, Spotify and a few others expose an oEmbed endpoint that returns a
 * human-readable title without any credentials. That is all this needs: the link
 * names the song, and the song is then found on a provider we *can* play. It is
 * the difference between "that link doesn't work" and "here is that track from
 * somewhere else", which is almost always what the person wanted.
 *
 * Apple additionally needs the page title as a fallback, since its oEmbed
 * response omits the artist for some regions.
 *
 * @param {string} url
 * @returns {Promise<string>} Search terms describing the track.
 */
/**
 * Page titles that name a service rather than a track.
 *
 * A dead, private or redirected link serves the service's landing page, and its
 * title is a slogan. Searching for one returns confident nonsense.
 */
const GENERIC_PAGE_TITLE =
  /^(?:soundcloud|spotify|apple music|deezer|tidal|youtube)\b|hear the world|listen to music|web player|sign ?up|log ?in|error|not found|page unavailable/i;

export async function describeLink(url) {
  const endpoints = [
    // Apple Music.
    {
      match: /music\.apple\.com\//i,
      oembed: (link) => `https://music.apple.com/api/v1/oembed?url=${encodeURIComponent(link)}`,
    },
    // Spotify.
    {
      match: /open\.spotify\.com\//i,
      oembed: (link) => `https://open.spotify.com/oembed?url=${encodeURIComponent(link)}`,
    },
    // SoundCloud, for the cases where extraction fails but the page is fine -
    // a private track, a region block, or a broken transcoding.
    {
      match: /soundcloud\.com\//i,
      oembed: (link) => 'https://soundcloud.com/oembed?format=json&url='
        + encodeURIComponent(link),
    },
    // Deezer and Tidal, both of which publish oEmbed and neither of which can
    // be played from here.
    {
      match: /deezer\.com\//i,
      oembed: (link) => `https://api.deezer.com/oembed?url=${encodeURIComponent(link)}`,
    },
    {
      // Tidal. The comment above claimed this was covered and it was not, so a
      // Tidal link fell past every oEmbed entry to the page scrape.
      match: /tidal\.com\//i,
      oembed: (link) => `https://embed.tidal.com/oembed?url=${encodeURIComponent(link)}`,
    },
    {
      // YouTube, for a link whose *audio* cannot be extracted - private,
      // age-gated, region-blocked, or a broken transcoding.
      //
      // Deliberately ahead of the yt-dlp probe that used to be the only
      // fallback here. This endpoint is public, needs no credentials, and
      // returns nothing but the title and channel, which is exactly the "link
      // identification only" category MEDIA_POLICY.md already sanctions for
      // Apple Music, Spotify, Deezer and Tidal. Probing with yt-dlp to learn a
      // title reaches for the one tool that document says cannot be part of a
      // distributable build - to obtain something a licensed endpoint gives
      // away. The probe remains as a last resort for links no oEmbed covers.
      match: /youtu\.?be|youtube\.com/i,
      oembed: (link) => 'https://www.youtube.com/oembed?format=json&url='
        + encodeURIComponent(link),
    },
  ];

  const entry = endpoints.find((candidate) => candidate.match.test(url));

  if (entry) {
    try {
      const response = await fetch(entry.oembed(url), {
        headers: { Accept: 'application/json', 'User-Agent': 'KAMMediaPlayer/1.0' },
      });
      if (response.ok) {
        const info = await response.json();
        // oEmbed's `title` is usually "Artist - Song"; `author_name` carries the
        // artist separately where the title does not.
        const title = String(info.title ?? '').trim();
        const author = String(info.author_name ?? '').trim();
        const terms = title.includes(author) || !author ? title : `${author} ${title}`;
        if (terms) return terms.replace(/\s+by\s+.*$/i, '').trim();
      }
    } catch {
      // Fall through to reading the page.
    }
  }

  // Last resort: read the page's own title tag. Works for essentially any music
  // service, since they all put the track name there for link previews.
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    const html = await response.text();
    const meta = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)
      ?? html.match(/<title[^>]*>([^<]+)</i);
    if (meta) {
      const described = meta[1]
        // Strip the service's own suffix, which is never part of the song name.
        .replace(/\s*[|\u2013-]\s*(?:Apple Music|Spotify|SoundCloud|Deezer|TIDAL).*$/i, '')
        .replace(/\s*on (?:Apple Music|Spotify|SoundCloud)\s*$/i, '')
        .trim();

      // A dead or redirected link serves the service's *home* page, whose title
      // names the service rather than any track - "SoundCloud - Hear the
      // world's sounds" was what a stale link actually produced here. Returning
      // that sends a search for the slogan and comes back with unrelated music,
      // which is worse than admitting the link could not be read.
      if (described && !GENERIC_PAGE_TITLE.test(described)) return described;
    }
  } catch {
    // Nothing more to try.
  }

  throw new Error('That link could not be identified.');
}

export async function describeSpotify(url) {
  const response = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`Spotify returned ${response.status} for that link.`);

  const info = await response.json();
  const title = String(info.title ?? '').trim();
  if (!title) throw new Error('That Spotify link did not name a track.');
  return title;
}

export async function searchSoundCloud(query, limit = 5) {
  if (soundcloudApi.available) {
    try {
      return await soundcloudApi.search(query, limit);
    } catch (error) {
      console.error(`soundcloud api search: ${error.message}; falling back`);
    }
  }

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
  // Licensed path: ask the API for a signed stream URL and let ffmpeg read it.
  // ffmpeg handles HLS natively, so an AAC playlist needs no special treatment
  // beyond being handed over as an input.
  if (soundcloudApi.available) {
    try {
      const { url, protocol } = await soundcloudApi.streamUrl(track);
      const target = path.join(directory, `sc-${track.providerId}.m4a`);
      await run(FFMPEG_BIN, [
        '-hide_banner', '-loglevel', 'error', '-y',
        // Following redirects is required: the signed URL redirects to a CDN.
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-i', url,
        // Copy rather than re-encode where possible; SoundCloud already serves
        // AAC, so a transcode would cost time and quality for nothing.
        '-vn', '-c:a', 'copy',
        target,
      ], 180_000);
      console.log(`soundcloud: fetched via official API (${protocol})`);
      return target;
    } catch (error) {
      console.error(`soundcloud api audio: ${error.message}; falling back to extraction`);
    }
  }

  // SoundCloud now serves AAC over HLS, so yt-dlp muxes through ffmpeg and the
  // resulting container is not predictable - hence the discovery step in
  // `download` rather than naming the file up front.
  return download(track.url, directory, `sc-${track.providerId}`, 'bestaudio');
}

// --- Download and verification ----------------------------------------------

/**
 * Inspect an audio file with ffprobe.
 *
 * A download can succeed and still be unplayable - a video-only stream, an
 * empty HLS mux, or a container ffmpeg cannot open. Without this the symptom is
 * simply silence, which is the hardest possible thing to diagnose.
 *
 * @param {string} filePath
 * @returns {Promise<{codec: string, durationSec: number, channels: number}>}
 * @throws {Error} If the file has no readable audio stream.
 */
async function probeAudio(filePath) {
  const raw = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,channels:format=duration',
    '-of', 'json',
    filePath,
  ], 30_000);

  const info = JSON.parse(raw);
  const stream = info.streams?.[0];
  if (!stream) throw new Error('The downloaded file contains no audio stream.');

  return {
    codec: stream.codec_name ?? 'unknown',
    channels: stream.channels ?? 0,
    durationSec: Math.round(Number(info.format?.duration ?? 0)),
  };
}

/**
 * Download audio with yt-dlp, find what it produced, and verify it plays.
 *
 * yt-dlp picks the output container based on the chosen format, so passing a
 * fixed filename with an extension is unreliable - the previous version assumed
 * `.m4a` and broke on SoundCloud's HLS streams. The output template leaves the
 * extension to yt-dlp and the file is located afterwards.
 *
 * @param {string} url Source URL.
 * @param {string} directory Destination directory.
 * @param {string} stem Filename prefix, without extension.
 * @param {string} format yt-dlp format selector.
 * @returns {Promise<string>} Path to a verified audio file.
 */
/**
 * Largest the audio cache is allowed to grow, in bytes.
 *
 * Downloaded tracks were never removed, so the directory grew without limit -
 * fine on a desktop with a spare terabyte, fatal on a Fly volume of a few
 * gigabytes, and it fails as a disk-full error somewhere unrelated rather than
 * as anything that names the cause.
 */
const CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * Delete the least recently used audio until the cache fits its budget.
 *
 * Access time would be the ideal ordering, but many filesystems mount with
 * `noatime` and stop updating it, so modification time is used instead: it is
 * always maintained, and for write-once cache files the two are equivalent.
 *
 * @param {string} directory
 * @param {string} [keepStem] A file being written right now, never deleted.
 */
async function pruneCache(directory, keepStem = '') {
  const names = await readdir(directory).catch(() => []);
  const files = [];
  let total = 0;

  for (const name of names) {
    // Only audio: the score cache and favourites store live here too.
    if (!/\.(m4a|mp3|opus|webm|ogg|wav)$/i.test(name)) continue;
    const full = path.join(directory, name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    files.push({ full, name, size: info.size, at: info.mtimeMs });
    total += info.size;
  }

  if (total <= CACHE_MAX_BYTES) return;

  files.sort((a, b) => a.at - b.at);
  let freed = 0;
  for (const file of files) {
    if (total - freed <= CACHE_MAX_BYTES) break;
    if (keepStem && file.name.startsWith(keepStem)) continue;
    await unlink(file.full).catch(() => {});
    freed += file.size;
  }

  if (freed > 0) {
    console.log(`cache: freed ${(freed / 1024 / 1024).toFixed(0)}MB `
      + `(was ${(total / 1024 / 1024).toFixed(0)}MB)`);
  }
}

async function download(url, directory, stem, format) {
  // Clear any leftovers from a previous failed attempt with the same stem.
  for (const name of await readdir(directory).catch(() => [])) {
    if (name.startsWith(stem)) await unlink(path.join(directory, name)).catch(() => {});
  }

  await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--no-playlist',
    '-f', format,
    '-o', path.join(directory, `${stem}.%(ext)s`),
    url,
  ]);

  const produced = (await readdir(directory))
    .filter((name) => name.startsWith(stem))
    .map((name) => path.join(directory, name));
  if (produced.length === 0) {
    throw new Error('yt-dlp reported success but produced no file.');
  }

  const filePath = produced[0];
  const info = await stat(filePath);
  if (info.size < 1024) {
    await unlink(filePath).catch(() => {});
    throw new Error('The downloaded audio file was empty.');
  }

  let audio;
  try {
    audio = await probeAudio(filePath);
  } catch (error) {
    await unlink(filePath).catch(() => {});
    throw new Error(`Downloaded audio is unplayable: ${error.message}`);
  }

  console.log(
    `audio ready: ${path.basename(filePath)} `
    + `${audio.codec} ${audio.channels}ch ${audio.durationSec}s `
    + `${(info.size / 1024 / 1024).toFixed(1)}MB`,
  );

  // Not awaited: the track can start playing while old files are removed.
  pruneCache(directory, stem).catch((error) => {
    console.error('cache prune failed:', error.message);
  });
  return filePath;
}

// --- Registry ---------------------------------------------------------------

/**
 * Available providers.
 *
 * Keeping providers behind one registry makes them replaceable with licensed
 * sources without rewriting the queue, voice, or visual systems.
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
export const DEFAULT_PROVIDER = YOUTUBE_API_KEY ? 'youtube' : 'soundcloud';

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

  // Verification lives in `download`, which knows what yt-dlp actually wrote.
  return provider.fetchAudio(track, directory);
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
