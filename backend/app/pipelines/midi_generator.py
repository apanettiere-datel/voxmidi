"""MIDI generation — MiniMax-only routing.

Route 1: Text only, no lyrics → MiniMax instrumental
Route 2: Text + lyrics → MiniMax vocal
Route 3: Voice/hum, no lyrics → Basic Pitch → MiniMax instrumental
Route 4: Voice/hum + lyrics → Basic Pitch melody → MiniMax vocal
Route 5: Piano/chords, no lyrics → chord MIDI → MiniMax instrumental
Route 6: Piano/chords + lyrics → chord MIDI → MiniMax vocal
Route 7: Uploaded reference file → librosa analysis → MiniMax instrumental/vocal
Mock: no API key → deterministic MIDI generator

Returns: Tuple[midi_path, vocal_audio_path, generated_audio_path]
  Stem separation is handled separately by the caller (two-phase pipeline).
"""

import os
import time
import pretty_midi
import numpy as np
from pathlib import Path
from typing import Optional, Tuple, Dict, List

KEY_ROOTS = {
    'C': 60, 'Cm': 60, 'C#': 61, 'C#m': 61,
    'D': 62, 'Dm': 62, 'Eb': 63, 'Ebm': 63,
    'E': 64, 'Em': 64, 'F': 65, 'Fm': 65,
    'F#': 66, 'F#m': 66, 'G': 67, 'Gm': 67,
    'Ab': 68, 'Abm': 68, 'A': 69, 'Am': 69,
    'Bb': 70, 'Bbm': 70, 'B': 71, 'Bm': 71,
}
MINOR_KEYS = {'Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','Abm','Am','Bbm','Bm'}


# ─── Music theory helpers ─────────────────────────────────────────────────────

def _is_minor(key: str) -> bool:
    return key in MINOR_KEYS or key.endswith('m')

def _scale(root: int, minor: bool) -> list:
    intervals = [0,2,3,5,7,8,10] if minor else [0,2,4,5,7,9,11]
    return [root + i for i in intervals]

def _pentatonic(root: int, minor: bool) -> list:
    intervals = [0,3,5,7,10] if minor else [0,2,4,7,9]
    return [root + i for i in intervals]

def _chord_roots(root: int, minor: bool) -> list:
    if minor:
        return [root, root-3, root+3, root-2]
    else:
        return [root, root+7, root-3, root+5]

def _chord_notes(chord_root: int, minor: bool) -> list:
    triad = [0,3,7] if minor else [0,4,7]
    return [chord_root + i for i in triad]


def _minimax_api_call(
    style_desc: str,
    lyrics: str,
    job_dir: Path,
    out_filename: str = "minimax_audio.mp3",
    voice_audio_path: Optional[str] = None,
) -> str:
    """Call MiniMax music API, save to out_filename, return path. Retries once on failure."""
    import httpx
    import binascii
    import json as _json

    api_key = os.environ.get('MINIMAX_API_KEY', '')
    if not api_key:
        raise RuntimeError("MINIMAX_API_KEY not set")

    use_cover = bool(voice_audio_path and Path(voice_audio_path).exists())
    model = "music-cover" if use_cover else "music-2.6"

    payload: dict = {
        "model": model,
        "prompt": style_desc,
        "audio_setting": {
            "sample_rate": 44100,
            "bitrate": 256000,
            "format": "mp3",
        },
    }

    if use_cover:
        import base64
        audio_bytes = Path(voice_audio_path).read_bytes()
        payload["audio_base64"] = base64.b64encode(audio_bytes).decode("utf-8")
        print(f"[midi_generator] Voice reference: {len(audio_bytes)} bytes from {Path(voice_audio_path).name}")

    if lyrics and lyrics.strip():
        payload["lyrics"] = lyrics.strip()
    else:
        payload["is_instrumental"] = True

    mode_label = 'cover' if use_cover else ('vocal' if lyrics and lyrics.strip() else 'instrumental')
    print(f"[midi_generator] MiniMax {model}: generating {mode_label}...")
    log_payload = {k: (v[:80] + '...' if isinstance(v, str) and len(v) > 80 else v) for k, v in payload.items()}
    print(f"[midi_generator] MiniMax request: {_json.dumps(log_payload)}")

    def _attempt() -> str:
        resp = httpx.post(
            "https://api.minimax.io/v1/music_generation",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=180.0,
        )
        resp.raise_for_status()
        resp_json = resp.json()
        audio_hex = resp_json.get("data", {}).get("audio", "") if resp_json else ""
        if not audio_hex:
            raise RuntimeError(f"MiniMax returned no audio data: {resp_json}")
        audio_bytes = binascii.unhexlify(audio_hex)
        audio_file = job_dir / out_filename
        audio_file.write_bytes(audio_bytes)
        print(f"[midi_generator] MiniMax: saved {len(audio_bytes)} bytes → {out_filename}")
        return str(audio_file)

    try:
        return _attempt()
    except Exception as e:
        print(f"[midi_generator] MiniMax attempt 1 failed: {e} — retrying in 10s")
        time.sleep(10)
        return _attempt()


