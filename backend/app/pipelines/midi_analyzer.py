"""Parse a MIDI file and return structured track data as JSON-serializable dicts."""

import pretty_midi
from typing import List, Dict, Any


def analyze_midi(midi_path: str) -> Dict[str, Any]:
    """
    Parse a MIDI file and return structured data for the frontend.

    Returns:
    {
        "tempo": 128,
        "duration": 32.5,
        "time_signature": "4/4",
        "key": "Am",
        "tracks": [
            {
                "name": "Melody",
                "program": 0,
                "channel": 0,
                "is_drum": false,
                "note_count": 64,
                "notes": [
                    {"pitch": 60, "start": 0.0, "end": 0.5, "velocity": 80},
                    ...
                ]
            }
        ]
    }
    """
    pm = pretty_midi.PrettyMIDI(midi_path)

    # Tempo
    tempos = pm.get_tempo_changes()
    tempo = int(round(float(tempos[1][0]))) if len(tempos[1]) > 0 else 120

    # Time signature
    ts = pm.time_signature_changes
    time_sig = f"{ts[0].numerator}/{ts[0].denominator}" if ts else "4/4"

    # Key estimation
    try:
        key_est = pm.estimate_key()
    except Exception:
        key_est = "Unknown"

    # Duration
    duration = pm.get_end_time()

    # Tracks
    tracks = []
    for instrument in pm.instruments:
        if len(instrument.notes) == 0:
            continue

        notes = [
            {
                "pitch": int(note.pitch),
                "start": round(float(note.start), 4),
                "end": round(float(note.end), 4),
                "velocity": int(note.velocity),
            }
            for note in sorted(instrument.notes, key=lambda n: n.start)
        ]

        tracks.append({
            "name": instrument.name or f"Track {len(tracks) + 1}",
            "program": int(instrument.program),
            "channel": 9 if instrument.is_drum else len(tracks),
            "is_drum": bool(instrument.is_drum),
            "note_count": len(notes),
            "notes": notes,
        })

    return {
        "tempo": tempo,
        "duration": round(duration, 2),
        "time_signature": time_sig,
        "key": key_est,
        "tracks": tracks,
    }
