"""Audio DSP stage: turn an audio file into a :class:`~visualcore.schema.VisualScore`.

This is the only stage that touches raw audio. Everything downstream reads the
score. Analysis runs once per track and the result is cached, so this module
optimises for output quality over speed - a few seconds per track is fine.

Deliberate choices worth knowing before you tune anything:

* **22.05 kHz mono.** Beat tracking, onsets and band energy are unaffected by
  discarding content above ~11 kHz, and it halves the work.
* **One STFT, reused everywhere.** Loudness, centroid, band energy, the mel
  spectrogram and the fine spectrum all derive from a single magnitude
  spectrogram.
* **Percentile normalisation, not min-max.** A single clipped sample would
  otherwise squash an entire lane. Lanes map the 2nd-98th percentile onto
  0.0-1.0 and clip, so a quiet track still uses the full visual range.
* **Downbeats and meter are heuristic.** They come from scoring accent
  strength across candidate bar phases, not from a trained model. Use them for
  accents that degrade gracefully when wrong.
"""

from __future__ import annotations

import logging
from pathlib import Path

import librosa
import numpy as np
import numpy.typing as npt

from .lyrics import summarise, transcribe
from .schema import (
    Lyrics,
    LyricMood,
    LyricWord,
    AnalysisMeta,
    Lanes,
    Provider,
    Section,
    SourceRef,
    Timing,
    VisualScore,
)

logger = logging.getLogger(__name__)

ANALYSER_VERSION = "1.4.0"
"""Bump on any change that alters output values, to invalidate cached scores."""

SAMPLE_RATE = 22_050
N_FFT = 2048
HOP_LENGTH = 512
DEFAULT_FPS = 30

# Mel bands used for the percussive onset envelope.
MEL_BANDS = 128

# Lowest mel band kept when isolating transients. Below roughly this point the
# spectrum is dominated by sustained bass and pitched content, which muddies the
# distinction between a hit and a chord change.
PERCUSSIVE_MEL_FLOOR = 40

# Number of bands in the fine-grained spectrum lane. Sixteen is enough for a
# classic analyser display while keeping the score a reasonable size: at 30fps a
# four-minute track costs roughly half a megabyte, fetched once per track.
SPECTRUM_BANDS = 16

# Range covered by the spectrum. Starts at 40Hz because nothing musical sits
# below it at this sample rate, and stops just under Nyquist.
SPECTRUM_RANGE_HZ = (40.0, 10_500.0)

# Band edges in Hz. Chosen to match how the bands read visually rather than any
# psychoacoustic standard: bass is what you feel, treble is what glitters.
_BANDS: dict[str, tuple[float, float]] = {
    "bass": (20.0, 250.0),
    "mid": (250.0, 4_000.0),
    "treble": (4_000.0, 11_000.0),
}

# Target seconds per section. Section count scales with duration between the
# clamps so a 90-second track is not carved into the same number of parts as a
# seven-minute one.
_SECONDS_PER_SECTION = 18.0
_MIN_SECTIONS = 3
_MAX_SECTIONS = 12

# Nominal tempo emitted when no beat grid can be recovered at all. Always
# paired with a confidence of 0.0, never presented as a real measurement.
_FALLBACK_BPM = 120.0

# Band in which a tracked tempo is trusted without octave checking. Chosen to
# cover the overwhelming majority of popular music; grids outside it are tested
# for half/double errors.
_PREFERRED_BPM = (90.0, 180.0)

# Fraction of beat-position onset strength that candidate positions must carry
# before the grid is re-octaved. Tuned so a genuinely sparse half-time track is
# left alone while a skipped-beat grid is corrected.
_OCTAVE_EVIDENCE = 0.45

# Shortest span still treated as a structural section. Anything briefer is a
# transition, not a section, and merging it prevents palette flicker.
_MIN_SECTION_SEC = 4.0


def _normalise(values: npt.NDArray[np.floating]) -> npt.NDArray[np.float64]:
    """Map a feature curve onto 0.0-1.0 using robust percentile scaling.

    Args:
        values: Any real-valued 1-D feature curve.

    Returns:
        The curve rescaled so its 2nd percentile is 0.0 and its 98th is 1.0,
        with outliers clipped. A flat input returns all zeros.
    """
    lo, hi = np.percentile(values, [2.0, 98.0])
    if hi - lo < 1e-9:
        return np.zeros_like(values, dtype=np.float64)
    return np.clip((values - lo) / (hi - lo), 0.0, 1.0).astype(np.float64)


