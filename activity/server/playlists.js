/**
 * Playlists: two per person, per server. One private, one public.
 *
 * Distinct from both of the collections that already exist, and the difference
 * is the whole point:
 *
 * - **Favourites** are one shared list per guild. Everyone sees the same
 *   entries and each carries who starred it. The point is social.
 * - **Decks** are up to three parallel *queues*. They are what the room is
 *   about to hear, they are transient, and they empty as they play.
 * - **Playlists** are a person's own saved collections. They outlive a session,
 *   nothing removes a track by playing it, and one of the two is visible to
 *   everybody else in the server while the other is nobody's business.
 *
 * ## Exactly two, deliberately
 *
 * Not a list of playlists. Two slots, `private` and `public`, both renameable.
 * A fixed pair means the visibility of a playlist is a property of *which slot
 * it is*, not a flag someone can flip by accident - there is no path where a
 * rename or an edit quietly publishes a private collection, because the private
 * slot is never serialised to anyone else. Renaming changes the label and
 * nothing else.
 *
 * ## Persistence and trust
 *
 * Same approach as {@link Favourites}: one JSON file under the cache directory,
 * writes serialised through a promise chain so two edits cannot interleave a
 * read-modify-write, and written-then-renamed so a crash cannot truncate the
 * store.
 *
 * Track descriptors are stored whole. That is what lets a playlist still be
 * playable months later, and it is why `resolveKnownTrack` treats this store as
 * a source: a track saved here must stay queueable after the resolve cache has
 * expired and without being a favourite. Callers must only ever pass
 * server-resolved descriptors - nothing a client sent - or this store becomes a
 * way to smuggle a URL into the queue.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

/** The two slots every user has. Order matters: it is the display order. */
export const SLOTS = ['public', 'private'];

/** Most tracks kept in one playlist. Oldest are dropped beyond this. */
export const MAX_TRACKS = 100;

/** Longest playlist name. Long enough to be descriptive, short enough to fit. */
export const MAX_NAME = 40;

/** Default names, used until somebody renames a slot. */
const DEFAULT_NAMES = { public: 'My public playlist', private: 'My private playlist' };

/**
 * Strip a user-supplied name down to something safe to render and store.
 *
 * Control characters are removed rather than escaped: they have no legitimate
 * place in a playlist name, and a name containing a newline breaks every
 * single-line layout that shows it.
 */
export function cleanName(raw, slot) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return text || DEFAULT_NAMES[slot] || 'Playlist';
}

export class Playlists {
  /** @param {string} directory Where to keep the store file. */
  constructor(directory) {
    this.filePath = path.join(directory, 'playlists.json');
    this.directory = directory;
    /** @type {Map<string, Map<string, object>>} Guild ID to user ID to record. */
    this.byGuild = new Map();
    this.writeChain = Promise.resolve();
    this.loaded = false;
  }

