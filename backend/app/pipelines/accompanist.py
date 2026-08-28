"""Accompaniment pipeline for the Jam feature.

Generates tempo-locked stems (audio + MIDI) from a riff audio file.
Provider is selected via env ACCOMPANIMENT_PROVIDER (default "mock").
Only "mock" is implemented; a real provider slots in by adding a branch
in _run_provider().
"""

import os
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import pretty_midi

from pipelines.transcriber import _ensure_wav
from pipelines.midi_generator import _analyze_reference_audio, KEY_ROOTS, _is_minor, _chord_notes

SR = 44100

VALID_PARTS = {"drums", "bass", "guitar", "pads", "synth", "fx"}

# Parts that get both an audio stem and a MIDI file
MIDI_PARTS = {"drums", "bass"}

# GM program numbers for non-drum parts
GM_PROGRAMS = {
    "bass": 33,    # Finger Bass
    "guitar": 25,  # Acoustic Guitar (steel)
    "pads": 89,    # Pad 2 (warm)
    "synth": 80,   # Lead 1 (square)
    "fx": 99,      # FX 4 (atmosphere)
}

# Human-readable labels
PART_LABELS = {
    "drums": "Drums",
    "bass": "Bass",
    "guitar": "Guitar",
    "pads": "Pads",
    "synth": "Synth",
    "fx": "FX",
}


# ─── Audio helpers ────────────────────────────────────────────────────────────

def _sine(freq: float, duration: float, sr: int = SR, amp: float = 0.3) -> np.ndarray:
    t = np.linspace(0, duration, int(duration * sr), endpoint=False)
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _noise(duration: float, sr: int = SR, amp: float = 0.15) -> np.ndarray:
    samples = int(duration * sr)
    return (amp * np.random.default_rng(42).standard_normal(samples)).astype(np.float32)


def _midi_note_to_freq(midi_note: int) -> float:
    return 440.0 * 2 ** ((midi_note - 69) / 12.0)


def _apply_envelope(buf: np.ndarray, attack_samples: int, release_samples: int) -> np.ndarray:
    """Simple linear attack/release envelope in-place."""
    n = len(buf)
    if attack_samples > 0:
        att = min(attack_samples, n)
        buf[:att] *= np.linspace(0, 1, att, dtype=np.float32)
    if release_samples > 0:
        rel = min(release_samples, n)
        buf[-rel:] *= np.linspace(1, 0, rel, dtype=np.float32)
    return buf


# ─── Mock stem generators ─────────────────────────────────────────────────────

def _gen_drums(duration: float, tempo: float) -> np.ndarray:
    """Kick on each beat + hihat burst on each eighth."""
    buf = np.zeros(int(duration * SR), dtype=np.float32)
    beat = 60.0 / tempo
    eighth = beat / 2.0

    kick_dur = 0.08
    hat_dur = 0.03

    # Kick at each beat (50 Hz sine burst)
    t = 0.0
    while t < duration:
        start = int(t * SR)
        kick = _sine(50.0, kick_dur, amp=0.35)
        end = min(start + len(kick), len(buf))
        buf[start:end] += kick[: end - start]
        t += beat

    # Hat on each eighth (short noise)
    t = 0.0
    while t < duration:
        start = int(t * SR)
        hat = _noise(hat_dur, amp=0.10)
        _apply_envelope(hat, 10, int(hat_dur * SR * 0.5))
        end = min(start + len(hat), len(buf))
        buf[start:end] += hat[: end - start]
        t += eighth

    return buf


def _gen_bass(duration: float, tempo: float, root_midi: int) -> np.ndarray:
    """Root-note sine, one note per beat."""
    buf = np.zeros(int(duration * SR), dtype=np.float32)
    beat = 60.0 / tempo
    note_dur = beat * 0.85
    freq = _midi_note_to_freq(root_midi)

    t = 0.0
    while t < duration:
        start = int(t * SR)
        samples = int(note_dur * SR)
        note = _sine(freq, note_dur, amp=0.30)
        _apply_envelope(note, int(SR * 0.01), int(SR * 0.05))
        end = min(start + samples, len(buf))
        buf[start:end] += note[: end - start]
        t += beat

    return buf


def _gen_chord_pads(duration: float, root_midi: int, minor: bool, amp: float = 0.25) -> np.ndarray:
    """Soft triad sustained chord, slow attack."""
    buf = np.zeros(int(duration * SR), dtype=np.float32)
    triad = [0, 3, 7] if minor else [0, 4, 7]
    attack = int(SR * 0.3)
    release = int(SR * 0.5)
    for interval in triad:
        freq = _midi_note_to_freq(root_midi + interval)
        tone = _sine(freq, duration, amp=amp / len(triad))
        _apply_envelope(tone, attack, release)
        buf += tone
    return buf