# ─── Melody extraction (Basic Pitch) ─────────────────────────────────────────

NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def _extract_melody_from_hum(audio_path: str, job_dir: Path) -> Tuple[Optional[str], str]:
    """
    Run Basic Pitch on hummed audio to extract melody notes.
    Returns (hum_midi_path, description_string).
    """
    from pipelines.transcriber import transcribe_audio
    try:
        hum_midi_path = transcribe_audio(audio_path, str(job_dir), output_name="hum_melody.mid")
        pm = pretty_midi.PrettyMIDI(hum_midi_path)
        notes = []
        for inst in pm.instruments:
            notes.extend(inst.notes)
        if not notes:
            return hum_midi_path, ""

        notes.sort(key=lambda n: n.start)
        pitches = [n.pitch for n in notes[:24]]

        # Detect root by most common pitch class
        pitch_classes = [p % 12 for p in pitches]
        most_common_pc = max(set(pitch_classes), key=pitch_classes.count)
        root_name = NOTE_NAMES_SHARP[most_common_pc]

        # Minor/major heuristic
        minor_intervals = {3, 7, 10}
        intervals_from_root = {(p - most_common_pc) % 12 for p in pitch_classes}
        is_minor = bool(intervals_from_root & minor_intervals)
        key_desc = f"{root_name}{'m' if is_minor else ''}"

        # Range
        min_p, max_p = min(pitches), max(pitches)
        range_desc = (
            f"{NOTE_NAMES_SHARP[min_p % 12]}{min_p // 12 - 1}"
            f"-{NOTE_NAMES_SHARP[max_p % 12]}{max_p // 12 - 1}"
        )

        # Sample note names
        note_sample = ' '.join(f"{NOTE_NAMES_SHARP[p % 12]}{p // 12 - 1}" for p in pitches[:8])

        desc = f"melody in {key_desc}, note range {range_desc}, melody notes: {note_sample}"
        return hum_midi_path, desc
    except Exception as e:
        print(f"[midi_generator] _extract_melody_from_hum failed: {e}")
        return None, ""


# ─── Reference audio analysis (librosa) ──────────────────────────────────────

def _analyze_reference_audio(audio_path: str) -> Tuple[float, str, str]:
    """
    Detect tempo, key, and energy from reference audio using librosa.
    Returns (detected_tempo, detected_key, style_description).
    """
    try:
        import librosa

        y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=60)

        # Tempo
        tempo_val, _ = librosa.beat.beat_track(y=y, sr=sr)
        tempo_f = float(tempo_val)
        if tempo_f < 60:
            tempo_f *= 2
        if tempo_f > 220:
            tempo_f /= 2

        # Key from chroma
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        root_idx = int(np.argmax(chroma_mean))
        root_name = NOTE_NAMES_SHARP[root_idx]

        major_template = np.array([1,0,1,0,1,1,0,1,0,1,0,1], dtype=float)
        minor_template = np.array([1,0,1,1,0,1,0,1,1,0,1,0], dtype=float)
        major_score = float(np.dot(np.roll(major_template, root_idx), chroma_mean))
        minor_score = float(np.dot(np.roll(minor_template, root_idx), chroma_mean))
        mode_suffix = 'm' if minor_score > major_score else ''
        key_str = f"{root_name}{mode_suffix}"

        style_desc = f"inspired by the provided reference audio, approximately {int(tempo_f)} BPM in {key_str}"
        return round(tempo_f, 1), key_str, style_desc
    except Exception as e:
        print(f"[midi_generator] _analyze_reference_audio failed: {e}")
        return 120.0, 'Am', "inspired by the provided reference audio"


