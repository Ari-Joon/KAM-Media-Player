/**
 * Reading a VisualScore against a playback position.
 *
 * This was the WebGL "Lava Lamp" visualisation and the two helpers it needed.
 * The visualisation is gone - it never became good enough to keep, and the
 * effort was better spent elsewhere - but the helpers are the canonical
 * statement of two rules the whole renderer set depends on: how a partial
 * score maps onto a longer track, and where the beat is when the beat list
 * runs out.
 */

/**
 * Map playback position into the analysed window.
 *
 * A preview-based score only covers ~30 seconds, while playback runs the full
 * track. Without this the lane index clamps to the final frame and every
 * visual freezes the moment the preview data runs out. Looping reuses the
 * excerpt, which works because a preview is taken from the middle of a track
 * and is broadly representative of it.
 *
 * The seam every ~30s is a single-frame step in the lane values, which the
 * visualiser's exponential smoothing absorbs.
 *
 * @param {object} score A VisualScore.
 * @param {number} playbackSec Current playback position in seconds.
 * @returns {number} Position in score-space, always inside the analysed window.
 */
export function resolveScoreTime(score, playbackSec) {
  const analysed = score.analysis.analysed_duration_sec;
  if (!score.analysis.is_partial || playbackSec < analysed || analysed <= 0) {
    return playbackSec;
  }
  return playbackSec % analysed;
}

/**
 * Decaying pulse that peaks at each beat.
 *
 * Gated on `tempo_confidence`: when beat tracking was unreliable, returning 0
 * suppresses beat-driven motion entirely rather than pulsing at the wrong
 * times, and the continuous lanes carry the visual on their own.
 *
 * Past the analysed window of a partial score the beat list is exhausted, so
 * the grid is extrapolated from the measured tempo instead of looping with the
 * lanes. Looping would restart the bar every ~30s, and a phase jump reads as a
 * mistake in a way that a continuous grid never does.
 *
 * @param {object} score A VisualScore.
 * @param {number} playbackSec Real playback position in seconds.
 * @returns {number} Pulse strength in 0-1.
 */
export function beatPulse(score, playbackSec) {
  const { beats, tempo_confidence: confidence, tempo_bpm: bpm } = score.timing;
  if (confidence < 0.5 || beats.length === 0) return 0;

  const decay = 0.18;  // seconds; short enough to read as a hit, not a swell
  const analysed = score.analysis.analysed_duration_sec;

  if (score.analysis.is_partial && playbackSec >= analysed && bpm > 0) {
    // Extrapolate the grid forward from the first measured beat.
    const interval = 60 / bpm;
    const since = (playbackSec - beats[0]) % interval;
    return Math.max(0, 1 - since / decay);
  }

  // Binary search for the latest beat at or before now. Beat lists run to a
  // few hundred entries, so a linear scan every frame would be wasteful.
  let low = 0;
  let high = beats.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (beats[mid] <= playbackSec) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (index < 0) return 0;

  return Math.max(0, 1 - (playbackSec - beats[index]) / decay);
}
