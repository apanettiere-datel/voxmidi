"""AI drums: turn the song's drum pattern into real-sounding drums.

1. Render the drum part (exactly as it plays in the app, swing and all) to
   audio with the shared one-shot synths.
2. Send that audio to an audio-to-audio model (Stable Audio 2.5 on fal by
   default) with a style prompt. Because the input is already a drums-only
   track on our grid, the model keeps the timing and replaces the sound.
3. Line the result back up with the pattern: find the offset by
   cross-correlating onset envelopes, shift, trim to the song length, then
   measure how many of the pattern's kicks and snares have a hit in the
   result. If too few do, the render drifted and is rejected.

Provider: DRUMS_PROVIDER=fal|mock, default fal when FAL_KEY is set, else mock.
The mock provider returns the rendered pattern with a room and saturation on
it, so the whole flow runs locally and in tests without spending anything.
"""

import base64
import io
import json
import os
import time
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import soundfile as sf

from pipelines.accompanist import (
    _kick_oneshot, _snare_oneshot, _hat_oneshot, _clap_oneshot, _shaker_oneshot, _apply_envelope,
)

SR = 44100
DEFAULT_MODEL = "fal-ai/stable-audio-25/audio-to-audio"
MAX_CHUNK_SECONDS = 180.0   # stay under the model's per-request length
MIN_MATCH = 0.6             # share of kicks and snares that must land in the result
MATCH_WINDOW = 0.05         # seconds

STYLES = {
    "acoustic":   "tight acoustic drum kit, dry studio recording, natural room, drums only",
    "rock":       "big rock drum kit in a live room, punchy kick and cracking snare, drums only",
    "breaks":     "vintage funk breakbeat, dusty warm vinyl drums, drums only",
    "trap":       "trap drum kit, deep 808 kick, crisp snappy snare, bright hi-hats, drums only",
    "brushes":    "brushed jazz drum kit, soft warm snare, gentle ride, drums only",
    "electronic": "punchy analog drum machine, tight electronic kick and snare, drums only",
}

KICK, SNARE, CLAP, CHAT, OHAT, PERC = 36, 38, 39, 42, 46, 75
DRUM_PITCHES = {KICK, SNARE, CLAP, CHAT, OHAT, PERC}


def _open_hat(sr: int = SR) -> np.ndarray:
    n = int(0.25 * sr)
    rng = np.random.default_rng(55)
    buf = np.diff(rng.standard_normal(n), prepend=0).astype(np.float32)
    buf = buf / (np.max(np.abs(buf)) or 1.0) * 0.22
    _apply_envelope(buf, int(sr * 0.001), int(sr * 0.2))
    return buf


def render_pattern(notes: List[dict], tempo: float, total_beats: float) -> np.ndarray:
    """Mix one-shots at each note's time, scaled by velocity."""
    spb = 60.0 / tempo
    out = np.zeros(int(total_beats * spb * SR) + SR, dtype=np.float32)
    shots = {KICK: _kick_oneshot(), SNARE: _snare_oneshot(), CLAP: _clap_oneshot(),
             CHAT: _hat_oneshot(), OHAT: _open_hat(), PERC: _shaker_oneshot()}
    for n in notes:
        hit = shots[n["p"]] * (n["v"] / 127.0)
        a = int(n["t"] * spb * SR)
        b = min(len(out), a + len(hit))
        if a < len(out):
            out[a:b] += hit[: b - a]
    peak = float(np.max(np.abs(out))) or 1.0
    return (out / peak * 0.89).astype(np.float32)


# ─── Providers ───────────────────────────────────────────────────────────────

def provider_name() -> str:
    p = os.environ.get("DRUMS_PROVIDER", "auto").lower()
    if p == "auto":
        return "fal" if os.environ.get("FAL_KEY") else "mock"
    return p


def _mock_reskin(audio: np.ndarray, prompt: str) -> np.ndarray:
    """Stand-in for the model: a short room and gentle saturation on the pattern."""
    rng = np.random.default_rng(7)
    ir_len = int(0.25 * SR)
    ir = rng.standard_normal(ir_len).astype(np.float32) * np.exp(-np.linspace(0, 8, ir_len)).astype(np.float32)
    ir[0] = 1.0
    wet = np.convolve(audio, ir * 0.15)[: len(audio)]
    return np.tanh(1.4 * (audio + wet)).astype(np.float32)


