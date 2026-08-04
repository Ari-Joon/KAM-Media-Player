/**
 * Artist lookup via MusicBrainz.
 *
 * Parsing a title tells you how many acts are credited but not how many people
 * those acts contain - "Illit" is a five-piece and nothing in the string says
 * so. MusicBrainz records whether an artist is a Person or a Group and lists a
 * group's members, which is the only reliable way to know.
 *
 * ## Why this is careful
 *
 * MusicBrainz is a volunteer-run service with a published rate limit of one
 * request per second and a requirement to identify your application. Ignoring
 * either gets an IP blocked, so requests are queued through a single-file gate
 * and every result is cached - including misses, so an unknown name is not
 * looked up repeatedly.
 *
 * A lookup needs two calls for a group (find the artist, then read its members),
 * so a track with three credited acts can cost six seconds of queue time. It is
 * therefore done in the background after playback starts, never on the path to
 * making sound.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://musicbrainz.org/ws/2';

/**
 * Identifying header, which MusicBrainz requires.
 *
 * Requests without a meaningful User-Agent are rejected, and a generic one is
 * treated as abuse.
 */
const USER_AGENT = 'KAMMediaPlayer/1.0 (Discord music visualiser)';

/** Minimum gap between requests, per their published limit. */
const REQUEST_GAP_MS = 1100;

/** How long a cached answer stays good. Group line-ups change rarely. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class ArtistInfo {
  /** @param {string} directory Where to persist the cache. */
  constructor(directory) {
    this.filePath = path.join(directory, 'artists.json');
    this.directory = directory;
    /** @type {Map<string, {type: string, members: number, at: number}>} */
    this.cache = new Map();
    this.loaded = false;
    /** Serialises outbound requests to respect the rate limit. */
    this.gate = Promise.resolve();
    this.lastRequest = 0;
    this.writeChain = Promise.resolve();
  }

  /** Load the cache from disk. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
      for (const [name, record] of Object.entries(raw)) this.cache.set(name, record);
      console.log(`artists: loaded ${this.cache.size} cached lookups`);
    } catch {
      // First run.
    }
  }

  /** Queue a cache write. */
  persist() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(Object.fromEntries(this.cache), null, 2));
      await rename(temporary, this.filePath);
    }).catch(() => {});
    return this.writeChain;
  }

  /**
   * Perform one request, no sooner than the rate limit allows.
   *
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  request(url) {
    this.gate = this.gate.then(async () => {
      const wait = REQUEST_GAP_MS - (Date.now() - this.lastRequest);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequest = Date.now();

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    });
    return this.gate;
  }

  /**
   * How many people perform under a given name.
   *
   * @param {string} name Artist or group name.
   * @returns {Promise<{type: string, members: number}>}
   */
  async lookup(name) {
    await this.load();
    const key = name.trim().toLowerCase();
    if (!key) return { type: 'Unknown', members: 1 };

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { type: cached.type, members: cached.members };
    }

    const search = await this.request(
      `${ENDPOINT}/artist?query=${encodeURIComponent(`artist:"${name}"`)}&limit=1&fmt=json`,
    );
    const artist = search?.artists?.[0];

    // A weak match is worse than no match: MusicBrainz will happily return
    // something loosely similar, and misattributing a band to a soloist puts the
    // wrong number of figures on stage.
    if (!artist || (artist.score ?? 0) < 90) {
      const record = { type: 'Unknown', members: 1, at: Date.now() };
      this.cache.set(key, record);
      this.persist();
      return { type: record.type, members: record.members };
    }

    let members = 1;
    if (artist.type === 'Group' || artist.type === 'Orchestra' || artist.type === 'Choir') {
      const detail = await this.request(
        `${ENDPOINT}/artist/${artist.id}?inc=artist-rels&fmt=json`,
      );
      const relations = detail?.relations ?? [];
      const band = relations.filter((relation) => relation.type === 'member of band');
      // Count current members where the data says so, otherwise everyone ever
      // listed - a defunct band still has a line-up worth showing.
      const current = band.filter((relation) => !relation.ended);
      members = Math.max(1, (current.length || band.length) || 4);
      // Cap: a 40-piece orchestra is not a useful number of dancers.
      members = Math.min(members, 8);
    }

    const record = { type: artist.type ?? 'Unknown', members, at: Date.now() };
    this.cache.set(key, record);
    this.persist();
    console.log(`artists: ${name} -> ${record.type}, ${members} member(s)`);
    return { type: record.type, members };
  }

  /**
   * Total performers across several credited names.
   *
   * @param {string[]} names
   * @returns {Promise<number>}
   */
  async countPerformers(names) {
    let total = 0;
    for (const name of names.slice(0, 4)) {
      const { members } = await this.lookup(name);
      total += members;
    }
    return Math.max(1, Math.min(10, total));
  }
}
