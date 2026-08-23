import assert from 'node:assert/strict';

// --- A pasted YouTube link must not depend on the Data API ------------------
//
// `resolveYouTube` called `fetch` unguarded. One dropped TLS handshake to
// googleapis.com therefore escaped as a raw `TypeError: fetch failed` and a
// perfectly playable link became unplayable - the reported symptom being
// simply "i cant play this song".
//
// The API contributes only title, channel and duration to a link whose ID is
// already in the URL, and yt-dlp fetches the audio regardless, so every one of
// these failures is recoverable. These tests assert the recovery is attempted.
//
// Extraction is pointed at a binary that does not exist, so it fails in
// milliseconds with ENOENT instead of shelling out to the real yt-dlp for up
// to sixty seconds against a live network. That keeps the assertions on what
// is deterministic: that the fallback ran, and that the original reason
// survived into the message.

process.env.YOUTUBE_API_KEY = 'test-key-not-a-real-one';
process.env.YTDLP_BIN = 'yt-dlp-absent-for-tests';

const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const ABSENT = 'yt-dlp-absent-for-tests is not installed or not on PATH.';

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write.bind(process.stdout);

/**
 * Resolve an input with the Data API failing in a given way.
 *
 * `fail` either throws - how a transport fault arrives - or returns a
 * Response, which is how quota and server errors arrive. Modelling both
 * matters: a test that only threw would pass while the status-code path
 * stayed broken.
 *
 * @param {object} module The providers module under test.
 * @param {string} input Link or free text.
 * @param {() => Error|Response} fail
 * @returns {Promise<{log: string, message: string, calls: number}>}
 */
async function resolveWithBrokenApi(module, input, fail) {
  let captured = '';
  let calls = 0;
  process.stdout.write = (chunk, ...rest) => {
    captured += chunk;
    return realWrite(chunk, ...rest);
  };
  globalThis.fetch = async (url) => {
    if (!String(url).includes('googleapis.com')) {
      throw new Error('network disabled in this test');
    }
    calls += 1;
    const outcome = fail();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  let message = '';
  try {
    await module.resolveTrack(input, 'youtube');
  } catch (error) {
    message = error.message;
  } finally {
    process.stdout.write = realWrite;
    globalThis.fetch = realFetch;
  }
  return { log: captured, message, calls };
}

const reset = () => Object.assign(new TypeError('fetch failed'), {
  cause: { code: 'ECONNRESET' },
});

const quota = () => new Response('{}', { status: 403 });

try {
  const providers = await import('../server/providers.js');

  // 1. The reported failure: a transport fault on a pasted link.
  const dropped = await resolveWithBrokenApi(providers, LINK, reset);
  assert.match(dropped.log, /Resolving the link by extraction instead/,
    'a dropped connection on a link must fall through to extraction');
  assert.match(dropped.message, /ECONNRESET/,
    'the transport fault must survive into the message');
  assert.ok(!/^fetch failed$/.test(dropped.message),
    'a raw TypeError must never reach the user');
  assert.ok(dropped.message.endsWith(ABSENT),
    `extraction should have been the thing that finally failed: ${dropped.message}`);

  // 2. Quota is a limit on metadata, not on playback, so a link still plays.
  const exhausted = await resolveWithBrokenApi(providers, LINK, quota);
  assert.match(exhausted.log, /Resolving the link by extraction instead/,
    'quota on a link must fall through to extraction');
  assert.match(exhausted.message, /quota is used up/,
    'the quota reason must survive, or the next person debugs the wrong subsystem');
  assert.ok(exhausted.message.endsWith(ABSENT),
    'the quota message must be followed by the extraction failure, not replace it');

  // 3. Free text has no ID to extract, so it must not pay for a doomed attempt.
  const words = await resolveWithBrokenApi(providers, 'some song title', reset);
  assert.ok(!/Resolving the link by extraction/.test(words.log),
    'free text has no video ID; extraction cannot resolve it');
  assert.match(words.message, /Could not reach YouTube: ECONNRESET/,
    'free text should report the transport fault plainly');
  assert.ok(!words.message.includes(ABSENT),
    'no extraction should have been attempted for free text');

  // 4. Without a key a link is still resolvable, because the ID is in the URL.
  //    A query string forces a second module instance that re-reads the env.
  delete process.env.YOUTUBE_API_KEY;
  const keyless = await import('../server/providers.js?keyless=1');
  const unkeyed = await resolveWithBrokenApi(keyless, LINK, reset);
  assert.equal(unkeyed.calls, 0,
    'a link must not call the Data API when no key is configured');
  assert.ok(unkeyed.message.endsWith(ABSENT),
    `a keyless link should go straight to extraction: ${unkeyed.message}`);
  assert.ok(!/is disabled because YOUTUBE_API_KEY/.test(unkeyed.message),
    'a pasted link needs no key and must not be refused for lacking one');

  console.log('link-resolve: 12 assertions passed');
} finally {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
}
