import assert from 'node:assert/strict';
import { SoundCloudApi } from '../server/soundcloud.js';

// --- availability ------------------------------------------------------------
assert.equal(new SoundCloudApi(undefined, undefined).available, false);
assert.equal(new SoundCloudApi('id', undefined).available, false,
  'a client id without a secret is not enough for client_credentials');
assert.equal(new SoundCloudApi('id', 'secret').available, true);
console.log('availability: 3/3 pass');

// --- token caching and refresh ----------------------------------------------
const api = new SoundCloudApi('id', 'secret');
let tokenCalls = 0;
globalThis.fetch = async () => {
  tokenCalls += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: `token-${tokenCalls}`, expires_in: 3600 }),
  };
};

assert.equal(await api.accessToken(), 'token-1');
assert.equal(await api.accessToken(), 'token-1', 'a valid token must be reused');
assert.equal(tokenCalls, 1, 'a cached token must not trigger a second request');

// Concurrent callers must share one refresh, not race each other.
api.token = null;
api.expiresAt = 0;
const [a, b, c] = await Promise.all([
  api.accessToken(), api.accessToken(), api.accessToken(),
]);
assert.equal(a, b);
assert.equal(b, c);
assert.equal(tokenCalls, 2, 'three concurrent callers must cause one refresh, not three');

// A token near expiry refreshes early rather than being used and failing.
api.expiresAt = Date.now() / 1000 + 30;
await api.accessToken();
assert.equal(tokenCalls, 3, 'a token inside the refresh margin must be replaced');
console.log('token handling: 6/6 pass');

// --- track mapping -----------------------------------------------------------
const mapped = SoundCloudApi.toTrack({
  id: 12345,
  title: 'A Song',
  duration: 214000,
  permalink_url: 'https://soundcloud.com/x/a-song',
  user: { username: 'An Artist' },
  artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
  streamable: true,
});
assert.equal(mapped.provider, 'soundcloud');
assert.equal(mapped.providerId, '12345', 'ids are strings, matching every other provider');
assert.equal(mapped.durationSec, 214, 'the API reports milliseconds');
assert.equal(mapped.artist, 'An Artist');
assert.ok(mapped.thumbnail.includes('t500x500'), 'artwork is upgraded from the tiny default');
console.log('track mapping: 5/5 pass');

// A 401 must clear the cached token so the next call fetches a fresh one.
globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
api.token = 'stale';
api.expiresAt = Date.now() / 1000 + 3600;
await assert.rejects(() => api.request('/tracks/1'));
assert.equal(api.token, null, 'a rejected token must be discarded, not retried forever');
console.log('error handling: 2/2 pass');