def _audio_url_from(result: dict) -> str:
    """fal endpoints differ in where they put the file; accept the usual shapes."""
    for key in ("audio", "audio_file", "output"):
        v = result.get(key)
        if isinstance(v, dict) and v.get("url"):
            return v["url"]
        if isinstance(v, list) and v and isinstance(v[0], dict) and v[0].get("url"):
            return v[0]["url"]
        if isinstance(v, str) and v.startswith("http"):
            return v
    if isinstance(result.get("url"), str):
        return result["url"]
    raise RuntimeError(f"AI drums: no audio in the response: {json.dumps(result)[:300]}")


def _fal_reskin(audio: np.ndarray, prompt: str, strength: float, http=None, sleep=time.sleep) -> np.ndarray:
    """Submit to the fal queue, poll, download and decode. Input goes up as a FLAC data URI."""
    import httpx
    http = http or httpx
    key = os.environ.get("FAL_KEY", "")
    if not key:
        raise RuntimeError("FAL_KEY is not set")
    model = os.environ.get("FAL_DRUMS_MODEL", DEFAULT_MODEL)
    headers = {"Authorization": f"Key {key}", "Content-Type": "application/json"}

    buf = io.BytesIO()
    sf.write(buf, audio, SR, format="FLAC", subtype="PCM_16")
    data_uri = "data:audio/flac;base64," + base64.b64encode(buf.getvalue()).decode()

    payload = {"prompt": prompt, "audio_url": data_uri, "strength": strength}
    r = http.post(f"https://queue.fal.run/{model}", headers=headers, json=payload, timeout=60.0)
    if not r.is_success:
        raise RuntimeError(f"AI drums: submit failed {r.status_code}: {r.text[:300]}")
    sub = r.json()
    status_url, response_url = sub["status_url"], sub["response_url"]

    deadline = time.time() + 300
    while True:
        s = http.get(status_url, headers=headers, timeout=15.0)
        if not s.is_success:
            raise RuntimeError(f"AI drums: status check failed {s.status_code}: {s.text[:300]}")
        state = s.json().get("status", "")
        if state == "COMPLETED":
            break
        if state not in ("IN_QUEUE", "IN_PROGRESS"):
            raise RuntimeError(f"AI drums: generation failed ({state})")
        if time.time() > deadline:
            raise RuntimeError("AI drums: timed out after 5 minutes")
        sleep(3)

    res = http.get(response_url, headers=headers, timeout=30.0)
    if not res.is_success:
        raise RuntimeError(f"AI drums: result fetch failed {res.status_code}: {res.text[:300]}")
    dl = http.get(_audio_url_from(res.json()), timeout=120.0)
    if not dl.is_success:
        raise RuntimeError(f"AI drums: download failed {dl.status_code}")
    return _decode(dl.content)


def _decode(data: bytes) -> np.ndarray:
    try:
        y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
    except Exception:
        import librosa  # mp3 and friends go through audioread/ffmpeg
        tmp = Path("/tmp/voxmidi") / f"drumai_{time.time_ns()}.bin"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data)
        try:
            y, sr = librosa.load(str(tmp), sr=None, mono=True)
        finally:
            tmp.unlink(missing_ok=True)
    if sr != SR:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y.astype(np.float32)


# ─── Alignment ───────────────────────────────────────────────────────────────

def _onset_env(y: np.ndarray, hop: int = 256) -> np.ndarray:
    import librosa
    return librosa.onset.onset_strength(y=y, sr=SR, hop_length=hop)


