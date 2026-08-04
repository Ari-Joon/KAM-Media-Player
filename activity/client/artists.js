/**
 * Work out how many people are on a track.
 *
 * The stick men are meant to be the performers, so a solo track should not be
 * danced by a chorus line of five. There is no artist-count field in any
 * provider's metadata, but the information is almost always present in the title
 * and channel name - "A ft. B", "A x B", "A & B (feat. C)" - so it is parsed out
 * of those.
 *
 * Deliberately conservative: when nothing can be established, one figure is a
 * better default than a crowd, because a solo performer reads as intentional
 * while an arbitrary group reads as filler.
 */

/**
 * Separators that genuinely indicate additional performers.
 *
 * The comma is allowed to have no leading space, because "DJ Snake, Lauv" is
 * written exactly that way and requiring symmetry missed it.
 */
const SEPARATORS = new RegExp([
  // Comma may have no leading space: "DJ Snake, Lauv".
  '\\s*,\\s+',
  // Feature words end in a full stop and are often written without a space
  // after it: "Illit ft.Tupac".
  '\\s+(?:ft|feat|featuring)\\.?\\s*',
  // The rest need spaces on both sides, or "Lil Nas X" would split on its own
  // name and "A+B" inside a title would be misread.
  '\\s+(?:with|vs\\.?|versus|&|x|×|\\+)\\s+',
].join('|'), 'gi');

/**
 * Words that look like separators but are not, in the contexts they appear.
 * "x" between two words is a collaboration; "Mix" is not.
 */
const NOT_ARTISTS = /^(?:official|video|audio|lyrics?|hd|hq|4k|remix|mix|edit|version|mashup|topic|vevo|records?|music|prod\.?)$/i;

/** Strip bracketed promotional content, which is full of false separators. */
function stripNoise(text) {
  return text
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\|.*$/, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Names credited on a track.
 *
 * @param {string} title Track title.
 * @param {string} artist Artist or channel name.
 * @returns {string[]} Distinct performer names, best effort.
 */
export function creditedArtists(title = '', artist = '') {
  // Feature credits appear two ways and both have to be caught:
  //
  //   bracketed   "(Illit ft.Tupac)" - inside brackets stripNoise would remove
  //   trailing    "Old Town Road ft. Billy Ray Cyrus" - after the song name
  //
  // The bracketed form is read before stripping. The trailing form is read
  // after, because only then are the promotional brackets out of the way.
  // Note `ft.Tupac` has no space, so the separator must not require one.
  const featured = [];
  for (const match of String(title).matchAll(/[([]([^)\]]+)[)\]]/g)) {
    const inner = match[1];
    // A bracket is only an artist list if it credits someone. Requiring it to
    // *start* with the feature word missed "(Illit ft.Tupac)", where the lead
    // artist comes first.
    if (/\b(?:ft|feat|featuring|with)\b|&| x |,/i.test(inner)) featured.push(inner);
  }

  const cleanTitle = stripNoise(String(title));

  const trailing = cleanTitle.match(/(?:^|\s)(?:ft|feat|featuring)\.?\s*(.+)$/i);
  if (trailing) featured.push(trailing[1]);
  // Only the part before a dash is the artist list; after it is the song name.
  // Everything before the first dash is the artist list; after it is the song
  // name, which must not be mined for names.
  let artistPart = cleanTitle.includes(' - ')
    ? cleanTitle.slice(0, cleanTitle.indexOf(' - '))
    : '';
  // A trailing feature credit can sit inside the artist part when there is no
  // dash at all; remove it so it is not counted twice.
  artistPart = artistPart.replace(/\s+(?:ft|feat|featuring)\.?\s*.+$/i, '');

  const channel = String(artist).replace(/\s*-\s*topic\s*$/i, '').replace(/vevo$/i, '').trim();

  // The channel is only a fallback. Including it alongside parsed names counted
  // the uploader as a third performer on "(Illit ft.Tupac)" uploads.
  const names = new Set();
  for (const source of [artistPart, ...featured]) {
    if (!source) continue;
    for (const part of source.split(SEPARATORS)) {
      const name = part.trim().replace(/^[-–—]\s*/, '');
      if (name.length < 2 || name.length > 40) continue;
      if (NOT_ARTISTS.test(name)) continue;
      names.add(name.toLowerCase());
    }
  }

  // Nothing parsed from the title: the channel is the performer.
  if (names.size === 0 && channel) {
    for (const part of channel.split(SEPARATORS)) {
      const name = part.trim();
      if (name.length >= 2 && !NOT_ARTISTS.test(name)) names.add(name.toLowerCase());
    }
    if (names.size === 0) names.add(channel.toLowerCase());
  }
  return [...names];
}

/**
 * Names that denote a group rather than one person.
 *
 * A band is several performers credited as one name, so counting the credits
 * alone put a single figure on stage for Swedish House Mafia. These patterns
 * bump the count to something plausible for a group.
 */
const GROUP_HINTS = [
  { pattern: /\b(?:band|orchestra|choir|ensemble|collective|quartet|philharmonic)\b/i, size: 5 },
  { pattern: /\b(?:mafia|boys|girls|brothers|sisters|crew|gang|squad|kids|club)\b/i, size: 4 },
  { pattern: /^(?:the)\s+\w+s$/i, size: 4 },
  { pattern: /\btrio\b/i, size: 3 },
  { pattern: /\bduo\b/i, size: 2 },
];

/**
 * Plausible number of performers behind one credited name.
 *
 * @param {string} name
 * @returns {number}
 */
function membersOf(name) {
  for (const { pattern, size } of GROUP_HINTS) {
    if (pattern.test(name)) return size;
  }
  return 1;
}

/**
 * How many figures should be on stage.
 *
 * Two things are combined: how many acts are credited, and how many people each
 * of those acts plausibly contains. Counting credits alone put one figure on
 * stage for a five-piece band; assuming everyone is a group would put a crowd
 * behind every solo single.
 *
 * @param {object|null} track Track descriptor.
 * @param {number} [max] Upper bound, so a large collaboration stays legible.
 * @returns {number}
 */
export function performerCount(track, max = 8) {
  if (!track) return 1;
  const credits = creditedArtists(track.title, track.artist);
  if (credits.length === 0) return 1;

  // Each credited act contributes its own plausible size, and every additional
  // credit guarantees at least one more figure.
  const total = credits.reduce((sum, name) => sum + membersOf(name), 0);
  return Math.min(max, Math.max(credits.length, total));
}
