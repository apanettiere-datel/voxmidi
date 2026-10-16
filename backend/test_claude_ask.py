"""Tests for the Claude ask endpoint (plain-language MIDI edits).

No real API calls: ask_claude is patched; validate_result is tested directly.

Run via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_claude_ask.py
"""

import os
import sys
from pathlib import Path

os.environ["DEV_MODE"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)
sys.path.insert(0, str(Path(__file__).parent / "app"))

SONG = {
    "text": "make the bass busier in the chorus",
    "tempo": 100,
    "key": "F minor",
    "time_signature": "4/4",
    "sections": [
        {"kind": "Verse", "bars": 4, "chords": ["Fm", "Db"]},
        {"kind": "Chorus", "bars": 4, "chords": ["Fm", "Eb"]},
    ],
    "tracks": [
        {"id": "bass", "name": "Bass", "role": "bass", "kind": "midi", "sound": "Warm bass",
         "notes": [{"p": 41, "t": 0.0, "d": 1.0, "v": 100}, {"p": 41, "t": 16.0, "d": 1.0, "v": 100}]},
    ],
}


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


# ─── validate_result unit tests ───────────────────────────────────────────────

def test_validate_result():
    from pipelines.claude_composer import ComposerError, validate_result

    tracks = SONG["tracks"]
    good = {"track": "bass", "title": "Busier chorus bass.", "detail": "Verse untouched.",
            "notes": [{"p": 41, "t": 0.0, "d": 1.0, "v": 100}, {"p": 200, "t": 17.0, "d": 100, "v": 300}]}
    r = validate_result(good, tracks, 32)
    assert r["trackId"] == "bass" and len(r["notes"]) == 2
    assert r["notes"][1]["p"] == 127 and r["notes"][1]["v"] == 127 and r["notes"][1]["d"] == 64

    # a note past the end of the song is dropped, not fatal
    r = validate_result({**good, "notes": good["notes"] + [{"p": 41, "t": 99.0, "d": 1, "v": 90}]}, tracks, 32)
    assert len(r["notes"]) == 2

    for bad, why in [
        ({**good, "track": "nope"}, "unknown track"),
        ({**good, "notes": []}, "empty notes"),
        ({**good, "notes": [{"p": 41, "t": 99.0, "d": 1, "v": 90}]}, "all notes out of range"),
        ({**good, "notes": [{"p": "x", "t": 0, "d": 1, "v": 90}]}, "malformed note"),
    ]:
        try:
            validate_result(bad, tracks, 32)
            raise AssertionError(f"validate_result accepted {why}")
        except ComposerError:
            pass
    print("  PASS: validate_result clamps, drops out-of-range notes, rejects bad replies")


# ─── Endpoint tests ───────────────────────────────────────────────────────────

def test_endpoint_503_without_key():
    client = _client()
    r = client.post("/api/studio/ask/ai", json=SONG)
    assert r.status_code == 503, f"expected 503, got {r.status_code}: {r.text}"
    print("  PASS: no ANTHROPIC_API_KEY -> 503 (frontend falls back to rule-based)")


def test_endpoint_happy_path_with_patched_claude():
    import pipelines.claude_composer as cc

    async def fake_ask(song, text):
        assert song["total_beats"] == 32
        assert song["tracks"][0]["id"] == "bass"
        assert "busier" in text
        return {"track": "bass", "title": "Chorus bass: eighth-note drive.", "detail": "Verse untouched.",
                "notes": [{"p": 41, "t": 16.0, "d": 0.5, "v": 104}, {"p": 41, "t": 16.5, "d": 0.5, "v": 92}]}

    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    orig = cc.ask_claude
    cc.ask_claude = fake_ask
    try:
        r = client.post("/api/studio/ask/ai", json=SONG)
    finally:
        cc.ask_claude = orig
        os.environ.pop("ANTHROPIC_API_KEY", None)
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert data["trackId"] == "bass" and data["trackName"] == "Bass"
    assert len(data["notes"]) == 2 and data["notes"][0]["t"] == 16.0
    print("  PASS: happy path returns a validated edit for one track")


def test_endpoint_maps_composer_error_to_422():
    import pipelines.claude_composer as cc

    async def fake_refusal(song, text):
        raise cc.ComposerError("The AI didn't make that change: it declined that request")

    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    orig = cc.ask_claude
    cc.ask_claude = fake_refusal
    try:
        r = client.post("/api/studio/ask/ai", json=SONG)
    finally:
        cc.ask_claude = orig
        os.environ.pop("ANTHROPIC_API_KEY", None)
    assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text}"
    assert "declined" in r.json()["detail"]
    print("  PASS: a composer error comes back as a readable 422")


def test_endpoint_rejects_bad_input():
    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    try:
        r = client.post("/api/studio/ask/ai", json={**SONG, "text": "x"})
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
        r = client.post("/api/studio/ask/ai", json={**SONG, "tracks": []})
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    finally:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    print("  PASS: short text and empty tracks -> 400")


if __name__ == "__main__":
    print("=" * 55)
    test_validate_result()
    test_endpoint_503_without_key()
    test_endpoint_happy_path_with_patched_claude()
    test_endpoint_maps_composer_error_to_422()
    test_endpoint_rejects_bad_input()
    print("=" * 55)
    print("All Claude ask tests passed.")
