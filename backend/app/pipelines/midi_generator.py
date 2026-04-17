"""MIDI generation — MusicGen (Replicate) + MiniMax Music, with mock fallback."""

import os
import time
import shutil
import urllib.request
import pretty_midi
import numpy as np
from pathlib import Path
from typing import Optional, Tuple

KEY_ROOTS = {
    'C': 60, 'Cm': 60, 'C#': 61, 'C#m': 61,
    'D': 62, 'Dm': 62, 'Eb': 63, 'Ebm': 63,
    'E': 64, 'Em': 64, 'F': 65, 'Fm': 65,
    'F#': 66, 'F#m': 66, 'G': 67, 'Gm': 67,
    'Ab': 68, 'Abm': 68, 'A': 69, 'Am': 69,
    'Bb': 70, 'Bbm': 70, 'B': 71, 'Bm': 71,
}
MINOR_KEYS = {'Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','Abm','Am','Bbm','Bm'}


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


# ─── Shared audio→MIDI helper ─────────────────────────────────────────────────

def _audio_to_midi(
    audio_path: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    skip_vocals: bool = False,
) -> Tuple[str, Optional[str]]:
    """Demucs stem separation → Basic Pitch transcription → merged MIDI.

    Returns (midi_path, vocal_stem_path_or_None).
    """
    from pipelines.separator import separate_stems
    from pipelines.transcriber import transcribe_audio

    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    print("[midi_generator] Separating stems via Demucs...")
    stems = separate_stems(str(audio_path), str(job_dir))

    print(f"[midi_generator] Transcribing {len(stems)} stems with Basic Pitch...")

    STEM_PROGRAMS = {
        "vocals": 0, "other": 0, "bass": 33,
        "piano": 0, "guitar": 25, "chords": 4,
    }

    merged = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)
    vocal_stem_path: Optional[str] = None

    for stem_name, stem_path in stems.items():
        if stem_name == "vocals":
            vocal_stem_path = stem_path
            if skip_vocals:
                continue

        is_drum = stem_name == "drums"
        program = STEM_PROGRAMS.get(stem_name, 0)

        try:
            stem_midi = transcribe_audio(
                stem_path, str(job_dir), output_name=f"{stem_name}.mid"
            )
            stem_pm = pretty_midi.PrettyMIDI(stem_midi)
            for instrument in stem_pm.instruments:
                if not instrument.notes:
                    continue
                new_inst = pretty_midi.Instrument(
                    program=program, is_drum=is_drum,
                    name=stem_name.capitalize(),
                )
                new_inst.notes = instrument.notes
                merged.instruments.append(new_inst)
                break
        except Exception as e:
            print(f"[midi_generator] Could not transcribe {stem_name}: {e}")

    if not merged.instruments:
        print("[midi_generator] No stems transcribed — falling back to mock")
        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        pm.write(output_path)
        return output_path, vocal_stem_path

    merged.write(output_path)
    print(f"[midi_generator] Wrote {len(merged.instruments)} tracks to {output_path}")
    return output_path, vocal_stem_path


# ─── MusicGen (Replicate) ─────────────────────────────────────────────────────

MUSICGEN_MODEL = "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb"


def _generate_via_musicgen(
    prompt: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    audio_path: Optional[str] = None,
) -> Tuple[str, Optional[str]]:
    """Generate instrumental audio with MusicGen, then convert to MIDI via stems."""
    import replicate

    token = os.environ.get('REPLICATE_API_TOKEN', '')
    if not token:
        print("[midi_generator] REPLICATE_API_TOKEN not set — using mock generator")
        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        pm.write(output_path)
        return output_path, None

    client = replicate.Client(api_token=token)

    built_prompt = (
        f"{genre.replace('-', ' ').title()} music at {tempo} BPM in the key of {key}. {prompt}"
    ).strip()

    inputs: dict = {
        "prompt": built_prompt,
        "model_version": "stereo-melody-large",
        "duration": 30,
        "output_format": "mp3",
    }

    try:
        if audio_path and Path(audio_path).exists():
            print("[midi_generator] MusicGen: generating with melody conditioning from user audio...")
            with open(audio_path, 'rb') as f:
                inputs["input_audio"] = f
                output = client.run(MUSICGEN_MODEL, input=inputs)
        else:
            print("[midi_generator] MusicGen: generating instrumental audio (30s)...")
            output = client.run(MUSICGEN_MODEL, input=inputs)
    except Exception as e:
        print(f"[midi_generator] MusicGen API error: {e} — falling back to mock")
        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        pm.write(output_path)
        return output_path, None

    # output is a URL to the generated MP3
    audio_url = str(output)
    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)
    gen_audio_path = str(job_dir / "musicgen_audio.mp3")

    print("[midi_generator] MusicGen: downloading audio...")
    urllib.request.urlretrieve(audio_url, gen_audio_path)

    return _audio_to_midi(gen_audio_path, output_path, genre=genre, tempo=tempo, key=key)


# ─── MiniMax Music ────────────────────────────────────────────────────────────

