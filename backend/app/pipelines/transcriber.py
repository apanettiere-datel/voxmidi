"""Wrapper around Spotify's Basic Pitch for audio → MIDI transcription."""

from pathlib import Path


def _ensure_wav(audio_path: str) -> str:
    """
    Convert any audio format (webm, ogg, mp3, …) to a plain WAV file that
    soundfile / basic-pitch can read without ffmpeg.

    Uses librosa which falls back to macOS CoreAudio / audioread for formats
    that soundfile doesn't support natively (e.g. browser-recorded webm/opus).
    Returns the path to the WAV file (may be the same as input if already WAV).
    """
    import numpy as np
    import soundfile as sf

    # Attempt to read with soundfile first (fast, no ffmpeg needed for WAV/FLAC/OGG)
    try:
        sf.info(audio_path)
        return audio_path  # soundfile can handle it — no conversion needed
    except Exception:
        pass

    # Fall back to librosa (uses macOS CoreAudio / audioread / ffmpeg)
    import librosa
    wav_path = str(Path(audio_path).parent / "input_converted.wav")
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    sf.write(wav_path, y, sr)
    return wav_path


def transcribe_audio(
    audio_path: str,
    output_dir: str,
    output_name: str = "output.mid",
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    minimum_note_length: float = 58.0,  # ms
    min_frequency: float = 80.0,        # Hz (low end of vocal range)
    max_frequency: float = 2000.0,      # Hz
) -> str:
    """
    Transcribe an audio file to MIDI using Basic Pitch.

    Returns the path to the generated .mid file.
    """
    from basic_pitch.inference import predict_and_save
    from basic_pitch import ICASSP_2022_MODEL_PATH

    # Ensure basic-pitch gets a format it can read (soundfile-compatible WAV)
    audio_path = _ensure_wav(audio_path)

    output_path = Path(output_dir)

    predict_and_save(
        audio_path_list=[audio_path],
        output_directory=str(output_path),
        save_midi=True,
        sonify_midi=False,
        save_model_outputs=False,
        save_notes=False,
        model_or_model_path=ICASSP_2022_MODEL_PATH,  # required in 0.4.0
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=minimum_note_length,
        minimum_frequency=min_frequency,
        maximum_frequency=max_frequency,
    )

    # Basic Pitch names output after the input file
    input_stem = Path(audio_path).stem
    generated_midi = output_path / f"{input_stem}_basic_pitch.mid"

    # Rename to requested output name
    final_path = output_path / output_name
    if generated_midi.exists():
        generated_midi.rename(final_path)
    else:
        # Fallback: find any .mid file in the output dir
        mid_files = list(output_path.glob("*.mid"))
        if mid_files:
            mid_files[0].rename(final_path)
        else:
            raise FileNotFoundError(f"No MIDI output generated in {output_path}")

    return str(final_path)
