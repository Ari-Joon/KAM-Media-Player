/**
 * Transport controls for the Activity.
 *
 * Sits over the visualiser and drives the server, which is the single source of
 * truth for playback. Nothing here holds authoritative state: every control
 * posts an action and re-renders from the snapshot that comes back, so two
 * people in the same voice channel can never disagree about what is playing.
 *
 * The scrub bar is the one place that needs care. While a user is dragging, the
 * incoming server position must be ignored - otherwise the handle fights the
 * poll and jumps backwards under the cursor. Dragging therefore latches a local
 * value, and the server is told once on release.
 */

import { PlaylistPanel, TrackMenu } from './playlists.js';

/**
 * Route an external image through this origin.
 *
 * Discord's Activity sandbox blocks direct loads from external hosts, so avatars
 * and cover art must come back through the server that served the page.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
function proxied(url) {
  return url ? `/api/image?url=${encodeURIComponent(url)}` : null;
}

/**
 * What a row hands to the right-click menu.
 *
 * Identity and a title, nothing else. The menu never needs a descriptor - every
 * action it offers goes back to the server, which holds the real one - and
 * putting a full track in an attribute would mean the DOM carrying a copy of
 * every list on the page.
 *
 * @param {object} track
 * @returns {string}
 */
function menuTrack(track) {
  return JSON.stringify({
    provider: track.provider,
    providerId: track.providerId,
    title: track.title,
    // Carried so the menu can offer a way back to the playlist a queued track
    // came from. Only the label and the key, never its contents.
    ...(track.source ? { source: track.source } : {}),
  });
}

/**
 * A circular badge showing someone's initial.
 *
 * Used when no avatar is available - older favourites predate avatar capture,
 * and a missing image should still say who added the track.
 *
 * @param {string|undefined} username
 * @returns {HTMLElement}
 */
function initialBadge(username) {
  const badge = document.createElement('span');
  badge.className = 'avatar initial';
  badge.textContent = (username ?? '?').slice(0, 1).toUpperCase();
  // Deterministic hue from the name, so a given person is always the same
  // colour rather than flickering between renders.
  let hash = 0;
  for (const character of username ?? '?') hash = (hash * 31 + character.charCodeAt(0)) % 360;
  badge.style.background = `hsl(${hash}, 62%, 42%)`;
  return badge;
}

/**
 * Whether a drag carries favourites from this app.
 *
 * `dataTransfer.getData` is deliberately blocked by the browser until the drop,
 * so the type list is the only thing readable while a drag is in progress -
 * which is enough to stop a file dragged in from the desktop lighting up the
 * queue panel as though it could be dropped there.
 *
 * @param {DragEvent} event
 * @returns {boolean}
 */
function isFavouriteDrag(event) {
  const types = event.dataTransfer?.types;
  // `types` is an array in modern browsers but a DOMStringList in older ones;
  // borrowing `includes` handles both without allocating per dragover.
  if (!types) return false;
  const has = (type) => Array.prototype.includes.call(types, type);
  // A queue row being reordered is also a drag the panel must accept, or the
  // insertion indicator never appears and there is nothing to aim at.
  return has('application/json') || has('application/x-kam-reorder');
}

/**
 * Make an element a drag source for the queue.
 *
 * The queue's drop handler already understands one payload - a JSON array of
 * track identities, or an object naming a playlist - so anything that can
 * produce one can be dragged into the queue. This exists so search results,
 * recently played and the playlists panel gain the gesture by calling one
 * function, rather than by four copies of the favourites drag drifting apart.
 *
 * `body.dragging-favourites` is what docks the queue panel to the left while a
 * drag is in progress. Both panels are pinned to the right edge and are
 * mutually exclusive, so without it the drop target is never visible and the
 * gesture is impossible rather than merely awkward.
 *
 * @param {HTMLElement} element
 * @param {() => object} payload Built at drag start, not before.
 * @param {string} label Shown as the drag's plain-text flavour.
 */
