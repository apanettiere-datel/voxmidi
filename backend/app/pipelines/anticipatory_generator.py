"""Hybrid MIDI generation: GPT-4o-mini for creative decisions, algorithmic code for note generation.

Pipeline:
  1. GPT-4o-mini extracts musical parameters (tempo, key, instruments) from the user's prompt
  2. GPT-4o-mini generates a composition plan (chord progression, patterns, structure)
  3. Deterministic code expands the plan into MIDI notes — always in-key, on-grid, valid
  4. Reference audio path: Demucs stems → Basic Pitch transcription → combined MIDI
"""

import os
import json
import random
from pathlib import Path
from typing import Optional, Dict, List, Tuple

import pretty_midi


# ─── Music theory constants ────────────────────────────────────────────────────

SCALE_INTERVALS = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "blues": [0, 3, 5, 6, 7, 10],
}

NOTE_TO_SEMITONE = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}

CHORD_INTERVALS = {
    "maj": [0, 4, 7],
    "min": [0, 3, 7],
    "7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "min7": [0, 3, 7, 10],
    "dim": [0, 3, 6],
    "aug": [0, 4, 8],
    "sus2": [0, 2, 7],
    "sus4": [0, 5, 7],
}

GM_PROGRAMS = {
    "drums": 0, "bass": 33, "piano": 0, "guitar": 25,
    "strings": 48, "synth": 81, "pad": 89, "organ": 19,
}

# GM drum map
KICK = 36
SNARE = 38
CLAP = 39
CLOSED_HAT = 42
OPEN_HAT = 46
CRASH = 49
RIDE = 51
SIDESTICK = 37
TOM_LOW = 45
TOM_MID = 47
TOM_HI = 48
SHAKER = 70


# ─── Chord and scale helpers ───────────────────────────────────────────────────

def _parse_key(key_str: str) -> Tuple[int, str]:
    key_str = key_str.strip()
    if not key_str:
        return 9, "minor"

    is_minor = key_str.endswith("m") and not key_str.endswith("dim") and not key_str.endswith("aug")
    root_str = key_str.rstrip("m").strip() if is_minor else key_str.strip()

    root = NOTE_TO_SEMITONE.get(root_str, NOTE_TO_SEMITONE.get(root_str[0], 9))

    return root, "minor" if is_minor else "major"


def _parse_chord(chord_str: str) -> Tuple[int, List[int]]:
    """Parse a chord symbol like 'Am', 'F#m7', 'Csus4' into (root_semitone, intervals)."""
    chord_str = chord_str.strip()
    if not chord_str:
        return 0, CHORD_INTERVALS["maj"]

    # Extract root note (1 or 2 chars)
    if len(chord_str) > 1 and chord_str[1] in ('#', 'b'):
        root_str = chord_str[:2]
        quality_str = chord_str[2:]
    else:
        root_str = chord_str[0]
        quality_str = chord_str[1:]

    root = NOTE_TO_SEMITONE.get(root_str, 0)

    if quality_str in ("m", "min"):
        intervals = CHORD_INTERVALS["min"]
    elif quality_str in ("m7", "min7"):
        intervals = CHORD_INTERVALS["min7"]
    elif quality_str in ("7", "dom7"):
        intervals = CHORD_INTERVALS["7"]
    elif quality_str in ("maj7", "M7"):
        intervals = CHORD_INTERVALS["maj7"]
    elif quality_str == "dim":
        intervals = CHORD_INTERVALS["dim"]
    elif quality_str == "aug":
        intervals = CHORD_INTERVALS["aug"]
    elif quality_str == "sus2":
        intervals = CHORD_INTERVALS["sus2"]
    elif quality_str == "sus4":
        intervals = CHORD_INTERVALS["sus4"]
    elif quality_str == "" or quality_str in ("maj", "M"):
        intervals = CHORD_INTERVALS["maj"]
    else:
        intervals = CHORD_INTERVALS["min"] if "m" in quality_str.lower() else CHORD_INTERVALS["maj"]

    return root, intervals


