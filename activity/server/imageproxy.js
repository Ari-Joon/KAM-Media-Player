/**
 * Bounded allowlisted image retrieval for the Discord Activity proxy.
 *
 * Redirects are handled manually because `redirect: 'follow'` validates only
 * the first URL: an allowlisted CDN could otherwise redirect the server to an
 * internal address. The response is streamed into a capped buffer so a missing
 * or dishonest Content-Length cannot exhaust server memory.
 */

const IMAGE_HOSTS = new Set([
  'cdn.discordapp.com',
  'i.ytimg.com',
  'yt3.ggpht.com',
  'i1.sndcdn.com',
  'i.sndcdn.com',
  'is1-ssl.mzstatic.com',
]);

const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ImageProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ImageProxyError';
    this.status = status;
  }
}

/** Parse and enforce the external-image allowlist. */
function allowedUrl(value, base = undefined) {
  let parsed;
  try {
    parsed = new URL(value, base);
  } catch {
    throw new ImageProxyError(400, 'Invalid image URL.');
  }
  if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.has(parsed.hostname)) {
    throw new ImageProxyError(403, 'Image host is not allowed.');
  }
  return parsed;
}

/**
 * Fetch one small image, revalidating every redirect destination.
 *
 * @param {string} source
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{body: Buffer, contentType: string}>}
 */
export async function fetchProxiedImage(source, fetchImpl = fetch) {
  let target = allowedUrl(source);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const upstream = await fetchImpl(target, { redirect: 'manual' });

    if (REDIRECT_STATUSES.has(upstream.status)) {
      if (redirects === MAX_REDIRECTS) {
        throw new ImageProxyError(502, 'Too many image redirects.');
      }
      const location = upstream.headers.get('location');
      if (!location) throw new ImageProxyError(502, 'Image redirect had no location.');
      target = allowedUrl(location, target);
      continue;
    }

    if (!upstream.ok) throw new ImageProxyError(upstream.status, 'Image fetch failed.');

    const contentType = (upstream.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new ImageProxyError(415, 'Upstream response is not an image.');
    }

    const declared = Number(upstream.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
      throw new ImageProxyError(413, 'Image is too large.');
    }

    const chunks = [];
    let total = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_IMAGE_BYTES) {
          throw new ImageProxyError(413, 'Image is too large.');
        }
        chunks.push(bytes);
      }
    }

    return { body: Buffer.concat(chunks, total), contentType };
  }

  throw new ImageProxyError(502, 'Image redirect failed.');
}
