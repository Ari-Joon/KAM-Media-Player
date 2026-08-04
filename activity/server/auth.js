/**
 * Establishing who is actually making a request.
 *
 * Until this existed, `/api/token` exchanged the OAuth code, handed the access
 * token back to the browser, and then nothing ever checked it again. Every
 * write endpoint took the caller's word for who they were: the favourites store
 * recorded whatever `user` object the request carried, and the transport and
 * queue routes were reachable by anyone who knew a channel ID. That was
 * documented as acceptable only inside the trusted-server alpha boundary, and
 * it is the thing that has to change before the Activity is exposed publicly.
 *
 * The token is verified against Discord itself rather than decoded locally.
 * OAuth access tokens are opaque strings, not JWTs - there is nothing in them to
 * validate, so the only way to learn who a token belongs to is to ask.
 *
 * ## Why the cache is not optional
 *
 * `/users/@me` would otherwise be called on every transport press. Discord rate
 * limits per route, and a room of people scrubbing would exhaust it and start
 * failing requests that are perfectly legitimate. Results are held briefly and
 * the map is bounded, because an unbounded token cache is a memory leak with a
 * long fuse - the same mistake the avatar cache had to fix.
 *
 * `fetchImpl` is injectable for exactly the reason the image proxy's is: the
 * unit tests need to drive the same token through different Discord responses
 * without a network.
 */

/** Raised when a request cannot be attributed, or the caller is not allowed. */
export class AuthError extends Error {
  /**
   * @param {number} status HTTP status to answer with.
   * @param {string} message Safe to show a user.
   */
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** How long a verified identity is trusted before Discord is asked again. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * How long a rejection is remembered.
 *
 * Much shorter than a success. A token rejected once is usually rejected
 * forever, and caching that spares Discord the traffic - but a token can also
 * fail because Discord had a bad minute, and holding that for five minutes
 * would lock a real user out of their own session for no reason.
 */
const FAILURE_TTL_MS = 15 * 1000;

/** Largest number of tokens held at once. */
const CACHE_MAX = 2000;

export class TokenVerifier {
  /**
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchImpl] Injected for tests.
   * @param {string} [options.apiBase] Discord API root.
   */
  constructor({ fetchImpl = fetch, apiBase = 'https://discord.com/api/v10' } = {}) {
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    /** @type {Map<string, {at: number, user: object|null, error: AuthError|null}>} */
    this.cache = new Map();
  }

  /** Drop expired entries, then the oldest if the map is still too large. */
  prune() {
    const now = Date.now();
    for (const [token, entry] of this.cache) {
      const ttl = entry.user ? TOKEN_TTL_MS : FAILURE_TTL_MS;
      if (now - entry.at >= ttl) this.cache.delete(token);
    }
    if (this.cache.size <= CACHE_MAX) return;
    // Map iterates in insertion order, so the first keys are the oldest.
    let excess = this.cache.size - CACHE_MAX;
    for (const token of this.cache.keys()) {
      this.cache.delete(token);
      if (--excess <= 0) break;
    }
  }

  /**
   * Resolve an access token to the Discord user it belongs to.
   *
   * @param {string} token Bearer token from the request.
   * @returns {Promise<{id: string, username: string, avatar: string|null}>}
   * @throws {AuthError} When the token is missing, rejected, or unverifiable.
   */
  async verify(token) {
    if (!token) throw new AuthError(401, 'Sign-in required.');

    const cached = this.cache.get(token);
    if (cached) {
      const ttl = cached.user ? TOKEN_TTL_MS : FAILURE_TTL_MS;
      if (Date.now() - cached.at < ttl) {
        if (cached.user) return cached.user;
        throw cached.error;
      }
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/users/@me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Discord unreachable. Deliberately not cached as a rejection for the
      // full failure window - but it is still an error, because proceeding
      // would mean accepting an unverified identity, which is the whole thing
      // this module exists to stop.
      throw new AuthError(503, 'Could not reach Discord to verify your session.');
    }

    if (!response.ok) {
      const error = new AuthError(401, 'Your Discord session has expired. Reopen the Activity.');
      this.cache.set(token, { at: Date.now(), user: null, error });
      this.prune();
      throw error;
    }

    let profile;
    try {
      profile = await response.json();
    } catch {
      throw new AuthError(502, 'Discord returned an unreadable profile.');
    }

    if (!profile?.id) {
      const error = new AuthError(401, 'That session is not valid.');
      this.cache.set(token, { at: Date.now(), user: null, error });
      this.prune();
      throw error;
    }

    // Only the three fields anything downstream uses. Storing the whole profile
    // would put e-mail and locale in a cache that has no reason to hold them.
    const user = {
      id: String(profile.id),
      username: profile.global_name ?? profile.username ?? 'someone',
      avatar: profile.avatar ?? null,
    };
    this.cache.set(token, { at: Date.now(), user, error: null });
    this.prune();
    return user;
  }
}

/**
 * Pull the bearer token out of a request.
 *
 * @param {import('express').Request} request
 * @returns {string} The token.
 * @throws {AuthError} When the header is absent or malformed.
 */
export function bearerToken(request) {
  const header = String(request.get?.('authorization') ?? request.headers?.authorization ?? '');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw new AuthError(401, 'Sign-in required.');
  return match[1];
}
