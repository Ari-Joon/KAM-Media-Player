/**
 * Playback queue: ordering, loop modes, shuffle and history.
 *
 * Kept deliberately free of Discord and audio concerns so its behaviour can be
 * reasoned about and tested on its own. It answers one question - "what plays
 * next?" - and holds no I/O.
 *
 * ## Shuffle
 *
 * Shuffling permutes the *upcoming* tracks rather than reordering the whole
 * queue in place, and the currently playing track never moves. Re-shuffling
 * produces a genuinely different order each time (Fisher-Yates over the
 * remainder), which is what users mean by "shuffle again" and what a
 * shuffle-once implementation gets wrong.
 *
 * ## Loop modes
 *
 * - `off`   - stop when the last track finishes
 * - `track` - repeat the current track forever
 * - `queue` - wrap to the start after the last track
 *
 * Loop interacts with history: `previous()` steps backwards through what was
 * actually played, so it behaves correctly even after a shuffle.
 */

/** @typedef {'off'|'track'|'queue'} LoopMode */

/** In-place Fisher-Yates shuffle over a slice of an array. */
function shuffleFrom(items, start) {
  for (let i = items.length - 1; i > start; i--) {
    const j = start + 1 + Math.floor(Math.random() * (i - start));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export class Queue {
  constructor() {
    /** @type {object[]} Track descriptors in play order. */
    this.tracks = [];
    /** Index of the current track, or -1 when nothing is loaded. */
    this.index = -1;
    /**
     * True once the queue has played through to the end.
     *
     * Needed because `index === -1` means two different things - "not started"
     * and "finished" - and conflating them made a finished queue look like a
     * fresh one, so playback restarted from the top instead of stopping.
     */
    this.ended = false;
    /** @type {LoopMode} */
    this.loop = 'off';
    this.shuffled = false;
    /** Indices in the order they were actually played, for `previous()`. */
    this.history = [];
  }

  /** @returns {object|null} The current track. */
  current() {
    return this.tracks[this.index] ?? null;
  }

  /** @returns {object[]} Tracks after the current one, in play order. */
  upcoming() {
    if (this.ended) return [];
    return this.index < 0 ? this.tracks.slice() : this.tracks.slice(this.index + 1);
  }

  /** @returns {number} Total tracks held. */
  get length() {
    return this.tracks.length;
  }

  /**
   * Append tracks to the end.
   *
   * @param {object|object[]} tracks One track or many.
   * @returns {number} Position of the first added track.
   */
  add(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const position = this.tracks.length;
    this.tracks.push(...list);
    // Adding to a finished queue resumes at the new track, not back at the
    // start - queueing one song should never replay the whole history.
    if (this.ended || this.index < 0) {
      this.index = position;
      this.ended = false;
    }
    return position;
  }

  /**
   * Insert tracks directly after the current one.
   *
   * @param {object|object[]} tracks One track or many.
   */
  addNext(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const at = this.index < 0 ? 0 : this.index + 1;
    this.tracks.splice(at, 0, ...list);
    if (this.index < 0) {
      this.index = 0;
      this.ended = false;
    }
  }

  /**
   * Insert tracks at an absolute position.
   *
   * Backs dropping a selection between two rows of the queue panel, so the
   * insertion indicator the user aimed at is where the tracks actually land.
   * `add` and `addNext` cover the two fixed positions; this covers the rest.
   *
   * Like {@link move}, the index follows the music: inserting *above* the
   * playhead pushes the playing track down the array, and without the shift
   * playback would jump to whichever track slid into its slot.
   *
   * @param {number} position Zero-based index to insert at. Clamped to the
   *   queue, so a stale position from a client cannot throw.
   * @param {object|object[]} tracks One track or many.
   * @returns {number} The position actually used, or -1 if nothing was given.
   */
  insertAt(position, tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (list.length === 0) return -1;

    const at = Math.min(Math.max(0, Math.trunc(position) || 0), this.tracks.length);
    this.tracks.splice(at, 0, ...list);

    if (this.ended || this.index < 0) {
      // Same rule as `add`: dropping onto a stopped or finished queue starts
      // from what was just dropped rather than replaying from the top.
      this.index = at;
      this.ended = false;
    } else if (at <= this.index) {
      this.index += list.length;
    }

    // History holds absolute indices too. Left unadjusted, `previous()` would
    // step back to whatever track slid into the slot it recorded.
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i] >= at) this.history[i] += list.length;
    }

    return at;
  }

  /**
   * Advance to the next track.
   *
   * @param {boolean} [manual] True when a user pressed skip. A manual skip
   *   ignores `loop: 'track'`, because repeating the song someone just chose to
   *   leave is never what they meant.
   * @returns {object|null} The new current track, or null when the queue ends.
   */
  next(manual = false) {
    if (this.index < 0) return null;

    if (this.loop === 'track' && !manual) return this.current();

    this.history.push(this.index);

    if (this.index + 1 < this.tracks.length) {
      this.index += 1;
      return this.current();
    }

    if (this.loop === 'queue' && this.tracks.length > 0) {
      this.index = 0;
      return this.current();
    }

    this.index = -1;
    this.ended = true;
    return null;
  }

  /**
   * Step back to the previously played track.
   *
   * Uses play history rather than `index - 1`, so it stays correct after a
   * shuffle or a jump.
   *
   * @returns {object|null} The new current track.
   */
  previous() {
    const last = this.history.pop();
    if (last === undefined) {
      // Nothing played before: restart the current track instead of failing.
      return this.current();
    }
    this.index = last;
    this.ended = false;
    return this.current();
  }

  /**
   * Jump to a specific position.
   *
   * @param {number} position Zero-based index into the queue.
   * @returns {object|null} The new current track.
   */
  jumpTo(position) {
    if (position < 0 || position >= this.tracks.length) return null;
    if (this.index >= 0) this.history.push(this.index);
    this.index = position;
    this.ended = false;
    return this.current();
  }

  /**
   * Remove a track by position.
   *
   * @param {number} position Zero-based index.
   * @returns {object|null} The removed track.
   */
  remove(position) {
    if (position < 0 || position >= this.tracks.length) return null;
    const [removed] = this.tracks.splice(position, 1);
    if (position < this.index) this.index -= 1;
    else if (position === this.index && this.index >= this.tracks.length) {
      this.index = this.tracks.length - 1;
    }
    return removed;
  }

  /**
   * Move a track to a different position.
   *
   * The current index follows the music, not the array: if the playing track is
   * shifted, or something moves across it, the index is adjusted so playback is
   * unaffected by a reorder. Getting this wrong would skip or repeat a song
   * whenever anyone tidied the queue.
   *
   * @param {number} from Absolute index to move.
   * @param {number} to Absolute index to move it to.
   * @returns {object|null} The moved track, or null if either index is invalid.
   */
  move(from, to) {
    if (from < 0 || from >= this.tracks.length) return null;
    if (to < 0 || to >= this.tracks.length) return null;
    if (from === to) return this.tracks[from];

    const [track] = this.tracks.splice(from, 1);
    this.tracks.splice(to, 0, track);

    if (from === this.index) {
      // The playing track itself moved.
      this.index = to;
    } else if (from < this.index && to >= this.index) {
      // Something before the playhead moved to after it.
      this.index -= 1;
    } else if (from > this.index && to <= this.index) {
      // Something after the playhead moved to before it.
      this.index += 1;
    }
    return track;
  }

  /**
   * Shuffle the upcoming tracks, leaving the current one in place.
   *
   * Calling this repeatedly gives a different order each time, which is the
   * behaviour people expect from pressing shuffle twice.
   */
  shuffle() {
    if (this.tracks.length > this.index + 2) {
      shuffleFrom(this.tracks, Math.max(this.index, 0));
    }
    this.shuffled = true;
  }

  /**
   * Set the loop mode.
   *
   * @param {LoopMode} mode
   * @returns {LoopMode} The mode now in effect.
   */
  setLoop(mode) {
    if (['off', 'track', 'queue'].includes(mode)) this.loop = mode;
    return this.loop;
  }

  /** Cycle off -> track -> queue -> off. @returns {LoopMode} */
  cycleLoop() {
    const order = ['off', 'track', 'queue'];
    this.loop = order[(order.indexOf(this.loop) + 1) % order.length];
    return this.loop;
  }

  /** Empty the queue entirely. */
  clear() {
    this.tracks = [];
    this.index = -1;
    this.history = [];
    this.shuffled = false;
    this.ended = false;
  }

  /**
   * Serialisable view for the Activity.
   *
   * @param {number} [limit] Maximum upcoming tracks to include.
   * @returns {object}
   */
  /**
   * The tracks already played, most recent first.
   *
   * Read from `this.history`, which `previous()` already maintains: it is the
   * order tracks were actually *played* in, which after a jump or a shuffle is
   * not the order they sit in. Walking backwards from `index` instead would
   * report whatever happens to be above the playhead, which is a different
   * question and usually the wrong answer.
   *
   * Positions are kept so an entry can be jumped straight back to. A separate
   * log of descriptors would have to be re-resolved to be playable and would
   * drift from the queue the moment anything was removed.
   *
   * @param {number} limit
   * @returns {object[]}
   */
  recentlyPlayed(limit = 3) {
    const played = [];
    const seen = new Set();
    // When the queue has ended the last track is behind the playhead rather
    // than at it, so it belongs in the history - and that is precisely the
    // state where reaching back to replay something matters most.
    const positions = this.ended && this.index >= 0
      ? [...this.history, this.index]
      : [...this.history];

    for (let i = positions.length - 1; i >= 0 && played.length < limit; i -= 1) {
      const position = positions[i];
      // A loop or a jump can revisit the same track; showing it three times
      // would fill the whole list with one song.
      if (seen.has(position)) continue;
      const track = this.tracks[position];
      if (!track) continue;
      seen.add(position);
      played.push({ position, ...track });
    }
    return played;
  }

  toJSON(limit = 25) {
    return {
      current: this.current(),
      index: this.index,
      total: this.tracks.length,
      loop: this.loop,
      shuffled: this.shuffled,
      ended: this.ended,
      played: this.recentlyPlayed().map((track) => ({
        position: track.position,
        providerId: track.providerId,
        provider: track.provider,
        title: track.title,
        artist: track.artist ?? null,
        durationSec: track.durationSec ?? 0,
        source: track.source ?? null,
      })),
      upcoming: this.upcoming().slice(0, limit).map((track, offset) => ({
        position: this.index + 1 + offset,
        // Identity is included so the client can tell a reorder from a change of
        // length - without it, a shuffle produced an identical signature and the
        // panel never redrew.
        providerId: track.providerId,
        title: track.title,
        artist: track.artist,
        durationSec: track.durationSec,
        provider: track.provider,
        thumbnail: track.thumbnail ?? null,
        addedBy: track.addedBy ?? null,
        // Where this track came from, when it came from a playlist. Carried per
        // track rather than as a separate list of ranges because the queue is
        // reordered, shuffled and removed from constantly - a range would have
        // to be maintained through every one of those, and would be wrong the
        // moment anything moved. A field on the track is simply always right.
        source: track.source ?? null,
      })),
    };
  }
}
