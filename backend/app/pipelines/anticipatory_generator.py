"""Multi-track MIDI generation using Anticipatory Music Transformer.

Generates production-quality multi-instrument MIDI files from:
  1. Text descriptions (via ChatGPT parameter extraction + model generation)
  2. Melody input (generates accompaniment around a given melody)
  3. From scratch (model samples freely)
"""

import os
import json
import functools
from pathlib import Path
from typing import Optional, Dict, List

import pretty_midi

_model = None
_tokenizer = None


def _get_model():
    """Lazy-load the Anticipatory Music Transformer model."""
    global _model
    if _model is not None:
        return _model

    import torch
    from transformers import AutoModelForCausalLM

    model_name = os.environ.get(
        "ANTICIPATION_MODEL", "stanford-crfm/music-medium-800k"
    )
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[anticipatory] Loading {model_name} on {device}...")

    _model = AutoModelForCausalLM.from_pretrained(model_name)
    _model = _model.to(device)
    _model.eval()
    print(f"[anticipatory] Model loaded.")
    return _model


def _parse_prompt_with_gpt(raw_prompt: str, genre: str = "") -> Dict:
    """Use GPT-4o-mini to extract structured musical parameters from a text prompt."""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return _default_params(genre)

    from openai import OpenAI
    client = OpenAI(api_key=api_key)

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a music theory expert. Extract structured musical parameters "
                    "from the user's description. Return ONLY valid JSON with these fields:\n"
                    '{\n'
                    '  "tempo": <int 60-200>,\n'
                    '  "key": "<root note like C, Dm, F#m, Bb>",\n'
                    '  "time_signature": "<like 4/4 or 3/4>",\n'
                    '  "duration_seconds": <int 15-60>,\n'
                    '  "density": "<sparse|medium|dense>",\n'
                    '  "instruments": ["drums", "bass", "piano", "strings", "synth", "guitar"],\n'
                    '  "mood": "<one or two words>",\n'
                    '  "top_p": <float 0.8-0.99 — lower for more predictable, higher for more creative>\n'
                    "}\n"
                    "Choose instruments and parameters that fit the described genre and mood. "
                    "Output ONLY the JSON, nothing else."
                ),
            },
            {
                "role": "user",
                "content": f"Genre: {genre}\nDescription: {raw_prompt}" if genre else raw_prompt,
            },
        ],
        max_tokens=300,
        temperature=0.3,
    )

    text = resp.choices[0].message.content.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        params = json.loads(text)
    except json.JSONDecodeError:
        print(f"[anticipatory] GPT returned invalid JSON: {text}")
        params = _default_params(genre)

    return params


def _default_params(genre: str = "") -> Dict:
    defaults = {
        "pop": {"tempo": 120, "key": "C", "density": "medium", "top_p": 0.95},
        "trap": {"tempo": 140, "key": "Fm", "density": "medium", "top_p": 0.92},
        "edm": {"tempo": 128, "key": "Am", "density": "dense", "top_p": 0.90},
        "lo-fi-hip-hop": {"tempo": 85, "key": "Cm", "density": "sparse", "top_p": 0.95},
        "house": {"tempo": 124, "key": "Gm", "density": "medium", "top_p": 0.93},
        "jazz": {"tempo": 110, "key": "Dm", "density": "medium", "top_p": 0.97},
        "rock": {"tempo": 130, "key": "Em", "density": "dense", "top_p": 0.92},
    }
    base = defaults.get(genre, {"tempo": 120, "key": "Am", "density": "medium", "top_p": 0.95})
    return {
        "tempo": base["tempo"],
        "key": base["key"],
        "time_signature": "4/4",
        "duration_seconds": 30,
        "density": base["density"],
        "instruments": ["drums", "bass", "piano"],
        "mood": "neutral",
        "top_p": base["top_p"],
    }


