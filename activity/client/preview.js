/**
 * Development harness for the visualisations.
 *
 * The Activity cannot be opened outside Discord: `main.js` constructs a
 * `DiscordSDK` at module scope and authenticates before anything is drawn, so
 * there is no way to look at a visualisation without a bot, a tunnel and a voice
 * channel. That makes iterating on how something *looks* extremely slow.
 *
 * This page renders one visualisation directly against a real analysed score
 * from `cache/`, with its own transport. No Discord, no server, no audio
 * pipeline - though a local audio file can be attached, and is then kept in sync
 * with the same clock the renderer reads, which is the only way to judge whether
 * motion actually lands on the music.
 *
 * Development only: it is not an entry point in the production build.
 */

import { VISUALS } from './registry.js';

const stage = document.getElementById('stage');
const canvas2d = document.getElementById('canvas2d');
const shaderCanvas = document.getElementById('shader');
const visualSelect = document.getElementById('visual');
const scoreSelect = document.getElementById('score');
const playButton = document.getElementById('play');
const seek = document.getElementById('seek');
const readout = document.getElementById('readout');
const audioInput = document.getElementById('audio');
const artInput = document.getElementById('art');
const castSelect = document.getElementById('cast');
const errorBox = document.getElementById('err');

const showError = (message) => {
  errorBox.textContent = message;
  errorBox.style.display = message ? 'block' : 'none';
};

/** Instantiated lazily and kept, exactly as the Activity does. */
const instances = new Map();
const getVisual = (entry) => {
  if (!instances.has(entry.id)) {
    const canvas = entry.mode === 'webgl' ? shaderCanvas : canvas2d;
    instances.set(entry.id, entry.make(canvas));
  }
  return instances.get(entry.id);
};

const available = VISUALS.filter((entry) => {
  try {
    getVisual(entry);
    return true;
  } catch (error) {
    console.warn(`${entry.name} unavailable:`, error.message);
    instances.delete(entry.id);
    return false;
  }
});

for (const entry of available) {
  const option = document.createElement('option');
  option.value = entry.id;
  option.textContent = entry.name;
  visualSelect.append(option);
}

// --- State -----------------------------------------------------------------

let score = null;
let currentId = new URLSearchParams(location.search).get('v')
  ?? localStorage.getItem('kam.preview.visual')
  ?? 'stickmen';
if (!available.some((entry) => entry.id === currentId)) currentId = available[0].id;
visualSelect.value = currentId;

let position = 0;
let playing = false;
let duration = 0;
let audio = null;
/** Stand-in track, so `setTrack` consumers have something to read. */
let track = { providerId: 'preview', title: 'Preview', thumbnail: null, performerCount: null };

const entryFor = (id) => available.find((candidate) => candidate.id === id);
const activeCanvas = () => (entryFor(currentId)?.mode === 'webgl' ? shaderCanvas : canvas2d);

function selectVisual(id) {
  currentId = id;
  visualSelect.value = id;
  localStorage.setItem('kam.preview.visual', id);
  const entry = entryFor(id);
  shaderCanvas.hidden = entry.mode !== 'webgl';
  canvas2d.hidden = entry.mode === 'webgl';
  // Newly revealed canvases have just gained size, and the renderers measure
  // lazily now, so they have to be told.
  for (const instance of instances.values()) instance.resize?.();
}

function applyTrack() {
  for (const instance of instances.values()) instance.setTrack?.(track);
}

const clock = (seconds) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// --- Scores ----------------------------------------------------------------

async function loadScoreList() {
  const files = await (await fetch('/preview/scores')).json();
  for (const file of files) {
    const option = document.createElement('option');
    option.value = file;
    // The provider prefix and schema suffix are noise when scanning a list.
    option.textContent = file.replace(/\.json$/, '');
    scoreSelect.append(option);
  }
  return files;
}

async function loadScore(file) {
  const loaded = await (await fetch(`/preview/scores/${encodeURIComponent(file)}`)).json();
  score = loaded;
  // The track's real length lives on `source`, not `analysis` - the field read
  // here was `analysis.duration_sec`, which the schema does not define, so this
  // always silently fell through to the analysed length. That is the same
  // number for a full analysis but the *preview window* for a partial one, so
  // the harness timeline for a partial score was 30 seconds against a
  // three-minute track, and anything paced on position - the Painter above all
  // - was judged against the wrong clock.
  duration = score.source?.duration_sec
    ?? score.analysis?.analysed_duration_sec
    ?? (score.lanes.frame_count / score.lanes.fps);
  position = 0;
  if (audio) audio.currentTime = 0;

  const performers = castSelect.value ? Number(castSelect.value) : null;
  track = {
    providerId: file,
    title: file,
    thumbnail: track.thumbnail,
    performerCount: performers,
  };
  applyTrack();
  showError('');
}

