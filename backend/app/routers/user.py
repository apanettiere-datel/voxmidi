"""User info, usage, and server-side library endpoints."""

from datetime import datetime, timezone, date
from calendar import monthrange

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db, User, Generation
from middleware.auth import get_current_user

router = APIRouter()


@router.get("/usage")
async def get_usage(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return current usage stats for the authenticated user."""
    now = datetime.now(timezone.utc)
    # Calculate reset date: first day of next month
    if now.month == 12:
        reset = date(now.year + 1, 1, 1)
    else:
        reset = date(now.year, now.month + 1, 1)

    return {
        "used": current_user.usage_count,
        "limit": current_user.usage_limit,
        "remaining": max(0, current_user.usage_limit - current_user.usage_count),
        "reset_date": reset.isoformat(),
    }


@router.get("/library")
async def get_library(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return user's generation history, newest first."""
    generations = (
        db.query(Generation)
        .filter(Generation.user_id == current_user.id)
        .order_by(Generation.created_at.desc())
        .limit(200)
        .all()
    )
    return [
        {
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
            "replicate_cost": g.replicate_cost,
        }
        for g in generations
    ]


@router.get("/library/{gen_id}")
async def get_generation(
    gen_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return a single generation by ID."""
    gen = db.query(Generation).filter(
        Generation.id == gen_id,
        Generation.user_id == current_user.id,
    ).first()
    if not gen:
        raise HTTPException(status_code=404, detail="Generation not found")
    return {
        "id": gen.id,
        "date": gen.created_at.isoformat(),
        "mode": gen.mode,
        "genre": gen.genre,
        "tempo": gen.tempo,
        "key": gen.key,
        "prompt": gen.prompt,
        "tracks_count": gen.tracks_count,
        "duration": gen.duration,
        "time_signature": gen.time_signature,
        "midi_url": f"/api/download/{gen.id}/{gen.midi_filename}" if gen.midi_filename else None,
        "replicate_cost": gen.replicate_cost,
    }
