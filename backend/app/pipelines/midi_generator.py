"""MIDI generation — smart routing: MiniMax (instrumental/vocal) + MusicGen (melody conditioning).

Routing logic:
  Route 1 — text only: MiniMax instrumental (best quality) → fallback MusicGen
  Route 2 — text + lyrics: MiniMax with lyrics (vocals)
  Route 3 — audio + no lyrics: MusicGen melody-conditioning (primary) + MiniMax instrumental (secondary)
  Route 4 — audio + lyrics: MusicGen melody (instrumental) + MiniMax lyrics (vocal)
  Mock — no API keys: deterministic MIDI generator

Returns: Tuple[midi_path, vocal_audio_path, primary_stems_dict, versions_list]
  versions_list: [] for single version, list of dicts for multiple
"""

import os
import shutil
import time
import threading
import urllib.request
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

MUSICGEN_MODEL = "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb"


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


# ─── Stem separation + clean MIDI ────────────────────────────────────────────

def _process_audio(
    audio_path: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    skip_vocals: bool = False,
    user_hum_path: Optional[str] = None,
    stem_prefix: str = "",
) -> Tuple[str, Optional[str], Dict[str, str]]:
    """
    Separate audio into stems, generate clean MIDI, optionally merge hummed melody.
    stem_prefix: if set, stem files are renamed as {prefix}_{stem}.mp3
    Returns (midi_path, vocal_stem_path, stems_dict).
    """
    from pipelines.separator import separate_stems
    from pipelines.transcriber import transcribe_audio

    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    # Use a temp subdir for demucs output when prefix is used (avoid overwriting primary stems)
    if stem_prefix:
        sep_dir = job_dir / f"_sep_{stem_prefix}"
        sep_dir.mkdir(parents=True, exist_ok=True)
    else:
        sep_dir = job_dir

    print(f"[midi_generator] Separating stems for {stem_prefix or 'primary'}...")
    raw_stems = separate_stems(str(audio_path), str(sep_dir))

    # Rename/copy stems with prefix into job_dir
    stems: Dict[str, str] = {}
    for stem_name, stem_path in raw_stems.items():
        src = Path(stem_path)
        if stem_prefix:
            dest_name = f"{stem_prefix}_{stem_name}{src.suffix}"
        else:
            dest_name = src.name
        dest = job_dir / dest_name
        if src != dest:
            shutil.copy2(src, dest)
        stems[stem_name] = str(dest)

    vocal_stem_path: Optional[str] = stems.get("vocals")

    # Generate clean MIDI (NOT transcription — transcription sounds bad)
    pm = mock_generate(genre=genre, tempo=tempo, key=key)

    # If user hummed a melody, transcribe THAT for the melody track
    if user_hum_path and Path(user_hum_path).exists():
        try:
            hum_midi_path = transcribe_audio(user_hum_path, str(job_dir), output_name="hum_melody.mid")
            hum_pm = pretty_midi.PrettyMIDI(hum_midi_path)
            if hum_pm.instruments:
                melody_idx = next(
                    (i for i, inst in enumerate(pm.instruments) if inst.name == 'Melody'), None
                )
                hum_inst = hum_pm.instruments[0]
                hum_inst.name = 'Melody (from hum)'
                hum_inst.program = 0
                if melody_idx is not None:
                    pm.instruments[melody_idx] = hum_inst
                else:
                    pm.instruments.append(hum_inst)
                print("[midi_generator] Merged hummed melody into MIDI")
        except Exception as e:
            print(f"[midi_generator] Could not transcribe hum: {e}")

    pm.write(output_path)
    print(f"[midi_generator] Wrote clean MIDI ({len(pm.instruments)} tracks) to {output_path}")

    return output_path, vocal_stem_path, stems


# ─── MusicGen ────────────────────────────────────────────────────────────────

