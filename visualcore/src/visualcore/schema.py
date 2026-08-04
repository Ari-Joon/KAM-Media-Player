"""Data contract for the visualiser pipeline.

A :class:`VisualScore` is the single artefact that travels between every stage:

    audio file -> analyse() -> VisualScore (timing + lanes + sections)
                            -> lyrics pass   (fills ``lyrics``)
                            -> LLM pass      (fills ``choreography``)
                            -> renderer      (reads everything, renders frames)

Design rules that downstream code depends on:

* **Everything is time-addressable.** The renderer knows only the server voice
  player's position in seconds and must be able to resolve any visual parameter
  from it without searching.
* **Lanes are fixed-rate.** A lane is a dense array sampled at
  :attr:`Lanes.fps`, so ``lane[int(t * fps)]`` is O(1). This is why the
  renderer never needs the original audio.
* **Lanes are normalised to 0.0-1.0** and rounded to 3 decimal places, which
  keeps the JSON small enough to ship to a browser without a binary format.
* **The schema is versioned.** Bump :data:`SCHEMA_VERSION` on any breaking
  change so cached scores from an older analyser are rejected, not
  misinterpreted.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1.2.0"
"""Semantic version of the VisualScore contract itself.

Increment the major component whenever a field is removed or its meaning
changes; the renderer refuses scores whose major version it was not built for.
"""

# A lane sample: normalised intensity in [0, 1].
UnitFloat = Annotated[float, Field(ge=0.0, le=1.0)]


class Provider(str, Enum):
    """Where the track can be played back from.

    Playback and analysis are deliberately decoupled: this field describes the
    *playback* embed the Activity will mount, not where the analysed audio came
    from.
    """

    YOUTUBE = "youtube"
    SOUNDCLOUD = "soundcloud"
    TIKTOK = "tiktok"
    INSTAGRAM = "instagram"
    LOCAL = "local"


class SourceRef(BaseModel):
    """Identifies the track and the embed needed to play it."""

    model_config = ConfigDict(extra="forbid")

    provider: Provider
    provider_id: str | None = Field(
        default=None,
        description="Provider-native ID (e.g. a YouTube video ID). Used as the "
        "cache key together with `provider`.",
    )
    url: str | None = None
    title: str | None = None
    artist: str | None = None
    duration_sec: float = Field(gt=0.0)


class AnalysisMeta(BaseModel):
    """Provenance for a score, so stale caches can be identified and purged."""

    model_config = ConfigDict(extra="forbid")

    schema_version: str = SCHEMA_VERSION
    analyser_version: str = Field(
        description="Version of the DSP code that produced this score. Bump it "
        "whenever the analysis changes, to invalidate cached scores."
    )
    sample_rate: int = Field(gt=0, description="Sample rate used for analysis, in Hz.")
    analysed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    analysed_duration_sec: float = Field(
        gt=0.0,
        description="Length of audio actually analysed. Less than "
        "`SourceRef.duration_sec` when only a preview clip was available, in "
        "which case timing is extrapolated and sections are unreliable.",
    )
    is_partial: bool = Field(
        default=False,
        description="True when analysis covered only part of the track (e.g. a "
        "30-second preview). The renderer should fall back to beat-grid-only "
        "visuals beyond `analysed_duration_sec`.",
    )


class Timing(BaseModel):
    """The rhythmic skeleton: what the visuals snap to."""

    model_config = ConfigDict(extra="forbid")

    tempo_bpm: float = Field(gt=0.0)
    tempo_confidence: UnitFloat = Field(
        description="Agreement between the tracked beats and a perfectly even "
        "grid at `tempo_bpm`. Below ~0.5, prefer continuous lanes over "
        "beat-snapped motion."
    )
    meter: Literal[3, 4] = Field(
        default=4, description="Beats per bar, estimated heuristically."
    )
    meter_confidence: UnitFloat = Field(
        default=0.0,
        description="How much more accented the chosen bar phase is than the "
        "average phase. Low values mean the track has no clear bar accent "
        "(common in ambient or heavily sidechained material) and `downbeats` "
        "should not drive anything structural.",
    )
    beats: list[float] = Field(
        description="Beat onset times in seconds, ascending, from the start of "
        "the analysed audio."
    )
    downbeats: list[float] = Field(
        description="Subset of `beats` estimated to fall on beat one of a bar. "
        "Heuristic - use for accents, not for anything that breaks visibly "
        "when wrong."
    )


class Lanes(BaseModel):
    """Dense, fixed-rate feature curves driving continuous motion.

    Every lane has exactly :attr:`frame_count` samples in [0, 1]. Index with
    ``int(playback_seconds * fps)``, clamped to ``frame_count - 1``.
    """

    model_config = ConfigDict(extra="forbid")

    fps: int = Field(gt=0, description="Samples per second for every lane below.")
    frame_count: int = Field(gt=0)

    energy: list[UnitFloat] = Field(
        description="Broadband loudness (RMS). Drives overall scale/brightness."
    )
    punch: list[UnitFloat] = Field(
        description="Percussive onset strength. Drives hits, kicks, snaps."
    )
    brightness: list[UnitFloat] = Field(
        description="Spectral centroid. Drives hue/temperature - low is warm "
        "and heavy, high is sharp and cold."
    )
    flux: list[UnitFloat] = Field(
        description="Spectral change rate. Drives how fast the scene mutates."
    )
    bass: list[UnitFloat] = Field(description="Band energy, roughly 20-250 Hz.")
    mid: list[UnitFloat] = Field(description="Band energy, roughly 250-4000 Hz.")
    treble: list[UnitFloat] = Field(description="Band energy, roughly 4-11 kHz.")

    spectrum: list[list[UnitFloat]] = Field(
        default_factory=list,
        description="Log-spaced band energies: one inner list per band, each "
        "`frame_count` long. Exists so spectrum-analyser visualisations show "
        "real per-band levels rather than an interpolation of the three coarse "
        "bands above, which cannot represent a real EQ curve. Each band is "
        "normalised independently, so quiet high bands remain visible instead of "
        "being flattened by dominant bass.",
    )


class Section(BaseModel):
    """A structurally homogeneous span - the unit a choreography move maps to."""

    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    start_sec: float = Field(ge=0.0)
    end_sec: float = Field(gt=0.0)
    energy_mean: UnitFloat
    brightness_mean: UnitFloat
    label: str | None = Field(
        default=None,
        description="Human/LLM label such as 'verse' or 'drop'. The DSP stage "
        "leaves this null; the choreography pass fills it in.",
    )


class LyricMood(BaseModel):
    """What a section's lyrics are about, as numbers a renderer can use."""

    valence: float = Field(
        default=0.0, ge=-1.0, le=1.0,
        description="-1 bleak to +1 elated, from the sentiment of the words.",
    )
    arousal: float = Field(
        default=0.0, ge=0.0, le=1.0,
        description="0 still to 1 agitated. Measured separately from valence "
        "because anger is intense and negative while calm joy is neither.",
    )
    density: float = Field(
        default=0.0, ge=0.0,
        description="Words per second, which distinguishes rapping from a ballad "
        "regardless of how loud either is.",
    )
    theme: str | None = Field(
        default=None,
        description="Strongest theme found: motion, romance, defiance, "
        "celebration, melancholy or aspiration. Null when nothing dominates.",
    )
    keywords: list[str] = Field(
        default_factory=list,
        description="Distinct sentiment-bearing words, for renderers that want "
        "to react to specific ones.",
    )


