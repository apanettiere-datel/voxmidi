"""User info, usage, and library endpoints."""

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

AUDIO_NAMES = ("musicgen_audio.mp3", "minimax_audio.mp3", "full_mix.mp3", "full_mix.wav")


def _generation_to_dict(g: Generation) -> dict:
    job_dir = MIDI_STORE / g.id
    files = {f.name: f for f in job_dir.iterdir()} if job_dir.exists() else {}

    # Full mix audio — try well-known names, then any mp3 that isn't a stem or vocal
    audio_url = None
    for name in AUDIO_NAMES:
        if name in files:
            audio_url = f"/api/download/{g.id}/{name}"
            break
    if not audio_url:
        for fname in files:
            if (fname.endswith(".mp3") or fname.endswith(".wav")) and \
               fname not in ("vocal_track.mp3",) and \
               not any(fname.startswith(s) for s in ("vocals.", "bass.", "drums.", "other.")):
                audio_url = f"/api/download/{g.id}/{fname}"
                break

    # Vocal URL
    vocal_url = None
    if "vocal_track.mp3" in files:
        vocal_url = f"/api/download/{g.id}/vocal_track.mp3"

    # Audio stems (mp3)
    stem_audio_urls = {}
    for stem in ("vocals", "bass", "drums", "other"):
        fname = f"{stem}.mp3"
        if fname in files:
            stem_audio_urls[stem] = f"/api/download/{g.id}/{fname}"

    # MIDI URL
    midi_url = None
    if g.midi_filename and g.midi_filename in files:
        midi_url = f"/api/download/{g.id}/{g.midi_filename}"
    elif "output.mid" in files:
        midi_url = f"/api/download/{g.id}/output.mid"
    elif "final.mid" in files:
        midi_url = f"/api/download/{g.id}/final.mid"

    # Display label for prompt
    prompt = g.prompt or ""
    if prompt == "file_upload":
        prompt = "Uploaded audio"
    elif prompt == "voice_recording":
        prompt = "Voice recording"

    return {
        "id": g.id,
        "date": g.created_at.isoformat(),
        "mode": g.mode,
        "genre": g.genre,
        "tempo": g.tempo,
        "key": g.key,
        "prompt": prompt,
        "tracks_count": g.tracks_count,
        "duration": g.duration,
        "time_signature": g.time_signature or "4/4",
        "midi_url": midi_url,
        "audio_url": audio_url,
        "vocal_audio_url": vocal_url,
        "stems": stem_audio_urls,
        "replicate_cost": g.replicate_cost or 0.0,
        "is_favorite": getattr(g, "is_favorite", False) or False,
        "is_shared": getattr(g, "is_shared", False) or False,
    }


@router.get("/usage")
async def get_usage(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    reset = date(now.year + 1, 1, 1) if now.month == 12 else date(now.year, now.month + 1, 1)

    rows = (
        db.query(Generation.replicate_cost)
        .filter(Generation.user_id == current_user.id)
        .all()
    )
    spend = sum(r[0] or 0.0 for r in rows)

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
    gens = (
        db.query(Generation)
        .filter(Generation.user_id == current_user.id)
        .order_by(Generation.created_at.desc())
        .limit(200)
        .all()
    )
    return [_generation_to_dict(g) for g in gens]


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


@router.post("/library/{gen_id}/favorite")
async def toggle_favorite(
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
    gen.is_favorite = not getattr(gen, "is_favorite", False)
    db.commit()
    return {"is_favorite": gen.is_favorite}


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

    for base in (MIDI_STORE, UPLOAD_DIR):
        job_dir = base / gen_id
        if job_dir.exists():
            shutil.rmtree(job_dir, ignore_errors=True)

    return {"status": "deleted"}


@router.post("/library/{gen_id}/share")
async def share_generation(
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
    gen.is_shared = True
    db.commit()
    return {"is_shared": True, "share_url": f"/share/{gen_id}"}


@router.get("/shared/{gen_id}")
async def get_shared(gen_id: str, db: Session = Depends(get_db)):
    """Public endpoint — no auth required."""
    gen = db.query(Generation).filter(Generation.id == gen_id).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Not found")
    return _generation_to_dict(gen)
