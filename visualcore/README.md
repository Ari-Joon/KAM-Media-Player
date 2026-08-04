# visualcore — analysis stage

Turns an audio file into a **VisualScore**: the JSON contract used by the
Activity's stick figures, shader, and canvas renderers. Analysis runs once per
track and is cached; browser renderers consume the score rather than raw audio.

## Install

```powershell
cd "C:\Projects\Discord Media Player"
python -m pip install -r visualcore\requirements.txt
```

## Use

```powershell
cd "C:\Projects\Discord Media Player"
# Local file
python -m visualcore.cli track.mp3 -o score.json -v

# A partial analysis associated with a longer remote track
python -m visualcore.cli preview.m4a --partial --duration 214 --provider youtube --provider-id dQw4w9WgXcQ
```

```python
from visualcore import analyse
score = analyse("track.mp3")
frame = score.lane_index(playback_seconds)   # O(1)
intensity = score.lanes.energy[frame]
```

## The contract

| Block | What it is | Renderer uses it for |
|---|---|---|
| `timing` | tempo, meter, beat times, downbeat times | snapping motion to the grid |
| `lanes` | 7 dense curves at 30 fps, all normalised 0–1 | continuous motion, colour, scale |
| `sections` | contiguous structural spans | palette and move-set changes |
| `lyrics` | reserved, next stage | choreography intent only, never on screen |
| `choreography` | reserved, LLM stage | per-section palette and moves |

Three rules the renderer must follow:

1. **Index, don't search.** `lane[int(t * fps)]`. Lanes are dense and
   fixed-rate specifically so playback position resolves in constant time.
2. **Gate on confidence.** `tempo_confidence` below ~0.5 means beat-snapped
   motion will look wrong — lean on `energy`/`flux` instead. `meter_confidence`
   below ~0.1 means `downbeats` are guesswork; don't hang structure on them.
3. **Check `is_partial`.** Past `analysed_duration_sec`, lane data does not
   exist. Degrade to the extrapolated beat grid.

## Tuning constants

All in `audio_analysis.py`: `SAMPLE_RATE` 22050, `HOP_LENGTH` 512,
`DEFAULT_FPS` 30, `_BANDS` (bass/mid/treble edges), `_SECONDS_PER_SECTION` 18,
`_MIN_SECTION_SEC` 4.

## Measured behaviour

Validated against a synthetic 64s 4/4 track at exactly 120 BPM with a
structural change at the midpoint.

- Tempo recovered as **119.98 BPM**, confidence 0.977.
- Section boundary found at **32.79s** against a true change at 32.0s.
- **~11× realtime warm** (5.6s for 64s audio). HPSS is ~3s of that and is the
  first thing to cut if latency matters.
- **First call in a process costs ~35s extra** for numba JIT and librosa's lazy
  imports. Warm the analyser at bot startup or the first request will stall.

Degenerate inputs, all covered by the checks in `analyse()`: silence yields a
nominal 120 BPM at confidence 0.0; audio under 1s raises `ValueError`; a
missing path raises `FileNotFoundError`.

## Known limits

- **Meter and downbeats are heuristic**, from accent-phase scoring rather than
  a trained model. `meter_confidence` reports how weak the evidence was.
- **Section labels are empty here.** The DSP stage finds boundaries; naming
  them "verse" or "drop" is the LLM pass's job.
- **Tempo is a single global value.** Tracks with a genuine tempo change will
  show a low `tempo_confidence` rather than a segmented tempo map.
- **Preview-length analysis cannot see structure.** 30s of a track gives a
  usable beat grid and palette but meaningless sections.

## Integration

The Node analyser bridge keeps one Python worker alive so librosa and numba pay
their import/JIT cost once. The Activity first receives a quick partial score,
then replaces it with the completed full-track analysis and caches that result
by analyser version.
