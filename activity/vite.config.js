import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';

const CACHE_DIR = path.resolve('cache');

/**
 * Serves the analysed scores in `cache/` to the development harness.
 *
 * `preview.html` runs a visualisation against real analysis rather than
 * synthetic lanes, which matters: hand-written lanes are smooth and periodic,
 * and a renderer can look perfectly good on them while falling apart on the
 * spiky, uneven data an actual track produces.
 *
 * Development only. It is a `configureServer` hook, so it exists in `vite dev`
 * and has no equivalent in the production build - the Node server never exposes
 * the cache directory.
 */
function previewScores() {
  return {
    name: 'kam-preview-scores',
    configureServer(server) {
      server.middlewares.use('/preview/scores', async (request, response, next) => {
        try {
          const name = decodeURIComponent(request.url.replace(/^\//, '').split('?')[0]);
          response.setHeader('Content-Type', 'application/json');

          if (!name) {
            const files = (await readdir(CACHE_DIR))
              .filter((f) => /^(youtube|soundcloud)-.*\.json$/.test(f))
              .sort();
            response.end(JSON.stringify(files));
            return;
          }

          // Resolved and re-checked rather than trusting the URL: this reads
          // from disk on request, so a traversal would serve arbitrary files.
          const target = path.resolve(CACHE_DIR, name);
          if (path.dirname(target) !== CACHE_DIR || !name.endsWith('.json')) {
            response.statusCode = 403;
            response.end('{"error":"outside the cache directory"}');
            return;
          }
          response.end(await readFile(target, 'utf8'));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

/**
 * The client is built from `client/` and served by the Node server. The dev
 * proxy forwards API calls so the Activity works identically in `vite dev`
 * and in production.
 */
export default defineConfig({
  root: 'client',
  envDir: '..',
  plugins: [previewScores()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The harness is a development tool and is deliberately not part of the
    // shipped Activity, so only `index.html` is an entry point.
    rollupOptions: { input: 'client/index.html' },
  },
});
