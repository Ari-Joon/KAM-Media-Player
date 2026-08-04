"""Diagnose tempo detection against a real Apple preview clip.

The analyser can only be validated so far with synthetic audio: librosa handles
every half-tempo case that can be constructed cleanly, yet production reported
86 BPM for a 171 BPM track. That gap means the real preview clip has to be
measured directly.

Run this on a machine with internet access:

    python -m visualcore.diagnose "blinding lights the weeknd"
    python -m visualcore.diagnose "blinding lights the weeknd" --keep

It fetches the same preview the bot would, analyses it, and prints what the
tempo estimator decided and why - including whether octave correction fired and
how strong the evidence was.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from .audio_analysis import ANALYSER_VERSION, analyse

ITUNES_SEARCH = "https://itunes.apple.com/search"


def fetch_preview(term: str) -> tuple[Path, dict]:
    """Download the first usable Apple preview clip for a search term.

    Args:
        term: Search phrase, ideally "artist title".

    Returns:
        Path to the downloaded clip and the matched catalogue entry.

    Raises:
        RuntimeError: If nothing with a preview URL is found.
    """
    query = urllib.parse.urlencode(
        {"term": term, "media": "music", "entity": "song", "limit": "5"}
    )
    with urllib.request.urlopen(f"{ITUNES_SEARCH}?{query}", timeout=20) as response:
        payload = json.load(response)

    for result in payload.get("results", []):
        if result.get("previewUrl"):
            target = Path(tempfile.gettempdir()) / "visualcore_preview.m4a"
            with urllib.request.urlopen(result["previewUrl"], timeout=30) as audio:
                target.write_bytes(audio.read())
            return target, result

    raise RuntimeError(f'No preview with audio found for "{term}".')


def main(argv: list[str] | None = None) -> int:
    """Fetch, analyse and report. Returns a process exit code."""
    parser = argparse.ArgumentParser(
        prog="visualcore.diagnose",
        description="Analyse a real Apple preview clip and report tempo findings.",
    )
    parser.add_argument("term", help='Search phrase, e.g. "blinding lights the weeknd"')
    parser.add_argument(
        "--expect",
        type=float,
        help="Known true BPM. When given, the ratio to the measured value is "
        "reported, which makes an octave error obvious.",
    )
    parser.add_argument(
        "--keep", action="store_true", help="Keep the downloaded clip for inspection."
    )
    args = parser.parse_args(argv)

    # Octave-correction decisions are logged at INFO by the analyser.
    logging.basicConfig(level=logging.INFO, format="  %(message)s")

    try:
        clip, matched = fetch_preview(args.term)
    except Exception as error:                      # noqa: BLE001 - report and exit
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"matched   : {matched.get('artistName')} - {matched.get('trackName')}")
    print(f"album     : {matched.get('collectionName')}")
    print(f"full track: {(matched.get('trackTimeMillis') or 0) / 1000:.0f}s")
    print(f"clip      : {clip} ({clip.stat().st_size / 1024:.0f} KB)")
    print(f"analyser  : v{ANALYSER_VERSION}")
    print("\nanalysing (octave decisions appear below if any fired):")

    score = analyse(clip, is_partial=True)
    timing = score.timing

    print(f"\ntempo     : {timing.tempo_bpm} BPM")
    print(f"confidence: {timing.tempo_confidence}")
    print(f"meter     : {timing.meter}/4 (confidence {timing.meter_confidence})")
    print(f"beats     : {len(timing.beats)} over {score.analysis.analysed_duration_sec:.1f}s")

    if args.expect:
        ratio = timing.tempo_bpm / args.expect
        verdict = "correct"
        if abs(ratio - 0.5) < 0.04:
            verdict = "HALF-TEMPO octave error"
        elif abs(ratio - 2.0) < 0.08:
            verdict = "DOUBLE-TEMPO octave error"
        elif abs(ratio - 1.0) > 0.04:
            verdict = "wrong, but not an octave error"
        print(f"expected  : {args.expect} BPM -> ratio {ratio:.3f} ({verdict})")

    # Interval histogram exposes an unstable grid that a single tempo figure hides.
    intervals = np.diff(np.array(timing.beats))
    if intervals.size:
        print(
            f"intervals : median {np.median(intervals) * 1000:.0f}ms, "
            f"spread {np.std(intervals) * 1000:.0f}ms, "
            f"min {intervals.min() * 1000:.0f} / max {intervals.max() * 1000:.0f}ms"
        )

    energy = np.array(score.lanes.energy)
    print(
        f"energy    : mean {energy.mean():.3f}, "
        f"quiet frames (<0.1) {100 * (energy < 0.1).mean():.0f}%"
    )
    print(f"sections  : {len(score.sections)}")

    if not args.keep:
        clip.unlink(missing_ok=True)
    else:
        print(f"\nclip kept at {clip}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
