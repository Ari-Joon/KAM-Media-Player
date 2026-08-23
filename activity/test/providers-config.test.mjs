import assert from 'node:assert/strict';

// Provider configuration is read when the module loads. Clearing the variable
// before the dynamic import reproduces a genuine first install with no optional
// YouTube key, rather than inheriting a developer's shell configuration.
delete process.env.YOUTUBE_API_KEY;

// Extraction is pointed at a binary that does not exist. Without this the
// second case below resolves the ID against the live network and the suite
// starts depending on yt-dlp and YouTube being reachable.
process.env.YTDLP_BIN = 'yt-dlp-absent-for-tests';

const { DEFAULT_PROVIDER, resolveTrack } = await import('../server/providers.js');

assert.equal(
  DEFAULT_PROVIDER,
  'soundcloud',
  'a missing optional YouTube key must leave a usable default provider',
);

// Free text is the only thing that genuinely needs the key: turning words into
// a video ID is what `search.list` is for.
await assert.rejects(
  () => resolveTrack('some song title', 'youtube'),
  /YOUTUBE_API_KEY is not configured/,
  'an explicit YouTube search should explain the missing optional key',
);

// A known ID needs no key at all. The Data API would only have supplied title,
// channel and duration, and yt-dlp - already required for the audio - has all
// three. Refusing these for want of an optional key was wrong.
await assert.rejects(
  () => resolveTrack('4NRXx6U8ABQ', 'youtube'),
  (error) => {
    assert.ok(!/YOUTUBE_API_KEY is not configured/.test(error.message),
      `an ID should not be refused for a missing key: ${error.message}`);
    assert.match(error.message, /yt-dlp-absent-for-tests/,
      `an ID should be resolved by extraction: ${error.message}`);
    return true;
  },
);

console.log('provider configuration: 3/3 pass');
