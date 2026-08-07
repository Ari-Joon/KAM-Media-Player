/**
 * Two visualisations built around what the track *is* rather than what it
 * sounds like: the artwork, and the words.
 *
 * Everything else in the set draws the analysis. These draw the record - the
 * cover you would be looking at if this were a sleeve on a table, and the
 * lyrics as they are sung. They still read every movement from the score, so
 * they breathe with the music rather than sitting still, and they obey the same
 * rule as the rest: motion comes from `lanes.scoreSec` and never from the wall
 * clock, so everyone in the voice channel sees the same frame.
 */

import { Canvas2DVisual, mix } from './visuals.js';

/**
 * Load an image through the proxy and hold it.
 *
 * Discord's Activity sandbox blocks external hosts, so artwork has to come back
 * through this origin. A local URL - `blob:` from the development harness, or
 * anything same-origin - is used as it is, because asking the server to fetch a
 * blob it cannot reach would fail for no reason.
 *
 * @param {string} url
 * @returns {Promise<HTMLImageElement|null>}
 */
async function loadImage(url) {
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const local = /^(blob:|data:|\/)/.test(url);
    image.src = local ? url : `/api/image?url=${encodeURIComponent(url)}`;
    await image.decode();
    return image;
  } catch {
    // No artwork, a blocked request, or a decode failure. The caller draws its
    // fallback rather than failing the frame.
    return null;
  }
}

/**
 * The cover, held large and steady, breathing with the track.
 *
 * The restraint is the point. A sleeve does not need to be thrown around the
 * screen to be worth looking at, so the artwork scales gently with energy and
 * lifts on a beat, and everything else that moves is behind it: a glow taken
 * from the section palette, and a ring that fills as the track plays. What it
 * gains over the transport bar's thumbnail is size - this is the one view where
 * the record itself is the subject.
 */
export class NowPlayingVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    this.image = null;
    this.imageKey = null;
    this.track = null;
    /** Eased separately from the lane so the cover never snaps. */
    this.swell = 0;
  }

  setTrack(track) {
    this.track = track;
    const key = track?.thumbnail ?? null;
    if (key === this.imageKey) return;
    this.imageKey = key;
    this.image = null;
    if (!key) return;
    // Fire and forget: the frame that lands while this is in flight draws the
    // fallback, and the next one has the picture.
    loadImage(key).then((image) => {
      if (this.imageKey === key) this.image = image;
    });
  }

  render(score, playbackSec) {
    const { context, width, height, deltaSec } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;

    context.fillStyle = mix('#05060a', from, 0.10);
    context.fillRect(0, 0, width, height);

    // The glow behind the sleeve, which is where nearly all the movement is.
    const centreX = width / 2;
    const centreY = height / 2;
    const short = Math.min(width, height);
    const glow = context.createRadialGradient(
      centreX, centreY, short * 0.1,
      centreX, centreY, short * (0.42 + lanes.energy * 0.30),
    );
    glow.addColorStop(0, mix(from, to, 0.35 + lanes.brightness * 0.4));
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.globalAlpha = 0.16 + lanes.energy * 0.34;
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    // Cover size. Eased rather than taken straight from the lane: a sleeve that
    // tracks punch exactly judders, and this is meant to be the calm view.
    const wanted = 0.52 + lanes.energy * 0.05 + lanes.punch * 0.035;
    this.swell += (wanted - this.swell) * Math.min(1, deltaSec * 6);
    const size = short * this.swell;
    const x = centreX - size / 2;
    const y = centreY - size / 2;

    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.55)';
    context.shadowBlur = short * 0.05;
    context.shadowOffsetY = short * 0.012;

    if (this.image) {
      // Cropped to a square from the centre. Thumbnails arrive 16:9 from
      // YouTube and square from SoundCloud, and letterboxing one of them inside
      // a square would look like a mistake.
      const side = Math.min(this.image.naturalWidth, this.image.naturalHeight);
      const sx = (this.image.naturalWidth - side) / 2;
      const sy = (this.image.naturalHeight - side) / 2;
      context.drawImage(this.image, sx, sy, side, side, x, y, size, size);
    } else {
      // No artwork: the palette itself, so the view is never a black hole.
      const plate = context.createLinearGradient(x, y, x + size, y + size);
      plate.addColorStop(0, from);
      plate.addColorStop(1, to);
      context.fillStyle = plate;
      context.fillRect(x, y, size, size);
    }
    context.restore();

    // Progress, as a ring just outside the sleeve. Read from the score's own
    // clock, so it agrees with the transport rather than drifting from it.
    const analysed = score.source?.duration_sec
      ?? score.analysis?.analysed_duration_sec ?? 0;
    if (analysed > 0) {
      const done = Math.max(0, Math.min(1, lanes.scoreSec / analysed));
      const radius = size * 0.74;
      context.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      context.lineWidth = Math.max(2, short * 0.006);
      context.beginPath();
      context.arc(centreX, centreY, radius, 0, Math.PI * 2);
      context.stroke();

      context.strokeStyle = mix(to, '#ffffff', 0.25);
      context.beginPath();
      context.arc(centreX, centreY, radius, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2);
      context.stroke();
    }

    // No title or artist here on purpose. The transport bar underneath already
    // carries both, and printing them again put the same two lines on screen
    // twice, a few pixels apart and in different sizes - which reads as a
    // rendering fault rather than as emphasis. The sleeve and the ring are the
    // whole view.
  }
}