def generate_midi(
    prompt: str,
    genre: str = "",
    job_dir: str = "/tmp",
    melody_midi_path: Optional[str] = None,
) -> str:
    """
    Generate a multi-track MIDI file.

    If melody_midi_path is provided, generates accompaniment around that melody.
    Otherwise generates from scratch based on the prompt.

    Returns path to the generated MIDI file.
    """
    job_path = Path(job_dir)
    job_path.mkdir(parents=True, exist_ok=True)

    # Step 1: Extract musical parameters via GPT
    print(f"[anticipatory] Parsing prompt: {prompt[:80]}...")
    params = _parse_prompt_with_gpt(prompt, genre)
    print(f"[anticipatory] Parameters: {json.dumps(params, indent=2)}")

    tempo = params.get("tempo", 120)
    key = params.get("key", "Am")
    duration = min(params.get("duration_seconds", 30), 60)
    top_p = params.get("top_p", 0.95)

    # Step 2: Generate with Anticipatory Music Transformer
    model = _get_model()

    from anticipation.sample import generate
    from anticipation.convert import events_to_midi, midi_to_events

    if melody_midi_path and Path(melody_midi_path).exists():
        # Accompaniment mode: generate around the provided melody
        print(f"[anticipatory] Generating accompaniment for {melody_midi_path}...")
        from anticipation.ops import extract_instruments
        melody_events = midi_to_events(melody_midi_path)
        melody_only = extract_instruments(melody_events, [0])
        events = generate(
            model,
            start_time=0,
            end_time=duration,
            inputs=melody_only,
            top_p=top_p,
        )
    else:
        # Generate from scratch
        print(f"[anticipatory] Generating {duration}s of music from scratch...")
        events = generate(
            model,
            start_time=0,
            end_time=duration,
            top_p=top_p,
        )

    # Step 3: Convert to MIDI
    mid = events_to_midi(events)

    # Step 4: Post-process — set tempo, transpose to target key
    mid.ticks_per_beat = 480
    # Set tempo
    import mido
    for track in mid.tracks:
        # Remove existing tempo events
        track[:] = [msg for msg in track if not (msg.type == 'set_tempo')]
    # Add tempo to first track
    if mid.tracks:
        mid.tracks[0].insert(0, mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(tempo), time=0))

    # Transpose to target key if needed
    target_root = _key_to_midi_root(key)
    if target_root is not None:
        _transpose_to_key(mid, target_root)

    # Step 5: Assign instrument names and programs for DAW compatibility
    _assign_instruments(mid, params.get("instruments", []))

    # Save
    output_path = job_path / "workshop_output.mid"
    mid.save(str(output_path))
    print(f"[anticipatory] Saved MIDI to {output_path}")

    return str(output_path)


def reference_to_midi(
    audio_path: str,
    job_dir: str,
) -> str:
    """
    Convert a reference audio file to multi-track MIDI.

    Pipeline: audio → Demucs stem separation → Basic Pitch transcription per stem → combined MIDI
    """
    from pipelines.separator import separate_stems
    from pipelines.transcriber import transcribe_audio

    job_path = Path(job_dir)
    stems_dir = job_path / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Separate stems
    print(f"[ref_to_midi] Separating stems from {audio_path}...")
    stems = separate_stems(audio_path, str(stems_dir))
    print(f"[ref_to_midi] Got stems: {list(stems.keys())}")

    # Step 2: Transcribe each stem to MIDI
    stem_midis = {}
    for stem_name, stem_path in stems.items():
        if stem_name == "drums":
            continue  # Basic Pitch doesn't handle drums well
        try:
            midi_path = transcribe_audio(
                stem_path,
                str(stems_dir),
                output_name=f"{stem_name}.mid",
            )
            stem_midis[stem_name] = midi_path
            print(f"[ref_to_midi] Transcribed {stem_name} → {midi_path}")
        except Exception as e:
            print(f"[ref_to_midi] Failed to transcribe {stem_name}: {e}")

    # Step 3: Combine into a single multi-track MIDI
    combined = pretty_midi.PrettyMIDI(initial_tempo=120)

    GM_PROGRAMS = {
        "vocals": 52,    # Choir Aahs
        "bass": 33,      # Electric Bass (finger)
        "other": 0,      # Acoustic Grand Piano
        "guitar": 25,    # Acoustic Guitar (steel)
        "piano": 0,      # Acoustic Grand Piano
    }

    for stem_name, midi_path in stem_midis.items():
        try:
            pm = pretty_midi.PrettyMIDI(midi_path)
            for inst in pm.instruments:
                new_inst = pretty_midi.Instrument(
                    program=GM_PROGRAMS.get(stem_name, 0),
                    is_drum=False,
                    name=stem_name.capitalize(),
                )
                new_inst.notes = inst.notes
                combined.instruments.append(new_inst)
        except Exception as e:
            print(f"[ref_to_midi] Error loading {stem_name} MIDI: {e}")

    # Detect tempo from audio
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=60)
        detected_tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        if hasattr(detected_tempo, '__len__'):
            detected_tempo = float(detected_tempo[0])
        if 60 <= detected_tempo <= 200:
            combined.adjust_times([0, combined.get_end_time()],
                                  [0, combined.get_end_time()])
            # Update initial tempo
            combined._initial_tempo = detected_tempo
    except Exception as e:
        print(f"[ref_to_midi] Tempo detection failed: {e}")

    output_path = job_path / "reference_output.mid"
    combined.write(str(output_path))
    print(f"[ref_to_midi] Combined MIDI saved to {output_path}")

    return str(output_path)


