"""Generate one instrument or vocal part from a plain-language prompt using the
ElevenLabs Music API, optionally conditioned on an earlier part.

The studio's "AI part" tracks use this: type what you want ("deep EDM reese
bass"), get an audio stem. A later part can be conditioned on an earlier one by
passing its song_id, so a melody can be built to fit a bass (ElevenLabs audio
reference, available on all paid Music v2/v2.5 plans).

Provider selection:
  ELEVENLABS_API_KEY set -> "eleven" (real API)
  unset -> "mock" (a short placeholder tone, for dev/test without a key)
"""

import os
import time
from pathlib import Path
from typing import Callable, Optional

import httpx
import numpy as np
import soundfile as sf

SR = 44100
API = "https://api.elevenlabs.io/v1/music"
MIN_MS, MAX_MS = 3000, 120000


def provider_name() -> str:
    p = os.environ.get("ELEVEN_MUSIC_PROVIDER", "auto").lower()
    if p == "auto":
        return "eleven" if os.environ.get("ELEVENLABS_API_KEY") else "mock"
    return p


def _mock_part(seconds: float = 4.0) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n, dtype=np.float32) / SR
    y = 0.2 * np.sin(2 * np.pi * 110 * t) * np.exp(-t % 0.5 * 2)
    fade = min(int(0.05 * SR), n // 4)
    r = np.linspace(0, 1, fade, dtype=np.float32)
    y[:fade] *= r
    y[-fade:] *= r[::-1]
    return y.astype(np.float32)


def _compose_body(prompt: str, length_ms: int, ref_song_id: Optional[str]) -> dict:
    """A prompt body, or a one-section composition plan that conditions on a reference.
    prompt and composition_plan are mutually exclusive in the API."""
    if not ref_song_id:
        return {"prompt": prompt, "music_length_ms": length_ms, "store_for_inpainting": True}
    # Condition the new part on an earlier one via its song_id.
    return {
        "composition_plan": {
            "positive_global_styles": [s.strip() for s in prompt.split(",") if s.strip()][:8] or [prompt[:60]],
            "negative_global_styles": [],
            "sections": [{
                "section_name": "part",
                "positive_local_styles": [prompt[:120]],
                "negative_local_styles": [],
                "duration_ms": length_ms,
                "lines": [],
                "conditioning_ref": {"song_id": ref_song_id, "range": {"start_ms": 0, "end_ms": length_ms}},
            }],
        },
        "store_for_inpainting": True,
    }


def _decode(data: bytes) -> np.ndarray:
    import io
    y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y.astype(np.float32)


def generate_song(
    prompt: str,
    lyrics: str,
    length_ms: int,
    job_dir: Path,
    progress: Callable[[int, str], None] = lambda p, s: None,
    http=None,
) -> dict:
    """Generate a whole finished song from a style prompt and optional lyrics.
    Writes ai_song.wav; returns its song_id."""
    length_ms = max(MIN_MS, min(MAX_MS, int(length_ms)))
    provider = provider_name()
    if provider == "mock":
        progress(30, "generating_song")
        y = _mock_part(length_ms / 1000)
        song_id = f"mock-{int(time.time())}"
    else:
        http = http or httpx
        key = os.environ["ELEVENLABS_API_KEY"]
        text = prompt.strip()
        if lyrics.strip():
            # The music endpoint takes a single prompt; the lyrics ride along in it.
            text = f"{text}. Sing these lyrics:\n{lyrics.strip()}"
        progress(15, "generating_song")
        resp = http.post(
            f"{API}?output_format=mp3_44100_128",
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json={"prompt": text, "music_length_ms": length_ms},
            timeout=300.0,
        )
        if not resp.is_success:
            raise RuntimeError(f"ElevenLabs music failed {resp.status_code}: {resp.text[:300]}")
        song_id = resp.headers.get("song-id", "")
        progress(80, "decoding_audio")
        y = _decode(resp.content)
    path = job_dir / "ai_song.wav"
    sf.write(str(path), y, SR, subtype="PCM_16")
    progress(100, "complete")
    return {"file": path.name, "provider": provider, "song_id": song_id, "duration": round(len(y) / SR, 3)}


def generate_part(
    prompt: str,
    length_ms: int,
    job_dir: Path,
    ref_song_id: Optional[str] = None,
    progress: Callable[[int, str], None] = lambda p, s: None,
    http=None,
) -> dict:
    """Generate one part. Writes ai_part.wav; returns its song_id so a later part
    can be conditioned on it."""
    length_ms = max(MIN_MS, min(MAX_MS, int(length_ms)))
    provider = provider_name()

    if provider == "mock":
        progress(30, "generating_part")
        y = _mock_part(length_ms / 1000)
        song_id = f"mock-{int(time.time())}"
    else:
        http = http or httpx
        key = os.environ["ELEVENLABS_API_KEY"]
        progress(15, "generating_part")
        resp = http.post(
            f"{API}?output_format=mp3_44100_128",
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json=_compose_body(prompt, length_ms, ref_song_id),
            timeout=180.0,
        )
        if not resp.is_success:
            raise RuntimeError(f"ElevenLabs music failed {resp.status_code}: {resp.text[:300]}")
        song_id = resp.headers.get("song-id", "")
        progress(80, "decoding_audio")
        y = _decode(resp.content)

    path = job_dir / "ai_part.wav"
    sf.write(str(path), y, SR, subtype="PCM_16")
    progress(100, "complete")
    return {
        "file": path.name,
        "provider": provider,
        "song_id": song_id,
        "prompt": prompt,
        "duration": round(len(y) / SR, 3),
    }
