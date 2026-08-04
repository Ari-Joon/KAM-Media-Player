import assert from 'node:assert/strict';
import { AnalyserWorker } from '../server/analyser.js';

/**
 * Queue ordering, with the Python worker stubbed out.
 *
 * The regression this covers: all three analysis passes shared one FIFO chain,
 * so a 10-30s lyrics transcription queued ahead of the 0.21s provisional score
 * that is the only thing standing between a new track and its first frame. The
 * stage stayed blank for the whole transcription.
 */
const track = { provider: 'youtube', providerId: 'abc', title: 'T' };

/** A worker whose requests resolve when the test says so, recording order. */
function stubbed() {
  const worker = new AnalyserWorker({ pythonBin: 'x', visualcorePath: 'y' });
  const started = [];
  const gates = [];
  worker.send = (audioPath, _track, quickSeconds, withLyrics) => {
    const label = withLyrics ? 'lyrics' : quickSeconds !== null ? 'quick' : 'full';
    started.push(`${label}:${audioPath}`);
    return new Promise((resolve, reject) => gates.push({ resolve, reject, label }));
  };
  return { worker, started, gates };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// --- a queued transcription must not delay a new track's provisional score ---
{
  const { worker, started, gates } = stubbed();

  // Track A: full analysis runs, then its lyrics pass is queued behind it.
  worker.analyse('a.wav', track);
  await settle();
  assert.deepEqual(started, ['full:a.wav'], 'the first request starts immediately');

  worker.analyse('a.wav', track, null, true);          // lyrics, queued
  // Track B starts while that transcription is still waiting its turn.
  worker.analyse('b.wav', track, 45);                  // provisional
  worker.analyse('b.wav', track);                      // full
  await settle();
  assert.deepEqual(started, ['full:a.wav'], 'nothing overlaps the running request');

  // Track A's full analysis finishes and the queue picks what runs next.
  gates[0].resolve({});
  await settle();
  assert.deepEqual(started.at(-1), 'quick:b.wav',
    'the provisional score overtook the queued transcription');

  gates[1].resolve({});
  await settle();
  assert.deepEqual(started.at(-1), 'full:b.wav', 'then the full analysis');

  gates[2].resolve({});
  await settle();
  assert.deepEqual(started.at(-1), 'lyrics:a.wav', 'the transcription runs last');
  console.log('analyser priority: 6/6 pass (provisional overtakes transcription)');
}

// --- equal priorities stay first-come-first-served ---------------------------
{
  const { worker, started, gates } = stubbed();
  worker.analyse('first.wav', track, 45);
  await settle();
  worker.analyse('second.wav', track, 45);
  worker.analyse('third.wav', track, 45);
  await settle();

  gates[0].resolve({});
  await settle();
  assert.equal(started[1], 'quick:second.wav', 'same priority keeps arrival order');
  gates[1].resolve({});
  await settle();
  assert.equal(started[2], 'quick:third.wav');
  console.log('analyser fairness: 2/2 pass (equal priorities stay FIFO)');
}

// --- a failure must not strand everything behind it --------------------------
{
  const { worker, started, gates } = stubbed();
  const failing = worker.analyse('bad.wav', track, 45);
  await settle();
  const following = worker.analyse('good.wav', track, 45);

  gates[0].reject(new Error('worker exited'));
  await assert.rejects(failing, /worker exited/, 'the failure reaches its own caller');
  await settle();
  assert.equal(started[1], 'quick:good.wav', 'the queue carried on after a failure');

  gates[1].resolve({ ok: true });
  assert.deepEqual(await following, { ok: true }, 'and the next request still resolves');
  console.log('analyser resilience: 3/3 pass (one failure does not strand the queue)');
}
