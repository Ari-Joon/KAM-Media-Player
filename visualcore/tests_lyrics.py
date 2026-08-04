"""Mood analysis tests. Transcription itself needs a model, so it is not tested
here; the summarisation that everything downstream depends on is."""
from visualcore.lyrics import summarise, Word

def words(text, step=0.4):
    return [Word(text=w, start=i*step, end=i*step+0.3) for i, w in enumerate(text.split())]

cases = [
    ("love you forever my heart beautiful sweet", "romance", 1),
    ("alone broken tears cold dark empty gone", "melancholy", -1),
    ("run drive road go away chase escape", "motion", None),
    ("party dance tonight club friends music floor", "celebration", 1),
    ("fight stand never against strong rise battle", "defiance", None),
    ("dream sky star higher believe hope reach", "aspiration", 1),
]
for text, theme, sign in cases:
    s = summarise(words(text), 0, len(text.split()) * 0.4)
    assert s.theme == theme, f"{text!r}: got theme {s.theme}, expected {theme}"
    if sign is not None:
        assert (s.valence > 0) == (sign > 0), f"{text!r}: valence {s.valence} wrong sign"
print(f"themes: {len(cases)}/{len(cases)} pass")

# Arousal must be independent of valence: anger is intense and negative.
angry = summarise(words("fight burn rage war blood kill scream"), 0, 2.8)
calm = summarise(words("love sweet warm gentle hope dream"), 0, 2.4)
assert angry.arousal > calm.arousal, "angry lyrics should read as more aroused"
assert angry.valence < 0 and calm.valence > 0
print("valence and arousal separate correctly")

# An empty or instrumental span returns neutral values, never None.
empty = summarise([], 0, 10)
assert empty.theme is None and empty.valence == 0 and empty.density == 0
print("empty span handled")

# Density distinguishes delivery at equal loudness.
dense = summarise(words("one two three four five six seven eight", 0.15), 0, 1.2)
sparse = summarise(words("one two three", 1.5), 0, 4.5)
assert dense.density > sparse.density * 3
print(f"density: {dense.density:.1f}/s vs {sparse.density:.1f}/s")
print("lyrics: 4/4 groups pass")
