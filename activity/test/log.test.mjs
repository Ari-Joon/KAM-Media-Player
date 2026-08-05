/**
 * Console policy: what gets printed, and what gets counted instead.
 *
 * The value of the logging layer is entirely in what it *hides*, so these are
 * mostly assertions that something does not print - and, just as importantly,
 * that the things which must never be hidden still are not.
 */
import assert from 'node:assert/strict';
import {
  classifyRequest, classifyChildLine, TrafficSummary, requestLogger, SLOW_MS,
} from '../server/log.js';

let passed = 0;
const check = (name, run) => { run(); passed += 1; };

// --- Requests --------------------------------------------------------------

check('the polling loop is counted, not printed', () => {
  // These are the three that made the console unreadable: the Activity polls
  // now-playing about twice a second per viewer, fetches the score on every
  // track change, and asks for an image per avatar and per piece of cover art.
  for (const path of ['/api/now-playing/123', '/api/score/123', '/api/image', '/healthz']) {
    assert.equal(classifyRequest({ path, status: 200, ms: 3 }).print, false, path);
  }
});

check('static assets are counted too', () => {
  for (const path of ['/', '/assets/index-abc123.js', '/index.html', '/icon.png']) {
    assert.equal(classifyRequest({ path, status: 200, ms: 5 }).print, false, path);
  }
});

check('a user action still prints', () => {
  // Nothing here happens on a timer - each one is somebody pressing something,
  // and seeing it is how you follow what a room is doing.
  for (const path of ['/api/queue/123', '/api/playlists/9', '/api/search', '/api/control/1']) {
    assert.equal(classifyRequest({ path, status: 200, ms: 10 }).print, true, path);
  }
});

check('a server fault always prints, however routine the path', () => {
  const broken = classifyRequest({ path: '/api/image', status: 500, ms: 2 });
  assert.equal(broken.print, true);
  assert.equal(broken.level, 'error');
});

check('an idle server does not warn twice a second', () => {
  // `/api/now-playing` answers 404 whenever nothing is playing, and the
  // Activity polls it about twice a second. Printing 4xx on routine paths -
  // which the first draft of this did - puts a warning on screen every 500ms
  // for a server that is behaving perfectly, which is louder than the
  // per-request logging it replaced.
  assert.equal(classifyRequest({ path: '/api/now-playing/1', status: 404, ms: 2 }).print, false);
  assert.equal(classifyRequest({ path: '/api/now-playing/1', status: 403, ms: 2 }).print, false);
});

check('a refusal off the polling path still prints', () => {
  const refused = classifyRequest({ path: '/api/queue/1', status: 403, ms: 2 });
  assert.equal(refused.print, true);
  assert.equal(refused.level, 'warn');
});

check('polling health is reported as a transition, not a stream', () => {
  const lines = [];
  const summary = new TrafficSummary(60_000, () => {});
  const spy = [];
  // `trackHealth` writes through the module's own `write`, so the transition
  // is observed through the state it leaves behind rather than the text.
  for (let i = 0; i < 20; i += 1) summary.record({ status: 404, ms: 1, routine: true });
  assert.equal(summary.pollState, 'ok', '404 while idle is not a failure');

  summary.record({ status: 403, ms: 1, routine: true });
  assert.equal(summary.pollState, 'failing');
  for (let i = 0; i < 20; i += 1) summary.record({ status: 403, ms: 1, routine: true });
  assert.equal(summary.pollState, 'failing', 'still one transition, not twenty');

  summary.record({ status: 200, ms: 1, routine: true });
  assert.equal(summary.pollState, 'ok');
  assert.equal(lines.length + spy.length, 0);
});

check('a slow success prints even on a routine path', () => {
  const slow = classifyRequest({ path: '/api/now-playing/1', status: 200, ms: SLOW_MS });
  assert.equal(slow.print, true);
  assert.equal(slow.level, 'warn');
  assert.equal(classifyRequest({ path: '/api/now-playing/1', status: 200, ms: SLOW_MS - 1 }).print, false);
});

// --- The summary -----------------------------------------------------------

check('a quiet minute says nothing at all', () => {
  const lines = [];
  const summary = new TrafficSummary(60_000, (message) => lines.push(message));
  assert.equal(summary.flush(), null);
  assert.equal(lines.length, 0);
});

check('a busy minute is one line, and resets', () => {
  const lines = [];
  const summary = new TrafficSummary(60_000, (message) => lines.push(message));
  for (let i = 0; i < 148; i += 1) summary.record({ status: 200, ms: 3 });
  summary.record({ status: 500, ms: 42 });
  summary.flush();

  assert.equal(lines.length, 1);
  assert.match(lines[0], /149 requests/);
  assert.match(lines[0], /1 failed/);
  assert.match(lines[0], /slowest 42ms/);

  // Reset, or every later minute would report the whole session.
  assert.equal(summary.flush(), null);
});

