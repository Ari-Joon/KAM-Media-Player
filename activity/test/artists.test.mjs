import assert from 'node:assert/strict';
import { performerCount, creditedArtists } from '../client/artists.js';

// Real-world titles, including several played during development. The dancer
// count is derived from these, so a parsing regression puts the wrong number of
// figures on stage.
const cases = [
  ['The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO', 1],
  ['Travis Scott - SICKO MODE ft. Drake', 'TravisScottVEVO', 2],
  ["Hit 'Em Up x NOT CUTE ANYMORE (OFFICIAL Mashup)", 'Keezy Wit A Banger', 1],
  ['Not Cute Anymore X Hit Em Up (Illit ft.Tupac)Mashup', 'tac1tum', 2],
  ['Muse - Knights of Cydonia [HD]', 'MrMuseLyrics', 1],
  ['Lil Nas X - Old Town Road (Official Movie) ft. Billy Ray Cyrus', 'LilNasXVEVO', 2],
  ['Calvin Harris & Dua Lipa - One Kiss', 'CalvinHarrisVEVO', 2],
  ['Lost Woods Riddim', 'Doctor Lifted - Topic', 1],
  ['DJ Snake, Lauv - A Different Way', 'DJSnakeVEVO', 2],
  ['Ed Sheeran - Azizam (Lyrics)', 'TrendingTracks', 1],
  // A group name counts as several performers: two credits, but one of them is
  // a collective, so the stage is not a duet.
  ['Swedish House Mafia & The Weeknd - Moth To A Flame', 'SHMVEVO', 5],
  ['Eminem - Lose Yourself', 'EminemMusic', 1],
  ['Daft Punk - Get Lucky (feat. Pharrell Williams, Nile Rodgers)', 'DaftPunkVEVO', 3],
];

for (const [title, artist, expected] of cases) {
  const got = performerCount({ title, artist });
  assert.equal(got, expected,
    `"${title}" gave ${got}, expected ${expected}: ${JSON.stringify(creditedArtists(title, artist))}`);
}
console.log(`performerCount: ${cases.length}/${cases.length} pass on real titles`);

// Groups must not be counted as a single performer, which was the whole
// complaint: a band was putting one figure on stage.
const groups = [
  ['The Beatles - Hey Jude', 'TheBeatlesVEVO', 4],
  ['Beach Boys - Good Vibrations', 'BeachBoys', 4],
  ['Swedish House Mafia - Greyhound', 'SHMVEVO', 4],
];
for (const [title, artist, expected] of groups) {
  const got = performerCount({ title, artist });
  assert.equal(got, expected, `"${title}" gave ${got}, expected ${expected}`);
}
// And a solo artist must not be inflated by the group rules.
for (const solo of ['Eminem - Lose Yourself', 'Adele - Hello', 'Drake - Hotline Bling']) {
  assert.equal(performerCount({ title: solo, artist: 'Chan' }), 1,
    `${solo} should stay solo`);
}
console.log('group detection: 6/6 pass');

// "Lil Nas X" must not split on its own name.
assert.equal(performerCount({ title: 'Lil Nas X - Panini', artist: 'LilNasXVEVO' }), 1,
  'an artist name containing x must not be split');

// Promotional words are never performers.
assert.ok(!creditedArtists('Artist - Song (Official Video)', 'Chan').includes('official video'));

// Defaults are conservative: one figure, never a crowd.
assert.equal(performerCount(null), 1, 'no track gives a solo');
assert.equal(performerCount({ title: '', artist: '' }), 1, 'empty metadata gives a solo');

// A large collaboration is capped so the stage stays legible.
assert.ok(performerCount({
  title: 'A & B & C & D & E & F & G & H & I - Song', artist: 'X',
}) <= 7, 'cast size is capped');
console.log('performerCount edge cases: 5/5 pass');

// --- A title with no dash must not credit the uploader ----------------------
//
// Lyrics channels title uploads `ARTIST 'SONG' lyrics`. The artist part was
// only ever taken from before a dash, so these fell through to the channel
// name: MusicBrainz was asked about "Regular ccl" rather than KATSEYE and
// answered one member, putting a six-piece group on stage as a solo act.
//
// Measured 23 August 2026 against the live lookup: `["katseye"]` returns 6 and
// `["regular ccl"]` returns 1, so the lookup was never the faulty part.

assert.deepEqual(
  creditedArtists("KATSEYE 'That way' lyrics (Color coded lyrics)", 'Regular ccl'),
  ['katseye'],
  'a quoted song title must credit the artist, not the lyrics channel',
);

assert.deepEqual(
  creditedArtists('KATSEYE "Touch" lyrics', 'SomeChannel'),
  ['katseye'],
  'double quotes are the same convention as single quotes',
);

// The opening quote must follow whitespace. Without that requirement an
// apostrophe inside a word opens one, and this parses as artist "Don" with
// song "t Stop Believin" - which is why the rule is not simply /['"]/.
for (const [title, channel] of [
  ["Journey - Don't Stop Believin'", 'Journey'],
  ["Don't Stop Believin'", 'Journey'],
]) {
  assert.deepEqual(creditedArtists(title, channel), ['journey'],
    `an apostrophe must not open a quoted song title: ${title}`);
}

// A dashed title is unaffected: that branch is still preferred.
assert.deepEqual(
  creditedArtists('KATSEYE - Hootie Frutti (Lyrics)', 'Vibe Music'),
  ['katseye'],
  'the dash branch must still win when a dash is present',
);

console.log('quoted song titles: 5/5 pass (uploader no longer credited)');
