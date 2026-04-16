"""Download audio from YouTube or direct URLs using yt-dlp."""

import subprocess
import re
import sys
from pathlib import Path
from typing import Optional

# Prefer yt-dlp from the same venv as the running interpreter
_VENV_YTDLP = Path(sys.executable).parent / 'yt-dlp'
YT_DLP = str(_VENV_YTDLP) if _VENV_YTDLP.exists() else 'yt-dlp'


def download_audio(
    url: str,
    output_dir: str,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> str:
    """
    Download audio from a URL (YouTube, SoundCloud, direct link, etc.)

    Returns path to the downloaded WAV file.
    """
    output_path = Path(output_dir) / "source_audio.wav"

    # Extract timestamp from YouTube URL if present (e.g., ?t=835s or &t=835)
    if start_time is None:
        t_match = re.search(r'[?&]t=(\d+)', url)
        if t_match:
            start_time = float(t_match.group(1))

    # Build yt-dlp command
    cmd = [
        YT_DLP,
        "--extract-audio",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "--output", str(Path(output_dir) / "source_audio.%(ext)s"),
        "--no-playlist",
    ]

    # Apply time range via ffmpeg postprocessor
    if start_time is not None or end_time is not None:
        pp_args = []
        if start_time is not None:
            pp_args.extend(["-ss", str(start_time)])
        if end_time is not None:
            duration = end_time - (start_time or 0)
            pp_args.extend(["-t", str(duration)])
        elif start_time is not None:
            # Default to 60 seconds if no end time specified
            pp_args.extend(["-t", "60"])

        cmd.extend([
            "--postprocessor-args",
            f"ffmpeg:{' '.join(pp_args)}",
        ])

    cmd.append(url)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {result.stderr}")

    # Find the output file (yt-dlp may name it slightly differently)
    wav_files = list(Path(output_dir).glob("source_audio*"))
    if not wav_files:
        raise FileNotFoundError("No audio file downloaded")

    # If not already .wav, convert
    actual_file = wav_files[0]
    if actual_file.suffix != ".wav":
        converted = Path(output_dir) / "source_audio.wav"
        subprocess.run(
            ["ffmpeg", "-i", str(actual_file), "-ar", "44100", "-ac", "2", str(converted), "-y"],
            capture_output=True, timeout=60,
        )
        actual_file.unlink()
        return str(converted)

    return str(actual_file)
