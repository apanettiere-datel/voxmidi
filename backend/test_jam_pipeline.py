"""Verification test for the jam pipeline.

Synthesizes a 10-second 110 BPM strummy test riff, runs the pipeline
directly (no HTTP), and asserts expected output shape.

Run with:
    backend/.venv/bin/python backend/test_jam_pipeline.py
or from backend/:
    .venv/bin/python test_jam_pipeline.py
"""

import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

# Resolve app/ on the path so pipeline imports work
sys.path.insert(0, str(Path(__file__).parent / "app"))


def _make_test_riff(path: str, duration: float = 10.0, bpm: float = 110.0) -> None:
    """Synthesize a strummy test riff: a simple chord strum pattern at 110 BPM."""
    sr = 44100
    samples = int(duration * sr)
    buf = np.zeros(samples, dtype=np.float32)

    beat = 60.0 / bpm
    # Strum: three chord tones (A minor triad: 220, 261.6, 329.6 Hz)
    freqs = [220.0, 261.63, 329.63]

    t = 0.0
    strum_dur = 0.15
    while t < duration:
        for i, freq in enumerate(freqs):
            offset = int((t + i * 0.015) * sr)
            length = int(strum_dur * sr)
            end = min(offset + length, samples)
            chunk = end - offset
            if chunk <= 0:
                continue
            tone = (0.15 * np.sin(2 * np.pi * freq * np.linspace(0, strum_dur, length))).astype(np.float32)
            buf[offset:end] += tone[:chunk]
        t += beat

    # Normalize gently
    peak = np.max(np.abs(buf))
    if peak > 0.01:
        buf = buf / peak * 0.5

    sf.write(path, buf, sr, subtype="PCM_16")


def run_test() -> None:
    from pipelines.accompanist import run_accompaniment, VALID_PARTS

    ALL_PARTS = sorted(VALID_PARTS)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        riff_path = str(tmp / "test_riff.wav")
        _make_test_riff(riff_path, duration=10.0, bpm=110.0)

        job_dir = tmp / "job_out"
        job_dir.mkdir()
        job_id = "test0001"

        result = run_accompaniment(
            riff_path=riff_path,
            beatbox_path=None,
            parts=ALL_PARTS,
            style_prompt="test",
            preset="",
            job_id=job_id,
            job_dir=job_dir,
        )

        # Assert result dict shape
        assert result["job_id"] == job_id, "job_id mismatch"
        assert result["mode"] == "jam", f"expected mode=jam, got {result['mode']}"
        assert result["provider"] == "mock", f"expected provider=mock, got {result['provider']}"
        assert result["tempo"] > 0, f"tempo should be positive, got {result['tempo']}"
        assert result["key"], "key should not be empty"
        assert result["duration"] > 0, f"duration should be positive, got {result['duration']}"
        assert "original" in result, "result missing 'original'"
        assert result["original"]["audio_url"], "original audio_url missing"
        assert result["mix_url"], "mix_url missing"
        assert result["midi_url"], "midi_url missing"

        tracks = result["tracks"]
        assert len(tracks) == len(ALL_PARTS), (
            f"expected {len(ALL_PARTS)} tracks, got {len(tracks)}"
        )

        track_ids = {t["id"] for t in tracks}
        assert track_ids == set(ALL_PARTS), f"track ids mismatch: {track_ids}"

        for track in tracks:
            assert "id" in track
            assert "label" in track
            assert "kind" in track
            assert track["kind"] in ("generated", "texture"), f"bad kind: {track['kind']}"
            assert "audio_url" in track
            assert "midi_url" in track

        # Assert files exist and are nonzero
        mix_filename = result["mix_url"].split("/")[-1]
        mix_path = job_dir / mix_filename
        assert mix_path.exists(), f"mix file missing: {mix_path}"
        assert mix_path.stat().st_size > 0, "mix file is empty"

        combined_mid_filename = result["midi_url"].split("/")[-1]
        combined_mid_path = job_dir / combined_mid_filename
        assert combined_mid_path.exists(), f"combined MIDI missing: {combined_mid_path}"
        assert combined_mid_path.stat().st_size > 0, "combined MIDI is empty"

        for track in tracks:
            audio_fname = track["audio_url"].split("/")[-1]
            audio_path = job_dir / audio_fname
            assert audio_path.exists(), f"stem audio missing: {audio_path}"
            assert audio_path.stat().st_size > 0, f"stem audio empty: {audio_path}"

            if track["midi_url"]:
                midi_fname = track["midi_url"].split("/")[-1]
                midi_path_f = job_dir / midi_fname
                assert midi_path_f.exists(), f"stem MIDI missing: {midi_path_f}"
                assert midi_path_f.stat().st_size > 0, f"stem MIDI empty: {midi_path_f}"

        print(f"ALL ASSERTIONS PASSED")
        print(f"  tempo={result['tempo']} BPM  key={result['key']}  duration={result['duration']}s")
        print(f"  tracks: {[t['id'] for t in tracks]}")
        print(f"  mix: {mix_path.stat().st_size} bytes")
        print(f"  combined MIDI: {combined_mid_path.stat().st_size} bytes")


if __name__ == "__main__":
    run_test()
