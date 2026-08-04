import assert from 'node:assert/strict';
import { fetchProxiedImage } from '../server/imageproxy.js';

function response(body, options = {}) {
  return new Response(body, options);
}

const image = await fetchProxiedImage('https://i.ytimg.com/cover.jpg', async () => (
  response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
  })
));
assert.equal(image.contentType, 'image/jpeg');
assert.deepEqual([...image.body], [1, 2, 3]);

await assert.rejects(
  () => fetchProxiedImage('https://i.ytimg.com/cover.jpg', async () => (
    response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
  )),
  (error) => error.status === 403,
  'a redirect must not escape the HTTPS host allowlist',
);

await assert.rejects(
  () => fetchProxiedImage('https://cdn.discordapp.com/file', async () => (
    response('not an image', { status: 200, headers: { 'content-type': 'text/html' } })
  )),
  (error) => error.status === 415,
  'non-image responses must not be proxied',
);

await assert.rejects(
  () => fetchProxiedImage('https://cdn.discordapp.com/huge.png', async () => (
    response(null, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '6000000' },
    })
  )),
  (error) => error.status === 413,
  'oversized responses must be rejected before buffering',
);

console.log('image proxy: 4/4 pass');
