"""Tests for the band member (ACE-Step Lego stem) feature.

1. Pipeline test against a real local mock ACE-Step HTTP server.
2. Endpoint tests: bad part -> 400, happy path -> 200, usage_count unchanged.

Run from backend/ with:
    python test_band.py
or via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_band.py
"""

import io
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

import numpy as np
import soundfile as sf

# ─── helpers ─────────────────────────────────────────────────────────────────

TASK_ID = "band-test-task-001"


def _wav_bytes(duration=1.0, sr=44100) -> bytes:
    """Minimal WAV the mock server serves as the stem result."""
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(duration * sr), dtype=np.float32), sr, format="WAV")
    return buf.getvalue()


MOCK_WAV = _wav_bytes()


class _MockAceStep(BaseHTTPRequestHandler):
    """Minimal ACE-Step API mock: health, release_task, query_result, audio download."""

    def log_message(self, *args):
        pass  # silence the server log

    def _read_body(self):
        length = self.headers.get("Content-Length", "0")
        try:
            n = int(length)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n else b""

    def _send(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._read_body()
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            body = json.dumps({
                "data": {"status": "ok", "loaded_model": self.server.health_model},
            }).encode()
            self._send(200, "application/json", body)
        elif parsed.path == "/v1/audio":
            self._send(200, "audio/wav", MOCK_WAV)
        else:
            self._send(404, "text/plain", b"not found")

    def do_POST(self):
        raw = self._read_body()
        parsed = urlparse(self.path)
        if parsed.path == "/release_task":
            self.server.release_bodies.append(raw)
            body = json.dumps({"data": {"task_id": TASK_ID}}).encode()
            self._send(200, "application/json", body)
        elif parsed.path == "/query_result":
            # Real API shape: rows live in a {"data": [...], "code": 200} envelope
            result_str = json.dumps([{"file": "/v1/audio"}])
            body = json.dumps({
                "data": [{"task_id": TASK_ID, "status": 1, "result": result_str}],
                "code": 200,
            }).encode()
            self._send(200, "application/json", body)
        elif parsed.path == "/v1/init":
            self.server.init_calls.append(True)
            self._send(200, "application/json", b'{"ok": true}')
        else:
            self._send(404, "text/plain", b"not found")


def _start_mock_server(model="acestep-v15-base"):
    """Spin up a mock ACE-Step server on a random port. Returns (server, url)."""
    server = HTTPServer(("127.0.0.1", 0), _MockAceStep)
    server.health_model = model
    server.init_calls = []
    server.release_bodies = []
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, f"http://127.0.0.1:{port}"


# ─── Pipeline tests ───────────────────────────────────────────────────────────

def test_mock_provider():
    """Mock provider writes band_{part}.wav without any HTTP server."""
    from pipelines.band import make_band_stem

    mix = _wav_bytes(duration=2.0)
    with tempfile.TemporaryDirectory() as tmp:
        result = make_band_stem(mix, "guitar", "clean electric", Path(tmp))
    assert result["provider"] == "mock"
    assert result["part"] == "guitar"
    assert result["duration"] > 0
    print("  PASS: mock provider generates a placeholder stem")


def test_acestep_provider_against_mock_server():
    """acestep provider submits to mock server and lands band_guitar.wav in the job dir."""
    from pipelines.band import make_band_stem

    server, url = _start_mock_server()
    mix = _wav_bytes(duration=2.0)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            saved = {
                "BAND_PROVIDER": os.environ.pop("BAND_PROVIDER", None),
                "ACESTEP_API_URL": os.environ.pop("ACESTEP_API_URL", None),
                "ACESTEP_API_KEY": os.environ.pop("ACESTEP_API_KEY", None),
            }
            os.environ["BAND_PROVIDER"] = "acestep"
            os.environ["ACESTEP_API_URL"] = url
            try:
                result = make_band_stem(mix, "guitar", "clean electric", Path(tmp), sleep=lambda s: None)
            finally:
                for k, v in saved.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v

            wav_path = Path(tmp) / "band_guitar.wav"
            assert wav_path.exists(), "band_guitar.wav not written"
            y, sr = sf.read(str(wav_path))
            assert sr == 44100 and len(y) > 0
            assert result["provider"] == "acestep"
            assert result["file"] == "band_guitar.wav"
    finally:
        server.shutdown()
    print(f"  PASS: acestep provider downloads stem and writes band_guitar.wav ({result['duration']:.2f}s)")


def test_init_called_when_wrong_model_loaded():
    """If health returns a non-base model, POST /v1/init is called before the task."""
    from pipelines.band import make_band_stem

    server, url = _start_mock_server(model="acestep-v15-turbo")

    mix = _wav_bytes()
    saved_url = os.environ.pop("ACESTEP_API_URL", None)
    saved_prov = os.environ.pop("BAND_PROVIDER", None)
    os.environ["BAND_PROVIDER"] = "acestep"
    os.environ["ACESTEP_API_URL"] = url
    try:
        with tempfile.TemporaryDirectory() as tmp:
            make_band_stem(mix, "bass", "", Path(tmp), sleep=lambda s: None)
    finally:
        if saved_url is None:
            os.environ.pop("ACESTEP_API_URL", None)
        else:
            os.environ["ACESTEP_API_URL"] = saved_url
        if saved_prov is None:
            os.environ.pop("BAND_PROVIDER", None)
        else:
            os.environ["BAND_PROVIDER"] = saved_prov
        server.shutdown()

    assert server.init_calls, "/v1/init was not called when the turbo model was loaded"
    print("  PASS: /v1/init is called when the wrong model is loaded")


def test_lyrics_reach_acestep_and_turn_thinking_on():
    """A vocals request with lyrics sends them to ACE-Step with thinking on;
    an instrumental request keeps thinking off and sends no lyrics."""
    from pipelines.band import make_band_stem

    server, url = _start_mock_server()
    mix = _wav_bytes(duration=2.0)
    saved = {
        "BAND_PROVIDER": os.environ.pop("BAND_PROVIDER", None),
        "ACESTEP_API_URL": os.environ.pop("ACESTEP_API_URL", None),
        "ACESTEP_API_KEY": os.environ.pop("ACESTEP_API_KEY", None),
    }
    os.environ["BAND_PROVIDER"] = "acestep"
    os.environ["ACESTEP_API_URL"] = url
    try:
        with tempfile.TemporaryDirectory() as tmp:
            make_band_stem(mix, "guitar", "clean electric", Path(tmp), sleep=lambda s: None)
            make_band_stem(mix, "vocals", "warm female lead", Path(tmp), sleep=lambda s: None,
                           lyrics="[verse]\nHold on, the night is thin")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        server.shutdown()

    plain, sung = server.release_bodies
    assert b'name="lyrics"' not in plain and b'name="thinking"\r\n\r\nfalse' in plain
    assert b'name="lyrics"' in sung and b"the night is thin" in sung
    assert b'name="thinking"\r\n\r\ntrue' in sung
    print("  PASS: lyrics travel to ACE-Step and turn thinking on, instrumental stays off")


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
    return TestClient(app), Session


def _wait(client, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/api/status/{job_id}").json()
        if s["status"] in ("complete", "error", "cancelled"):
            return s
        time.sleep(0.2)
    raise AssertionError("job did not finish")


def _usage(client):
    r = client.get("/api/usage")
    assert r.status_code == 200, r.text
    return r.json()


def test_endpoint_rejects_bad_part():
    """POST with an unknown part returns 400, not 422 or 500."""
    client, _ = _client()
    mix_wav = _wav_bytes()
    r = client.post(
        "/api/studio/parts/band",
        files={"mix": ("mix.wav", io.BytesIO(mix_wav), "audio/wav")},
        data={"part": "kazoo"},
    )
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    assert "part" in r.json().get("detail", "").lower()
    print("  PASS: bad part -> 400 with readable detail")


def test_endpoint_happy_path_no_usage_charge():
    """Mock provider: job completes, audio is downloadable, usage_count is unchanged."""
    client, _ = _client()
    mix_wav = _wav_bytes()

    saved_prov = os.environ.pop("BAND_PROVIDER", None)
    saved_url = os.environ.pop("ACESTEP_API_URL", None)
    os.environ["BAND_PROVIDER"] = "mock"
    try:
        before = _usage(client)["used"]
        r = client.post(
            "/api/studio/parts/band",
            files={"mix": ("mix.wav", io.BytesIO(mix_wav), "audio/wav")},
            data={"part": "guitar", "style": "clean electric"},
        )
    finally:
        if saved_prov is None:
            os.environ.pop("BAND_PROVIDER", None)
        else:
            os.environ["BAND_PROVIDER"] = saved_prov
        if saved_url is None:
            os.environ.pop("ACESTEP_API_URL", None)
        else:
            os.environ["ACESTEP_API_URL"] = saved_url

    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert data["provider"] == "mock"
    assert "job_id" in data

    s = _wait(client, data["job_id"])
    assert s["status"] == "complete", s
    assert s["result"]["part"] == "guitar"
    assert s["result"]["provider"] == "mock"

    # The stem is downloadable
    audio = client.get(s["result"]["audio_url"])
    assert audio.status_code == 200 and audio.content[:4] == b"RIFF"

    # No usage charge
    after = _usage(client)["used"]
    assert after == before, f"usage_count changed from {before} to {after}; band stem must be free"
    print(f"  PASS: band stem completes (provider=mock), audio is {len(audio.content)} bytes, usage_count unchanged")


def test_endpoint_empty_mix_is_400():
    """An empty mix file returns 400."""
    client, _ = _client()
    r = client.post(
        "/api/studio/parts/band",
        files={"mix": ("mix.wav", io.BytesIO(b""), "audio/wav")},
        data={"part": "guitar"},
    )
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    print("  PASS: empty mix -> 400")


if __name__ == "__main__":
    print("=" * 55)
    test_mock_provider()
    test_acestep_provider_against_mock_server()
    test_init_called_when_wrong_model_loaded()
    test_lyrics_reach_acestep_and_turn_thinking_on()
    test_endpoint_rejects_bad_part()
    test_endpoint_happy_path_no_usage_charge()
    test_endpoint_empty_mix_is_400()
    print("=" * 55)
    print("All band tests passed.")