# ─── Public API ───────────────────────────────────────────────────────────────

def generate_from_prompt(
    prompt: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    lyrics: str = '',
    audio_path: Optional[str] = None,
    chord_progression: Optional[list] = None,
    piano_melody_path: Optional[str] = None,
    mode: str = 'text',
    **kwargs,
) -> Tuple[str, Optional[str], Optional[str]]:
    """
    Combined pipeline — all inputs are used together.
    - hum/voice → Basic Pitch → MIDI melody track
    - piano recording → Basic Pitch → MIDI melody track (overrides hum)
    - chord progression → MIDI chord/bass tracks
    - reference audio → librosa analysis → style context for MiniMax
    - lyrics → MiniMax vocal mode; no lyrics → MiniMax instrumental
    - prompt → MiniMax style description (raw or pre-built by caller)

    Returns (midi_path, vocal_audio_path, generated_audio_path).
    Stem separation is handled on-demand by the caller.
    """
    has_minimax = bool(os.environ.get('MINIMAX_API_KEY'))
    provider = os.environ.get('MIDI_GEN_PROVIDER', 'auto')
    use_api = provider == 'api' or (provider == 'auto' and has_minimax)

    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    has_lyrics = bool(lyrics and lyrics.strip())
    has_voice = bool(audio_path and Path(audio_path).exists() and mode in ('voice', 'hum', 'recording'))
    has_reference = bool(audio_path and Path(audio_path).exists() and mode == 'source')
    has_piano = bool(piano_melody_path and Path(piano_melody_path).exists())
    has_chords = bool(chord_progression and len(chord_progression) > 0)

    log_parts = []
    if has_voice: log_parts.append('voice')
    if has_piano: log_parts.append('piano')
    if has_chords: log_parts.append(f'chords={len(chord_progression)}')
    if has_reference: log_parts.append('reference')
    if has_lyrics: log_parts.append('lyrics')
    print(f"[midi_generator] inputs: {', '.join(log_parts) or 'text-only'} lyrics={'yes' if has_lyrics else 'no'}")

    # ── MOCK MODE ────────────────────────────────────────────────────────────
    if not use_api or provider == 'mock':
        pm = mock_generate(genre=genre, tempo=tempo, key=key, chord_progression=chord_progression)
        pm.write(output_path)
        return output_path, None, None

    # ── Step 1: Extract melody MIDI from any audio source ───────────────────
    melody_midi_path: Optional[str] = None
    melody_desc = ""

    if has_piano:
        # Piano recording takes priority over voice hum
        print("[midi_generator] Extracting melody from piano recording via Basic Pitch")
        melody_midi_path, melody_desc = _extract_melody_from_hum(piano_melody_path, job_dir)
        melody_desc = melody_desc.replace("hummed melody", "piano melody") if melody_desc else ""
    elif has_voice:
        print("[midi_generator] Extracting melody from voice/hum via Basic Pitch")
        melody_midi_path, melody_desc = _extract_melody_from_hum(audio_path, job_dir)

    # ── Step 2: Analyze reference audio if provided ──────────────────────────
    ref_desc = ""
    ref_tempo = tempo
    ref_key = key
    if has_reference:
        print("[midi_generator] Analyzing reference audio via librosa")
        ref_tempo_f, ref_key, ref_desc = _analyze_reference_audio(audio_path)
        ref_tempo = int(ref_tempo_f) if ref_tempo_f else tempo

    # ── Step 3: Build MIDI combining melody + chords ─────────────────────────
    midi_tempo = ref_tempo if has_reference else tempo
    midi_key = ref_key if has_reference else key

    pm = mock_generate(genre=genre, tempo=midi_tempo, key=midi_key, chord_progression=chord_progression)

    if melody_midi_path and Path(melody_midi_path).exists():
        try:
            hum_pm = pretty_midi.PrettyMIDI(melody_midi_path)
            if hum_pm.instruments:
                melody_idx = next(
                    (i for i, inst in enumerate(pm.instruments) if inst.name == 'Melody'), None
                )
                hum_inst = hum_pm.instruments[0]
                hum_inst.name = 'Melody'
                hum_inst.program = 0
                if melody_idx is not None:
                    pm.instruments[melody_idx] = hum_inst
                else:
                    pm.instruments.append(hum_inst)
                print("[midi_generator] Merged extracted melody into MIDI")
        except Exception as e:
            print(f"[midi_generator] Could not merge melody: {e}")

    pm.write(output_path)

    # ── Step 4: Build MiniMax style description from all context ─────────────
    desc_parts = []
    if prompt.strip():
        desc_parts.append(prompt.strip())
    if melody_desc:
        desc_parts.append(f"Based on {melody_desc}")
    if has_chords and chord_progression:
        desc_parts.append(f"Chord progression: {' - '.join(str(c) for c in chord_progression[:8])}")
    if ref_desc:
        desc_parts.append(ref_desc)

    style_desc = ". ".join(desc_parts) if desc_parts else "An instrumental composition"
    effective_lyrics = lyrics if has_lyrics else ""

    # ── Step 5: Call MiniMax ─────────────────────────────────────────────────
    try:
        voice_path = kwargs.get("voice_audio_path")
        route = "cover" if voice_path else ("vocal" if has_lyrics else ("voice+instrumental" if has_voice else "text-only"))
        model_name = "music-cover" if voice_path else "music-2.6"
        print(f"[midi_generator] Route: {route} - using {model_name}")
        audio_out = _minimax_api_call(style_desc, lyrics=effective_lyrics, job_dir=job_dir, voice_audio_path=voice_path)
    except Exception as e:
        print(f"[midi_generator] MiniMax failed: {e}")
        raise

    return output_path, None, audio_out


