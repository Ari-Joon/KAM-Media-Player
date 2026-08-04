"""Command-line entry point for the analysis stage.

Usage::

    python -m visualcore.cli track.mp3 -o score.json
    python -m visualcore.cli preview.m4a --partial --provider youtube \\
        --provider-id dQw4w9WgXcQ --fps 60
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .audio_analysis import DEFAULT_FPS, analyse
from .schema import Provider, SourceRef


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="visualcore",
        description="Analyse an audio file into a VisualScore JSON document.",
    )
    parser.add_argument("audio", type=Path, help="Path to the audio file.")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Where to write the score. Defaults to <audio>.score.json.",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=DEFAULT_FPS,
        help=f"Lane sample rate (default: {DEFAULT_FPS}).",
    )
    parser.add_argument(
        "--partial",
        action="store_true",
        help="Mark the input as a preview clip rather than the full track.",
    )
    parser.add_argument(
        "--provider",
        type=Provider,
        choices=list(Provider),
        default=Provider.LOCAL,
        help="Playback provider to record in the score (default: local).",
    )
    parser.add_argument(
        "--provider-id", help="Provider-native track ID, e.g. a YouTube video ID."
    )
    parser.add_argument("--url", help="Playback URL.")
    parser.add_argument("--title", help="Track title.")
    parser.add_argument("--artist", help="Track artist.")
    parser.add_argument(
        "--duration",
        type=float,
        help="True full-track duration in seconds. Required with --partial so "
        "the renderer knows how much of the track the analysis covers.",
    )
    parser.add_argument(
        "--indent",
        type=int,
        default=None,
        help="Pretty-print the JSON with this indent. Omit for compact output.",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Log analysis progress."
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the CLI.

    Args:
        argv: Argument list, defaulting to ``sys.argv[1:]``.

    Returns:
        Process exit code: 0 on success, 1 on a handled error.
    """
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )

    if args.partial and args.duration is None:
        print("error: --partial requires --duration", file=sys.stderr)
        return 1

    source = None
    if args.provider is not Provider.LOCAL or args.provider_id or args.url:
        if args.duration is None:
            print(
                "error: --duration is required when a playback source is given",
                file=sys.stderr,
            )
            return 1
        source = SourceRef(
            provider=args.provider,
            provider_id=args.provider_id,
            url=args.url,
            title=args.title,
            artist=args.artist,
            duration_sec=args.duration,
        )

    try:
        score = analyse(
            args.audio, source=source, fps=args.fps, is_partial=args.partial
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    output = args.output or args.audio.with_suffix(".score.json")
    output.write_text(score.model_dump_json(indent=args.indent), encoding="utf-8")

    print(
        f"{output}  |  {score.timing.tempo_bpm:.1f} BPM "
        f"(confidence {score.timing.tempo_confidence:.2f}, {score.timing.meter}/4)  |  "
        f"{len(score.timing.beats)} beats  |  {len(score.sections)} sections  |  "
        f"{output.stat().st_size / 1024:.0f} KB"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
