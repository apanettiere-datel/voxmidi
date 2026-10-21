"""Tests for saved studio songs (DB-backed projects) and take persistence.

Run via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_studio_projects.py
"""

import io
import os
import sys
from pathlib import Path

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))


def _client(tmp):
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    import database
    from routers import studio_projects as sp
    from main import app

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    database.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    database.SessionLocal = Session
    sp.TAKES_DIR = Path(tmp) / "user_takes"  # keep test files out of the real store

    def get_test_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = get_test_db
    return TestClient(app)


PROJECT = {"name": "My EDM Song", "tempo": 128,
           "data": {"sections": [{"id": "s1", "kind": "Verse", "bars": 4, "chords": ["Am"]}],
                    "tracks": [{"id": "bass", "kind": "midi", "notes": [{"p": 45, "t": 0, "d": 1, "v": 90}]}]}}


def test_crud_roundtrip(tmp):
    client = _client(tmp)
    # empty to start
    assert client.get("/api/studio/projects").json()["projects"] == []
    # create
    r = client.post("/api/studio/projects", json=PROJECT)
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert r.json()["name"] == "My EDM Song" and r.json()["tempo"] == 128
    # list shows it
    lst = client.get("/api/studio/projects").json()["projects"]
    assert len(lst) == 1 and lst[0]["id"] == pid
    # get full data back
    full = client.get(f"/api/studio/projects/{pid}").json()
    assert full["data"]["tracks"][0]["notes"][0]["p"] == 45
    # update
    upd = {**PROJECT, "name": "Renamed", "data": {**PROJECT["data"], "tracks": []}}
    r = client.put(f"/api/studio/projects/{pid}", json=upd)
    assert r.status_code == 200 and r.json()["name"] == "Renamed"
    assert client.get(f"/api/studio/projects/{pid}").json()["data"]["tracks"] == []
    # delete
    assert client.delete(f"/api/studio/projects/{pid}").status_code == 200
    assert client.get(f"/api/studio/projects/{pid}").status_code == 404
    print("  PASS: create, list, get, update, delete round-trip")


def test_bad_input(tmp):
    client = _client(tmp)
    assert client.post("/api/studio/projects", json={"name": "x"}).status_code == 400  # no data
    assert client.post("/api/studio/projects", json={"data": {}, "tempo": 9}).status_code == 400  # bad tempo
    assert client.get("/api/studio/projects/nope").status_code == 404
    print("  PASS: missing data, bad tempo -> 400; missing song -> 404")


def test_take_upload_and_fetch(tmp):
    client = _client(tmp)
    wav = b"RIFF....WAVEfmt " + b"\x00" * 40
    # upload
    r = client.post("/api/studio/takes/take123", files={"take": ("t.wav", io.BytesIO(wav), "audio/wav")})
    assert r.status_code == 200 and r.json()["stored"] is True
    # re-upload is a no-op
    r2 = client.post("/api/studio/takes/take123", files={"take": ("t.wav", io.BytesIO(wav), "audio/wav")})
    assert r2.json()["stored"] is False
    # fetch back
    g = client.get("/api/studio/takes/take123")
    assert g.status_code == 200 and g.content == wav
    # unknown take
    assert client.get("/api/studio/takes/missing").status_code == 404
    # bad id
    assert client.post("/api/studio/takes/bad%20id", files={"take": ("t.wav", io.BytesIO(wav), "audio/wav")}).status_code in (400, 404)
    print("  PASS: take upload is idempotent, fetch returns bytes, unknown -> 404")


if __name__ == "__main__":
    import tempfile
    print("=" * 55)
    with tempfile.TemporaryDirectory() as tmp:
        test_crud_roundtrip(tmp)
        test_bad_input(tmp)
        test_take_upload_and_fetch(tmp)
    print("=" * 55)
    print("All studio-project tests passed.")
