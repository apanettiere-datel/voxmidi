"""Tests for the whole-song Claude composer (one brief in, a full song out).

No real API calls: compose_song is patched; validate_song is tested directly.

Run via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_song_ai.py
"""

import os
import sys
from pathlib import Path

os.environ["DEV_MODE"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
sys.path.insert(0, str(Path(__file__).parent / "app"))


def _song(**over):
    song = {
        "title": "Night Drive",
        "tempo": 100,
        "key": "A minor",
        "caption": "Warm indie pop at 100 BPM with a soft female lead vocal.",
        "lyrics": "[verse]\nStreetlights fading one by one\n[chorus]\nDrive me home",
        "sections": [
            {"kind": "Intro", "bars": 4, "chords": ["Am", "F"]},
            {"kind": "Verse", "bars": 8, "chords": ["Am", "F", "C", "G"]},
            {"kind": "Chorus", "bars": 8, "chords": ["F", "C", "G", "Am"]},
        ],
        "tracks": [
            {"role": "chords", "name": "Rhodes", "notes": [{"p": 57, "t": 0.0, "d": 3.8, "v": 78}]},
            {"role": "bass", "name": "Bass", "notes": [{"p": 33, "t": 0.0, "d": 0.9, "v": 92}]},
            {"role": "melody", "name": "Vocal guide", "notes": [{"p": 64, "t": 16.0, "d": 1.0, "v": 85}]},
        ],
    }
    song.update(over)
    return song


# ─── validate_song unit tests ─────────────────────────────────────────────────

def test_validate_song_happy_path():
    from pipelines.claude_composer import validate_song

    out = validate_song(_song())
    assert out["title"] == "Night Drive" and out["tempo"] == 100
    assert [s["id"] for s in out["sections"]] == ["s1", "s2", "s3"]
    assert out["sections"][1]["chords"] == ["Am", "F", "C", "G"]
    assert {t["role"] for t in out["tracks"]} == {"chords", "bass", "melody"}
    print("  PASS: a well-formed song validates and gets section ids")


def test_validate_song_rejects_garbage():
    from pipelines.claude_composer import ComposerError, validate_song

    for bad in (
        _song(tempo=0),
        _song(sections=[]),
        _song(sections=[{"kind": "Drop", "bars": 8, "chords": []}]),
        _song(sections=[{"kind": "Verse", "bars": 40, "chords": []}]),
        _song(sections=[{"kind": "Verse", "bars": 32, "chords": []}] * 3),  # 96 bars
        _song(tracks=[]),
        _song(tracks=[{"role": "chords", "name": "x", "notes": []}]),  # no notes anywhere
    ):
        try:
            validate_song(bad)
            raise AssertionError(f"validate_song accepted {bad}")
        except ComposerError:
            pass
    print("  PASS: bad tempo, form, length and empty songs are all rejected")


def test_validate_song_cleans_and_clamps():
    from pipelines.claude_composer import validate_song

    out = validate_song(_song(tracks=[
        {"role": "bass", "name": "", "notes": [
            {"p": 200, "t": 0.0, "d": 0.5, "v": 300},      # clamped
            {"p": 40, "t": 500.0, "d": 1.0, "v": 90},       # outside the song: dropped
        ]},
        {"role": "bass", "name": "Dup", "notes": [{"p": 40, "t": 0.0, "d": 1.0, "v": 90}]},  # dup role: dropped
        {"role": "flute", "name": "No", "notes": [{"p": 70, "t": 0.0, "d": 1.0, "v": 90}]},  # unknown: dropped
    ]))
    assert len(out["tracks"]) == 1
    bass = out["tracks"][0]
    assert bass["name"] == "Bass" and len(bass["notes"]) == 1
    assert bass["notes"][0]["p"] == 127 and bass["notes"][0]["v"] == 127
    print("  PASS: notes are clamped, out-of-song notes and duplicate/unknown roles dropped")


# ─── Endpoint tests ───────────────────────────────────────────────────────────

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


def test_endpoint_503_without_key():
    client = _client()
    # importing the app ran load_dotenv, which may have re-set the key from a real .env
    os.environ.pop("ANTHROPIC_API_KEY", None)
    r = client.post("/api/studio/song/ai", json={"brief": "a happy song"})
    assert r.status_code == 503, f"expected 503, got {r.status_code}: {r.text}"
    print("  PASS: no ANTHROPIC_API_KEY -> 503")


def test_endpoint_happy_path_with_patched_claude():
    import pipelines.claude_composer as cc

    async def fake_compose(brief):
        assert "night" in brief
        return _song()

    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    orig = cc.compose_song
    cc.compose_song = fake_compose
    try:
        r = client.post("/api/studio/song/ai", json={"brief": "a song about driving at night"})
    finally:
        cc.compose_song = orig
        os.environ.pop("ANTHROPIC_API_KEY", None)
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert data["title"] == "Night Drive" and len(data["sections"]) == 3
    assert data["lyrics"].startswith("[verse]")
    print("  PASS: happy path returns the validated song")


def test_endpoint_maps_composer_error_to_422():
    import pipelines.claude_composer as cc

    async def fake_refusal(brief):
        raise cc.ComposerError("The AI didn't do it: it declined that request")

    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    orig = cc.compose_song
    cc.compose_song = fake_refusal
    try:
        r = client.post("/api/studio/song/ai", json={"brief": "a happy song"})
    finally:
        cc.compose_song = orig
        os.environ.pop("ANTHROPIC_API_KEY", None)
    assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text}"
    assert "declined" in r.json()["detail"]
    print("  PASS: a composer error comes back as a readable 422")


def test_endpoint_rejects_bad_input():
    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    try:
        for body in ({"brief": "x"}, {}, {"brief": "y" * 501}):
            r = client.post("/api/studio/song/ai", json=body)
            assert r.status_code == 400, f"expected 400 for {body}, got {r.status_code}"
    finally:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    print("  PASS: too-short, missing and too-long briefs -> 400")


if __name__ == "__main__":
    print("=" * 55)
    test_validate_song_happy_path()
    test_validate_song_rejects_garbage()
    test_validate_song_cleans_and_clamps()
    test_endpoint_503_without_key()
    test_endpoint_happy_path_with_patched_claude()
    test_endpoint_maps_composer_error_to_422()
    test_endpoint_rejects_bad_input()
    print("=" * 55)
    print("All song-ai tests passed.")