def align(reference: np.ndarray, generated: np.ndarray, max_shift: float = 0.3) -> tuple:
    """Shift `generated` so its onsets line up with `reference`. Returns (aligned, offset_seconds)."""
    hop = 256
    a, b = _onset_env(reference, hop), _onset_env(generated, hop)
    n = min(len(a), len(b))
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    lags = int(max_shift * SR / hop)
    best, best_lag = -np.inf, 0
    for lag in range(-lags, lags + 1):
        if lag >= 0:
            score = float(np.dot(a[lag:], b[: n - lag]))
        else:
            score = float(np.dot(a[: n + lag], b[-lag:]))
        if score > best:
            best, best_lag = score, lag
    shift = best_lag * hop  # generated is late by -shift samples when lag < 0
    if shift > 0:
        out = np.concatenate([np.zeros(shift, dtype=np.float32), generated])
    else:
        out = generated[-shift:]
    out = out[: len(reference)]
    if len(out) < len(reference):
        out = np.pad(out, (0, len(reference) - len(out)))
    return out.astype(np.float32), shift / SR


def match_rate(notes: List[dict], tempo: float, audio: np.ndarray) -> float:
    """Share of the pattern's kicks and snares that have an onset within MATCH_WINDOW in `audio`."""
    import librosa
    # A hit in the first 50 ms has no silence before it to rise out of, so it
    # can't show up as an onset; leave those out of the check
    anchors = [n["t"] * 60.0 / tempo for n in notes if n["p"] in (KICK, SNARE, CLAP) and n["t"] * 60.0 / tempo >= MATCH_WINDOW]
    if not anchors:
        return 1.0
    onsets = librosa.onset.onset_detect(y=audio, sr=SR, hop_length=256, units="time", backtrack=True)
    if len(onsets) == 0:
        return 0.0
    onsets = np.asarray(onsets)
    hits = sum(1 for t in anchors if np.min(np.abs(onsets - t)) <= MATCH_WINDOW)
    return hits / len(anchors)


# ─── Pipeline ────────────────────────────────────────────────────────────────

def make_ai_drums(notes: List[dict], tempo: float, total_beats: float, style: str, strength: float,
                  job_dir: Path, progress: Callable[[int, str], None] = lambda p, s: None,
                  reskin: Optional[Callable] = None) -> dict:
    """Render, re-skin (in chunks cut on bar lines), align and verify. Writes drums_ai.wav."""
    provider = provider_name()
    spb = 60.0 / tempo
    prompt = f"{STYLES[style]}, {int(round(tempo))} BPM"
    if reskin is None:
        reskin = (lambda audio: _fal_reskin(audio, prompt, strength)) if provider == "fal" else (lambda audio: _mock_reskin(audio, prompt))

    progress(10, "rendering_pattern")
    reference = render_pattern(notes, tempo, total_beats)

    # Cut into chunks on bar lines so each stays under the model's length limit
    bar_sec = 4 * spb
    bars_per_chunk = max(1, int(MAX_CHUNK_SECONDS // bar_sec))
    total_bars = int(np.ceil(total_beats / 4))
    chunks = [(b, min(total_bars, b + bars_per_chunk)) for b in range(0, total_bars, bars_per_chunk)]

    out = np.zeros_like(reference)
    offsets = []
    for i, (b0, b1) in enumerate(chunks):
        progress(20 + int(60 * i / len(chunks)), "generating_audio")
        a = int(b0 * bar_sec * SR)
        z = min(len(reference), int(b1 * bar_sec * SR) + (SR if b1 == total_bars else 0))
        piece = reference[a:z]
        generated = reskin(piece)
        aligned, offset = align(piece, generated)
        out[a:a + len(aligned)] = aligned[: len(out) - a]
        offsets.append(offset)

    progress(85, "checking_timing")
    peak = float(np.max(np.abs(out)))
    if peak < 1e-4:
        raise RuntimeError("The AI returned silence. Nothing was placed.")
    out = out / peak * 0.89
    rate = match_rate(notes, tempo, out)
    if rate < MIN_MATCH:
        raise RuntimeError(
            f"The AI drums drifted off your pattern (only {int(rate * 100)}% of kicks and snares lined up). "
            "Nothing was placed. Try again, or lower how far the AI can stray."
        )

    path = job_dir / "drums_ai.wav"
    sf.write(str(path), out, SR, subtype="PCM_16")
    return {
        "file": path.name,
        "provider": provider,
        "style": style,
        "duration": round(len(out) / SR, 3),
        "offset_ms": int(round(1000 * float(np.median(offsets)))),
        "match": int(round(100 * rate)),
        "chunks": len(chunks),
    }