check('one request is not "1 requests"', () => {
  const lines = [];
  const summary = new TrafficSummary(60_000, (message) => lines.push(message));
  summary.record({ status: 200, ms: 1 });
  summary.flush();
  assert.match(lines[0], /1 request,/);
});

// --- Child process output --------------------------------------------------

check('routine tunnel chatter is dropped', () => {
  const noise = [
    '2026-08-05T20:11:04Z INF Thank you for trying Cloudflare Tunnel.',
    '2026-08-05T20:11:04Z INF Version 2024.8.2',
    '2026-08-05T20:11:04Z INF GOOS: windows, GOVersion: go1.22',
    '2026-08-05T20:11:05Z INF Initial protocol quic',
    '2026-08-05T20:11:05Z INF ICMP proxy will use 192.168.1.5 as source for IPv4',
    '2026-08-05T20:11:06Z INF Updated to new configuration config="{}" version=1',
  ];
  for (const line of noise) {
    assert.equal(classifyChildLine('tunnel', line).show, false, line);
  }
});

check('the address and the proof it is up still come through', () => {
  const keep = [
    '2026-08-05T20:11:05Z INF |  https://odd-word-pair.trycloudflare.com  |',
    '2026-08-05T20:11:06Z INF Registered tunnel connection connIndex=0',
  ];
  for (const line of keep) {
    assert.equal(classifyChildLine('tunnel', line).show, true, line);
  }
});

check('tunnel trouble is never hidden', () => {
  const bad = [
    ['2026-08-05T20:11:07Z ERR Failed to serve tunnel connection', 'error'],
    ['2026-08-05T20:11:07Z WRN Retrying connection in up to 2s', 'warn'],
    ['ERR_NGROK_121 the agent is too old', 'error'],
    ['authentication failed', 'error'],
  ];
  for (const [line, level] of bad) {
    const verdict = classifyChildLine('tunnel', line);
    assert.equal(verdict.show, true, line);
    assert.equal(verdict.level, level, line);
  }
});

check('the server is never filtered', () => {
  // It logs through this module already, so it arrives having made its own
  // decision about what is worth saying.
  assert.equal(classifyChildLine('server', 'anything at all').show, true);
});

// --- End to end, against a real server -------------------------------------
//
// The unit checks above decide what *should* print. This mounts the actual
// middleware on a real express app and fires real requests at it, because the
// first attempt to verify this end to end was silent for the wrong reason - the
// server under test had exited and nothing had connected at all.

const express = (await import('express')).default;

const captured = [];
const realLog = console.log;
const realError = console.error;
console.log = (...args) => captured.push(args.join(' '));
console.error = (...args) => captured.push(args.join(' '));

const summary = new TrafficSummary(60_000, (message) => captured.push(`SUMMARY ${message}`));
const app = express();
app.use(requestLogger(summary));
app.get('/api/now-playing/:id', (request, response) => response.status(404).json({}));
app.get('/api/image', (request, response) => response.json({}));
app.get('/api/queue/:id', (request, response) => response.json({}));

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://localhost:${server.address().port}`;

let landed = 0;
for (let i = 0; i < 25; i += 1) {
  const response = await fetch(`${base}/api/now-playing/1`);
  if (response.status === 404) landed += 1;
  await response.arrayBuffer();
}
for (let i = 0; i < 25; i += 1) await (await fetch(`${base}/api/image`)).arrayBuffer();
const action = await fetch(`${base}/api/queue/1`);
await action.arrayBuffer();

console.log = realLog;
console.error = realError;
server.close();

// The check that the previous attempt was missing: prove the traffic was real
// before drawing any conclusion from the silence.
assert.equal(landed, 25, 'the requests under test never reached the server');
assert.equal(action.status, 200);
passed += 1;

const requestLines = captured.filter((line) => / -> \d\d\d /.test(line));
assert.equal(requestLines.length, 1,
  `50 polls and one action should print one line, got:\n${requestLines.join('\n')}`);
assert.match(requestLines[0], /\/api\/queue\/1 -> 200/);
passed += 1;

summary.flush();
assert.ok(captured.some((line) => line.startsWith('SUMMARY 51 requests')),
  'the hidden traffic should still be counted');
passed += 1;

console.log(`log policy: ${passed}/${passed} pass (routine hidden, failures kept, summary, tunnel noise, end to end)`);
