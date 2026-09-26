"""Real-sounding bass, guitar, keys and lead from the song's MIDI parts.

Two levels, both starting from the notes the user wrote or edited:

1. Real instrument (free): the part is played by sampled instruments with
   FluidSynth and a General MIDI SoundFont. Every note comes out exactly as
   written. Guitar chords are strummed string by string so they don't land
   as one block.
2. Polish with AI: that render goes through an audio-to-audio model (the
   same provider as AI drums) for a more played, recorded sound. Audio
   models can change notes, so the result is lined up with the render and
   its pitch is checked before anything is placed:
     - bass and lead (one note at a time): each note's pitch is tracked
       (pYIN) and compared with the written note (bass may drop or rise an
       octave, nothing else)
     - guitar and keys (chords): each bar's chroma is compared with the
       render's; the chord has to be the same
   If too little survives, the render is rejected.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import soundfile as sf

from pipelines import drum_ai

SR = 44100
MIN_NOTE_MATCH = 0.8
MIN_BAR_MATCH = 0.8
CHROMA_SIM = 0.85

# style -> (GM program, prompt)
PART_STYLES = {
    "bass": {
        "finger": (33, "fingered electric bass, warm and round"),
        "pick": (34, "picked electric bass, punchy attack"),
        "slap": (36, "slap bass, funky and bright"),
        "upright": (32, "upright acoustic bass, woody"),
        "synth": (38, "analog synth bass, deep and smooth"),
    },
    "guitar": {
        "clean": (27, "clean electric guitar, light chorus, studio recording"),
        "acoustic": (25, "steel-string acoustic guitar, strummed, close mic"),
        "crunch": (29, "overdriven electric guitar, crunchy tube amp"),
        "distorted": (30, "distorted rock guitar, high gain amp"),
        "nylon": (24, "nylon-string classical guitar, warm"),
    },
    "keys": {
        "piano": (0, "grand piano, warm studio recording"),
        "rhodes": (4, "Rhodes electric piano, soft tremolo"),
        "organ": (16, "Hammond organ, rotary speaker"),
        "pad": (89, "warm analog synth pad"),
    },
    "lead": {
        "guitar": (29, "lead electric guitar, singing sustain"),
        "piano": (0, "piano melody, expressive"),
        "synth": (81, "analog synth lead"),
        "flute": (73, "flute, breathy and warm"),
    },
}
PART_LABEL = {"bass": "bass", "guitar": "guitar", "keys": "keys", "lead": "lead"}
MONO_PARTS = {"bass", "lead"}


def soundfont_path() -> Optional[str]:
    for p in (os.environ.get("SOUNDFONT"), "/usr/share/sounds/sf2/FluidR3_GM.sf2", "/usr/share/sounds/sf2/default-GM.sf2"):
        if p and Path(p).exists():
            return p
    return None


def _hash01(a, b):
    h = (int(a * 1000) * 2654435761 ^ int(b) * 1597334677) & 0xFFFFFFFF
    h = (h ^ (h >> 15)) * 2246822507 & 0xFFFFFFFF
    return ((h ^ (h >> 13)) % 10000) / 10000.0


def _perform(notes: List[dict], part: str) -> List[dict]:
    """Small, repeatable human touches: strum chords (guitar), vary velocity a little."""
    out = []
    ordered = sorted(notes, key=lambda n: (n["t"], n["p"]))
    i = 0
    while i < len(ordered):
        group = [ordered[i]]
        while i + len(group) < len(ordered) and ordered[i + len(group)]["t"] - ordered[i]["t"] < 0.03:
            group.append(ordered[i + len(group)])
        up = part == "guitar" and _hash01(group[0]["t"], 7) < 0.3  # some upstrokes
        for k, n in enumerate(sorted(group, key=lambda x: x["p"], reverse=up)):
            strum = k * 0.03 if part == "guitar" and len(group) > 2 else 0.0  # ~15 ms at 120 BPM
            v = int(max(1, min(127, round(n["v"] + (_hash01(n["t"], n["p"]) - 0.5) * 10))))
            out.append({**n, "t": n["t"] + strum, "v": v})
        i += len(group)
    return out


def render_part(notes: List[dict], tempo: float, total_beats: float, part: str, style: str) -> np.ndarray:
    """Play the notes with sampled instruments. Falls back to a plain synth without FluidSynth."""
    import pretty_midi
    program = PART_STYLES[part][style][0]
    spb = 60.0 / tempo
    length = int((total_beats * spb + 1.5) * SR)
    played = _perform(notes, part)
    sf2 = soundfont_path()
    if sf2 and shutil.which("fluidsynth"):
        pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)
        inst = pretty_midi.Instrument(program=program, name=part)
        for n in played:
            s = max(0.0, n["t"] * spb)
            inst.notes.append(pretty_midi.Note(n["v"], int(n["p"]), s, s + max(0.05, n["d"] * spb)))
        pm.instruments.append(inst)
        with tempfile.TemporaryDirectory() as tmp:
            mid, wav = Path(tmp) / "part.mid", Path(tmp) / "part.wav"
            pm.write(str(mid))
            subprocess.run(["fluidsynth", "-ni", "-q", "-g", "0.8", "-r", str(SR), "-F", str(wav), sf2, str(mid)],
                           check=True, capture_output=True, timeout=300)
            y, sr = sf.read(str(wav), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
    else:
        y = np.zeros(length, np.float32)
        for n in played:
            a = int(n["t"] * spb * SR)
            d = max(0.05, n["d"] * spb)
            t = np.arange(int(d * SR)) / SR
            f = 440 * 2 ** ((n["p"] - 69) / 12)
            tone = sum((0.5 ** h) * np.sin(2 * np.pi * f * (h + 1) * t) for h in range(4))
            tone *= np.minimum(1, t / 0.005) * np.exp(-t * 2.0) * (n["v"] / 127) * 0.3
            b = min(length, a + len(tone))
            if a < length:
                y[a:b] += tone[: b - a].astype(np.float32)
    y = y[:length] if len(y) >= length else np.pad(y, (0, length - len(y)))
    peak = float(np.max(np.abs(y))) or 1.0
    return (y / peak * 0.89).astype(np.float32)


# ─── Pitch checks ────────────────────────────────────────────────────────────

def note_match(notes: List[dict], tempo: float, audio: np.ndarray, octave_ok: bool) -> float:
    """Share of notes whose tracked pitch is the written pitch (or an octave off, for bass)."""
    import librosa
    sr = 11025
    y = librosa.resample(audio, orig_sr=SR, target_sr=sr)
    hop = 128
    lo = min(n["p"] for n in notes)
    hi = max(n["p"] for n in notes)
    fmin = max(25.0, librosa.midi_to_hz(lo - 14))
    fmax = min(2000.0, librosa.midi_to_hz(hi + 14))
    f0, voiced, _ = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048 if fmin < 60 else 1024, hop_length=hop)
    midi = np.where(voiced, librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
    spb = 60.0 / tempo
    checked = hits = 0
    for n in notes:
        dur = n["d"] * spb
        if dur < 0.12:
            continue
        a = int((n["t"] * spb + 0.2 * dur) / (hop / sr))
        b = int((n["t"] * spb + 0.8 * dur) / (hop / sr))
        seg = midi[a:b]
        seg = seg[~np.isnan(seg)]
        checked += 1
        if len(seg) < 2:
            continue
        diff = float(np.median(seg)) - n["p"]
        allowed = (0, -12, 12) if octave_ok else (0,)
        if any(abs(diff - k) <= 0.6 for k in allowed):
            hits += 1
    return 1.0 if checked == 0 else hits / checked


def chord_match(reference: np.ndarray, audio: np.ndarray, tempo: float, total_beats: float) -> float:
    """Share of non-silent bars whose chroma matches the reference render's."""
    import librosa
    sr = 22050
    ref = librosa.resample(reference, orig_sr=SR, target_sr=sr)
    out = librosa.resample(audio, orig_sr=SR, target_sr=sr)
    hop = 512
    ca = librosa.feature.chroma_cqt(y=ref, sr=sr, hop_length=hop)
    cb = librosa.feature.chroma_cqt(y=out, sr=sr, hop_length=hop)
    rms = librosa.feature.rms(y=ref, hop_length=hop)[0]
    fpb = 4 * 60.0 / tempo * sr / hop  # frames per bar
    bars = int(np.ceil(total_beats / 4))
    checked = hits = 0
    floor = 0.05 * float(rms.max() or 1.0)
    for b in range(bars):
        s, e = int(b * fpb), int((b + 1) * fpb)
        if e <= s or float(np.mean(rms[s:e] if e <= len(rms) else rms[s:])) < floor:
            continue
        va, vb = ca[:, s:e].mean(axis=1), cb[:, s:e].mean(axis=1)
        sim = float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb) + 1e-9))
        checked += 1
        hits += sim >= CHROMA_SIM
    return 1.0 if checked == 0 else hits / checked


