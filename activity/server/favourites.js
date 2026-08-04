/**
 * Favourites: a shared, persistent list per Discord server.
 *
 * Everyone in the guild sees the same list, and each entry carries who added it
 * along with their avatar - the point is social, not personal bookmarking. A
 * favourite is a full track descriptor, so playing one needs no re-resolution
 * and costs no YouTube search quota.
 *
 * ## Persistence
 *
 * Written to a JSON file under the cache directory, which on the Fly deployment
 * lives on a mounted volume and therefore survives redeploys. Writes are
 * serialised through a single promise chain: two people pressing the star at the
 * same moment would otherwise interleave read-modify-write and lose one entry.
 *
 * ## Trust
 *
 * The attributed user is asserted by the client rather than verified against the
 * OAuth token server-side. This is acceptable only within the documented
 * trusted-server alpha boundary. Before any public deployment it must be bound
 * to a server-verified OAuth and Activity-instance session, because a crafted
 * request can currently attribute a favourite to another user.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

/** Most favourites kept per guild. Older entries are dropped beyond this. */
const MAX_PER_GUILD = 200;

export class Favourites {
  /** @param {string} directory Where to keep the store file. */
  constructor(directory) {
    this.filePath = path.join(directory, 'favourites.json');
    this.directory = directory;
    /** @type {Map<string, object[]>} Entries by guild ID. */
    this.byGuild = new Map();
    /** Serialises writes so concurrent adds cannot clobber each other. */
    this.writeChain = Promise.resolve();
    this.loaded = false;
  }

