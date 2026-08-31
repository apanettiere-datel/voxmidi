"""Tests for the fal.ai music provider in midi_generator.

Monkeypatches httpx so no live API call is made.
Covers: _fal_music_api_call writes file and returns path, instrumental payload,
and provider auto-selection (fal when FAL_KEY set, mock when nothing set).
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent / "app"))

import pipelines.midi_generator as mg


# ─── helpers ─────────────────────────────────────────────────────────────────

FAKE_AUDIO = b"\xff\xfb\x90\x00" + b"\x00" * 200  # minimal fake mp3 frame

_SUBMIT_BODY = {
    "request_id": "req-abc-123",
    "status_url": "https://queue.fal.run/fal-ai/minimax-music/v2.6/requests/req-abc-123/status",
    "response_url": "https://queue.fal.run/fal-ai/minimax-music/v2.6/requests/req-abc-123",
    "cancel_url": "https://queue.fal.run/fal-ai/minimax-music/v2.6/requests/req-abc-123/cancel",
    "queue_position": 0,
}


def _resp(json_data=None, content=b"", status_code=200):
    r = MagicMock()
    r.status_code = status_code
    r.is_success = status_code < 400
    r.json.return_value = json_data or {}
    r.content = content
    r.text = str(json_data)
    return r


def _get_sequence(*responses):
    """Returns a side_effect callable that yields responses in order."""
    seq = list(responses)
    idx = [0]

    def side_effect(url, **kwargs):
        r = seq[idx[0]]
        idx[0] += 1
        return r

    return side_effect


# ─── _fal_music_api_call tests ────────────────────────────────────────────────

class TestFalMusicApiCall(unittest.TestCase):

    def _make_get_side(self):
        return _get_sequence(
            _resp({"status": "COMPLETED"}),
            _resp({"audio": {"url": "https://fake.fal.media/song.mp3", "content_type": "audio/mpeg"}}),
            _resp(content=FAKE_AUDIO),
        )

    def test_writes_file_and_returns_path(self):
        post_resp = _resp(_SUBMIT_BODY)
        with tempfile.TemporaryDirectory() as tmpdir:
            job_dir = Path(tmpdir)
            with patch.dict(os.environ, {"FAL_KEY": "test-fal-key"}):
                with patch("httpx.post", return_value=post_resp):
                    with patch("httpx.get", side_effect=self._make_get_side()):
                        result = mg._fal_music_api_call("pop music", "Hello world", job_dir, "out.mp3")

            result_path = Path(result)
            self.assertTrue(result_path.exists(), "Expected output file to be written")
            self.assertEqual(result_path.read_bytes(), FAKE_AUDIO, "File content should match downloaded bytes")

    def test_correct_filename(self):
        post_resp = _resp(_SUBMIT_BODY)
        with tempfile.TemporaryDirectory() as tmpdir:
            job_dir = Path(tmpdir)
            with patch.dict(os.environ, {"FAL_KEY": "test-fal-key"}):
                with patch("httpx.post", return_value=post_resp):
                    with patch("httpx.get", side_effect=self._make_get_side()):
                        result = mg._fal_music_api_call("pop", "lyrics", job_dir, "custom_name.mp3")
            self.assertEqual(Path(result).name, "custom_name.mp3")

    def test_submit_uses_correct_url_and_auth(self):
        post_resp = _resp(_SUBMIT_BODY)
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"FAL_KEY": "test-fal-key"}):
                with patch("httpx.post", return_value=post_resp) as mock_post:
                    with patch("httpx.get", side_effect=self._make_get_side()):
                        mg._fal_music_api_call("pop music", "Hello", Path(tmpdir), "out.mp3")

        call_args = mock_post.call_args
        submitted_url = call_args[0][0]
        auth_header = call_args[1]["headers"]["Authorization"]
        self.assertIn("queue.fal.run", submitted_url)
        self.assertIn("fal-ai/minimax-music/v2.6", submitted_url)
        self.assertEqual(auth_header, "Key test-fal-key")

    def test_lyrics_included_in_payload_when_present(self):
        post_resp = _resp(_SUBMIT_BODY)
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"FAL_KEY": "test-fal-key"}):
                with patch("httpx.post", return_value=post_resp) as mock_post:
                    with patch("httpx.get", side_effect=self._make_get_side()):
                        mg._fal_music_api_call("pop", "[Verse]\nHello world", Path(tmpdir))

        payload = mock_post.call_args[1]["json"]
        self.assertIn("lyrics", payload)
        self.assertNotIn("is_instrumental", payload)

    def test_instrumental_flag_when_no_lyrics(self):
        post_resp = _resp(_SUBMIT_BODY)
        get_side = _get_sequence(
            _resp({"status": "COMPLETED"}),
            _resp({"audio": {"url": "https://fake.fal.media/inst.mp3"}}),
            _resp(content=FAKE_AUDIO),
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"FAL_KEY": "test-fal-key"}):
                with patch("httpx.post", return_value=post_resp) as mock_post:
                    with patch("httpx.get", side_effect=get_side):
                        mg._fal_music_api_call("ambient dronescape", "", Path(tmpdir))

        payload = mock_post.call_args[1]["json"]
        self.assertTrue(payload.get("is_instrumental"), "Expected is_instrumental=True for empty lyrics")
        self.assertNotIn("lyrics", payload)

    def test_model_id_from_env_override(self):
        post_resp = _resp({**_SUBMIT_BODY, "status_url": _SUBMIT_BODY["status_url"].replace("v2.6", "v2.5"),
                           "response_url": _SUBMIT_BODY["response_url"].replace("v2.6", "v2.5")})
        get_side = _get_sequence(
            _resp({"status": "COMPLETED"}),
            _resp({"audio": {"url": "https://fake.fal.media/song.mp3"}}),
            _resp(content=FAKE_AUDIO),
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            env = {"FAL_KEY": "k", "FAL_MUSIC_MODEL": "fal-ai/minimax-music/v2.5"}
            with patch.dict(os.environ, env):
                with patch("httpx.post", return_value=post_resp) as mock_post:
                    with patch("httpx.get", side_effect=get_side):
                        mg._fal_music_api_call("jazz", "lyrics", Path(tmpdir))

        submitted_url = mock_post.call_args[0][0]
        self.assertIn("v2.5", submitted_url)

    def test_raises_when_no_fal_key(self):
        saved = os.environ.pop("FAL_KEY", None)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.assertRaises(RuntimeError, msg="Expected RuntimeError when FAL_KEY not set"):
                    mg._fal_music_api_call("pop", "lyrics", Path(tmpdir))
        finally:
            if saved is not None:
                os.environ["FAL_KEY"] = saved

    def test_raises_on_error_status(self):
        post_resp = _resp(_SUBMIT_BODY)
        get_side = _get_sequence(
            _resp({"status": "ERROR", "error": "generation failed"}),
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"FAL_KEY": "k"}):
                with patch("httpx.post", return_value=post_resp):
                    with patch("httpx.get", side_effect=get_side):
                        with self.assertRaises(RuntimeError):
                            mg._fal_music_api_call("pop", "lyrics", Path(tmpdir))


# ─── provider selection tests ─────────────────────────────────────────────────

class TestProviderSelection(unittest.TestCase):
    """Verify that generate_from_prompt routes to the right provider based on env vars."""

    def _clear_keys(self):
        """Remove provider env vars, return saved values for restoration."""
        keys = ("FAL_KEY", "MINIMAX_API_KEY", "MUSIC_PROVIDER")
        saved = {k: os.environ.pop(k, None) for k in keys}
        return saved

    def _restore_keys(self, saved):
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v

    def test_fal_selected_when_fal_key_set(self):
        saved = self._clear_keys()
        fal_called = []

        def fake_fal(prompt, lyrics, job_dir, out_filename="fal_audio.mp3"):
            path = job_dir / out_filename
            path.write_bytes(b"fake audio")
            fal_called.append(True)
            return str(path)

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                midi_out = str(Path(tmpdir) / "out.mid")
                with patch.dict(os.environ, {"FAL_KEY": "test-key"}):
                    with patch.object(mg, "_fal_music_api_call", side_effect=fake_fal):
                        with patch.object(mg, "_minimax_api_call",
                                          side_effect=AssertionError("minimax must not be called")):
                            mg.generate_from_prompt("pop music", midi_out)
        finally:
            self._restore_keys(saved)

        self.assertTrue(fal_called, "_fal_music_api_call was not called when FAL_KEY is set")

    def test_minimax_selected_when_only_minimax_key(self):
        saved = self._clear_keys()
        minimax_called = []

        def fake_minimax(style_desc, lyrics, job_dir, out_filename="minimax_audio.mp3", voice_audio_path=None):
            path = job_dir / out_filename
            path.write_bytes(b"fake audio")
            minimax_called.append(True)
            return str(path)

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                midi_out = str(Path(tmpdir) / "out.mid")
                with patch.dict(os.environ, {"MINIMAX_API_KEY": "mm-key"}):
                    with patch.object(mg, "_minimax_api_call", side_effect=fake_minimax):
                        with patch.object(mg, "_fal_music_api_call",
                                          side_effect=AssertionError("fal must not be called")):
                            mg.generate_from_prompt("pop music", midi_out)
        finally:
            self._restore_keys(saved)

        self.assertTrue(minimax_called, "_minimax_api_call was not called when only MINIMAX_API_KEY is set")

    def test_mock_when_no_keys(self):
        saved = self._clear_keys()
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                midi_out = str(Path(tmpdir) / "out.mid")
                with patch.object(mg, "_fal_music_api_call",
                                  side_effect=AssertionError("fal must not be called in mock mode")):
                    with patch.object(mg, "_minimax_api_call",
                                      side_effect=AssertionError("minimax must not be called in mock mode")):
                        midi_path, vocal, audio = mg.generate_from_prompt("pop music", midi_out)

                # Check inside the tmpdir context so the file still exists
                self.assertTrue(Path(midi_path).exists(), "Expected MIDI file in mock mode")
                self.assertIsNone(audio, "Expected no audio output in mock mode")
        finally:
            self._restore_keys(saved)

    def test_music_provider_env_overrides_auto(self):
        saved = self._clear_keys()
        mock_reached = []

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                midi_out = str(Path(tmpdir) / "out.mid")
                # FAL_KEY is set but MUSIC_PROVIDER=mock forces mock path
                with patch.dict(os.environ, {"FAL_KEY": "key", "MUSIC_PROVIDER": "mock"}):
                    with patch.object(mg, "_fal_music_api_call",
                                      side_effect=AssertionError("fal must not be called when MUSIC_PROVIDER=mock")):
                        midi_path, _, audio = mg.generate_from_prompt("pop music", midi_out)
                        mock_reached.append(True)
        finally:
            self._restore_keys(saved)

        self.assertTrue(mock_reached)
        self.assertIsNone(audio)


if __name__ == "__main__":
    unittest.main(verbosity=2)
