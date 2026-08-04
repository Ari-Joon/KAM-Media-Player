"""Persistent analysis worker.

Reads newline-delimited JSON requests from stdin and writes one JSON response per
line to stdout, staying alive between tracks.

## Why this exists

Spawning ``python -m visualcore.cli`` per track measured 9-10 seconds on a
four-minute file, while the same analysis in an already-warm process took 2.3-3.4
seconds. The difference is not module import - that is only about 0.3s once
numba's disk cache is populated - but JIT compilation that is not cached across
processes, paid again on every single track.

Keeping one process alive removes that entirely.

## Protocol

Request::

    {"id": 1, "audio": "/path/to.m4a", "provider": "youtube",
     "providerId": "abc", "title": "Some Track", "duration": 240}

Response::

    {"id": 1, "ok": true, "score": {...}}
    {"id": 1, "ok": false, "error": "message"}

One request is handled at a time. Analysis is CPU-bound, so concurrency here
would only add contention - the caller queues.

Anything written to stdout other than a response would corrupt the stream, so
logging goes to stderr and librosa's warnings are silenced.
"""

from __future__ import annotations

import json
import sys
import warnings

from .audio_analysis import ANALYSER_VERSION, analyse
from .schema import Provider, SourceRef

# librosa emits warnings on stderr; harmless, but noisy in a server log.
warnings.filterwarnings("ignore")


def _handle(request: dict) -> dict:
    """Analyse one file and return a response payload.

    Args:
        request: Decoded request object.

    Returns:
        A response dict, including ``ok`` and either ``score`` or ``error``.
    """
    request_id = request.get("id")
    try:
        provider_name = request.get("provider", "local")
        provider = Provider(provider_name) if provider_name in {
            p.value for p in Provider
        } else Provider.LOCAL

        source = SourceRef(
            provider=provider,
            provider_id=request.get("providerId"),
            title=request.get("title"),
            # A duration of zero would fail validation; fall back to something
            # positive and let the analyser report the real analysed length.
            duration_sec=max(float(request.get("duration") or 0.0), 1.0),
        )

        # A `quick` request analyses only the opening of the track, which
        # returns in well under a second and lets visuals start almost
        # immediately; the full analysis follows and replaces it.
        quick_seconds = request.get("quick")
        score = analyse(
            request["audio"],
            source=source,
            max_seconds=float(quick_seconds) if quick_seconds else None,
            # Requested explicitly, as a third pass after the full analysis has
            # already been delivered - transcription takes ten to thirty seconds
            # and must never sit between pressing play and seeing anything.
            with_lyrics=bool(request.get("lyrics")),
        )
        return {"id": request_id, "ok": True, "score": json.loads(score.model_dump_json())}
    except Exception as error:                      # noqa: BLE001 - reported to caller
        return {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}


def _warm_up() -> None:
    """Run one throwaway analysis so JIT compilation happens at startup.

    Without this the numba work is triggered by the first real request, which
    measured 8.5 seconds against 1.7-2.2 seconds for every request after it. Doing
    it here moves that cost off the first person to press play.

    A few seconds of noise exercises the same code paths as a real track.
    """
    import tempfile
    import numpy as np
    import soundfile as sf

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        path = handle.name
    try:
        sample_rate = 22_050
        noise = np.random.randn(sample_rate * 4).astype(np.float32) * 0.2
        # A pulse train as well, so beat tracking and onset detection compile too.
        for beat in range(8):
            start = int(beat * 0.5 * sample_rate)
            noise[start:start + 800] += 0.8
        sf.write(path, noise, sample_rate)
        analyse(path)
    except Exception as error:                      # noqa: BLE001 - non-fatal
        print(f"warm-up failed: {error}", file=sys.stderr, flush=True)
    finally:
        import os
        try:
            os.unlink(path)
        except OSError:
            pass


def main() -> int:
    """Serve requests until stdin closes."""
    _warm_up()
    # Announce readiness on stderr so the caller can log it without touching the
    # response stream.
    print(f"worker ready (analyser {ANALYSER_VERSION})", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({"id": None, "ok": False, "error": str(error)}), flush=True)
            continue

        response = _handle(request)
        # A single line, flushed immediately: the caller reads by line.
        print(json.dumps(response), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
