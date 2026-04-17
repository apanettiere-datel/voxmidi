"""User info, usage, and server-side library endpoints."""

import shutil
from datetime import datetime, timezone, date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db, User, Generation
from middleware.auth import get_current_user

router = APIRouter()

MIDI_STORE = Path("/app/data/midi")
UPLOAD_DIR = Path("/tmp/voxmidi")


def _generation_to_dict(g: Generation) -> dict:
    job_dir = MIDI_STORE / g.id
    files = {f.name for f in job_dir.iterdir()} if job_dir.exists() else set()

    # Audio URL — prefer full mix over vocal
    audio_url = None
    for name in ("musicgen_audio.mp3", "minimax_audio.mp3"):
        if name in files:
            audio_url = f"/api/download/{g.id}/{name}"
            break

    # Vocal URL
    vocal_url = "vocal_track.mp3" in files and f"/api/download/{g.id}/vocal_track.mp3" or None

    # Stems
    stem_urls = {}
    for stem in ("vocals", "bass", "drums", "other"):
        fname = f"{stem}.mp3"
        if fname in files:
            stem_urls[stem] = f"/api/download/{g.id}/{fname}"

    return {
        "id": g.id,
        "date": g.created_at.isoformat(),
        "mode": g.mode,
        "genre": g.genre,
        "tempo": g.tempo,
        "key": g.key,
        "prompt": g.prompt,
        "tracks_count": g.tracks_count,
        "duration": g.duration,
        "time_signature": g.time_signature,
        "midi_url": f"/api/download/{g.id}/{g.midi_filename}" if g.midi_filename else None,
        "audio_url": audio_url,
        "vocal_audio_url": vocal_url,
        "stems": stem_urls,
        "replicate_cost": g.replicate_cost,
    }


@router.get("/usage")
async def get_usage(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    if now.month == 12:
        reset = date(now.year + 1, 1, 1)
    else:
        reset = date(now.year, now.month + 1, 1)

    total_cost = (
        db.query(Generation)
        .filter(Generation.user_id == current_user.id)
        .with_entities(Generation.replicate_cost)
        .all()
    )
    spend = sum(row[0] or 0.0 for row in total_cost)

    return {
        "used": current_user.usage_count,
        "limit": current_user.usage_limit,
        "remaining": max(0, current_user.usage_limit - current_user.usage_count),
        "reset_date": reset.isoformat(),
        "total_spend": round(spend, 4),
    }


@router.get("/library")
async def get_library(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    generations = (
        db.query(Generation)
        .filter(Generation.user_id == current_user.id)
        .order_by(Generation.created_at.desc())
        .limit(200)
        .all()
    )
    return [_generation_to_dict(g) for g in generations]


@router.get("/library/{gen_id}")
async def get_generation(
    gen_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    gen = db.query(Generation).filter(
        Generation.id == gen_id,
        Generation.user_id == current_user.id,
    ).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")
    return _generation_to_dict(gen)


@router.delete("/library/{gen_id}")
async def delete_generation(
    gen_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    gen = db.query(Generation).filter(
        Generation.id == gen_id,
        Generation.user_id == current_user.id,
    ).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")

    db.delete(gen)
    db.commit()

    # Delete files from persistent store
    for base in (MIDI_STORE, UPLOAD_DIR):
        job_dir = base / gen_id
        if job_dir.exists():
            shutil.rmtree(job_dir, ignore_errors=True)

    return {"status": "deleted"}


@router.get("/shared/{gen_id}")
async def get_shared(gen_id: str, db: Session = Depends(get_db)):
    """Public endpoint — no auth required. Returns result data for share links."""
    gen = db.query(Generation).filter(Generation.id == gen_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Not found")
    return _generation_to_dict(gen)