def _musicgen_generate_audio(
    prompt: str,
    job_dir: Path,
    genre: str,
    tempo: int,
    key: str,
    audio_path: Optional[str] = None,
    max_retries: int = 2,
) -> str:
    """
    Call MusicGen API and return path to downloaded mp3.
    Retries on CUDA errors; raises RuntimeError on final failure.
    """
    import replicate

    token = os.environ.get('REPLICATE_API_TOKEN', '')
    if not token:
        raise RuntimeError("REPLICATE_API_TOKEN not set")

    client = replicate.Client(api_token=token)

    built_prompt = f"{genre.replace('-', ' ').title()} music at {tempo} BPM in the key of {key}. {prompt}".strip()
    inputs: dict = {
        "prompt": built_prompt,
        "model_version": "stereo-melody-large",
        "duration": 30,
        "output_format": "mp3",
    }

    gen_audio_path = str(job_dir / "musicgen_audio.mp3")

    for attempt in range(max_retries + 1):
        try:
            if audio_path and Path(audio_path).exists():
                print(f"[midi_generator] MusicGen: melody conditioning (attempt {attempt+1})...")
                with open(audio_path, 'rb') as f:
                    inputs_with_audio = {**inputs, "input_audio": f}
                    output = client.run(MUSICGEN_MODEL, input=inputs_with_audio)
            else:
                print(f"[midi_generator] MusicGen: text prompt (attempt {attempt+1})...")
                output = client.run(MUSICGEN_MODEL, input=inputs)

            audio_url = str(output)
            print("[midi_generator] MusicGen: downloading generated audio...")
            urllib.request.urlretrieve(audio_url, gen_audio_path)
            return gen_audio_path

        except Exception as e:
            err_str = str(e).lower()
            is_cuda = "cuda" in err_str or "gpu" in err_str or "out of memory" in err_str
            if is_cuda and attempt < max_retries:
                print(f"[midi_generator] MusicGen CUDA error (attempt {attempt+1}), retrying in 5s...")
                time.sleep(5)
                continue
            raise RuntimeError(f"MusicGen API error: {e}")


def _generate_via_musicgen(
    prompt: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    audio_path: Optional[str] = None,
    stem_prefix: str = "",
) -> Tuple[str, None, Dict[str, str]]:
    """Generate with MusicGen, run Demucs, generate clean MIDI."""
    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    has_minimax = bool(os.environ.get('MINIMAX_API_KEY'))

    try:
        gen_audio_path = _musicgen_generate_audio(prompt, job_dir, genre, tempo, key, audio_path)
    except RuntimeError as e:
        err_str = str(e).lower()
        is_cuda = "cuda" in err_str or "gpu" in err_str
        if is_cuda and has_minimax:
            print("[midi_generator] MusicGen CUDA error — falling back to MiniMax instrumental")
            return _generate_via_minimax_instrumental(prompt, output_path, genre, tempo, key, stem_prefix=stem_prefix)
        raise

    return _process_audio(
        gen_audio_path, output_path,
        genre=genre, tempo=tempo, key=key,
        user_hum_path=audio_path,
        stem_prefix=stem_prefix,
    )


# ─── MiniMax ─────────────────────────────────────────────────────────────────

def _minimax_api_call(
    style_desc: str,
    lyrics: str,
    job_dir: Path,
    out_filename: str = "minimax_audio.mp3",
) -> str:
    """Call MiniMax music API, save to out_filename, return path."""
    import httpx
    import binascii

    api_key = os.environ.get('MINIMAX_API_KEY', '')
    if not api_key:
        raise RuntimeError("MINIMAX_API_KEY not set")

    payload: dict = {
        "model": "music-2.6",
        "prompt": style_desc,
        "audio_setting": {
            "sample_rate": 44100,
            "bitrate": 256000,
            "format": "mp3",
        },
    }
    if lyrics:
        payload["lyrics"] = lyrics

    print(f"[midi_generator] MiniMax: generating {'vocal' if lyrics else 'instrumental'}...")
    resp = httpx.post(
        "https://api.minimax.io/v1/music_generation",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=120.0,
    )
    resp.raise_for_status()

    resp_json = resp.json()
    audio_hex = resp_json.get("data", {}).get("audio", "")
    if not audio_hex:
        raise RuntimeError(f"MiniMax returned no audio data: {resp_json}")

    audio_bytes = binascii.unhexlify(audio_hex)
    audio_file = job_dir / out_filename
    audio_file.write_bytes(audio_bytes)
    print(f"[midi_generator] MiniMax: saved {len(audio_bytes)} bytes → {out_filename}")
    return str(audio_file)


def _generate_via_minimax_instrumental(
    prompt: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    stem_prefix: str = "",
) -> Tuple[str, None, Dict[str, str]]:
    """MiniMax instrumental (empty lyrics). Best quality for text-only prompts."""
    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    api_key = os.environ.get('MINIMAX_API_KEY', '')
    if not api_key:
        raise RuntimeError("MINIMAX_API_KEY not set")

    style_desc = f"{genre.replace('-', ' ').title()} style at {tempo} BPM in {key}. {prompt}".strip()
    audio_file = _minimax_api_call(style_desc, lyrics="", job_dir=job_dir,
                                   out_filename="minimax_audio.mp3")

    midi_path, _, stems = _process_audio(
        audio_file, output_path,
        genre=genre, tempo=tempo, key=key, skip_vocals=False,
        stem_prefix=stem_prefix,
    )
    return midi_path, None, stems


