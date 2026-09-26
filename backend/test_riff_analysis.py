"""
Riff analysis tests against synthesized audio with a known ground truth.

Each case renders a strummed chord progression at a known tempo, key and
start offset, then asserts the analysis recovers exactly those values.

Run from backend/ with:
    .venv/bin/python test_riff_analysis.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf

SR = 44100

NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
        "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def _chord_pitches(name: str):
    minor = name.endswith("m")
    root = NOTE[name[:-1] if minor else name]
    third = 3 if minor else 4
    # Bass root in octave 2 (MIDI 36 = C2), a triad in octave 3, the root doubled in octave 4
    return [36 + root, 48 + root, 48 + root + third, 48 + root + 7, 60 + root]


def _pluck(freq: float, dur: float, amp: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    tone = sum((0.6 ** h) * np.sin(2 * np.pi * freq * (h + 1) * t) for h in range(6))
    env = np.exp(-t * 5.0) * np.minimum(1.0, t / 0.004)
    return (amp * tone * env).astype(np.float32)


def synth_riff(path: str, chords, bpm: float, lead_in: float, repeats: int = 2, offbeats: bool = False):
    beat = 60.0 / bpm
    bars = len(chords) * repeats
    total = lead_in + bars * 4 * beat + 1.0
    buf = np.zeros(int(total * SR), dtype=np.float32)
    for bar in range(bars):
        pitches = _chord_pitches(chords[bar % len(chords)])
        for b in range(4):
            hits = [(b, 1.0 if b == 0 else 0.7)]
            if offbeats:
                hits.append((b + 0.5, 0.35))
            for pos, amp in hits:
                t0 = lead_in + (bar * 4 + pos) * beat
                for i, p in enumerate(pitches):
                    freq = 440.0 * 2 ** ((p - 69) / 12)
                    start = int((t0 + i * 0.008) * SR)
                    note = _pluck(freq, beat * 1.2, 0.12 * amp)
                    end = min(len(buf), start + len(note))
                    buf[start:end] += note[: end - start]
    buf /= np.max(np.abs(buf)) / 0.8
    sf.write(path, buf, SR, subtype="PCM_16")


CASES = [
    # name, chords, bpm, lead-in seconds, expected key, offbeat strums
    ("100 BPM A minor", ["Am", "F", "C", "G"], 100.0, 0.25, "A minor", False),
    ("120 BPM E major with offbeat strums", ["E", "B", "C#m", "A"], 120.0, 0.0, "E major", True),
    ("84 BPM D minor spelled with flats", ["Dm", "Bb", "F", "C"], 84.0, 0.5, "D minor", False),
]


def run_case(name, chords, bpm, lead_in, key, offbeats):
    from pipelines.riff_analysis import analyze_riff

    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "riff.wav")
        synth_riff(path, chords, bpm, lead_in, repeats=2, offbeats=offbeats)
        r = analyze_riff(path)

    got = [c["chord"] for c in r["chords"]]
    print(f"  {name}: tempo={r['tempo']} ({r['tempo_confidence']}%) key={r['key']} ({r['key_confidence']}%) "
          f"start={r['start']} bars={r['bars']} chords={got}")

    assert abs(r["tempo"] - bpm) <= 1.5, f"{name}: tempo {r['tempo']} != {bpm}"
    assert int(round(bpm)) in r["tempo_options"], f"{name}: tempo options {r['tempo_options']}"
    assert r["key"] == key, f"{name}: key {r['key']} != {key}"
    assert r["key"] in r["key_options"], "detected key missing from key_options"
    assert abs(r["start"] - lead_in) <= 0.06, f"{name}: bar 1 starts at {r['start']}, expected {lead_in}"
    assert r["bars"] == len(chords) * 2, f"{name}: bars {r['bars']} != {len(chords) * 2}"
    expected = [chords[i % len(chords)] for i in range(r["bars"])]
    assert got == expected, f"{name}: chords {got} != {expected}"
    for c in r["chords"]:
        assert c["chord"] == c["options"][0] and len(c["options"]) >= 2
        assert isinstance(c["confidence"], int) and 0 <= c["confidence"] <= 100

    # Every downbeat strum is an accent, and accents sit on whole beats
    downbeats = {bar * 4 for bar in range(r["bars"])}
    accent_beats = [a["beat"] for a in r["accents"]]
    for d in downbeats:
        assert any(abs(b - d) < 0.15 for b in accent_beats), f"{name}: no accent near beat {d}"
    for b in accent_beats:
        assert abs(b - round(b)) < 0.15, f"{name}: accent at beat {b} is off the grid"

    assert 300 <= len(r["peaks"]) <= 400
    assert all(isinstance(v, int) for v in (r["tempo_confidence"], r["key_confidence"], r["bars"]))
    print(f"  PASS: {name}")


def test_rejects_silence_and_short_audio():
    from pipelines.riff_analysis import analyze_riff

    with tempfile.TemporaryDirectory() as tmp:
        silent = str(Path(tmp) / "silent.wav")
        sf.write(silent, np.zeros(SR * 4, dtype=np.float32), SR)
        short = str(Path(tmp) / "short.wav")
        sf.write(short, (0.3 * np.sin(np.arange(SR) / SR * 2 * np.pi * 220)).astype(np.float32), SR)
        for p, why in ((silent, "silent"), (short, "short")):
            try:
                analyze_riff(p)
            except ValueError as exc:
                print(f"  {why}: ValueError({exc})")
                continue
            raise AssertionError(f"{why} audio should raise ValueError")
    print("  PASS: rejects silence and short audio")


def test_click_grid_hint():
    """A take recorded to the click: the given tempo and bar 1 set the grid."""
    from pipelines.riff_analysis import analyze_riff

    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "riff.wav")
        # Starts half a bar late relative to the file, as if the player came in on beat 3
        synth_riff(path, ["Am", "F", "C", "G"], 100.0, 0.0, repeats=2)
        r = analyze_riff(path, tempo_hint=100.0, start_hint=0.0)
    got = [c["chord"] for c in r["chords"]]
    assert r["tempo"] == 100.0 and r["start"] == 0.0, r
    assert got == ["Am", "F", "C", "G"] * 2, got
    assert 100 in r["tempo_options"]
    print(f"  PASS: click grid hint (chords={got})")


if __name__ == "__main__":
    print("=" * 50)
    for case in CASES:
        run_case(*case)
    test_rejects_silence_and_short_audio()
    test_click_grid_hint()
    print("=" * 50)
    print("All tests passed.")