def _to_fps_grid(
    values: npt.NDArray[np.floating],
    frame_times: npt.NDArray[np.floating],
    fps: int,
    duration: float,
) -> list[float]:
    """Resample a frame-rate feature curve onto a uniform per-frame grid.

    The STFT hop gives an awkward frame rate (~43 Hz at these settings). The
    renderer wants a round number it can index with ``int(t * fps)``, so every
    lane is linearly interpolated onto that grid.

    Args:
        values: Normalised feature curve, one value per STFT frame.
        frame_times: Timestamp in seconds of each entry in ``values``.
        fps: Target samples per second.
        duration: Length of the analysed audio in seconds.

    Returns:
        Interpolated samples rounded to 3 decimals, for compact JSON.
    """
    grid = np.arange(0.0, duration, 1.0 / fps)
    resampled = np.interp(grid, frame_times, values)
    return [round(float(v), 3) for v in resampled]


def _estimate_meter_and_downbeats(
    beat_frames: npt.NDArray[np.integer],
    beat_times: npt.NDArray[np.floating],
    onset_env: npt.NDArray[np.floating],
) -> tuple[int, float, list[float]]:
    """Pick the bar length and bar-start phase that best explain the accents.

    For each candidate meter (4 then 3) and each phase within it, average the
    onset strength of the beats that would land on beat one. Real music accents
    the downbeat, so the highest-scoring combination is the most likely bar
    alignment. Averaging rather than summing keeps the two meters comparable
    despite selecting different numbers of beats.

    Confidence is the winning phase's margin over the mean of all phases at
    that meter, normalised by that mean. Music with no bar-level accent
    produces near-identical phase scores and therefore near-zero confidence,
    which is the signal the renderer needs to ignore downbeats entirely.

    Args:
        beat_frames: STFT frame index of each tracked beat.
        beat_times: Time in seconds of each tracked beat.
        onset_env: Onset strength envelope, indexed by STFT frame.

    Returns:
        The estimated meter, its confidence in 0.0-1.0, and the estimated
        downbeat times.
    """
    if len(beat_frames) < 8:
        return 4, 0.0, [round(float(t), 4) for t in beat_times]

    strengths = onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]

    best_meter, best_phase, best_score, best_confidence = 4, 0, -np.inf, 0.0
    for meter in (4, 3):
        phase_scores = np.array(
            [float(np.mean(strengths[phase::meter])) for phase in range(meter)]
        )
        phase = int(np.argmax(phase_scores))
        baseline = float(np.mean(phase_scores))
        confidence = (
            float(np.clip((phase_scores[phase] - baseline) / baseline, 0.0, 1.0))
            if baseline > 1e-9
            else 0.0
        )
        if phase_scores[phase] > best_score:
            best_meter = meter
            best_phase = phase
            best_score = float(phase_scores[phase])
            best_confidence = confidence

    downbeats = beat_times[best_phase :: best_meter]
    return best_meter, round(best_confidence, 3), [round(float(t), 4) for t in downbeats]