def _chord_pitches(root: int, intervals: List[int], octave: int = 4) -> List[int]:
    """Get MIDI pitches for a chord at a given octave."""
    base = octave * 12 + root
    return [base + i for i in intervals if 0 <= base + i <= 127]


def _get_scale_degrees(root: int, scale_type: str, octave: int = 4) -> List[int]:
    """Get MIDI pitches for one octave of a scale."""
    intervals = SCALE_INTERVALS.get(scale_type, SCALE_INTERVALS["minor"])
    base = octave * 12 + root
    return [base + i for i in intervals if 0 <= base + i <= 127]


def _get_scale_pitches_set(root: int, scale_type: str) -> set:
    intervals = SCALE_INTERVALS.get(scale_type, SCALE_INTERVALS["minor"])
    pitches = set()
    for octave_base in range(0, 128, 12):
        for interval in intervals:
            p = octave_base + root + interval
            if 0 <= p <= 127:
                pitches.add(p)
    return pitches


def _snap_to_scale(pitch: int, valid_pitches: set) -> int:
    if pitch in valid_pitches:
        return pitch
    for offset in range(1, 7):
        if pitch - offset in valid_pitches:
            return pitch - offset
        if pitch + offset in valid_pitches:
            return pitch + offset
    return pitch


# ─── Drum pattern library ──────────────────────────────────────────────────────
# Each pattern is a list of (beat_offset_in_16ths, pitch, velocity) for one bar of 4/4

def _drum_pattern_four_on_floor() -> List[Tuple[int, int, int]]:
    hits = []
    for i in range(4):
        hits.append((i * 4, KICK, 100))
    hits.append((4, SNARE, 95))
    hits.append((12, SNARE, 95))
    for i in range(8):
        hits.append((i * 2, CLOSED_HAT, 70 + random.randint(-5, 5)))
    return hits


def _drum_pattern_trap() -> List[Tuple[int, int, int]]:
    hits = [
        (0, KICK, 110),
        (6, KICK, 95),
        (10, KICK, 100),
        (8, SNARE, 100),
        (0, CLOSED_HAT, 65),
    ]
    # Rapid hi-hats
    for i in range(16):
        hits.append((i, CLOSED_HAT, 55 + random.randint(-5, 10)))
    # Hat rolls on beat 4
    hits.append((14, OPEN_HAT, 75))
    return hits


def _drum_pattern_rock() -> List[Tuple[int, int, int]]:
    hits = [
        (0, KICK, 105), (8, KICK, 100),
        (4, SNARE, 100), (12, SNARE, 100),
        (0, CRASH, 80),
    ]
    for i in range(8):
        hits.append((i * 2, CLOSED_HAT, 70 + random.randint(-5, 5)))
    return hits


def _drum_pattern_lofi() -> List[Tuple[int, int, int]]:
    hits = [
        (0, KICK, 80), (7, KICK, 70),
        (4, SIDESTICK, 65), (12, SIDESTICK, 60),
    ]
    for i in range(0, 16, 2):
        hits.append((i, CLOSED_HAT, 45 + random.randint(-5, 5)))
    return hits


def _drum_pattern_jazz() -> List[Tuple[int, int, int]]:
    hits = [
        (0, RIDE, 75), (3, RIDE, 55), (4, RIDE, 70),
        (6, RIDE, 50), (8, RIDE, 75), (11, RIDE, 55),
        (12, RIDE, 70), (14, RIDE, 50),
        (0, KICK, 60), (10, KICK, 55),
    ]
    return hits