# ─── Mock generator (genre-aware, clean MIDI) ────────────────────────────────

CHORD_NAME_TO_SEMITONES = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3,
    'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8,
    'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11,
}


def _parse_chord_name(name: str) -> int:
    import re
    m = re.match(r'^([A-G][b#]?)', name)
    if not m:
        return 60
    return 48 + CHORD_NAME_TO_SEMITONES.get(m.group(1), 0)


def mock_generate(
    genre: str,
    tempo: int,
    key: str,
    num_bars: int = 32,
    chord_progression: Optional[list] = None,
) -> pretty_midi.PrettyMIDI:
    g = genre.lower().replace(' ', '-').replace('_', '-')
    minor = _is_minor(key)
    root = KEY_ROOTS.get(key, 69)
    beat = 60.0 / tempo
    bar = beat * 4
    pent = _pentatonic(root, minor)
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)

    if chord_progression and len(chord_progression) > 0:
        raw_roots = [_parse_chord_name(c) for c in chord_progression]
        progression = [raw_roots[i % len(raw_roots)] for i in range(num_bars)]
        minor = any(c.endswith('m') and not c.endswith('maj') for c in chord_progression) or minor
    else:
        base_prog = _chord_roots(root, minor)
        progression = [base_prog[i % 4] for i in range(num_bars)]

    if g in ('edm', 'house', 'techno'):
        _edm_drums(pm, tempo, bar, beat, num_bars)
        _edm_bass(pm, bar, beat, num_bars, progression, minor)
        _edm_chords(pm, bar, beat, num_bars, progression, minor)
        _edm_melody(pm, bar, beat, num_bars, pent, root, minor)
    elif g == 'trap':
        _trap_drums(pm, tempo, bar, beat, num_bars)
        _trap_bass(pm, bar, beat, num_bars, progression)
        _trap_chords(pm, bar, beat, num_bars, progression, minor)
        _trap_melody(pm, bar, beat, num_bars, root, minor)
    elif g in ('lo-fi-hip-hop', 'lo-fi', 'lofi', 'hip-hop'):
        _lofi_drums(pm, tempo, bar, beat, num_bars)
        _lofi_bass(pm, bar, beat, num_bars, progression)
        _lofi_chords(pm, bar, beat, num_bars, progression, minor)
        _lofi_melody(pm, bar, beat, num_bars, pent, root, minor)
    elif g == 'synthwave':
        _synthwave_drums(pm, tempo, bar, beat, num_bars)
        _synthwave_bass(pm, bar, beat, num_bars, progression)
        _synthwave_chords(pm, bar, beat, num_bars, progression, minor)
        _synthwave_melody(pm, bar, beat, num_bars, pent, root, minor)
    elif g == 'jazz':
        _jazz_drums(pm, tempo, bar, beat, num_bars)
        _jazz_bass(pm, bar, beat, num_bars, progression)
        _jazz_chords(pm, bar, beat, num_bars, progression, minor)
        _jazz_melody(pm, bar, beat, num_bars, root, minor)
    elif g == 'ambient':
        _ambient_pads(pm, bar, beat, num_bars, progression, minor)
        _ambient_melody(pm, bar, beat, num_bars, pent, root)
    else:
        _generic_drums(pm, tempo, bar, beat, num_bars)
        _generic_bass(pm, bar, beat, num_bars, progression)
        _generic_chords(pm, bar, beat, num_bars, progression, minor)
        _generic_melody(pm, bar, beat, num_bars, pent, root, minor)

    return pm


