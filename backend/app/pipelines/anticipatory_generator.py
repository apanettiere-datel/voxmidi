"""Multi-track MIDI generation using GPT-4o for note-level composition.

Generates production-quality multi-instrument MIDI files from:
  1. Text descriptions (GPT extracts parameters + composes note data)
  2. Melody input (generates accompaniment around a given melody)
  3. Reference audio (Demucs stems → Basic Pitch transcription → combined MIDI)
"""

import os
import json
from pathlib import Path
from typing import Optional, Dict, List

import pretty_midi


def _get_openai_client():
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    from openai import OpenAI
    return OpenAI(api_key=api_key)


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
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        params = json.loads(text)
    except json.JSONDecodeError:
        print(f"[midi-gen] GPT returned invalid JSON: {text}")
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


def _compose_tracks_with_gpt(params: Dict, melody_notes: Optional[List[Dict]] = None) -> List[Dict]:
    """Use GPT-4o to compose multi-track MIDI note data as structured JSON."""
    client = _get_openai_client()

    tempo = params.get("tempo", 120)
    key = params.get("key", "Am")
    duration = params.get("duration_seconds", 30)
    density = params.get("density", "medium")
    instruments = params.get("instruments", ["drums", "bass", "piano"])
    mood = params.get("mood", "neutral")
    time_sig = params.get("time_signature", "4/4")

    beat_dur = 60.0 / tempo
    num_beats = int(duration / beat_dur)
    num_bars = num_beats // 4

    melody_context = ""
    if melody_notes:
        melody_summary = json.dumps(melody_notes[:64], separators=(',', ':'))
        melody_context = (
            f"\n\nIMPORTANT: A melody has been provided. Generate ACCOMPANIMENT tracks that complement it. "
            f"Do NOT generate a melody track. The melody notes (first 64): {melody_summary}\n"
            f"Match the harmonic content and rhythm of the melody."
        )

    system_prompt = f"""You are a professional music producer and composer. Generate multi-track MIDI note data as JSON.

RULES FOR PRODUCTION-QUALITY MIDI:
- Output must be realistic enough for a producer to use in FL Studio / Ableton / Logic
- Use proper chord progressions for the genre (not just random notes)
- Drums: use General MIDI drum map (kick=36, snare=38, closed-hat=42, open-hat=46, crash=49, ride=51, tom-low=45, tom-mid=47, tom-hi=48, clap=39)
- Bass: follow the root notes of the chord progression, use octave 2-3 (MIDI 36-59)
- Chords/Piano: voice chords properly in octave 4-5 (MIDI 60-83), use inversions for smooth voice leading
- Melody: use scale-appropriate notes in octave 4-5, include passing tones and rhythmic variation
- Strings/Pads: sustained notes following the chord progression
- Guitar: arpeggiated or strummed patterns
- Vary velocity (60-110) for human feel — downbeats louder, ghost notes softer
- Include rests and variation — don't just loop the same bar
- Make it {num_bars} bars long at {tempo} BPM in {key} {time_sig}
- Density: {density}
- Mood: {mood}

Return ONLY valid JSON array of tracks:
[
  {{
    "name": "Drums",
    "instrument": "drums",
    "is_drum": true,
    "program": 0,
    "notes": [
      {{"pitch": 36, "start": 0.0, "end": 0.1, "velocity": 100}},
      ...
    ]
  }},
  {{
    "name": "Bass",
    "instrument": "bass",
    "is_drum": false,
    "program": 33,
    "notes": [...]
  }},
  ...
]

Times are in seconds. Use these GM program numbers:
drums=0(ignored), bass=33, piano=0, guitar=25, strings=48, synth=81, pad=89, organ=19

Generate ALL notes for ALL {num_bars} bars. Do NOT use shorthand or "repeat" instructions.{melody_context}"""

    user_content = f"Generate a {duration}-second {mood} track in {key} at {tempo} BPM, {time_sig} time. Instruments: {', '.join(instruments)}. Density: {density}."

    print(f"[midi-gen] Requesting GPT-4o composition: {num_bars} bars, {instruments}...")
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        max_tokens=16000,
        temperature=params.get("top_p", 0.95),
    )

    text = resp.choices[0].message.content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        tracks = json.loads(text)
    except json.JSONDecodeError:
        print(f"[midi-gen] GPT returned invalid JSON, attempting to extract array...")
        start = text.find('[')
        end = text.rfind(']')
        if start >= 0 and end > start:
            try:
                tracks = json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                print(f"[midi-gen] Could not parse GPT output")
                raise ValueError("GPT-4o returned invalid JSON for MIDI composition")
        else:
            raise ValueError("GPT-4o returned no parseable track data")

    print(f"[midi-gen] GPT generated {len(tracks)} tracks")
    return tracks


