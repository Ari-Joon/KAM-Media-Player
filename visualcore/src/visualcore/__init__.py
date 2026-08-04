"""Music-reactive visualiser core: audio analysis and the VisualScore contract."""

from .audio_analysis import ANALYSER_VERSION, analyse
from .schema import (
    SCHEMA_VERSION,
    AnalysisMeta,
    Lanes,
    Provider,
    Section,
    SourceRef,
    Timing,
    VisualScore,
)

__all__ = [
    "ANALYSER_VERSION",
    "SCHEMA_VERSION",
    "AnalysisMeta",
    "Lanes",
    "Provider",
    "Section",
    "SourceRef",
    "Timing",
    "VisualScore",
    "analyse",
]
