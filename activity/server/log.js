/**
 * Console output for the server and the launcher.
 *
 * The console is the only interface this product has while it is running. It is
 * where you find out that a tunnel died, that YouTube is refusing you, or that
 * a track failed to analyse - so what it says has to be worth reading, and the
 * things worth reading have to survive contact with everything else.
 *
 * They were not surviving. Every HTTP request printed a line, and the Activity
 * polls `/api/now-playing` roughly twice a second per viewer and fetches an
 * `/api/image` for every avatar and every piece of cover art. A quiet room with
 * one person watching produced a steady scroll of `GET /api/now-playing/... ->
 * 200 (2ms)`, and anything that actually mattered was gone from the screen
 * within seconds of being printed.
 *
 * ## What replaces it
 *
 * Routine, successful, high-frequency requests are counted rather than printed,
 * and one line a minute says how many there were. That keeps the reassurance -
 * traffic is flowing, nothing is failing - at about a six-hundredth of the
 * volume. Everything unusual still prints immediately: any failure, anything
 * slow, and anything that is not part of the polling loop.
 *
 * `LOG_LEVEL=debug` restores the per-request line, because when you are
 * debugging a request that is exactly what you want.
 */

/** Ordered loudest-last. A message prints when its level is at or below this. */
export const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = String(process.env.LOG_LEVEL ?? 'info').toLowerCase();
export const threshold = LEVELS[configured] ?? LEVELS.info;

/** Colour only for a terminal; a redirected log file should stay plain text. */
const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);

const LEVEL_STYLE = {
  error: (text) => paint('31;1', text),
  warn: (text) => paint('33', text),
  info: (text) => text,
  debug: (text) => paint('2', text),
};

/** `14:32:07`, local time. A date would be repeated on every line for nothing. */
function stamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0')).join(':');
}

/**
 * Write one line.
 *
 * The shape is `time  scope  message`, with the scope padded so messages line
 * up down the left edge - the point being that you can scan the scope column
 * for the subsystem you care about without reading anything else.
 *
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} scope Subsystem, lowercase and short: `voice`, `api`, `tunnel`.
 * @param {string} message
 */
export function write(level, scope, message) {
  if (LEVELS[level] > threshold) return;
  // The trailing space is not decoration: `padEnd(9)` alone runs a nine
  // character scope straight into its message - `licensingsoundcloud=...` -
  // and every scope name is one rename away from being that long.
  const scopeColumn = `${scope.padEnd(9)} `;
  const line = `${paint('2', stamp())}  ${paint('2', scopeColumn)}${LEVEL_STYLE[level](message)}`;
  // Anything at warn or worse goes to stderr, so that redirecting stdout to a
  // file still leaves problems visible on the terminal.
  if (LEVELS[level] <= LEVELS.warn) console.error(line);
  else console.log(line);
}

/**
 * A logger bound to one subsystem.
 *
 * @param {string} scope
 */
export function logger(scope) {
  return {
    error: (message) => write('error', scope, message),
    warn: (message) => write('warn', scope, message),
    info: (message) => write('info', scope, message),
    debug: (message) => write('debug', scope, message),
  };
}

/**
 * Paths whose successful responses are counted rather than printed.
 *
 * These are the ones the client asks for on a timer or once per image. Nothing
 * here is a user action - a person queueing a track hits `/api/queue`, which is
 * not in this list and still prints.
 */
const ROUTINE = [
  /^\/api\/now-playing\//,
  /^\/api\/score\//,
  /^\/api\/image\b/,
  /^\/healthz\b/,
  // Static assets: the bundle, the page itself, icons.
  /^\/assets\//,
  /^\/$/,
  /\.(js|css|html|png|svg|ico|woff2?)$/,
];

/** Anything slower than this prints even when it succeeded. */
export const SLOW_MS = 1000;

/**
 * Whether one finished request is worth a line of its own.
 *
 * Separated from the middleware so it can be tested directly: the whole value
 * of this file is in which requests it decides to hide, and that decision
 * should not need an HTTP server to check.
 *
 * @param {{path: string, status: number, ms: number}} request
 * @returns {{print: boolean, level: 'error'|'warn'|'info', reason: string}}
 */
export function classifyRequest({ path, status, ms }) {
  const routine = ROUTINE.some((pattern) => pattern.test(path));

  // A server fault is always worth a line, whatever the path.
  if (status >= 500) return { print: true, routine, level: 'error', reason: 'server error' };

  // A refusal on a routine path is *not* printed per request, and the reason is
  // specific: `/api/now-playing` answers 404 whenever nothing is playing, which
  // is a normal answer to a normal question. Printing 4xx here would have put a
  // warning on screen twice a second for every idle server - louder than the
  // per-request logging this replaced, which is the opposite of the point.
  //
  // They are not ignored. `TrafficSummary` counts them and says once when a
  // polling loop starts failing and once when it recovers, which is the shape
  // this information actually wants: a state change, not a stream.
  if (status >= 400 && !routine) {
    return { print: true, routine, level: 'warn', reason: 'refused' };
  }
  if (status >= 400) return { print: false, routine, level: 'warn', reason: 'routine refusal' };

  if (ms >= SLOW_MS) return { print: true, routine, level: 'warn', reason: 'slow' };
  if (routine) return { print: false, routine, level: 'info', reason: 'routine' };
  return { print: true, routine, level: 'info', reason: 'action' };
}

