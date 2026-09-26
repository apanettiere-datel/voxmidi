"""
Bass, vocal and drum recording analysis, against synthesized ground truth.

Run from backend/ with:
    .venv/bin/python test_part_analysis.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf

SR = 44100
PROG = ["Am", "F", "C", "G"]
ROOT = {"Am": 33, "F": 29, "C": 36, "G": 31}  # bass roots, MIDI (A1 F1 C2 G1)


def tone(midi, dur, amp=0.4, harmonics=5, vibrato=0.0):
    t = np.arange(int(dur * SR)) / SR
    f = 440 * 2 ** ((midi - 69) / 12)
    ph = 2 * np.pi * f * t + (vibrato * np.sin(2 * np.pi * 5.5 * t) if vibrato else 0)
    y = sum((0.6 ** h) * np.sin((h + 1) * ph) for h in range(harmonics))
    env = np.minimum(1, t / 0.01) * np.exp(-t * 1.5)
    return (amp * y * env).astype(np.float32)


def place(buf, y, at):
    a = int(at * SR)
    b = min(len(buf), a + len(y))
    buf[a:b] += y[: b - a]


def write(path, buf):
    buf = buf / np.max(np.abs(buf)) * 0.8
    sf.write(path, buf, SR, subtype="PCM_16")


# Bass: root on 1 (1.5 beats), root on the "and" of 2, fifth on the "and" of 3, octave on 4
BASS_RHYTHM = [(0, 1.5, 0), (1.5, 1, 0), (2.5, 0.5, 7), (3, 1, 12)]


def synth_bass(path, bpm=100, lead=0.2, reps=2):
    spb = 60 / bpm
    buf = np.zeros(int((lead + len(PROG) * reps * 4 * spb + 1) * SR), np.float32)
    truth = []
    for bar in range(len(PROG) * reps):
        root = ROOT[PROG[bar % 4]]
        for x, d, iv in BASS_RHYTHM:
            place(buf, tone(root + iv, d * spb * 0.95), lead + (bar * 4 + x) * spb)
            truth.append((root + iv, bar * 4 + x))
    write(path, buf)
    return truth


# Vocal: chord tones on each beat, then a final held A
MELODY = {"Am": [69, 72, 76, 72], "F": [65, 69, 72, 69], "C": [64, 67, 72, 67], "G": [62, 67, 71, 67]}


def synth_vocal(path, bpm=100, lead=0.0):
    spb = 60 / bpm
    bars = PROG * 2 + ["Am"]
    buf = np.zeros(int((lead + len(bars) * 4 * spb + 1) * SR), np.float32)
    for bar, ch in enumerate(bars):
        line = MELODY[ch] if bar < len(bars) - 1 else [69]
        for k, p in enumerate(line):
            d = 4 if len(line) == 1 else 1
            place(buf, tone(p, d * spb * 0.9, harmonics=3, vibrato=0.3), lead + (bar * 4 + k) * spb)
    write(path, buf)
    return bars


def synth_drums(path, bpm=100, lead=0.3, bars=8):
    from pipelines.accompanist import _kick_oneshot, _snare_oneshot, _hat_oneshot
    spb = 60 / bpm
    buf = np.zeros(int((lead + bars * 4 * spb + 1) * SR), np.float32)
    for b in range(bars):
        o = lead + b * 4 * spb
        for x in (0, 2.5):
            place(buf, _kick_oneshot(), o + x * spb)
        for x in (1, 3):
            place(buf, _snare_oneshot(), o + x * spb)
        for k in range(8):
            place(buf, _hat_oneshot() * 0.6, o + k * 0.5 * spb)
    write(path, buf)


def test_bass():
    from pipelines.part_analysis import analyze_part
    with tempfile.TemporaryDirectory() as tmp:
        p = str(Path(tmp) / "bass.wav")
        truth = synth_bass(p)
        r = analyze_part(p, "bass")
    got = [c["chord"] for c in r["chords"]]
    print(f"  bass: tempo={r['tempo']} key={r['key']} start={r['start']} bars={r['bars']} chords={got} groove={r['groove']}")
    assert abs(r["tempo"] - 100) <= 1.5, r["tempo"]
    assert r["key"] == "A minor", r["key"]
    assert r["bars"] == 8 and abs(r["start"] - 0.2) < 0.05
    assert got == PROG * 2, got
    assert r["groove"] == [0.0, 1.5, 2.5, 3.0], r["groove"]
    # Every note transcribed at the right pitch and time
    notes = r["notes"]
    hit = sum(1 for p, t in truth if any(n["p"] == p and abs(n["t"] - t) < 0.2 for n in notes))
    assert hit / len(truth) >= 0.9, f"{hit}/{len(truth)} bass notes transcribed"
    print(f"  PASS: bass ({hit}/{len(truth)} notes exact)")


def test_vocals():
    from pipelines.part_analysis import analyze_part
    with tempfile.TemporaryDirectory() as tmp:
        p = str(Path(tmp) / "vocal.wav")
        bars = synth_vocal(p)
        r = analyze_part(p, "vocals", tempo_hint=100, start_hint=0.0)
    got = [c["chord"] for c in r["chords"]]
    print(f"  vocals: key={r['key']} bars={r['bars']} chords={got} notes={len(r['notes'])}")
    assert r["key"] == "A minor", r["key"]
    assert r["bars"] == len(bars), r["bars"]
    assert got == bars, got
    for c in r["chords"]:
        assert c["chord"] in c["options"] and isinstance(c["confidence"], int)
    # Uploaded without the click: tempo and bar 1 detected, first note at sample 0
    with tempfile.TemporaryDirectory() as tmp:
        p = str(Path(tmp) / "vocal.wav")
        synth_vocal(p)
        r2 = analyze_part(p, "vocals")
    got2 = [c["chord"] for c in r2["chords"]]
    assert abs(r2["tempo"] - 100) <= 1.5 and r2["start"] < 0.02, (r2["tempo"], r2["start"])
    assert got2 == bars, f"no-click vocal chords {got2}"
    print("  PASS: vocals harmonized to the chords they outline, with and without the click")


def test_drums():
    from pipelines.part_analysis import analyze_part
    with tempfile.TemporaryDirectory() as tmp:
        p = str(Path(tmp) / "drums.wav")
        synth_drums(p)
        r = analyze_part(p, "drums")
    lanes = {}
    for h in r["hits"]:
        lanes.setdefault(h["lane"], []).append(h["t"])
    print(f"  drums: tempo={r['tempo']} start={r['start']} bars={r['bars']} groove={r['groove']} hits={ {k: len(v) for k, v in lanes.items()} }")
    assert abs(r["tempo"] - 100) <= 1.5, r["tempo"]
    assert abs(r["start"] - 0.3) < 0.05, r["start"]
    assert r["bars"] == 8
    assert r["groove"] == [0.0, 2.5], r["groove"]
    assert r["key"] is None and r["chords"] == []
    print("  PASS: drums give tempo, bar 1 and the kick groove")


def test_rejects_bad_input():
    from pipelines.part_analysis import analyze_part
    with tempfile.TemporaryDirectory() as tmp:
        p = str(Path(tmp) / "s.wav")
        sf.write(p, np.zeros(SR * 4, np.float32), SR)
        for kind in ("bass", "vocals", "drums"):
            try:
                analyze_part(p, kind)
            except ValueError:
                continue
            raise AssertionError(f"silence should be rejected for {kind}")
        try:
            analyze_part(p, "kazoo")
        except ValueError:
            pass
        else:
            raise AssertionError("unknown kind should be rejected")
    print("  PASS: silence and unknown kinds rejected")


if __name__ == "__main__":
    print("=" * 50)
    test_bass()
    test_vocals()
    test_drums()
    test_rejects_bad_input()
    print("=" * 50)
    print("All tests passed.")
