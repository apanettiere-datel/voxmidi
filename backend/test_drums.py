"""
Drum pipeline tests. Run from backend/ with:
    .venv/bin/python test_drums.py
"""

import sys
from pathlib import Path

# Point imports at app/ (mirrors how uvicorn runs it)
sys.path.insert(0, str(Path(__file__).parent / "app"))

import tempfile
import numpy as np
import soundfile as sf


def make_beatbox_wav(path: str, bpm: float = 120.0) -> None:
    """
    Write a synthetic beatbox WAV: 8 bursts at bpm.
    Even-indexed bursts are low-freq thumps (kick-like, 60 Hz sine).
    Odd-indexed bursts are high-freq noise ticks (hat-like).
    """
    sr = 44100
    beat_dur = 60.0 / bpm
    n_bursts = 8
    total_dur = n_bursts * beat_dur
    buf = np.zeros(int(total_dur * sr), dtype=np.float32)

    for i in range(n_bursts):
        t_start = i * beat_dur
        start = int(t_start * sr)

        if i % 2 == 0:
            # Low-freq thump (kick): 60 Hz sine, 80ms
            dur_s = int(0.08 * sr)
            t = np.linspace(0, 0.08, dur_s, endpoint=False)
            burst = (0.6 * np.sin(2 * np.pi * 60 * t)).astype(np.float32)
        else:
            # High-freq noise tick (hat): white noise, 30ms, highpassed via diff
            dur_s = int(0.03 * sr)
            rng = np.random.default_rng(i * 7)
            burst = (0.4 * rng.standard_normal(dur_s)).astype(np.float32)
            burst = np.diff(burst, prepend=burst[:1]).astype(np.float32) * 8.0
            burst = np.clip(burst, -0.5, 0.5)

        end = min(start + len(burst), len(buf))
        buf[start:end] += burst[:end - start]

    sf.write(path, buf, sr)


def test_analyze() -> None:
    print("test_analyze: running...")
    from pipelines.drums import analyze_drums

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
    make_beatbox_wav(wav_path, bpm=120.0)

    result = analyze_drums(wav_path)

    assert 60.0 <= result["tempo"] <= 180.0, f"tempo out of range: {result['tempo']}"
    assert result["steps_per_beat"] == 4, "steps_per_beat must be 4"
    assert result["bars"] >= 1, "bars must be >= 1"
    assert result["bars"] <= 8, f"bars capped at 8, got {result['bars']}"
    assert "kick" in result["lanes"], "kick lane missing"
    assert "snare" in result["lanes"], "snare lane missing"
    assert "hat" in result["lanes"], "hat lane missing"
    assert result["steps_total"] == result["bars"] * 16, "steps_total mismatch"

    total_hits = len(result["lanes"]["kick"]) + len(result["lanes"]["hat"])
    assert total_hits > 0, "No drum hits detected at all"

    # Kicks should mostly land on even-beat steps (0, 8, 16, ...) at 120 BPM / 16th grid
    # Just assert there are some kick hits detected (4 thumps in the recording)
    print(f"  tempo={result['tempo']} bars={result['bars']} kicks={result['lanes']['kick']} hats={result['lanes']['hat']} snares={result['lanes']['snare']}")
    assert len(result["lanes"]["kick"]) > 0, f"Expected kick hits from low-freq thumps, got none. lanes={result['lanes']}"

    print("  PASS: test_analyze")


def test_render() -> None:
    print("test_render: running...")
    from pipelines.drums import render_drums

    with tempfile.TemporaryDirectory() as tmpdir:
        job_dir = Path(tmpdir)

        result = render_drums(
            tempo=120.0,
            steps_per_beat=4,
            steps_total=32,  # 2 bars at 16 steps/bar
            lanes={
                "kick":  [0, 8, 16, 24],
                "snare": [4, 12, 20, 28],
                "hat":   [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
                "clap":  [4, 20],
            },
            job_dir=job_dir,
        )

        wav_path = job_dir / "drums.wav"
        mid_path = job_dir / "drums.mid"

        assert wav_path.exists(), "drums.wav not created"
        assert mid_path.exists(), "drums.mid not created"
        assert wav_path.stat().st_size > 0, "drums.wav is empty"
        assert mid_path.stat().st_size > 0, "drums.mid is empty"
        assert result["duration"] > 0, "duration is zero"

        # 2 bars at 120 BPM = 4.0s exactly
        assert abs(result["duration"] - 4.0) < 0.01, f"Expected ~4.0s duration, got {result['duration']}"

        print(f"  duration={result['duration']}s wav={wav_path.stat().st_size}B mid={mid_path.stat().st_size}B")
        print("  PASS: test_render")


def test_main_imports() -> None:
    print("test_main_imports: verifying 'from main import app'...")
    import importlib
    spec = importlib.util.find_spec("main")
    assert spec is not None, "main module not found on sys.path"
    # Import it; if the router wiring is broken this will raise
    import main  # noqa: F401
    from main import app
    assert app is not None
    # Check our new routes are registered
    routes = [r.path for r in app.routes]
    assert any("/drums/analyze" in p for p in routes), f"/drums/analyze not found in routes: {routes}"
    assert any("/drums/render" in p for p in routes), f"/drums/render not found in routes: {routes}"
    print("  PASS: test_main_imports")


if __name__ == "__main__":
    print("=" * 50)
    print("Running drum pipeline tests")
    print("=" * 50)
    test_analyze()
    test_render()
    test_main_imports()
    print("=" * 50)
    print("All tests passed.")
    print("=" * 50)
