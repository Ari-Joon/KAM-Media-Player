/**
 * Is there a newer KAM Media Player than the one running?
 *
 * Asked once, when the server starts, and only for the person running it: the
 * answer goes to the console and to /healthz, never into Discord, because
 * nobody in a voice channel can act on it.
 *
 * The newest version is read from the repository's tags, not from its
 * "latest release". Releases here lag the tags - GitHub still called 0.9.0 the
 * latest while 0.9.6 was tagged - so a release-based check would either stay
 * silent forever or offer an older version as an update. Only a strictly
 * higher plain version number counts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'Ari-Joon/KAM-Media-Player';
export const CHANGELOG = `https://github.com/${REPO}/blob/main/CHANGELOG.md`;
const TAGS = `https://api.github.com/repos/${REPO}/tags?per_page=100`;

/** The version this copy is, from the package.json every way of running it carries. */
export function currentVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
}

/** `v0.9.7` or `0.9.7` -> [0, 9, 7]. Anything else, pre-releases included, -> null. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Number by number, so 0.10.0 is newer than 0.9.9 rather than older. */
export function isNewer(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The highest plain version among the tags, as `0.9.7`, or null. GitHub does not sort them. */
export function newestTag(tags) {
  let best = null;
  for (const tag of tags ?? []) {
    const version = parseVersion(tag?.name);
    if (version && (!best || isNewer(version, best))) best = version;
  }
  return best ? best.join('.') : null;
}

/** UPDATE_CHECK=off (or false, 0, no) keeps the server off GitHub at boot. */
export function checkDisabled(env = process.env) {
  return /^(off|false|0|no)$/i.test(String(env.UPDATE_CHECK ?? '').trim());
}

/**
 * Ask GitHub. Resolves to `{ current, latest, available }`, or to
 * `{ current, error }` when the question could not be answered. It never
 * throws: a failed check must make no difference to the server.
 */
export async function checkForUpdate({ current = currentVersion(), fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TAGS, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `KAM-Media-Player/${current}` },
    });
    if (!response.ok) return { current, error: `GitHub replied ${response.status}` };
    const latest = newestTag(await response.json());
    if (!latest) return { current, error: 'GitHub listed no release tags' };
    const mine = parseVersion(current);
    return { current, latest, available: mine ? isNewer(parseVersion(latest), mine) : false };
  } catch (error) {
    return { current, error: error?.name === 'AbortError' ? 'GitHub did not answer in time' : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
