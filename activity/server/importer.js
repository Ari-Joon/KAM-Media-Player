/**
 * Playlist import: read a public playlist page, then find each track on
 * YouTube or SoundCloud.
 *
 * Nothing is streamed from Apple or Spotify - only the track *names* are taken,
 * and playback comes from the providers this bot already uses. That avoids
 * Apple's paid developer membership and Spotify's prohibition on synchronising
 * their content with other audio, but it is still scraping a page rather than
 * using a sanctioned API, so it can break whenever either site changes its
 * markup, and it is not something to rely on commercially.
 *
 * ## Resolution order
 *
 * SoundCloud is tried first for every track, because its search costs nothing.
 * YouTube is the fallback for misses only, and is capped - a 50-track playlist
 * resolved entirely through YouTube would consume half the daily search quota in
 * one command.
 *
 * Anything found on neither is reported back by name rather than silently
 * dropped, so it is obvious what did not make it.
 */

import { searchSoundCloud, searchTracks } from './providers.js';
import { loadConfig } from './config.js';
import { logger } from './log.js';

const log = logger('import');

/**
 * The YouTube key, read when it is needed rather than at module load.
 *
 * Reading it at load made importing this module require the whole server
 * configuration - a client id, a bot token - which is nonsense for a link
 * parser and made `parsePlaylistUrl` untestable without a full .env.
 */
const youtubeKey = () => loadConfig().YOUTUBE_API_KEY;

/** Most tracks taken from one playlist. */
const MAX_TRACKS = 60;

/** Most misses to retry on YouTube, to bound quota spend per import. */
const MAX_YOUTUBE_FALLBACKS = 12;

/**
 * Identify a supported playlist URL.
 *
 * @param {string} url
 * @returns {{kind: 'apple'|'spotify', id: string}|null}
 */
export function parsePlaylistUrl(url) {
  const apple = url.match(/music\.apple\.com\/[^/]+\/(?:playlist|album)\/[^/]+\/(pl\.[\w-]+|\d+)/i);
  if (apple) return { kind: 'apple', id: apple[1] };

  const spotify = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album)\/([A-Za-z0-9]+)/i);
  if (spotify) return { kind: 'spotify', id: spotify[2] };

  // YouTube, and only via `list=`. This is the one import that does not scrape:
  // the Data API returns the playlist in its real order, with video IDs, so
  // nothing has to be searched for by name and nothing can be matched to the
  // wrong song. `RD`-prefixed lists are radio mixes generated per viewer rather
  // than playlists, and have no stable contents to import.
  const youtube = url.match(/[?&]list=([A-Za-z0-9_-]+)/i);
  if (youtube && !/^RD/i.test(youtube[1])) return { kind: 'youtube', id: youtube[1] };

  return null;
}

/**
 * Read a YouTube playlist through the Data API.
 *
 * The only import that is not scraping. `playlistItems` returns the playlist in
 * its own order with a video ID per entry, so the result is *already playable* -
 * no track has to be searched for by name, and none can be matched to a cover,
 * a live version or the wrong artist entirely, which is the standing risk of
 * every name-based import.
 *
 * Paged deliberately rather than asking for everything: the API caps a page at
 * 50, and a playlist of several hundred would otherwise silently import its
 * first fifty and look complete.
 *
 * @param {string} id
 * @returns {Promise<{source: string, playable: object[], name: string|null}>}
 */
async function readYouTubePlaylist(id) {
  if (!youtubeKey()) {
    throw new Error(
      'Importing a YouTube playlist needs YOUTUBE_API_KEY. A SoundCloud, Apple '
      + 'Music or Spotify link works without one.',
    );
  }

  const playable = [];
  let pageToken = '';

  while (playable.length < MAX_TRACKS) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.search = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId: id,
      maxResults: '50',
      key: youtubeKey(),
      ...(pageToken ? { pageToken } : {}),
    }).toString();

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.status === 404
        ? 'That playlist is private or does not exist.'
        : response.status === 403
          ? 'The YouTube quota is used up for today. It resets at midnight Pacific.'
          : `YouTube playlist lookup failed (${response.status}).`);
    }
    const page = await response.json();

    for (const item of page.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      const title = item.snippet?.title;
      // Deleted and private entries keep their slot in a playlist but carry no
      // usable title. Skipped rather than imported as "Private video", which
      // would queue something unplayable and look like a bug at playback.
      if (!videoId || !title || title === 'Private video' || title === 'Deleted video') continue;
      playable.push({
        provider: 'youtube',
        providerId: videoId,
        title,
        artist: item.snippet?.videoOwnerChannelTitle ?? '',
        thumbnail: item.snippet?.thumbnails?.medium?.url
          ?? item.snippet?.thumbnails?.default?.url ?? null,
        durationSec: 0,
      });
      if (playable.length >= MAX_TRACKS) break;
    }

    pageToken = page.nextPageToken ?? '';
    if (!pageToken) break;
  }

  if (playable.length === 0) {
    throw new Error('That playlist has nothing playable in it.');
  }

  log.info(`imported ${playable.length} track(s) from a YouTube playlist`);
  return { source: 'youtube', playable, name: null };
}