def _drum_pattern_edm() -> List[Tuple[int, int, int]]:
    hits = []
    for i in range(4):
        hits.append((i * 4, KICK, 115))
    hits.append((4, CLAP, 95))
    hits.append((12, CLAP, 95))
    for i in range(8):
        v = 80 if i % 2 == 0 else 60
        hits.append((i * 2, CLOSED_HAT, v + random.randint(-3, 3)))
    hits.append((7, OPEN_HAT, 70))
    hits.append((15, OPEN_HAT, 70))
    return hits


def _drum_pattern_house() -> List[Tuple[int, int, int]]:
    hits = []
    for i in range(4):
        hits.append((i * 4, KICK, 110))
    hits.append((4, CLAP, 90))
    hits.append((12, CLAP, 90))
    for i in range(16):
        if i % 2 == 0:
            hits.append((i, CLOSED_HAT, 65 + random.randint(-5, 5)))
        else:
            hits.append((i, OPEN_HAT, 50 + random.randint(-3, 3)))
    return hits


DRUM_PATTERNS = {
    "four-on-floor": _drum_pattern_four_on_floor,
    "trap": _drum_pattern_trap,
    "rock": _drum_pattern_rock,
    "lo-fi": _drum_pattern_lofi,
    "jazz": _drum_pattern_jazz,
    "edm": _drum_pattern_edm,
    "house": _drum_pattern_house,
    "pop": _drum_pattern_four_on_floor,
    "synthwave": _drum_pattern_edm,
    "ambient": _drum_pattern_lofi,
}


# ─── Instrument pattern generators ─────────────────────────────────────────────

def _gen_drums(pattern_name: str, num_bars: int, beat_dur: float) -> List[Dict]:
    """Generate drum notes for num_bars using the named pattern."""
    pattern_fn = DRUM_PATTERNS.get(pattern_name, _drum_pattern_four_on_floor)
    sixteenth = beat_dur / 4
    notes = []

    for bar in range(num_bars):
        bar_start = bar * 4 * beat_dur
        pattern = pattern_fn()
        for pos_16th, pitch, velocity in pattern:
            t = bar_start + pos_16th * sixteenth
            vel = max(1, min(127, velocity + random.randint(-3, 3)))
            notes.append({"pitch": pitch, "start": t, "end": t + 0.05, "velocity": vel})

    return notes


def _gen_bass(chords_per_bar: List[str], num_bars: int, beat_dur: float, style: str) -> List[Dict]:
    """Generate bass notes following chord roots."""
    notes = []
    octave = 2

    for bar in range(num_bars):
        chord_str = chords_per_bar[bar % len(chords_per_bar)]
        root, intervals = _parse_chord(chord_str)
        root_pitch = octave * 12 + root
        bar_start = bar * 4 * beat_dur

        if style == "whole-note":
            notes.append({"pitch": root_pitch, "start": bar_start, "end": bar_start + 4 * beat_dur * 0.9, "velocity": 85})
        elif style == "half-note":
            notes.append({"pitch": root_pitch, "start": bar_start, "end": bar_start + 2 * beat_dur * 0.9, "velocity": 85})
            notes.append({"pitch": root_pitch, "start": bar_start + 2 * beat_dur, "end": bar_start + 4 * beat_dur * 0.9, "velocity": 80})
        elif style == "eighth-note":
            for i in range(8):
                t = bar_start + i * beat_dur / 2
                p = root_pitch if i % 2 == 0 else root_pitch + 12
                vel = 85 if i % 2 == 0 else 70
                notes.append({"pitch": p, "start": t, "end": t + beat_dur / 2 * 0.8, "velocity": vel + random.randint(-3, 3)})
        elif style == "syncopated":
            offsets = [0, 1.5, 3, 3.5]
            for off in offsets:
                t = bar_start + off * beat_dur
                notes.append({"pitch": root_pitch, "start": t, "end": t + beat_dur * 0.7, "velocity": 85 + random.randint(-5, 5)})
        elif style == "octave":
            notes.append({"pitch": root_pitch, "start": bar_start, "end": bar_start + beat_dur * 0.9, "velocity": 90})
            notes.append({"pitch": root_pitch + 12, "start": bar_start + beat_dur, "end": bar_start + 2 * beat_dur * 0.9, "velocity": 80})
            notes.append({"pitch": root_pitch, "start": bar_start + 2 * beat_dur, "end": bar_start + 3 * beat_dur * 0.9, "velocity": 85})
            notes.append({"pitch": root_pitch + 12, "start": bar_start + 3 * beat_dur, "end": bar_start + 4 * beat_dur * 0.9, "velocity": 75})
        else:
            notes.append({"pitch": root_pitch, "start": bar_start, "end": bar_start + 4 * beat_dur * 0.9, "velocity": 85})

    return notes


