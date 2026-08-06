/**
 * Discord Activity client.
 *
 * Responsibilities, in order:
 *   1. Authenticate with Discord via the Embedded App SDK.
 *   2. Ask the server what this voice channel is currently playing.
 *   3. Mirror the voice player's authoritative position and transport state.
 *   4. Drive the visualiser from an interpolated playback clock.
 *
 * The browser never receives raw audio. The server-side voice player transmits
 * it to Discord, while this client renders only the pre-computed score.
 */

import { DiscordSDK } from '@discord/embedded-app-sdk';
import { Transport } from './transport.js';
import { VISUALS } from './registry.js';

/**
 * Interface font choices.
 *
 * Deliberately restricted to stacks that resolve on Windows, macOS and Linux
 * without downloading anything: a webfont inside the Activity sandbox is another
 * external request to be blocked, and a missing font silently falls back to
 * something arbitrary.
 */
const UI_FONTS = [
  // Stacks only - no webfonts. A font file is another external request, and the
  // Activity sandbox blocks those; a missing webfont also falls back to
  // something arbitrary rather than to the intended alternative.
  { id: 'sans', name: 'Sans (default)', stack: 'var(--sans)' },
  { id: 'georgia', name: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'futura', name: 'Futura', stack: '"Futura", "Century Gothic", "Avant Garde", "Trebuchet MS", sans-serif' },
  { id: 'mono', name: 'Monospace', stack: 'var(--mono)' },
  { id: 'helvetica', name: 'Helvetica', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'garamond', name: 'Garamond', stack: '"EB Garamond", Garamond, "Palatino Linotype", Palatino, serif' },
  { id: 'baskerville', name: 'Baskerville', stack: 'Baskerville, "Libre Baskerville", "Times New Roman", serif' },
  { id: 'optima', name: 'Optima', stack: 'Optima, Candara, "Gill Sans", "Gill Sans MT", sans-serif' },
  { id: 'verdana', name: 'Verdana', stack: 'Verdana, Geneva, Tahoma, sans-serif' },
  { id: 'tahoma', name: 'Tahoma', stack: 'Tahoma, Verdana, Geneva, sans-serif' },
  { id: 'palatino', name: 'Palatino', stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
  { id: 'trebuchet', name: 'Trebuchet', stack: '"Trebuchet MS", "Lucida Grande", Tahoma, sans-serif' },
  { id: 'courier', name: 'Courier', stack: '"Courier New", Courier, "Nimbus Mono PS", monospace' },
  { id: 'rounded', name: 'Rounded', stack: '"Segoe UI Variable", "SF Pro Rounded", Nunito, var(--sans)' },
  { id: 'condensed', name: 'Condensed', stack: '"Roboto Condensed", "Arial Narrow", "Segoe UI Semibold", var(--sans)' },
];


const SCALE_STORAGE_KEY = 'kam.uiScale';
const FONT_STORAGE_KEY = 'kam.uiFont';
const FONT_SIZE_STORAGE_KEY = 'kam.uiFontSize';

/**
 * Selectable text sizes in points.
 *
 * Fine steps of 2 through the range people actually read at, then coarser steps
 * of 4 above 20 where a single point stops being perceptible. A plain linear
 * slider would spend most of its travel on sizes nobody picks.
 */
const FONT_SIZES = [
  8, 10, 12, 14, 16, 18, 20,
  24, 28, 32, 36, 40,
];

/**
 * Close every overlay panel and menu.
 *
 * The visualisation picker, the interface settings, the queue and the favourites
 * all live at screen edges and several overlap. Making them mutually exclusive
 * is simpler and more predictable than trying to lay four panels out so they
 * never collide.
 */
function closeAllOverlays() {
  for (const id of ['visual-menu', 'settings-menu', 'queue-panel', 'fav-panel',
    'playlist-panel', 'track-menu']) {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  }
  document.getElementById('t-queue')?.classList.remove('active');
}

/**
 * Where an error came from, short enough to sit in the on-screen notice.
 *
 * A message alone is not enough to act on. "Cannot read properties of undefined
 * (reading 'x')" was reported from a real session and could not be reproduced
 * afterwards - 1040 cold starts across every cached score, at four playback
 * positions and four cast sizes, with track changes throughout, all clean. The
 * console is unavailable inside the Discord client, so without the location in
 * the notice itself there is nothing to go on but the message.
 *
 * Built from the stack rather than logged, because the person who sees the
 * failure is not the person with devtools open - they are usually the same
 * person, in an iframe, with no way to open them.
 *
 * @param {Error} error
 * @returns {string} Something like `(stickmen.js:3421)`, or an empty string.
 */
function originOf(error) {
  const frame = String(error?.stack ?? '').split('\n')[1] ?? '';
  // Matches both `at Foo.bar (http://host/file.js:12:34)` and the bare
  // `at http://host/file.js:12:34` that minified builds produce.
  const at = frame.match(/([\w.-]+\.js):(\d+):\d+/);
  return at ? `(${at[1]}:${at[2]})` : '';
}

/** Read a stored preference, tolerating storage being unavailable. */
function readStored(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a stored preference, tolerating storage being unavailable. */
function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisting is acceptable; the session still works.
  }
}