def _correct_tempo_octave(
    beat_frames: npt.NDArray[np.integer],
    beat_times: npt.NDArray[np.floating],
    onset_env: npt.NDArray[np.floating],
    tempo_bpm: float,
    sample_rate: int,
) -> tuple[npt.NDArray[np.floating], float]:
    """Detect and repair a beat grid locked to half or double the true tempo.

    Beat trackers are ambiguous by an octave: a 171 BPM track with kicks on
    alternate beats is readily heard as 85.5. librosa's tempogram also carries a
    prior centred near 120 BPM, which biases fast tracks toward the half-tempo
    reading - observed in production on a 171 BPM track reported as 86, with a
    tempo confidence of 0.98. High confidence in the wrong octave is the
    dangerous case, because nothing downstream flags it.

    The test is whether the midpoints between beats carry real onset energy. If
    they do, the tracker skipped every other beat and the grid should be
    doubled. Correction is attempted only outside ``_PREFERRED_BPM``, so a
    confidently-tracked mid-tempo grid is never second-guessed.

    Note the ambiguity is partly musical rather than an outright error: a
    half-time reading can be perceptually valid. The bias here is deliberate -
    visuals driven by a 43 BPM pulse look inert, so within the ambiguous band
    the faster reading is preferred.

    Args:
        beat_frames: STFT frame index of each tracked beat.
        beat_times: Tracked beat times in seconds.
        onset_env: Onset strength envelope, indexed by STFT frame.
        tempo_bpm: Tempo implied by ``beat_times``.
        sample_rate: Analysis sample rate.

    Returns:
        Possibly-corrected beat times and tempo.
    """
    low, high = _PREFERRED_BPM
    if len(beat_frames) < 8 or low <= tempo_bpm <= high:
        return beat_times, tempo_bpm

    beat_strength = float(np.mean(onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]))
    if beat_strength <= 1e-9:
        return beat_times, tempo_bpm

    if tempo_bpm < low:
        # Candidate doubled grid: the existing beats plus their midpoints.
        midpoints = (beat_times[:-1] + beat_times[1:]) / 2.0
        mid_frames = librosa.time_to_frames(
            midpoints, sr=sample_rate, hop_length=HOP_LENGTH
        )
        mid_strength = float(
            np.mean(onset_env[np.clip(mid_frames, 0, len(onset_env) - 1)])
        )
        if mid_strength / beat_strength >= _OCTAVE_EVIDENCE:
            doubled = np.sort(np.concatenate([beat_times, midpoints]))
            logger.info(
                "Doubling tempo %.1f -> %.1f BPM; midpoints carry %.0f%% of "
                "beat onset strength.",
                tempo_bpm, tempo_bpm * 2, 100 * mid_strength / beat_strength,
            )
            return doubled, tempo_bpm * 2.0

    elif tempo_bpm > high:
        # Candidate halved grid: keep whichever alternating phase is stronger.
        strengths = onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]
        even, odd = strengths[0::2], strengths[1::2]
        keep = 0 if float(np.mean(even)) >= float(np.mean(odd)) else 1
        weaker = float(np.mean(odd if keep == 0 else even))
        if weaker / beat_strength < _OCTAVE_EVIDENCE:
            logger.info(
                "Halving tempo %.1f -> %.1f BPM; alternate beats carry only "
                "%.0f%% of onset strength.",
                tempo_bpm, tempo_bpm / 2, 100 * weaker / beat_strength,
            )
            return beat_times[keep::2], tempo_bpm / 2.0

    return beat_times, tempo_bpm


def _estimate_tempo(beat_times: npt.NDArray[np.floating]) -> tuple[float, float]:
    """Derive tempo and its confidence from the tracked beat grid.

    ``librosa.beat.beat_track`` also returns a tempo, but it comes from a
    log-spaced tempogram search and can disagree with the beats it just
    produced - on a true 120 BPM signal it reports 117.5. The beat grid itself
    is the better estimator, with one caveat: beat times are quantised to the
    STFT hop (23.2 ms here), so consecutive intervals alternate around the true
    value. The **median** interval therefore locks onto one side of that
    alternation and inherits the full quantisation error, while the **mean**
    averages it out. Outlying intervals are trimmed first so a single dropped
    or doubled beat cannot drag the mean.

    Confidence is ``1 - (std / mean)`` over the trimmed intervals. Note it
    cannot reach exactly 1.0, because hop quantisation alone contributes a
    small amount of jitter.

    Args:
        beat_times: Tracked beat times in seconds.

    Returns:
        Tempo in BPM and confidence in 0.0-1.0. Returns ``(0.0, 0.0)`` when
        there are too few beats to measure.
    """
    if len(beat_times) < 3:
        return 0.0, 0.0

    intervals = np.diff(beat_times)
    median = float(np.median(intervals))
    if median <= 0.0:
        return 0.0, 0.0

    # Keep only intervals within half/double of the median, which removes
    # dropped beats (long) and spurious extra beats (short).
    inliers = intervals[(intervals > 0.5 * median) & (intervals < 1.5 * median)]
    if inliers.size < 2:
        return round(60.0 / median, 2), 0.0

    mean = float(np.mean(inliers))
    confidence = float(np.clip(1.0 - (float(np.std(inliers)) / mean), 0.0, 1.0))
    return round(60.0 / mean, 2), round(confidence, 3)