  /** Read the store from disk. Safe to call repeatedly. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
      for (const [guildId, users] of Object.entries(raw ?? {})) {
        const map = new Map();
        for (const [userId, record] of Object.entries(users ?? {})) {
          map.set(userId, {
            user: record.user ?? { id: userId, username: 'someone', avatar: null },
            public: {
              name: cleanName(record.public?.name, 'public'),
              tracks: Array.isArray(record.public?.tracks) ? record.public.tracks : [],
            },
            private: {
              name: cleanName(record.private?.name, 'private'),
              tracks: Array.isArray(record.private?.tracks) ? record.private.tracks : [],
            },
          });
        }
        this.byGuild.set(guildId, map);
      }
    } catch (error) {
      // A missing file is the normal first run. Anything else is worth saying
      // out loud, because the alternative is silently starting empty and
      // looking to the user like every playlist was deleted.
      if (error.code !== 'ENOENT') {
        console.error('playlists: could not read store:', error.message);
      }
    }
  }

  /** Queue a write. @returns {Promise<void>} */
  persist() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const payload = {};
      for (const [guildId, users] of this.byGuild) {
        payload[guildId] = Object.fromEntries(users);
      }
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(payload, null, 2));
      await rename(temporary, this.filePath);
    }).catch((error) => {
      console.error('playlists: write failed:', error.message);
    });
    return this.writeChain;
  }

  /**
   * The record for one user, created empty if they have never had one.
   *
   * @param {string} guildId
   * @param {{id: string, username?: string, avatar?: string|null}} user
   */
  ensure(guildId, user) {
    if (!this.byGuild.has(guildId)) this.byGuild.set(guildId, new Map());
    const users = this.byGuild.get(guildId);
    const existing = users.get(user.id);
    if (existing) {
      // Names change. Keeping the display name current matters because other
      // people browse public playlists by their owner.
      if (user.username) existing.user.username = user.username;
      if (user.avatar !== undefined) existing.user.avatar = user.avatar;
      return existing;
    }
    const record = {
      user: { id: user.id, username: user.username ?? 'someone', avatar: user.avatar ?? null },
      public: { name: DEFAULT_NAMES.public, tracks: [] },
      private: { name: DEFAULT_NAMES.private, tracks: [] },
    };
    users.set(user.id, record);
    return record;
  }

  /** @returns {object|null} A user's record without creating one. */
  get(guildId, userId) {
    return this.byGuild.get(guildId)?.get(userId) ?? null;
  }

  /**
   * Save a track into one of a user's playlists.
   *
   * @param {string} guildId
   * @param {object} user Verified identity.
   * @param {'public'|'private'} slot
   * @param {object} track A server-resolved descriptor.
   * @returns {{added: boolean, reason?: string, playlist: object}}
   */
  add(guildId, user, slot, track) {
    if (!SLOTS.includes(slot)) throw new Error(`No such playlist slot: ${slot}`);
    const record = this.ensure(guildId, user);
    const playlist = record[slot];
    const key = `${track.provider}:${track.providerId}`;

    if (playlist.tracks.some((entry) => `${entry.provider}:${entry.providerId}` === key)) {
      return { added: false, reason: 'already', playlist };
    }

    playlist.tracks.push({ ...track, savedAt: new Date().toISOString() });
    // Oldest go first. A playlist at its ceiling that silently refused new
    // tracks would look broken; dropping the oldest is at least predictable.
    if (playlist.tracks.length > MAX_TRACKS) {
      playlist.tracks.splice(0, playlist.tracks.length - MAX_TRACKS);
    }
    this.persist();
    return { added: true, playlist };
  }

  /**
   * Remove a track from one of a user's playlists.
   *
   * @returns {{removed: boolean, playlist: object|null}}
   */
  remove(guildId, userId, slot, provider, providerId) {
    if (!SLOTS.includes(slot)) throw new Error(`No such playlist slot: ${slot}`);
    const record = this.get(guildId, userId);
    if (!record) return { removed: false, playlist: null };
    const playlist = record[slot];
    const key = `${provider}:${providerId}`;
    const before = playlist.tracks.length;
    playlist.tracks = playlist.tracks.filter(
      (entry) => `${entry.provider}:${entry.providerId}` !== key,
    );
    if (playlist.tracks.length === before) return { removed: false, playlist };
    this.persist();
    return { removed: true, playlist };
  }

  /**
   * Rename a slot. The slot's visibility is unchanged - only its label.
   *
   * @returns {{name: string}}
   */
  rename(guildId, user, slot, name) {
    if (!SLOTS.includes(slot)) throw new Error(`No such playlist slot: ${slot}`);
    const record = this.ensure(guildId, user);
    record[slot].name = cleanName(name, slot);
    this.persist();
    return { name: record[slot].name };
  }

  /**
   * What one viewer is allowed to see.
   *
   * Their own two playlists in full, and everybody else's *public* one. The
   * private slot of another user is never read here, so no serialisation
   * mistake downstream can leak it - it is not in the returned object at all.
   *
   * @param {string} guildId
   * @param {object} viewer Verified identity of whoever is asking.
   */
  forViewer(guildId, viewer) {
    const record = this.ensure(guildId, viewer);
    const users = this.byGuild.get(guildId) ?? new Map();

    const others = [];
    for (const [userId, other] of users) {
      if (userId === viewer.id) continue;
      // An empty public playlist is not worth a row. Somebody who has never
      // used the feature would otherwise fill the panel with empty shelves.
      if (other.public.tracks.length === 0) continue;
      others.push({
        user: other.user,
        name: other.public.name,
        visibility: 'public',
        tracks: other.public.tracks,
      });
    }
    others.sort((a, b) => b.tracks.length - a.tracks.length);

    return {
      mine: {
        public: { ...record.public, visibility: 'public', slot: 'public' },
        private: { ...record.private, visibility: 'private', slot: 'private' },
      },
      others,
    };
  }

  /**
   * Find a stored descriptor for a track anywhere in a guild's playlists.
   *
   * Every playlist is searched, private ones included. That is not a leak:
   * this answers "what track is this", not "whose playlist is it in", and it
   * returns only the descriptor. Without it, a track saved months ago and since
   * evicted from the resolve cache could be seen in a playlist and not played -
   * and the private slot would be the one that broke.
   *
   * @returns {object|null} The descriptor, without playlist bookkeeping.
   */
  findTrack(guildId, provider, providerId) {
    const key = `${provider}:${providerId}`;
    for (const record of (this.byGuild.get(guildId) ?? new Map()).values()) {
      for (const slot of SLOTS) {
        const found = record[slot].tracks.find(
          (entry) => `${entry.provider}:${entry.providerId}` === key,
        );
        if (found) {
          const { savedAt, ...track } = found;
          return track;
        }
      }
    }
    return null;
  }
}
