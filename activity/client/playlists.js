/**
 * The playlists panel, and the right-click menu that fills it.
 *
 * Kept out of `transport.js`, which is already long and is about the *player* -
 * what is playing, what is queued, what the scrub bar says. A playlist is none
 * of those. The two are joined by a small context object rather than by this
 * file reaching into the transport, so what one needs from the other is a list
 * of five functions instead of a shared surface.
 *
 * ## Private and public
 *
 * Two slots per person, fixed. Visibility is a property of the slot rather than
 * a setting, so there is no control here that can publish a private collection
 * by accident - `rename` sends a name and nothing else. The private slot is
 * never sent to anybody else by the server, so the marking in this file is for
 * the owner's benefit, telling them which one they are typing into.
 *
 * That marking is deliberately redundant: colour, a border, a word, and a lock.
 * Any one of those alone fails somebody - colour and the lock both fail a
 * screen reader, the word alone is easy to skim past - and this is the one
 * thing in the panel a user must never get wrong.
 */

/** Identity only. The server holds the descriptor and refuses one from here. */
const identify = (track) => ({ provider: track.provider, providerId: track.providerId });

/**
 * Route an external image through this origin.
 *
 * Discord's Activity sandbox blocks loads from external hosts, so a Discord CDN
 * avatar set straight on an `img` silently fails to appear - and only inside
 * Discord, which is exactly where nobody can open devtools to find out why. The
 * same one-liner lives in `transport.js`; importing it from there would make
 * this module and that one circular, for a line that is cheaper to repeat than
 * to share.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
const proxied = (url) => (url ? `/api/image?url=${encodeURIComponent(url)}` : null);

export class PlaylistPanel {
  /**
   * @param {object} context
   * @param {string} context.guildId
   * @param {() => Record<string, string>} context.authHeaders
   * @param {(track: object, at?: number) => Promise<void>} context.enqueue
   * @param {(message: string) => void} context.notify
   */
  constructor(context) {
    this.context = context;
    /** Whose panel this is, for matching own cards to queue blocks. */
    this.viewerId = context.viewerId ?? null;
    this.panel = document.getElementById('playlist-panel');
    this.mine = document.getElementById('playlist-mine');
    this.others = document.getElementById('playlist-others');
    this.status = document.getElementById('playlist-status');
    this.searchBox = document.getElementById('playlist-search');
    this.searchClear = document.getElementById('playlist-search-clear');
    this.ownerFilter = document.getElementById('playlist-owner');
    this.importBox = document.getElementById('playlist-import');

    this.importBox?.addEventListener('keydown', (event) => {
      // Otherwise a space in a pasted link pauses the music, and "/" reopens
      // search over the top of what is being typed.
      event.stopPropagation();
      if (event.key === 'Enter') this.importFrom(this.importBox.value.trim());
    });

    /**
     * The view, which is personal and local.
     *
     * Filtering happens here rather than on the server for the same reason it
     * does for favourites: the playlists are shared but *looking* at them is
     * not, and one person searching should not change what anyone else sees.
     * The whole set is already in hand, so there is nothing to fetch.
     */
    this.view = { query: '', owner: '' };

    /**
     * Play order of each playlist currently in the queue, keyed `ownerId:slot`
     * - the same key the server stamps onto a queued track.
     *
     * @type {Map<string, number>}
     */
    this.queued = new Map();

    this.searchBox?.addEventListener('input', () => {
      this.view.query = this.searchBox.value.trim().toLowerCase();
      if (this.searchClear) this.searchClear.hidden = this.view.query === '';
      this.render();
    });
    // Typing in the panel must not reach the page's keyboard shortcuts - space
    // would otherwise pause the music mid-word.
    this.searchBox?.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.searchBox.value = '';
        this.view.query = '';
        if (this.searchClear) this.searchClear.hidden = true;
        this.render();
      }
    });
    this.searchClear?.addEventListener('click', () => {
      this.searchBox.value = '';
      this.view.query = '';
      this.searchClear.hidden = true;
      this.render();
    });
    this.ownerFilter?.addEventListener('change', () => {
      this.view.owner = this.ownerFilter.value;
      this.render();
    });
    /**
     * Whether the markup this panel needs is actually present.
     *
     * A served `index.html` older than the JavaScript is a real state - it is
     * what `npm start` gives you after editing the client without building -
     * and the panel refusing to construct would take the player down with it.
     * Losing one panel is a bad afternoon; a blank Activity with the music
     * still playing and no way to reach the transport is a much worse one.
     */
    this.available = Boolean(this.panel && this.mine && this.others && this.status);

    document.getElementById('playlist-close')?.addEventListener('click', () => this.close());
  }

  /** The viewer's own two playlists, for the context menu's submenu. */
  get slots() {
    if (!this.cache) return [];
    return [
      { slot: 'public', ...this.cache.mine.public },
      { slot: 'private', ...this.cache.mine.private },
    ];
  }

  close() {
    if (this.panel) this.panel.hidden = true;
  }

  async open() {
    if (!this.available) {
      this.context.notify('Playlists need a rebuild: run `npm run build`.');
      return;
    }
    this.panel.hidden = false;
    await this.refresh();
  }

  /**
   * Reload from the server.
   *
   * Always refetched rather than trusting a local edit, because another member
   * may have changed their public playlist since this panel was last drawn -
   * and because the response is shaped by who is asking, so there is no shared
   * copy to keep in sync.
   */
  async refresh() {
    if (!this.available) return;
    try {
      const response = await fetch(`/api/playlists/${this.context.guildId}`, {
        headers: this.context.authHeaders(),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error ?? `The server refused that (${response.status}).`);
      }
      this.cache = await response.json();
      this.status.textContent = '';
      this.render();
    } catch (error) {
      this.status.textContent = error.message;
    }
  }

  /** Send an edit, then redraw from whatever the server now holds. */
  async edit(body) {
    try {
      const response = await fetch(`/api/playlists/${this.context.guildId}`, {
        method: 'POST',
        headers: this.context.authHeaders(),
        body: JSON.stringify(body),
      });
      const detail = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(detail.error ?? 'That did not work.');
      return detail;
    } catch (error) {
      this.context.notify(error.message);
      return null;
    }
  }

  /**
   * Write a label into an element, marking the part that matched the search.
   *
   * Built from text nodes rather than by assigning `innerHTML`, because the
   * label is a track title from a third party and the query is whatever was
   * typed. Neither is trustworthy as markup, and a title containing a tag would
   * otherwise be parsed as one.
   *
   * @param {HTMLElement} element
   * @param {string} label
   */
  paintMatch(element, label) {
    const at = this.view.query
      ? label.toLowerCase().indexOf(this.view.query)
      : -1;
    if (at < 0) {
      element.textContent = label;
      return;
    }
    const hit = document.createElement('mark');
    hit.textContent = label.slice(at, at + this.view.query.length);
    element.append(
      document.createTextNode(label.slice(0, at)),
      hit,
      document.createTextNode(label.slice(at + this.view.query.length)),
    );
  }

  /**
   * The key the server uses for a playlist block in the queue.
   *
   * Another member's card carries their id; the viewer's own two carry no user
   * object at all, so `null` stands for "me" and is filled in by the panel's
   * own knowledge of whose playlists those are.
   *
   * @param {object} entry
   * @returns {string}
   */
  keyFor(entry) {
    const owner = entry.user?.id ?? this.viewerId ?? 'me';
    return `${owner}:${entry.slot ?? entry.visibility}`;
  }

  /**
   * Told by the transport which playlists are in the queue, and in what order.
   *
   * @param {Map<string, number>} order
   */
  setQueued(order) {
    const changed = order.size !== this.queued.size
      || [...order].some(([key, place]) => this.queued.get(key) !== place);
    this.queued = order;
    // Only redraw when it actually changed: this arrives with every snapshot,
    // about twice a second, and rebuilding the panel that often would fight
    // anyone typing in the search box.
    if (changed && !this.panel?.hidden) this.render();
  }

  /**
   * Import a linked playlist into the viewer's private slot.
   *
   * Private, always. An import is somebody's own collection arriving, and
   * publishing it to a whole server because that happened to be the default
   * would be the wrong way round - it takes one click to copy tracks across
   * afterwards, and no clicks to regret the other order.
   *
   * @param {string} url
   */
  async importFrom(url) {
    if (!url) return;
    this.status.textContent = 'Reading that playlist…';
    this.importBox.disabled = true;
    try {
      const result = await this.edit({ action: 'import', slot: 'private', url });
      if (!result) return;
      this.importBox.value = '';
      // Both numbers, because they differ for two ordinary reasons: a track
      // already saved is not added again, and a name-based import may not find
      // everything. Reporting only one would make either look like a fault.
      this.status.textContent = result.skipped > 0
        ? `Imported ${result.imported} of ${result.found}; ${result.skipped} already saved or unavailable.`
        : `Imported ${result.imported} tracks.`;
      await this.refresh();
    } finally {
      this.importBox.disabled = false;
    }
  }

  /**
   * Open the panel and bring one playlist into view.
   *
   * Any search or member filter in force is cleared first: arriving at a panel
   * that is still filtered to something else, and finding the playlist you
   * asked for absent, is worse than not offering the jump at all.
   *
   * @param {{id: string, name: string}} source As stamped on a queued track.
   */
  async reveal(source) {
    this.view.query = '';
    this.view.owner = '';
    if (this.searchBox) this.searchBox.value = '';
    if (this.searchClear) this.searchClear.hidden = true;
    await this.open();

    const card = [...this.panel.querySelectorAll('.playlist')].find(
      (element) => element.dataset.playlistId === source.id,
    );
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A brief flash rather than a lasting selection: the point is to say "here
    // it is", not to put the panel into a mode that has to be got out of.
    card.classList.add('revealed');
    setTimeout(() => card.classList.remove('revealed'), 1600);
  }

  /** Whether one track matches the current search. */
  matches(track) {
    if (!this.view.query) return true;
    return `${track.artist ?? ''} ${track.title ?? ''}`.toLowerCase().includes(this.view.query);
  }

  /**
   * Keep the member filter's options in step with who has actually shared.
   *
   * Rebuilt from the data rather than appended to, so somebody who empties
   * their public playlist stops being an option - a filter offering a name that
   * can only ever produce an empty list is worse than no filter.
   */
  renderOwners() {
    if (!this.ownerFilter) return;
    const chosen = this.view.owner;
    this.ownerFilter.textContent = '';

    const everyone = document.createElement('option');
    everyone.value = '';
    everyone.textContent = `Everyone (${this.cache.others.length})`;
    this.ownerFilter.append(everyone);

    for (const entry of this.cache.others) {
      const option = document.createElement('option');
      option.value = entry.user.id;
      option.textContent = `${entry.user.username} (${entry.tracks.length})`;
      this.ownerFilter.append(option);
    }

    // A filter set to somebody who has since gone quiet falls back to everyone,
    // rather than silently showing nothing.
    const stillThere = this.cache.others.some((entry) => entry.user.id === chosen);
    this.view.owner = stillThere ? chosen : '';
    this.ownerFilter.value = this.view.owner;
  }

  render() {
    if (!this.cache || !this.available) return;
    this.mine.textContent = '';
    this.others.textContent = '';
    this.renderOwners();

    for (const entry of this.slots) {
      this.mine.append(this.drawPlaylist(entry, { own: true }));
    }

    const visible = this.cache.others.filter(
      (entry) => !this.view.owner || entry.user.id === this.view.owner,
    );

    if (this.cache.others.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nobody else has shared a public playlist yet.';
      this.others.append(empty);
      return;
    }

    // A search that matches nothing shared hides every card, which without this
    // looks identical to nobody having shared anything at all.
    const shown = visible.filter(
      (entry) => !this.view.query || entry.tracks.some((track) => this.matches(track)),
    );
    if (shown.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = this.view.query
        ? `Nothing matching "${this.searchBox.value.trim()}" in shared playlists.`
        : 'Nothing shared by that member.';
      this.others.append(empty);
      return;
    }

    for (const entry of shown) {
      this.others.append(this.drawPlaylist(entry, { own: false }));
    }
  }

  /**
   * One playlist card.
   *
   * @param {object} entry
   * @param {{own: boolean}} options
   */
  drawPlaylist(entry, { own }) {
    const isPrivate = entry.visibility === 'private';
    const card = document.createElement('section');
    card.className = `playlist ${isPrivate ? 'is-private' : 'is-public'}`;
    // The key a queued track carries, so "go to playlist" can find this card.
    card.dataset.playlistId = this.keyFor(entry);

    // The whole playlist can be dragged into the queue, which is the same thing
    // "Queue all" does - dropping one and pressing the button must not produce
    // two different results, so both name the playlist and let the server
    // expand it.
    if (entry.tracks.length > 0) {
      this.context.makeDragSource?.(
        card,
        () => ({
          playlist: {
            ownerId: entry.user?.id ?? this.viewerId ?? null,
            slot: entry.slot ?? entry.visibility,
            name: entry.name,
          },
        }),
        entry.name,
      );
    }

    const top = document.createElement('div');
    top.className = 'playlist-top';

    const badge = document.createElement('span');
    badge.className = 'badge';
    // The lock is decoration on top of the word, never instead of it.
    badge.textContent = isPrivate ? '\u{1F512} Private' : 'Public';
    top.append(badge);

    // Where this playlist sits in the queue, when it is in the queue at all.
    // Queueing playlists in the order you want them *is* the ordering, so this
    // is a readout of what you have already done rather than a control.
    const place = this.queued.get(this.keyFor(entry));
    if (place) {
      const order = document.createElement('span');
      order.className = 'play-order';
      order.textContent = String(place);
      order.title = `Playing ${place === 1 ? 'first' : `${place}${place === 2 ? 'nd' : place === 3 ? 'rd' : 'th'}`} in the queue`;
      card.classList.add('is-queued');
      top.append(order);
    }

    const name = document.createElement('input');
    name.className = 'playlist-name';
    name.value = entry.name;
    name.maxLength = 40;
    name.spellcheck = false;
    // Someone else's playlist is shown in the same shape but cannot be edited.
    // A disabled input would drop it out of the tab order and stop it being
    // read; readonly keeps the name reachable.
    name.readOnly = !own;
    name.setAttribute(
      'aria-label',
      own
        ? `Name of your ${isPrivate ? 'private' : 'public'} playlist`
        : `${entry.name}, a public playlist by ${entry.user?.username ?? 'someone'}`,
    );
    if (own) {
      name.title = 'Click to rename';
      const commit = async () => {
        const wanted = name.value.trim();
        if (wanted === entry.name) return;
        const result = await this.edit({ action: 'rename', slot: entry.slot, name: wanted });
        // The server cleans and may shorten a name, so what it returns wins
        // over what was typed.
        if (result?.name) {
          entry.name = result.name;
          name.value = result.name;
        } else {
          name.value = entry.name;
        }
      };
      name.addEventListener('blur', commit);
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') name.blur();
        if (event.key === 'Escape') {
          name.value = entry.name;
          name.blur();
        }
      });
    }
    top.append(name);

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${entry.tracks.length}`;
    top.append(count);
    card.append(top);

    // Queue the whole thing.
    //
    // Clicking one track queues one track, which is obvious once you know it
    // and invisible until then - there was no way at all to play a playlist,
    // which is most of what a playlist is for. The button sends the tracks in
    // one request rather than one per track: each call otherwise fetches the
    // channel, prepares the player and connects to voice, all repeated.
    if (entry.tracks.length > 0) {
      const queueAll = document.createElement('button');
      queueAll.className = 'queue-all';
      queueAll.type = 'button';
      queueAll.textContent = 'Queue all';
      queueAll.title = `Add all ${entry.tracks.length} tracks to the queue`;
      queueAll.addEventListener('click', async (event) => {
        event.stopPropagation();
        queueAll.disabled = true;
        try {
          // The playlist is named, not sent. The server reads its own copy and
          // stamps each track with where it came from, so the queue can group
          // them - and so the label on a block cannot be anything a client
          // decided to claim.
          await this.context.enqueuePlaylist({
            ownerId: entry.user?.id ?? null, slot: entry.slot ?? 'public', name: entry.name,
          });
        } finally {
          queueAll.disabled = false;
        }
      });
      top.append(queueAll);
    }

    if (!own && entry.user) {
      const owner = document.createElement('div');
      owner.className = 'owner';
      if (entry.user.avatarUrl) {
        const avatar = document.createElement('img');
        avatar.src = proxied(entry.user.avatarUrl);
        avatar.alt = '';
        owner.append(avatar);
      }
      const who = document.createElement('span');
      who.textContent = entry.user.username ?? 'someone';
      owner.append(who);
      card.append(owner);
    }

    if (entry.tracks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = own
        ? 'Empty. Right-click a track anywhere to save it here.'
        : 'Empty.';
      card.append(empty);
      return card;
    }

    const showing = entry.tracks.filter((track) => this.matches(track));
    // The count stays honest about both numbers while a search is running, so
    // it is never unclear whether a playlist is short or merely filtered.
    if (this.view.query) count.textContent = `${showing.length}/${entry.tracks.length}`;

    if (showing.length === 0) {
      const none = document.createElement('p');
      none.className = 'filtered-out';
      none.textContent = 'No matches in this playlist.';
      card.append(none);
      return card;
    }

    const list = document.createElement('ol');
    for (const track of showing) {
      const row = document.createElement('li');
      row.dataset.provider = track.provider;
      row.dataset.providerId = track.providerId;

      const title = document.createElement('span');
      title.className = 'title';
      const label = track.artist ? `${track.artist} - ${track.title}` : track.title;
      this.paintMatch(title, label);
      title.title = label;
      row.append(title);

      if (own) {
        const drop = document.createElement('button');
        drop.className = 'drop';
        drop.textContent = '×';
        drop.title = 'Remove from this playlist';
        drop.setAttribute('aria-label', `Remove ${track.title}`);
        drop.addEventListener('click', async (event) => {
          // Without this the click also lands on the row and queues the track
          // that was just removed.
          event.stopPropagation();
          const result = await this.edit({
            action: 'remove', slot: entry.slot, track: identify(track),
          });
          if (result?.removed) await this.refresh();
        });
        row.append(drop);
      }

      row.addEventListener('click', () => this.context.enqueue(track));
      this.context.makeDragSource?.(
        row,
        () => [identify(track)],
        track.title,
      );
      // Tracks in a playlist get the same menu as tracks anywhere else, so a
      // song can be moved from a public playlist into a private one.
      row.dataset.menuTrack = JSON.stringify({
        provider: track.provider, providerId: track.providerId, title: track.title,
      });
      list.append(row);
    }
    card.append(list);
    return card;
  }
}

/**
 * The right-click menu shared by every list of tracks.
 *
 * One menu element moved and refilled per use rather than one per row: the
 * favourites panel alone can hold two hundred entries, and a hidden menu on
 * each is two hundred pieces of DOM that exist to be used once.
 *
 * Rows opt in by carrying a `data-menu-track` attribute holding the identity of
 * their track. That keeps this decoupled from how any particular list is built,
 * and means a new list gets the menu by setting one attribute.
 */
export class TrackMenu {
  /**
   * @param {object} context
   * @param {(track: object) => Promise<void>} context.enqueue Append to the queue.
   * @param {(track: object) => Promise<void>} context.playNext Insert next.
   * @param {PlaylistPanel} context.playlists
   * @param {(message: string) => void} context.notify
   */
  constructor(context) {
    this.context = context;
    this.element = document.getElementById('track-menu');
    this.track = null;
    // Same reasoning as the panel: without the markup this does nothing rather
    // than throwing on every right-click anywhere in the app.
    if (!this.element) return;

    document.addEventListener('contextmenu', (event) => {
      const row = event.target.closest?.('[data-menu-track]');
      if (!row) return;
      event.preventDefault();
      this.openFor(row, event.clientX, event.clientY);
    });

    // --- Touch ------------------------------------------------------------
    //
    // A phone has no right-click, and this menu is the only way to reach "play
    // next" or "add to playlist" - so without a long press those features
    // simply do not exist on mobile, which is where an Activity is often
    // watched. Drag-and-drop has the same problem and no equivalent gesture,
    // which makes this the one that has to work.
    let timer = null;
    let startedAt = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      startedAt = null;
    };

    document.addEventListener('touchstart', (event) => {
      const row = event.target.closest?.('[data-menu-track]');
      if (!row || event.touches.length !== 1) return;
      const touch = event.touches[0];
      startedAt = { x: touch.clientX, y: touch.clientY };
      timer = setTimeout(() => {
        timer = null;
        // The tap that ends this press must not also queue the track, so the
        // next click is swallowed. Without it a long press opens the menu and
        // plays the song underneath it at the same time.
        this.swallowNextClick = true;
        this.openFor(row, startedAt.x, startedAt.y);
      }, 500);
    }, { passive: true });

    // A press that turns into a scroll is a scroll. Ten pixels is about the
    // slop a thumb produces while holding still.
    document.addEventListener('touchmove', (event) => {
      if (!timer || !startedAt) return;
      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - startedAt.x, touch.clientY - startedAt.y) > 10) cancel();
    }, { passive: true });

    document.addEventListener('touchend', cancel, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });

    document.addEventListener('click', (event) => {
      if (!this.swallowNextClick) return;
      this.swallowNextClick = false;
      event.stopPropagation();
      event.preventDefault();
    }, true);

    // Any click outside closes it, including a click that opens something else.
    document.addEventListener('pointerdown', (event) => {
      if (!this.element.hidden && !this.element.contains(event.target)) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
    // A menu pinned to a viewport position is wrong the moment anything moves.
    window.addEventListener('resize', () => this.close());
    window.addEventListener('scroll', () => this.close(), true);
  }

  close() {
    if (this.element) this.element.hidden = true;
    this.track = null;
  }

  /**
   * Open the menu for a row, wherever the request came from.
   *
   * Shared by the right-click and the long press so the two cannot drift - a
   * menu that behaves differently by input device is worse than one that only
   * works on one of them.
   *
   * @param {HTMLElement} row Carrying `data-menu-track`.
   * @param {number} x
   * @param {number} y
   */
  openFor(row, x, y) {
    try {
      this.open(JSON.parse(row.dataset.menuTrack), x, y);
    } catch {
      // A malformed attribute must not take the whole page's right-click or
      // every long press with it.
      this.close();
    }
  }

  /**
   * @param {object} track
   * @param {number} x
   * @param {number} y
   */
  open(track, x, y) {
    this.track = track;
    this.element.textContent = '';

    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = track.title ?? 'This track';
    this.element.append(head);

    const item = (label, run, { enabled = true } = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = !enabled;
      button.addEventListener('click', async () => {
        this.close();
        await run();
      });
      this.element.append(button);
    };

    item('Add to queue', () => this.context.enqueue(track));
    item('Play next', () => this.context.playNext(track));

    // A track queued from a playlist can lead back to it. The colour stripe in
    // the queue says *which* playlist a track came from, and this is the answer
    // to the obvious next question - "show me the rest of it".
    if (track.source?.name) {
      item(`Go to ${track.source.name}`, () => this.context.playlists.reveal(track.source));
    }

    const slots = this.context.playlists.slots;
    if (slots.length === 0) {
      // The panel has never been opened, so the names are unknown. Offering
      // "Add to playlist" with no idea which one would be a guess.
      item('Open Playlists to save', () => this.context.playlists.open());
    } else {
      for (const entry of slots) {
        const mark = entry.slot === 'private' ? '\u{1F512}' : '\u{1F310}';
        item(`${mark} Add to ${entry.name}`, async () => {
          const result = await this.context.playlists.edit({
            action: 'add', slot: entry.slot, track: identify(track),
          });
          if (!result) return;
          if (result.added) {
            this.context.notify(`Saved to ${entry.name}.`);
            await this.context.playlists.refresh();
          } else if (result.reason === 'already') {
            this.context.notify(`Already in ${entry.name}.`);
          }
        });
      }
    }

    // Placed, then corrected against the viewport. Measuring needs it visible,
    // so it is shown off-screen first rather than flashing in the wrong corner.
    this.element.style.left = '-9999px';
    this.element.style.top = '-9999px';
    this.element.hidden = false;
    const bounds = this.element.getBoundingClientRect();
    const left = Math.max(6, Math.min(x, window.innerWidth - bounds.width - 6));
    const top = Math.max(6, Math.min(y, window.innerHeight - bounds.height - 6));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }
}
