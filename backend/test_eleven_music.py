"""Tests for the AI-part generator (ElevenLabs music).

1. Pipeline: mock provider, and the eleven provider against a local mock server
   (prompt body vs conditioning composition_plan).
2. Endpoint: happy path, bad input.

Run via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_eleven_music.py
"""

import io
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf


def _mp3ish_wav() -> bytes:
    # soundfile can't write mp3 everywhere; the pipeline decodes via soundfile
    # then librosa, so a WAV body is fine for the test.
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(1.0 * 44100), dtype=np.float32), 44100, format="WAV")
    return buf.getvalue()


BODY = _mp3ish_wav()


class _MockEleven(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b""
        self.server.bodies.append(raw)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("song-id", "SONGID12345")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)


def _server():
    s = HTTPServer(("127.0.0.1", 0), _MockEleven)
    s.bodies = []
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, f"http://127.0.0.1:{s.server_address[1]}"


def test_mock_provider():
    from pipelines.eleven_music import generate_part
    saved = os.environ.pop("ELEVENLABS_API_KEY", None)
    os.environ["ELEVEN_MUSIC_PROVIDER"] = "mock"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            r = generate_part("deep edm bass", 8000, Path(tmp))
        assert r["provider"] == "mock" and r["duration"] > 0 and r["song_id"].startswith("mock-")
    finally:
        os.environ.pop("ELEVEN_MUSIC_PROVIDER", None)
        if saved is not None:
            os.environ["ELEVENLABS_API_KEY"] = saved
    print("  PASS: mock provider writes a placeholder part with a song_id")


def test_eleven_prompt_body():
    import httpx
    from pipelines.eleven_music import generate_part
    s, url = _server()
    os.environ["ELEVENLABS_API_KEY"] = "sk_test"
    os.environ["ELEVEN_MUSIC_PROVIDER"] = "eleven"
    import pipelines.eleven_music as em
    orig_api = em.API
    em.API = url
    try:
        with tempfile.TemporaryDirectory() as tmp:
            r = generate_part("deep edm bass", 8000, Path(tmp), http=httpx)
        body = json.loads(s.bodies[0])
        assert "prompt" in body and body["music_length_ms"] == 8000 and body["store_for_inpainting"] is True
        assert "composition_plan" not in body
        assert r["song_id"] == "SONGID12345" and r["provider"] == "eleven"
    finally:
        em.API = orig_api
        os.environ.pop("ELEVENLABS_API_KEY", None)
        os.environ.pop("ELEVEN_MUSIC_PROVIDER", None)
        s.shutdown()
    print("  PASS: prompt generation sends a prompt body and reads the song-id header")


def test_eleven_conditioning_body():
    import httpx
    from pipelines.eleven_music import generate_part
    s, url = _server()
    os.environ["ELEVENLABS_API_KEY"] = "sk_test"
    os.environ["ELEVEN_MUSIC_PROVIDER"] = "eleven"
    import pipelines.eleven_music as em
    orig_api = em.API
    em.API = url
    try:
        with tempfile.TemporaryDirectory() as tmp:
            generate_part("bright supersaw lead", 8000, Path(tmp), ref_song_id="PREV123", http=httpx)
        body = json.loads(s.bodies[0])
        assert "prompt" not in body, "a conditioned part must use composition_plan, not prompt"
        sec = body["composition_plan"]["sections"][0]
        assert sec["conditioning_ref"]["song_id"] == "PREV123"
        assert sec["conditioning_ref"]["range"] == {"start_ms": 0, "end_ms": 8000}
    finally:
        em.API = orig_api
        os.environ.pop("ELEVENLABS_API_KEY", None)
        os.environ.pop("ELEVEN_MUSIC_PROVIDER", None)
        s.shutdown()
    print("  PASS: a reference song_id produces a conditioning composition_plan")


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


def test_endpoint_happy_path():
    os.environ["ELEVEN_MUSIC_PROVIDER"] = "mock"
    try:
        client = _client()
        r = client.post("/api/studio/parts/generate", json={"prompt": "deep edm bass", "length_ms": 8000})
        assert r.status_code == 200, f"{r.status_code}: {r.text}"
        assert r.json()["provider"] == "mock" and "job_id" in r.json()
    finally:
        os.environ.pop("ELEVEN_MUSIC_PROVIDER", None)
    print("  PASS: endpoint starts a job and reports the provider")


def test_endpoint_rejects_bad_input():
    client = _client()
    for body in ({"prompt": "x"}, {}, {"prompt": "ok", "length_ms": 1000}):
        r = client.post("/api/studio/parts/generate", json=body)
        assert r.status_code == 400, f"expected 400 for {body}, got {r.status_code}"
    print("  PASS: short prompt, missing prompt and too-short length -> 400")


if __name__ == "__main__":
    print("=" * 55)
    test_mock_provider()
    test_eleven_prompt_body()
    test_eleven_conditioning_body()
    test_endpoint_happy_path()
    test_endpoint_rejects_bad_input()
    print("=" * 55)
    print("All eleven-music tests passed.")
