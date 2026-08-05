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
    this.panel = document.getElementById('playlist-panel');
    this.mine = document.getElementById('playlist-mine');
    this.others = document.getElementById('playlist-others');
    this.status = document.getElementById('playlist-status');
    /** @type {{mine: object, others: object[]}|null} */
    this.cache = null;

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
    this.panel.hidden = true;
  }

  async open() {
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

  render() {
    if (!this.cache) return;
    this.mine.textContent = '';
    this.others.textContent = '';

    for (const entry of this.slots) {
      this.mine.append(this.drawPlaylist(entry, { own: true }));
    }

    if (this.cache.others.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nobody else has shared a public playlist yet.';
      this.others.append(empty);
      return;
    }
    for (const entry of this.cache.others) {
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

    const top = document.createElement('div');
    top.className = 'playlist-top';

    const badge = document.createElement('span');
    badge.className = 'badge';
    // The lock is decoration on top of the word, never instead of it.
    badge.textContent = isPrivate ? '\u{1F512} Private' : 'Public';
    top.append(badge);

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

    if (!own && entry.user) {
      const owner = document.createElement('div');
      owner.className = 'owner';
      if (entry.user.avatarUrl) {
        const avatar = document.createElement('img');
        avatar.src = entry.user.avatarUrl;
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

    const list = document.createElement('ol');
    for (const track of entry.tracks) {
      const row = document.createElement('li');
      row.dataset.provider = track.provider;
      row.dataset.providerId = track.providerId;

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = track.artist ? `${track.artist} - ${track.title}` : track.title;
      title.title = title.textContent;
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

    document.addEventListener('contextmenu', (event) => {
      const row = event.target.closest?.('[data-menu-track]');
      if (!row) return;
      event.preventDefault();
      try {
        this.open(JSON.parse(row.dataset.menuTrack), event.clientX, event.clientY);
      } catch {
        // A malformed attribute must not take the whole page's right-click
        // with it.
        this.close();
      }
    });

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
    this.element.hidden = true;
    this.track = null;
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
