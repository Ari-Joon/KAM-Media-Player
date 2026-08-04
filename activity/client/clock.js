/**
 * Playback position estimation between server snapshots.
 *
 * Kept separate from `main.js` so it can be unit tested without a browser or
 * the Discord SDK.
 */

/**
 * Playback position estimator for a remotely hosted voice player.
 *
 * The server reports transmitted playback position on a polling interval.
 * Reading that value directly every frame makes visuals visibly step, so this
 * advances a local clock between polls and snaps only when drift exceeds a
 * threshold. Motion stays smooth without losing the server's authority.
 */
export class PlaybackClock {
  /**
   * @param {object} options
   * @param {() => number} options.readPosition Returns the player's reported
   *   position in seconds.
   * @param {number} [options.pollMs] How often to re-read the player.
   * @param {number} [options.resyncThresholdSec] Drift beyond which the local
   *   clock snaps to the player instead of easing.
   */
  constructor({ readPosition, pollMs = 250, resyncThresholdSec = 0.25 }) {
    this.readPosition = readPosition;
    this.pollMs = pollMs;
    this.resyncThresholdSec = resyncThresholdSec;
    this.position = 0;
    this.playing = false;
    this.lastTickMs = performance.now();
    this.lastPollMs = 0;
  }

  /** Start advancing. Call when the player reports it is playing. */
  play() {
    this.playing = true;
    this.lastTickMs = performance.now();
  }

  /** Stop advancing, holding the current position. */
  pause() {
    this.playing = false;
  }

  /** Jump the clock, e.g. after a seek. @param {number} seconds */
  seek(seconds) {
    this.position = seconds;
  }

  /**
   * Advance and return the current estimate. Call once per rendered frame.
   *
   * @returns {number} Estimated playback position in seconds.
   */
  tick() {
    const now = performance.now();
    const deltaSec = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;

    if (this.playing) this.position += deltaSec;

    // Polling continues while paused on purpose: a user can scrub the player
    // while it is stopped, and the clock must follow so the first frame after
    // resuming is already correct.
    if (now - this.lastPollMs >= this.pollMs) {
      this.lastPollMs = now;
      const reported = this.readPosition();
      if (Number.isFinite(reported) && reported > 0) {
        const drift = reported - this.position;
        if (Math.abs(drift) > this.resyncThresholdSec) {
          // Large drift means a seek, a stall or a buffering pause. Snap.
          this.position = reported;
        } else {
          // Small drift is normal clock skew; ease it out so the correction is
          // invisible rather than a jolt in the middle of a bar.
          this.position += drift * 0.1;
        }
      }
    }
    return this.position;
  }
}
