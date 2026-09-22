/**
 * The boot-time update check: which versions count as newer, where the newest
 * one is read from, and that nothing it can run into - a slow GitHub, an error,
 * no network at all - becomes a problem for the server.
 */
import assert from 'node:assert/strict';
import {
  parseVersion, isNewer, newestTag, checkForUpdate, checkDisabled, currentVersion,
} from '../server/updates.js';

let passed = 0;
const check = async (name, run) => { await run(); passed += 1; };

// A fetch that answers with a tag list, the way GitHub's /tags does: unsorted.
const answering = (names, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => names.map((name) => ({ name })),
});

await check('versions compare number by number', () => {
  assert.deepEqual(parseVersion('v0.9.7'), [0, 9, 7]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0]);
  // Comparing the strings would put 0.10.0 below 0.9.9, which is the usual way to get this wrong.
  assert.equal(isNewer([0, 10, 0], [0, 9, 9]), true);
  assert.equal(isNewer([0, 9, 9], [0, 10, 0]), false);
  assert.equal(isNewer([0, 9, 6], [0, 9, 6]), false);
});

await check('only plain release numbers are versions', () => {
  // The repository has carried a v0.2.0-alpha tag; a pre-release is never offered.
  for (const name of ['v0.2.0-alpha', 'latest', '', '0.9', 'v1.0.0-rc1']) {
    assert.equal(parseVersion(name), null, name);
  }
});

await check('the newest tag wins whatever order GitHub lists them in', () => {
  assert.equal(newestTag([{ name: 'v0.9.1' }, { name: 'v0.10.0' }, { name: 'v0.9.6' }, { name: 'v0.2.0-alpha' }]), '0.10.0');
  assert.equal(newestTag([]), null);
});

await check('a higher tag than this one is offered', async () => {
  const result = await checkForUpdate({ current: '0.9.6', fetchImpl: answering(['v0.9.6', 'v0.9.7', 'v0.9.5']) });
  assert.deepEqual(result, { current: '0.9.6', latest: '0.9.7', available: true });
});

await check('the same or an older version is not', async () => {
  const same = await checkForUpdate({ current: '0.9.6', fetchImpl: answering(['v0.9.0', 'v0.9.6']) });
  assert.equal(same.available, false);
  // GitHub's "latest release" said 0.9.0 while this was 0.9.6. That must never read as an update.
  const older = await checkForUpdate({ current: '0.9.6', fetchImpl: answering(['v0.9.0']) });
  assert.equal(older.available, false);
});

await check('a failure is an answer, not an exception', async () => {
  const refused = await checkForUpdate({ current: '0.9.6', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.equal(refused.error, 'getaddrinfo ENOTFOUND');
  const limited = await checkForUpdate({ current: '0.9.6', fetchImpl: answering([], 403) });
  assert.equal(limited.error, 'GitHub replied 403');
  const empty = await checkForUpdate({ current: '0.9.6', fetchImpl: answering([]) });
  assert.equal(empty.error, 'GitHub listed no release tags');
});

await check('a GitHub that never answers is given up on', async () => {
  // Honours the abort signal the way fetch does, and would otherwise hang forever.
  const hanging = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const result = await checkForUpdate({ current: '0.9.6', fetchImpl: hanging, timeoutMs: 50 });
  assert.equal(result.error, 'GitHub did not answer in time');
  assert.ok(Date.now() - started < 2000, 'and promptly');
});

await check('the operator can switch it off', () => {
  assert.equal(checkDisabled({ UPDATE_CHECK: 'off' }), true);
  assert.equal(checkDisabled({ UPDATE_CHECK: 'FALSE' }), true);
  assert.equal(checkDisabled({}), false);
  assert.equal(checkDisabled({ UPDATE_CHECK: 'on' }), false);
});

await check('the running version is read from package.json', () => {
  assert.ok(parseVersion(currentVersion()), `package.json version is a plain release number: ${currentVersion()}`);
});

console.log(`update check: ${passed}/${passed} pass (ordering, tags not releases, failures, timeout, off switch)`);
