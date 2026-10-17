"""Tests for the stem-split feature (Demucs on the local GPU service).

1. Pipeline tests: mock provider, and the demucs provider against a local
   mock HTTP server that returns a zip of stem WAVs.
2. Endpoint tests: happy path with no usage charge, empty take -> 400.

Run via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_stems.py
"""

import io
import os
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf

# ─── helpers ─────────────────────────────────────────────────────────────────


def _wav_bytes(duration=1.0, sr=44100) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(duration * sr), dtype=np.float32), sr, format="WAV")
    return buf.getvalue()


def _stems_zip(names=("vocals", "drums", "bass", "other")) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n in names:
            z.writestr(f"{n}.wav", _wav_bytes())
    return buf.getvalue()


class _MockDemucs(BaseHTTPRequestHandler):
    """Minimal Demucs service mock: /separate returns a zip of stem WAVs."""

    def log_message(self, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        self.rfile.read(n)
        if self.path == "/separate":
            self.server.seen_keys.append(self.headers.get("x-api-key"))
            body = _stems_zip()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


def _start_mock_server():
    server = HTTPServer(("127.0.0.1", 0), _MockDemucs)
    server.seen_keys = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def _with_env(env, fn):
    saved = {k: os.environ.pop(k, None) for k in ("STEMS_PROVIDER", "DEMUCS_API_URL", "DEMUCS_API_KEY")}
    os.environ.update(env)
    try:
        return fn()
    finally:
        for k in ("STEMS_PROVIDER", "DEMUCS_API_URL", "DEMUCS_API_KEY"):
            os.environ.pop(k, None)
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


# ─── Pipeline tests ───────────────────────────────────────────────────────────

def test_mock_provider():
    from pipelines.stems import make_stems

    with tempfile.TemporaryDirectory() as tmp:
        result = _with_env({}, lambda: make_stems(_wav_bytes(), Path(tmp)))
        assert result["provider"] == "mock"
        assert sorted(result["files"]) == ["bass", "drums", "other", "vocals"]
        for fname in result["files"].values():
            assert (Path(tmp) / fname).exists()
    print("  PASS: mock provider writes four placeholder stems")


def test_demucs_provider_against_mock_server():
    from pipelines.stems import make_stems

    server, url = _start_mock_server()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            result = _with_env(
                {"DEMUCS_API_URL": url, "DEMUCS_API_KEY": "sekret"},
                lambda: make_stems(_wav_bytes(), Path(tmp)),
            )
            assert result["provider"] == "demucs"
            assert sorted(result["files"]) == ["bass", "drums", "other", "vocals"]
            y, sr = sf.read(str(Path(tmp) / result["files"]["drums"]))
            assert sr == 44100 and len(y) > 0
            assert server.seen_keys == ["sekret"], "api key header not sent"
    finally:
        server.shutdown()
    print("  PASS: demucs provider unzips four stems and sends the api key")


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


def _wait(client, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/api/status/{job_id}").json()
        if s["status"] in ("complete", "error", "cancelled"):
            return s
        time.sleep(0.2)
    raise AssertionError("job did not finish")


def test_endpoint_happy_path_no_usage_charge():
    client = _client()

    def run():
        before = client.get("/api/usage").json()["used"]
        r = client.post("/api/studio/stems", files={"take": ("take.wav", io.BytesIO(_wav_bytes()), "audio/wav")})
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert data["provider"] == "mock"
        s = _wait(client, data["job_id"])
        assert s["status"] == "complete", s
        stems = s["result"]["stems"]
        assert sorted(stems) == ["bass", "drums", "other", "vocals"]
        audio = client.get(stems["vocals"])
        assert audio.status_code == 200 and audio.content[:4] == b"RIFF"
        after = client.get("/api/usage").json()["used"]
        assert after == before, "stem split must be free"
        return len(audio.content)

    size = _with_env({}, run)
    print(f"  PASS: stems job completes (provider=mock), vocals stem is {size} bytes, usage unchanged")


def test_endpoint_empty_take_is_400():
    client = _client()
    r = client.post("/api/studio/stems", files={"take": ("take.wav", io.BytesIO(b""), "audio/wav")})
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    print("  PASS: empty take -> 400")


if __name__ == "__main__":
    print("=" * 55)
    test_mock_provider()
    test_demucs_provider_against_mock_server()
    test_endpoint_happy_path_no_usage_charge()
    test_endpoint_empty_take_is_400()
    print("=" * 55)
    print("All stems tests passed.")