# ─── EDM ─────────────────────────────────────────────────────────────────────

def _edm_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CLAP, CHAT, OHAT, CRASH = 36, 38, 39, 42, 46, 49
    for b in range(num_bars):
        t = b * bar
        if b == 0 or b == 8 or b == 16:
            inst.notes.append(pretty_midi.Note(100, CRASH, t, t + 0.1))
        for beat_i in range(4):
            bt = t + beat_i * beat
            if b >= 4:
                inst.notes.append(pretty_midi.Note(100, KICK, bt, bt + 0.08))
            if b >= 8 and beat_i in (1, 3):
                inst.notes.append(pretty_midi.Note(90, CLAP, bt, bt + 0.05))
            for e in range(2):
                hat_t = bt + e * beat * 0.5
                if b >= 4:
                    inst.notes.append(pretty_midi.Note(65 if e else 75, CHAT, hat_t, hat_t + 0.04))
            if b >= 12 and beat_i in (1, 3):
                oht = bt + beat * 0.5
                inst.notes.append(pretty_midi.Note(70, OHAT, oht, oht + 0.04))
    pm.instruments.append(inst)


def _edm_bass(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=38, name='Bass')
    for b in range(8, num_bars):
        chord_root = progression[b % len(progression)] - 24
        while chord_root < 28: chord_root += 12
        t = b * bar
        for beat_i in range(4):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(95, chord_root, bt, bt + beat * 0.35))
            inst.notes.append(pretty_midi.Note(75, chord_root + 12, bt + beat * 0.5, bt + beat * 0.75))
    pm.instruments.append(inst)


def _edm_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')
    for b in range(12, num_bars):
        cr = progression[b % len(progression)]
        notes = [(n % 12) + 60 for n in _chord_notes(cr, minor)]
        t = b * bar
        arp = notes * 2
        for i, pitch in enumerate(arp):
            nt = t + i * beat * 0.25
            if nt < t + bar:
                inst.notes.append(pretty_midi.Note(72, pitch, nt, nt + beat * 0.2))
    pm.instruments.append(inst)


def _edm_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=80, name='Melody')
    for b in range(16, num_bars):
        lpent = [(root + i) % 12 + 60 for i in ([0,3,5,7,10] if minor else [0,2,4,7,9])]
        t = b * bar
        for e in range(8):
            if np.random.random() < 0.6:
                nt = t + e * beat * 0.5
                dur = min(beat * np.random.choice([0.5, 0.5, 1.0]), bar - e * beat * 0.5 - 0.01)
                pitch = np.random.choice(lpent)
                while pitch < 64: pitch += 12
                while pitch > 88: pitch -= 12
                inst.notes.append(pretty_midi.Note(np.random.randint(75, 100), pitch, nt, nt + dur))
    pm.instruments.append(inst)


