"""Studio endpoints: write a project, rewrite one part, analyze a riff.

All three are synchronous: the composer runs in milliseconds and riff
analysis in a couple of seconds, so none of them go through the job store.

Bad input always comes back as 400 with a readable detail, never 422 or 500.
"""

import json
import random
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import update
from sqlalchemy.orm import Session

from database import get_db, User
from middleware.auth import get_current_user
from pipelines.composer import (
    GENRES, FEELS, SECTION_KINDS, TRACK_IDS, BEATS_PER_BAR,
    compose, write_track, read_prompt, parse_key, parse_chord, normalize_groove,
)
from .generate import UPLOAD_DIR

router = APIRouter()

MAX_TOTAL_BARS = 256
MAX_RIFF_BYTES = 25 * 1024 * 1024


def _check_key(v):
    if v is not None and parse_key(v) is None:
        raise ValueError(f"unknown key {v!r}")
    return v


def _check_chords(v):
    if v is None:
        return v
    bad = [c for c in v if parse_chord(c) is None]
    if bad:
        raise ValueError(f"unknown chords {bad[:3]}")
    return v


def _check_groove(v):
    if v is not None and any(not (0 <= x < BEATS_PER_BAR) for x in v):
        raise ValueError(f"kick positions must be beats inside one bar, 0 to under {BEATS_PER_BAR}")
    return v


class ComposeRequest(BaseModel):
    prompt: str = Field("", max_length=500)
    genre: Optional[str] = None
    feel: Optional[str] = None
    tempo: Optional[int] = Field(None, ge=40, le=240)
    key: Optional[str] = Field(None, max_length=12)
    chords: Optional[List[str]] = Field(None, min_length=1, max_length=8)
    fills: bool = True
    groove: Optional[List[float]] = Field(None, min_length=1, max_length=16)

    @field_validator("groove")
    @classmethod
    def _groove(cls, v):
        return _check_groove(v)

    @field_validator("genre")
    @classmethod
    def _genre(cls, v):
        if v is not None and v not in GENRES:
            raise ValueError(f"genre must be one of {sorted(GENRES)}")
        return v

    @field_validator("feel")
    @classmethod
    def _feel(cls, v):
        if v is not None and v not in FEELS:
            raise ValueError(f"feel must be one of {list(FEELS)}")
        return v

    @field_validator("key")
    @classmethod
    def _key(cls, v):
        return _check_key(v)

    @field_validator("chords")
    @classmethod
    def _chords(cls, v):
        return _check_chords(v)


class SectionIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=40)
    kind: str
    bars: int = Field(..., ge=1, le=64)
    chords: List[str] = Field(..., min_length=1, max_length=8)

    @field_validator("kind")
    @classmethod
    def _kind(cls, v):
        if v not in SECTION_KINDS:
            raise ValueError(f"kind must be one of {list(SECTION_KINDS)}")
        return v

    @field_validator("chords")
    @classmethod
    def _chords(cls, v):
        return _check_chords(v)


class RegenerateRequest(BaseModel):
    track: str
    key: str = Field(..., max_length=12)
    genre: str
    feel: Optional[str] = None
    sections: List[SectionIn] = Field(..., min_length=1, max_length=32)
    start_beat: Optional[float] = Field(None, ge=0)
    end_beat: Optional[float] = Field(None, gt=0)
    seed: int = Field(..., ge=0, le=2 ** 31 - 1)
    fills: bool = True
    groove: Optional[List[float]] = Field(None, min_length=1, max_length=16)

    @field_validator("groove")
    @classmethod
    def _groove(cls, v):
        return _check_groove(v)

    @field_validator("track")
    @classmethod
    def _track(cls, v):
        if v not in TRACK_IDS:
            raise ValueError(f"track must be one of {list(TRACK_IDS)}")
        return v

    @field_validator("genre")
    @classmethod
    def _genre(cls, v):
        if v not in GENRES:
            raise ValueError(f"genre must be one of {sorted(GENRES)}")
        return v

    @field_validator("feel")
    @classmethod
    def _feel(cls, v):
        if v is not None and v not in FEELS:
            raise ValueError(f"feel must be one of {list(FEELS)}")
        return v

    @field_validator("key")
    @classmethod
    def _key(cls, v):
        return _check_key(v)


