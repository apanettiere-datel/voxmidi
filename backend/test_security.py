"""
Security and robustness tests: file downloads can't escape the job dirs, job
status is owner-only, bad uploads get 400 (not 500), and a failed or cancelled
job gives back its song exactly once.

No live providers: the generation pipelines are replaced with functions that
fail on purpose.

Run from backend/ with:
    .venv/bin/python test_security.py
"""

import io
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf

SECRET = b"SQLite format 3 SECRET DB CONTENTS"
LEGIT = b"MThd legit midi bytes"


def _client():
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    import database
    from main import app

    # A file, not one shared in-memory connection: background jobs commit refunds from their own thread
    db_file = Path(tempfile.mkdtemp()) / "test.db"
    engine = create_engine(f"sqlite:///{db_file}", connect_args={"check_same_thread": False})
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


def _sandbox(root: Path):
    """Point every router's file stores into root, laid out like prod (/app/data/midi next to the DB)."""
    from routers import transcribe, generate, jam, midi_workshop, drums
    data = root / "data"
    store = data / "midi"
    uploads = root / "tmp_voxmidi"
    for d in (store, uploads):
        d.mkdir(parents=True, exist_ok=True)
    (data / "voxmidi.db").write_bytes(SECRET)
    (root / "outside.txt").write_bytes(SECRET)
    for mod in (transcribe, generate, jam, drums):
        mod.MIDI_STORE = store
        mod.UPLOAD_DIR = uploads
    midi_workshop.UPLOAD_DIR = uploads
    return store, uploads