/**
 * Wire the interface size and font controls.
 *
 * Both are applied by setting two custom properties on the root element, so
 * every chrome rule picks them up without knowing they are adjustable. Like the
 * visualisation choice, these are per-viewer and never sent to the server.
 */
function setupInterfaceSettings(closeOthers) {
  const button = document.getElementById('settings-button');
  const menu = document.getElementById('settings-menu');
  const slider = document.getElementById('ui-scale');
  const readout = document.getElementById('ui-scale-value');
  const sizeSlider = document.getElementById('ui-size');
  const sizeReadout = document.getElementById('ui-size-value');
  const fontList = document.getElementById('ui-fonts');

  const applyScale = (percent) => {
    // Stored and displayed as a percentage, applied as a ratio. Zero is allowed
    // deliberately: it hides the chrome entirely for a completely clean view.
    const ratio = percent / 100;
    document.documentElement.style.setProperty('--ui-scale', String(ratio));
    readout.textContent = `${percent}%`;
    slider.value = String(percent);
    writeStored(SCALE_STORAGE_KEY, String(percent));
  };

  const applyFont = (id) => {
    const font = UI_FONTS.find((candidate) => candidate.id === id) ?? UI_FONTS[0];
    document.documentElement.style.setProperty('--ui-font', font.stack);
    for (const item of fontList.children) {
      item.classList.toggle('active', item.dataset.id === font.id);
    }
    writeStored(FONT_STORAGE_KEY, font.id);
  };

  for (const font of UI_FONTS) {
    const item = document.createElement('button');
    item.dataset.id = font.id;
    item.textContent = font.name;
    // Preview in the font itself, which is the only useful way to choose one.
    item.style.fontFamily = font.stack;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      applyFont(font.id);
    });
    fontList.append(item);
  }

  const applySize = (points) => {
    document.documentElement.style.setProperty('--ui-size', `${points}px`);
    sizeReadout.textContent = `${points}px`;
    sizeSlider.value = String(FONT_SIZES.indexOf(points));
    writeStored(FONT_SIZE_STORAGE_KEY, String(points));
  };

  // The slider indexes the table rather than carrying the value directly, which
  // is what gives uneven steps from a native range input.
  sizeSlider.min = '0';
  sizeSlider.max = String(FONT_SIZES.length - 1);
  sizeSlider.step = '1';
  sizeSlider.addEventListener('input', () => applySize(FONT_SIZES[Number(sizeSlider.value)]));
  sizeSlider.addEventListener('click', (event) => event.stopPropagation());

  slider.addEventListener('input', () => applyScale(Number(slider.value)));
  slider.addEventListener('click', (event) => event.stopPropagation());
  menu.addEventListener('click', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    closeOthers?.();
    menu.hidden = !opening;
  });

  // Older builds stored a ratio; anything at or below 3 is one of those.
  const storedScale = Number(readStored(SCALE_STORAGE_KEY, '100'));
  applyScale(storedScale <= 3 ? Math.round(storedScale * 100) : storedScale);
  applyFont(readStored(FONT_STORAGE_KEY, 'sans'));

  const storedSize = Number(readStored(FONT_SIZE_STORAGE_KEY, '14'));
  applySize(FONT_SIZES.includes(storedSize) ? storedSize : 14);

  return menu;
}
import { PlaybackClock } from './clock.js';

const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

/**
 * Authenticate the Activity with Discord.
 *
 * @returns {Promise<object>} The authenticated user and access token.
 * @throws {Error} If Discord rejects the authorisation.
 */
