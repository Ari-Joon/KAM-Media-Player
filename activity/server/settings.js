/**
 * Per-guild playback settings that outlive a restart.
 *
 * ## Why these are not just fields on the player
 *
 * `GuildPlayer` is built fresh whenever a guild is first seen, so anything held
 * only in memory resets every time the process restarts. That is right for
 * playback state - the queue, the position, what is playing - because none of
 * it survives the audio stopping anyway. It is wrong for a *setting*: somebody
 * chose a crossfade length once, and it disappearing on a deploy reads as the
 * feature being broken rather than as the process having restarted.
 *
 * Deliberately separate from `GuildPlayer` rather than a method on it. The
 * player knows nothing about the filesystem - its audio loading is injected for
 * the same reason - and a store that writes to disk from inside the voice
 * pipeline would put a failed write in the path of playback.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('settings');

export class PlayerSettings {
  /** @param {string} directory Where to keep the store file. */
  constructor(directory) {
    this.filePath = path.join(directory, 'player-settings.json');
    this.directory = directory;
    /** @type {Map<string, object>} Settings by guild ID. */
    this.byGuild = new Map();
    /** Serialises writes so two guilds changing at once cannot clobber. */
    this.writeChain = Promise.resolve();
    this.loaded = false;
  }

  /** Read the store, treating any problem as "no settings yet". */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
      for (const [guildId, values] of Object.entries(raw)) {
        if (values && typeof values === 'object') this.byGuild.set(guildId, values);
      }
      if (this.byGuild.size > 0) {
        log.info(`loaded settings for ${this.byGuild.size} guild(s)`);
      }
    } catch {
      // No file on a first run, and a corrupt one is not worth refusing to
      // start over - the cost of losing these is one slider being re-set.
    }
  }

  /**
   * @param {string} guildId
   * @returns {object} The guild's settings, or an empty object.
   */
  get(guildId) {
    return this.byGuild.get(guildId) ?? {};
  }

  /**
   * Store one setting and persist.
   *
   * @param {string} guildId
   * @param {string} key
   * @param {unknown} value Anything JSON can hold; null removes the setting.
   * @returns {Promise<void>}
   */
  set(guildId, key, value) {
    const current = { ...this.get(guildId) };
    if (value === null || value === undefined) delete current[key];
    else current[key] = value;
    this.byGuild.set(guildId, current);
    return this.save();
  }

  /** Write the store atomically. @returns {Promise<void>} */
  save() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const payload = Object.fromEntries(this.byGuild);
      // Write then rename, as the favourites store does: a crash mid-write
      // would otherwise leave a truncated file that fails to parse.
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(payload, null, 2));
      await rename(temporary, this.filePath);
    }).catch((error) => {
      log.error(`write failed: ${error.message}`);
    });
    return this.writeChain;
  }
}