# ─── TRAP ─────────────────────────────────────────────────────────────────────

def _trap_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT, OHAT = 36, 38, 42, 46
    for b in range(num_bars):
        t = b * bar
        inst.notes.append(pretty_midi.Note(100, KICK, t, t + 0.08))
        if np.random.random() < 0.5:
            kt = t + beat * 2.5
            inst.notes.append(pretty_midi.Note(90, KICK, kt, kt + 0.08))
        st = t + beat * 2
        inst.notes.append(pretty_midi.Note(95, SNARE, st, st + 0.05))
        for s in range(16):
            ht = t + s * beat * 0.25
            vel = 40 + (s % 4) * 15
            if np.random.random() < 0.7:
                inst.notes.append(pretty_midi.Note(vel, CHAT, ht, ht + 0.03))
            if s % 4 == 3 and np.random.random() < 0.4:
                ht2 = ht + beat * 0.125
                inst.notes.append(pretty_midi.Note(55, CHAT, ht2, ht2 + 0.02))
        if np.random.random() < 0.3:
            ot = t + beat * 1.5
            inst.notes.append(pretty_midi.Note(70, OHAT, ot, ot + 0.05))
    pm.instruments.append(inst)


def _trap_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=38, name='Bass')
    for b in range(num_bars):
        root = progression[b % len(progression)] - 24
        while root < 24: root += 12
        t = b * bar
        inst.notes.append(pretty_midi.Note(95, root, t, t + bar * 0.9))
        if np.random.random() < 0.4:
            slide_t = t + bar * 0.5
            root2 = progression[(b + 1) % len(progression)] - 24
            while root2 < 24: root2 += 12
            inst.notes.append(pretty_midi.Note(85, root2, slide_t, t + bar * 0.95))
    pm.instruments.append(inst)


def _trap_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')
    for b in range(num_bars):
        cr = progression[b % len(progression)]
        notes = [(n % 12) + 60 for n in _chord_notes(cr, minor)]
        t = b * bar
        for p in notes:
            inst.notes.append(pretty_midi.Note(55, p, t, t + bar - 0.1))
    pm.instruments.append(inst)


def _trap_melody(pm, bar, beat, num_bars, root, minor):
    inst = pretty_midi.Instrument(program=0, name='Melody')
    scale = _scale(root, minor)
    for b in range(num_bars):
        t = b * bar
        if np.random.random() < 0.65:
            for _ in range(np.random.randint(2, 5)):
                st = t + np.random.random() * bar * 0.8
                pitch = np.random.choice(scale) % 12 + 60
                while pitch < 60: pitch += 12
                while pitch > 82: pitch -= 12
                dur = beat * np.random.choice([0.25, 0.5, 0.25])
                inst.notes.append(pretty_midi.Note(np.random.randint(55, 80), pitch, st, st + dur))
    pm.instruments.append(inst)


# ─── LO-FI HIP HOP ───────────────────────────────────────────────────────────

def _lofi_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT = 35, 38, 42
    swing = beat * 0.08
    for b in range(num_bars):
        t = b * bar
        inst.notes.append(pretty_midi.Note(90, KICK, t, t + 0.08))
        if np.random.random() < 0.4:
            inst.notes.append(pretty_midi.Note(80, KICK, t + beat * 1.5, t + beat * 1.58))
        inst.notes.append(pretty_midi.Note(85, SNARE, t + beat, t + beat + 0.06))
        inst.notes.append(pretty_midi.Note(80, SNARE, t + beat * 3, t + beat * 3 + 0.06))
        for e in range(8):
            ht = t + e * beat * 0.5 + (swing if e % 2 == 1 else 0)
            inst.notes.append(pretty_midi.Note(np.random.randint(45, 75), CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _lofi_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % len(progression)] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i in range(4):
            pitch = root if beat_i % 2 == 0 else root + 5
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(70, pitch, bt, bt + beat * 0.8))
    pm.instruments.append(inst)