async function authenticate() {
  await discordSdk.ready();

  const { code } = await discordSdk.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });

  // The client secret never reaches the browser; the server does the exchange.
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error('Discord sign-in failed.');

  const { access_token: accessToken } = await response.json();
  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  // The token is kept, not discarded. Every request that changes something is
  // now signed with it and verified server-side - previously the server took
  // the client's word for who was calling.
  return { auth, accessToken };
}

/**
 * Fetch what this voice channel is playing, and its score.
 *
 * @returns {Promise<object|null>} `{ track, score }`, or null if idle.
 */
async function fetchNowPlaying(userId = null) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const response = await fetch(`/api/now-playing/${discordSdk.channelId}${query}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Server returned ${response.status}.`);
  return response.json();
}

/**
 * Poll until the server reports a track with a finished score.
 *
 * Two waits are folded into one loop: for someone to run /play, and for the
 * background analysis of a new track to complete. Audio is already playing
 * during the second, which is why the status distinguishes them.
 *
 * @returns {Promise<object>} The now-playing payload, score included.
 */
async function fetchScore(attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`/api/score/${discordSdk.channelId}`);
      if (response.ok) return response.json();
      // 404 means analysis has not finished; anything else is worth retrying.
      if (response.status === 404) return null;
    } catch {
      // Network hiccup - fall through to the retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  return null;
}

/**
 * Poll until a track is playing and its score is ready.
 *
 * The score arrives from its own endpoint rather than inside the state payload,
 * so polling stays cheap enough not to disturb audio transmission.
 *
 * @returns {Promise<{state: object, score: object}>}
 */
