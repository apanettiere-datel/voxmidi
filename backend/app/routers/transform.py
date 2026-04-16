import uuid
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List, Optional
from sqlalchemy.orm import Session

from pipelines.midi_generator import generate_from_prompt
from pipelines.post_processor import post_process_midi
from pipelines.midi_analyzer import analyze_midi
from database import get_db, User, Generation
from middleware.auth import get_current_user

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")


class TransformRequest(BaseModel):
    source_job_id: str
    style_prompt: str
    keep_tracks: List[str] = []
    generate_tracks: List[str] = []
    tempo: int = 128
    key: str = "Am"


@router.post("/transform")
async def transform_style(
    req: TransformRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Take extracted MIDI stems, keep some, regenerate others with style transfer."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} reached")

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    source_dir = UPLOAD_DIR / req.source_job_id
    if not source_dir.exists():
        raise HTTPException(status_code=404, detail="Source job not found")

    conditioning_midi = None
    for track_name in req.keep_tracks:
        midi_path = source_dir / f"{track_name}.mid"
        if midi_path.exists():
            conditioning_midi = str(midi_path)
            break

    prompt = f"A {req.style_prompt}, at {req.tempo} BPM, in the key of {req.key}."
    output_path = str(job_dir / "transformed.mid")

    try:
        generate_from_prompt(
            prompt=prompt,
            output_path=output_path,
            conditioning_midi=conditioning_midi,
            genre=req.style_prompt.split()[0] if req.style_prompt else "edm",
            tempo=req.tempo,
            key=req.key,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    try:
        final_path = post_process_midi(output_path, str(job_dir / "final.mid"), tempo=req.tempo, key=req.key)
    except Exception:
        final_path = output_path

    try:
        analysis = analyze_midi(final_path)
    except Exception:
        analysis = {"tempo": req.tempo, "duration": 0, "time_signature": "4/4", "key": req.key, "tracks": []}

    gen = Generation(
        id=job_id,
        user_id=current_user.id,
        mode="transform",
        genre="unknown",
        tempo=req.tempo,
        key=req.key,
        prompt=req.style_prompt,
        midi_filename="final.mid",
        tracks_count=len(analysis.get("tracks", [])),
        duration=analysis.get("duration", 0.0),
        time_signature=analysis.get("time_signature", "4/4"),
    )
    db.add(gen)
    current_user.usage_count += 1
    db.commit()

    return {
        "job_id": job_id,
        "midi_url": f"/api/download/{job_id}/final.mid",
        "tempo": analysis.get("tempo") or req.tempo,
        "key": analysis.get("key") or req.key,
        "duration": analysis.get("duration", 0),
        "time_signature": analysis.get("time_signature", "4/4"),
        "tracks": analysis.get("tracks", []),
    }