# ─── Pipeline ────────────────────────────────────────────────────────────────

def make_real_part(part: str, style: str, notes: List[dict], tempo: float, total_beats: float, polish: bool,
                   strength: float, job_dir: Path, progress: Callable[[int, str], None] = lambda p, s: None,
                   reskin: Optional[Callable] = None) -> dict:
    progress(10, "rendering_part")
    reference = render_part(notes, tempo, total_beats, part, style)
    provider = "samples"
    match = 100
    offset_ms = 0
    out = reference

    if polish:
        provider = drum_ai.provider_name()
        prompt = f"{PART_STYLES[part][style][1]}, {int(round(tempo))} BPM, solo {PART_LABEL[part]} only"
        if reskin is None:
            reskin = (lambda a: drum_ai._fal_reskin(a, prompt, strength)) if provider == "fal" else (lambda a: drum_ai._mock_reskin(a, prompt))
        spb = 60.0 / tempo
        bar_sec = 4 * spb
        bars_per_chunk = max(1, int(drum_ai.MAX_CHUNK_SECONDS // bar_sec))
        total_bars = int(np.ceil(total_beats / 4))
        out = np.zeros_like(reference)
        offsets = []
        chunks = [(b, min(total_bars, b + bars_per_chunk)) for b in range(0, total_bars, bars_per_chunk)]
        for i, (b0, b1) in enumerate(chunks):
            progress(20 + int(55 * i / len(chunks)), "generating_audio")
            a = int(b0 * bar_sec * SR)
            z = min(len(reference), int(b1 * bar_sec * SR) + (int(1.5 * SR) if b1 == total_bars else 0))
            piece = reference[a:z]
            aligned, off = drum_ai.align(piece, reskin(piece))
            out[a:a + len(aligned)] = aligned[: len(out) - a]
            offsets.append(off)
        offset_ms = int(round(1000 * float(np.median(offsets))))
        peak = float(np.max(np.abs(out)))
        if peak < 1e-4:
            raise RuntimeError("The AI returned silence. Nothing was placed.")
        out = out / peak * 0.89

        progress(80, "checking_pitch")
        if part in MONO_PARTS:
            rate = note_match(notes, tempo, out, octave_ok=part == "bass")
            what = "notes"
            need = MIN_NOTE_MATCH
        else:
            rate = chord_match(reference, out, tempo, total_beats)
            what = "bars of chords"
            need = MIN_BAR_MATCH
        match = int(round(100 * rate))
        if rate < need:
            raise RuntimeError(
                f"The AI changed your part (only {match}% of {what} still matched). Nothing was placed. "
                "Try again with the AI staying closer to your part, or use Real instrument."
            )

    path = job_dir / f"{part}_real.wav"
    sf.write(str(path), out.astype(np.float32), SR, subtype="PCM_16")
    return {"file": path.name, "provider": provider, "part": part, "style": style, "polish": polish,
            "match": match, "offset_ms": offset_ms, "duration": round(len(out) / SR, 3),
            "renderer": "fluidsynth" if soundfont_path() and shutil.which("fluidsynth") else "synth"}