def _lofi_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=4, name='Chords')
    for b in range(num_bars):
        cr = progression[b % len(progression)]
        chord = [cr, cr+3, cr+7, cr+10] if minor else [cr, cr+4, cr+7, cr+11]
        chord = [(p % 12) + 60 for p in chord]
        t = b * bar
        for beat_i in (1, 3):
            bt = t + beat_i * beat
            for p in chord:
                inst.notes.append(pretty_midi.Note(np.random.randint(55, 72), p, bt, bt + beat * 0.9))
    pm.instruments.append(inst)


def _lofi_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=4, name='Melody')
    for b in range(num_bars):
        t = b * bar
        for pos in sorted(np.random.uniform(0, bar * 0.85, np.random.randint(2, 5))):
            pitch = np.random.choice(pent) % 12 + 72
            while pitch > 84: pitch -= 12
            dur = beat * np.random.choice([0.5, 1.0, 1.5])
            inst.notes.append(pretty_midi.Note(np.random.randint(55, 75), pitch, t + pos, t + pos + dur))
    pm.instruments.append(inst)


# ─── SYNTHWAVE ────────────────────────────────────────────────────────────────

def _synthwave_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT, CRASH = 36, 38, 42, 49
    for b in range(num_bars):
        t = b * bar
        if b % 8 == 0:
            inst.notes.append(pretty_midi.Note(95, CRASH, t, t + 0.1))
        for beat_i in range(4):
            bt = t + beat_i * beat
            if beat_i in (0, 2): inst.notes.append(pretty_midi.Note(95, KICK, bt, bt + 0.08))
            if beat_i in (1, 3): inst.notes.append(pretty_midi.Note(88, SNARE, bt, bt + 0.06))
            for e in range(2):
                ht = bt + e * beat * 0.5
                inst.notes.append(pretty_midi.Note(60 if e else 70, CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _synthwave_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=38, name='Bass')
    for b in range(num_bars):
        root = progression[b % len(progression)] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i in range(4):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(88, root, bt, bt + beat * 0.45))
    pm.instruments.append(inst)


def _synthwave_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')
    for b in range(num_bars):
        if b % 2 == 0:
            cr = progression[b % len(progression)]
            for p in [(n % 12) + 60 for n in _chord_notes(cr, minor)]:
                inst.notes.append(pretty_midi.Note(65, p, b * bar, b * bar + bar * 2 - 0.05))
    pm.instruments.append(inst)


def _synthwave_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=80, name='Melody')
    for b in range(num_bars):
        t = b * bar
        pitches = [(root + i) % 12 + 72 for i in ([0,3,5,7,10] if minor else [0,2,4,7,9])]
        for i in range(4):
            if i < len(pitches):
                nt = t + i * beat * 0.5
                inst.notes.append(pretty_midi.Note(82, pitches[i], nt, nt + beat * 0.45))
        hold_t = t + beat * 2
        inst.notes.append(pretty_midi.Note(85, pitches[-1], hold_t, hold_t + beat * 2 - 0.05))
    pm.instruments.append(inst)


# ─── JAZZ ─────────────────────────────────────────────────────────────────────

def _jazz_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, RIDE = 36, 38, 51
    for b in range(num_bars):
        t = b * bar
        swing = beat * 0.1
        for triplet in range(6):
            rt = t + triplet * beat * (2/3)
            inst.notes.append(pretty_midi.Note(65 if triplet % 2 == 0 else 50, RIDE, rt, rt + 0.04))
        inst.notes.append(pretty_midi.Note(80, KICK, t, t + 0.06))
        for beat_i in range(4):
            if np.random.random() < 0.4:
                st = t + beat_i * beat + (swing if beat_i % 2 == 1 else 0)
                inst.notes.append(pretty_midi.Note(np.random.randint(35, 75), SNARE, st, st + 0.04))
    pm.instruments.append(inst)


def _jazz_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % len(progression)] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i, pitch in enumerate([root, root+2, root+4, root+7]):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(80, pitch, bt, bt + beat * 0.9))
    pm.instruments.append(inst)


