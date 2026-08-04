/**
 * Decks: up to three independent playlists per guild.
 *
 * Built for collaborative sessions. Several people can stack up different sets
 * in parallel - one deck of hip-hop, one of house, one someone is still
 * building - see all three at once, shuffle them independently, and choose
 * which one the next track comes from.
 *
 * ## Why decks rather than one queue with tags
 *
 * Each deck owns its own loop mode, shuffle state and play history. That falls
 * out naturally from holding separate {@link Queue} instances, and would need
 * constant filtering if everything shared one list. It also means the existing
 * queue logic and its tests apply unchanged.
 *
 * ## Switching
 *
 * Switching decks does **not** interrupt the current track by default: it sets
 * where the *next* track comes from. Cutting the music off mid-song because
 * somebody pressed a tab is the wrong default in a room full of people. Pass
 * `immediate` when a user explicitly asks to jump.
 */

import { Queue } from './queue.js';

/** Hard ceiling on decks. Three is enough to collaborate, few enough to see. */
export const MAX_DECKS = 3;

export class DeckSet {
  /** @param {string} [firstName] Name for the initial deck. */
  constructor(firstName = 'Main') {
    /** @type {{name: string, queue: Queue, createdBy: string|null}[]} */
    this.decks = [{ name: firstName, queue: new Queue(), createdBy: null }];
    this.activeIndex = 0;
  }

  /** @returns {{name: string, queue: Queue}} The deck playback draws from. */
  get active() {
    return this.decks[this.activeIndex];
  }

  /** @returns {Queue} Shorthand for the active deck's queue. */
  get queue() {
    return this.active.queue;
  }

  /**
   * Add a deck.
   *
   * @param {string} name Display name.
   * @param {string|null} [createdBy] Who made it, for attribution.
   * @returns {number} Index of the new deck.
   * @throws {Error} When the limit is reached.
   */
  create(name, createdBy = null) {
    if (this.decks.length >= MAX_DECKS) {
      throw new Error(`Only ${MAX_DECKS} playlists can be open at once.`);
    }
    this.decks.push({ name: name.slice(0, 40), queue: new Queue(), createdBy });
    return this.decks.length - 1;
  }

  /**
   * Resolve a deck by index or name.
   *
   * Accepts either so commands can take a number and the Activity can pass what
   * the user typed, without callers needing to care.
   *
   * @param {number|string|null|undefined} reference
   * @returns {{name: string, queue: Queue}|null}
   */
  resolve(reference) {
    if (reference === null || reference === undefined || reference === '') {
      return this.active;
    }
    if (typeof reference === 'number' || /^\d+$/.test(String(reference))) {
      return this.decks[Number(reference)] ?? null;
    }
    const wanted = String(reference).toLowerCase();
    return this.decks.find((deck) => deck.name.toLowerCase() === wanted) ?? null;
  }

  /**
   * Choose the deck the next track comes from.
   *
   * @param {number} index
   * @param {boolean} [immediate] Also restart playback from that deck now.
   * @returns {{name: string, queue: Queue}|null} The deck now selected.
   */
  switchTo(index, immediate = false) {
    if (index < 0 || index >= this.decks.length) return null;
    this.activeIndex = index;
    if (immediate && this.queue.length > 0 && this.queue.index < 0) {
      this.queue.index = 0;
    }
    return this.active;
  }

  /**
   * Remove a deck and its contents.
   *
   * The last remaining deck is cleared rather than removed, so there is always
   * somewhere for tracks to go.
   *
   * @param {number} index
   * @returns {boolean} True if a deck was removed.
   */
  remove(index) {
    if (index < 0 || index >= this.decks.length) return false;
    if (this.decks.length === 1) {
      this.decks[0].queue.clear();
      return false;
    }
    this.decks.splice(index, 1);
    if (this.activeIndex >= this.decks.length) this.activeIndex = this.decks.length - 1;
    else if (index < this.activeIndex) this.activeIndex -= 1;
    return true;
  }

  /** @returns {number} Tracks across every deck. */
  get totalTracks() {
    return this.decks.reduce((sum, deck) => sum + deck.queue.length, 0);
  }

  /**
   * Find the next deck that still has tracks.
   *
   * Used when a deck runs dry: in a shared session, silence because one deck
   * emptied while two others are full is not what the room wants. The caller
   * decides whether to follow this suggestion.
   *
   * @returns {number|null} Index of a deck with upcoming tracks.
   */
  nextNonEmpty() {
    // Stops before wrapping back to the active deck. Including it meant a
    // finished deck was offered as its own continuation, so a single track
    // replayed endlessly.
    for (let offset = 1; offset < this.decks.length; offset++) {
      const index = (this.activeIndex + offset) % this.decks.length;
      if (this.decks[index].queue.upcoming().length > 0) return index;
    }
    return null;
  }

  /**
   * Serialisable view for the Activity.
   *
   * @param {number} [limit] Upcoming tracks per deck.
   * @returns {object}
   */
  toJSON(limit = 25) {
    return {
      activeIndex: this.activeIndex,
      maxDecks: MAX_DECKS,
      decks: this.decks.map((deck, index) => ({
        index,
        name: deck.name,
        createdBy: deck.createdBy,
        active: index === this.activeIndex,
        ...deck.queue.toJSON(limit),
      })),
    };
  }
}
