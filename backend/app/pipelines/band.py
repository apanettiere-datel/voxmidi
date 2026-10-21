"""Add a band member: generate an isolated audio stem for a given instrument
using ACE-Step in Lego (accompaniment) mode.

The existing mix is uploaded as the audio context. ACE-Step's Lego task
generates one instrument stem that fits the mix, so each call adds one
player to the song.

Provider selection:
  ACESTEP_API_URL set -> "acestep" provider (real ACE-Step API on the local GPU)
  ACESTEP_API_URL unset -> "mock" provider (short placeholder WAV for dev/test)

ACE-Step requires the base model (acestep-v15-base). If the health check
shows a different model loaded, the pipeline calls POST /v1/init to swap
before submitting the task.
"""

import io
import json
import os
import time
from pathlib import Path
from typing import Callable

import httpx
import numpy as np
import soundfile as sf

SR = 44100

VALID_PARTS = frozenset([
    "vocals", "backing_vocals", "drums", "bass", "guitar",
    "keyboard", "percussion", "strings", "synth", "fx", "brass", "woodwinds",
])

PART_LABELS = {
    "vocals": "Vocals",
    "backing_vocals": "Backing vocals",
    "drums": "Drums",
    "bass": "Bass",
    "guitar": "Guitar",
    "keyboard": "Keyboard",
    "percussion": "Percussion",
    "strings": "Strings",
    "synth": "Synth",
    "fx": "FX",
    "brass": "Brass",
    "woodwinds": "Woodwinds",
}

REQUIRED_MODEL = "acestep-v15-base"


def provider_name() -> str:
    p = os.environ.get("BAND_PROVIDER", "auto").lower()
    if p == "auto":
        return "acestep" if os.environ.get("ACESTEP_API_URL") else "mock"
    return p


