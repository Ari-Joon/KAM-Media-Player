/**
 * Track resolution and query normalisation.
 *
 * Two jobs, both of which were failing:
 *
 * 1. **YouTube links.** A pasted URL must become a video ID and be looked up
 *    directly. Feeding the URL text to `search.list` searched for the URL as a
 *    phrase, and cost 100 quota units to do it. `videos.list` costs 1.
 *
 * 2. **iTunes queries.** The preview lookup needs a clean "artist title"
 *    string. YouTube titles are full of noise - "(Official Video)",
 *    "[Music Video]", "ft." clauses, "| 4K" suffixes - and the channel name
 *    usually repeats the artist. The unfiltered concatenation matched nothing,
 *    which is why every track reported having no preview.
 *
 * Pure functions with no network calls, so the parsing rules can be tested
 * against real-world titles.
 */

/**
 * Bracketed segments containing any of these are noise, not part of the title.
 * "(Remix)" and "(Live)" are deliberately included: dropping them may match the
 * studio original instead, which is a better outcome than finding nothing.
 */
const NOISE_PATTERN =
  /official|video|audio|lyric|visuali[sz]er|hd|hq|4k|8k|remaster|explicit|clean|full album|music video|mv|prod\.?\s|directed by|out now|premiere/i;

/** Channel-name suffixes that are branding rather than artist name. */
const CHANNEL_NOISE =
  /\s*(-\s*topic|vevo|official|officiel|music|records|recordings|tv|channel|entertainment)\s*$/gi;

/** Results from these are covers or karaoke, never the track the user wanted. */
const IMPOSTOR_PATTERN =
  /karaoke|tribute|made famous by|in the style of|instrumental version|cover version|\bcovers?\b/i;

/**
 * Extract a YouTube video ID from a URL or bare ID.
 *
 * Handles watch URLs, youtu.be short links, /shorts/, /embed/, and
 * music.youtube.com, with or without a scheme and with extra query parameters.
 *
 * @param {string} input Anything the user typed.
 * @returns {string|null} The 11-character video ID, or null if not a link.
 */
export function parseYouTubeId(input) {
  const text = input.trim();

  // A bare video ID. Exactly 11 chars from YouTube's alphabet.
  if (/^[\w-]{11}$/.test(text)) return text;

  if (!/youtu/i.test(text)) return null;

  const patterns = [
    /[?&]v=([\w-]{11})/,            // watch?v=ID
    /youtu\.be\/([\w-]{11})/,       // youtu.be/ID
    /\/shorts\/([\w-]{11})/,        // /shorts/ID
    /\/embed\/([\w-]{11})/,         // /embed/ID
    /\/live\/([\w-]{11})/,          // /live/ID
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Strip promotional noise from a YouTube video title.
 *
 * Bracketed segments are removed only when they look like noise, so a genuine
 * parenthetical such as "(Reprise)" survives. Feature credits and everything
 * after a pipe are dropped, since neither helps a catalogue search.
 *
 * @param {string} title Raw video title.
 * @returns {string} Cleaned title.
 */
export function cleanTitle(title) {
  let text = title;

  // Remove bracketed segments whose contents look promotional.
  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (match, inner) =>
    NOISE_PATTERN.test(inner) ? ' ' : match,
  );

  // Drop a trailing feature credit and anything after a pipe or bullet.
  text = text.replace(/\s+(ft\.?|feat\.?|featuring)\s+.*$/i, ' ');
  text = text.replace(/\s*[|•·]\s*.*$/, ' ');

  // Trailing standalone noise words left over after bracket removal.
  text = text.replace(/\s+(official|hd|hq|4k|8k|audio|video|lyrics)\s*$/i, ' ');

  return text.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Remove branding from a channel name to recover the artist.
 *
 * @param {string} channel YouTube channel title.
 * @returns {string} Probable artist name.
 */
export function cleanChannel(channel) {
  return channel.replace(CHANNEL_NOISE, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Split "Artist - Title" into parts, if the title uses that convention.
 *
 * Only the first separator is used, because remixes and subtitles routinely
 * contain further dashes that are part of the title.
 *
 * @param {string} cleanedTitle Output of {@link cleanTitle}.
 * @returns {{artist: string|null, title: string}}
 */
export function splitArtistTitle(cleanedTitle) {
  const match = cleanedTitle.match(/^(.{2,60}?)\s+[-–—]\s+(.+)$/);
  if (!match) return { artist: null, title: cleanedTitle };
  return { artist: match[1].trim(), title: match[2].trim() };
}

/**
 * Build an ordered list of search terms to try against iTunes.
 *
 * Ordered most to least specific. The cascade matters because no single form
 * works for every title convention: "Artist - Title" videos need the split,
 * topic-channel uploads carry the artist only in the channel name, and some
 * titles are just the song name.
 *
 * @param {string} rawTitle Raw YouTube video title.
 * @param {string} rawChannel Raw YouTube channel title.
 * @returns {string[]} Deduplicated candidate search terms.
 */
export function buildSearchTerms(rawTitle, rawChannel) {
  const cleaned = cleanTitle(rawTitle);
  const channel = cleanChannel(rawChannel || '');
  const { artist, title } = splitArtistTitle(cleaned);

  const candidates = [
    artist ? `${artist} ${title}` : null,
    channel && title !== cleaned ? `${channel} ${title}` : null,
    channel ? `${channel} ${cleaned}` : null,
    cleaned,
    title,
  ];

  // Deduplicate case-insensitively while preserving order.
  const seen = new Set();
  return candidates
    .filter((term) => term && term.length > 1)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Choose the best usable result from an iTunes search response.
 *
 * Requires a preview URL, and rejects karaoke and cover versions, which iTunes
 * returns readily for popular songs and which would produce a score for the
 * wrong recording entirely.
 *
 * @param {Array<object>} results `results` array from the iTunes API.
 * @returns {object|null} The chosen result, or null if none qualify.
 */
export function pickPreview(results) {
  for (const result of results ?? []) {
    if (!result.previewUrl) continue;
    const haystack = [result.trackName, result.collectionName, result.artistName]
      .filter(Boolean)
      .join(' ');
    if (IMPOSTOR_PATTERN.test(haystack)) continue;
    return result;
  }
  return null;
}
