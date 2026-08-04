/**
 * Bounded in-memory response cache.
 *
 * Both things this server caches are large, immutable-per-key payloads that
 * several viewers request at once: an analysed score, and artwork that Discord's
 * Activity sandbox forces through our own origin. In both cases the cost being
 * avoided is per-viewer repetition of work whose result is identical.
 *
 * Bounded by *bytes* rather than entry count because sizes vary by two orders of
 * magnitude - an avatar is a few kilobytes, a full-track score around a
 * megabyte - so a count limit would either waste memory or evict uselessly.
 */

export class ByteBoundedCache {
  /**
   * @param {object} options
   * @param {number} options.maxBytes Total budget across all entries.
   * @param {number} [options.ttlMs] Age at which an entry is discarded on read.
   *   Omit for content that can never change under its key.
   * @param {(value: any) => number} options.sizeOf Byte cost of one value.
   * @param {() => number} [options.now] Clock, injectable for tests.
   */
  constructor({ maxBytes, ttlMs = Infinity, sizeOf, now = Date.now }) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.sizeOf = sizeOf;
    this.now = now;
    /** Insertion order is the eviction order; `get` re-inserts to refresh it. */
    this.entries = new Map();
    this.bytes = 0;
  }

  /** Number of live entries. */
  get size() {
    return this.entries.size;
  }

  /**
   * Read a value, discarding it if it has aged out.
   *
   * A hit is re-inserted so eviction order is least-recently-*used* rather than
   * least-recently-stored. Without that, artwork shown on every panel open would
   * be evicted by a burst of one-off avatars despite being the hottest entry.
   *
   * @param {string} key
   * @returns {any|null}
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.bytes -= entry.size;
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value, evicting least-recently-used entries to stay within budget.
   *
   * Re-storing an existing key replaces it rather than double-counting its
   * bytes, which is the accounting slip that would otherwise let the tracked
   * total drift above the real one until the cache evicted everything.
   *
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.size;
    }

    const size = this.sizeOf(value);
    this.entries.set(key, { value, size, storedAt: this.now() });
    this.bytes += size;

    // Always keep the entry just stored, even if it alone exceeds the budget -
    // evicting it immediately would mean never serving a cache hit for an
    // oversized item while still paying to look it up.
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).size;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Serialised scores, keyed by `scoreId`.
 *
 * A score is immutable once analysed, so stringifying it per request was pure
 * repetition: `response.json()` ran `JSON.stringify` over roughly a megabyte
 * synchronously, once for every viewer in the channel. `Player.snapshot`
 * documents why that matters - the same serialisation cost in the once-a-second
 * state poll was disturbing the audio player's 20ms packet timer badly enough to
 * be audible - and the score is far larger than a snapshot.
 *
 * No TTL: a `scoreId` already encodes the partial and lyric flags, so an
 * upgraded score arrives under a different key rather than replacing one.
 */
export const scoreCache = new ByteBoundedCache({
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (body) => body.length,
});

/**
 * Fetched artwork, keyed by source URL.
 *
 * Discord's Activity sandbox blocks external images, so every avatar and every
 * piece of cover art is routed through this origin. The 24-hour `Cache-Control`
 * we send covers one viewer reopening the panel but nothing across viewers: each
 * person joining made this server re-fetch the same handful of images upstream.
 * A channel of eight browsing a ten-track queue meant eighty upstream requests
 * for ten distinct images.
 *
 * The TTL matches the `Cache-Control` sent to clients, so the server never holds
 * a version of a changed avatar for longer than a client would.
 */
export const imageCache = new ByteBoundedCache({
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 86_400_000,
  sizeOf: (image) => image.body.length,
});
