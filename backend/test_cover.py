"""Tests for the AI cover feature (MIDI part -> sample render -> ACE-Step cover).

1. Pipeline tests against a real local mock ACE-Step HTTP server.
2. Endpoint tests: bad style / bad strength -> 400, happy path -> 200, free.

Run from backend/ with:
    python test_cover.py
or via Docker:
    docker run --rm -e DEV_MODE=true -v $PWD/backend:/work -w /work voxmidi-backend python test_cover.py
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

TASK_ID = "cover-test-task-001"

NOTES = [
    {"p": 36, "t": 0.0, "d": 1.0, "v": 100},
    {"p": 43, "t": 2.0, "d": 1.0, "v": 100},
    {"p": 36, "t": 4.0, "d": 2.0, "v": 90},
]
TEMPO = 120
TOTAL_BEATS = 8


def _tone_wav_bytes(duration=2.0, sr=44100) -> bytes:
    """Non-silent WAV the mock server serves as the cover result
    (silence would trip the pipeline's silence check)."""
    t = np.arange(int(duration * sr), dtype=np.float32) / sr
    y = 0.3 * np.sin(2 * np.pi * 220.0 * t).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV")
    return buf.getvalue()


MOCK_WAV = _tone_wav_bytes()


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
        body = self._read_body()
        parsed = urlparse(self.path)
        if parsed.path == "/release_task":
            self.server.release_bodies.append(body)
            reply = json.dumps({"data": {"task_id": TASK_ID}}).encode()
            self._send(200, "application/json", reply)
        elif parsed.path == "/query_result":
            result_str = json.dumps([{"file": "/v1/audio"}])
            reply = json.dumps({
                "data": [{"task_id": TASK_ID, "status": 1, "result": result_str}],
                "code": 200,
            }).encode()
            self._send(200, "application/json", reply)
        elif parsed.path == "/v1/init":
            self.server.init_calls.append(True)
            self._send(200, "application/json", b'{"ok": true}')
        else:
            self._send(404, "text/plain", b"not found")


def _start_mock_server(model="acestep-v15-turbo"):
    server = HTTPServer(("127.0.0.1", 0), _MockAceStep)
    server.health_model = model
    server.init_calls = []
    server.release_bodies = []
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, f"http://127.0.0.1:{port}"


def _with_env(provider, url, fn):
    """Run fn with BAND_PROVIDER/ACESTEP_API_URL set, restoring the old values after."""
    saved = {k: os.environ.pop(k, None) for k in ("BAND_PROVIDER", "ACESTEP_API_URL", "ACESTEP_API_KEY")}
    if provider:
        os.environ["BAND_PROVIDER"] = provider
    if url:
        os.environ["ACESTEP_API_URL"] = url
    try:
        return fn()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ─── Pipeline tests ───────────────────────────────────────────────────────────

def test_mock_provider():
    """Without ACE-Step configured the sample render itself is placed, match 100."""
    from pipelines.part_render import make_cover_part

    with tempfile.TemporaryDirectory() as tmp:
        result = _with_env(None, None, lambda: make_cover_part(
            "bass", "finger", NOTES, TEMPO, TOTAL_BEATS, 1.0, Path(tmp)))
        assert (Path(tmp) / "bass_cover.wav").exists(), "bass_cover.wav not written"
    assert result["provider"] == "mock"
    assert result["cover"] is True
    assert result["match"] == 100
    print("  PASS: mock provider places the sample render as the cover")


def test_acestep_provider_against_mock_server():
    """acestep provider submits task_type=cover with audio_cover_strength and writes the stem."""
    from pipelines.part_render import make_cover_part

    server, url = _start_mock_server(model="acestep-v15-turbo")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            result = _with_env("acestep", url, lambda: make_cover_part(
                "bass", "finger", NOTES, TEMPO, TOTAL_BEATS, 0.85, Path(tmp), sleep=lambda s: None))
            wav_path = Path(tmp) / "bass_cover.wav"
            assert wav_path.exists(), "bass_cover.wav not written"
            y, sr = sf.read(str(wav_path))
            assert sr == 44100 and len(y) > 0
        assert result["provider"] == "acestep"
        assert result["strength"] == 0.85
        assert isinstance(result["match"], int)
        body = server.release_bodies[0]
        assert b"cover" in body, "task_type=cover not in the release_task body"
        assert b"audio_cover_strength" in body and b"1.00" in body, "audio_cover_strength not sent"
        # the user's 0.85 drives cover_noise_strength (the keep-the-notes knob): 0.85 * 0.85
        assert b"cover_noise_strength" in body and b"0.72" in body, "cover_noise_strength not sent"
        assert not server.init_calls, "cover must not swap models when turbo is loaded"
    finally:
        server.shutdown()
    print(f"  PASS: cover submitted (strength 0.85, no model swap on turbo), stem written ({result['duration']:.2f}s, match {result['match']}%)")


def test_init_called_when_no_model_loaded():
    """If health reports no loaded model, /v1/init loads the base model first."""
    from pipelines.part_render import make_cover_part

    server, url = _start_mock_server(model="")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            _with_env("acestep", url, lambda: make_cover_part(
                "bass", "finger", NOTES, TEMPO, TOTAL_BEATS, 1.0, Path(tmp), sleep=lambda s: None))
        assert server.init_calls, "/v1/init was not called when no model was loaded"
    finally:
        server.shutdown()
    print("  PASS: /v1/init is called when no model is loaded")


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


def _wait(client, job_id, timeout=120):
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


def _body(**overrides):
    base = {"part": "bass", "style": "finger", "tempo": TEMPO, "total_beats": TOTAL_BEATS,
            "notes": NOTES, "strength": 1.0}
    base.update(overrides)
    return base


def test_endpoint_rejects_bad_style():
    client, _ = _client()
    r = client.post("/api/studio/parts/cover", json=_body(style="piano"))
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    assert "style" in r.json().get("detail", "").lower()
    print("  PASS: bad style -> 400 with readable detail")


def test_endpoint_rejects_bad_strength():
    client, _ = _client()
    r = client.post("/api/studio/parts/cover", json=_body(strength=0.1))
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
    assert "strength" in r.json().get("detail", "").lower()
    print("  PASS: strength below 0.3 -> 400")


def test_endpoint_happy_path_no_usage_charge():
    client, _ = _client()
    before = _usage(client)["used"]

    def run():
        r = client.post("/api/studio/parts/cover", json=_body())
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
        # keep the env override until the background job finishes
        return r.json(), _wait(client, r.json()["job_id"])

    data, s = _with_env("mock", None, run)
    assert data["provider"] == "mock"
    assert s["status"] == "complete", s
    assert s["result"]["cover"] is True
    assert s["result"]["part"] == "bass"

    audio = client.get(s["result"]["audio_url"])
    assert audio.status_code == 200 and audio.content[:4] == b"RIFF"

    after = _usage(client)["used"]
    assert after == before, f"usage_count changed from {before} to {after}; cover must be free"
    print(f"  PASS: cover completes (provider=mock), audio is {len(audio.content)} bytes, usage_count unchanged")


if __name__ == "__main__":
    print("=" * 55)
    test_mock_provider()
    test_acestep_provider_against_mock_server()
    test_init_called_when_no_model_loaded()
    test_endpoint_rejects_bad_style()
    test_endpoint_rejects_bad_strength()
    test_endpoint_happy_path_no_usage_charge()
    print("=" * 55)
    print("All cover tests passed.")
