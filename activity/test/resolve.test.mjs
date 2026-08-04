import assert from 'node:assert/strict';
import {
  parseYouTubeId, cleanTitle, cleanChannel, splitArtistTitle,
  buildSearchTerms, pickPreview,
} from '../server/resolve.js';

// --- URL parsing ------------------------------------------------------------
const urls = {
  'https://www.youtube.com/watch?v=4NRXx6U8ABQ': '4NRXx6U8ABQ',
  'https://youtu.be/4NRXx6U8ABQ': '4NRXx6U8ABQ',
  'https://youtu.be/4NRXx6U8ABQ?t=42': '4NRXx6U8ABQ',
  'youtube.com/watch?v=4NRXx6U8ABQ&list=PLabc': '4NRXx6U8ABQ',
  'https://music.youtube.com/watch?v=4NRXx6U8ABQ&si=xyz': '4NRXx6U8ABQ',
  'https://www.youtube.com/shorts/4NRXx6U8ABQ': '4NRXx6U8ABQ',
  'https://www.youtube.com/embed/4NRXx6U8ABQ': '4NRXx6U8ABQ',
  '4NRXx6U8ABQ': '4NRXx6U8ABQ',
  'blinding lights': null,
  'the weeknd': null,
};
for (const [input, expected] of Object.entries(urls)) {
  assert.equal(parseYouTubeId(input), expected, `parseYouTubeId(${input})`);
}
console.log(`parseYouTubeId: ${Object.keys(urls).length}/${Object.keys(urls).length} pass`);

// --- Title cleaning against real-world titles -------------------------------
const titles = {
  'The Weeknd - Blinding Lights (Official Video)': 'The Weeknd - Blinding Lights',
  'Billie Eilish - bad guy (Official Music Video)': 'Billie Eilish - bad guy',
  'Central Cee - Doja [Music Video]': 'Central Cee - Doja',
  'Kendrick Lamar - HUMBLE.': 'Kendrick Lamar - HUMBLE.',
  'Travis Scott - SICKO MODE ft. Drake': 'Travis Scott - SICKO MODE',
  'Eminem - Lose Yourself [HD]': 'Eminem - Lose Yourself',
  'Dave - Titanium (Official Video) | 4K': 'Dave - Titanium',
  'Michael Jackson - Billie Jean (Official Video) - 4K Remaster':
    'Michael Jackson - Billie Jean - 4K Remaster',
  'Nothing Else Matters (Reprise)': 'Nothing Else Matters (Reprise)',
  'Doja Cat - Paint The Town Red (Official Video)': 'Doja Cat - Paint The Town Red',
};
for (const [raw, expected] of Object.entries(titles)) {
  assert.equal(cleanTitle(raw), expected, `cleanTitle(${raw})`);
}
console.log(`cleanTitle: ${Object.keys(titles).length}/${Object.keys(titles).length} pass (genuine parentheticals survive)`);

// --- Channel cleaning -------------------------------------------------------
assert.equal(cleanChannel('TheWeekndVEVO'), 'TheWeeknd');
assert.equal(cleanChannel('The Weeknd - Topic'), 'The Weeknd');
assert.equal(cleanChannel('Kendrick Lamar'), 'Kendrick Lamar');
assert.equal(cleanChannel('Dave Official'), 'Dave');
console.log('cleanChannel: 4/4 pass');

// --- Artist/title split -----------------------------------------------------
assert.deepEqual(splitArtistTitle('The Weeknd - Blinding Lights'),
  { artist: 'The Weeknd', title: 'Blinding Lights' });
// Only the first dash splits; later ones belong to the title.
assert.deepEqual(splitArtistTitle('Artist - Song - Remaster'),
  { artist: 'Artist', title: 'Song - Remaster' });
assert.deepEqual(splitArtistTitle('Blinding Lights'),
  { artist: null, title: 'Blinding Lights' });
console.log('splitArtistTitle: 3/3 pass');

// --- The regression this all exists for -------------------------------------
const terms = buildSearchTerms('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO');
assert.equal(terms[0], 'The Weeknd Blinding Lights', `first term was "${terms[0]}"`);
assert.ok(!terms[0].includes('Official'), 'noise leaked into the primary term');
assert.ok(!/weeknd.*weeknd/i.test(terms[0]), 'artist duplicated in the primary term');
// Topic-channel upload: artist exists only in the channel name.
const topic = buildSearchTerms('Blinding Lights', 'The Weeknd - Topic');
assert.ok(topic.some((t) => t === 'The Weeknd Blinding Lights'),
  `topic-channel fallback missing, got ${JSON.stringify(topic)}`);
assert.ok(terms.length >= 2, 'cascade should offer fallbacks');
console.log(`buildSearchTerms: 5/5 pass (primary term now "${terms[0]}")`);

// --- Preview selection ------------------------------------------------------
assert.equal(pickPreview([]), null, 'empty results');
assert.equal(pickPreview([{ trackName: 'X' }]), null, 'result without previewUrl');
assert.equal(pickPreview([
  { trackName: 'Blinding Lights (Karaoke Version)', previewUrl: 'a' },
  { trackName: 'Blinding Lights', artistName: 'The Weeknd', previewUrl: 'b' },
]).previewUrl, 'b', 'karaoke must be skipped');
assert.equal(pickPreview([
  { trackName: 'Blinding Lights', collectionName: 'Tribute to The Weeknd', previewUrl: 'a' },
  { trackName: 'Blinding Lights', previewUrl: 'b' },
]).previewUrl, 'b', 'tribute album must be skipped');
console.log('pickPreview: 4/4 pass (karaoke and tribute versions rejected)');
