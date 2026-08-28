"""Drum Grid pipeline -- onset analysis and pattern render."""

import math
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
import pretty_midi

from pipelines.accompanist import (
    SR,
    _kick_oneshot,
    _snare_oneshot,
    _hat_oneshot,
    _clap_oneshot,
    _tom_oneshot,
    _shaker_oneshot,
)

VALID_LANES = {"kick", "snare", "hat", "clap", "tom", "shaker"}

GM_NOTES = {
    "kick": 36,
    "snare": 38,
    "hat": 42,
    "clap": 39,
    "tom": 45,
    "shaker": 70,
}

_HIT_GENERATORS = {
    "kick": _kick_oneshot,
    "snare": _snare_oneshot,
    "hat": _hat_oneshot,
    "clap": _clap_oneshot,
    "tom": _tom_oneshot,
    "shaker": _shaker_oneshot,
}


def analyze_drums(wav_path: str) -> dict:
    """
    Analyze a beatbox WAV: detect onsets, classify as kick/snare/hat,
    and quantize to a 16th-note grid.

    Returns a response-ready dict. Raises ValueError on unreadable audio.
    """
    import librosa

    try:
        y, sr = librosa.load(wav_path, sr=None, mono=True)
    except Exception as exc:
        raise ValueError(f"Cannot read audio: {exc}")

    if len(y) == 0:
        raise ValueError("Audio file is empty")

    duration = len(y) / sr

    # Onset detection with backtrack for tight onset alignment
    onsets_samples = librosa.onset.onset_detect(
        y=y, sr=sr, backtrack=True, units="samples"
    )
    onsets_times = onsets_samples.astype(float) / sr

    # Tempo detection; clamp to 60-180, fallback 100.0 on failure or few onsets
    tempo = 100.0
    if len(onsets_times) >= 3:
        try:
            tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
            t = float(np.atleast_1d(tempo_arr)[0])
            if 60.0 <= t <= 180.0:
                tempo = t
        except Exception:
            pass

    # Classify each onset using ~60ms window band energy
    window_sec = 0.060
    window_n = int(window_sec * sr)

    classified = []
    for onset_time in onsets_times:
        start_s = int(onset_time * sr)
        end_s = min(start_s + window_n, len(y))
        chunk = y[start_s:end_s]
        if len(chunk) < 32:
            continue

        fft_mag = np.abs(np.fft.rfft(chunk))
        freqs = np.fft.rfftfreq(len(chunk), d=1.0 / sr)

        low_mask = freqs < 150.0
        high_mask = freqs > 4000.0

        low_energy = float(np.sqrt(np.mean(fft_mag[low_mask] ** 2))) if low_mask.any() else 0.0
        high_energy = float(np.sqrt(np.mean(fft_mag[high_mask] ** 2))) if high_mask.any() else 0.0
        total_energy = float(np.sqrt(np.mean(fft_mag ** 2)))

        if total_energy < 1e-8:
            continue

        low_ratio = low_energy / total_energy
        high_ratio = high_energy / total_energy

        if low_ratio > 0.4:
            lane = "kick"
            confidence = low_ratio
        elif high_ratio > 0.35 and low_ratio < 0.25:
            lane = "hat"
            confidence = high_ratio
        else:
            lane = "snare"
            confidence = max(0.0, 1.0 - low_ratio - high_ratio)

        classified.append((float(onset_time), lane, float(min(1.0, confidence))))

    # Quantize to 16th-note grid (steps_per_beat = 4)
    steps_per_beat = 4
    step_dur = 60.0 / tempo / steps_per_beat
    seconds_per_bar = 60.0 / tempo * 4
    bars = max(1, min(8, math.ceil(duration / seconds_per_bar)))
    steps_total = bars * 16

    t0 = classified[0][0] if classified else 0.0

    lanes: dict = {"kick": set(), "snare": set(), "hat": set()}
    onsets_out = []

    for onset_time, lane, confidence in classified:
        step = int(round((onset_time - t0) / step_dur))
        step = max(0, min(step, steps_total - 1))
        if lane in lanes:
            lanes[lane].add(step)
        onsets_out.append({"time": round(onset_time, 4), "lane": lane, "confidence": round(confidence, 3)})

    grid_id = str(uuid.uuid4())[:8]

    return {
        "grid_id": grid_id,
        "tempo": round(tempo, 1),
        "duration": round(duration, 3),
        "steps_per_beat": steps_per_beat,
        "bars": bars,
        "steps_total": steps_total,
        "lanes": {k: sorted(v) for k, v in lanes.items()},
        "onsets": onsets_out,
    }


def render_drums(
    tempo: float,
    steps_per_beat: int,
    steps_total: int,
    lanes: dict,
    job_dir: Path,
) -> dict:
    """
    Synthesize a drum pattern to WAV + MIDI and write drums.wav and drums.mid
    into job_dir. Returns a dict with render_id, file paths, and duration.
    """
    step_dur = 60.0 / tempo / steps_per_beat
    total_duration = steps_total * step_dur
    total_samples = int(total_duration * SR)

    mix = np.zeros(total_samples, dtype=np.float32)

    # Precompute one-shot for each lane that has hits
    for lane_name, steps in lanes.items():
        if not steps:
            continue
        hit = _HIT_GENERATORS[lane_name](sr=SR)
        hit_len = len(hit)
        for step in steps:
            start = int(step * step_dur * SR)
            end = min(start + hit_len, total_samples)
            mix[start:end] += hit[:end - start]

    # Clip protection
    peak = float(np.max(np.abs(mix)))
    if peak > 0.99:
        mix = mix / peak * 0.99

    render_id = str(uuid.uuid4())[:8]
    wav_path = job_dir / "drums.wav"
    mid_path = job_dir / "drums.mid"

    sf.write(str(wav_path), mix, SR, subtype="PCM_16")

    # MIDI: drum track, GM channel 9 (is_drum=True in pretty_midi)
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    note_dur = step_dur * 0.8

    for lane_name, steps in lanes.items():
        midi_note = GM_NOTES[lane_name]
        for step in steps:
            t_start = step * step_dur
            t_end = t_start + note_dur
            inst.notes.append(pretty_midi.Note(100, midi_note, t_start, t_end))

    pm.instruments.append(inst)
    pm.write(str(mid_path))

    print(f"[drums] render_id={render_id} tempo={tempo} bars={steps_total // steps_per_beat // 4} wav={wav_path.stat().st_size}B")

    return {
        "render_id": render_id,
        "wav_path": wav_path,
        "mid_path": mid_path,
        "duration": round(total_duration, 3),
    }