/** Fetch a page as a browser would, since both sites vary by user agent. */
async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Page returned ${response.status}.`);
  return response.text();
}

/**
 * Recursively collect plausible track entries from an arbitrary JSON structure.
 *
 * Both sites embed deeply nested state whose exact shape changes without notice,
 * so this looks for the *shape* of a track - a name plus an artist - anywhere in
 * the tree, rather than following a fixed path that would break on every
 * redesign.
 *
 * @param {unknown} node
 * @param {Array<{title: string, artist: string}>} found
 */
function harvestTracks(node, found) {
  if (found.length >= MAX_TRACKS) return;

  if (Array.isArray(node)) {
    for (const item of node) harvestTracks(item, found);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const title = node.name ?? node.title ?? node.trackName ?? null;
  const artist = node.artistName ?? node.artist ?? node.subtitle
    ?? node.artists?.[0]?.name ?? node.artists?.[0] ?? null;

  const artistText = typeof artist === 'string' ? artist : artist?.name ?? null;

  if (typeof title === 'string' && artistText && title.length < 200) {
    // Reject obvious non-tracks: playlist names carry no artist, and section
    // headings tend to be very short.
    if (title.length > 1 && artistText.length > 1) {
      const duplicate = found.some(
        (entry) => entry.title === title && entry.artist === artistText,
      );
      if (!duplicate) found.push({ title, artist: artistText });
    }
  }

  for (const value of Object.values(node)) harvestTracks(value, found);
}

/**
 * Extract every JSON blob embedded in a page and harvest tracks from each.
 *
 * @param {string} html
 * @returns {Array<{title: string, artist: string}>}
 */
function extractFromHtml(html) {
  const found = [];

  // Script tags holding JSON: `serialized-server-data` on Apple,
  // `__NEXT_DATA__` and friends on Spotify, plus any JSON-LD.
  const scripts = html.matchAll(
    /<script[^>]*type="application\/(?:json|ld\+json)"[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of scripts) {
    try {
      harvestTracks(JSON.parse(match[1]), found);
    } catch {
      // A blob that isn't valid JSON is not worth reporting; try the next.
    }
    if (found.length >= MAX_TRACKS) break;
  }

  // Fallback: Apple pages carry `music:song` meta tags listing track URLs whose
  // slugs contain the title. Worse quality, but better than nothing.
  if (found.length === 0) {
    const metas = html.matchAll(/<meta[^>]+content="([^"]*\/song\/([^/"]+)\/[^"]*)"/gi);
    for (const match of metas) {
      const title = decodeURIComponent(match[2]).replace(/-/g, ' ');
      if (title.length > 1) found.push({ title, artist: '' });
      if (found.length >= MAX_TRACKS) break;
    }
  }

  return found.slice(0, MAX_TRACKS);
}

/**
 * Read the track list from a public playlist page.
 *
 * @param {string} url Apple Music or Spotify playlist/album URL.
 * @returns {Promise<{source: string, tracks: Array<{title: string, artist: string}>}>}
 * @throws {Error} If the URL is unsupported or nothing could be read.
 */
export async function readPlaylist(url) {
  const parsed = parsePlaylistUrl(url);
  if (!parsed) {
    throw new Error('That is not a YouTube, Apple Music or Spotify playlist link.');
  }

  // YouTube returns playable tracks directly, so it skips `resolveAll`
  // entirely - see `readYouTubePlaylist`.
  if (parsed.kind === 'youtube') return readYouTubePlaylist(parsed.id);

  // Spotify's embed view is far more stable to parse than the full app page,
  // which renders its track list client-side.
  const target = parsed.kind === 'spotify'
    ? `https://open.spotify.com/embed/playlist/${parsed.id}`
    : url;

  const html = await fetchPage(target);
  const tracks = extractFromHtml(html);

  if (tracks.length === 0) {
    throw new Error(
      'Could not read any tracks from that page. It may be private, or the '
      + 'site may have changed its layout.',
    );
  }

  log.info(`read ${tracks.length} track(s) from ${parsed.kind}`);
  return { source: parsed.kind, tracks };
}

/**
 * Find each named track on a provider we can actually play.
 *
 * @param {Array<{title: string, artist: string}>} wanted
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{resolved: object[], missing: string[]}>}
 */
export async function resolveAll(wanted, onProgress) {
  const resolved = [];
  const missing = [];
  let youtubeAttempts = 0;

  for (const [index, entry] of wanted.entries()) {
    const query = `${entry.artist} ${entry.title}`.trim();
    let track = null;

    // SoundCloud first: its search has no daily allowance to exhaust.
    try {
      [track] = await searchSoundCloud(query, 1);
    } catch {
      track = null;
    }

    // YouTube only for misses, and only up to the cap.
    if (!track && youtubeAttempts < MAX_YOUTUBE_FALLBACKS) {
      youtubeAttempts += 1;
      try {
        [track] = await searchTracks(query, 1);
      } catch {
        track = null;
      }
    }

    if (track) resolved.push(track);
    else missing.push(query);

    onProgress?.(index + 1, wanted.length);
  }

  log.info(`resolved ${resolved.length}, missing ${missing.length}`
    + ` (${youtubeAttempts} YouTube searches used)`);
  return { resolved, missing };
}
