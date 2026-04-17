import io
import uuid
import zipfile
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from pipelines.transcriber import transcribe_audio
from pipelines.midi_analyzer import analyze_midi
from database import get_db, User, Generation
from middleware.auth import get_current_user

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")
MIDI_STORE = Path("/app/data/midi")


@router.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Transcribe uploaded audio to MIDI using Basic Pitch."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} reached")

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    audio_path = job_dir / "input.wav"
    content = await audio.read()
    audio_path.write_bytes(content)

    try:
        midi_path = transcribe_audio(str(audio_path), str(job_dir))
        analysis = analyze_midi(midi_path)

        # Record generation
        gen = Generation(
            id=job_id,
            user_id=current_user.id,
            mode="transcribe",
            genre="unknown",
            tracks_count=len(analysis.get("tracks", [])),
            duration=analysis.get("duration", 0.0),
            time_signature=analysis.get("time_signature", "4/4"),
            midi_filename="output.mid",
        )
        db.add(gen)
        current_user.usage_count += 1
        db.commit()

        return {
            "job_id": job_id,
            "midi_url": f"/api/download/{job_id}/output.mid",
            **analysis,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/download/{job_id}/{filename}")
async def download_file(job_id: str, filename: str):
    """Download a generated file. Checks persistent store first, then /tmp."""
    if filename == "stems.zip":
        return await _stems_zip(job_id)

    for base in (MIDI_STORE, UPLOAD_DIR):
        file_path = base / job_id / filename
        if file_path.exists():
            if filename.endswith(".mp3"):
                media_type = "audio/mpeg"
            elif filename.endswith(".mid"):
                media_type = "audio/midi"
            else:
                media_type = "application/octet-stream"
            return FileResponse(
                str(file_path),
                media_type=media_type,
                filename=filename,
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
    raise HTTPException(status_code=404, detail="File not found")


async def _stems_zip(job_id: str) -> StreamingResponse:
    """Stream a zip of all stem MP3s for the given job."""
    STEM_NAMES = ["vocals", "bass", "drums", "other"]
    buf = io.BytesIO()
    found = False
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for base in (MIDI_STORE, UPLOAD_DIR):
            job_dir = base / job_id
            if not job_dir.exists():
                continue
            for stem in STEM_NAMES:
                src = job_dir / f"{stem}.mp3"
                if src.exists():
                    zf.write(src, f"{stem}.mp3")
                    found = True
            # Also include full mix
            for name in ("musicgen_audio.mp3", "minimax_audio.mp3"):
                src = job_dir / name
                if src.exists():
                    zf.write(src, "full_mix.mp3")
                    found = True
                    break
            if found:
                break
    if not found:
        raise HTTPException(status_code=404, detail="No stems found")
    buf.seek(0)
    zip_name = f"voxmidi_{job_id}_stems.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
    )