/** How long a word stays lit after it has been sung, in seconds. */
const WORD_AFTERGLOW = 0.45;

/** Words shown either side of the one being sung. */
const LINE_WORDS = 9;

/**
 * The lyrics, printed as they are sung.
 *
 * ## Not in the menu
 *
 * Nothing produces lyrics any more, so this can only draw its "no lyrics"
 * state and is no longer registered. The transcription pass behind it was
 * removed because it could not meet what it was asked for: instant, and
 * accurate. Whisper is a *speech* model run on a CPU, so it was neither -
 * seconds of decode per track, and unreliable on sung vocals over a full mix,
 * which is the same reason its voice-activity filter discarded whole tracks as
 * containing no speech at all.
 *
 * Kept rather than deleted because the class is not the problem: give it a
 * `lyrics` block from any source with real timings - a synced-lyrics database
 * rather than a transcription - and it works as written. That is the only route
 * to instant, and it is a different feature.
 *
 * Karaoke, in the sense that matters: the word being sung is the bright one,
 * the words already sung stay legible behind it, and the words to come are
 * visible but dim, so you can see what is arriving.
 */
export class LyricsVisual extends Canvas2DVisual {
  constructor(canvas) {
    super(canvas);
    /** Cached per score, since the word list never changes within one. */
    this.words = null;
    this.wordsKey = null;
    this.cursor = 0;
  }

  /**
   * The index of the last word started at or before `sec`.
   *
   * Scanned from the previous answer rather than searched from the start:
   * playback almost always moves forward by one frame, so this is a step or two
   * in the common case. A seek backwards resets it, which costs one linear pass
   * on the frame the seek lands and nothing afterwards.
   *
   * @param {number} sec
   * @returns {number} -1 before the first word.
   */
  indexAt(sec) {
    const words = this.words;
    if (!words || words.length === 0) return -1;
    if (this.cursor >= words.length || words[this.cursor].t > sec) this.cursor = 0;
    while (this.cursor + 1 < words.length && words[this.cursor + 1].t <= sec) this.cursor += 1;
    return words[this.cursor].t <= sec ? this.cursor : -1;
  }

