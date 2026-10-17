"""Split a recorded take into stems (vocals, drums, bass, other) with Demucs
running on the local GPU service.

Provider selection:
  DEMUCS_API_URL set -> "demucs" (htdemucs_ft on the local GPU, same host-service
                        pattern as ACE-Step: bound to the compose gateway)
  unset -> "mock" (short synthetic stems so dev without the GPU still works)
"""

import io
import os
import zipfile
from pathlib import Path
from typing import Callable

import httpx
import numpy as np
import soundfile as sf

SR = 44100
STEM_NAMES = ("vocals", "drums", "bass", "other")
STEM_LABELS = {"vocals": "Vocals", "drums": "Drums", "bass": "Bass", "other": "Other"}


def provider_name() -> str:
    p = os.environ.get("STEMS_PROVIDER", "auto").lower()
    if p == "auto":
        return "demucs" if os.environ.get("DEMUCS_API_URL") else "mock"
    return p


def _mock_stems(duration_seconds: float = 4.0) -> dict:
    """A distinct quiet tone per stem, faded so it does not click."""
    freqs = {"vocals": 440.0, "drums": 110.0, "bass": 82.41, "other": 329.63}
    n = int(duration_seconds * SR)
    t = np.arange(n, dtype=np.float32) / SR
    fade = min(int(0.05 * SR), n // 4)
    ramp = np.linspace(0, 1, fade, dtype=np.float32)
    out = {}
    for name, f in freqs.items():
        y = (0.12 * np.sin(2 * np.pi * f * t)).astype(np.float32)
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]
        out[name] = y
    return out


def _demucs_separate(audio_bytes: bytes, http=None) -> dict:
    """Send the take to the local Demucs service; returns {stem name: wav bytes}."""
    http = http or httpx

    base_url = os.environ.get("DEMUCS_API_URL", "").rstrip("/")
    key = os.environ.get("DEMUCS_API_KEY", "")
    headers = {"x-api-key": key} if key else {}

    r = http.post(
        f"{base_url}/separate",
        headers=headers,
        files={"audio": ("take.wav", audio_bytes, "audio/wav")},
        timeout=600.0,
    )
    if not r.is_success:
        raise RuntimeError(f"Demucs service failed {r.status_code}: {r.text[:200]}")

    stems = {}
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        for info in z.infolist():
            name = Path(info.filename).stem
            if name in STEM_NAMES:
                stems[name] = z.read(info)
    if not stems:
        raise RuntimeError("Demucs service returned no stems")
    return stems


def make_stems(
    audio_bytes: bytes,
    job_dir: Path,
    progress: Callable[[int, str], None] = lambda p, s: None,
    http=None,
) -> dict:
    """Split the take into stems. Writes stem_{name}.wav files into job_dir."""
    provider = provider_name()

    if provider == "mock":
        progress(20, "separating")
        decoded = _mock_stems()
    else:
        progress(10, "separating")
        raw = _demucs_separate(audio_bytes, http=http)
        progress(80, "decoding_audio")
        decoded = {}
        for name, data in raw.items():
            y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
            y = y.mean(axis=1)
            if sr != SR:
                import librosa  # local: slow import, only pay it when resampling
                y = librosa.resample(y, orig_sr=sr, target_sr=SR)
            decoded[name] = y.astype(np.float32)

    files = {}
    for name, y in decoded.items():
        path = job_dir / f"stem_{name}.wav"
        sf.write(str(path), y, SR, subtype="PCM_16")
        files[name] = path.name
    progress(100, "complete")
    return {"files": files, "provider": provider}
