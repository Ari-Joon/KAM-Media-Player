import assert from 'node:assert/strict';

// Provider configuration is read when the module loads. Clearing the variable
// before the dynamic import reproduces a genuine first install with no optional
// YouTube key, rather than inheriting a developer's shell configuration.
delete process.env.YOUTUBE_API_KEY;
const { DEFAULT_PROVIDER, resolveTrack } = await import('../server/providers.js');

assert.equal(
  DEFAULT_PROVIDER,
  'soundcloud',
  'a missing optional YouTube key must leave a usable default provider',
);

await assert.rejects(
  () => resolveTrack('4NRXx6U8ABQ', 'youtube'),
  /YOUTUBE_API_KEY is not configured/,
  'an explicit YouTube request should explain the missing optional key',
);

console.log('provider configuration: 2/2 pass');