def _segment_sections(
    magnitude: npt.NDArray[np.floating],
    beat_frames: npt.NDArray[np.integer],
    beat_times: npt.NDArray[np.floating],
    duration: float,
    energy: npt.NDArray[np.floating],
    brightness: npt.NDArray[np.floating],
    frame_times: npt.NDArray[np.floating],
    min_section_sec: float = _MIN_SECTION_SEC,
) -> list[Section]:
    """Split the track into structurally similar spans.

    Timbre (MFCC) and harmony (chroma) are averaged within each beat, then
    agglomerative clustering finds the boundaries where both change together -
    which is what a verse-to-chorus transition looks like numerically.
    Boundaries land on beats, so a section change can be cut to cleanly.

    Args:
        magnitude: STFT magnitude spectrogram.
        beat_frames: STFT frame index of each tracked beat.
        beat_times: Time in seconds of each tracked beat.
        duration: Analysed duration in seconds.
        energy: Normalised loudness curve, per STFT frame.
        brightness: Normalised spectral centroid curve, per STFT frame.
        frame_times: Timestamp of each STFT frame.
        min_section_sec: Sections shorter than this are merged into the
            preceding one.

    Returns:
        Contiguous, non-overlapping sections covering the whole track.
    """
    target = int(round(duration / _SECONDS_PER_SECTION))
    n_sections = int(np.clip(target, _MIN_SECTIONS, _MAX_SECTIONS))

    boundary_times: list[float] = [0.0]
    # Clustering needs more beats than clusters to be meaningful; short or
    # poorly-tracked audio falls back to even division below.
    if len(beat_frames) > n_sections + 1:
        mfcc = librosa.feature.mfcc(S=librosa.power_to_db(magnitude**2), n_mfcc=13)
        # tuning=0.0 assumes standard A440 rather than estimating it per track.
        # The estimate is unreliable on percussive or atonal material and warns
        # noisily; absolute tuning is irrelevant here because only *changes* in
        # chroma matter for finding section boundaries.
        chroma = librosa.feature.chroma_stft(S=magnitude, tuning=0.0)
        features = np.vstack([librosa.util.normalize(mfcc), chroma])
        beat_sync = librosa.util.sync(features, beat_frames, aggregate=np.mean)

        bounds = librosa.segment.agglomerative(beat_sync, n_sections)
        boundary_times = [
            float(beat_times[min(int(b), len(beat_times) - 1)]) for b in bounds
        ]
        boundary_times[0] = 0.0
    else:
        logger.warning(
            "Too few beats (%d) for structural segmentation; dividing evenly.",
            len(beat_frames),
        )
        boundary_times = list(np.linspace(0.0, duration, n_sections, endpoint=False))

    # Clustering can place two boundaries a beat apart, which would emit a
    # sub-second section and make the renderer flicker through a whole palette
    # change. Drop any boundary that falls too soon after the last kept one.
    ordered = sorted(set(boundary_times))
    kept: list[float] = [0.0]
    for boundary in ordered[1:]:
        if boundary - kept[-1] >= min_section_sec:
            kept.append(boundary)
    # The tail is governed by the same rule: if the final section came out too
    # short, absorb it into its predecessor rather than emitting a stub.
    if len(kept) > 1 and duration - kept[-1] < min_section_sec:
        kept.pop()

    edges = kept + [duration]

    sections: list[Section] = []
    for index, (start, end) in enumerate(zip(edges[:-1], edges[1:])):
        if end - start < 1e-3:
            continue
        mask = (frame_times >= start) & (frame_times < end)
        if not mask.any():
            continue
        sections.append(
            Section(
                index=len(sections),
                start_sec=round(start, 3),
                end_sec=round(end, 3),
                energy_mean=round(float(np.mean(energy[mask])), 3),
                brightness_mean=round(float(np.mean(brightness[mask])), 3),
            )
        )
    return sections


