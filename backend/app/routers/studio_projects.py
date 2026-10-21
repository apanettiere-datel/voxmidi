"""Saved studio songs: a project is the full song JSON (sections, tracks, clips)
stored per user, plus the audio takes it references stored as WAV files so a
loaded song plays its recordings and AI parts on any device.

Projects live in the studio_projects table. Takes are content-addressed by their
client id under a per-user folder, uploaded once and fetched on load when the
browser doesn't already have them cached.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from database import get_db, User, StudioProject
from middleware.auth import get_current_user
from .generate import MIDI_STORE

router = APIRouter()

TAKES_DIR = MIDI_STORE.parent / "user_takes"
MAX_PROJECT_BYTES = 8 * 1024 * 1024
MAX_TAKE_BYTES = 50 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ProjectSaveRequest(BaseModel):
    name: str = Field("Untitled song", max_length=120)
    tempo: int = Field(120, ge=40, le=240)
    data: dict


async def _parse(request: Request, model):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ())) or "body"
        raise HTTPException(status_code=400, detail=f"{where}: {first.get('msg', 'invalid')}")


def _row(p: StudioProject) -> dict:
    return {"id": p.id, "name": p.name, "tempo": p.tempo,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            "created_at": p.created_at.isoformat() if p.created_at else None}


@router.get("/studio/projects")
async def list_projects(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every saved song for this user, most recently updated first."""
    rows = (db.query(StudioProject)
            .filter(StudioProject.user_id == current_user.id)
            .order_by(StudioProject.updated_at.desc()).all())
    return {"projects": [_row(p) for p in rows]}


@router.post("/studio/projects")
async def create_project(request: Request, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Save the current song as a new project. Returns its id."""
    req = await _parse(request, ProjectSaveRequest)
    blob = json.dumps(req.data, separators=(",", ":"))
    if len(blob) > MAX_PROJECT_BYTES:
        raise HTTPException(status_code=400, detail="data: the song is too large to save")
    p = StudioProject(user_id=current_user.id, name=req.name.strip() or "Untitled song", tempo=req.tempo, data=blob)
    db.add(p)
    db.commit()
    db.refresh(p)
    print(f"[studio] project create user={current_user.id} id={p.id} name={p.name!r}")
    return _row(p)


@router.get("/studio/projects/{project_id}")
async def get_project(project_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The full saved song, including its track and clip data."""
    p = db.query(StudioProject).filter(StudioProject.id == project_id, StudioProject.user_id == current_user.id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="Song not found")
    try:
        data = json.loads(p.data) if p.data else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Saved song is corrupt")
    return {**_row(p), "data": data}


@router.put("/studio/projects/{project_id}")
async def update_project(project_id: str, request: Request, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Overwrite a saved song with the current one."""
    req = await _parse(request, ProjectSaveRequest)
    p = db.query(StudioProject).filter(StudioProject.id == project_id, StudioProject.user_id == current_user.id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="Song not found")
    blob = json.dumps(req.data, separators=(",", ":"))
    if len(blob) > MAX_PROJECT_BYTES:
        raise HTTPException(status_code=400, detail="data: the song is too large to save")
    p.name = req.name.strip() or p.name
    p.tempo = req.tempo
    p.data = blob
    p.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _row(p)


@router.delete("/studio/projects/{project_id}")
async def delete_project(project_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Delete a saved song. Its uploaded takes are left for any other song that shares them."""
    p = db.query(StudioProject).filter(StudioProject.id == project_id, StudioProject.user_id == current_user.id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="Song not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


def _take_path(user_id: str, take_id: str) -> Path:
    return TAKES_DIR / user_id / f"{take_id}.wav"


@router.post("/studio/takes/{take_id}")
async def upload_take(take_id: str, take: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    """Store one audio take (a recording or an AI part) so a saved song can replay
    it later. Content-addressed by the client's take id; re-uploading is a no-op."""
    if not SAFE_ID.match(take_id):
        raise HTTPException(status_code=400, detail="take_id: invalid")
    path = _take_path(current_user.id, take_id)
    if path.exists():
        return {"ok": True, "stored": False}  # already have it
    data = await take.read()
    if not data:
        raise HTTPException(status_code=400, detail="take: the file is empty")
    if len(data) > MAX_TAKE_BYTES:
        raise HTTPException(status_code=400, detail="take: keep audio under 50 MB")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"ok": True, "stored": True}


@router.get("/studio/takes/{take_id}")
async def get_take(take_id: str, current_user: User = Depends(get_current_user)):
    """Fetch a stored take's WAV, scoped to the owner."""
    if not SAFE_ID.match(take_id):
        raise HTTPException(status_code=400, detail="take_id: invalid")
    path = _take_path(current_user.id, take_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Take not found")
    return FileResponse(str(path), media_type="audio/wav")