def _jazz_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=4, name='Chords')
    for b in range(num_bars):
        cr = progression[b % len(progression)]
        chord = [cr, cr+3, cr+7, cr+10, cr+14] if minor else [cr, cr+4, cr+7, cr+11, cr+14]
        chord = [(p % 12) + 60 for p in chord][:4]
        t = b * bar
        for beat_i in np.random.choice([0,1,2,3], 2, replace=False):
            bt = t + beat_i * beat
            for p in chord:
                inst.notes.append(pretty_midi.Note(np.random.randint(60, 78), p, bt, bt + beat * 0.4))
    pm.instruments.append(inst)


def _jazz_melody(pm, bar, beat, num_bars, root, minor):
    inst = pretty_midi.Instrument(program=66, name='Melody')
    scale = _scale(root, minor)
    for b in range(num_bars):
        t = b * bar
        num_notes = np.random.randint(3, 7)
        curr = (root % 12) + 72
        for i in range(num_notes):
            nt = t + i * (bar / num_notes) * np.random.uniform(0.8, 1.1)
            if nt >= t + bar: break
            curr = int(np.clip(curr + np.random.choice([-2,-1,0,1,2]), 60, 84))
            dur = beat * np.random.choice([0.5, 1.0, 1.5, 0.25])
            inst.notes.append(pretty_midi.Note(np.random.randint(65, 90), curr, nt, nt + dur))
    pm.instruments.append(inst)


# ─── AMBIENT ─────────────────────────────────────────────────────────────────

def _ambient_pads(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')
    for b in range(0, num_bars, 4):
        cr = progression[b % len(progression)]
        chord = [cr-12, cr, cr+7, cr+12, cr+19] if minor else [cr-12, cr, cr+7, cr+11, cr+19]
        chord = [(p % 12) + 48 for p in chord]
        t = b * bar
        for p in chord:
            inst.notes.append(pretty_midi.Note(np.random.randint(45, 65), p, t, t + bar * 4 - 0.1))
    pm.instruments.append(inst)


def _ambient_melody(pm, bar, beat, num_bars, pent, root):
    inst = pretty_midi.Instrument(program=99, name='Melody')
    for b in range(0, num_bars, 2):
        t = b * bar
        if np.random.random() < 0.6:
            pitch = np.random.choice(pent) % 12 + 72
            dur = bar * np.random.uniform(1.5, 3.5)
            inst.notes.append(pretty_midi.Note(np.random.randint(40, 65), pitch, t, t + dur))
    pm.instruments.append(inst)


# ─── GENERIC ─────────────────────────────────────────────────────────────────

def _generic_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT, CRASH = 36, 38, 42, 49
    for b in range(num_bars):
        t = b * bar
        if b % 8 == 0:
            inst.notes.append(pretty_midi.Note(90, CRASH, t, t + 0.1))
        for beat_i in range(4):
            bt = t + beat_i * beat
            if beat_i in (0, 2): inst.notes.append(pretty_midi.Note(90, KICK, bt, bt + 0.08))
            if beat_i in (1, 3): inst.notes.append(pretty_midi.Note(85, SNARE, bt, bt + 0.06))
            for e in range(2):
                ht = bt + e * beat * 0.5
                inst.notes.append(pretty_midi.Note(55 if e else 68, CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _generic_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % len(progression)] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i in range(4):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(85, root, bt, bt + beat * 0.8))
    pm.instruments.append(inst)


def _generic_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=0, name='Chords')
    for b in range(num_bars):
        if b % 2 == 0:
            cr = progression[b % len(progression)]
            notes = [(n % 12) + 60 for n in _chord_notes(cr, minor)]
            t = b * bar
            for p in notes:
                inst.notes.append(pretty_midi.Note(68, p, t, t + bar * 2 - 0.1))
    pm.instruments.append(inst)


def _generic_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=0, name='Melody')
    for b in range(num_bars):
        t = b * bar
        for e in range(8):
            if np.random.random() < 0.55:
                nt = t + e * beat * 0.5
                pitch = np.random.choice(pent) % 12 + 72
                while pitch > 84: pitch -= 12
                dur = beat * np.random.choice([0.5, 1.0])
                inst.notes.append(pretty_midi.Note(np.random.randint(70, 90), pitch, nt, nt + dur))
    pm.instruments.append(inst)