def _wav_bytes(seconds=1.0):
    sr = 22050
    t = np.arange(int(sr * seconds)) / sr
    buf = io.BytesIO()
    sf.write(buf, (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr, format="WAV")
    return buf.getvalue()


def _wait(client, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/api/status/{job_id}").json()
        if s.get("status") in ("complete", "error", "cancelled"):
            return s
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} did not finish")


def test_download_traversal(client, store, uploads):
    job = store / "abc12345"
    job.mkdir()
    (job / "output.mid").write_bytes(LEGIT)
    (job / "subdir").mkdir()
    (uploads / "tmp98765").mkdir()
    (uploads / "tmp98765" / "drums.wav").write_bytes(LEGIT)
    try:
        (job / "link.mid").symlink_to(store.parent / "voxmidi.db")
    except OSError:
        pass

    r = client.get("/api/download/abc12345/output.mid")
    assert r.status_code == 200 and r.content == LEGIT, r.status_code
    r = client.get("/api/download/tmp98765/drums.wav")
    assert r.status_code == 200 and r.content == LEGIT, r.status_code

    attacks = [
        "/api/download/%2E%2E/voxmidi.db",
        "/api/download/../voxmidi.db",
        "/api/download/abc12345/..%2Fvoxmidi.db",
        "/api/download/abc12345/%2E%2E",
        "/api/download/abc12345/..",
        "/api/download/%2E%2E/%2E%2E",
        "/api/download/%2E%2E%2F%2E%2E/outside.txt",
        "/api/download/abc12345/%2E%2E%2F%2E%2E%2Fvoxmidi.db",
        "/api/download/abc12345/..%5C..%5Cvoxmidi.db",
        "/api/download/%2E%2E%5C%2E%2E/voxmidi.db",
        "/api/download/abc12345/%2Fetc%2Fpasswd",
        "/api/download/%2Fetc/passwd",
        "/api/download/abc12345/output.mid%00.txt",
        "/api/download/abc12345/subdir",
        "/api/download/abc12345/link.mid",
        "/api/download/%2E/voxmidi.db",
        "/api/download/abc12345/.",
        "/api/download/%2E%2E/stems.zip",
        "/api/workshop/download/%2E%2E/voxmidi.db",
        "/api/workshop/download/abc/..%2F..%2Fdata%2Fvoxmidi.db",
        "/api/workshop/download/%2E%2E%2Fdata/voxmidi.db",
    ]
    for url in attacks:
        r = client.get(url)
        assert r.status_code in (400, 404), f"{url} -> {r.status_code}"
        assert SECRET not in r.content, f"{url} leaked the file"

    # A legit workshop file still downloads
    (uploads / "workshop_feed1234").mkdir()
    (uploads / "workshop_feed1234" / "workshop_output.mid").write_bytes(LEGIT)
    r = client.get("/api/workshop/download/feed1234/workshop_output.mid")
    assert r.status_code == 200 and r.content == LEGIT, r.status_code
    print(f"  PASS: {len(attacks)} traversal / directory / symlink attempts all 400/404, legit files download")


def test_job_id_params(client):
    for url in ("/api/separate/%2E%2E", "/api/extend/%2E%2E", "/api/separate/a.b"):
        r = client.post(url)
        assert r.status_code in (400, 404), f"{url} -> {r.status_code}"
    r = client.post("/api/concat/abc12345", data={"ext_job_id": "../../data"})
    assert r.status_code == 400, r.status_code
    print("  PASS: separate/extend/concat reject job ids that aren't plain ids")


def test_status_owner_only(client):
    from routers.jobs import set_job
    set_job("own00001", {"status": "complete", "progress": 100, "result": {"x": 1}, "_owner": "dev", "_charged": "dev"})
    set_job("oth00001", {"status": "complete", "progress": 100, "result": {"x": 1}, "_owner": "someone-else"})
    set_job("nob00001", {"status": "complete", "progress": 100, "result": {"x": 1}})
    r = client.get("/api/status/own00001")
    assert r.status_code == 200 and r.json()["result"] == {"x": 1}, r.text
    assert not any(k.startswith("_") for k in r.json()), r.json()
    assert client.get("/api/status/oth00001").status_code == 404
    assert client.get("/api/status/nob00001").status_code == 404
    assert client.get("/api/status/missing1").status_code == 404
    assert client.post("/api/cancel/oth00001").status_code == 404
    print("  PASS: /api/status and /api/cancel only show a job to its owner, internal keys hidden")


def test_bad_uploads_are_400(client):
    wav = _wav_bytes()
    cases = [
        ("/api/workshop/reference", {"audio": ("song.mp3", b"", "audio/mpeg")}, {}),
        ("/api/workshop/reference", {"audio": ("notes.txt", b"hello there", "text/plain")}, {}),
        ("/api/workshop/reference", {"audio": ("song.mp3", b"not audio at all" * 10, "audio/mpeg")}, {}),
        ("/api/workshop/reference", {"audio": ("big.wav", b"\0" * (25 * 1024 * 1024 + 1), "audio/wav")}, {}),
        ("/api/workshop/generate", {"melody_audio": ("hum.webm", b"garbage" * 20, "audio/webm")}, {"prompt": "x"}),
        ("/api/workshop/generate", {"melody_audio": ("pic.png", b"\x89PNG....", "image/png")}, {"prompt": "x"}),
        ("/api/workshop/generate", None, {"prompt": "x" * 5000}),
        ("/api/analyze-audio", {"audio": ("a.webm", b"", "audio/webm")}, {}),
        ("/api/analyze-audio", {"audio": ("a.webm", b"garbage" * 50, "audio/webm")}, {}),
        ("/api/transcribe", {"audio": ("a.wav", b"", "audio/wav")}, {}),
        ("/api/transcribe", {"audio": ("a.wav", b"RIFF garbage" * 10, "audio/wav")}, {}),
        ("/api/drums/analyze", {"beatbox": ("b.webm", b"garbage" * 20, "audio/webm")}, {}),
        ("/api/jam", {"riff": ("r.webm", b"", "audio/webm")}, {"parts": "[]"}),
    ]
    for url, files, data in cases:
        r = client.post(url, files=files, data=data) if files else client.post(url, data=data)
        assert r.status_code == 400, f"{url} {data or ''} -> {r.status_code} {r.text[:200]}"
    r = client.post("/api/analyze-audio", files={"audio": ("a.wav", wav, "audio/wav")})
    assert r.status_code == 200 and "tempo" in r.json(), r.text
    print(f"  PASS: {len(cases)} empty / non-audio / undecodable / oversized uploads get 400; good audio still analyzes")


def test_refunds(client, store, uploads):
    from routers import generate, jam
    from routers.generate import refund_song
    from routers.jobs import set_job
    import pipelines.midi_generator as mg
    used = lambda: client.get("/api/usage").json()["used"]

    def boom(*a, **k):
        raise RuntimeError("provider exploded")

    real_gen, real_mg, real_jam = generate.generate_from_prompt, mg.generate_from_prompt, jam.run_accompaniment
    generate.generate_from_prompt = boom
    mg.generate_from_prompt = boom
    jam.run_accompaniment = boom
    try:
        before = used()
        r = client.post("/api/generate", data={"prompt": "lofi beat", "mode": "text"})
        assert r.status_code == 200, r.text
        s = _wait(client, r.json()["job_id"])
        assert s["status"] == "error", s
        assert used() == before, f"failed /api/generate must be refunded ({used()} vs {before})"

        r = client.post("/api/jam", files={"riff": ("r.wav", _wav_bytes(), "audio/wav")}, data={"parts": "[]"})
        assert r.status_code == 200, r.text
        s = _wait(client, r.json()["job_id"])
        assert s["status"] == "error", s
        assert used() == before, "failed /api/jam must be refunded"

        (store / "src12345").mkdir()
        (store / "src12345" / "full_mix.mp3").write_bytes(b"not really an mp3")
        r = client.post("/api/extend/src12345")
        assert r.status_code == 200, r.text
        s = _wait(client, r.json()["ext_job_id"])
        assert s["status"] == "error", s
        assert used() == before, "failed /api/extend must be refunded"
    finally:
        generate.generate_from_prompt, mg.generate_from_prompt, jam.run_accompaniment = real_gen, real_mg, real_jam

    # A refund happens at most once per job, however many paths try it
    client.post("/api/studio/compose", json={"prompt": "anything"})
    charged = used()
    set_job("twice001", {"status": "error", "_owner": "dev", "_charged": "dev"})
    refund_song("twice001")
    refund_song("twice001")
    refund_song("twice001")
    assert used() == charged - 1, f"refunded more than once: {used()} vs {charged - 1}"

    # The limit is enforced atomically: at the limit, generate is 429 and nothing is charged
    import database
    db = database.SessionLocal()
    u = db.query(database.User).filter(database.User.id == "dev").first()
    u.usage_count = u.usage_limit
    db.commit()
    db.close()
    for url, kw in (("/api/generate", {"data": {"prompt": "x"}}),
                    ("/api/jam", {"files": {"riff": ("r.wav", _wav_bytes(), "audio/wav")}, "data": {"parts": "[]"}}),
                    ("/api/extend/src12345", {})):
        r = client.post(url, **kw)
        assert r.status_code == 429, f"{url} -> {r.status_code}"
    assert used() == 50, used()
    print("  PASS: failed generate / jam / extend are refunded once; charges are atomic and 429 at the limit")


if __name__ == "__main__":
    print("=" * 50)
    with tempfile.TemporaryDirectory() as tmp:
        client = _client()
        store, uploads = _sandbox(Path(tmp))
        test_download_traversal(client, store, uploads)
        test_job_id_params(client)
        test_status_owner_only(client)
        test_bad_uploads_are_400(client)
        test_refunds(client, store, uploads)
    print("=" * 50)
    print("All tests passed.")