def _gen_piano(chords_per_bar: List[str], num_bars: int, beat_dur: float, style: str) -> List[Dict]:
    """Generate piano/chord notes."""
    notes = []
    octave = 4

    for bar in range(num_bars):
        chord_str = chords_per_bar[bar % len(chords_per_bar)]
        root, intervals = _parse_chord(chord_str)
        pitches = _chord_pitches(root, intervals, octave)
        bar_start = bar * 4 * beat_dur

        if style == "block":
            for beat in range(4):
                t = bar_start + beat * beat_dur
                vel = 85 if beat == 0 else 70
                for p in pitches:
                    notes.append({"pitch": p, "start": t, "end": t + beat_dur * 0.85, "velocity": vel + random.randint(-3, 3)})
        elif style == "arpeggiated":
            arp_pitches = pitches + [p + 12 for p in pitches[:1]]
            step = beat_dur / 2
            for i, p in enumerate(arp_pitches):
                t = bar_start + i * step
                if t >= bar_start + 4 * beat_dur:
                    break
                notes.append({"pitch": p, "start": t, "end": t + step * 0.8, "velocity": 75 + random.randint(-5, 5)})
            # Repeat pattern for second half of bar
            half = 4 * beat_dur / 2
            for i, p in enumerate(arp_pitches):
                t = bar_start + half + i * step
                if t >= bar_start + 4 * beat_dur:
                    break
                notes.append({"pitch": p, "start": t, "end": t + step * 0.8, "velocity": 70 + random.randint(-5, 5)})
        elif style == "stabs":
            offsets = [0, 0.5, 2]
            for off in offsets:
                t = bar_start + off * beat_dur
                for p in pitches:
                    notes.append({"pitch": p, "start": t, "end": t + beat_dur * 0.3, "velocity": 90 + random.randint(-5, 5)})
        elif style == "sustained":
            for p in pitches:
                notes.append({"pitch": p, "start": bar_start, "end": bar_start + 4 * beat_dur * 0.95, "velocity": 65 + random.randint(-3, 3)})
        else:
            for beat in [0, 2]:
                t = bar_start + beat * beat_dur
                for p in pitches:
                    notes.append({"pitch": p, "start": t, "end": t + 2 * beat_dur * 0.9, "velocity": 75 + random.randint(-3, 3)})

    return notes


def _gen_strings(chords_per_bar: List[str], num_bars: int, beat_dur: float) -> List[Dict]:
    """Generate sustained string/pad notes following chord progression."""
    notes = []
    octave = 4
    for bar in range(num_bars):
        chord_str = chords_per_bar[bar % len(chords_per_bar)]
        root, intervals = _parse_chord(chord_str)
        pitches = _chord_pitches(root, intervals, octave)
        bar_start = bar * 4 * beat_dur
        for p in pitches:
            notes.append({"pitch": p, "start": bar_start, "end": bar_start + 4 * beat_dur * 0.98, "velocity": 55 + random.randint(-3, 3)})
    return notes