/**
 * Counts what was not printed and reports it periodically.
 *
 * One line a minute rather than one per request, and nothing at all during a
 * minute with no traffic - an idle server should produce an idle console.
 */
export class TrafficSummary {
  /**
   * @param {number} everyMs How often to report.
   * @param {(message: string) => void} emit
   */
  constructor(everyMs = 60_000, emit = (message) => write('info', 'api', message)) {
    this.everyMs = everyMs;
    this.emit = emit;
    this.served = 0;
    this.failed = 0;
    this.slowest = 0;
    /** @type {'ok'|'failing'} */
    this.pollState = 'ok';
  }

  /**
   * @param {{status: number, ms: number, routine?: boolean}} request
   */
  record({ status, ms, routine = false }) {
    this.served += 1;
    if (status >= 400) this.failed += 1;
    if (ms > this.slowest) this.slowest = ms;
    if (routine) this.trackHealth(status);
  }

  /**
   * Say once when the polling loop starts failing, and once when it recovers.
   *
   * A 404 from `/api/now-playing` is normal - nothing is playing. A 401 or 403
   * on every poll is not, and it is invisible in a per-request stream because
   * it looks like all the other lines. Reported as a transition so it is one
   * line either way, no matter how long it lasts.
   *
   * 404 is excluded from the unhealthy set for the reason above; a run of them
   * is what an idle server looks like.
   */
  trackHealth(status) {
    const bad = status >= 400 && status !== 404;
    if (bad && this.pollState !== 'failing') {
      this.pollState = 'failing';
      write('warn', 'api', `the Activity's polling is being refused (${status})`);
      return;
    }
    if (!bad && this.pollState === 'failing') {
      this.pollState = 'ok';
      write('info', 'api', 'polling recovered');
    }
  }

  /** Emit a summary if anything happened, and reset. */
  flush() {
    if (this.served === 0) return null;
    const parts = [`${this.served} request${this.served === 1 ? '' : 's'}`];
    if (this.failed > 0) parts.push(`${this.failed} failed`);
    parts.push(`slowest ${this.slowest}ms`);
    const message = parts.join(', ');
    this.served = 0;
    this.failed = 0;
    this.slowest = 0;
    this.emit(message);
    return message;
  }

  /** Start reporting. The timer never holds the process open. */
  start() {
    this.timer = setInterval(() => this.flush(), this.everyMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Express middleware that applies the policy above.
 *
 * A factory rather than inline in `server.js` so it can be mounted on a bare
 * express app and fired at with real requests. The first attempt to check this
 * end to end started the real server with a deliberately invalid bot token,
 * fired 51 requests at it and saw no output - which looked like a pass and was
 * nothing of the kind: the process had already exited on the bad token and
 * every request had failed to connect. A test that cannot tell "correctly
 * silent" from "not running" is worse than no test.
 *
 * @param {TrafficSummary} summary
 */
export function requestLogger(summary) {
  return (request, response, next) => {
    const startedAt = Date.now();
    response.on('finish', () => {
      const ms = Date.now() - startedAt;
      const status = response.statusCode;
      const { print, level, routine } = classifyRequest({ path: request.path, status, ms });
      summary.record({ status, ms, routine });
      if (!print) return;
      write(level, 'api', `${request.method} ${request.originalUrl} -> ${status} (${ms}ms)`);
    });
    next();
  };
}

/**
 * What to do with one line of a child process's output.
 *
 * The launcher pipes the server and the tunnel into one console, which is the
 * right idea and the reason it is pleasant to run - but it piped *everything*.
 * cloudflared alone prints a dozen informational lines before it is ready and
 * re-registers its connections periodically for the rest of the session, none
 * of which anybody reads.
 *
 * Errors and warnings always pass. Informational lines from the tunnel pass
 * only if they are one of the few worth seeing. The server is already logging
 * through this module and is left alone.
 *
 * @param {string} label Which child produced the line.
 * @param {string} line
 * @returns {{show: boolean, level: 'error'|'warn'|'info'}}
 */
export function classifyChildLine(label, line) {
  if (threshold >= LEVELS.debug) return { show: true, level: 'info' };
  if (label !== 'tunnel') return { show: true, level: 'info' };

  if (/\bERR\b|\bERROR\b|ERR_NGROK|authentication failed|failed to/i.test(line)) {
    return { show: true, level: 'error' };
  }
  if (/\bWRN\b|\bWARN\b|retrying|unregistered|connection.*lost/i.test(line)) {
    return { show: true, level: 'warn' };
  }

  // The few informational lines that say something a person acts on.
  const worthwhile = [
    /trycloudflare\.com/i,          // the assigned address
    /started tunnel/i,              // ngrok's equivalent
    /registered tunnel connection/i, // first proof it is actually up
  ];
  if (worthwhile.some((pattern) => pattern.test(line))) {
    return { show: true, level: 'info' };
  }
  return { show: false, level: 'info' };
}