  render(score, playbackSec) {
    const { context, width, height } = this.begin(score, playbackSec);
    const lanes = this.lanes;
    const [from, to] = lanes.palette;
    const short = Math.min(width, height);

    // The same moving ground as the rest of the set, so this does not look like
    // a different application when you switch to it.
    const ground = context.createLinearGradient(0, 0, 0, height);
    ground.addColorStop(0, mix('#04050a', from, 0.16 + lanes.energy * 0.10));
    ground.addColorStop(1, mix('#03040a', to, 0.08));
    context.fillStyle = ground;
    context.fillRect(0, 0, width, height);

    // A slow wash that answers the beat, keeping the screen alive between
    // lines - lyrics are sparse, and long silences are common.
    const pulse = context.createRadialGradient(
      width / 2, height * 0.5, 0,
      width / 2, height * 0.5, short * (0.5 + lanes.punch * 0.3),
    );
    pulse.addColorStop(0, mix(to, '#ffffff', 0.10));
    pulse.addColorStop(1, 'rgba(0,0,0,0)');
    context.globalAlpha = 0.05 + lanes.punch * 0.18;
    context.fillStyle = pulse;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    const key = score.lyrics ? (score.source?.duration_sec ?? 0) + ':' + (score.lyrics.words?.length ?? 0) : null;
    if (key !== this.wordsKey) {
      this.wordsKey = key;
      this.words = score.lyrics?.words ?? null;
      this.cursor = 0;
    }

    const scale = short * 0.055;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    if (!this.words || this.words.length === 0) {
      context.fillStyle = 'rgba(255, 255, 255, 0.30)';
      context.font = `${scale * 0.55}px "gg sans", Inter, system-ui, sans-serif`;
      // Said plainly. An empty screen would read as a broken visualisation,
      // and this is the ordinary case for an instrumental or a track whose
      // transcription has not finished.
      context.fillText('No lyrics for this track', width / 2, height / 2);
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      return;
    }

    const at = this.indexAt(lanes.scoreSec);
    const current = at >= 0 ? this.words[at] : null;

    // A window of words around the one being sung, laid out as one line that
    // scrolls through them. A full-text karaoke layout would need line breaks
    // the transcription does not provide - it gives words, not lines.
    const first = Math.max(0, at - Math.floor(LINE_WORDS / 2));
    const window = this.words.slice(first, first + LINE_WORDS);

    context.font = `600 ${scale}px "gg sans", Inter, system-ui, sans-serif`;
    const gap = scale * 0.42;
    const widths = window.map((word) => context.measureText(word.w).width);
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, window.length - 1);

    let x = width / 2 - total / 2;
    const y = height / 2;

    window.forEach((word, index) => {
      const absolute = first + index;
      const sung = absolute < at;
      const singing = absolute === at;
      const since = lanes.scoreSec - (word.t + word.d);

      let alpha;
      if (singing) alpha = 1;
      else if (sung) {
        // Recently sung words fade rather than switching off, so a line does
        // not blink out behind the cursor.
        alpha = since < WORD_AFTERGLOW ? 0.9 - (since / WORD_AFTERGLOW) * 0.45 : 0.42;
      } else alpha = 0.22;

      context.globalAlpha = alpha;
      context.fillStyle = singing
        ? mix('#ffffff', to, 0.15)
        : (sung ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.7)');

      if (singing) {
        // The one being sung is the only thing that glows, which is what makes
        // it findable at a glance from across a room.
        context.shadowColor = mix(to, '#ffffff', 0.4);
        context.shadowBlur = scale * 0.8;
      }
      context.fillText(word.w, x + widths[index] / 2, y);
      context.shadowBlur = 0;
      x += widths[index] + gap;
    });
    context.globalAlpha = 1;

    // The next line, dim and below, so there is something to read ahead to.
    const ahead = this.words.slice(first + LINE_WORDS, first + LINE_WORDS * 2);
    if (ahead.length > 0) {
      context.globalAlpha = 0.18;
      context.fillStyle = '#ffffff';
      context.font = `${scale * 0.62}px "gg sans", Inter, system-ui, sans-serif`;
      context.fillText(ahead.map((word) => word.w).join(' '), width / 2, y + scale * 1.7,
        width * 0.9);
      context.globalAlpha = 1;
    }

    // A quiet marker while nothing is being sung, so a long instrumental
    // passage still shows the track is running.
    if (!current || lanes.scoreSec > current.t + current.d + 2) {
      context.globalAlpha = 0.10 + lanes.energy * 0.2;
      context.fillStyle = mix(from, to, 0.5);
      const dotY = height * 0.72;
      for (let i = 0; i < 3; i += 1) {
        const beat = Math.max(0, Math.sin((lanes.beatCount - i * 0.25) * Math.PI));
        context.beginPath();
        context.arc(width / 2 + (i - 1) * scale, dotY, scale * (0.10 + beat * 0.08), 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    }

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
  }
}
