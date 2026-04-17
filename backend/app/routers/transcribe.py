import uuid
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from fastapi.responses import FileResponse
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
    """Download a generated file. Checks /tmp first, then persistent data store."""
    for base in (UPLOAD_DIR, MIDI_STORE):
        file_path = base / job_id / filename
        if file_path.exists():
            media_type = "audio/mpeg" if filename.endswith(".mp3") else "audio/midi"
            return FileResponse(str(file_path), media_type=media_type, filename=filename)
    raise HTTPException(status_code=404, detail="File not found")
