/**
 * Client for the persistent Python analyser worker.
 *
 * Replaces spawning a process per track. Measured on a four-minute file:
 * 9-10 seconds per subprocess versus 2.3-3.4 seconds in an already-warm process,
 * the difference being numba JIT work that is not cached across processes and was
 * therefore paid again on every single track.
 *
 * Requests are queued and served one at a time. Analysis is CPU-bound, so running
 * two at once would only make both slower; the queue also means a burst of
 * `/play` commands cannot spawn unbounded work.
 *
 * The worker is restarted automatically if it exits, and any in-flight request is
 * rejected rather than left hanging.
 *
 * ## Why the caller runs two of these
 *
 * Transcription takes 10-30 seconds; the provisional score that ends a blank
 * stage takes 0.21. One worker serves one request at a time, so a transcription
 * that had already *started* held every new track behind it however the queue
 * was ordered - and one is in flight through roughly the first half-minute of
 * every uncached track, which is exactly when somebody skips.
 *
 * `server.js` therefore runs a second instance for lyrics alone. The two
 * processes do compete for CPU, which is why the priorities below still exist:
 * they order work *within* a worker. What the split buys is that the short,
 * latency-critical pass never waits on the long one at all.
 */

import { spawn } from 'node:child_process';

/** How long a single analysis may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * Order queued work runs in. Lower goes first.
 *
 * All three passes shared one FIFO chain, which meant the pass that ends a
 * blank stage queued behind the pass that nobody is waiting for. The
 * provisional score is 0.21s of work and is the only thing standing between a
 * new track and its first frame; the lyrics pass is 10-30s of work that
 * upgrades a score already on screen. Starting a new track while a
 * transcription was queued therefore held the stage blank for the whole
 * transcription.
 *
 * Note this can only reorder work that has not started. A transcription
 * already running still has to finish - the Python worker handles one request
 * at a time and there is no cancellation in the protocol.
 */
const PRIORITY = { quick: 0, full: 1, lyrics: 2 };

export class AnalyserWorker {
  /**
   * @param {object} options
   * @param {string} options.pythonBin Python executable.
   * @param {string} options.visualcorePath Directory to put on PYTHONPATH.
   * @param {string} [options.label] Log prefix. There is more than one worker
   *   now, and two processes both announcing themselves as `[analyser]` makes
   *   the boot log unreadable at exactly the moment it matters.
   */
  constructor({ pythonBin, visualcorePath, label = 'analyser' }) {
    this.pythonBin = pythonBin;
    this.visualcorePath = visualcorePath;
    this.label = label;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    /**
     * Work waiting to run, highest priority first.
     *
     * A queue rather than a promise chain, because a chain can only ever be
     * appended to and the whole point is letting a provisional score overtake a
     * transcription that is merely queued.
     *
     * @type {{priority: number, seq: number, run: Function,
     *   resolve: Function, reject: Function}[]}
     */
    this.queue = [];
    /** True while one request is in flight: analysis is CPU-bound. */
    this.running = false;
    /** Arrival counter, so equal priorities stay first-come-first-served. */
    this.seq = 0;
    this.ready = false;
  }

  /** Start the worker if it is not already running. */
  start() {
    if (this.child) return;

    this.child = spawn(this.pythonBin, ['-u', '-m', 'visualcore.worker'], {
      env: { ...process.env, PYTHONPATH: this.visualcorePath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (text) console.log(`[${this.label}] ${text}`);
      if (text.includes('worker ready')) this.ready = true;
    });

    this.child.on('error', (error) => {
      console.error(`[${this.label}] failed to start:`, error.message);
      this.failAll(error);
    });

    this.child.on('exit', (code) => {
      console.error(`[${this.label}] worker exited (${code}); it will restart on next use.`);
      this.child = null;
      this.ready = false;
      this.failAll(new Error('Analyser worker exited.'));
    });
  }

  /**
   * Accumulate stdout and dispatch complete lines.
   *
   * Responses are large - a full-track score is several hundred kilobytes - so
   * they arrive across many chunks and must be reassembled by line rather than
   * parsed per chunk.
   */
  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Resolve or reject the request a response line belongs to. */
  dispatch(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      console.error(`[${this.label}] unparseable response:`, error.message);
      return;
    }

    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    this.pending.delete(response.id);
    clearTimeout(waiter.timer);

    if (response.ok) waiter.resolve(response.score);
    else waiter.reject(new Error(response.error ?? 'Analysis failed.'));
  }

  /** Reject every outstanding request, e.g. after the worker dies. */
  failAll(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Analyse an audio file.
   *
   * @param {string} audioPath Local audio file.
   * @param {object} track Track descriptor, for the score's source block.
   * @param {number|null} [quickSeconds] Analyse only this much of the opening,
   *   for a provisional score that returns in a fraction of the time.
   * @param {boolean} [withLyrics] Also transcribe the vocals. Slow, so this is
   *   requested as a separate final pass rather than with the first analysis.
   * @returns {Promise<object>} The VisualScore.
   */
  analyse(audioPath, track, quickSeconds = null, withLyrics = false) {
    // Queued rather than parallelised: CPU-bound work gains nothing from
    // overlap, and a burst of /play commands cannot spawn unbounded work.
    const priority = withLyrics
      ? PRIORITY.lyrics
      : quickSeconds !== null ? PRIORITY.quick : PRIORITY.full;

    return new Promise((resolve, reject) => {
      this.queue.push({
        priority,
        seq: this.seq++,
        resolve,
        reject,
        run: () => this.send(audioPath, track, quickSeconds, withLyrics),
      });
      this.drain();
    });
  }

  /**
   * Take the highest-priority queued request, oldest first within a priority.
   *
   * @returns {object|null}
   */
  takeNext() {
    if (this.queue.length === 0) return null;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const candidate = this.queue[i];
      const current = this.queue[best];
      if (candidate.priority < current.priority
        || (candidate.priority === current.priority && candidate.seq < current.seq)) {
        best = i;
      }
    }
    return this.queue.splice(best, 1)[0];
  }

  /** Run queued work, one request at a time. */
  drain() {
    if (this.running) return;
    const next = this.takeNext();
    if (!next) return;

    this.running = true;
    // A rejection is delivered to that caller only; the queue must keep going
    // or one failed analysis would strand every request behind it forever.
    next.run().then(next.resolve, next.reject).finally(() => {
      this.running = false;
      this.drain();
    });
  }

  /** Issue one request. @returns {Promise<object>} */
  send(audioPath, track, quickSeconds = null, withLyrics = false) {
    this.start();
    if (!this.child) {
      return Promise.reject(new Error(`The ${this.label} worker is unavailable.`));
    }

    const id = this.nextId++;
    const request = {
      id,
      audio: audioPath,
      provider: track.provider,
      providerId: track.providerId,
      title: track.title,
      duration: track.durationSec,
      quick: quickSeconds,
      lyrics: withLyrics,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Analysis timed out.'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Stop the worker. */
  stop() {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = null;
  }
}
