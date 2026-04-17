"""Download audio from YouTube or direct URLs using yt-dlp."""

import subprocess
import re
import sys
from pathlib import Path
from typing import Optional

_VENV_YTDLP = Path(sys.executable).parent / "yt-dlp"
YT_DLP = str(_VENV_YTDLP) if _VENV_YTDLP.exists() else "yt-dlp"

_BOT_PHRASES = [
    "sign in to confirm",
    "confirm you're not a bot",
    "bot detection",
    "sign in",
    "cookies required",
    "age-restricted",
]


def download_audio(
    url: str,
    output_dir: str,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> str:
    """
    Download audio from a URL (YouTube, SoundCloud, direct link, etc.)
    Returns path to the downloaded WAV file.
    Raises RuntimeError with a user-friendly message on failure.
    """
    output_path = Path(output_dir) / "source_audio.wav"

    # Extract timestamp from YouTube URL if present (e.g., ?t=835s or &t=835)
    if start_time is None:
        t_match = re.search(r"[?&]t=(\d+)", url)
        if t_match:
            start_time = float(t_match.group(1))

    cmd = [
        YT_DLP,
        "--extract-audio",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "--output", str(Path(output_dir) / "source_audio.%(ext)s"),
        "--no-playlist",
    ]

    if start_time is not None or end_time is not None:
        pp_args = []
        if start_time is not None:
            pp_args.extend(["-ss", str(start_time)])
        if end_time is not None:
            duration = end_time - (start_time or 0)
            pp_args.extend(["-t", str(duration)])
        elif start_time is not None:
            pp_args.extend(["-t", "60"])
        cmd.extend(["--postprocessor-args", f"ffmpeg:{' '.join(pp_args)}"])

    cmd.append(url)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        stderr_lower = (result.stderr or "").lower()
        if any(phrase in stderr_lower for phrase in _BOT_PHRASES):
            raise RuntimeError(
                "YouTube is blocking this download. Please download the audio yourself "
                "and upload it as a file instead."
            )
        raise RuntimeError(
            "Download failed. Check that the URL is public and try again. "
            "For YouTube, uploading the file directly is more reliable."
        )

    wav_files = list(Path(output_dir).glob("source_audio*"))
    if not wav_files:
        raise FileNotFoundError("No audio file was downloaded.")

    actual_file = wav_files[0]
    if actual_file.suffix != ".wav":
        converted = Path(output_dir) / "source_audio.wav"
        subprocess.run(
            ["ffmpeg", "-i", str(actual_file), "-ar", "44100", "-ac", "2", str(converted), "-y"],
            capture_output=True,
            timeout=60,
        )
        actual_file.unlink(missing_ok=True)
        return str(converted)

    return str(actual_file)
