/**
 * Media embedding: turn a social link into a video that plays inside Discord.
 *
 * TikTok, Instagram and X links unfurl badly or not at all in Discord - you get
 * a thumbnail and a click-out. Downloading the video and re-uploading it as an
 * attachment makes it play inline, which is the whole trick behind bots like
 * CLYPPY.
 *
 * ## Size is the hard part
 *
 * Discord's upload limit depends on the server's boost tier, and short-form
 * video routinely exceeds the default 10 MiB. Rather than refusing, oversized
 * files are transcoded down to fit: the target bitrate is computed from the
 * duration and the limit, so the result is as good as the ceiling allows. A
 * 60-second clip into 10 MiB is roughly 1.3 Mbps, which is visually fine at
 * phone resolution.
 *
 * Files are deleted immediately after upload. Nothing is retained.
 */

import { spawn } from 'node:child_process';
import { mkdir, stat, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';

const { YTDLP_BIN = 'yt-dlp' } = process.env;

/**
 * Discord attachment limits by guild boost tier, in bytes.
 *
 * Deliberately conservative: the real ceiling is per-request and includes
 * overhead, so aiming at 95% avoids rejections at the boundary.
 */
const TIER_LIMITS = [10, 10, 50, 100].map((mib) => Math.floor(mib * 1024 * 1024 * 0.95));

/** Longest clip worth embedding. Beyond this the transcode looks poor anyway. */
const MAX_DURATION_SEC = 10 * 60;

/**
 * Hosts that definitely will not work, so the attempt can be refused quickly.
 *
 * The allowlist that used to live here rejected full YouTube videos, Vimeo,
 * Twitch clips and everything else yt-dlp handles - which is over a thousand
 * sites. Inverting it means anything plausible is tried, and yt-dlp reports what
 * it cannot do far more accurately than a regular expression can guess.
 */
const NEVER_EMBEDDABLE = /\.(?:jpg|jpeg|png|gif|webp|pdf|zip|exe|dmg)(?:$|\?)/i;

/**
 * Whether a URL is worth attempting.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isEmbeddable(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  return !NEVER_EMBEDDABLE.test(url);
}

/**
 * Upload limit for a guild.
 *
 * @param {number} premiumTier Guild boost tier, 0-3.
 * @returns {number} Bytes.
 */
export function uploadLimit(premiumTier = 0) {
  return TIER_LIMITS[premiumTier] ?? TIER_LIMITS[0];
}

/**
 * Run a command, resolving with stdout.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function run(command, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT'
        ? new Error(`${command} is not installed or not on PATH.`)
        : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim().split('\n').pop() || `${command} exited ${code}`));
    });
  });
}

/**
 * Read metadata without downloading.
 *
 * Done first so an over-long or unsupported link fails in a second rather than
 * after a full download.
 *
 * @param {string} url
 * @returns {Promise<object>} Title, uploader, duration and dimensions.
 */
export async function probe(url) {
  const raw = await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--no-playlist', '--dump-single-json', url,
  ], 45_000);

  const info = JSON.parse(raw);
  return {
    title: info.title ?? 'Untitled',
    uploader: info.uploader ?? info.channel ?? null,
    durationSec: Math.round(info.duration ?? 0),
    width: info.width ?? null,
    height: info.height ?? null,
    thumbnail: info.thumbnail ?? null,
    extractor: info.extractor_key ?? 'unknown',
    webpageUrl: info.webpage_url ?? url,
    viewCount: info.view_count ?? null,
    likeCount: info.like_count ?? null,
  };
}

/**
 * Transcode a file to fit a byte budget.
 *
 * Bitrate is derived from the budget and duration rather than guessed at, and
 * audio is pinned at 96 kbps so the video track gets everything else. H.264 and
 * AAC in MP4 because that is what every Discord client plays inline.
 *
 * @param {string} source Input file.
 * @param {string} target Output file.
 * @param {number} durationSec
 * @param {number} budgetBytes
 * @returns {Promise<string>} The output path.
 */
async function transcodeToFit(source, target, durationSec, budgetBytes) {
  const audioKbps = 96;
  const totalKbps = (budgetBytes * 8) / Math.max(durationSec, 1) / 1000;
  // Leave 8% headroom for container overhead and rate-control overshoot.
  const videoKbps = Math.max(150, Math.floor((totalKbps - audioKbps) * 0.92));

  await run('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-i', source,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${Math.floor(videoKbps * 1.4)}k`,
    '-bufsize', `${videoKbps * 2}k`,
    // Cap the long edge: short-form video is watched small, and pixels spent on
    // 4K resolution are pixels not spent on avoiding blocking artefacts.
    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
    '-c:a', 'aac', '-b:a', `${audioKbps}k`,
    '-movflags', '+faststart',
    target,
  ]);

  return target;
}

/**
 * Download a video and make it fit the guild's upload limit.
 *
 * @param {string} url Source link.
 * @param {string} directory Working directory.
 * @param {number} limitBytes Guild upload limit.
 * @returns {Promise<{filePath: string, info: object, transcoded: boolean}>}
 * @throws {Error} If the clip is too long or cannot be fetched.
 */
export async function fetchClip(url, directory, limitBytes) {
  await mkdir(directory, { recursive: true });

  const info = await probe(url);
  if (info.durationSec > MAX_DURATION_SEC) {
    throw new Error(
      `That clip is ${Math.round(info.durationSec / 60)} minutes long; `
      + `the limit for embedding is ${MAX_DURATION_SEC / 60}.`,
    );
  }

  const stamp = Date.now().toString(36);
  const base = path.join(directory, `clip-${stamp}`);

  // Ask yt-dlp for something already under the limit where possible; the
  // fallbacks accept progressively worse options rather than failing.
  const budgetMB = Math.floor(limitBytes / 1024 / 1024);
  await run(YTDLP_BIN, [
    '--quiet', '--no-warnings', '--no-playlist',
    '-f', `best[ext=mp4][filesize<${budgetMB}M]/best[ext=mp4]/best`,
    '--merge-output-format', 'mp4',
    '-o', `${base}.%(ext)s`,
    url,
  ]);

  // yt-dlp picks the extension, so find what it actually produced.
  const produced = (await readdir(directory))
    .filter((name) => name.startsWith(`clip-${stamp}`))
    .map((name) => path.join(directory, name));
  if (produced.length === 0) throw new Error('Nothing was downloaded.');

  let filePath = produced[0];
  let size = (await stat(filePath)).size;
  let transcoded = false;

  if (size > limitBytes) {
    const target = `${base}-fit.mp4`;
    await transcodeToFit(filePath, target, info.durationSec, limitBytes);
    await unlink(filePath).catch(() => {});
    filePath = target;
    size = (await stat(filePath)).size;
    transcoded = true;

    if (size > limitBytes) {
      await unlink(filePath).catch(() => {});
      throw new Error(
        'That clip is too large for this server even after compressing. '
        + 'Boosting the server raises the upload limit.',
      );
    }
  }

  return { filePath, info, transcoded, sizeBytes: size };
}

/**
 * Delete a downloaded clip. Safe to call more than once.
 *
 * @param {string} filePath
 */
export async function discard(filePath) {
  if (filePath) await unlink(filePath).catch(() => {});
}