def analyse(
    audio_path: str | Path,
    *,
    source: SourceRef | None = None,
    fps: int = DEFAULT_FPS,
    is_partial: bool = False,
    max_seconds: float | None = None,
    with_lyrics: bool = False,
) -> VisualScore:
    """Analyse an audio file and produce a complete :class:`VisualScore`.

    Args:
        audio_path: Path to any audio file readable by soundfile or audioread
            (wav, flac, ogg, mp3, m4a).
        source: Playback reference to embed in the score. Defaults to a local
            reference derived from the file itself; pass a provider reference
            when the server associates the analysis with a remote track.
        fps: Lane sample rate. 30 matches typical render rates; raise it only
            if the renderer runs faster and the JSON size is acceptable.
        is_partial: Set when ``audio_path`` is a preview clip rather than the
            full track, so the renderer knows to degrade past its end.
        with_lyrics: Transcribe the vocals and summarise their mood. Adds ten to
            thirty seconds, so it is off by default and requested separately once
            playback has already started.
        max_seconds: Analyse only the first this-many seconds. Used to produce a
            provisional score in well under a second so visuals can start
            immediately, with the full analysis replacing it moments later.
            Implies ``is_partial``.

    Returns:
        A populated score. ``lyrics`` and ``choreography`` are left unset for
        the later pipeline stages.

    Raises:
        FileNotFoundError: If ``audio_path`` does not exist.
        ValueError: If the file decodes to less than one second of audio.
    """
    path = Path(audio_path)
    if not path.is_file():
        raise FileNotFoundError(f"Audio file not found: {path}")

    logger.info("Loading %s", path.name)
    samples, sample_rate = librosa.load(
        path, sr=SAMPLE_RATE, mono=True, duration=max_seconds
    )
    if max_seconds is not None:
        is_partial = True
    duration = float(len(samples) / sample_rate)
    if duration < 1.0:
        raise ValueError(f"Audio too short to analyse: {duration:.3f}s")

    # Single STFT reused by every feature below.
    spectrogram = np.abs(librosa.stft(samples, n_fft=N_FFT, hop_length=HOP_LENGTH))
    frame_times = librosa.frames_to_time(
        np.arange(spectrogram.shape[1]), sr=sample_rate, hop_length=HOP_LENGTH
    )
    # Onset detection runs on a mel-scaled spectrogram rather than the linear
    # one: mel banding weights the low-mid range where percussive energy
    # actually lives. On the test signal the linear-STFT envelope missed the
    # first 6.8 seconds of beats outright, while the mel envelope tracked from
    # 0.77s. Do not "simplify" this back to reusing `spectrogram`.
    onset_env = librosa.onset.onset_strength(
        y=samples, sr=sample_rate, hop_length=HOP_LENGTH
    )

    # `punch` previously came from a harmonic/percussive source separation
    # (librosa.decompose.hpss), which dominated the whole analysis: 14.7 of 20.9
    # seconds on a four-minute track, purely to produce this one lane.
    #
    # Onset strength restricted to the upper mel bands is 289x faster and
    # correlates with the HPSS result at 0.997 - effectively the same signal.
    # It works because transients are broadband while sustained pitched content
    # is not, so discarding the lower bands isolates hits without separating
    # sources at all.
    mel_power = librosa.feature.melspectrogram(
        S=spectrogram**2, sr=sample_rate, n_mels=MEL_BANDS
    )
    punch_env = librosa.onset.onset_strength(
        S=librosa.power_to_db(mel_power[PERCUSSIVE_MEL_FLOOR:]), sr=sample_rate
    )

    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sample_rate, hop_length=HOP_LENGTH, units="frames"
    )
    beat_times = librosa.frames_to_time(
        beat_frames, sr=sample_rate, hop_length=HOP_LENGTH
    )

    # beat_track's own tempo return value is discarded on purpose - see
    # _estimate_tempo for why the beat grid is the better estimator.
    tempo_bpm, tempo_confidence = _estimate_tempo(beat_times)

    # Repair half/double-tempo lock-in before anything downstream uses the grid.
    beat_times, tempo_bpm = _correct_tempo_octave(
        beat_frames, beat_times, onset_env, tempo_bpm, sample_rate
    )
    if tempo_bpm > 0:
        # Recompute confidence against the corrected grid, and refresh the frame
        # indices the meter estimator needs.
        _, tempo_confidence = _estimate_tempo(beat_times)
        beat_frames = librosa.time_to_frames(
            beat_times, sr=sample_rate, hop_length=HOP_LENGTH
        )
    if tempo_bpm <= 0.0:
        # Silence, dead air or a truncated download yields no usable grid.
        # Emit a nominal tempo rather than a zero the schema would reject:
        # consumers are already required to gate beat-driven motion on
        # `tempo_confidence`, and this keeps that the single check they need.
        logger.warning("No usable beat grid; falling back to %.0f BPM.", _FALLBACK_BPM)
        tempo_bpm, tempo_confidence = _FALLBACK_BPM, 0.0
    meter, meter_confidence, downbeats = _estimate_meter_and_downbeats(
        beat_frames, beat_times, onset_env
    )

    rms = librosa.feature.rms(S=spectrogram)[0]
    centroid = librosa.feature.spectral_centroid(S=spectrogram, sr=sample_rate)[0]

    energy = _normalise(rms)
    brightness = _normalise(centroid)

    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=N_FFT)
    band_curves: dict[str, npt.NDArray[np.float64]] = {}
    for name, (low, high) in _BANDS.items():
        band_mask = (frequencies >= low) & (frequencies < high)
        band_curves[name] = _normalise(spectrogram[band_mask].mean(axis=0))

    # Log-spaced spectrum. Logarithmic edges because pitch is perceived
    # logarithmically: linear bands would spend most of the display on the
    # inaudible upper octaves and cram all the musical content into two bars.
    spectrum_edges = np.geomspace(*SPECTRUM_RANGE_HZ, SPECTRUM_BANDS + 1)
    spectrum_curves: list[npt.NDArray[np.float64]] = []
    for index in range(SPECTRUM_BANDS):
        low, high = spectrum_edges[index], spectrum_edges[index + 1]
        band_mask = (frequencies >= low) & (frequencies < high)
        if not band_mask.any():
            # Narrow low bands can fall between FFT bins; borrow the nearest.
            nearest = int(np.argmin(np.abs(frequencies - (low + high) / 2)))
            band_mask = np.zeros_like(frequencies, dtype=bool)
            band_mask[nearest] = True
        # Independent normalisation per band, so the top octaves stay visible
        # rather than being crushed by bass energy an order of magnitude larger.
        spectrum_curves.append(_normalise(spectrogram[band_mask].mean(axis=0)))

    def lane(values: npt.NDArray[np.floating]) -> list[float]:
        return _to_fps_grid(values, frame_times, fps, duration)

    lanes = Lanes(
        fps=fps,
        frame_count=len(np.arange(0.0, duration, 1.0 / fps)),
        energy=lane(energy),
        punch=lane(_normalise(punch_env)),
        brightness=lane(brightness),
        flux=lane(_normalise(onset_env)),
        bass=lane(band_curves["bass"]),
        mid=lane(band_curves["mid"]),
        treble=lane(band_curves["treble"]),
        # Two decimals rather than three: a bar height needs far less precision
        # than a continuous curve, and this nearly halves the payload.
        spectrum=[
            [round(value, 2) for value in lane(curve)] for curve in spectrum_curves
        ],
    )

    sections = _segment_sections(
        spectrogram, beat_frames, beat_times, duration, energy, brightness, frame_times
    )

    logger.info(
        "Analysed %.1fs: %.1f BPM, %d beats, %d sections",
        duration,
        tempo_bpm,
        len(beat_times),
        len(sections),
    )

    lyrics_block = None
    if with_lyrics:
        # Transcription is slow and entirely optional: a failure here must never
        # cost the caller its analysis, so anything going wrong yields None and
        # the score is emitted without lyrics.
        words = transcribe(path)
        if words:
            lyrics_block = Lyrics(
                words=[
                    LyricWord(t=round(w.start, 2), d=round(w.end - w.start, 2), w=w.text)
                    for w in words
                ],
                sections=[
                    LyricMood(**vars(summarise(words, s.start_sec, s.end_sec)))
                    for s in sections
                ],
                overall=LyricMood(**vars(summarise(
                    words, 0.0, float(duration),
                ))),
            )

    return VisualScore(
        source=source
        or SourceRef(
            provider=Provider.LOCAL,
            provider_id=path.stem,
            title=path.stem,
            duration_sec=duration,
        ),
        analysis=AnalysisMeta(
            analyser_version=ANALYSER_VERSION,
            sample_rate=sample_rate,
            analysed_duration_sec=duration,
            is_partial=is_partial,
        ),
        timing=Timing(
            tempo_bpm=tempo_bpm,
            tempo_confidence=tempo_confidence,
            meter=meter,
            meter_confidence=meter_confidence,
            beats=[round(float(t), 4) for t in beat_times],
            downbeats=downbeats,
        ),
        lanes=lanes,
        lyrics=lyrics_block,
        sections=sections,
    )
