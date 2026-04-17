"""Audio download helper — supports direct file paths only (yt-dlp removed)."""

from pathlib import Path
from typing import Optional


def download_audio(
    url: str,
    output_dir: str,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> str:
    """
    Handles direct file paths only. YouTube/URL support removed.
    Raises RuntimeError with a user-friendly message for URLs.
    """
    if url.startswith("file://"):
        src = Path(url[7:])
        if not src.exists():
            raise FileNotFoundError(f"File not found: {src}")
        dest = Path(output_dir) / "source_audio" + src.suffix
        import shutil
        shutil.copy2(str(src), str(dest))
        return str(dest)

    raise RuntimeError(
        "URL downloads are not supported. Please upload the audio file directly."
    )