async def _parse(request: Request, model):
    """Parse a JSON body into `model`, turning every failure into a 400."""
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ())) or "body"
        msg = first.get("msg", "invalid").removeprefix("Value error, ")
        raise HTTPException(status_code=400, detail=f"{where}: {msg}")


@router.post("/studio/compose")
async def studio_compose(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Write a new project from a description. Counts as one song against the monthly limit."""
    req = await _parse(request, ComposeRequest)

    heard = read_prompt(req.prompt)
    seed = random.randint(0, 2 ** 31 - 1)
    project = compose(
        genre=req.genre or heard["genre"],
        feel=req.feel or heard["feel"],
        tempo=req.tempo or heard["tempo"],
        key=req.key or heard["key"],
        seed=seed,
        chords=req.chords,
        fills=req.fills,
        groove=req.groove,
        mode=heard["mode"],
    )

    # Charge one song only if the user is under their limit, in one statement,
    # so two concurrent requests can't both slip under it.
    result = db.execute(
        update(User)
        .where(User.id == current_user.id, User.usage_count < User.usage_limit)
        .values(usage_count=User.usage_count + 1)
    )
    db.commit()
    if result.rowcount != 1:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} songs reached")
    db.refresh(current_user)

    project["id"] = str(uuid.uuid4())[:8]
    project["prompt"] = req.prompt
    project["heard"] = heard
    project["usage"] = {"used": current_user.usage_count, "limit": current_user.usage_limit}
    print(f"[studio] compose user={current_user.id} genre={project['genre']} tempo={project['tempo']} key={project['key']}")
    return project


@router.post("/studio/regenerate")
async def studio_regenerate(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """Rewrite one part, optionally only inside [start_beat, end_beat). Free: no usage is counted."""
    req = await _parse(request, RegenerateRequest)

    sections = [s.model_dump() for s in req.sections]
    total_beats = sum(s["bars"] for s in sections) * BEATS_PER_BAR
    if total_beats > MAX_TOTAL_BARS * BEATS_PER_BAR:
        raise HTTPException(status_code=400, detail=f"sections: at most {MAX_TOTAL_BARS} bars in total")
    start = req.start_beat if req.start_beat is not None else 0.0
    end = req.end_beat if req.end_beat is not None else float(total_beats)
    if end <= start:
        raise HTTPException(status_code=400, detail="end_beat must be after start_beat")

    notes = write_track(req.track, sections, parse_key(req.key), req.genre, req.feel, req.seed, req.fills,
                        normalize_groove(req.groove))
    notes = [n for n in notes if start <= n["t"] < end]
    return {"track": req.track, "start_beat": start, "end_beat": end, "notes": notes}


@router.post("/studio/analyze-riff")
async def studio_analyze_riff(
    riff: Optional[UploadFile] = File(None),
    tempo: Optional[str] = Form(None),
    start: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
):
    """Detect tempo, bar 1, key, per-bar chords and strum accents in a riff recording."""
    from pipelines.transcriber import _ensure_wav
    from pipelines.riff_analysis import analyze_riff

    if riff is None:
        raise HTTPException(status_code=400, detail="riff: an audio file is required")
    # Optional click grid for takes recorded to the app's metronome
    tempo_hint = start_hint = None
    try:
        if tempo not in (None, ""):
            tempo_hint = float(tempo)
        if start not in (None, ""):
            start_hint = float(start)
    except ValueError:
        raise HTTPException(status_code=400, detail="tempo and start must be numbers")
    if tempo_hint is not None and not (40 <= tempo_hint <= 240):
        raise HTTPException(status_code=400, detail="tempo: must be 40-240")
    if start_hint is not None and not (0 <= start_hint <= 30):
        raise HTTPException(status_code=400, detail="start: must be 0-30 seconds")
    data = await riff.read()
    if not data:
        raise HTTPException(status_code=400, detail="riff: the file is empty")
    if len(data) > MAX_RIFF_BYTES:
        raise HTTPException(status_code=400, detail="riff: keep recordings under 25 MB")

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(riff.filename or "riff.webm").suffix or ".webm"
    raw_path = job_dir / f"riff{suffix}"
    raw_path.write_bytes(data)

    try:
        wav_path = _ensure_wav(str(raw_path))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"riff: cannot read audio ({exc})")
    try:
        result = analyze_riff(wav_path, tempo_hint=tempo_hint, start_hint=start_hint)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    print(f"[studio] analyze-riff user={current_user.id} tempo={result['tempo']} key={result['key']} bars={result['bars']}")
    return result


# ─── AI drums ────────────────────────────────────────────────────────────────

class DrumNote(BaseModel):
    p: int
    t: float = Field(..., ge=0)
    d: float = Field(0.1, gt=0, le=16)
    v: int = Field(..., ge=1, le=127)


class AiDrumsRequest(BaseModel):
    tempo: int = Field(..., ge=40, le=240)
    total_beats: int = Field(..., ge=4, le=MAX_TOTAL_BARS * BEATS_PER_BAR)
    notes: List[DrumNote] = Field(..., min_length=1, max_length=20000)
    style: str
    strength: float = Field(0.5, ge=0.2, le=0.9)

    @field_validator("style")
    @classmethod
    def _style(cls, v):
        from pipelines.drum_ai import STYLES
        if v not in STYLES:
            raise ValueError(f"style must be one of {list(STYLES)}")
        return v


def _run_ai_drums(job_id: str, req: dict, user_id: str, charged: bool):
    from pipelines.drum_ai import make_ai_drums
    from .generate import MIDI_STORE, _persist_files
    from .jobs import update_job, get_job

    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    def progress(pct, status):
        if (get_job(job_id) or {}).get("status") == "cancelled":
            raise RuntimeError("cancelled")
        update_job(job_id, {"status": status, "progress": pct})

    try:
        result = make_ai_drums(req["notes"], req["tempo"], req["total_beats"], req["style"], req["strength"], job_dir, progress)
        _persist_files(job_dir, MIDI_STORE / job_id)
        result["audio_url"] = f"/api/download/{job_id}/{result.pop('file')}"
        update_job(job_id, {"status": "complete", "progress": 100, "result": result})
        print(f"[studio] ai drums job={job_id} provider={result['provider']} match={result['match']}% offset={result['offset_ms']}ms")
    except Exception as exc:
        # A failed or rejected render doesn't cost the user a song
        if charged:
            from database import SessionLocal
            db = SessionLocal()
            try:
                db.execute(update(User).where(User.id == user_id, User.usage_count > 0).values(usage_count=User.usage_count - 1))
                db.commit()
            finally:
                db.close()
        cancelled = str(exc) == "cancelled"
        update_job(job_id, {"status": "cancelled" if cancelled else "error", "message": None if cancelled else str(exc)})
        print(f"[studio] ai drums job={job_id} failed: {exc}")


@router.post("/studio/drums/ai")
async def studio_ai_drums(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Re-skin the song's drum pattern into real drums. With a live provider this counts as one song."""
    from pipelines.drum_ai import provider_name, DRUM_PITCHES
    from .jobs import set_job, try_start

    req = await _parse(request, AiDrumsRequest)
    bad = [n.p for n in req.notes if n.p not in DRUM_PITCHES]
    if bad:
        raise HTTPException(status_code=400, detail=f"notes: unknown drum pitches {sorted(set(bad))[:5]}")
    if any(n.t >= req.total_beats for n in req.notes):
        raise HTTPException(status_code=400, detail="notes: every note must start before total_beats")

    provider = provider_name()
    charged = provider != "mock"
    if charged:
        result = db.execute(
            update(User)
            .where(User.id == current_user.id, User.usage_count < User.usage_limit)
            .values(usage_count=User.usage_count + 1)
        )
        db.commit()
        if result.rowcount != 1:
            raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} songs reached")

    job_id = str(uuid.uuid4())[:8]
    set_job(job_id, {"status": "queued", "progress": 0})
    payload = req.model_dump()
    started = try_start(job_id, _run_ai_drums, (job_id, payload, current_user.id, charged))
    return {"job_id": job_id, "status": "processing" if started else "queued", "provider": provider}