def _generate_via_minimax(
    prompt: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    lyrics: str = '',
) -> Tuple[str, Optional[str]]:
    """Generate a full song (vocals + music) with MiniMax, extract MIDI from instrumentals."""
    import httpx
    import binascii

    api_key = os.environ.get('MINIMAX_API_KEY', '')
    if not api_key:
        print("[midi_generator] MINIMAX_API_KEY not set — using mock generator")
        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        pm.write(output_path)
        return output_path, None

    style_desc = (
        f"{genre.replace('-', ' ').title()} style at {tempo} BPM in {key}. {prompt}"
    ).strip()

    print("[midi_generator] MiniMax: generating song with vocals...")

    resp = httpx.post(
        "https://api.minimax.io/v1/music_generation",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "music-2.6",
            "prompt": style_desc,
            "lyrics": lyrics,
            "audio_setting": {
                "sample_rate": 44100,
                "bitrate": 256000,
                "format": "mp3",
            },
        },
        timeout=120.0,
    )
    resp.raise_for_status()

    resp_json = resp.json()
    audio_hex = resp_json.get("data", {}).get("audio", "")
    if not audio_hex:
        raise RuntimeError(f"MiniMax returned no audio data: {resp_json}")

    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    audio_bytes = binascii.unhexlify(audio_hex)
    audio_file = str(job_dir / "minimax_audio.mp3")
    Path(audio_file).write_bytes(audio_bytes)
    print(f"[midi_generator] MiniMax: saved {len(audio_bytes)} bytes of audio")

    # Separate stems — skip vocals in MIDI (they're returned as audio)
    midi_path, vocal_path = _audio_to_midi(
        audio_file, output_path, genre=genre, tempo=tempo, key=key, skip_vocals=True
    )

    # Copy the vocal stem (separated) as the vocal track for the DAW
    # If Demucs didn't separate, fall back to the full mix
    if vocal_path and Path(vocal_path).exists():
        final_vocal = str(job_dir / "vocal_track.mp3")
        shutil.copy(vocal_path, final_vocal)
    else:
        final_vocal = audio_file  # full mix as fallback

    return midi_path, final_vocal


# ─── Public API ───────────────────────────────────────────────────────────────

def generate_from_prompt(
    prompt: str,
    output_path: str,
    conditioning_midi: Optional[str] = None,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    lyrics: str = '',
    audio_path: Optional[str] = None,
    **kwargs,
) -> Tuple[str, Optional[str]]:
    """Generate MIDI from prompt/audio/lyrics.

    Returns (midi_path, vocal_audio_path_or_None).
    vocal_audio_path is the local path to a separated vocal stem (MP3).
    """
    provider = os.environ.get('MIDI_GEN_PROVIDER', 'auto')
    has_replicate = bool(os.environ.get('REPLICATE_API_TOKEN'))
    has_minimax = bool(os.environ.get('MINIMAX_API_KEY'))

    use_api = provider == 'api' or (provider == 'auto' and (has_replicate or has_minimax))

    if not use_api or provider == 'mock':
        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        pm.write(output_path)
        return output_path, None

    # Route based on input:
    # lyrics present AND MiniMax available → MiniMax (vocals + music)
    # audio present or text only → MusicGen (instrumental)
    if lyrics.strip() and has_minimax:
        print("[midi_generator] Routing to MiniMax (lyrics provided)")
        return _generate_via_minimax(
            prompt, output_path, genre=genre, tempo=tempo, key=key, lyrics=lyrics
        )
    else:
        print("[midi_generator] Routing to MusicGen")
        return _generate_via_musicgen(
            prompt, output_path, genre=genre, tempo=tempo, key=key, audio_path=audio_path
        )


# ─── Mock generator (genre-aware fallback) ────────────────────────────────────

def mock_generate(genre: str, tempo: int, key: str, num_bars: int = 32) -> pretty_midi.PrettyMIDI:
    g = genre.lower().replace(' ', '-').replace('_', '-')
    minor = _is_minor(key)
    root = KEY_ROOTS.get(key, 69)
    beat = 60.0 / tempo
    bar = beat * 4
    progression = _chord_roots(root, minor)
    pent = _pentatonic(root, minor)
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)

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
        chord_root = progression[b % 4] - 24
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
        cr = progression[b % 4]
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
        root = progression[b % 4] - 24
        while root < 24: root += 12
        t = b * bar
        inst.notes.append(pretty_midi.Note(95, root, t, t + bar * 0.9))
        if np.random.random() < 0.4:
            slide_t = t + bar * 0.5
            root2 = progression[(b + 1) % 4] - 24
            while root2 < 24: root2 += 12
            inst.notes.append(pretty_midi.Note(85, root2, slide_t, t + bar * 0.95))
    pm.instruments.append(inst)


def _trap_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')
    for b in range(num_bars):
        cr = progression[b % 4]
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
        if np.random.random() < 0.3:
            inst.notes.append(pretty_midi.Note(75, KICK, t + beat * 2.5, t + beat * 2.58))
        inst.notes.append(pretty_midi.Note(85, SNARE, t + beat, t + beat + 0.06))
        inst.notes.append(pretty_midi.Note(80, SNARE, t + beat * 3, t + beat * 3 + 0.06))
        for e in range(8):
            ht = t + e * beat * 0.5 + (swing if e % 2 == 1 else 0)
            inst.notes.append(pretty_midi.Note(np.random.randint(45, 75), CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _lofi_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % 4] - 12
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
        cr = progression[b % 4]
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
        root = progression[b % 4] - 12
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
            cr = progression[b % 4]
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
        root = progression[b % 4] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i, pitch in enumerate([root, root+2, root+4, root+7]):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(80, pitch, bt, bt + beat * 0.9))
    pm.instruments.append(inst)


def _jazz_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=4, name='Chords')
    for b in range(num_bars):
        cr = progression[b % 4]
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
        cr = progression[(b // 4) % 4]
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
        root = progression[b % 4] - 12
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
            cr = progression[b % 4]
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
