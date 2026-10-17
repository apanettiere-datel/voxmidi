"""Tests for the Claude ask endpoint (plain-language MIDI edits).

No real API calls: ask_claude is patched; validate_changes is tested directly.

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
        {"id": "drums", "name": "Drums", "role": "drums", "kind": "midi", "sound": "Tight kit",
         "notes": [{"p": 36, "t": 0.0, "d": 0.1, "v": 110}]},
    ],
}
CHORUS = {"start_beat": 16.0, "end_beat": 32.0, "label": "Chorus"}


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


def _reply(changes, title="Did it.", detail="Kept the rest."):
    return {"title": title, "detail": detail, "changes": changes}


# ─── validate_changes unit tests ──────────────────────────────────────────────

def test_validate_changes():
    from pipelines.claude_composer import ComposerError, validate_changes

    tracks = SONG["tracks"]
    good = _reply([{"track": "bass",
                    "notes": [{"p": 41, "t": 0.0, "d": 1.0, "v": 100}, {"p": 200, "t": 17.0, "d": 100, "v": 300}]}])
    r = validate_changes(good, tracks, 32)
    ch = r["changes"][0]
    assert ch["trackId"] == "bass" and not ch["created"] and len(ch["notes"]) == 2
    assert ch["notes"][1]["p"] == 127 and ch["notes"][1]["v"] == 127 and ch["notes"][1]["d"] == 64

    # a note past the end of the song is dropped, not fatal
    extra = _reply([{"track": "bass", "notes": good["changes"][0]["notes"] + [{"p": 41, "t": 99.0, "d": 1, "v": 90}]}])
    assert len(validate_changes(extra, tracks, 32)["changes"][0]["notes"]) == 2

    for bad, why in [
        (_reply([{"track": "nope", "notes": [{"p": 41, "t": 0, "d": 1, "v": 90}]}]), "unknown track"),
        (_reply([{"track": "bass", "notes": []}]), "empty notes without a scope"),
        (_reply([{"track": "bass", "notes": [{"p": 41, "t": 99.0, "d": 1, "v": 90}]}]), "all notes out of range"),
        (_reply([{"track": "bass", "notes": [{"p": "x", "t": 0, "d": 1, "v": 90}]}]), "malformed note"),
        (_reply([]), "no changes"),
        (_reply([{"track": "bass", "notes": [{"p": 41, "t": 0, "d": 1, "v": 90}]}] * 2), "same track twice"),
    ]:
        try:
            validate_changes(bad, tracks, 32)
            raise AssertionError(f"validate_changes accepted {why}")
        except ComposerError:
            pass
    print("  PASS: validate_changes clamps, drops out-of-range notes, rejects bad replies")


def test_validate_changes_new_track_and_multi():
    from pipelines.claude_composer import ComposerError, validate_changes

    tracks = SONG["tracks"]
    r = validate_changes(_reply([
        {"track": "drums", "notes": [{"p": 38, "t": 2.0, "d": 0.1, "v": 100}]},
        {"track": "new", "role": "chords", "name": "Strings", "notes": [{"p": 60, "t": 0.0, "d": 4.0, "v": 70}]},
    ]), tracks, 32)
    assert len(r["changes"]) == 2
    assert r["changes"][1]["created"] and r["changes"][1]["role"] == "chords" and r["changes"][1]["name"] == "Strings"

    # a new track defaults its name from the role
    r = validate_changes(_reply([{"track": "new", "role": "melody", "notes": [{"p": 72, "t": 0.0, "d": 1.0, "v": 90}]}]), tracks, 32)
    assert r["changes"][0]["name"] == "Melody"

    for bad, why in [
        (_reply([{"track": "new", "role": "theremin", "notes": [{"p": 60, "t": 0, "d": 1, "v": 90}]}]), "unknown role"),
        (_reply([{"track": "new", "notes": [{"p": 60, "t": 0, "d": 1, "v": 90}]}]), "new track without a role"),
        (_reply([{"track": "new", "role": "bass", "notes": []}]), "new track with no notes"),
    ]:
        try:
            validate_changes(bad, tracks, 32)
            raise AssertionError(f"validate_changes accepted {why}")
        except ComposerError:
            pass
    print("  PASS: multi-track changes and new tracks validate; bad roles are rejected")


def test_validate_changes_scope():
    from pipelines.claude_composer import ComposerError, validate_changes

    tracks = SONG["tracks"]
    # notes outside the scope are dropped, inside kept
    r = validate_changes(_reply([{"track": "bass", "notes": [
        {"p": 41, "t": 17.0, "d": 1.0, "v": 100},
        {"p": 41, "t": 2.0, "d": 1.0, "v": 100},
    ]}]), tracks, 32, scope=CHORUS)
    assert len(r["changes"][0]["notes"]) == 1 and r["changes"][0]["notes"][0]["t"] == 17.0
    assert r["scope"] == CHORUS

    # an explicitly empty list with a scope means "clear this range" and is allowed
    r = validate_changes(_reply([{"track": "bass", "notes": []}]), tracks, 32, scope=CHORUS)
    assert r["changes"][0]["notes"] == []

    # but a reply whose notes all fell outside the scope is an error, not a silent clear
    try:
        validate_changes(_reply([{"track": "bass", "notes": [{"p": 41, "t": 2.0, "d": 1, "v": 90}]}]), tracks, 32, scope=CHORUS)
        raise AssertionError("validate_changes accepted a reply entirely outside the scope")
    except ComposerError:
        pass
    print("  PASS: scope keeps only in-range notes, allows a deliberate clear, rejects misses")


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
        assert song["scope"]["label"] == "Chorus"
        assert "busier" in text
        return _reply([
            {"track": "bass", "notes": [{"p": 41, "t": 16.0, "d": 0.5, "v": 104}, {"p": 41, "t": 16.5, "d": 0.5, "v": 92}]},
            {"track": "new", "role": "chords", "name": "Pad", "notes": [{"p": 65, "t": 16.0, "d": 4.0, "v": 60}]},
        ], title="Chorus bass: eighth-note drive, plus a pad.")

    client = _client()
    os.environ["ANTHROPIC_API_KEY"] = "test-dummy"
    orig = cc.ask_claude
    cc.ask_claude = fake_ask
    try:
        r = client.post("/api/studio/ask/ai", json={**SONG, "scope": CHORUS})
    finally:
        cc.ask_claude = orig
        os.environ.pop("ANTHROPIC_API_KEY", None)
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert len(data["changes"]) == 2
    assert data["changes"][0]["trackId"] == "bass" and data["changes"][0]["notes"][0]["t"] == 16.0
    assert data["changes"][1]["created"] and data["changes"][1]["name"] == "Pad"
    assert data["scope"]["start_beat"] == 16.0
    print("  PASS: happy path returns validated changes, scoped, with a new track")


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
        r = client.post("/api/studio/ask/ai", json={**SONG, "scope": {"start_beat": 20.0, "end_beat": 16.0}})
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
        r = client.post("/api/studio/ask/ai", json={**SONG, "scope": {"start_beat": 99.0, "end_beat": 101.0}})
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    finally:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    print("  PASS: short text, empty tracks and bad scopes -> 400")


if __name__ == "__main__":
    print("=" * 55)
    test_validate_changes()
    test_validate_changes_new_track_and_multi()
    test_validate_changes_scope()
    test_endpoint_503_without_key()
    test_endpoint_happy_path_with_patched_claude()
    test_endpoint_maps_composer_error_to_422()
    test_endpoint_rejects_bad_input()
    print("=" * 55)
    print("All Claude ask tests passed.")