  /**
   * Read the store from disk, migrating older records.
   *
   * Early versions recorded a single `addedBy` object, which made it impossible
   * for two people to favourite the same song. Entries in that shape are
   * upgraded to a list on load, so no favourite is lost and nothing has to be
   * re-saved by hand.
   */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
      let migrated = 0;
      for (const [guildId, entries] of Object.entries(raw)) {
        for (const entry of entries) {
          if (entry.addedBy && !Array.isArray(entry.addedBy)) {
            entry.addedBy = [{ ...entry.addedBy, at: entry.addedAt ?? null }];
            migrated += 1;
          } else if (!entry.addedBy) {
            entry.addedBy = [];
          }
        }
        this.byGuild.set(guildId, entries);
      }
      if (migrated) console.log(`favourites: migrated ${migrated} single-user entries`);
      console.log(`favourites: loaded ${this.count()} across `
        + `${this.byGuild.size} guild(s)`);
    } catch {
      // No file yet is the normal first-run case.
    }
  }

  /** @returns {number} Total entries across all guilds. */
  count() {
    let total = 0;
    for (const entries of this.byGuild.values()) total += entries.length;
    return total;
  }

  /** Queue a write. @returns {Promise<void>} */
  persist() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const payload = Object.fromEntries(this.byGuild);
      // Write then rename: a crash mid-write would otherwise leave a truncated
      // file that fails to parse and loses every favourite.
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(payload, null, 2));
      await rename(temporary, this.filePath);
    }).catch((error) => {
      console.error('favourites: write failed:', error.message);
    });
    return this.writeChain;
  }

  /**
   * List a guild's favourites, newest first.
   *
   * @param {string} guildId
   * @returns {object[]}
   */
  list(guildId) {
    return [...(this.byGuild.get(guildId) ?? [])].reverse();
  }

  /**
   * Favourite a track for a user.
   *
   * A track is stored once; each person who favourites it is appended to its
   * list. That is what allows the same song to appear in several people's
   * folders and lets a "most favourited" view exist at all.
   *
   * @param {string} guildId
   * @param {object} track Track descriptor.
   * @param {{id: string, username: string, avatar: string|null}} user
   * @returns {{entry: object, added: boolean, alreadyMine: boolean}}
   */
  add(guildId, track, user) {
    const entries = this.byGuild.get(guildId) ?? [];
    const key = `${track.provider}:${track.providerId}`;
    const stamp = new Date().toISOString();

    const record = {
      id: user?.id ?? null,
      username: user?.username ?? 'someone',
      avatar: user?.avatar ?? null,
      at: stamp,
    };

    const existing = entries.find(
      (entry) => `${entry.provider}:${entry.providerId}` === key,
    );

    if (existing) {
      const already = existing.addedBy.some((who) => who.id && who.id === record.id);
      if (already) return { entry: existing, added: false, alreadyMine: true };
      existing.addedBy.push(record);
      this.persist();
      return { entry: existing, added: true, alreadyMine: false };
    }

    const entry = {
      provider: track.provider,
      providerId: track.providerId,
      title: track.title,
      artist: track.artist,
      url: track.url,
      durationSec: track.durationSec,
      thumbnail: track.thumbnail ?? null,
      addedBy: [record],
      addedAt: stamp,
    };

    entries.push(entry);
    // Drop the oldest rather than refusing, so the star never stops working.
    while (entries.length > MAX_PER_GUILD) entries.shift();
    this.byGuild.set(guildId, entries);
    this.persist();
    return { entry, added: true, alreadyMine: false };
  }

  /**
   * Most recent time anyone favourited a track.
   *
   * @param {object} entry
   * @returns {number} Milliseconds since epoch.
   */
  static latestAt(entry) {
    const stamps = (entry.addedBy ?? [])
      .map((who) => Date.parse(who.at ?? '') || 0)
      .concat(Date.parse(entry.addedAt ?? '') || 0);
    return Math.max(...stamps, 0);
  }

  /**
   * Everyone who has favourited anything, with counts.
   *
   * @param {string} guildId
   * @returns {Array<{id: string|null, username: string, count: number, latest: number}>}
   */
  contributors(guildId) {
    const people = new Map();
    for (const entry of this.byGuild.get(guildId) ?? []) {
      for (const who of entry.addedBy ?? []) {
        const key = who.id ?? who.username;
        const current = people.get(key) ?? {
          id: who.id ?? null, username: who.username, count: 0, latest: 0,
        };
        current.count += 1;
        current.latest = Math.max(current.latest, Date.parse(who.at ?? '') || 0);
        people.set(key, current);
      }
    }
    // Busiest first: the person with the most favourites is the most useful
    // folder to open.
    return [...people.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * Remove a track.
   *
   * @param {string} guildId
   * @param {string} provider
   * @param {string} providerId
   * @returns {object|null} The removed entry.
   */
  /**
   * Un-favourite a track for one user, or remove it entirely.
   *
   * Removing only the requesting user matters now that several people can
   * favourite the same song: one person changing their mind must not delete it
   * from everyone else's folder.
   *
   * @param {string} guildId
   * @param {string} provider
   * @param {string} providerId
   * @param {string|null} [userId] Remove only this user's entry when given.
   * @returns {object|null} The affected entry.
   */
  remove(guildId, provider, providerId, userId = null) {
    const entries = this.byGuild.get(guildId);
    if (!entries) return null;
    const key = `${provider}:${providerId}`;
    const index = entries.findIndex(
      (entry) => `${entry.provider}:${entry.providerId}` === key,
    );
    if (index === -1) return null;

    const entry = entries[index];
    if (userId) {
      entry.addedBy = entry.addedBy.filter((who) => who.id !== userId);
      // Only when nobody is left does the track leave the list.
      if (entry.addedBy.length > 0) {
        this.persist();
        return entry;
      }
    }

    entries.splice(index, 1);
    this.persist();
    return entry;
  }

  /**
   * Whether a track is already favourited.
   *
   * @param {string} guildId
   * @param {object|null} track
   * @returns {boolean}
   */
  has(guildId, track, userId = null) {
    if (!track) return false;
    const key = `${track.provider}:${track.providerId}`;
    const entry = (this.byGuild.get(guildId) ?? []).find(
      (candidate) => `${candidate.provider}:${candidate.providerId}` === key,
    );
    if (!entry) return false;
    if (!userId) return true;
    return entry.addedBy.some((who) => who.id === userId);
  }
}

/**
 * Build a Discord CDN avatar URL.
 *
 * Kept here so both the bot and the Activity render the same image, and so the
 * fallback for users with no custom avatar is handled in one place.
 *
 * @param {{id: string|null, avatar: string|null}} user
 * @returns {string|null}
 */
export function avatarUrl(user) {
  if (!user?.id) return null;
  if (!user.avatar) {
    // Default avatars are derived from the user ID.
    const index = (BigInt(user.id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=64`;
}