def _gen_melody(chords_per_bar: List[str], num_bars: int, beat_dur: float,
                root: int, scale_type: str, density: str) -> List[Dict]:
    """Generate a simple melody using scale degrees and chord tones."""
    notes = []
    scale = _get_scale_degrees(root, scale_type, octave=5)
    if not scale:
        return notes

    pos = len(scale) // 2
    sixteenth = beat_dur / 4

    notes_per_bar = {"sparse": 4, "medium": 6, "dense": 8}.get(density, 6)

    for bar in range(num_bars):
        chord_str = chords_per_bar[bar % len(chords_per_bar)]
        chord_root, chord_intervals = _parse_chord(chord_str)
        chord_tones = set((chord_root + i) % 12 for i in chord_intervals)
        bar_start = bar * 4 * beat_dur

        # Generate rhythmic positions for this bar
        positions = sorted(random.sample(range(16), min(notes_per_bar, 16)))

        for i, slot in enumerate(positions):
            t = bar_start + slot * sixteenth

            # On strong beats (0, 4, 8, 12), prefer chord tones
            if slot % 4 == 0:
                candidates = [p for p in scale if p % 12 in chord_tones]
                if candidates:
                    closest = min(candidates, key=lambda p: abs(p - scale[pos]))
                    pos = scale.index(closest) if closest in scale else pos
            else:
                # Step motion: move up or down by 1-2 scale degrees
                step = random.choice([-2, -1, -1, 1, 1, 2])
                pos = max(0, min(len(scale) - 1, pos + step))

            pitch = scale[pos]
            dur = sixteenth * random.choice([2, 3, 4])
            vel = 80 if slot % 4 == 0 else 65
            notes.append({
                "pitch": pitch,
                "start": t,
                "end": min(t + dur, bar_start + 4 * beat_dur),
                "velocity": vel + random.randint(-5, 5),
            })

    return notes


def _gen_guitar(chords_per_bar: List[str], num_bars: int, beat_dur: float, style: str) -> List[Dict]:
    """Generate guitar notes — strum or arpeggiated."""
    notes = []
    octave = 3

    for bar in range(num_bars):
        chord_str = chords_per_bar[bar % len(chords_per_bar)]
        root, intervals = _parse_chord(chord_str)
        pitches = _chord_pitches(root, intervals, octave) + _chord_pitches(root, intervals, octave + 1)[:2]
        bar_start = bar * 4 * beat_dur

        if style == "strummed":
            for beat in range(4):
                t = bar_start + beat * beat_dur
                for j, p in enumerate(pitches):
                    notes.append({
                        "pitch": p,
                        "start": t + j * 0.01,
                        "end": t + beat_dur * 0.85,
                        "velocity": (85 if beat == 0 else 70) + random.randint(-5, 5),
                    })
        else:
            step = beat_dur / 2
            pattern = list(range(len(pitches))) + list(range(len(pitches) - 2, 0, -1))
            for i in range(8):
                idx = pattern[i % len(pattern)]
                t = bar_start + i * step
                notes.append({
                    "pitch": pitches[idx % len(pitches)],
                    "start": t,
                    "end": t + step * 0.8,
                    "velocity": 70 + random.randint(-5, 5),
                })

    return notes


def _gen_synth(chords_per_bar: List[str], num_bars: int, beat_dur: float,
               root: int, scale_type: str) -> List[Dict]:
    """Generate synth lead — arpeggiated chord tones."""
    notes = []
    sixteenth = beat_dur / 4

    for bar in range(num_bars):
        chord_str = chords_per_bar[bar % len(chords_per_bar)]
        chord_root, intervals = _parse_chord(chord_str)
        pitches = _chord_pitches(chord_root, intervals, 5)
        bar_start = bar * 4 * beat_dur

        arp = pitches + [p + 12 for p in pitches[:1]]
        for i in range(16):
            p = arp[i % len(arp)]
            t = bar_start + i * sixteenth
            notes.append({
                "pitch": p,
                "start": t,
                "end": t + sixteenth * 0.7,
                "velocity": 70 + random.randint(-5, 8),
            })

    return notes


