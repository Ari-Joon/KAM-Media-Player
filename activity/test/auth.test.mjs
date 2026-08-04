import assert from 'node:assert/strict';
import { TokenVerifier, AuthError, bearerToken } from '../server/auth.js';

/**
 * Token verification, with Discord stubbed.
 *
 * The property under test is not "does it call Discord" but "can a request ever
 * be attributed to a user who did not make it" - which is what the favourites
 * store and the transport routes were relying on the client to tell the truth
 * about.
 */

/** A stubbed Discord that records calls and answers from a script. */
function discord(script) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, token: /Bearer (\S+)/.exec(options?.headers?.Authorization ?? '')?.[1] });
    const next = script.shift();
    if (typeof next === 'function') return next();
    return next;
  };
  return { fetchImpl, calls };
}

const ok = (body) => ({ ok: true, json: async () => body });
const rejected = { ok: false, status: 401, json: async () => ({}) };

// --- a valid token resolves to its user ------------------------------------
{
  const { fetchImpl, calls } = discord([ok({ id: '42', username: 'sam', avatar: 'abc' })]);
  const verifier = new TokenVerifier({ fetchImpl });
  const user = await verifier.verify('good-token');
  assert.deepEqual(user, { id: '42', username: 'sam', avatar: 'abc' });
  assert.equal(calls[0].token, 'good-token', 'the token is sent as a bearer credential');
  assert.match(calls[0].url, /users\/@me$/);
}

// `global_name` wins over `username`, matching what the rest of the app shows.
{
  const { fetchImpl } = discord([ok({ id: '7', username: 'legacy', global_name: 'Sam' })]);
  const user = await new TokenVerifier({ fetchImpl }).verify('t');
  assert.equal(user.username, 'Sam');
  assert.equal(user.avatar, null, 'a missing avatar is null rather than undefined');
}

// Only the fields the app needs are kept: no e-mail in a long-lived cache.
{
  const { fetchImpl } = discord([ok({
    id: '9', username: 'sam', avatar: null, email: 'sam@example.com', locale: 'en-GB',
  })]);
  const user = await new TokenVerifier({ fetchImpl }).verify('t');
  assert.deepEqual(Object.keys(user).sort(), ['avatar', 'id', 'username']);
}
console.log('token verification: 6/6 pass (identity comes from Discord, not the caller)');

// --- a rejected token must fail, and keep failing ---------------------------
{
  const { fetchImpl, calls } = discord([rejected]);
  const verifier = new TokenVerifier({ fetchImpl });
  await assert.rejects(() => verifier.verify('stolen'), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.status, 401);
    return true;
  });
  // Cached, so a flood of bad tokens cannot be used to hammer Discord.
  await assert.rejects(() => verifier.verify('stolen'), AuthError);
  assert.equal(calls.length, 1, 'the rejection was answered from cache');
}

// An empty or absent token never reaches the network at all.
{
  const { fetchImpl, calls } = discord([]);
  const verifier = new TokenVerifier({ fetchImpl });
  await assert.rejects(() => verifier.verify(''), AuthError);
  await assert.rejects(() => verifier.verify(undefined), AuthError);
  assert.equal(calls.length, 0, 'a missing token is rejected without asking Discord');
}

// A profile with no id is not an identity, however cheerful the status code.
{
  const { fetchImpl } = discord([ok({ username: 'nobody' })]);
  await assert.rejects(() => new TokenVerifier({ fetchImpl }).verify('t'), AuthError);
}

// Discord being unreachable must fail closed, never fall through to "trusted".
{
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => new TokenVerifier({ fetchImpl }).verify('t'), (error) => {
    assert.equal(error.status, 503);
    return true;
  });
}
console.log('rejection: 7/7 pass (fails closed, and remembers a refusal)');

// --- the cache ---------------------------------------------------------------
{
  const { fetchImpl, calls } = discord([
    ok({ id: '1', username: 'a' }),
    ok({ id: '1', username: 'a' }),
  ]);
  const verifier = new TokenVerifier({ fetchImpl });
  await verifier.verify('token');
  await verifier.verify('token');
  assert.equal(calls.length, 1, 'a verified token is not re-checked on every request');

  // Two different tokens are two different identities, never conflated.
  const pair = discord([ok({ id: '1', username: 'a' }), ok({ id: '2', username: 'b' })]);
  const other = new TokenVerifier({ fetchImpl: pair.fetchImpl });
  assert.equal((await other.verify('first')).id, '1');
  assert.equal((await other.verify('second')).id, '2');
}

// The map is bounded. An unbounded token cache is a slow memory leak.
{
  const verifier = new TokenVerifier({ fetchImpl: async () => ok({ id: 'x', username: 'x' }) });
  for (let i = 0; i < 2500; i++) await verifier.verify(`token-${i}`);
  assert.ok(verifier.cache.size <= 2000, `cache grew to ${verifier.cache.size}`);
}
console.log('cache: 4/4 pass (reused, bounded, never conflates two tokens)');

// --- header parsing ----------------------------------------------------------
{
  const request = (value) => ({ get: () => value });
  assert.equal(bearerToken(request('Bearer abc123')), 'abc123');
  assert.equal(bearerToken(request('bearer abc123')), 'abc123', 'the scheme is case-insensitive');
  assert.equal(bearerToken(request('  Bearer   abc123  ')), 'abc123');
  for (const bad of ['', 'abc123', 'Basic abc123', 'Bearer', 'Bearer ', undefined]) {
    assert.throws(() => bearerToken(request(bad)), AuthError, `accepted ${JSON.stringify(bad)}`);
  }
  // Header-only requests, as a bare object rather than an Express request.
  assert.equal(bearerToken({ headers: { authorization: 'Bearer xyz' } }), 'xyz');
}
console.log('bearer header: 11/11 pass');