function makeQueueDragSource(element, payload, label) {
  element.draggable = true;
  element.addEventListener('dragstart', (event) => {
    // A drag that begins on a control belongs to that control. Without this,
    // pressing into the playlist name field and moving the pointer starts a
    // drag of the whole card instead of selecting text, and the field cannot
    // be edited with the mouse at all.
    if (event.target.closest?.('input, textarea, button, select')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/json', JSON.stringify(payload()));
    // Plain text as well, so dragging out of the app into a text field or
    // another window produces something a person recognises.
    event.dataTransfer.setData('text/plain', label);
    document.body.classList.add('dragging-favourites');
  });
  element.addEventListener('dragend', () => {
    document.body.classList.remove('dragging-favourites');
  });
}

/**
 * Keyboard shortcuts, as data.
 *
 * One table drives both the handler and the reference panel. Written as two
 * lists that had to be kept in step, the panel would eventually describe keys
 * that no longer do what it says - and a shortcuts sheet that lies is worse
 * than none, because it is believed.
 *
 * Unmodified keys only. Discord's client claims many combinations for itself,
 * and an Activity that fought it over ctrl-K would lose in a way nobody could
 * debug from inside the iframe.
 *
 * @type {{keys: string[], label: string, run: (t: Transport, event: KeyboardEvent) => void}[]}
 */
const SHORTCUTS = [
  { keys: [' '], label: 'Play or pause', show: 'Space', run: (t) => t.send('toggle') },
  {
    keys: ['ArrowLeft'],
    label: 'Back 5 seconds, or 30 with shift',
    show: '←',
    run: (t, event) => t.nudge(event.shiftKey ? -30 : -5),
  },
  {
    keys: ['ArrowRight'],
    label: 'Forward 5 seconds, or 30 with shift',
    show: '→',
    run: (t, event) => t.nudge(event.shiftKey ? 30 : 5),
  },
  { keys: ['n'], label: 'Next track', show: 'N', run: (t) => t.send('next') },
  { keys: ['p'], label: 'Previous track', show: 'P', run: (t) => t.send('previous') },
  { keys: ['f'], label: 'Favourite this track', show: 'F', run: (t) => t.toggleFavourite() },
  { keys: ['q'], label: 'Show or hide the queue', show: 'Q', run: (t) => t.elements.queueButton.click() },
  { keys: ['l'], label: 'Cycle loop mode', show: 'L', run: (t) => t.send('loop') },
  { keys: ['s'], label: 'Shuffle the queue', show: 'S', run: (t) => t.send('shuffle') },
  {
    keys: ['/'],
    label: 'Search for a track',
    show: '/',
    // The key would otherwise be typed into the box it just opened.
    run: (t, event) => { event.preventDefault(); t.elements.searchButton.click(); },
  },
  { keys: ['?'], label: 'Show this list', show: '?', run: (t) => t.toggleShortcuts() },
  { keys: ['Escape'], label: 'Close any panel', show: 'Esc', run: (t) => t.closeEverything() },
];

/**
 * Whether a keystroke belongs to something being typed into.
 *
 * A shortcut that fires while someone is naming a playlist would rename it to
 * fragments and pause the music halfway through the word.
 *
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isTyping(target) {
  const element = /** @type {HTMLElement|null} */ (target);
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

/** Format seconds as m:ss. */
function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/**
 * Loop presentation.
 *
 * Each mode gets its own glyph *and* its own word. A single repeat icon cannot
 * distinguish looping one track from looping the whole queue, so the state was
 * effectively invisible - the label is what makes it readable.
 */
/**
 * Height of the wake zone at the bottom of the frame, as a fraction.
 *
 * Generous enough to reach for without aiming, small enough that watching the
 * middle of the visualisation leaves the bar hidden.
 */
const HOT_ZONE_FRACTION = 0.28;

const LOOP_STATES = {
  off: { glyph: '\u{1F501}', label: 'loop off', title: 'Loop: off (click for track)' },
  track: { glyph: '\u{1F502}', label: 'loop track', title: 'Loop: this track (click for queue)' },
  queue: { glyph: '\u{1F501}', label: 'loop queue', title: 'Loop: the whole queue (click to turn off)' },
};

export class Transport {
  /**
   * @param {string} channelId Voice channel the Activity is running in.
   * @param {(state: object) => void} [onState] Called after every server reply.
   */
  constructor(channelId, guildId, user, onState, accessToken = null) {
    this.channelId = channelId;
    this.guildId = guildId;
    /**
     * The viewer.
     *
     * Used for display only. Attribution is settled server-side from the access
     * token below - anything this object claims is treated as decoration, since
     * the client is exactly who cannot be trusted to say who the client is.
     */
    this.user = user;
    /** Signs every request that changes something. */
    this.accessToken = accessToken;
    this.favourited = false;
    this.onState = onState;
    this.dragging = false;
    this.dragValue = 0;
    this.durationSec = 0;
    // Last values written to the scrub bar and elapsed label, so the per-frame
    // update can skip the DOM when nothing has actually changed.
    this.lastFillWidth = null;
    this.lastElapsed = null;

    /**
     * Favourites view state.
     *
     * `sort` orders the flat list; `folder` restricts it to one person. Both are
     * client-side, so two viewers can browse the same shared list differently.
     */
    this.favView = { sort: 'latest', folder: null, query: '', expanded: new Set() };
    /** Track keys currently selected in the favourites panel. */
    this.favSelection = new Set();
    /**
     * Selected queue positions, for removing several at once.
     *
     * Absolute positions from the server rather than display indices: the queue
     * changes underneath while the panel is open, and an index would come to
     * mean a different track than the one that was clicked.
     *
     * @type {Set<number>}
     */
    this.queueSelection = new Set();
    /** Last row touched, so shift-click has something to extend from. */
    this.queueAnchor = null;
    /**
     * Playlist blocks the viewer has opened out in the queue.
     *
     * Client state, like the visualisation choice: two people looking at the
     * same queue can have different blocks expanded, and neither should move
     * the other's panel.
     *
     * @type {Set<string>}
     */
    this.expandedGroups = new Set();
    /** Row index anchoring a shift-click range. */
    this.favAnchor = null;
    /** How many tracks the in-flight drag carries, shown on the indicator. */
    this.dragCount = 0;
    this.favCache = { favourites: [], contributors: [] };

    /**
     * Queue-panel drop state.
     *
     * `dropRows` caches each row's geometry for the length of a drag so that
     * `dragover` - which fires continuously - costs arithmetic rather than a
     * layout flush. `dropSlot` is the gap the indicator is currently pointing
     * at, kept so the element is only written when the pointer crosses a row
     * boundary.
     */
    this.dropRows = null;
    this.dropSlot = null;
    this.dropIndicator = null;
    /** Absolute queue positions of the rendered rows, for mapping a drop. */
    this.queuePositions = [];

    /** Marquee state for long titles. */
    this.marquee = { offset: 0, paused: 0, overflow: 0, text: '' };

    /**
     * Visibility state.
     *
     * The bar is shown only while the pointer is over the bottom of the frame,
     * rather than on any activity anywhere. Hiding is still suppressed while a
     * panel is open or the scrub handle is being dragged - a control vanishing
     * mid-interaction is worse than one that lingers.
     */
    this.hideTimer = null;
    this.pointerInside = false;
    this.pointerNear = false;

    this.root = document.getElementById('transport');
    this.elements = {
      previous: document.getElementById('t-prev'),
      toggle: document.getElementById('t-toggle'),
      next: document.getElementById('t-next'),
      stop: document.getElementById('t-stop'),
      shuffle: document.getElementById('t-shuffle'),
      loop: document.getElementById('t-loop'),
      queueButton: document.getElementById('t-queue'),
      queueLabel: document.getElementById('t-queue-label'),
      loopLabel: document.getElementById('t-loop-label'),
      scrub: document.getElementById('t-scrub'),
      fill: document.getElementById('t-fill'),
      elapsed: document.getElementById('t-elapsed'),
      total: document.getElementById('t-total'),
      title: document.getElementById('t-title'),
      titleWindow: document.getElementById('t-title-window'),
      artist: document.getElementById('t-artist'),
      panel: document.getElementById('queue-panel'),
      list: document.getElementById('queue-list'),
      close: document.getElementById('queue-close'),
      fav: document.getElementById('t-fav'),
      searchButton: document.getElementById('t-search'),
      searchPanel: document.getElementById('search-panel'),
      searchClose: document.getElementById('search-close'),
      searchInput: document.getElementById('search-input'),
      searchStatus: document.getElementById('search-status'),
      searchResults: document.getElementById('search-results'),
      favsButton: document.getElementById('t-favs'),
      favPanel: document.getElementById('fav-panel'),
      favClose: document.getElementById('fav-close'),
      favList: document.getElementById('fav-list'),
      favFilter: document.getElementById('fav-filter'),
      favSearch: document.getElementById('fav-search'),
      favSearchClear: document.getElementById('fav-search-clear'),
      favFolders: document.getElementById('fav-folders'),
      recentPanel: document.getElementById('recent-played'),
      recentList: document.getElementById('recent-list'),
      queueSelectionBar: document.getElementById('queue-selection'),
      queueSelectionCount: document.getElementById('queue-selection-count'),
      queueRemoveSelected: document.getElementById('queue-remove-selected'),
      queueClearSelection: document.getElementById('queue-clear-selection'),
      deckShuffle: document.getElementById('deck-shuffle'),
    };

    /**
     * Deck being viewed in the panel, which is deliberately independent of the
     * deck being played. Browsing someone else's playlist should not change
     * what the room is listening to.
     */
    this.viewIndex = 0;

    const missing = Object.entries(this.elements)
      .filter(([, element]) => !element)
      .map(([name]) => name);
    if (!this.root || missing.length) {
      throw new Error(
        `Transport markup missing: ${[!this.root && 'transport', ...missing]
          .filter(Boolean).join(', ')}. Run \`npm run build\` - the served `
        + 'index.html is older than the JavaScript.',
      );
    }

    /**
     * Set by the page so panels can surface a message in the shared notice
     * line. Late-bound rather than a constructor argument: the notice belongs
     * to the page, and the transport is built before the page has finished
     * deciding what to do with one.
     *
     * @type {((message: string) => void)|null}
     */
    this.notify = null;
    const notify = (message) => this.notify?.(message);

    this.playlists = new PlaylistPanel({
      guildId: this.guildId,
      authHeaders: () => this.authHeaders(),
      enqueue: (track) => this.addToQueue(track).catch((error) => notify(error.message)),
      enqueueMany: (tracks) => this.addManyToQueue(tracks).catch((error) => notify(error.message)),
      enqueuePlaylist: (which) => this.queuePlaylist(which).catch((error) => notify(error.message)),
      viewerId: this.user?.id ?? null,
      makeDragSource: makeQueueDragSource,
      notify,
    });

    this.trackMenu = new TrackMenu({
      enqueue: async (track) => {
        try {
          await this.addToQueue(track);
          notify(`Added ${track.title} to the queue.`);
        } catch (error) {
          notify(error.message);
        }
      },
      playNext: async (track) => {
        try {
          await this.playNext(track);
          notify(`${track.title} plays next.`);
        } catch (error) {
          notify(error.message);
        }
      },
      playlists: this.playlists,
      notify,
    });

    this.bind();
    this.bindShortcuts();
  }

  /** Attach listeners once. */
  bind() {
    const { previous, toggle, next, stop, shuffle, loop, queueButton, scrub, panel,
      close } = this.elements;

    previous.addEventListener('click', () => this.send('previous'));
    toggle.addEventListener('click', () => {
      // Optimistic: flip the icon immediately rather than after the round trip.
      // The request travels through a tunnel, so waiting for confirmation makes
      // a working button feel broken. The next poll corrects it if the server
      // disagreed.
      this.optimisticPaused = !this.optimisticPaused;
      toggle.textContent = this.optimisticPaused ? '\u25B6' : '\u23F8';
      this.send('toggle');
    });
    next.addEventListener('click', () => this.send('next'));
    stop.addEventListener('click', () => this.send('stop'));
    shuffle.addEventListener('click', () => this.send('shuffle'));
    loop.addEventListener('click', () => this.send('loop'));

    const setPanel = (open) => {
      // The panels share an edge, so opening one closes the others.
      if (open) {
        this.elements.favPanel.hidden = true;
        this.elements.searchPanel.hidden = true;
      }
      panel.hidden = !open;
      queueButton.classList.toggle('active', open);
    };
    queueButton.addEventListener('click', () => setPanel(panel.hidden));
    close.addEventListener('click', () => setPanel(false));

    // Escape as well as the button: at narrow window sizes the transport can be
    // clipped, and a panel with no reachable way to close it is a trap.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!panel.hidden) setPanel(false);
      if (!this.elements.favPanel.hidden) this.elements.favPanel.hidden = true;
      if (!this.elements.searchPanel.hidden) this.elements.searchPanel.hidden = true;
    });

    // Pointer events cover mouse and touch with one code path, and capture
    // keeps the drag alive if the cursor leaves the bar.
    scrub.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      scrub.setPointerCapture(event.pointerId);
      this.updateDrag(event);
    });
    scrub.addEventListener('pointermove', (event) => {
      if (this.dragging) this.updateDrag(event);
    });
    scrub.addEventListener('pointerup', (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      scrub.releasePointerCapture(event.pointerId);
      this.send('seek', Math.round(this.dragValue));
    });

    // Star toggles; long-press-free, with the panel opened by a separate route
    // so an accidental click cannot lose a favourite.
    this.elements.fav.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleFavourite();
    });
    // --- Track search -------------------------------------------------------
    this.elements.searchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = this.elements.searchPanel.hidden;
      this.closePanels();
      this.elements.searchPanel.hidden = !opening;
      if (opening) this.elements.searchInput.focus();
    });

    this.elements.searchClose.addEventListener('click', () => {
      this.elements.searchPanel.hidden = true;
    });
    this.elements.searchPanel.addEventListener('click', (event) => event.stopPropagation());

    this.elements.searchInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') this.runSearch();
      if (event.key === 'Escape') this.elements.searchPanel.hidden = true;
    });

    this.elements.favsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.elements.favPanel.hidden) {
        this.closePanels();
        this.openFavourites();
      } else {
        this.elements.favPanel.hidden = true;
      }
    });
    this.elements.favClose.addEventListener('click', () => {
      this.elements.favPanel.hidden = true;
    });

    // Deliberately not in `this.elements`, which is checked for completeness and
    // throws when anything is missing. That check exists to catch a served
    // `index.html` older than the JavaScript, and it is the right behaviour for
    // the transport's own controls - but it would mean a missing playlists
    // button taking down the player, the queue and the visualisations with it.
    // Not in `this.elements`: a missing shortcuts button must not take the
    // player down with it, for the same reason the playlists button is not.
    document.getElementById('shortcuts-button')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleShortcuts();
    });
    document.getElementById('shortcuts-panel')?.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    this.elements.queueRemoveSelected.addEventListener('click', () => this.removeSelected());
    this.elements.queueClearSelection.addEventListener('click', () => {
      this.queueSelection.clear();
      this.queueAnchor = null;
      this.queueSignature = null;
      if (this.lastDecks) this.renderDecks(this.lastDecks);
    });

    const playlistsButton = document.getElementById('t-playlists');
    playlistsButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.playlists.panel?.hidden !== false) {
        this.closePanels();
        this.playlists.open();
      } else {
        this.playlists.close();
      }
    });
    // Clicks inside must not reach the document handler that closes panels -
    // renaming a playlist means clicking into a field inside this panel.
    this.playlists.panel?.addEventListener('click', (event) => event.stopPropagation());

    // Queue panel as a drop target for favourites.
    //
    // `dragover` fires continuously while the pointer is over the panel, so it
    // does no DOM work beyond moving a single indicator element: row geometry
    // is measured once per drag and compared arithmetically thereafter. The
    // same discipline as `setPosition` - a panel that rebuilt its list on every
    // pointer move would be unusable.
    //
    // Measured in Chromium over a full 25-row panel: 0.2ms median for the first
    // dragover of a drag (the one that measures every row), 0.76us when the
    // pointer crosses a row boundary, and 0.04us for a move inside one gap -
    // which is the overwhelming majority of events. Re-measure if the row
    // markup gains anything that costs layout.
    this.elements.panel.addEventListener('dragover', (event) => {
      if (!isFavouriteDrag(event)) return;
      // Both of these are required for a drop to be accepted at all.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.elements.panel.classList.add('drop-target');
      this.updateDropTarget(event.clientY);
    });
    this.elements.panel.addEventListener('dragleave', (event) => {
      // dragleave also fires when the pointer crosses from the panel onto one
      // of its own children, so clearing unconditionally made the highlight
      // flicker at every row boundary. Only a move that genuinely leaves the
      // panel counts as leaving.
      if (this.elements.panel.contains(event.relatedTarget)) return;
      this.clearDropIndicator();
    });
    this.elements.panel.addEventListener('drop', (event) => this.handleQueueDrop(event));
    // The cached rows hold viewport coordinates, so scrolling the panel
    // mid-drag invalidates them.
    this.elements.panel.addEventListener('scroll', () => {
      this.dropRows = null;
    }, { passive: true });

    this.elements.favFilter.addEventListener('change', (event) => {
      this.favView.sort = event.target.value;
      this.renderFavourites();
    });
    this.elements.favFilter.addEventListener('click', (event) => event.stopPropagation());

    const search = this.elements.favSearch;
    search.addEventListener('input', () => {
      this.favView.query = search.value;
      this.elements.favSearchClear.hidden = search.value.length === 0;
      this.renderFavourites();
    });
    search.addEventListener('click', (event) => event.stopPropagation());
    // Escape clears the query first and only closes the panel when it is already
    // empty, so a stray press does not lose both the search and the panel.
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (search.value.length > 0) {
        event.stopPropagation();
        this.clearSearch();
      }
    });
    this.elements.favSearchClear.addEventListener('click', (event) => {
      event.stopPropagation();
      this.clearSearch();
      search.focus();
    });
    this.elements.favPanel.addEventListener('click', (event) => event.stopPropagation());

    this.elements.deckShuffle.addEventListener('click', async () => {
      await this.send('shuffleDeck', this.viewIndex);
      // Force a redraw: the reply arrives before the next poll, and watching the
      // list reorder is the point of shuffling with the panel open.
      this.queueSignature = null;
    });

    // Presence, not activity, decides visibility: the bar appears when the
    // cursor enters the lower part of the frame and leaves shortly after it
    // goes. Waking on *any* movement meant the bar flickered in and out
    // constantly while watching the visualisation.
    // Touch devices have no hover, so a bar that appears on pointer movement
    // never appears at all - which is why the Activity looked broken on a
    // phone. Detected by capability rather than by user agent, which is both
    // more reliable and correct for hybrid devices.
    this.isTouch = window.matchMedia?.('(hover: none)')?.matches
      ?? ('ontouchstart' in window);

    document.addEventListener('pointermove', (event) => {
      if (this.isTouch) return;
      const zone = window.innerHeight * HOT_ZONE_FRACTION;
      this.pointerNear = event.clientY >= window.innerHeight - zone;
      if (this.pointerNear) this.wake();
    }, { passive: true });

    // On touch, any tap on the stage reveals the controls - the standard
    // gesture for a video player, and the only one available without hover.
    document.addEventListener('touchstart', () => this.wake(), { passive: true });

    // Keyboard and clicks always wake it, so it is never unreachable.
    for (const event of ['pointerdown', 'keydown']) {
      document.addEventListener(event, () => this.wake(), { passive: true });
    }

    // Leaving the window entirely counts as leaving the zone.
    document.addEventListener('pointerleave', () => { this.pointerNear = false; });

    // Hovering the bar itself holds it open indefinitely.
    this.root.addEventListener('pointerenter', () => {
      this.pointerInside = true;
      this.wake();
    });
    this.root.addEventListener('pointerleave', () => { this.pointerInside = false; });

    // Clicking the title jumps back to the beginning and holds it there, so a
    // long name can actually be read rather than chased across the bar.
    this.elements.titleWindow.addEventListener('click', (event) => {
      event.stopPropagation();
      this.marquee.offset = 0;
      this.marquee.paused = 4;
      this.elements.title.style.transform = 'translateX(0px)';
    });

    // Clicks inside the transport must not reach the body handler that switches
    // render mode.
    this.root.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('click', (event) => event.stopPropagation());
  }

  /**
   * Headers for a request that changes something.
   *
   * @returns {Record<string, string>}
   */
  authHeaders() {
    return this.accessToken
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${this.accessToken}` }
      : { 'Content-Type': 'application/json' };
  }

  /** Convert a pointer position into a track position and paint it. */
  updateDrag(event) {
    const bounds = this.elements.scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    this.dragValue = ratio * this.durationSec;
    this.elements.fill.style.width = `${ratio * 100}%`;
    this.elements.elapsed.textContent = clock(this.dragValue);
    // This writes the bar directly, so the no-op cache in `setPosition` no
    // longer describes what is on screen. Clearing it means the first frame
    // after a drag repaints instead of believing it is already correct.
    this.invalidatePositionCache();
  }

  /** Forget what the scrub bar and elapsed label were last set to. */
  invalidatePositionCache() {
    this.lastFillWidth = null;
    this.lastElapsed = null;
  }

  /**
   * Send a control action and apply the returned snapshot.
   *
   * @param {string} action
   * @param {number|string} [value]
   */
  async send(action, value) {
    try {
      const response = await fetch(`/api/control/${this.channelId}`, {
        method: 'POST',
        headers: this.authHeaders(),
        // No userId: the server takes it from the verified token, and sending
        // one here would only invite the belief that it means something.
        body: JSON.stringify({ action, value }),
      });
      if (!response.ok) {
        // Said out loud, not swallowed. A refused control and a control that
        // did nothing look identical from here, and this silence is exactly
        // what made a stale server - one started before an action existed, so
        // answering 400 "Unknown action" - look like a broken button.
        const detail = await response.json().catch(() => ({}));
        this.notify?.(detail.error ?? `The server refused that (${response.status}).`);
        return;
      }
      const state = await response.json();
      // Any control that can reorder must invalidate the cached signatures, or
      // the panel keeps showing the previous order.
      if (['move', 'shuffle', 'shuffleDeck', 'removeTrack', 'removeTracks'].includes(action)) {
        this.queueSignature = null;
      }
      this.update(state);
      this.onState?.(state);
      return state;
    } catch {
      // The poll loop will resynchronise; a failed control press is not fatal.
    }
  }

  /**
   * Seek by a relative amount, clamped to the track.
   *
   * @param {number} bySec Negative to go back.
   */
  nudge(bySec) {
    if (!(this.durationSec > 0)) return;
    const from = this.dragging ? this.dragValue : this.lastKnownPosition ?? 0;
    const to = Math.max(0, Math.min(this.durationSec, from + bySec));
    this.wake();
    this.send('seek', to);
  }

  /** Close every panel and menu this transport owns. */
  closeEverything() {
    this.closePanels();
    this.trackMenu?.close();
    const sheet = document.getElementById('shortcuts-panel');
    if (sheet) sheet.hidden = true;
  }

  /** Show or hide the shortcuts reference. */
  toggleShortcuts() {
    const sheet = document.getElementById('shortcuts-panel');
    if (!sheet) return;
    if (sheet.hidden && sheet.childElementCount <= 1) this.fillShortcuts(sheet);
    sheet.hidden = !sheet.hidden;
  }

  /**
   * Build the reference from the same table the handler uses.
   *
   * @param {HTMLElement} sheet
   */
  fillShortcuts(sheet) {
    const list = sheet.querySelector('dl') ?? document.createElement('dl');
    list.textContent = '';
    for (const entry of SHORTCUTS) {
      const key = document.createElement('dt');
      key.textContent = entry.show;
      const what = document.createElement('dd');
      what.textContent = entry.label;
      list.append(key, what);
    }
    if (!list.parentElement) sheet.append(list);
  }

  /**
   * Listen for shortcuts.
   *
   * Bound to the document rather than to the transport, because the transport
   * hides itself when the pointer leaves and a hidden element cannot hold
   * focus - so shortcuts would stop working exactly when the interface is out
   * of the way, which is when they are most wanted.
   */
  bindShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (isTyping(event.target)) return;
      // Modified keystrokes belong to the browser and to Discord.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const match = SHORTCUTS.find((entry) => entry.keys.includes(event.key));
      if (!match) return;
      // Space scrolls the page and arrows move a scrolled panel; neither is
      // wanted once the key means something here.
      if (event.key === ' ' || event.key.startsWith('Arrow')) event.preventDefault();
      match.run(this, event);
    });
  }

  /** Reveal the bar and cancel any pending hide. */
  wake() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.root.classList.remove('idle');
  }

  /**
   * Hide shortly after the pointer leaves.
   *
   * The short grace period matters: without it, moving the cursor between the
   * bar and a panel it opened would hide the bar in transit.
   */
  scheduleHide(delayMs = 500) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.canHide()) this.root.classList.add('idle');
    }, delayMs);
  }

  /** Whether hiding is currently allowed. @returns {boolean} */
  canHide() {
    return !this.pointerInside
      && !this.dragging
      && this.elements.panel.hidden
      && this.elements.favPanel.hidden;
  }

  /**
   * Advance the auto-hide countdown.
   *
   * Called per frame alongside the marquee. Hiding is suppressed while the
   * pointer is over the bar, while the scrub handle is being dragged, or while
   * either side panel is open, since in all three cases the controls are clearly
   * still in use.
   *
   * @param {number} deltaSec Seconds since the previous frame.
   * @param {number} [hideAfterSec] Idle time before hiding.
   */
  tickIdle(deltaSec, hideAfterSec = 0.5) {
    // Touch users cannot bring the bar back by moving a cursor, so it stays up
    // far longer after a tap. Half a second would make it unusable.
    if (this.isTouch) hideAfterSec = 6;
    const busy = this.pointerInside
      || this.pointerNear
      || this.dragging
      || !this.elements.panel.hidden
      || !this.elements.favPanel.hidden
      || !this.elements.searchPanel.hidden;

    if (busy) {
      this.idleSeconds = 0;
      return;
    }

    this.idleSeconds += deltaSec;
    if (this.idleSeconds >= hideAfterSec) this.root.classList.add('idle');
  }

  /**
   * Advance the title marquee.
   *
   * Called per frame from the render loop. Scrolls only when the text is
   * genuinely wider than its window - a short title that jiggles for no reason
   * is worse than one that sits still - and pauses at each end so the beginning
   * and the end are both readable.
   *
   * @param {number} deltaSec Seconds since the previous frame.
   */
  tickMarquee(deltaSec) {
    const { title, titleWindow } = this.elements;
    const overflow = title.scrollWidth - titleWindow.clientWidth;

    if (overflow <= 4) {
      // Fits: park it and stop doing work.
      if (this.marquee.offset !== 0) {
        this.marquee.offset = 0;
        title.style.transform = 'translateX(0px)';
      }
      return;
    }

    // Paint from the current offset, whatever put it there.
    //
    // This used to happen only on the scrolling path, after the pause check
    // returned early - so a title parked at its start kept the leading fade
    // that had been applied while it was scrolling, and its first characters
    // stayed masked for the whole pause. Clicking the title made it worst: that
    // sets a four second hold, so the beginning of the name was eaten for four
    // seconds at exactly the moment somebody had asked to read it.
    const paint = () => {
      const shift = Math.max(0, this.marquee.offset);
      title.style.transform = `translateX(${-shift}px)`;
      // The leading fade only applies once scrolled away from the start, so a
      // parked title is never clipped at its first character.
      titleWindow.classList.toggle('scrolled', shift > 1);
    };

    if (this.marquee.paused > 0) {
      this.marquee.paused -= deltaSec;
      paint();
      return;
    }

    this.marquee.offset += deltaSec * 26;   // pixels per second

    if (this.marquee.offset >= overflow + 12) {
      // Reached the end: hold briefly, then snap back and hold again, which
      // reads far better than a continuous loop that never settles.
      this.marquee.offset = 0;
      this.marquee.paused = 2.5;
    }

    paint();
  }

  /**
   * Add or remove the current track from the shared favourites.
   *
   * Optimistic, like the pause button: the star fills immediately and the server
   * response corrects it if needed.
   */
  async toggleFavourite() {
    const wanted = !this.favourited;
    this.favourited = wanted;
    this.elements.fav.classList.toggle('active', wanted);
    this.elements.fav.querySelector('.glyph').textContent = wanted ? '\u2605' : '\u2606';

    try {
      const response = await fetch(`/api/favourites/${this.guildId}`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          action: wanted ? 'add' : 'remove',
          channelId: this.channelId,
        }),
      });
      if (!response.ok) throw new Error('failed');
      const result = await response.json();
      this.setFavourited(result.favourited);
      if (!this.elements.favPanel.hidden) this.openFavourites();
    } catch {
      // Revert on failure so the star never lies about what is stored.
      this.setFavourited(!wanted);
    }
  }

  /** Reflect the stored favourite state on the star. @param {boolean} value */
  setFavourited(value) {
    this.favourited = value;
    this.elements.fav.classList.toggle('active', value);
    this.elements.fav.querySelector('.glyph').textContent = value ? '\u2605' : '\u2606';
    this.elements.fav.title = value ? 'Remove from favourites' : 'Favourite this track';
  }

  /**
   * Cache the queue rows' geometry for the length of a drag.
   *
   * Measured once rather than per `dragover`: calling `getBoundingClientRect`
   * on every row for every pointer move forces a layout flush sixty times a
   * second. Invalidated whenever the list is rebuilt or the panel is scrolled.
   */
  measureDropRows() {
    const list = this.elements.list;
    const listTop = list.getBoundingClientRect().top;
    this.dropRows = [...list.children]
      // Only real track rows. A playlist heading and a "3 more" expander are
      // list items too, and counting them would shift every gap after the
      // first block - `positionForSlot` maps a gap index straight onto
      // `queuePositions`, which holds tracks and nothing else.
      .filter((row) => row.classList.contains('track'))
      .map((row) => {
        const bounds = row.getBoundingClientRect();
        return {
          // Which half of a row the pointer is in decides which side of it the
          // tracks land on. The offsets are relative to the list rather than
          // the viewport, so the indicator sits correctly however far the panel
          // happens to be scrolled.
          middleY: bounds.top + bounds.height / 2,
          topOffset: bounds.top - listTop,
          bottomOffset: bounds.bottom - listTop,
        };
      });
  }

  /**
   * Point the insertion indicator at the gap nearest the pointer.
   *
   * @param {number} clientY Pointer position from the drag event.
   */
  updateDropTarget(clientY) {
    if (!this.dropRows) this.measureDropRows();
    const rows = this.dropRows;

    let slot = rows.length;
    for (let index = 0; index < rows.length; index++) {
      if (clientY < rows[index].middleY) {
        slot = index;
        break;
      }
    }

    // Nothing is written unless the pointer has actually crossed a boundary.
    // Without this the indicator is restyled on every dragover - the same
    // wasted write the scrub bar's no-op guard exists to avoid.
    if (slot === this.dropSlot) return;
    this.dropSlot = slot;

    const offset = rows.length === 0
      ? 0
      : slot >= rows.length
        ? rows[rows.length - 1].bottomOffset
        : rows[slot].topOffset;
    this.showDropIndicator(offset);
  }

  /**
   * Move the insertion line, creating it on first use.
   *
   * One element that is repositioned, never a re-render. `transform` rather
   * than `top` keeps the move off the layout path entirely.
   *
   * @param {number} offsetPx Distance from the top of the list.
   */
  showDropIndicator(offsetPx) {
    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement('div');
      this.dropIndicator.className = 'drop-indicator';
    }
    // Silent for a single track: the line already says where it is going, and a
    // "1 track" badge is noise.
    this.dropIndicator.dataset.count = this.dragCount > 1 ? `${this.dragCount} tracks` : '';
    this.dropIndicator.style.transform = `translateY(${offsetPx}px)`;
    if (this.dropIndicator.parentNode !== this.elements.list) {
      this.elements.list.append(this.dropIndicator);
    }
  }

  /**
   * End a favourites drag: hide the revealed queue panel and the indicator.
   *
   * Called from `dragend` as well as from the drop, because a drag abandoned
   * over the visualisation never reaches a drop handler and would otherwise
   * leave the queue docked open on the left.
   */
  endFavouriteDrag() {
    document.body.classList.remove('dragging-favourites');
    this.clearDropIndicator();
  }

  /**
   * Report a drop that the server refused.
   *
   * Every failure on this path used to be silent - the client returned on a
   * non-OK response and swallowed exceptions, and the server answered auth
   * refusals without logging - so a drop that did nothing looked identical to
   * a drop that was never received. Shown where the tracks were aimed.
   *
   * @param {string} message
   */
  showQueueError(message) {
    const list = this.elements.list;
    const line = document.createElement('li');
    line.className = 'empty';
    line.textContent = message;
    line.style.color = '#ff8a8a';
    list.prepend(line);
    // Cleared by the next real render; removed on a timer in case the queue
    // does not change, so it cannot become permanent furniture.
    setTimeout(() => line.remove(), 6000);
  }

  /** Remove the insertion line and forget the cached row geometry. */
  clearDropIndicator() {
    this.elements.panel.classList.remove('drop-target');
    this.dropIndicator?.remove();
    this.dropRows = null;
    this.dropSlot = null;
  }

  /**
   * Absolute queue position for a gap in the rendered list.
   *
   * The panel shows only the upcoming tracks, so a slot in the list is not an
   * index into the queue. Each row carries the absolute position the server
   * gave it, and that is what an insertion has to be expressed in.
   *
   * @param {number} slot Gap index in the rendered list.
   * @returns {number|null} Queue position, or null to append.
   */
  positionForSlot(slot) {
    const positions = this.queuePositions;
    if (!positions || positions.length === 0) return null;
    if (slot >= positions.length) return positions[positions.length - 1] + 1;
    return positions[slot];
  }

  /**
   * Accept tracks dropped onto the queue panel.
   *
   * One request carrying every track, not one per track: each call fetches the
   * channel, prepares the player and connects to voice, so a ten-track drop
   * would otherwise repeat all of that ten times and interleave ten writes to a
   * queue that is being read by the voice player.
   *
   * @param {DragEvent} event
   */
  async handleQueueDrop(event) {
    event.preventDefault();
    const slot = this.dropSlot;
    this.endFavouriteDrag();

    // A row dragged from the queue itself moves; everything else adds.
    if (this.reorderFrom !== null && this.reorderFrom !== undefined) {
      const from = this.reorderFrom;
      this.reorderFrom = null;
      let to = this.positionForSlot(slot ?? Number.MAX_SAFE_INTEGER);
      if (to === null) return;
      // Dropping below its own position, the track is removed before it is
      // reinserted, so every gap after it has shifted up by one. Without this
      // a track dropped one place down lands exactly where it started and the
      // drag appears to do nothing.
      if (to > from) to -= 1;
      if (to === from) return;
      this.queueSignature = null;
      this.send('move', { deck: this.viewIndex, from, to });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(event.dataTransfer.getData('application/json'));
    } catch {
      this.showQueueError('That drop carried nothing this app understands.');
      return;
    }

    // A whole playlist, dragged from its card. Named rather than expanded into
    // its tracks here, so it arrives as one block with its source stamped by
    // the server - dropping a playlist and pressing "Queue all" should not
    // produce two different things in the queue.
    if (payload?.playlist) {
      this.queuePlaylist(payload.playlist).catch(
        (error) => this.showQueueError(error.message),
      );
      return;
    }

    if (!Array.isArray(payload) || payload.length === 0) return;

    // The selection is cleared straight away rather than after the round trip.
    // The tracks have left the panel as far as the user is concerned, and
    // leaving them lit while the request is in flight looks like a failure.
    this.favSelection.clear();
    this.favAnchor = null;
    this.renderFavourites();

    try {
      const response = await fetch(`/api/queue/${this.channelId}`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          tracks: payload.map((entry) => ({
            provider: entry.provider, providerId: entry.providerId,
          })),
          // Where the indicator was pointing, and which deck it was pointing
          // into - the panel can be showing a deck that is not the one playing.
          at: this.positionForSlot(slot ?? Number.MAX_SAFE_INTEGER),
          deck: this.viewIndex,
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        this.showQueueError(detail.error ?? `The server refused that (${response.status}).`);
        return;
      }
      const state = await response.json();
      // The drop changed the order, so the cached signature no longer describes
      // what is on screen and the list has to be rebuilt.
      this.queueSignature = null;
      this.update(state);
      this.onState?.(state);
    } catch (error) {
      this.showQueueError(`Could not reach the server: ${error.message}`);
    }
  }

  /** Hide every side panel. */
  closePanels() {
    this.elements.panel.hidden = true;
    this.elements.favPanel.hidden = true;
    this.elements.searchPanel.hidden = true;
    this.playlists.close();
    this.elements.queueButton.classList.remove('active');
  }

  /**
   * Search for tracks and show the results.
   *
   * Deliberately triggered on Enter rather than as-you-type: each query costs
   * real YouTube quota, and firing one per keystroke would exhaust a day's
   * allowance in a single sentence.
   */
  async runSearch() {
    const query = this.elements.searchInput.value.trim();
    if (query.length < 2) return;

    this.elements.searchStatus.textContent = 'Searching\u2026';
    this.elements.searchResults.textContent = '';

    let payload;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Search failed.');
    } catch (error) {
      this.elements.searchStatus.textContent = error.message;
      return;
    }

    const results = payload.results ?? [];
    this.elements.searchStatus.textContent = results.length === 0
      ? 'Nothing found.'
      : payload.source === 'identified'
        // Worth saying: the link itself could not be played, so this is the same
        // song found somewhere it can be.
        ? `That link could not be played. Found "${payload.identified}" elsewhere:`
        : `${results.length} result${results.length === 1 ? '' : 's'}`;

    for (const track of results) {
      const item = document.createElement('li');

      const art = document.createElement('img');
      art.src = track.thumbnail ? proxied(track.thumbnail) : '';
      art.alt = '';
      art.loading = 'lazy';
      item.append(art);

      const text = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = track.title;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${track.artist} \u00B7 ${track.provider}`;
      text.append(name, document.createElement('br'), who);

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = clock(track.durationSec);

      item.append(text, time);
      item.title = `Queue ${track.title}`;
      item.dataset.menuTrack = menuTrack(track);
      makeQueueDragSource(
        item,
        () => [{ provider: track.provider, providerId: track.providerId }],
        track.title,
      );
      item.addEventListener('click', () => this.queueTrack(track));
      this.elements.searchResults.append(item);
    }
  }

  /**
   * Put a track in the queue.
   *
   * @param {object} track Identity is enough; a descriptor is ignored.
   * @param {number} [at] Absolute position. Appends when absent.
   * @returns {Promise<void>}
   */
  async addToQueue(track, at) {
    const response = await fetch(`/api/queue/${this.channelId}`, {
      method: 'POST',
      headers: this.authHeaders(),
      // Identity only. The server holds the descriptor it gave us and will
      // not accept one from here - see `resolveKnownTrack` in server.js.
      body: JSON.stringify({
        track: { provider: track.provider, providerId: track.providerId },
        ...(Number.isFinite(at) ? { at, deck: this.viewIndex } : {}),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error ?? 'Could not queue that track.');
    }
    const state = await response.json();
    this.update(state);
    this.onState?.(state);
    this.queueSignature = null;
  }

  /**
   * Queue several tracks in one request.
   *
   * One call, not one per track: each of these fetches the channel, prepares
   * the player and connects to voice, so a fifty track playlist sent one at a
   * time would repeat all of that fifty times and interleave fifty writes to
   * the queue while the voice player is running. The server already accepts a
   * batch - this is the same path a multiple selection of favourites uses.
   *
   * @param {object[]} tracks
   */
  async addManyToQueue(tracks) {
    if (tracks.length === 0) return;
    const response = await fetch(`/api/queue/${this.channelId}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        tracks: tracks.map((track) => ({
          provider: track.provider, providerId: track.providerId,
        })),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error ?? 'Could not queue those tracks.');
    }
    const state = await response.json();
    this.update(state);
    this.onState?.(state);
    this.queueSignature = null;
  }

  /**
   * Queue a whole playlist as one block.
   *
   * Sends which playlist, never its contents. The server reads its own copy,
   * so the tracks are the ones it has and the label stamped on them is the one
   * it holds - a client cannot caption a block with somebody else's playlist
   * name, or slip a track into a block it does not belong to.
   *
   * @param {{ownerId: string|null, slot: string, name: string}} which
   */
  async queuePlaylist(which) {
    const response = await fetch(`/api/queue/${this.channelId}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        playlist: { ownerId: which.ownerId ?? this.user?.id ?? null, slot: which.slot },
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error ?? 'Could not queue that playlist.');
    }
    const state = await response.json();
    this.queueSignature = null;
    this.update(state);
    this.onState?.(state);
    this.notify?.(`Queued ${which.name}.`);
  }

  /**
   * Queue a track so it plays after the current one.
   *
   * The insert position is the first *upcoming* track's absolute position, not
   * the literal 1. Queue positions are absolute and the playhead moves through
   * them, so 1 is only "next" while the first track is still playing; four
   * songs into a session the playhead is at 4 and inserting at 1 buries the
   * track three places behind it, where it will never play. That is exactly
   * what "play next doesn't work" looked like.
   *
   * With nothing queued there is no position to insert at, and appending is
   * both correct and what the caller wanted.
   *
   * @param {object} track
   */
  async playNext(track) {
    const at = this.positionForSlot(0);
    await this.addToQueue(track, at ?? undefined);
  }

  /**
   * Add a searched track to the queue, reporting into the search panel.
   *
   * @param {object} track
   */
  async queueTrack(track) {
    this.elements.searchStatus.textContent = `Queueing ${track.title}\u2026`;
    try {
      await this.addToQueue(track);
      this.elements.searchStatus.textContent = `Added ${track.title}.`;
      this.elements.searchInput.value = '';
      this.elements.searchResults.textContent = '';
    } catch (error) {
      this.elements.searchStatus.textContent = error.message;
    }
  }

  /** Empty the search box and redraw. */
  clearSearch() {
    this.favView.query = '';
    this.elements.favSearch.value = '';
    this.elements.favSearchClear.hidden = true;
    this.renderFavourites();
  }

  /** Fetch the shared favourites and render the panel. */
  async openFavourites() {
    this.elements.favPanel.hidden = false;
    try {
      const response = await fetch(`/api/favourites/${this.guildId}`);
      this.favCache = await response.json();
    } catch {
      this.elements.favList.textContent = 'Could not load favourites.';
      return;
    }
    this.renderFavourites();
  }

  /**
   * Order and filter the cached favourites, then draw them.
   *
   * Sorting and filtering happen here rather than on the server because the list
   * is shared but the *view* of it is personal - one person browsing by artist
   * should not change what anyone else sees.
   */
  renderFavourites() {
    const list = this.elements.favList;
    const { favourites: all, contributors } = this.favCache;
    const { sort, folder } = this.favView;

    this.renderFolders(contributors);

    let entries = folder
      ? all.filter((entry) => entry.addedBy.some((who) => (who.id ?? who.username) === folder))
      : [...all];

    // Free-text filter across title, artist and the people who added it, so
    // "sam" finds their picks and "weeknd" finds the track either way.
    const query = this.favView.query.trim().toLowerCase();
    if (query) {
      const terms = query.split(/\s+/);
      entries = entries.filter((entry) => {
        const haystack = [
          entry.title,
          entry.artist,
          ...entry.addedBy.map((who) => who.username),
        ].filter(Boolean).join(' ').toLowerCase();
        // Every term must appear, which makes multi-word searches narrow rather
        // than widen - typing more should always mean fewer results.
        return terms.every((term) => haystack.includes(term));
      });
    }

    const comparators = {
      latest: (a, b) => b.latestAt - a.latestAt,
      oldest: (a, b) => a.latestAt - b.latestAt,
      az: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      za: (a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: 'base' }),
      popular: (a, b) => b.addedBy.length - a.addedBy.length || b.latestAt - a.latestAt,
      longest: (a, b) => b.durationSec - a.durationSec,
    };
    entries.sort(comparators[sort] ?? comparators.latest);

    list.textContent = '';
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = query
        ? `Nothing matches "${this.favView.query.trim()}".`
        : folder
          ? 'Nothing favourited by this person yet.'
          : 'No favourites yet. Star a track to add one.';
      list.append(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const item = document.createElement('li');

      // Cover art, with the adder's avatar overlaid in the corner - the album
      // identifies the track, the avatar identifies whose taste it is.
      const first = entry.addedBy?.[0];
      const art = document.createElement('span');
      art.className = 'art';
      if (entry.thumbnail) {
        const cover = document.createElement('img');
        cover.className = 'cover';
        cover.src = proxied(entry.thumbnail);
        cover.alt = '';
        cover.loading = 'lazy';
        art.append(cover);
      }
      if (first?.avatarUrl) {
        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.src = proxied(first.avatarUrl);
        avatar.alt = first.username ?? '';
        avatar.loading = 'lazy';
        // A broken icon is worse than none, so fall back to an initial.
        avatar.addEventListener('error', () => {
          avatar.replaceWith(initialBadge(first.username));
        });
        art.append(avatar);
      } else if (first?.username) {
        art.append(initialBadge(first.username));
      }

      // More than one person favouriting a track is worth showing: it is the
      // signal the "most favourited" ordering is built on.
      if (entry.addedBy.length > 1) {
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = `+${entry.addedBy.length - 1}`;
        count.title = entry.addedBy.map((who) => who.username).join(', ');
        art.append(count);
      }
      item.append(art);

      const text = document.createElement('span');
      text.className = 'text';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.title;
      const who = document.createElement('span');
      who.className = 'who';
      const names = entry.addedBy.map((person) => person.username);
      who.textContent = names.length === 0
        ? ''
        : names.length === 1
          ? `added by ${names[0]}`
          : `added by ${names[0]} and ${names.length - 1} other`
            + (names.length > 2 ? 's' : '');
      text.append(name, who);

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = clock(entry.durationSec);

      item.append(text, time);
      item.title = `Play ${entry.title}`;
      item.dataset.menuTrack = menuTrack(entry);
      // Selection is keyed on the track's identity rather than the row element
      // or its position: the list is filtered and sorted client-side, so an
      // index means nothing between renders, and a key survives someone else
      // adding a favourite underneath.
      const key = `${entry.provider}:${entry.providerId}`;
      if (this.favSelection.has(key)) item.classList.add('selected');

      item.addEventListener('click', (event) => {
        if (event.shiftKey && this.favAnchor !== null) {
          // The range replaces the selection rather than adding to it, so
          // dragging a shift-click back up shrinks the range instead of
          // leaving everything it passed over selected.
          const low = Math.min(this.favAnchor, index);
          const high = Math.max(this.favAnchor, index);
          this.favSelection.clear();
          for (let i = low; i <= high; i++) {
            const other = entries[i];
            this.favSelection.add(`${other.provider}:${other.providerId}`);
          }
          this.renderFavourites();
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          if (this.favSelection.has(key)) this.favSelection.delete(key);
          else this.favSelection.add(key);
          this.favAnchor = index;
          this.renderFavourites();
          return;
        }
        // A plain click plays, which is what this panel is for. When a
        // selection exists it collapses that first and plays nothing: after
        // ctrl-picking five tracks to drag, a slightly-off click should not
        // blast a song into a room full of people.
        const hadSelection = this.favSelection.size > 0;
        this.favSelection.clear();
        this.favAnchor = index;
        if (hadSelection) {
          this.renderFavourites();
          return;
        }
        this.playFavourite(entry);
      });

      // Dragging a row - or the whole selection, if this row is part of one -
      // onto the queue panel adds those tracks.
      item.draggable = true;
      item.addEventListener('dragstart', (dragEvent) => {
        if (!this.favSelection.has(key)) {
          // Dragging a row from outside the selection makes it the selection,
          // which is what every file manager does and what people expect
          // without being told. The classes are written directly rather than
          // through a re-render: replacing this row mid-dragstart destroys the
          // element being dragged and cancels the drag.
          this.favSelection.clear();
          this.favSelection.add(key);
          this.favAnchor = index;
          for (const row of list.children) row.classList.remove('selected');
          item.classList.add('selected');
        }
        const chosen = entries.filter((candidate) => this.favSelection.has(
          `${candidate.provider}:${candidate.providerId}`,
        ));

        dragEvent.dataTransfer.effectAllowed = 'copy';
        // Full descriptors, not identities. A favourite already holds
        // everything needed to play it - that is the point of the store - so
        // the queue endpoint can take these verbatim without re-resolving the
        // track and spending search quota on something already known.
        dragEvent.dataTransfer.setData('application/json', JSON.stringify(
          chosen.map((track) => ({
            provider: track.provider,
            providerId: track.providerId,
            title: track.title,
            artist: track.artist,
            url: track.url,
            durationSec: track.durationSec,
            thumbnail: track.thumbnail ?? null,
          })),
        ));
        // A plain-text fallback, so dropping outside the app does something
        // sensible rather than nothing.
        dragEvent.dataTransfer.setData('text/plain',
          chosen.map((track) => track.title).join('\n'));
        this.dragCount = chosen.length;

        // Reveal the queue as a drop target on the opposite edge. Both panels
        // are docked right and are mutually exclusive, so while favourites are
        // open there is otherwise nothing on screen to drop onto. Only the
        // class is set - `hidden` is left alone, so removing it restores
        // whatever the panel's real state was.
        document.body.classList.add('dragging-favourites');
      });
      // A drag that ends anywhere else must not leave the indicator, or the
      // revealed queue panel, behind.
      item.addEventListener('dragend', () => this.endFavouriteDrag());
      list.append(item);
    });
  }

  /**
   * Draw the per-person folders.
   *
   * Each contributor is a collapsible folder; opening one filters the list to
   * their favourites. Selecting the same folder twice clears the filter, so
   * getting back to everything never requires hunting for an "all" control.
   *
   * @param {Array<object>} contributors
   */
  renderFolders(contributors) {
    const container = this.elements.favFolders;
    container.textContent = '';

    const makeFolder = (key, label, count, avatarUrl) => {
      const folder = document.createElement('button');
      folder.className = 'folder';
      folder.classList.toggle('active', this.favView.folder === key);

      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = this.favView.folder === key ? '\u25BE' : '\u25B8';
      folder.append(caret);

      if (avatarUrl) {
        const image = document.createElement('img');
        image.src = proxied(avatarUrl);
        image.alt = '';
        image.loading = 'lazy';
        folder.append(image);
      }

      const text = document.createElement('span');
      text.className = 'folder-name';
      text.textContent = label;
      folder.append(text);

      const badge = document.createElement('span');
      badge.className = 'folder-count';
      badge.textContent = String(count);
      folder.append(badge);

      folder.addEventListener('click', (event) => {
        event.stopPropagation();
        // Toggling: clicking the open folder returns to everything.
        this.favView.folder = this.favView.folder === key ? null : key;
        this.renderFavourites();
      });
      return folder;
    };

    // Counts respect the current search, so a folder never advertises more
    // tracks than clicking it would actually show.
    const query = this.favView.query.trim().toLowerCase();
    const terms = query ? query.split(/\s+/) : [];
    const matches = (entry) => {
      if (terms.length === 0) return true;
      const haystack = [entry.title, entry.artist, ...entry.addedBy.map((w) => w.username)]
        .filter(Boolean).join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    };

    const visible = this.favCache.favourites.filter(matches);
    container.append(makeFolder(null, 'Everyone', visible.length, null));

    for (const person of contributors) {
      const key = person.id ?? person.username;
      const count = visible.filter(
        (entry) => entry.addedBy.some((who) => (who.id ?? who.username) === key),
      ).length;
      // Hide people with nothing matching, so searching narrows the folders too.
      if (terms.length > 0 && count === 0) continue;
      container.append(makeFolder(key, person.username, count, person.avatarUrl));
    }
  }

  /**
   * Play a favourite.
   *
   * Uses its own endpoint rather than the generic control route, because that
   * route needs a player already attached to the channel - so clicking a
   * favourite while nothing was playing did nothing at all.
   *
   * @param {object} entry The favourite to play.
   */
  async playFavourite(entry) {
    try {
      const response = await fetch(`/api/favourites/${this.guildId}/play`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          channelId: this.channelId,
          provider: entry.provider,
          providerId: entry.providerId,
        }),
      });
      if (!response.ok) return;
      const state = await response.json();
      this.update(state);
      this.onState?.(state);
      this.elements.favPanel.hidden = true;
    } catch {
      // The poll loop will pick up whatever actually happened.
    }
  }

  /**
   * Move only the scrub bar, for per-frame smoothness.
   *
   * Kept separate from {@link update} because that rebuilds the queue list;
   * calling it every animation frame would recreate those DOM nodes sixty times
   * a second and make the panel unusable.
   *
   * @param {number} positionSec Interpolated playback position.
   */
  setPosition(positionSec) {
    // Held even while dragging, so a relative seek from the keyboard has
    // somewhere to start from. It is written before the early return for that
    // reason - the guard below is about painting, not about knowing.
    this.lastKnownPosition = positionSec;
    if (this.dragging || this.durationSec <= 0) return;
    const ratio = Math.min(1, Math.max(0, positionSec / this.durationSec));

    // Both writes are guarded against no-op updates.
    //
    // This runs once per animation frame. The elapsed label only ever changes
    // once a second, so fifty-nine of every sixty writes set the text to what it
    // already said - and each one still built the string to compare against
    // nothing. The bar is rounded to a tenth of a percent, which is finer than a
    // pixel on any realistic bar width and cuts the style writes similarly.
    const width = `${(Math.round(ratio * 1000) / 10)}%`;
    if (width !== this.lastFillWidth) {
      this.lastFillWidth = width;
      this.elements.fill.style.width = width;
    }

    const elapsed = clock(positionSec);
    if (elapsed !== this.lastElapsed) {
      this.lastElapsed = elapsed;
      this.elements.elapsed.textContent = elapsed;
    }
  }

  /**
   * Re-render from a server snapshot.
   *
   * @param {object} state Snapshot from the server.
   * @param {number} [interpolatedSec] Locally interpolated position, used
   *   between polls so the bar advances smoothly rather than in 1s steps.
   */
  update(state, interpolatedSec) {
    if (!state?.track) return;
    const { track, queue, paused } = state;
    this.durationSec = track.durationSec || state.durationSec || 0;

    if (this.marquee.text !== track.title) {
      // A new title starts from the beginning, with a pause so it can be read
      // before it begins moving.
      this.marquee.text = track.title ?? '';
      this.marquee.offset = 0;
      this.marquee.paused = 2.5;
      this.elements.title.style.transform = 'translateX(0px)';
    }
    this.elements.title.textContent = track.title ?? '';
    this.elements.artist.textContent = track.artist ?? '';
    this.optimisticPaused = paused;
    this.elements.toggle.textContent = paused ? '\u25B6' : '\u23F8';
    this.elements.toggle.title = paused ? 'Play' : 'Pause';

    const loopState = LOOP_STATES[queue.loop] ?? LOOP_STATES.off;
    this.elements.loop.classList.toggle('active', queue.loop !== 'off');
    this.elements.loop.title = loopState.title;
    this.elements.loop.querySelector('.glyph').textContent = loopState.glyph;
    this.elements.loopLabel.textContent = loopState.label;

    this.elements.shuffle.classList.toggle('active', queue.shuffled);
    this.elements.queueLabel.textContent = String(queue.total);
    if (typeof state.favourited === 'boolean') this.setFavourited(state.favourited);

    if (!this.dragging) {
      const position = interpolatedSec ?? state.positionSec;
      const ratio = this.durationSec > 0
        ? Math.min(1, position / this.durationSec)
        : 0;
      this.elements.fill.style.width = `${ratio * 100}%`;
      this.elements.elapsed.textContent = clock(position);
      this.invalidatePositionCache();
    }
    this.elements.total.textContent = clock(this.durationSec);

    if (state.decks) this.renderDecks(state.decks);
    else this.renderQueue(queue);
    this.renderRecent(state.recent);
  }

  /**
   * Draw the recently played list under the search box.
   *
   * Only while the results list is empty. Someone who has just searched wants
   * to see what they searched for, and a second list of tracks underneath it
   * is one more thing to read past.
   *
   * @param {object[]} recent Newest first, from the server snapshot.
   */
  renderRecent(recent = []) {
    const { recentPanel, recentList } = this.elements;
    if (!recentPanel || !recentList) return;

    const searching = this.elements.searchResults.childElementCount > 0;
    recentPanel.hidden = searching || recent.length === 0;
    if (recentPanel.hidden) return;

    const signature = recent.map((track) => track.providerId).join(',');
    if (signature === this.recentSignature) return;
    this.recentSignature = signature;

    recentList.textContent = '';
    for (const track of recent) {
      const row = document.createElement('li');

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = track.artist ? `${track.artist} - ${track.title}` : track.title;
      title.title = title.textContent;

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = clock(track.durationSec);

      row.append(title, time);
      row.title = `Queue ${track.title}`;
      // The same right-click menu as everywhere else, which is the point of the
      // list: the usual reason to want a track you just heard is to save it.
      row.dataset.menuTrack = menuTrack(track);
      makeQueueDragSource(
        row,
        () => [{ provider: track.provider, providerId: track.providerId }],
        track.title,
      );
      row.addEventListener('click', () => this.queueTrack(track));
      recentList.append(row);
    }
  }

  /**
   * Render the queue.
   *
   * The deck tabs are gone. Decks are parallel queues the bot supports from
   * chat, but in the Activity they surfaced as a row of buttons reading
   * "Main 7" - a name nobody chose above a count nobody asked for - and the
   * panel is the queue, not a place to manage several. The active deck is what
   * is shown, which is what the room is listening to.
   *
   * @param {object} decks Serialised DeckSet.
   */
  renderDecks(decks) {
    this.viewIndex = decks.activeIndex;
    // Held so a selection change can repaint without waiting for the next
    // server snapshot, which is up to 600ms away and would make every click
    // feel broken.
    this.lastDecks = decks;

    const viewed = decks.decks[decks.activeIndex] ?? decks.decks[0];
    if (viewed) this.renderQueue(viewed);
  }

  /**
   * Rebuild the queue list, but only when it has actually changed.
   *
   * The snapshot arrives once a second; rebuilding unconditionally would reset
   * scroll position and cancel any hover the user is in the middle of.
   */
  renderQueue(queue) {
    // Identity, not just position: a shuffle keeps the same positions and the
    // same length, so a position-only signature never changed and the panel
    // silently failed to redraw.
    const signature = `${this.viewIndex}:${queue.total}:${queue.index}:`
      + `${(queue.played ?? []).map((track) => track.position).join('.')}:`
      + queue.upcoming.map(
        (track) => `${track.position}|${track.providerId}|${track.source?.id ?? ''}`,
      ).join(',')
      // Selection is part of what is drawn, so a selection change has to be a
      // signature change or the highlight only appears on the next poll.
      + `#${[...this.queueSelection].sort((a, b) => a - b).join('.')}`;
    if (signature === this.queueSignature) return;
    this.queueSignature = signature;

    const list = this.elements.list;
    list.textContent = '';

    // The rows are about to be replaced, so any geometry cached for a drag in
    // progress describes elements that no longer exist. Absolute positions are
    // republished for the same reason: a drop maps a gap to one of these.
    this.dropRows = null;

    if (queue.upcoming.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Nothing queued';
      list.append(empty);
      return;
    }

    // --- Where each track came from ----------------------------------------
    //
    // Marked per row, not as a heading over a run of rows.
    //
    // The heading version was wrong in two ways that only showed up in use. A
    // track added on its own after a playlist block carried no heading of its
    // own, so it sat under the previous playlist's heading and read as part of
    // it - "it adds that song to that playlist even though its not on the
    // playlist". And a playlist interrupted and resumed became two blocks with
    // the same number, which looks like a bug whether or not it is one.
    //
    // A tag on the row cannot have either problem: every row states its own
    // provenance, and no row can be captured by its neighbour's. Reordering,
    // shuffling and removing all stay correct for free, because there is no
    // grouping left to maintain.
    const order = new Map();
    for (const track of queue.upcoming) {
      const id = track.source?.id;
      if (id && !order.has(id)) order.set(id, order.size + 1);
    }
    this.playlists?.setQueued(order);

    // Played tracks, above the upcoming ones and dimmed. Kept short on purpose:
    // this is "what was that last one", not a listening history, and a long
    // list of things already heard would push the actual queue off the screen.
    //
    // Rendered before the rows but excluded from `queuePositions`, so a drop
    // can never be aimed into the past - the gap arithmetic addresses upcoming
    // tracks only.
    for (const track of (queue.played ?? []).slice().reverse()) {
      list.append(this.playedRow(track));
    }

    this.queuePositions = [];
    queue.upcoming.forEach((track, index) => {
      list.append(this.queueRow(track, index, queue, order));
      this.queuePositions.push(track.position);
    });

    this.updateQueueSelectionBar();
  }

  /**
   * A track that has already played.
   *
   * Clickable, because the entire point is being able to go back to it - and it
   * is the only way back once the queue has ended. Not draggable and not
   * selectable: those act on the upcoming queue, and offering them here would
   * invite reordering the past.
   *
   * @param {object} track
   * @returns {HTMLElement}
   */
  playedRow(track) {
    const item = document.createElement('li');
    item.className = 'played';

    const glyph = document.createElement('span');
    glyph.className = 'num';
    glyph.textContent = '↺';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = track.title;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = clock(track.durationSec);

    item.append(glyph, name, time);
    item.title = `Play ${track.title} again`;
    item.dataset.menuTrack = menuTrack(track);
    item.addEventListener('click', () => this.send('jumpDeck', {
      deck: this.viewIndex, position: track.position,
    }));
    return item;
  }

  /**
   * One queue row.
   *
   * @param {object} track
   * @param {number} index Display index among rendered rows.
   * @param {object} queue
   * @param {Map<string, number>} [order] Play order of each playlist in the queue.
   * @returns {HTMLElement}
   */
  queueRow(track, index, queue, order = new Map()) {
    {
      const item = document.createElement('li');
      // Marks this as a real track row, which is what the drop measurement
      // counts and what tells it apart from anything else in the list.
      item.className = 'track';

      if (track.source) {
        const place = order.get(track.source.id) ?? 1;
        // One of a small set of colours, chosen by play order rather than by
        // hashing the name: two playlists next to each other in the queue are
        // then always adjacent in the palette and never collide, which a hash
        // cannot promise.
        item.classList.add(`from-playlist-${((place - 1) % 6) + 1}`);
        item.dataset.playlist = track.source.name;

        const tag = document.createElement('span');
        tag.className = 'source-tag';
        tag.textContent = String(place);
        tag.title = track.source.visibility === 'private'
          ? `From your private playlist "${track.source.name}"`
          : `From "${track.source.name}" by ${track.source.ownerName}`;
        item.append(tag);
      }

      const number = document.createElement('span');
      number.className = 'num';
      number.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = track.title;
      if (track.addedBy) {
        name.title = `Added by ${track.addedBy}`;
        const by = document.createElement('span');
        by.className = 'by';
        by.textContent = track.addedBy;
        name.append(' ', by);
      }

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = clock(track.durationSec);

      // Reorder controls. Separate buttons rather than drag-and-drop: dragging
      // inside an iframe that also handles pointer events for the scrub bar is
      // fragile, and two arrows are unambiguous on touch.
      const tools = document.createElement('span');
      tools.className = 'tools';
      const makeTool = (glyph, title, handler) => {
        const button = document.createElement('button');
        button.textContent = glyph;
        button.title = title;
        button.addEventListener('click', (event) => {
          // Without this the row's own click fires and jumps to the track.
          event.stopPropagation();
          handler();
        });
        return button;
      };
      tools.append(
        makeTool('\u2191', 'Move up', () => this.send('move', {
          deck: this.viewIndex, from: track.position, to: track.position - 1,
        })),
        makeTool('\u2193', 'Move down', () => this.send('move', {
          deck: this.viewIndex, from: track.position, to: track.position + 1,
        })),
        makeTool('\u00D7', 'Remove from queue', async () => {
          await this.send('removeTrack', { deck: this.viewIndex, position: track.position });
          this.queueSignature = null;
        }),
      );

      item.append(number, name, time, tools);
      item.title = `Play ${track.title}`;
      item.dataset.menuTrack = menuTrack(track);

      // Dragging a row reorders the queue, rather than adding anything. The
      // arrows stay: they are unambiguous on touch, where a drag inside a
      // scrolling panel fights the scroll.
      //
      // Marked with its own transfer type. The queue accepts dropped tracks
      // from four other lists, and a reorder must not be mistaken for one of
      // those - it would re-add the track instead of moving it.
      item.draggable = true;
      item.addEventListener('dragstart', (dragEvent) => {
        dragEvent.stopPropagation();
        dragEvent.dataTransfer.effectAllowed = 'move';
        dragEvent.dataTransfer.setData('application/x-kam-reorder', String(track.position));
        dragEvent.dataTransfer.setData('text/plain', track.title);
        this.reorderFrom = track.position;
        document.body.classList.add('dragging-favourites');
      });
      item.addEventListener('dragend', () => {
        this.reorderFrom = null;
        document.body.classList.remove('dragging-favourites');
      });

      // Multi-select, so a queue can be cleared out in one go rather than one
      // row at a time. Ctrl toggles, shift extends from the last row touched -
      // the same gestures the favourites panel uses, and the same ones every
      // file manager uses, so there is nothing new to learn.
      //
      // Keyed on the absolute position rather than the display index: the queue
      // changes underneath while this panel is open, and an index would select
      // a different track than the one clicked.
      if (this.queueSelection.has(track.position)) item.classList.add('selected');

      item.addEventListener('click', (event) => {
        if (event.shiftKey && this.queueAnchor !== null) {
          const positions = queue.upcoming.map((other) => other.position);
          const from = positions.indexOf(this.queueAnchor);
          const to = positions.indexOf(track.position);
          if (from >= 0 && to >= 0) {
            this.queueSelection.clear();
            for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
              this.queueSelection.add(positions[i]);
            }
            this.queueSignature = null;
            this.renderDecks(this.lastDecks);
            return;
          }
        }
        if (event.ctrlKey || event.metaKey) {
          if (this.queueSelection.has(track.position)) {
            this.queueSelection.delete(track.position);
          } else {
            this.queueSelection.add(track.position);
          }
          this.queueAnchor = track.position;
          this.queueSignature = null;
          this.renderDecks(this.lastDecks);
          return;
        }
        // A plain click with a selection open clears it rather than jumping:
        // jumping the room's music because somebody clicked to deselect would
        // be a nasty surprise.
        if (this.queueSelection.size > 0) {
          this.queueSelection.clear();
          this.queueAnchor = null;
          this.queueSignature = null;
          this.renderDecks(this.lastDecks);
          return;
        }
        // Absolute position from the server, not the display index, so it stays
        // correct while the queue changes underneath.
        this.queueAnchor = track.position;
        this.send('jumpDeck', { deck: this.viewIndex, position: track.position });
      });
      return item;
    }
  }

  /**
   * Show or hide the bar that acts on a selection.
   *
   * Only present while something is selected. A permanent "remove selected"
   * button that does nothing most of the time is furniture.
   */
  updateQueueSelectionBar() {
    const bar = this.elements.queueSelectionBar;
    if (!bar) return;
    const count = this.queueSelection.size;
    bar.hidden = count === 0;
    if (count === 0) return;
    this.elements.queueSelectionCount.textContent =
      `${count} selected`;
  }

  /** Remove every selected track in one request. */
  async removeSelected() {
    const positions = [...this.queueSelection];
    if (positions.length === 0) return;
    // Cleared immediately: the rows have gone as far as the user is concerned,
    // and leaving them lit through the round trip looks like a failure.
    this.queueSelection.clear();
    this.queueAnchor = null;
    this.queueSignature = null;
    await this.send('removeTracks', { deck: this.viewIndex, positions });
  }
}
