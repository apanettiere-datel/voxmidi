"""Post-process generated MIDI for quality and DAW compatibility."""

import pretty_midi
from pathlib import Path
from typing import Optional


# General MIDI program numbers for common instruments
GM_PROGRAMS = {
    "melody": 0,     # Acoustic Grand Piano
    "bass": 33,      # Electric Bass (finger)
    "chords": 4,     # Electric Piano 1
    "pad": 89,       # Pad 2 (warm)
    "lead": 80,      # Lead 1 (square)
    "strings": 48,   # String Ensemble 1
    "synth": 81,     # Lead 2 (sawtooth)
}

# Track name → GM channel mapping
CHANNEL_MAP = {
    "drums": 9,  # Channel 10 (0-indexed = 9)
}


def post_process_midi(
    input_path: str,
    output_path: str,
    tempo: int = 128,
    key: Optional[str] = None,
    quantize_strength: float = 0.8,
    min_note_duration: float = 0.02,  # 20ms minimum
    velocity_range: tuple = (40, 120),
) -> str:
    """
    Post-process a MIDI file for quality and DAW compatibility.

    Steps:
    1. Set tempo and time signature
    2. Remove artifact notes (too short, zero-velocity)
    3. Remove overlapping notes on same pitch
    4. Quantize to grid
    5. Normalize velocities
    6. Assign GM programs and track names
    7. Write clean Type 1 MIDI at 480 ticks/quarter

    Returns path to the processed file.
    """
    pm = pretty_midi.PrettyMIDI(input_path)

    # Create new PrettyMIDI with correct tempo and resolution
    output = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)

    # Calculate grid size for quantization
    beat_duration = 60.0 / tempo
    grid_size = beat_duration / 4  # 16th note grid

    for i, instrument in enumerate(pm.instruments):
        # Create new instrument with proper GM settings
        is_drum = instrument.is_drum
        program = instrument.program if instrument.program > 0 else GM_PROGRAMS.get("melody", 0)
        channel = 9 if is_drum else min(i, 8) if i < 9 else i + 1

        new_instrument = pretty_midi.Instrument(
            program=program,
            is_drum=is_drum,
            name=instrument.name or f"Track {i + 1}",
        )

        # Process notes
        processed_notes = []
        for note in instrument.notes:
            # Skip artifacts
            duration = note.end - note.start
            if duration < min_note_duration:
                continue
            if note.velocity == 0:
                continue

            # Quantize onset and duration
            if quantize_strength > 0:
                quantized_start = round(note.start / grid_size) * grid_size
                note.start = note.start + (quantized_start - note.start) * quantize_strength

                quantized_end = round(note.end / grid_size) * grid_size
                note.end = note.end + (quantized_end - note.end) * quantize_strength

                # Ensure minimum duration after quantization
                if note.end - note.start < min_note_duration:
                    note.end = note.start + grid_size

            # Normalize velocity
            note.velocity = max(velocity_range[0], min(velocity_range[1], note.velocity))

            processed_notes.append(note)

        # Remove overlapping notes on same pitch
        processed_notes.sort(key=lambda n: (n.pitch, n.start))
        deoverlapped = []
        for note in processed_notes:
            if deoverlapped and note.pitch == deoverlapped[-1].pitch:
                prev = deoverlapped[-1]
                if note.start < prev.end:
                    prev.end = note.start  # Truncate previous note
                    if prev.end - prev.start < min_note_duration:
                        deoverlapped.pop()
            deoverlapped.append(note)

        new_instrument.notes = deoverlapped
        output.instruments.append(new_instrument)

    # Write output
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    output.write(output_path)

    return output_path