def _generate_via_minimax_vocal(
    prompt: str,
    output_path: str,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    lyrics: str = '',
    stem_prefix: str = "",
) -> Tuple[str, Optional[str], Dict[str, str]]:
    """MiniMax with lyrics = vocal track generation."""
    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    api_key = os.environ.get('MINIMAX_API_KEY', '')
    if not api_key:
        raise RuntimeError("MINIMAX_API_KEY not set")

    style_desc = f"{genre.replace('-', ' ').title()} style at {tempo} BPM in {key}. {prompt}".strip()
    audio_file = _minimax_api_call(style_desc, lyrics=lyrics, job_dir=job_dir,
                                   out_filename="minimax_audio.mp3")

    midi_path, vocal_stem_path, stems = _process_audio(
        audio_file, output_path,
        genre=genre, tempo=tempo, key=key, skip_vocals=True,
        stem_prefix=stem_prefix,
    )

    if vocal_stem_path and Path(vocal_stem_path).exists():
        final_vocal = str(job_dir / "vocal_track.mp3")
        shutil.copy(vocal_stem_path, final_vocal)
        vocal_stem_path = final_vocal

    return midi_path, vocal_stem_path, stems


def _minimax_audio_only(
    prompt: str,
    job_dir: Path,
    genre: str,
    tempo: int,
    key: str,
    out_filename: str = "minimax_audio.mp3",
) -> Optional[str]:
    """Generate MiniMax audio only (no Demucs). For secondary version."""
    try:
        style_desc = f"{genre.replace('-', ' ').title()} style at {tempo} BPM in {key}. {prompt}".strip()
        return _minimax_api_call(style_desc, lyrics="", job_dir=job_dir, out_filename=out_filename)
    except Exception as e:
        print(f"[midi_generator] MiniMax audio-only failed: {e}")
        return None


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
    conditioning_midi: Optional[str] = None,
    **kwargs,
) -> Tuple[str, Optional[str], Dict[str, str], List[dict]]:
    """
    Smart model routing. Returns (midi_path, vocal_path, primary_stems, versions_list).

    versions_list: [] for single version, list of version dicts for multiple:
      [{"id": "musicgen"|"minimax", "label": str, "provider": str,
        "audio_path": str, "stems": {stem_name: local_path}, "vocal_path": optional}]
    """
    provider = os.environ.get('MIDI_GEN_PROVIDER', 'auto')
    has_replicate = bool(os.environ.get('REPLICATE_API_TOKEN'))
    has_minimax = bool(os.environ.get('MINIMAX_API_KEY'))
    use_api = provider == 'api' or (provider == 'auto' and (has_replicate or has_minimax))

    # Piano melody takes priority over voice recording as audio conditioning
    effective_audio_path = audio_path or piano_melody_path
    job_dir = Path(output_path).parent
    job_dir.mkdir(parents=True, exist_ok=True)

    # ── MOCK MODE ────────────────────────────────────────────────────────────
    if not use_api or provider == 'mock':
        pm = mock_generate(genre=genre, tempo=tempo, key=key, chord_progression=chord_progression)
        pm.write(output_path)
        return output_path, None, {}, []

    has_audio = bool(effective_audio_path and Path(effective_audio_path).exists())
    has_lyrics = bool(lyrics.strip())

    # ── ROUTE 1: text only (no audio, no lyrics) → MiniMax instrumental ─────
    if not has_audio and not has_lyrics:
        if has_minimax:
            print("[midi_generator] Route 1: MiniMax instrumental")
            try:
                midi, vocal, stems = _generate_via_minimax_instrumental(
                    prompt, output_path, genre=genre, tempo=tempo, key=key
                )
                return midi, vocal, stems, []
            except Exception as e:
                print(f"[midi_generator] MiniMax failed: {e} — trying MusicGen")

        if has_replicate:
            print("[midi_generator] Route 1 fallback: MusicGen text-only")
            midi, vocal, stems = _generate_via_musicgen(
                prompt, output_path, genre=genre, tempo=tempo, key=key
            )
            return midi, vocal, stems, []

        # No API at all → mock
        pm = mock_generate(genre=genre, tempo=tempo, key=key, chord_progression=chord_progression)
        pm.write(output_path)
        return output_path, None, {}, []

    # ── ROUTE 2: lyrics, no audio → MiniMax vocal ────────────────────────────
    if has_lyrics and not has_audio:
        if has_minimax:
            print("[midi_generator] Route 2: MiniMax vocal (lyrics provided)")
            midi, vocal, stems = _generate_via_minimax_vocal(
                prompt, output_path, genre=genre, tempo=tempo, key=key, lyrics=lyrics
            )
            return midi, vocal, stems, []

        if has_replicate:
            print("[midi_generator] Route 2 fallback: MusicGen (no MiniMax key)")
            midi, vocal, stems = _generate_via_musicgen(
                prompt, output_path, genre=genre, tempo=tempo, key=key
            )
            return midi, vocal, stems, []

        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        pm.write(output_path)
        return output_path, None, {}, []

    # ── ROUTE 3: audio input, no lyrics → MusicGen (melody) + MiniMax (alt) ─
    if has_audio and not has_lyrics:
        print("[midi_generator] Route 3: MusicGen melody-conditioning + MiniMax alternate")

        if has_replicate:
            # Primary: MusicGen with melody conditioning
            midi, vocal, primary_stems = _generate_via_musicgen(
                prompt, output_path, genre=genre, tempo=tempo, key=key,
                audio_path=effective_audio_path
            )
            musicgen_audio = job_dir / "musicgen_audio.mp3"
            versions = [
                {
                    "id": "musicgen",
                    "label": "🎤 Your Melody",
                    "provider": "musicgen",
                    "audio_path": str(musicgen_audio) if musicgen_audio.exists() else None,
                    "stems": primary_stems,
                    "vocal_path": None,
                }
            ]

            # Secondary: MiniMax instrumental (audio only, no Demucs — cheaper)
            if has_minimax:
                alt_audio = _minimax_audio_only(prompt, job_dir, genre, tempo, key,
                                                out_filename="minimax_audio.mp3")
                if alt_audio:
                    versions.append({
                        "id": "minimax",
                        "label": "✨ High Quality",
                        "provider": "minimax",
                        "audio_path": alt_audio,
                        "stems": {},
                        "vocal_path": None,
                    })

            return midi, vocal, primary_stems, versions

        # No Replicate but has MiniMax → single MiniMax version
        if has_minimax:
            midi, vocal, stems = _generate_via_minimax_instrumental(
                prompt, output_path, genre=genre, tempo=tempo, key=key
            )
            return midi, vocal, stems, []

        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        pm.write(output_path)
        return output_path, None, {}, []

    # ── ROUTE 4: audio + lyrics → MusicGen melody + MiniMax vocal ────────────
    if has_audio and has_lyrics:
        print("[midi_generator] Route 4: MusicGen melody + MiniMax vocal")
        versions = []
        vocal = None  # may be set below

        if has_replicate:
            try:
                midi, _, mg_stems = _generate_via_musicgen(
                    prompt, output_path, genre=genre, tempo=tempo, key=key,
                    audio_path=effective_audio_path
                )
                musicgen_audio = job_dir / "musicgen_audio.mp3"
                versions.append({
                    "id": "musicgen",
                    "label": "🎤 Your Melody (Instrumental)",
                    "provider": "musicgen",
                    "audio_path": str(musicgen_audio) if musicgen_audio.exists() else None,
                    "stems": mg_stems,
                    "vocal_path": None,
                })
            except Exception as e:
                print(f"[midi_generator] Route 4 MusicGen failed: {e}")
                # Generate a basic MIDI if MusicGen fails
                pm = mock_generate(genre=genre, tempo=tempo, key=key)
                pm.write(output_path)
                midi = output_path

        if has_minimax:
            try:
                mm_midi_path = str(job_dir / "minimax_output.mid")
                shutil.copy(output_path, mm_midi_path) if Path(output_path).exists() else None
                _, vocal_path, mm_stems = _generate_via_minimax_vocal(
                    prompt, mm_midi_path if Path(mm_midi_path).exists() else output_path,
                    genre=genre, tempo=tempo, key=key, lyrics=lyrics, stem_prefix="mm"
                )
                minimax_audio = job_dir / "minimax_audio.mp3"
                versions.append({
                    "id": "minimax",
                    "label": "✨ Full Song (Vocals)",
                    "provider": "minimax",
                    "audio_path": str(minimax_audio) if minimax_audio.exists() else None,
                    "stems": mm_stems,
                    "vocal_path": vocal_path,
                })
                if not versions or versions[0]["id"] == "musicgen":
                    vocal = vocal_path
            except Exception as e:
                print(f"[midi_generator] Route 4 MiniMax failed: {e}")

        if not Path(output_path).exists():
            pm = mock_generate(genre=genre, tempo=tempo, key=key)
            pm.write(output_path)

        primary_stems = versions[0]["stems"] if versions else {}
        vocal = versions[-1].get("vocal_path") if versions else None
        return output_path, vocal, primary_stems, versions

    # Should never reach here
    pm = mock_generate(genre=genre, tempo=tempo, key=key)
    pm.write(output_path)
    return output_path, None, {}, []


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
