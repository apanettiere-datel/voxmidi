"""
AI drums tests. No live API calls: fal is mocked, and the "model" in the
pipeline tests is a function that damages the audio in a known way (delay,
saturation, tempo drift) so the alignment and rejection have a ground truth.

Run from backend/ with:
    .venv/bin/python test_drum_ai.py
"""

import io
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf

from pipelines import drum_ai
from pipelines.drum_ai import SR, render_pattern, align, match_rate, make_ai_drums, _audio_url_from, _fal_reskin

TEMPO = 100
SPB = 60 / TEMPO


def pattern(bars=4):
    notes = []
    for b in range(bars):
        o = b * 4
        notes += [{"p": 36, "t": o, "d": 0.2, "v": 118}, {"p": 36, "t": o + 2.5, "d": 0.2, "v": 110},
                  {"p": 38, "t": o + 1, "d": 0.2, "v": 104}, {"p": 38, "t": o + 3, "d": 0.2, "v": 104}]
        notes += [{"p": 42, "t": o + k / 2, "d": 0.1, "v": 60} for k in range(8)]
    return notes


def test_render_puts_hits_on_the_grid():
    import librosa
    notes = [n for n in pattern(2) if n["p"] in (36, 38)]
    y = render_pattern(notes, TEMPO, 8)
    onsets = librosa.onset.onset_detect(y=y, sr=SR, units="time", backtrack=True)
    for n in notes:
        t = n["t"] * SPB
        if t == 0:
            continue  # nothing before it to rise out of
        assert np.min(np.abs(onsets - t)) < 0.02, f"no onset near {t:.3f}s"
    assert len(y) >= 8 * SPB * SR
    print("  PASS: rendered hits sit on the grid")


def test_align_recovers_known_delay():
    notes = pattern(4)
    ref = render_pattern(notes, TEMPO, 16)
    delay = int(0.12 * SR)
    late = np.concatenate([np.zeros(delay, np.float32), np.tanh(2 * ref)])[: len(ref)]
    aligned, offset = align(ref, late)
    assert abs(offset + 0.12) < 0.012, f"offset {offset:.3f}s, expected -0.120"
    assert match_rate(notes, TEMPO, aligned) >= 0.9
    assert match_rate(notes, TEMPO, late) < 0.6, "unaligned audio should not match"
    print(f"  PASS: alignment recovers a 120 ms delay (found {offset * 1000:.0f} ms)")


def test_pipeline_accepts_a_good_render_and_rejects_drift():
    notes = pattern(8)
    with tempfile.TemporaryDirectory() as tmp:
        good = lambda a: np.concatenate([np.zeros(int(0.08 * SR), np.float32), np.tanh(1.5 * a)])
        r = make_ai_drums(notes, TEMPO, 32, "rock", 0.5, Path(tmp), reskin=good)
        assert abs(r["offset_ms"] + 80) <= 12 and r["match"] >= 90, r
        y, sr = sf.read(Path(tmp) / r["file"])
        assert sr == SR and abs(len(y) / SR - (32 * SPB + 1)) < 0.05 and np.max(np.abs(y)) <= 0.9

        import librosa
        drift = lambda a: librosa.effects.time_stretch(a, rate=1.03)
        try:
            make_ai_drums(notes, TEMPO, 32, "rock", 0.5, Path(tmp), reskin=drift)
        except RuntimeError as e:
            assert "drifted" in str(e), e
        else:
            raise AssertionError("a 3% tempo drift must be rejected")

        try:
            make_ai_drums(notes, TEMPO, 32, "rock", 0.5, Path(tmp), reskin=lambda a: np.zeros_like(a))
        except RuntimeError as e:
            assert "silence" in str(e), e
        else:
            raise AssertionError("silence must be rejected")
    print(f"  PASS: good render accepted (offset {r['offset_ms']} ms, {r['match']}% matched), drift and silence rejected")


def test_long_songs_are_cut_on_bar_lines():
    calls = []

    def spy(a):
        calls.append(len(a) / SR)
        return a

    notes = [{"p": 36, "t": b * 4, "d": 0.2, "v": 110} for b in range(100)] + [{"p": 38, "t": b * 4 + 2, "d": 0.2, "v": 100} for b in range(100)]
    with tempfile.TemporaryDirectory() as tmp:
        r = make_ai_drums(notes, 60, 400, "acoustic", 0.5, Path(tmp), reskin=spy)
    # 60 BPM: 4 s bars, 45 bars (180 s) per chunk, 100 bars -> 3 chunks
    assert r["chunks"] == 3 and len(calls) == 3, (r, calls)
    assert all(c <= drum_ai.MAX_CHUNK_SECONDS + 1.01 for c in calls), calls
    print(f"  PASS: 100 bars at 60 BPM cut into {len(calls)} chunks of {[round(c) for c in calls]} s")


def _resp(json_data=None, content=b"", status=200):
    r = MagicMock()
    r.status_code = status
    r.is_success = status < 400
    r.json.return_value = json_data or {}
    r.content = content
    r.text = str(json_data)
    return r


