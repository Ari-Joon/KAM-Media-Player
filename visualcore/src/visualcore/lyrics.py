"""Lyric transcription and mood analysis.

Produces word-level timings from a track's audio, plus a per-section summary of
what the words are *about*, which the visualiser uses to choose choreography and
colour.

## Why this is optional

`faster-whisper` pulls in CTranslate2 and downloads a model on first use, which
is a meaningful ask for someone who only wants a music bot. Everything here
degrades to returning ``None``, and the analyser emits a score without a
``lyrics`` block, which every visualisation already handles - they fall back to
reading section energy and brightness as they did before.

Install it with::

    pip install faster-whisper

## Why the small model

``base`` transcribes roughly ten times faster than real time on a CPU and is
accurate enough for the purpose here. Nothing downstream needs a perfect
transcript: choreography reads sentiment and keywords, so an occasional
misheard word changes nothing. A larger model would triple the runtime for
accuracy no one would see.

## Why mood is computed here rather than in the client

The word list for a four-minute track is a few thousand entries. Summarising it
server-side into a handful of numbers per section means the client receives
something small and immediately usable, rather than several hundred kilobytes it
would have to analyse on every frame.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# Model size. See the note above on why this is not larger.
MODEL_SIZE = "base"

# Cached between tracks: loading takes several seconds and the worker is
# long-lived, so paying it once rather than per track matters.
_MODEL = None
_MODEL_FAILED = False


@dataclass
class Word:
    """One transcribed word with its timing."""

    text: str
    start: float
    end: float


@dataclass
class MoodSummary:
    """What a span of lyrics is about, as numbers a renderer can use."""

    # -1 (bleak) to +1 (elated).
    valence: float = 0.0
    # 0 (still) to 1 (agitated).
    arousal: float = 0.0
    # Words per second, which tracks delivery: rapping against a ballad.
    density: float = 0.0
    # The strongest theme found, or None.
    theme: str | None = None
    # Distinct keywords that fired, for the client to use directly.
    keywords: list[str] = field(default_factory=list)


# Sentiment lexicon.
#
# Deliberately small and hand-picked rather than a general-purpose model: song
# lyrics use a narrow emotional vocabulary, and a hundred well-chosen words
# cover most of it. A full sentiment model would add a large dependency to
# decide something the visualiser only needs approximately.
_POSITIVE = {
    "love", "loving", "loved", "happy", "smile", "smiling", "shine", "shining",
    "bright", "beautiful", "sweet", "dance", "dancing", "high", "fly", "flying",
    "free", "alive", "good", "best", "heaven", "angel", "sunshine", "sunny",
    "gold", "golden", "dream", "dreaming", "warm", "hope", "joy", "celebrate",
    "party", "laugh", "laughing", "kiss", "kissing", "heart", "forever", "yes",
    "win", "winning", "rise", "rising", "glow", "glowing", "magic", "wonderful",
}

_NEGATIVE = {
    "hate", "hurt", "hurting", "pain", "cry", "crying", "tears", "broken",
    "break", "breaking", "lost", "lose", "losing", "alone", "lonely", "dark",
    "darkness", "cold", "死", "die", "dying", "dead", "kill", "killing", "blood",
    "war", "fight", "fighting", "hell", "sad", "sorry", "gone", "leave",
    "leaving", "fall", "falling", "down", "empty", "numb", "afraid", "fear",
    "scared", "regret", "goodbye", "never", "nothing", "wrong", "bad", "sick",
}

# High-arousal words, which drive movement rather than colour. A lyric can be
# negative and still frantic - anger is not sadness - so this is measured
# separately from valence.
_INTENSE = {
    "run", "running", "fight", "fighting", "burn", "burning", "fire", "wild",
    "crazy", "loud", "scream", "screaming", "shout", "shouting", "jump",
    "jumping", "move", "moving", "shake", "shaking", "hit", "hard", "fast",
    "rush", "blast", "explode", "smash", "beat", "pump", "energy", "power",
    "go", "now", "never", "kill", "war", "blood", "rage", "hype", "up",
}

# Themes, each with the words that signal it. The visualiser maps these onto
# choreography: a track about motion should not be danced standing still.
_THEMES: dict[str, set[str]] = {
    "motion": {"run", "running", "drive", "road", "go", "away", "chase", "ride",
               "fly", "flying", "move", "moving", "race", "escape", "leave"},
    "romance": {"love", "kiss", "heart", "baby", "girl", "boy", "hold", "touch",
                "together", "forever", "mine", "yours", "arms", "close"},
    "defiance": {"fight", "stand", "won't", "can't", "never", "against", "beat",
                 "back", "strong", "rise", "enemy", "war", "battle", "own"},
    "celebration": {"party", "dance", "night", "club", "drink", "celebrate",
                    "friends", "tonight", "music", "floor", "hands", "up"},
    "melancholy": {"alone", "lonely", "cry", "tears", "miss", "gone", "empty",
                   "rain", "cold", "sad", "memory", "remember", "used", "yesterday"},
    "aspiration": {"dream", "sky", "star", "stars", "higher", "top", "believe",
                   "hope", "future", "rise", "climb", "reach", "someday"},
}


def _load_model():
    """Load the transcription model, once.

    Returns:
        A ``WhisperModel``, or ``None`` if the package is unavailable or the
        model could not be fetched.
    """
    global _MODEL, _MODEL_FAILED

    if _MODEL is not None or _MODEL_FAILED:
        return _MODEL

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        logger.info("faster-whisper not installed; lyrics will be skipped")
        _MODEL_FAILED = True
        return None

    try:
        # int8 on CPU: roughly twice as fast as float32 with no accuracy loss
        # that matters for keyword extraction.
        _MODEL = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        logger.info("lyrics: loaded %s model", MODEL_SIZE)
    except Exception as error:  # noqa: BLE001 - any failure means no lyrics
        logger.warning("lyrics: could not load model (%s); skipping", error)
        _MODEL_FAILED = True
        return None

    return _MODEL


#: Below this, a VAD-filtered result is treated as a failure rather than as an
#: instrumental, and the decode is retried without it.
#:
#: Measured across four cached tracks: songs with vocals came back with 267,
#: 300, 501 and 673 words, while a genuinely instrumental one gave 2. Anywhere
#: in the wide gap between works; twenty is far enough above the instrumental
#: case to avoid pointless second passes and far enough below the real ones to
#: never reject a transcript.
MIN_PLAUSIBLE_WORDS = 20


def transcribe(audio_path: str | Path, max_seconds: float | None = None) -> list[Word] | None:
    """Transcribe a track's vocals to timed words.

    Args:
        audio_path: Local audio file.
        max_seconds: Stop after this much audio, for a quick partial pass.

    Returns:
        Words in order, or ``None`` if transcription is unavailable.
    """
    model = _load_model()
    if model is None:
        return None

    def decode(**vad: object) -> list[Word]:
        segments, _info = model.transcribe(
            str(audio_path),
            word_timestamps=True,
            # Greedy decoding: beam search costs several times more for a
            # transcript nobody reads.
            beam_size=1,
            condition_on_previous_text=False,
            **vad,
        )
        found: list[Word] = []
        for segment in segments:
            if max_seconds is not None and segment.start > max_seconds:
                break
            for word in segment.words or []:
                cleaned = word.word.strip()
                if cleaned:
                    found.append(Word(text=cleaned, start=word.start, end=word.end))
        return found

    try:
        # Voice activity detection was meant to skip instrumental passages, and
        # on this material it skips everything.
        #
        # Measured on a six-minute track: ``VAD filter removed 06:06.922 of
        # audio`` - the whole file - and the pass returned 0 words in 1.1s.
        # Silero is trained on speech, and sung vocals over a full mix do not
        # look like speech to it. Dropping the threshold to 0.2 recovered one
        # word. So this was never a tuning problem, and it is why the lyric
        # visuals were empty while the worker looked like it was doing its job.
        #
        # Kept as a first attempt rather than deleted, because when it does work
        # it genuinely removes a third of the decode - and falling back costs
        # nothing but the second pass on tracks where it has already failed.
        words = decode(
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 700},
        )
        if len(words) >= MIN_PLAUSIBLE_WORDS:
            logger.info("lyrics: %d words transcribed", len(words))
            return words

        # A near-empty result is not "this track is instrumental" - it is much
        # more often VAD having eaten the vocal, and the two are told apart by
        # retrying without it. Only genuinely instrumental tracks pay for the
        # second pass.
        #
        # The bar is a count rather than emptiness. Testing only for empty was
        # not enough: VAD left four words on a four-minute Weeknd track, which
        # is plainly not a transcript but is not nothing either, so the retry
        # never ran and the lyric visuals stayed blank with a successful-looking
        # log line saying "4 words".
        logger.info(
            "lyrics: VAD left only %d words; retrying without it", len(words),
        )
        words = decode(vad_filter=False)
        logger.info("lyrics: %d words transcribed without VAD", len(words))
        return words
    except Exception as error:  # noqa: BLE001 - never fail the analysis
        logger.warning("lyrics: transcription failed (%s)", error)
        return None


def _normalise(word: str) -> str:
    """Reduce a word to a comparable form."""
    return re.sub(r"[^\w']", "", word.lower())


def summarise(words: list[Word], start: float, end: float) -> MoodSummary:
    """Summarise the mood of the words falling within a time span.

    Args:
        words: All transcribed words.
        start: Span start, in seconds.
        end: Span end, in seconds.

    Returns:
        A summary. An empty span returns neutral values rather than ``None``, so
        callers never have to special-case it.
    """
    span = [w for w in words if start <= w.start < end]
    duration = max(end - start, 0.001)

    if not span:
        return MoodSummary(density=0.0)

    tokens = [_normalise(w.text) for w in span]
    tokens = [t for t in tokens if t]

    positive = sum(1 for t in tokens if t in _POSITIVE)
    negative = sum(1 for t in tokens if t in _NEGATIVE)
    intense = sum(1 for t in tokens if t in _INTENSE)

    # Valence as a proportion of *matched* words, not of all words: a verse with
    # three positive words and nothing else negative is positive, however many
    # filler words surround them.
    matched = positive + negative
    valence = (positive - negative) / matched if matched else 0.0

    # Arousal is a rate rather than a proportion, because intensity is about how
    # often forceful words arrive, not what share of the line they occupy.
    arousal = min(1.0, intense / duration * 2.5)

    theme_scores = {
        name: sum(1 for t in tokens if t in vocabulary)
        for name, vocabulary in _THEMES.items()
    }
    best = max(theme_scores.items(), key=lambda item: item[1])
    theme = best[0] if best[1] >= 2 else None

    keywords = sorted({
        t for t in tokens
        if t in _POSITIVE or t in _NEGATIVE or t in _INTENSE
    })

    return MoodSummary(
        valence=round(valence, 3),
        arousal=round(arousal, 3),
        density=round(len(span) / duration, 2),
        theme=theme,
        keywords=keywords[:12],
    )