def _gen_synth(duration: float, root_midi: int, minor: bool) -> np.ndarray:
    """Arpeggiated chord tones, short pulses."""
    buf = np.zeros(int(duration * SR), dtype=np.float32)
    triad = [0, 3, 7] if minor else [0, 4, 7]
    pulse_dur = 0.12
    pulse_gap = 0.25

    t = 0.0
    idx = 0
    while t < duration:
        freq = _midi_note_to_freq(root_midi + triad[idx % len(triad)])
        pulse = _sine(freq, pulse_dur, amp=0.20)
        _apply_envelope(pulse, int(SR * 0.01), int(SR * 0.04))
        start = int(t * SR)
        end = min(start + len(pulse), len(buf))
        buf[start:end] += pulse[: end - start]
        t += pulse_gap
        idx += 1

    return buf


def _gen_fx(duration: float) -> np.ndarray:
    """Filtered noise sweep that loops every 2 seconds."""
    buf = np.zeros(int(duration * SR), dtype=np.float32)
    loop_dur = 2.0
    loop_samples = int(loop_dur * SR)

    # Build one loop of filtered noise
    rng = np.random.default_rng(7)
    loop = (rng.standard_normal(loop_samples) * 0.12).astype(np.float32)
    # Amplitude modulation (slow rise/fall)
    env = np.abs(np.sin(np.linspace(0, np.pi, loop_samples))).astype(np.float32)
    loop *= env

    # Tile to fill duration
    total = len(buf)
    tiles = (total // loop_samples) + 1
    tiled = np.tile(loop, tiles)[:total]
    buf += tiled
    return buf


# ─── Mock MIDI generators ──────────────────────────────────────────────────────

def _midi_drums(duration: float, tempo: float) -> pretty_midi.PrettyMIDI:
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    beat = 60.0 / tempo
    KICK, HAT = 36, 42
    t = 0.0
    while t < duration - 0.05:
        inst.notes.append(pretty_midi.Note(100, KICK, t, t + 0.08))
        inst.notes.append(pretty_midi.Note(70, HAT, t, t + 0.04))
        inst.notes.append(pretty_midi.Note(65, HAT, t + beat / 2, t + beat / 2 + 0.03))
        t += beat
    pm.instruments.append(inst)
    return pm


def _midi_bass(duration: float, tempo: float, root_midi: int) -> pretty_midi.PrettyMIDI:
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)
    inst = pretty_midi.Instrument(program=33, name="Bass")
    beat = 60.0 / tempo
    note_dur = beat * 0.85
    t = 0.0
    while t < duration - 0.05:
        end = min(t + note_dur, duration - 0.01)
        inst.notes.append(pretty_midi.Note(85, root_midi, t, end))
        t += beat
    pm.instruments.append(inst)
    return pm


