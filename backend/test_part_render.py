"""
Real-instrument parts: rendering, the pitch checks that guard AI polish, and
the /api/studio/parts/real endpoint. fal is never called; the "AI" in these
tests damages the audio in a known way (wrong pitch, saturation, delay).

Run from backend/ with:
    .venv/bin/python test_part_render.py
"""

import os
import sys
import tempfile
import time
from pathlib import Path

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np

from pipelines.part_render import render_part, note_match, chord_match, make_real_part, soundfont_path, SR

TEMPO = 100
PROG = [(45, 57, 60, 64), (41, 57, 60, 65), (48, 55, 60, 64), (43, 55, 59, 62)]  # Am F C G: bass + voicing


def bass_line(bars=8):
    out = []
    for b in range(bars):
        root = PROG[b % 4][0] - 12
        out += [{"p": root, "t": b * 4, "d": 1.5, "v": 100}, {"p": root, "t": b * 4 + 2, "d": 1, "v": 90},
                {"p": root + 7, "t": b * 4 + 3, "d": 0.9, "v": 90}]
    return out


def guitar_chords(bars=8):
    out = []
    for b in range(bars):
        for x in (0, 2):
            out += [{"p": p, "t": b * 4 + x, "d": 1.9, "v": 90} for p in PROG[b % 4][1:]]
    return out


def shift(audio, semis):
    import librosa
    return librosa.effects.pitch_shift(audio, sr=SR, n_steps=semis)


def test_render_and_checks():
    print(f"  renderer: {'FluidSynth + ' + Path(soundfont_path()).name if soundfont_path() else 'fallback synth'}")
    bass = bass_line()
    y = render_part(bass, TEMPO, 32, "bass", "finger")
    assert len(y) == int((32 * 0.6 + 1.5) * SR) and np.max(np.abs(y)) <= 0.9
    ok = note_match(bass, TEMPO, y, octave_ok=True)
    bad = note_match(bass, TEMPO, shift(y, 2), octave_ok=True)
    print(f"  bass render: {ok:.0%} of notes on pitch; shifted 2 semitones: {bad:.0%}")
    assert ok >= 0.9, ok
    assert bad < 0.3, bad

    gtr = guitar_chords()
    g = render_part(gtr, TEMPO, 32, "guitar", "clean")
    same = chord_match(g, np.tanh(2 * g), TEMPO, 32)
    wrong = chord_match(g, shift(g, 2), TEMPO, 32)
    print(f"  guitar chords: saturated copy {same:.0%} bars match; shifted 2 semitones {wrong:.0%}")
    assert same >= 0.9 and wrong < 0.3, (same, wrong)
    print("  PASS: renders are on pitch and the checks catch wrong notes")


def test_pipeline():
    bass = bass_line()
    with tempfile.TemporaryDirectory() as tmp:
        r = make_real_part("bass", "finger", bass, TEMPO, 32, False, 0.4, Path(tmp))
        assert r["provider"] == "samples" and (Path(tmp) / r["file"]).exists()
        good = lambda a: np.concatenate([np.zeros(int(0.05 * SR), np.float32), np.tanh(1.5 * a)])
        r = make_real_part("bass", "finger", bass, TEMPO, 32, True, 0.4, Path(tmp), reskin=good)
        assert r["match"] >= 90 and abs(r["offset_ms"] + 50) <= 12, r
        try:
            make_real_part("bass", "finger", bass, TEMPO, 32, True, 0.4, Path(tmp), reskin=lambda a: shift(a, 2))
        except RuntimeError as e:
            assert "changed your part" in str(e), e
        else:
            raise AssertionError("wrong notes must be rejected")
        gtr = guitar_chords()
        try:
            make_real_part("guitar", "clean", gtr, TEMPO, 32, True, 0.4, Path(tmp), reskin=lambda a: shift(a, 2))
        except RuntimeError as e:
            assert "bars of chords" in str(e), e
        else:
            raise AssertionError("wrong chords must be rejected")
    print(f"  PASS: polish accepted when notes survive ({r['match']}%), rejected when they don't")


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
    database.SessionLocal = Session

    def get_test_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = get_test_db
    return TestClient(app)


def _wait(client, job_id):
    t0 = time.time()
    while time.time() - t0 < 120:
        s = client.get(f"/api/status/{job_id}").json()
        if s["status"] in ("complete", "error", "cancelled"):
            return s
        time.sleep(0.2)
    raise AssertionError("job did not finish")


def test_endpoint():
    import pipelines.drum_ai as da
    client = _client()
    used = lambda: client.get("/api/usage").json()["used"]
    body = {"part": "bass", "style": "finger", "tempo": TEMPO, "total_beats": 32, "notes": bass_line(), "polish": False}
    for bad in ({**body, "part": "tuba"}, {**body, "style": "slapped"}, {**body, "tempo": 10}, {**body, "notes": []},
                {**body, "notes": [{"p": 200, "t": 0, "d": 1, "v": 90}]}, {**body, "notes": [{"p": 40, "t": 40, "d": 1, "v": 90}]},
                {**body, "strength": 2}):
        r = client.post("/api/studio/parts/real", json=bad)
        assert r.status_code == 400, f"{bad.get('part')} {r.status_code} {r.text}"

    before = used()
    s = _wait(client, client.post("/api/studio/parts/real", json=body).json()["job_id"])
    assert s["status"] == "complete" and s["result"]["provider"] == "samples", s
    assert client.get(s["result"]["audio_url"]).content[:4] == b"RIFF"
    s = _wait(client, client.post("/api/studio/parts/real", json={**body, "polish": True}).json()["job_id"])
    assert s["status"] == "complete" and s["result"]["provider"] == "mock", s
    assert used() == before, "samples and preview polish are free"

    os.environ["DRUMS_PROVIDER"] = "fal"
    real = da._fal_reskin
    try:
        da._fal_reskin = lambda a, p, st: shift(a, 3)  # the "AI" rewrites the notes
        s = _wait(client, client.post("/api/studio/parts/real", json={**body, "polish": True}).json()["job_id"])
        assert s["status"] == "error" and "changed your part" in s["message"], s
        assert used() == before, "a rejected polish is refunded"
        da._fal_reskin = lambda a, p, st: np.tanh(1.5 * a)
        s = _wait(client, client.post("/api/studio/parts/real", json={**body, "polish": True}).json()["job_id"])
        assert s["status"] == "complete" and s["result"]["provider"] == "fal", s
        assert used() == before + 1
    finally:
        da._fal_reskin = real
        del os.environ["DRUMS_PROVIDER"]
    print("  PASS: /api/studio/parts/real validates, samples are free, polish counts one song and refunds rejects")


if __name__ == "__main__":
    print("=" * 50)
    test_render_and_checks()
    test_pipeline()
    test_endpoint()
    print("=" * 50)
    print("All tests passed.")