def test_fal_client_mocked():
    os.environ["FAL_KEY"] = "test-key"
    buf = io.BytesIO()
    sf.write(buf, np.zeros(SR, np.float32), SR, format="WAV")
    http = MagicMock()
    http.post.return_value = _resp({"request_id": "r1", "status_url": "https://q/s", "response_url": "https://q/r"})
    http.get.side_effect = [
        _resp({"status": "IN_QUEUE"}), _resp({"status": "IN_PROGRESS"}), _resp({"status": "COMPLETED"}),
        _resp({"audio": {"url": "https://cdn/x.wav"}}), _resp(content=buf.getvalue()),
    ]
    y = _fal_reskin(np.zeros(SR, np.float32), "rock drums, 100 BPM", 0.5, http=http, sleep=lambda s: None)
    assert len(y) == SR
    url = http.post.call_args.args[0]
    body = http.post.call_args.kwargs["json"]
    assert url.endswith("fal-ai/stable-audio-25/audio-to-audio")
    assert body["prompt"] == "rock drums, 100 BPM" and body["strength"] == 0.5
    assert body["audio_url"].startswith("data:audio/flac;base64,")
    assert http.post.call_args.kwargs["headers"]["Authorization"] == "Key test-key"

    http.get.side_effect = [_resp({"status": "FAILED"})]
    try:
        _fal_reskin(np.zeros(SR, np.float32), "p", 0.5, http=http, sleep=lambda s: None)
    except RuntimeError as e:
        assert "FAILED" in str(e)
    else:
        raise AssertionError("a failed fal job must raise")

    for shape in ({"audio": {"url": "https://a"}}, {"audio_file": {"url": "https://a"}}, {"audio": [{"url": "https://a"}]}, {"url": "https://a"}):
        assert _audio_url_from(shape) == "https://a"
    del os.environ["FAL_KEY"]
    print("  PASS: fal client submits a FLAC data URI, polls, downloads, and handles failures")


def _client():
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    import database
    from main import app

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    database.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    database.SessionLocal = Session  # the job thread's refund uses this

    def get_test_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = get_test_db
    return TestClient(app)


def _wait(client, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/api/status/{job_id}").json()
        if s["status"] in ("complete", "error", "cancelled"):
            return s
        time.sleep(0.2)
    raise AssertionError("job did not finish")


def test_endpoint():
    import pipelines.drum_ai as mod
    client = _client()
    used = lambda: client.get("/api/usage").json()["used"]
    body = {"tempo": TEMPO, "total_beats": 16, "notes": pattern(4), "style": "rock", "strength": 0.5}

    for bad in ({**body, "style": "polka"}, {**body, "tempo": 20}, {**body, "strength": 1.5},
                {**body, "notes": []}, {**body, "notes": [{"p": 60, "t": 0, "v": 100}]},
                {**body, "notes": [{"p": 36, "t": 16, "v": 100}]}, {**body, "notes": [{"p": 36, "t": 0, "v": 0}]},
                {k: v for k, v in body.items() if k != "style"}):
        r = client.post("/api/studio/drums/ai", json=bad)
        assert r.status_code == 400, f"{r.status_code} {r.text}"

    # Preview mode (no FAL_KEY): runs end to end and costs nothing
    before = used()
    r = client.post("/api/studio/drums/ai", json=body)
    assert r.status_code == 200 and r.json()["provider"] == "mock", r.text
    s = _wait(client, r.json()["job_id"])
    assert s["status"] == "complete", s
    res = s["result"]
    assert res["provider"] == "mock" and res["match"] >= 90
    audio = client.get(res["audio_url"])
    assert audio.status_code == 200 and audio.content[:4] == b"RIFF"
    assert used() == before, "preview mode must not count"

    # Live provider, model fails: the song is refunded
    os.environ["DRUMS_PROVIDER"] = "fal"
    real = mod._fal_reskin
    try:
        mod._fal_reskin = lambda audio, prompt, strength: (_ for _ in ()).throw(RuntimeError("AI drums: submit failed 500"))
        before = used()
        r = client.post("/api/studio/drums/ai", json=body)
        s = _wait(client, r.json()["job_id"])
        assert s["status"] == "error" and "submit failed" in s["message"], s
        assert used() == before, "a failed render must be refunded"

        # Live provider, model succeeds: one song is counted
        mod._fal_reskin = lambda audio, prompt, strength: np.tanh(1.5 * audio)
        r = client.post("/api/studio/drums/ai", json=body)
        s = _wait(client, r.json()["job_id"])
        assert s["status"] == "complete" and s["result"]["provider"] == "fal", s
        assert used() == before + 1 and isinstance(used(), int)
    finally:
        mod._fal_reskin = real
        del os.environ["DRUMS_PROVIDER"]
    print("  PASS: /api/studio/drums/ai validates input, preview is free, failures refund, success counts one song")


if __name__ == "__main__":
    print("=" * 50)
    test_render_puts_hits_on_the_grid()
    test_align_recovers_known_delay()
    test_pipeline_accepts_a_good_render_and_rejects_drift()
    test_long_songs_are_cut_on_bar_lines()
    test_fal_client_mocked()
    test_endpoint()
    print("=" * 50)
    print("All tests passed.")
