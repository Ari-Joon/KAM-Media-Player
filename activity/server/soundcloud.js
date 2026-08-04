/**
 * SoundCloud via their official API.
 *
 * This is the sanctioned path to audio, and the reason it matters: extraction
 * breaches a provider's terms, whereas this is the documented, permitted way to
 * stream SoundCloud content. It is the difference between a project that cannot
 * be operated commercially and one that can.
 *
 * ## Why it is more involved than a URL
 *
 * Two things changed on SoundCloud's side and both have to be handled:
 *
 * 1. **`client_id` as a query parameter was deprecated.** Every client is now
 *    treated as confidential and must exchange a client ID and secret for an
 *    OAuth token via the `client_credentials` grant. Tokens expire, so they have
 *    to be refreshed rather than fetched once.
 *
 * 2. **MP3 and Opus progressive transcodings were retired** in favour of AAC
 *    over HLS at the end of 2025. There is no longer a single URL that returns
 *    an audio file; a track exposes a list of *transcodings*, each of which must
 *    be resolved to a playlist URL, which then has to be consumed as HLS.
 *
 * ffmpeg reads HLS natively, so once the playlist URL is obtained the rest of
 * the pipeline is unchanged - which is why this module's job ends at returning
 * that URL.
 *
 * ## Credentials
 *
 * Register at https://developers.soundcloud.com and set `SOUNDCLOUD_CLIENT_ID`
 * and `SOUNDCLOUD_CLIENT_SECRET`. Without both, this module reports itself
 * unavailable and the caller falls back to extraction.
 */

const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const API = 'https://api.soundcloud.com';

/**
 * Seconds of margin before a token's stated expiry.
 *
 * Refreshing slightly early avoids the case where a token passes validation
 * here and expires in flight, which surfaces as an unexplained 401 mid-track.
 */
const REFRESH_MARGIN_SEC = 120;

export class SoundCloudApi {
  /**
   * @param {string|undefined} clientId
   * @param {string|undefined} clientSecret
   */
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.expiresAt = 0;
    /** Serialises refreshes so a burst of requests triggers only one. */
    this.pending = null;
  }

  /** Whether credentials are configured. @returns {boolean} */
  get available() {
    return Boolean(this.clientId && this.clientSecret);
  }

  /**
   * A valid access token, fetched or refreshed as needed.
   *
   * @returns {Promise<string>}
   */
  async accessToken() {
    if (!this.available) throw new Error('SoundCloud API credentials are not set.');

    if (this.token && Date.now() / 1000 < this.expiresAt - REFRESH_MARGIN_SEC) {
      return this.token;
    }

    // One refresh at a time. Without this, several tracks starting together
    // would each request a token and the last to land would win, discarding
    // tokens the others were about to use.
    if (this.pending) return this.pending;

    this.pending = (async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json; charset=utf-8',
        },
        body,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `SoundCloud token request failed (${response.status}). `
          + `Check SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET. ${detail.slice(0, 200)}`,
        );
      }

      const data = await response.json();
      this.token = data.access_token;
      this.expiresAt = Date.now() / 1000 + (data.expires_in ?? 3600);
      console.log('soundcloud: obtained access token, valid '
        + `${Math.round((data.expires_in ?? 3600) / 60)} minutes`);
      return this.token;
    })().finally(() => {
      this.pending = null;
    });

    return this.pending;
  }

  /**
   * Call an API endpoint with a valid token.
   *
   * @param {string} path Path or absolute URL.
   * @param {Record<string, string|number>} [query]
   * @returns {Promise<object>}
   */
  async request(path, query = {}) {
    const token = await this.accessToken();
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `OAuth ${token}`,
        Accept: 'application/json; charset=utf-8',
      },
    });

    if (response.status === 401) {
      // The token was rejected despite looking valid. Discard it so the next
      // call fetches a fresh one rather than failing identically.
      this.token = null;
      this.expiresAt = 0;
      throw new Error('SoundCloud rejected the access token.');
    }
    if (!response.ok) {
      throw new Error(`SoundCloud returned ${response.status} for ${url.pathname}`);
    }

    return response.json();
  }

  /**
   * Convert an API track object into this project's track shape.
   *
   * @param {object} track
   * @returns {object}
   */
  static toTrack(track) {
    return {
      provider: 'soundcloud',
      providerId: String(track.id),
      title: track.title ?? 'Untitled',
      artist: track.user?.username ?? 'Unknown',
      url: track.permalink_url,
      durationSec: Math.round((track.duration ?? 0) / 1000),
      // The default artwork is tiny; asking for the larger size costs nothing.
      thumbnail: (track.artwork_url ?? track.user?.avatar_url ?? null)
        ?.replace('-large.', '-t500x500.') ?? null,
      // Carried through so the audio step does not have to fetch the track again.
      media: track.media ?? null,
      streamable: track.streamable !== false,
    };
  }

  /**
   * Resolve a soundcloud.com URL to a track.
   *
   * @param {string} url
   * @returns {Promise<object>}
   */
  async resolve(url) {
    const resolved = await this.request('/resolve', { url });
    if (resolved.kind && resolved.kind !== 'track') {
      throw new Error(`That SoundCloud link is a ${resolved.kind}, not a track.`);
    }
    return SoundCloudApi.toTrack(resolved);
  }

  /**
   * Search for tracks.
   *
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async search(query, limit = 5) {
    const results = await this.request('/tracks', {
      q: query,
      limit,
      access: 'playable',
      linked_partitioning: 1,
    });
    const collection = results.collection ?? results;
    if (!Array.isArray(collection) || collection.length === 0) {
      throw new Error(`Nothing found on SoundCloud for "${query}".`);
    }
    return collection.map((track) => SoundCloudApi.toTrack(track));
  }

  /**
   * Get a playable stream URL for a track.
   *
   * Prefers progressive audio where a track still offers it, because a single
   * file is simpler and slightly cheaper than a playlist. Falls back to HLS,
   * which is what most tracks now serve.
   *
   * The returned URL is short-lived and pre-authorised, so it is handed straight
   * to ffmpeg rather than being stored.
   *
   * @param {object} track A track from {@link toTrack}, or its id.
   * @returns {Promise<{url: string, protocol: string}>}
   */
  async streamUrl(track) {
    let media = track.media;

    // A track queued earlier, or restored from favourites, may not carry its
    // transcodings; fetch them rather than failing.
    if (!media?.transcodings?.length) {
      const full = await this.request(`/tracks/${track.providerId ?? track}`);
      media = full.media;
    }

    const transcodings = media?.transcodings ?? [];
    if (transcodings.length === 0) {
      throw new Error('That SoundCloud track offers no playable stream.');
    }

    // Order of preference: progressive audio, then HLS. Anything unrecognised
    // is left to last rather than excluded, since new formats appear over time.
    const rank = (item) => {
      const protocol = item.format?.protocol;
      if (protocol === 'progressive') return 0;
      if (protocol === 'hls') return 1;
      return 2;
    };
    const chosen = [...transcodings].sort((a, b) => rank(a) - rank(b))[0];

    // The transcoding's `url` is not the audio: it returns a short-lived,
    // signed URL that is.
    const ticket = await this.request(chosen.url);
    if (!ticket?.url) throw new Error('SoundCloud did not return a stream URL.');

    return { url: ticket.url, protocol: chosen.format?.protocol ?? 'unknown' };
  }
}
