import assert from 'node:assert/strict';

// A key must be present before the module loads, or `searchTracks` short
// circuits straight to SoundCloud and the branch under test never runs.
process.env.YOUTUBE_API_KEY = 'test-key-not-a-real-one';
const { searchTracks } = await import('../server/providers.js');

// --- YouTube is optional, so no failure of it should end a search ------------
//
// `searchTracks` fell back to SoundCloud only when the error message matched
// /quota/i, and rethrew everything else. A dropped TLS handshake to
// googleapis.com therefore reached the user as `TypeError: fetch failed` with
// no way to play anything, while SoundCloud sat there working.
//
// Asserted on the log rather than on the result. Whether the fallback then
// *succeeds* depends on yt-dlp and a live network, which would make this
// flaky; whether the fallback is *attempted* is the regression, and it is
// deterministic.

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write.bind(process.stdout);

/**
 * Run a search with YouTube failing in a given way, capturing what was logged.
 *
 * `fail` either throws - which is how a network fault arrives - or returns a
 * Response, which is how quota and server errors arrive. Modelling that
 * difference matters: a test that threw for every case would pass while the
 * status-code path stayed broken.
 *
 * @param {() => Error|Response} fail
 * @returns {Promise<{log: string, message: string}>}
 */
async function searchWithBrokenYouTube(fail) {
  let captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += chunk;
    return realWrite(chunk, ...rest);
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes('googleapis.com')) {
      const outcome = fail();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    throw new Error('network disabled in this test');
  };
  let message = '';
  try {
    await searchTracks('a song', 3);
  } catch (error) {
    message = error.message;
  } finally {
    process.stdout.write = realWrite;
    globalThis.fetch = realFetch;
  }
  return { log: captured, message };
}

try {
  // The exact fault from the report: a socket reset during the TLS handshake,
  // which arrives as a TypeError carrying a cause rather than an HTTP status.
  const network = await searchWithBrokenYouTube(() => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNRESET' };
    return error;
  });

  assert.match(network.log, /trying SoundCloud/,
    'a network fault on YouTube did not fall through to SoundCloud - one blip '
    + 'on the optional provider takes search down completely');

  assert.match(network.log, /ECONNRESET/,
    'the underlying cause did not survive into the log; a reset socket and an '
    + 'outage need different responses from whoever reads it');

  assert.doesNotMatch(network.log, /TypeError/,
    'the raw fetch TypeError was passed along rather than converted');

  // Quota is the case that already worked, and must keep working.
  const quota = await searchWithBrokenYouTube(
    () => new Response('', { status: 403 }),
  );
  assert.match(quota.log, /quota is used up/,
    'a 403 is no longer reported as quota exhaustion');
  assert.match(quota.log, /trying SoundCloud/,
    'quota exhaustion stopped falling back to SoundCloud');

  // A plain HTTP failure is neither quota nor network, and was the third thing
  // that used to be rethrown.
  const http = await searchWithBrokenYouTube(
    () => new Response('', { status: 500 }),
  );
  assert.match(http.log, /\(500\)/,
    'the HTTP status was lost on the way to the log');
  assert.match(http.log, /trying SoundCloud/,
    'a YouTube server error stopped falling back to SoundCloud');

  // Whatever happens after the fallback, the user must never be shown the raw
  // fetch failure that started all this.
  for (const [name, result] of [['network', network], ['http', http]]) {
    assert.doesNotMatch(result.message, /TypeError: fetch failed/,
      `the raw fetch error reached the user in the ${name} case: ${result.message}`);
  }
} finally {
  process.stdout.write = realWrite;
  globalThis.fetch = realFetch;
}

console.log('search fallback: 8/8 pass (any YouTube failure falls through to SoundCloud)');
