/**
 * Keeping the on-disk score cache from growing without limit.
 *
 * Scores are far smaller than audio and far from free: measured on a working
 * install, 75 cached scores came to 62MB against 84MB of audio, and one
 * four-minute track's score was 12MB on its own. The audio beside them has been
 * bounded by a 3GB least-recently-used budget all along; these never were, so
 * over long sessions they are the part that grows without limit.
 *
 * Its own module rather than a function in `server.js` because it deletes
 * files, and a deletion rule is worth being able to test directly - the failure
 * mode of getting it wrong is removing something that cannot be rebuilt.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Largest the on-disk score cache is allowed to grow, in bytes. */
export const SCORE_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Which analyser version a cache file belongs to, or null if it is not one.
 *
 * The suffix is the whole test. Favourites, settings, audio and the tunnel
 * host file all live in the same directory, and none of them may be touched.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function scoreVersion(name) {
  const match = /^.+-a(.+)\.json$/.exec(name);
  return match ? match[1] : null;
}

/**
 * Delete scores that can no longer be read, then the oldest until the rest fit.
 *
 * ## Why there are several copies of one track
 *
 * The cache path carries the analyser version, so a score built by an older
 * analyser is never handed to a newer one - `SCHEMA_VERSION` is semantic for
 * exactly this reason. Nothing ever removed the superseded files, so every
 * analyser release left another full copy of every track behind. Measured
 * before this existed: 48MB of 62MB belonged to versions no longer in use, and
 * four tracks had three copies each.
 *
 * Those can never be read again, so they go outright rather than being counted
 * against the budget. What survives is trimmed by modification time, as the
 * audio cache is and for the same reason - `noatime` mounts stop maintaining
 * access time, and these are written once.
 *
 * @param {string} directory
 * @param {string} version The analyser version currently running.
 * @param {number} [maxBytes]
 * @returns {Promise<{staleCount: number, staleBytes: number, freed: number,
 *   liveBytes: number}>}
 */
export async function pruneScoreCache(directory, version, maxBytes = SCORE_CACHE_MAX_BYTES) {
  const names = await readdir(directory).catch(() => []);
  const live = [];
  let staleBytes = 0;
  let staleCount = 0;
  let total = 0;

  for (const name of names) {
    const found = scoreVersion(name);
    if (found === null) continue;
    const full = path.join(directory, name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;

    if (found !== version) {
      await unlink(full).catch(() => {});
      staleBytes += info.size;
      staleCount += 1;
      continue;
    }
    live.push({ full, size: info.size, at: info.mtimeMs });
    total += info.size;
  }

  let freed = 0;
  if (total > maxBytes) {
    live.sort((a, b) => a.at - b.at);
    for (const file of live) {
      if (total - freed <= maxBytes) break;
      await unlink(file.full).catch(() => {});
      freed += file.size;
    }
  }

  return { staleCount, staleBytes, freed, liveBytes: total - freed };
}