// --- Transport -------------------------------------------------------------

function setPlaying(next) {
  playing = next;
  playButton.textContent = playing ? 'Pause' : 'Play';
  playButton.classList.toggle('on', playing);
  if (!audio) return;
  if (playing) audio.play().catch(() => {});
  else audio.pause();
}

playButton.addEventListener('click', () => setPlaying(!playing));

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'SELECT' || event.target.tagName === 'INPUT') return;
  if (event.code === 'Space') {
    event.preventDefault();
    setPlaying(!playing);
  }
  // Arrow keys scrub, which is the fastest way to check that motion is locked
  // to the score rather than running on its own clock.
  if (event.code === 'ArrowRight') seekTo(position + (event.shiftKey ? 10 : 2));
  if (event.code === 'ArrowLeft') seekTo(position - (event.shiftKey ? 10 : 2));
});

function seekTo(seconds) {
  position = Math.min(duration, Math.max(0, seconds));
  if (audio) audio.currentTime = position;
}

seek.addEventListener('input', () => {
  seekTo((Number(seek.value) / 1000) * duration);
});

visualSelect.addEventListener('change', () => selectVisual(visualSelect.value));
scoreSelect.addEventListener('change', () => loadScore(scoreSelect.value).catch(
  (error) => showError(`Could not load score: ${error.message}`),
));

castSelect.addEventListener('change', () => {
  track = { ...track, performerCount: castSelect.value ? Number(castSelect.value) : null };
  applyTrack();
});

audioInput.addEventListener('change', () => {
  const file = audioInput.files?.[0];
  if (!file) return;
  if (audio) audio.pause();
  audio = new Audio(URL.createObjectURL(file));
  audio.addEventListener('loadedmetadata', () => {
    // The audio is authoritative once attached: a score analysed from a
    // different encode of the same track can be a fraction of a second out, and
    // following the audio keeps what is heard and what is drawn together.
    if (Number.isFinite(audio.duration)) duration = audio.duration;
  });
  audio.currentTime = position;
  if (playing) audio.play().catch(() => {});
});

artInput.addEventListener('change', () => {
  const file = artInput.files?.[0];
  if (!file) return;
  track = { ...track, thumbnail: URL.createObjectURL(file) };
  applyTrack();
});

// --- Frame loop ------------------------------------------------------------

if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(() => {
    for (const instance of instances.values()) instance.resize?.();
  });
  observer.observe(canvas2d);
  observer.observe(shaderCanvas);
}

const failed = new Set();
let lastMs = performance.now();
const startedAt = performance.now();

function frame() {
  const now = performance.now();
  const deltaSec = Math.min(Math.max((now - lastMs) / 1000, 0), 0.1);
  lastMs = now;

  if (playing) {
    // The attached audio element is the clock when there is one, exactly as the
    // voice player is in the real Activity - so what is drawn cannot drift away
    // from what is being heard.
    position = audio && !audio.paused ? audio.currentTime : position + deltaSec;
    if (position >= duration && duration > 0) {
      position = 0;
      if (audio) audio.currentTime = 0;
    }
  }

  const target = activeCanvas();
  if (score && target && target.clientWidth > 0 && target.clientHeight > 0) {
    const entry = entryFor(currentId);
    if (entry && !failed.has(entry.id)) {
      try {
        getVisual(entry).render(score, position, (now - startedAt) / 1000);
      } catch (error) {
        failed.add(entry.id);
        showError(`${entry.name} threw:\n${error.stack ?? error.message}`);
        console.error(error);
      }
    }
  }

  if (duration > 0) {
    seek.value = String(Math.round((position / duration) * 1000));
    readout.textContent = `${clock(position)} / ${clock(duration)}`
      + `   ${(1 / Math.max(deltaSec, 1e-6)).toFixed(0)} fps`;
  }
  requestAnimationFrame(frame);
}

(async () => {
  try {
    selectVisual(currentId);
    const files = await loadScoreList();
    if (files.length === 0) {
      showError('No analysed scores in cache/. Play a track through the bot first.');
    } else {
      scoreSelect.value = files[0];
      await loadScore(files[0]);
    }
  } catch (error) {
    showError(`Harness failed to start: ${error.message}`);
    console.error(error);
  }
  requestAnimationFrame(frame);
})();

void stage;
