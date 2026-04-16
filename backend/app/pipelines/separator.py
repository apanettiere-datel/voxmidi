"""Wrapper around Demucs for audio source separation."""

import os
import subprocess
import tempfile
import urllib.request
import pretty_midi
from pathlib import Path
from typing import Dict


def separate_stems(audio_path: str, output_dir: str, model: str = 'htdemucs_ft') -> Dict[str, str]:
    provider = os.environ.get('SEPARATOR_PROVIDER', 'mock')

    if provider == 'mock':
        return _mock_stems(audio_path, output_dir)
    elif provider == 'api':
        return _separate_via_replicate(audio_path, output_dir)
    else:  # local Demucs
        return _separate_via_demucs(audio_path, output_dir, model)


def _separate_via_replicate(audio_path: str, output_dir: str) -> Dict[str, str]:
    """Separate stems via Replicate's hosted Demucs model."""
    import replicate

    token = os.environ.get('REPLICATE_API_TOKEN', '')
    if not token:
        raise RuntimeError("REPLICATE_API_TOKEN not set")

    client = replicate.Client(api_token=token)

    # Upload audio file
    audio_file = Path(audio_path)
    if not audio_file.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    print(f"[separator] Uploading {audio_file.name} to Replicate...")
    with open(audio_path, 'rb') as f:
        output = client.run(
            "cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",
            input={
                "audio": f,
                "model_name": "htdemucs",
                "shifts": 1,
                "float32": False,
                "output_format": "mp3",
            }
        )

    # output is a dict with stem URLs: {"bass": url, "drums": url, "other": url, "vocals": url}
    stems = {}
    output_path = Path(output_dir)

    stem_map = {
        "vocals": output.get("vocals"),
        "bass": output.get("bass"),
        "drums": output.get("drums"),
        "other": output.get("other"),
        "guitar": output.get("guitar"),
        "piano": output.get("piano"),
    }
    # Remove None entries
    stem_map = {k: v for k, v in stem_map.items() if v}

    for stem_name, url in stem_map.items():
        dest = output_path / f"{stem_name}.mp3"
        print(f"[separator] Downloading {stem_name} stem...")
        urllib.request.urlretrieve(str(url), str(dest))
        stems[stem_name] = str(dest)

    if not stems:
        raise RuntimeError("Replicate Demucs returned no stems")

    print(f"[separator] Got {len(stems)} stems: {list(stems.keys())}")
    return stems


def _mock_stems(audio_path: str, output_dir: str) -> Dict[str, str]:
    """Generate mock MIDI stems for development."""
    import numpy as np
    stems = {}
    output_path = Path(output_dir)

    stem_configs = [
        ('vocals', 0, False),
        ('bass', 33, False),
        ('drums', 0, True),
        ('other', 4, False),
    ]

    tempo = 120.0
    beat = 60.0 / tempo
    num_bars = 8

    for stem_name, program, is_drum in stem_configs:
        pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
        inst = pretty_midi.Instrument(program=program, is_drum=is_drum, name=stem_name.capitalize())

        if is_drum:
            for bar_i in range(num_bars):
                t = bar_i * beat * 4
                for beat_i in range(4):
                    bt = t + beat_i * beat
                    if beat_i in [0, 2]:
                        inst.notes.append(pretty_midi.Note(velocity=90, pitch=36, start=bt, end=bt+0.1))
                    if beat_i in [1, 3]:
                        inst.notes.append(pretty_midi.Note(velocity=80, pitch=38, start=bt, end=bt+0.1))
                    inst.notes.append(pretty_midi.Note(velocity=60, pitch=42, start=bt, end=bt+0.05))
        elif stem_name == 'bass':
            for bar_i in range(num_bars):
                t = bar_i * beat * 4
                for beat_i in range(4):
                    bt = t + beat_i * beat
                    pitch = [45, 45, 48, 43][beat_i % 4]
                    inst.notes.append(pretty_midi.Note(velocity=80, pitch=pitch, start=bt, end=bt+beat*0.8))
        elif stem_name == 'vocals':
            pent = [69, 72, 74, 76, 79]
            for bar_i in range(num_bars):
                t = bar_i * beat * 4
                for i in range(4):
                    pitch = np.random.choice(pent)
                    nt = t + i * beat
                    inst.notes.append(pretty_midi.Note(velocity=75, pitch=pitch, start=nt, end=nt+beat*0.75))
        else:  # other/chords
            for bar_i in range(num_bars):
                t = bar_i * beat * 4
                for p in [69, 72, 76]:
                    inst.notes.append(pretty_midi.Note(velocity=65, pitch=p, start=t, end=t+beat*2))

        pm.instruments.append(inst)
        midi_path = output_path / f'{stem_name}_mock.mid'
        pm.write(str(midi_path))
        stems[stem_name] = str(midi_path)

    return stems


def _separate_via_demucs(audio_path: str, output_dir: str, model: str) -> Dict[str, str]:
    cmd = ['python', '-m', 'demucs', '-n', model, '-o', output_dir, '--mp3', '--mp3-bitrate', '320', audio_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f'Demucs failed: {result.stderr}')

    input_stem = Path(audio_path).stem
    stems_dir = Path(output_dir) / model / input_stem
    if not stems_dir.exists():
        stems_dir = Path(output_dir) / input_stem

    stems = {}
    for stem_name in ['vocals', 'drums', 'bass', 'other']:
        for ext in ['.wav', '.mp3']:
            p = stems_dir / f'{stem_name}{ext}'
            if p.exists():
                stems[stem_name] = str(p)
                break

    if not stems:
        raise FileNotFoundError(f'No stems found in {stems_dir}')
    return stems
