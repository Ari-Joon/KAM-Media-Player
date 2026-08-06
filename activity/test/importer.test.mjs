import assert from 'node:assert/strict';
import { parsePlaylistUrl } from '../server/importer.js';

// YouTube playlists are recognised in every shape a link arrives in.
for (const url of [
  'https://www.youtube.com/playlist?list=PLabc123_-x',
  'https://www.youtube.com/watch?v=abc&list=PLabc123_-x&index=2',
  'https://music.youtube.com/playlist?list=OLAK5uy_abc',
]) {
  const parsed = parsePlaylistUrl(url);
  assert.equal(parsed?.kind, 'youtube', url);
  assert.ok(parsed.id.length > 2);
}

// A radio mix is generated per viewer and has no stable contents to import.
assert.equal(parsePlaylistUrl('https://www.youtube.com/watch?v=x&list=RDabc123'), null);

// The existing hosts still parse.
assert.equal(parsePlaylistUrl('https://open.spotify.com/playlist/37i9dQZ')?.kind, 'spotify');
assert.equal(
  parsePlaylistUrl('https://music.apple.com/gb/playlist/thing/pl.u-abc')?.kind, 'apple');

// A plain track link is not a playlist.
assert.equal(parsePlaylistUrl('https://www.youtube.com/watch?v=abc'), null);
assert.equal(parsePlaylistUrl('nonsense'), null);

console.log('playlist import: 8/8 pass (link shapes, radio mixes rejected)');