def _mock_stem(duration_seconds: float = 4.0) -> np.ndarray:
    """Short sine-wave chord placeholder so dev without GPU still works."""
    n = int(duration_seconds * SR)
    t = np.arange(n, dtype=np.float32) / SR
    # Gentle C major triad pad
    y = (0.12 * np.sin(2 * np.pi * 261.63 * t)
         + 0.10 * np.sin(2 * np.pi * 329.63 * t)
         + 0.09 * np.sin(2 * np.pi * 392.00 * t))
    # Fade in / out so it does not click
    fade = min(int(0.05 * SR), n // 4)
    ramp = np.linspace(0, 1, fade, dtype=np.float32)
    y[:fade] *= ramp
    y[-fade:] *= ramp[::-1]
    return y


def _acestep_generate(
    mix_bytes: bytes,
    part: str,
    style: str,
    http=None,
    sleep=time.sleep,
    task_type: str = "lego",
    strength: float = 1.0,
    lyrics: str = "",
) -> bytes:
    """Submit to ACE-Step, poll until done, return raw audio bytes.

    task_type "lego" adds an instrument stem around the mix (base model only);
    "cover" re-plays the uploaded audio with AI sound (any loaded model),
    where `strength` is audio_cover_strength (1.0 keeps the notes, lower drifts).
    """
    http = http or httpx

    base_url = os.environ.get("ACESTEP_API_URL", "").rstrip("/")
    key = os.environ.get("ACESTEP_API_KEY", "")
    headers = {"Authorization": f"Bearer {key}"} if key else {}

    # Lego only runs on the base model; cover runs on whatever is loaded,
    # so only swap for lego (or load base when nothing is loaded at all).
    r = http.get(f"{base_url}/health", headers=headers, timeout=15.0)
    if not r.is_success:
        raise RuntimeError(f"ACE-Step health check failed {r.status_code}: {r.text[:200]}")
    loaded = r.json().get("data", {}).get("loaded_model", "")
    if (loaded != REQUIRED_MODEL) if task_type == "lego" else (not loaded):
        init = http.post(
            f"{base_url}/v1/init",
            headers={**headers, "Content-Type": "application/json"},
            json={"model": REQUIRED_MODEL},
            timeout=300.0,
        )
        if not init.is_success:
            raise RuntimeError(f"ACE-Step model init failed {init.status_code}: {init.text[:200]}")

    # Submit the task
    data = {
        "task_type": task_type,
        "caption": style or "",
        "thinking": "false",
        "inference_steps": "32",
        "batch_size": "1",
    }
    if task_type == "cover":
        data["instruction"] = "Generate audio semantic tokens based on the given conditions:"
        # Two knobs steer a cover. audio_cover_strength is the share of denoise steps
        # that keep source-aware conditioning; cover_noise_strength is how close to the
        # source latents the denoise STARTS (0 = pure noise = the notes are ignored).
        # The second one is what actually keeps the notes, so the user's strength
        # drives it, with source conditioning kept on for all steps.
        data["audio_cover_strength"] = "1.00"
        data["cover_noise_strength"] = f"{0.85 * strength:.2f}"
    else:
        data["instruction"] = f"Generate the {part} track based on the audio context:"
        if lyrics:
            # Lyrics are read by the songwriter brain, which only runs with
            # thinking on, so a lyrics request turns it on for this task.
            data["lyrics"] = lyrics
            data["thinking"] = "true"
    r = http.post(
        f"{base_url}/release_task",
        headers=headers,
        files={"src_audio": ("mix.wav", mix_bytes, "audio/wav")},
        data=data,
        timeout=60.0,
    )
    if not r.is_success:
        raise RuntimeError(f"ACE-Step submit failed {r.status_code}: {r.text[:300]}")
    task_id = r.json()["data"]["task_id"]

    deadline = time.time() + 900  # 15-minute budget
    while True:
        if time.time() > deadline:
            raise RuntimeError("ACE-Step generation timed out after 15 minutes")
        poll = http.post(
            f"{base_url}/query_result",
            headers={**headers, "Content-Type": "application/json"},
            json={"task_id_list": [task_id]},
            timeout=30.0,
        )
        if not poll.is_success:
            raise RuntimeError(f"ACE-Step poll failed {poll.status_code}: {poll.text[:200]}")
        payload = poll.json()
        # The API wraps results in {"data": [...], "code": 200}; unwrap, then
        # normalize: list of row objects, or dict keyed by task_id
        rows = payload.get("data", payload) if isinstance(payload, dict) else payload
        if isinstance(rows, list):
            row = next((x for x in rows if x.get("task_id") == task_id), rows[0] if rows else {})
        else:
            row = rows.get(task_id, {})
        status = row.get("status", 0)
        if status == 2:
            raise RuntimeError(f"ACE-Step generation failed for {part}")
        if status == 1:
            raw = row.get("result", "[]")
            entries = json.loads(raw) if isinstance(raw, str) else raw
            if not entries:
                raise RuntimeError("ACE-Step returned no file in the result")
            file_path = entries[0]["file"]
            dl = http.get(f"{base_url}{file_path}", headers=headers, timeout=120.0)
            if not dl.is_success:
                raise RuntimeError(f"ACE-Step download failed {dl.status_code}")
            return dl.content
        sleep(5)


def _decode(data: bytes) -> np.ndarray:
    """Decode audio bytes to a mono float32 array at SR=44100."""
    try:
        y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
    except Exception:
        import librosa  # local: librosa import is slow, only pay it on the fallback path
        tmp = Path("/tmp/voxmidi") / f"band_{time.time_ns()}.bin"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data)
        try:
            y, sr = librosa.load(str(tmp), sr=None, mono=True)
        finally:
            tmp.unlink(missing_ok=True)
    if sr != SR:
        import librosa  # local: librosa import is slow, only pay it when resampling
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y.astype(np.float32)


def make_band_stem(
    mix_bytes: bytes,
    part: str,
    style: str,
    job_dir: Path,
    progress: Callable[[int, str], None] = lambda p, s: None,
    http=None,
    sleep=time.sleep,
    lyrics: str = "",
) -> dict:
    """Generate a stem for `part` that fits the supplied mix. Writes band_{part}.wav.

    With `lyrics`, a vocals part comes back sung rather than instrumental."""
    provider = provider_name()

    if provider == "mock":
        progress(20, "generating_stem")
        y = _mock_stem()
    else:
        progress(15, "generating_stem")
        raw = _acestep_generate(mix_bytes, part, style, http=http, sleep=sleep, lyrics=lyrics)
        progress(85, "decoding_audio")
        y = _decode(raw)

    path = job_dir / f"band_{part}.wav"
    sf.write(str(path), y, SR, subtype="PCM_16")
    progress(100, "complete")
    return {
        "file": path.name,
        "provider": provider,
        "part": part,
        "style": style,
        "duration": round(len(y) / SR, 3),
    }