# ─── OpenAI helpers ─────────────────────────────────────────────────────────────

def _get_openai_client():
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    from openai import OpenAI
    return OpenAI(api_key=api_key)


def _get_composition_plan(prompt: str, genre: str = "") -> Dict:
    """Ask GPT-4o-mini for a small composition plan — chords, patterns, structure."""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return _default_plan(genre)

    from openai import OpenAI
    client = OpenAI(api_key=api_key)

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a music producer. Given a description, output a composition plan as JSON.\n"
                    "Return ONLY valid JSON with these exact fields:\n"
                    "{\n"
                    '  "tempo": <int 60-200>,\n'
                    '  "key": "<root note, e.g. C, Am, F#m, Bb>",\n'
                    '  "time_signature": "4/4",\n'
                    '  "bars": <int 4-16>,\n'
                    '  "chord_progression": ["Am", "F", "C", "G"],\n'
                    '  "drum_pattern": "<one of: four-on-floor, trap, rock, lo-fi, jazz, edm, house>",\n'
                    '  "bass_style": "<one of: whole-note, half-note, eighth-note, syncopated, octave>",\n'
                    '  "piano_style": "<one of: block, arpeggiated, stabs, sustained>",\n'
                    '  "instruments": ["drums", "bass", "piano"],\n'
                    '  "density": "<sparse|medium|dense>",\n'
                    '  "mood": "<one or two words>"\n'
                    "}\n\n"
                    "CHORD RULES:\n"
                    "- Use standard chord symbols: C, Am, F#m, Bb, Dm7, G7, etc.\n"
                    "- Progression should be 4-8 chords that repeat across the bars\n"
                    "- Use genre-appropriate progressions (e.g., i-iv-VII-III for lo-fi, I-V-vi-IV for pop)\n"
                    "- Instruments can include: drums, bass, piano, guitar, strings, synth, melody\n"
                    "- Choose patterns that fit the genre and mood\n"
                    "Output ONLY the JSON."
                ),
            },
            {
                "role": "user",
                "content": f"Genre: {genre}\nDescription: {prompt}" if genre else prompt,
            },
        ],
        max_tokens=400,
        temperature=0.7,
    )

    text = resp.choices[0].message.content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        plan = json.loads(text)
    except json.JSONDecodeError:
        print(f"[midi-gen] GPT plan parse failed, using defaults: {text[:200]}")
        plan = _default_plan(genre)

    return plan