def _tracks_to_midi(tracks: List[Dict], tempo: float, time_sig: str = "4/4") -> pretty_midi.PrettyMIDI:
    """Convert GPT-generated track data to a PrettyMIDI object."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)

    ts_parts = time_sig.split('/')
    numerator = int(ts_parts[0]) if len(ts_parts) == 2 else 4
    denominator = int(ts_parts[1]) if len(ts_parts) == 2 else 4
    ts = pretty_midi.TimeSignature(numerator, denominator, 0.0)
    pm.time_signature_changes.append(ts)

    for track in tracks:
        is_drum = track.get("is_drum", False)
        program = track.get("program", 0)
        name = track.get("name", "Track")

        inst = pretty_midi.Instrument(
            program=program if not is_drum else 0,
            is_drum=is_drum,
            name=name,
        )

        for note in track.get("notes", []):
            pitch = int(note.get("pitch", 60))
            start = float(note.get("start", 0))
            end = float(note.get("end", start + 0.1))
            velocity = int(note.get("velocity", 80))

            pitch = max(0, min(127, pitch))
            velocity = max(1, min(127, velocity))
            if end <= start:
                end = start + 0.05

            inst.notes.append(pretty_midi.Note(
                velocity=velocity,
                pitch=pitch,
                start=start,
                end=end,
            ))

        if inst.notes:
            pm.instruments.append(inst)

    return pm


def generate_midi(
    prompt: str,
    genre: str = "",
    job_dir: str = "/tmp",
    melody_midi_path: Optional[str] = None,
) -> str:
    """
    Generate a multi-track MIDI file using GPT-4o for composition.

    If melody_midi_path is provided, generates accompaniment around that melody.
    Otherwise generates from scratch based on the prompt.

    Returns path to the generated MIDI file.
    """
    job_path = Path(job_dir)
    job_path.mkdir(parents=True, exist_ok=True)

    print(f"[midi-gen] Parsing prompt: {prompt[:80]}...")
    params = _parse_prompt_with_gpt(prompt, genre)
    print(f"[midi-gen] Parameters: {json.dumps(params, indent=2)}")

    melody_notes = None
    if melody_midi_path and Path(melody_midi_path).exists():
        print(f"[midi-gen] Loading melody from {melody_midi_path}...")
        melody_pm = pretty_midi.PrettyMIDI(melody_midi_path)
        for inst in melody_pm.instruments:
            if not inst.is_drum and inst.notes:
                melody_notes = [
                    {"pitch": n.pitch, "start": round(n.start, 3), "end": round(n.end, 3), "velocity": n.velocity}
                    for n in sorted(inst.notes, key=lambda n: n.start)
                ]
                break

    tracks_data = _compose_tracks_with_gpt(params, melody_notes)

    tempo = params.get("tempo", 120)
    time_sig = params.get("time_signature", "4/4")
    pm = _tracks_to_midi(tracks_data, tempo, time_sig)

    if melody_notes and melody_midi_path:
        melody_pm = pretty_midi.PrettyMIDI(melody_midi_path)
        for inst in melody_pm.instruments:
            if not inst.is_drum and inst.notes:
                melody_inst = pretty_midi.Instrument(program=73, is_drum=False, name="Melody")
                melody_inst.notes = inst.notes
                pm.instruments.insert(0, melody_inst)
                break

    output_path = job_path / "workshop_output.mid"
    pm.write(str(output_path))
    print(f"[midi-gen] Saved MIDI to {output_path} ({len(pm.instruments)} tracks, {pm.get_end_time():.1f}s)")

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

    print(f"[ref_to_midi] Separating stems from {audio_path}...")
    stems = separate_stems(audio_path, str(stems_dir))
    print(f"[ref_to_midi] Got stems: {list(stems.keys())}")

    stem_midis = {}
    for stem_name, stem_path in stems.items():
        if stem_name == "drums":
            continue
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

    combined = pretty_midi.PrettyMIDI(initial_tempo=120)

    GM_PROGRAMS = {
        "vocals": 52,
        "bass": 33,
        "other": 0,
        "guitar": 25,
        "piano": 0,
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

    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=60)
        detected_tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        if hasattr(detected_tempo, '__len__'):
            detected_tempo = float(detected_tempo[0])
        if 60 <= detected_tempo <= 200:
            combined._initial_tempo = detected_tempo
    except Exception as e:
        print(f"[ref_to_midi] Tempo detection failed: {e}")

    output_path = job_path / "reference_output.mid"
    combined.write(str(output_path))
    print(f"[ref_to_midi] Combined MIDI saved to {output_path}")

    return str(output_path)
