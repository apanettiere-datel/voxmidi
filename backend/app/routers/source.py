import os
import shutil
import uuid
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from pipelines.audio_download import download_audio
from pipelines.separator import separate_stems
from pipelines.transcriber import transcribe_audio
from pipelines.midi_analyzer import analyze_midi
from database import get_db, User, Generation
from middleware.auth import get_current_user

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")

STEM_PROGRAMS = {"vocals": 0, "bass": 33, "drums": 0, "other": 4, "guitar": 25, "piano": 0}
REPLICATE_DEMUCS_COST = 0.02  # ~$0.02 per run


class SourceRequest(BaseModel):
    url: str
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    genre: Optional[str] = "edm"
    tempo: Optional[int] = 128
    key: Optional[str] = "Am"


@router.post("/source")
async def extract_source(
    req: SourceRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Extract audio from URL, separate stems, transcribe each to MIDI."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} reached")

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    separator_provider = os.environ.get('SEPARATOR_PROVIDER', 'mock')
    audio_path = str(job_dir / "source_audio.wav")  # placeholder for mock

    if separator_provider != 'mock':
        try:
            audio_path = download_audio(req.url, str(job_dir), start_time=req.start_time, end_time=req.end_time)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Download failed: {e}")

    try:
        stems = separate_stems(audio_path, str(job_dir))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Separation failed: {e}")

    stem_midis = {}
    all_tracks = []
    replicate_cost = REPLICATE_DEMUCS_COST if separator_provider == 'api' else 0.0

    for stem_name, stem_path in stems.items():
        try:
            if stem_path.endswith(".mid"):
                dest = str(job_dir / f"{stem_name}.mid")
                shutil.copy2(stem_path, dest)
                final_midi = dest
            else:
                final_midi = transcribe_audio(stem_path, str(job_dir), output_name=f"{stem_name}.mid")

            analysis = analyze_midi(final_midi)
            tracks = analysis.get("tracks", [])

            for t in tracks:
                t["name"] = stem_name.capitalize()
                if stem_name == "drums":
                    t["is_drum"] = True
                    t["channel"] = 9
                elif "program" not in t or t["program"] == 0:
                    t["program"] = STEM_PROGRAMS.get(stem_name, 0)

            stem_midis[stem_name] = {
                "midi_url": f"/api/download/{job_id}/{stem_name}.mid",
                "stem_url": f"/api/download/{job_id}/{stem_name}.mid",
                "tracks": tracks,
            }
            all_tracks.extend(tracks)

        except Exception as ex:
            stem_midis[stem_name] = {"error": str(ex)}

    # Record generation + increment usage
    gen = Generation(
        id=job_id,
        user_id=current_user.id,
        mode="source",
        genre=req.genre or "unknown",
        tempo=req.tempo or 128,
        key=req.key or "Am",
        prompt=req.url,
        midi_filename="",
        tracks_count=len(all_tracks),
        replicate_cost=replicate_cost,
    )
    db.add(gen)
    current_user.usage_count += 1
    db.commit()

    return {
        "job_id": job_id,
        "stems": stem_midis,
        "tracks": all_tracks,
        "tempo": req.tempo,
        "key": req.key,
    }