def _default_plan(genre: str = "") -> Dict:
    plans = {
        "pop": {
            "tempo": 120, "key": "C", "bars": 8,
            "chord_progression": ["C", "G", "Am", "F"],
            "drum_pattern": "four-on-floor", "bass_style": "eighth-note",
            "piano_style": "block", "instruments": ["drums", "bass", "piano"],
            "density": "medium", "mood": "upbeat",
        },
        "trap": {
            "tempo": 140, "key": "Fm", "bars": 8,
            "chord_progression": ["Fm", "Db", "Ab", "Eb"],
            "drum_pattern": "trap", "bass_style": "syncopated",
            "piano_style": "stabs", "instruments": ["drums", "bass", "piano", "synth"],
            "density": "medium", "mood": "dark",
        },
        "edm": {
            "tempo": 128, "key": "Am", "bars": 8,
            "chord_progression": ["Am", "F", "C", "G"],
            "drum_pattern": "edm", "bass_style": "eighth-note",
            "piano_style": "arpeggiated", "instruments": ["drums", "bass", "synth"],
            "density": "dense", "mood": "energetic",
        },
        "lo-fi": {
            "tempo": 85, "key": "Cm", "bars": 8,
            "chord_progression": ["Cm", "Ab", "Eb", "Bb"],
            "drum_pattern": "lo-fi", "bass_style": "half-note",
            "piano_style": "arpeggiated", "instruments": ["drums", "bass", "piano"],
            "density": "sparse", "mood": "chill",
        },
        "house": {
            "tempo": 124, "key": "Gm", "bars": 8,
            "chord_progression": ["Gm", "Cm", "Eb", "D"],
            "drum_pattern": "house", "bass_style": "eighth-note",
            "piano_style": "stabs", "instruments": ["drums", "bass", "piano"],
            "density": "medium", "mood": "groovy",
        },
        "jazz": {
            "tempo": 110, "key": "Dm", "bars": 8,
            "chord_progression": ["Dm7", "G7", "Cmaj7", "Am7"],
            "drum_pattern": "jazz", "bass_style": "half-note",
            "piano_style": "block", "instruments": ["drums", "bass", "piano"],
            "density": "medium", "mood": "smooth",
        },
        "rock": {
            "tempo": 130, "key": "Em", "bars": 8,
            "chord_progression": ["Em", "C", "G", "D"],
            "drum_pattern": "rock", "bass_style": "eighth-note",
            "piano_style": "block", "instruments": ["drums", "bass", "guitar"],
            "density": "dense", "mood": "powerful",
        },
        "synthwave": {
            "tempo": 118, "key": "Am", "bars": 8,
            "chord_progression": ["Am", "F", "C", "Em"],
            "drum_pattern": "edm", "bass_style": "octave",
            "piano_style": "arpeggiated", "instruments": ["drums", "bass", "synth", "pad"],
            "density": "medium", "mood": "nostalgic",
        },
        "ambient": {
            "tempo": 70, "key": "Cm", "bars": 8,
            "chord_progression": ["Cm", "Ab", "Fm", "G"],
            "drum_pattern": "lo-fi", "bass_style": "whole-note",
            "piano_style": "sustained", "instruments": ["piano", "strings"],
            "density": "sparse", "mood": "ethereal",
        },
    }
    return plans.get(genre, plans["pop"]).copy()


# ─── Main composition pipeline ─────────────────────────────────────────────────