class LyricWord(BaseModel):
    """One transcribed word with its timing."""

    t: float = Field(description="Start time in seconds.")
    d: float = Field(description="Duration in seconds.")
    w: str = Field(description="The word.")


class Lyrics(BaseModel):
    """Transcribed lyrics and their per-section mood.

    Absent entirely when transcription is unavailable, so every consumer must
    treat this as optional.
    """

    words: list[LyricWord] = Field(
        default_factory=list,
        description="Every transcribed word, in order. Field names are single "
        "letters because this is the largest part of the payload - a four-minute "
        "track has around eight hundred entries.",
    )
    sections: list[LyricMood] = Field(
        default_factory=list,
        description="One mood summary per section, aligned by index with "
        "`sections`.",
    )
    overall: LyricMood = Field(
        default_factory=LyricMood,
        description="Mood across the whole track.",
    )


class VisualScore(BaseModel):
    """Everything the renderer needs, and nothing it has to compute itself."""

    model_config = ConfigDict(extra="forbid")

    source: SourceRef
    analysis: AnalysisMeta
    timing: Timing
    lanes: Lanes
    sections: list[Section]

    lyrics: dict | None = Field(
        default=None,
        description="Reserved for the timed-lyrics pass. Never rendered as "
        "on-screen text - it exists to inform choreography intent only.",
    )
    choreography: dict | None = Field(
        default=None,
        description="Reserved for the LLM pass: per-section palette, move set "
        "and intensity curve. Absent means the renderer uses lane-driven "
        "defaults.",
    )

    def lane_index(self, playback_sec: float) -> int:
        """Resolve a playback position to a lane index, clamped in range.

        Args:
            playback_sec: Position reported by the embedded player, in seconds.

        Returns:
            An index valid for every lane array.
        """
        raw = int(playback_sec * self.lanes.fps)
        return max(0, min(raw, self.lanes.frame_count - 1))

    def section_at(self, playback_sec: float) -> Section | None:
        """Return the section containing ``playback_sec``, or None if past the end."""
        for section in self.sections:
            if section.start_sec <= playback_sec < section.end_sec:
                return section
        return None