async function waitForScore(intervalMs = 1500) {
  let failures = 0;
  let waited = 0;

  for (;;) {
    try {
      const state = await fetchNowPlaying();
      failures = 0;
      if (state?.scoreId) {
        const score = await fetchScore();
        if (score) return { state, score };
      }
      // Report elapsed time so a genuinely slow analysis looks like progress
      // rather than a hang. Full-track DSP takes 15-25 seconds on first play.
      setStatus(state
        ? `Analysing the track for visuals\u2026 ${Math.round(waited / 1000)}s`
        : 'Nothing playing. Run /play in this channel.');
    } catch (error) {
      failures += 1;
      // Two consecutive failures means the server is gone, not busy. Saying so
      // is far more useful than an indefinite "analysing" message.
      if (failures >= 2) {
        setStatus('Cannot reach the visualiser server. Check that `npm start` is '
          + 'still running and that the tunnel hostname matches the URL mapping.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    waited += intervalMs;
  }
}

/** Write a message into the unobtrusive notice strip. @param {string} message */
/**
 * Until when the notice is holding an important message.
 *
 * The poll loop calls `setNotice` every 600ms to show or clear "Analysing new
 * track", which meant any message written by anything else survived for at most
 * half a second. A render failure therefore announced itself and was wiped
 * before it could be read - which is precisely why a visualisation that dies
 * has been so hard to diagnose from inside the Discord client, where there is
 * no console to fall back on.
 */
let noticeHeldUntil = 0;

/**
 * Write a message into the notice strip.
 *
 * @param {string} message
 * @param {number} [holdMs] Keep it for at least this long, ignoring routine
 *   traffic from the poll loop.
 */
function setNotice(message, holdMs = 0) {
  const now = Date.now();
  if (holdMs > 0) {
    noticeHeldUntil = now + holdMs;
  } else if (now < noticeHeldUntil) {
    // Something more important is on screen; routine updates wait their turn.
    return;
  }
  const notice = document.getElementById('notice');
  notice.textContent = message;
  notice.hidden = !message;
}

/** Write a message into the status strip. @param {string} message */
function setStatus(message) {
  document.getElementById('status').textContent = message;
}

/**
 * True when the page was launched by Discord as an Activity.
 *
 * Detected from the query parameters Discord appends on launch - `frame_id` and
 * `instance_id` are always present and cannot appear if somebody simply opens
 * the tunnel URL. An earlier version compared `window.self` to `window.top`,
 * which was wrong: the desktop client can host an Activity where those are
 * equal, so the landing page appeared over a working Activity.
 *
 * @returns {boolean}
 */
function isLaunchedByDiscord() {
  const params = new URLSearchParams(window.location.search);
  return params.has('frame_id') || params.has('instance_id');
}

/** Replace the stage with an explanatory landing page for direct visitors. */
function showLandingPage() {
  setStatus('');
  document.getElementById('landing').hidden = false;
  document.body.classList.add('landing-mode');
}

async function main() {
  if (!isLaunchedByDiscord()) {
    showLandingPage();
    return;
  }

  const canvas2d = document.getElementById('stage-2d');

  /**
   * Instantiate visualisations lazily.
   *
   * Building all seven up front would create several canvas contexts and a WebGL
   * program nobody asked for. Each is made the first time it is chosen and then
   * kept, so switching back is instant.
   */
  const instances = new Map();
  const getVisual = (entry) => {
    if (!instances.has(entry.id)) {
      instances.set(entry.id, entry.make(canvas2d));
    }
    return instances.get(entry.id);
  };

  // Drop anything this client cannot render, so the menu never offers a broken
  // option. WebGL is the real risk: Discord can run with it unavailable.
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

  if (available.length === 0) {
    setStatus('No visualisation could start. Try enabling hardware acceleration '
      + "in Discord's settings.");
    return;
  }

  // The choice is per-viewer and never sent to the server, so two people in the
  // same voice channel can watch entirely different visuals of one track. Only
  // playback is shared, because only playback needs to agree.
  const settingsMenu = setupInterfaceSettings(closeAllOverlays);
  // Painter is the default for a first-time viewer.
  //
  // The fallback used to be `available[0]`, which is the "None" entry - so
  // anyone opening the Activity for the first time got a blank stage and had to
  // discover the menu before seeing anything at all. Painter is the better
  // introduction: it starts from an empty canvas and fills in as the track
  // plays, so the first thing a new viewer sees is the Activity visibly doing
  // something with their music.
  //
  // Every open starts here, not just a viewer's first.
  //
  // The last choice used to be restored from localStorage and always won, so
  // anyone who had once picked something else never saw the default again -
  // including on a reload or a reset, which is exactly when the app should be
  // showing its face. Switching during a session still works; it simply does
  // not outlive the session.
  //
  // `available` is still the guard: if Painter somehow failed to construct it
  // is not in the list, and the first working entry is used instead.
  const DEFAULT_VISUAL = 'painter';
  let currentId = available.some((entry) => entry.id === DEFAULT_VISUAL)
    ? DEFAULT_VISUAL
    : available[0].id;

  const menuButton = document.getElementById('visual-button');
  const menu = document.getElementById('visual-menu');

  /**
   * Show a visualisation.
   *
   * @param {string} id
   * @param {boolean} [byUser] True when a person chose it from the menu, as
   *   opposed to the render guard substituting one.
   */
  const selectVisual = (id, byUser = false) => {
    const entry = available.find((candidate) => candidate.id === id);
    if (!entry) return;
    // Choosing something deliberately always gives it another chance. A
    // visualisation disabled earlier in the session stayed disabled until the
    // page was reloaded, so picking it from the menu appeared to do nothing -
    // the guard simply substituted another one again, and the menu looked
    // broken rather than the renderer.
    if (byUser) {
      failed.delete(id);
      strikes.delete(id);
    }
    currentId = id;
    canvas2d.hidden = false;
    menuButton.textContent = entry.name;
    for (const item of menu.children) {
      item.classList.toggle('active', item.dataset.id === id);
    }
  };

  for (const entry of available) {
    const item = document.createElement('button');
    item.dataset.id = entry.id;
    item.textContent = entry.name;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      selectVisual(entry.id, true);
      menu.hidden = true;
    });
    menu.append(item);
  }

  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    // Opening one overlay closes the others; several of these occupy the same
    // corner and were drawing on top of each other.
    const opening = menu.hidden;
    closeAllOverlays();
    menu.hidden = !opening;
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
    settingsMenu.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    menu.hidden = true;
    settingsMenu.hidden = true;
  });

  selectVisual(currentId);

  /**
   * Render the selected visualisation, surviving errors.
   *
   * A single exception inside a renderer used to escape the animation frame
   * callback and stop the loop permanently - the visuals "just died" and only a
   * reload brought them back. Now a failing visualisation is reported once,
   * dropped from the menu and replaced, so the stage keeps moving.
   */
  const failed = new Set();
  /** The canvas the current visualisation draws into. */
  const visualCanvas = () => canvas2d;

  /**
   * Consecutive failures per visualisation.
   *
   * One bad frame is not a broken visualisation. Several renderers throw on
   * their very first frame after being selected - state that only exists once
   * the first frame has run - and disabling on a single exception meant the
   * viewer was thrown to another visualisation and had to choose theirs twice.
   * A run of failures is a real fault; one is a hiccup, and the frame it spoiled
   * is already gone.
   */
  const strikes = new Map();
  const STRIKES_BEFORE_DISABLING = 3;

  const visualizer = {
    render: (...args) => {
      const entry = available.find((candidate) => candidate.id === currentId);
      if (!entry) return;
      try {
        getVisual(entry).render(...args);
        // A frame that worked clears the count, so occasional failures far
        // apart never accumulate into a disablement.
        if (strikes.has(entry.id)) strikes.delete(entry.id);
      } catch (error) {
        const count = (strikes.get(entry.id) ?? 0) + 1;
        strikes.set(entry.id, count);
        console.error(`${entry.name} threw (${count}/${STRIKES_BEFORE_DISABLING}):`, error);
        if (count < STRIKES_BEFORE_DISABLING) {
          // Named even when it is survivable. The console is unavailable inside
          // the Discord client, so a fault that recovers by itself would
          // otherwise never be reportable - and a renderer that throws on every
          // first frame is still a bug worth fixing, even when nobody sees it.
          if (count === 1) {
            setNotice(`${entry.name} hiccuped: ${error.message ?? error} ${originOf(error)}`,
              12_000);
          }
          return;
        }

        if (!failed.has(entry.id)) {
          failed.add(entry.id);
          console.error(`${entry.name} failed and was disabled:`, error);
          // Shown, not only logged. An Activity runs in an iframe inside the
          // Discord client, where the console is disabled by default - so a
          // visualisation that dies has, until now, been able to say nothing
          // at all to the one person who can see it happen.
          // Held, so the poll loop cannot wipe it before it is read.
          setNotice(`${entry.name} failed: ${error.message ?? error} ${originOf(error)}`, 25_000);
        }
        // Never fall back to "None".
        //
        // `available` is in menu order and "None" is first, so the first entry
        // that had not failed was always the one that draws nothing - a crash
        // in any visualisation dropped the viewer onto a blank stage that looks
        // exactly like a second, worse bug. The default is tried first, then any
        // working visualisation, and "None" only ever by choosing it.
        const replacement = available.find(
          (candidate) => candidate.id === DEFAULT_VISUAL && !failed.has(candidate.id),
        ) ?? available.find(
          (candidate) => candidate.id !== 'none' && !failed.has(candidate.id),
        );
        if (replacement && replacement.id !== currentId) selectVisual(replacement.id);
      }
    },
  };

  try {
    setStatus('Connecting to Discord');
    const { auth, accessToken } = await authenticate();

    setStatus('Connecting');
    const { state: initial, score } = await waitForScore();

    setStatus('');
    document.body.classList.add('playing');

    // The server transmits the audio, so its reported position is measured
    // rather than estimated. The clock interpolates between polls purely for
    // smoothness - drift is corrected against the server, never accumulated.
    // The authenticated user is passed through so favourites can be attributed
    // and show the right avatar.
    const viewer = {
      id: auth?.user?.id ?? null,
      username: auth?.user?.global_name ?? auth?.user?.username ?? null,
      avatar: auth?.user?.avatar ?? null,
    };
    const transport = new Transport(
      discordSdk.channelId, discordSdk.guildId, viewer, undefined, accessToken,
    );
    // Held long enough to read and no longer. The poll loop clears the notice
    // whenever the analysing state changes, so a message with no hold of its
    // own can be wiped within 600ms - which is how an earlier diagnostic
    // vanished before anyone saw it.
    transport.notify = (message) => setNotice(message, 4000);
    for (const instance of instances.values()) instance.setTrack?.(initial.track);
    transport.update(initial);
    document.getElementById('transport').hidden = false;

    let serverPosition = initial.positionSec;
    let playing = initial.playing;
    let currentScore = score;
    let currentScoreId = initial.scoreId;
    let currentTrackId = initial.track?.providerId;

    const clock = new PlaybackClock({
      readPosition: () => serverPosition,
      pollMs: 400,
      resyncThresholdSec: 0.20,
    });
    clock.seek(serverPosition);
    clock.play();

    const poll = async () => {
      try {
        const state = await fetchNowPlaying(viewer.id);
        if (!state) {
          playing = false;
          clock.pause();
          // The transport stays visible with nothing playing, so search,
          // favourites and the queue remain reachable. Hiding it meant the only
          // way back was a slash command in chat.
          document.getElementById('transport').hidden = false;
          document.body.classList.add('idle-transport');
          document.getElementById('queue-panel').hidden = true;
          setNotice('');
          setStatus('Nothing playing. Run /play to start a track.');
          return;
        }

        // A track change resets the clock and swaps in the new score once its
        // analysis lands; until then the previous score keeps the visuals alive
        // rather than freezing the stage.
        // Any state at all means something is playing, so clear the idle
        // message unconditionally - it previously survived until a track change,
        // and lingered over working visuals.
        document.getElementById('transport').hidden = false;

        // The queue has run out but the player is still here. The transport
        // stays, holding the play history, so the track that just finished is
        // one click away instead of needing to be searched for again.
        if (!state.track) {
          document.body.classList.add('idle-transport');
          clock.pause();
          playing = false;
          setStatus('');
          setNotice('');
          transport.update(state, 0);
          currentTrackId = null;
          return;
        }

        setStatus('');
        document.body.classList.remove('idle-transport');

        if (state.track?.providerId !== currentTrackId) {
          currentTrackId = state.track?.providerId;
          // Renderers that care about who made the track get told; the stick men
          // size their cast from it.
          for (const instance of instances.values()) {
            instance.setTrack?.(state.track);
          }
          // Snap the clock straight away so the scrub bar and visuals jump to
          // the new track rather than drifting there over the next second.
          clock.seek(state.positionSec);
          clock.play();
          transport.update(state, state.positionSec);
        }
        setNotice(state.analysing ? 'Analysing new track\u2026' : '');
        // Only refetch when the score actually changed, which is once per track.
        if (state.scoreId && state.scoreId !== currentScoreId) {
          const fresh = await fetchScore();
          if (fresh) {
            currentScore = fresh;
            currentScoreId = state.scoreId;
            setStatus('');
            setNotice('');
          }
        }

        serverPosition = state.positionSec;
        if (state.playing !== playing) {
          playing = state.playing;
          if (playing) clock.play();
          else clock.pause();
        }
        transport.update(state, clock.position);
        document.getElementById('transport').hidden = false;
      } catch {
        // A transient failure shouldn't stop the render loop; the interpolated
        // clock carries on and the next poll corrects it.
      }
    };
    setInterval(poll, 600);

    // An Activity that loads while its tab is in the background gets a canvas of
    // zero size, and nothing drawn into it survives. Watching for the element
    // actually gaining size - and for the tab becoming visible - forces a
    // redraw at that moment instead of leaving a blank stage until someone
    // closes and rejoins.
    const nudgeRenderers = () => {
      for (const instance of instances.values()) {
        try {
          instance.resize?.();
        } catch {
          // A renderer that cannot resize will be caught by the render guard.
        }
      }
    };

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(nudgeRenderers);
      observer.observe(canvas2d);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) nudgeRenderers();
    });
    window.addEventListener('focus', nudgeRenderers);

    const startedAt = performance.now();
    let lastFrameMs = performance.now();
    const frame = () => {
      const nowMs = performance.now();
      const deltaSec = Math.min((nowMs - lastFrameMs) / 1000, 0.1);
      lastFrameMs = nowMs;
      const playbackSec = clock.tick();
      // Skip while the *active* stage has no size. Checking the 2D canvas
      // unconditionally was wrong: with a WebGL visualisation selected the 2D
      // canvas is hidden and reports zero width, so Ambience never drew at all.
      const stage = visualCanvas();
      if (stage && stage.clientWidth > 0 && stage.clientHeight > 0) {
        visualizer.render(currentScore, playbackSec, (performance.now() - startedAt) / 1000);
      }
      // Scrub bar and marquee only: a full update would rebuild the queue DOM
      // every frame.
      transport.setPosition(playbackSec);
      transport.tickMarquee(deltaSec);
      transport.tickIdle(deltaSec, 0.5);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
}

/**
 * Show a fatal error on screen.
 *
 * An uncaught exception during setup previously left a blank white page with no
 * indication of what failed, which is the least debuggable possible outcome
 * inside Discord's iframe where the console is easy to miss.
 */
function showFatal(message) {
  document.body.style.background = '#07070b';
  const status = document.getElementById('status');
  if (status) status.textContent = message;
  else document.body.textContent = message;
}

window.addEventListener('error', (event) => {
  console.error('fatal:', event.error ?? event.message);
  showFatal(`Error: ${event.error?.message ?? event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('fatal (promise):', event.reason);
  showFatal(`Error: ${event.reason?.message ?? event.reason}`);
});

main().catch((error) => {
  console.error(error);
  showFatal(`Error: ${error.message}`);
});