def _midi_combined(duration: float, tempo: float, root_midi: int, parts: list) -> pretty_midi.PrettyMIDI:
    """Combined MIDI of all generated parts (drums on ch9, others on ch0)."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)
    beat = 60.0 / tempo

    if "drums" in parts:
        drum_inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
        KICK, HAT = 36, 42
        t = 0.0
        while t < duration - 0.05:
            drum_inst.notes.append(pretty_midi.Note(100, KICK, t, t + 0.08))
            drum_inst.notes.append(pretty_midi.Note(65, HAT, t + beat / 2, t + beat / 2 + 0.03))
            t += beat
        pm.instruments.append(drum_inst)

    if "bass" in parts:
        bass_inst = pretty_midi.Instrument(program=33, name="Bass")
        t = 0.0
        note_dur = beat * 0.85
        while t < duration - 0.05:
            end = min(t + note_dur, duration - 0.01)
            bass_inst.notes.append(pretty_midi.Note(85, root_midi, t, end))
            t += beat
        pm.instruments.append(bass_inst)

    return pm


# ─── Provider dispatch ────────────────────────────────────────────────────────

def _run_mock(
    riff_wav: str,
    beatbox_wav: Optional[str],
    parts: list,
    tempo: float,
    key: str,
    duration: float,
    job_dir: Path,
    job_id: str,
) -> dict:
    """Generate mock stems and return URL-ready result dict (paths, no URLs)."""
    minor = _is_minor(key)
    root_midi = KEY_ROOTS.get(key, 69)
    # Put bass an octave lower
    bass_root = root_midi - 12
    while bass_root < 36:
        bass_root += 12

    stems_audio: dict = {}
    stems_midi: dict = {}

    for part in parts:
        print(f"[accompanist] mock: generating {part} stem")
        if part == "drums":
            audio = _gen_drums(duration, tempo)
        elif part == "bass":
            audio = _gen_bass(duration, tempo, bass_root)
        elif part in ("guitar", "pads"):
            audio = _gen_chord_pads(duration, root_midi, minor)
        elif part == "synth":
            audio = _gen_synth(duration, root_midi, minor)
        elif part == "fx":
            audio = _gen_fx(duration)
        else:
            audio = np.zeros(int(duration * SR), dtype=np.float32)

        stem_path = job_dir / f"stem_{part}.wav"
        sf.write(str(stem_path), audio, SR, subtype="PCM_16")
        stems_audio[part] = stem_path

        # MIDI for drums and bass
        if part == "drums":
            pm = _midi_drums(duration, tempo)
            mid_path = job_dir / f"stem_{part}.mid"
            pm.write(str(mid_path))
            stems_midi[part] = mid_path
        elif part == "bass":
            pm = _midi_bass(duration, tempo, bass_root)
            mid_path = job_dir / f"stem_{part}.mid"
            pm.write(str(mid_path))
            stems_midi[part] = mid_path

    # Combined MIDI of all generated parts
    combined_pm = _midi_combined(duration, tempo, bass_root, parts)
    combined_mid_path = job_dir / "jam_combined.mid"
    combined_pm.write(str(combined_mid_path))

    # Mixdown: riff + all stems, riff at 1.0 gain, stems at 0.5
    print("[accompanist] mock: mixing down")
    riff_data, riff_sr = sf.read(riff_wav, dtype="float32", always_2d=False)
    if riff_data.ndim > 1:
        riff_data = riff_data.mean(axis=1)
    if riff_sr != SR:
        # Resample via linear interpolation (librosa not needed here; keep simple)
        import librosa as _librosa
        riff_data = _librosa.resample(riff_data, orig_sr=riff_sr, target_sr=SR)

    riff_samples = int(duration * SR)
    if len(riff_data) > riff_samples:
        riff_data = riff_data[:riff_samples]
    elif len(riff_data) < riff_samples:
        riff_data = np.pad(riff_data, (0, riff_samples - len(riff_data)))

    mix = riff_data * 1.0

    for part, stem_path in stems_audio.items():
        stem_data, _ = sf.read(str(stem_path), dtype="float32", always_2d=False)
        if len(stem_data) < riff_samples:
            stem_data = np.pad(stem_data, (0, riff_samples - len(stem_data)))
        else:
            stem_data = stem_data[:riff_samples]
        mix += stem_data * 0.5

    # Clip protection: normalize if peak > 0.99
    peak = np.max(np.abs(mix))
    if peak > 0.99:
        mix = mix / peak * 0.99

    mix_path = job_dir / "mix.wav"
    sf.write(str(mix_path), mix, SR, subtype="PCM_16")

    return {
        "stems_audio": stems_audio,
        "stems_midi": stems_midi,
        "combined_mid_path": combined_mid_path,
        "mix_path": mix_path,
    }


# ─── Public pipeline entry point ──────────────────────────────────────────────

def run_accompaniment(
    riff_path: str,
    beatbox_path: Optional[str],
    parts: list,
    style_prompt: str,
    preset: str,
    job_id: str,
    job_dir: Path,
) -> dict:
    """
    Full jam pipeline. Returns a result dict with all URLs populated.

    riff_path   -- raw uploaded riff audio (any format)
    beatbox_path -- optional beatbox audio (any format)
    parts       -- list of part ids from VALID_PARTS
    style_prompt -- free text style hint (used by real providers)
    preset      -- preset name (used by real providers)
    job_id      -- for building /api/download URLs
    job_dir     -- directory for all output files
    """
    provider = os.environ.get("ACCOMPANIMENT_PROVIDER", "mock").lower()
    print(f"[accompanist] job={job_id} provider={provider} parts={parts}")

    # Step a: convert riff to WAV
    riff_wav = _ensure_wav(riff_path)
    beatbox_wav: Optional[str] = None
    if beatbox_path and Path(beatbox_path).exists():
        beatbox_wav = _ensure_wav(beatbox_path)

    # Step b: analyze tempo + key
    tempo_f, key_str, _ = _analyze_reference_audio(riff_wav)
    print(f"[accompanist] detected tempo={tempo_f:.1f} BPM key={key_str}")

    # Measure duration from the WAV
    info = sf.info(riff_wav)
    duration = info.duration

    # Step c/d/e: generate stems, MIDI, and mix
    if provider == "mock":
        raw = _run_mock(riff_wav, beatbox_wav, parts, tempo_f, key_str, duration, job_dir, job_id)
    else:
        # Future real providers: add elif branches here and call their runner.
        # Each runner must return the same raw dict shape as _run_mock.
        raise NotImplementedError(f"ACCOMPANIMENT_PROVIDER={provider!r} is not implemented")

    # Step f: build result dict with download URLs
    def url(filename: str) -> str:
        return f"/api/download/{job_id}/{filename}"

    tracks = []
    for part in parts:
        stem_audio_path = raw["stems_audio"].get(part)
        stem_midi_path = raw["stems_midi"].get(part)
        tracks.append({
            "id": part,
            "label": PART_LABELS[part],
            "kind": "generated" if part in MIDI_PARTS else "texture",
            "audio_url": url(stem_audio_path.name) if stem_audio_path else None,
            "midi_url": url(stem_midi_path.name) if stem_midi_path else None,
        })

    riff_filename = Path(riff_wav).name

    result = {
        "job_id": job_id,
        "mode": "jam",
        "provider": provider,
        "tempo": round(tempo_f, 1),
        "key": key_str,
        "duration": round(duration, 2),
        "original": {
            "label": "Your riff",
            "audio_url": url(riff_filename),
        },
        "tracks": tracks,
        "mix_url": url(raw["mix_path"].name),
        "midi_url": url(raw["combined_mid_path"].name),
    }

    print(f"[accompanist] job={job_id} complete: {len(tracks)} tracks, duration={duration:.1f}s")
    return result