def _build_midi_from_plan(plan: Dict, resolution: int = 480,
                          melody_notes: Optional[List[Dict]] = None) -> pretty_midi.PrettyMIDI:
    """Convert a composition plan into a PrettyMIDI object."""
    tempo = plan.get("tempo", 120)
    key = plan.get("key", "Am")
    bars = plan.get("bars", 8)
    chords = plan.get("chord_progression", ["Am", "F", "C", "G"])
    instruments = plan.get("instruments", ["drums", "bass", "piano"])
    density = plan.get("density", "medium")
    drum_pattern = plan.get("drum_pattern", "four-on-floor")
    bass_style = plan.get("bass_style", "eighth-note")
    piano_style = plan.get("piano_style", "block")
    time_sig = plan.get("time_signature", "4/4")

    root_midi, scale_type = _parse_key(key)
    beat_dur = 60.0 / tempo

    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=resolution)

    ts_parts = time_sig.split('/')
    numerator = int(ts_parts[0]) if len(ts_parts) == 2 else 4
    denominator = int(ts_parts[1]) if len(ts_parts) == 2 else 4
    pm.time_signature_changes.append(pretty_midi.TimeSignature(numerator, denominator, 0.0))

    # Expand chord progression to per-bar
    chords_per_bar = []
    for i in range(bars):
        chords_per_bar.append(chords[i % len(chords)])

    print(f"[midi-gen] Building: {bars} bars, {tempo} BPM, key={key}, chords={chords}, instruments={instruments}")

    # Generate each instrument
    for inst_name in instruments:
        if inst_name == "drums":
            notes = _gen_drums(drum_pattern, bars, beat_dur)
            inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
        elif inst_name == "bass":
            notes = _gen_bass(chords_per_bar, bars, beat_dur, bass_style)
            inst = pretty_midi.Instrument(program=GM_PROGRAMS["bass"], is_drum=False, name="Bass")
        elif inst_name == "piano":
            notes = _gen_piano(chords_per_bar, bars, beat_dur, piano_style)
            inst = pretty_midi.Instrument(program=GM_PROGRAMS["piano"], is_drum=False, name="Piano")
        elif inst_name == "guitar":
            gstyle = "strummed" if density == "dense" else "arpeggiated"
            notes = _gen_guitar(chords_per_bar, bars, beat_dur, gstyle)
            inst = pretty_midi.Instrument(program=GM_PROGRAMS["guitar"], is_drum=False, name="Guitar")
        elif inst_name in ("strings", "pad"):
            notes = _gen_strings(chords_per_bar, bars, beat_dur)
            prog = GM_PROGRAMS.get(inst_name, GM_PROGRAMS["strings"])
            inst = pretty_midi.Instrument(program=prog, is_drum=False, name=inst_name.capitalize())
        elif inst_name == "synth":
            notes = _gen_synth(chords_per_bar, bars, beat_dur, root_midi, scale_type)
            inst = pretty_midi.Instrument(program=GM_PROGRAMS["synth"], is_drum=False, name="Synth")
        elif inst_name == "melody":
            if melody_notes:
                continue
            notes = _gen_melody(chords_per_bar, bars, beat_dur, root_midi, scale_type, density)
            inst = pretty_midi.Instrument(program=73, is_drum=False, name="Melody")
        else:
            continue

        for n in notes:
            pitch = max(0, min(127, int(n["pitch"])))
            velocity = max(1, min(127, int(n["velocity"])))
            start = max(0.0, float(n["start"]))
            end = float(n["end"])
            if end <= start:
                end = start + beat_dur / 4
            inst.notes.append(pretty_midi.Note(velocity=velocity, pitch=pitch, start=start, end=end))

        if inst.notes:
            pm.instruments.append(inst)

    # Add provided melody if present
    if melody_notes:
        valid_pitches = _get_scale_pitches_set(root_midi, scale_type)
        melody_inst = pretty_midi.Instrument(program=73, is_drum=False, name="Melody")
        for n in melody_notes:
            pitch = _snap_to_scale(int(n["pitch"]), valid_pitches)
            melody_inst.notes.append(pretty_midi.Note(
                velocity=int(n.get("velocity", 80)),
                pitch=pitch,
                start=float(n["start"]),
                end=float(n["end"]),
            ))
        if melody_inst.notes:
            pm.instruments.insert(0, melody_inst)

    return pm


def generate_midi(
    prompt: str,
    genre: str = "",
    job_dir: str = "/tmp",
    melody_midi_path: Optional[str] = None,
    resolution: int = 480,
) -> str:
    """Generate a multi-track MIDI file: GPT plans, code composes."""
    job_path = Path(job_dir)
    job_path.mkdir(parents=True, exist_ok=True)

    print(f"[midi-gen] Getting composition plan for: {prompt[:80]}...")
    plan = _get_composition_plan(prompt, genre)
    print(f"[midi-gen] Plan: {json.dumps(plan, indent=2)}")

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

    pm = _build_midi_from_plan(plan, resolution=resolution, melody_notes=melody_notes)

    output_path = job_path / "workshop_output.mid"
    pm.write(str(output_path))
    print(f"[midi-gen] Saved MIDI to {output_path} ({len(pm.instruments)} tracks, {pm.get_end_time():.1f}s)")

    return str(output_path)


# ─── Reference audio → MIDI (unchanged) ────────────────────────────────────────

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

    REF_PROGRAMS = {
        "vocals": 52, "bass": 33, "other": 0, "guitar": 25, "piano": 0,
    }

    for stem_name, midi_path in stem_midis.items():
        try:
            pm = pretty_midi.PrettyMIDI(midi_path)
            for inst in pm.instruments:
                new_inst = pretty_midi.Instrument(
                    program=REF_PROGRAMS.get(stem_name, 0),
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