# ─── Helpers ─────────────────────────────────────────────────────────────────

KEY_MAP = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3,
    'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8,
    'A': 9, 'A#': 10, 'Bb': 10, 'B': 11,
}


def _key_to_midi_root(key: str) -> Optional[int]:
    clean = key.replace('m', '').replace('minor', '').replace('major', '').strip()
    return KEY_MAP.get(clean)


def _transpose_to_key(mid, target_root: int):
    """Transpose all non-drum notes so the detected root aligns with target_root."""
    import mido

    # Detect current root from note distribution
    pitch_counts = [0] * 12
    for track in mid.tracks:
        for msg in track:
            if msg.type == 'note_on' and msg.velocity > 0 and msg.channel != 9:
                pitch_counts[msg.note % 12] += 1

    if sum(pitch_counts) == 0:
        return

    current_root = pitch_counts.index(max(pitch_counts))
    shift = (target_root - current_root) % 12
    if shift > 6:
        shift -= 12

    if shift == 0:
        return

    print(f"[anticipatory] Transposing by {shift} semitones to target root {target_root}")
    for track in mid.tracks:
        for msg in track:
            if hasattr(msg, 'note') and msg.channel != 9:
                msg.note = max(0, min(127, msg.note + shift))


def _assign_instruments(mid, requested_instruments: List[str]):
    """Assign General MIDI program numbers and names to tracks for DAW compatibility."""
    import mido

    INSTRUMENT_PROGRAMS = {
        "drums": (0, True),
        "bass": (33, False),
        "piano": (0, False),
        "guitar": (25, False),
        "strings": (48, False),
        "synth": (81, False),
        "pad": (89, False),
        "organ": (19, False),
    }

    for i, track in enumerate(mid.tracks):
        if i == 0:
            continue  # Skip tempo track

        # Try to match track to a requested instrument
        if i - 1 < len(requested_instruments):
            inst_name = requested_instruments[i - 1]
        else:
            inst_name = "piano"

        program, is_drum = INSTRUMENT_PROGRAMS.get(inst_name, (0, False))
        channel = 9 if is_drum else min(i, 15) if i < 9 else min(i + 1, 15)

        # Set track name
        has_name = False
        for msg in track:
            if msg.type == 'track_name':
                msg.name = inst_name.capitalize()
                has_name = True
                break
        if not has_name:
            track.insert(0, mido.MetaMessage('track_name', name=inst_name.capitalize(), time=0))

        # Set program change
        has_program = False
        for msg in track:
            if msg.type == 'program_change':
                msg.program = program
                msg.channel = channel
                has_program = True
                break
        if not has_program:
            track.insert(1, mido.Message('program_change', program=program, channel=channel, time=0))

        # Update channel on all note events
        for msg in track:
            if hasattr(msg, 'channel'):
                msg.channel = channel
