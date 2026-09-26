"""Drum Grid endpoints -- synchronous, no job queue."""

import asyncio
import functools
import shutil
import uuid
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from pydantic import BaseModel

from database import User
from middleware.auth import get_current_user
from .generate import UPLOAD_DIR, MIDI_STORE, MAX_UPLOAD_BYTES, _persist_files
from pipelines.transcriber import _ensure_wav
from pipelines.drums import analyze_drums, render_drums, VALID_LANES

router = APIRouter()


@router.post("/drums/analyze")
async def drums_analyze(
    beatbox: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Detect drum hits from a beatbox recording and return a quantized 16th-note grid."""
    data = await beatbox.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="beatbox: keep recordings under 25 MB")

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(beatbox.filename or "beatbox.webm").suffix or ".webm"
    raw_path = job_dir / f"beatbox{suffix}"

    print(f"[drums] analyze job={job_id} file={beatbox.filename!r}")

    # Decoding and onset detection are CPU-bound: run them off the event loop.
    # Nothing downloads from this dir later, so it goes when we're done.
    loop = asyncio.get_running_loop()
    try:
        raw_path.write_bytes(data)
        try:
            wav_path = await loop.run_in_executor(None, _ensure_wav, str(raw_path))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Cannot read audio: {exc}")

        try:
            result = await loop.run_in_executor(None, analyze_drums, wav_path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            print(f"[drums] analyze error job={job_id}: {exc}")
            raise HTTPException(status_code=400, detail="Could not analyze audio")
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)

    print(f"[drums] analyze job={job_id} done: tempo={result['tempo']} onsets={len(result['onsets'])}")
    return result


class RenderRequest(BaseModel):
    tempo: float
    steps_per_beat: int
    steps_total: int
    lanes: Dict[str, List[int]]


@router.post("/drums/render")
async def drums_render(
    req: RenderRequest,
    current_user: User = Depends(get_current_user),
):
    """Synthesize a drum pattern grid to WAV + MIDI."""
    if not (40.0 <= req.tempo <= 260.0):
        raise HTTPException(status_code=400, detail=f"tempo must be 40-260, got {req.tempo}")

    if req.steps_per_beat not in (4, 8):
        raise HTTPException(status_code=400, detail=f"steps_per_beat must be 4 or 8, got {req.steps_per_beat}")

    if not (1 <= req.steps_total <= 512):
        raise HTTPException(status_code=400, detail=f"steps_total must be 1-512, got {req.steps_total}")

    unknown = [ln for ln in req.lanes if ln not in VALID_LANES]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown lanes: {unknown}. Valid: {sorted(VALID_LANES)}",
        )

    for lane_name, steps in req.lanes.items():
        bad = [s for s in steps if not (0 <= s < req.steps_total)]
        if bad:
            raise HTTPException(
                status_code=400,
                detail=f"Lane '{lane_name}' has steps out of [0, {req.steps_total}): {bad[:5]}",
            )

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    store_dir = MIDI_STORE / job_id

    print(f"[drums] render job={job_id} tempo={req.tempo} steps_total={req.steps_total}")

    try:
        # Synthesis is CPU-bound: run it off the event loop
        result = await asyncio.get_running_loop().run_in_executor(None, functools.partial(
            render_drums,
            tempo=req.tempo,
            steps_per_beat=req.steps_per_beat,
            steps_total=req.steps_total,
            lanes=req.lanes,
            job_dir=job_dir,
        ))
    except Exception as exc:
        print(f"[drums] render error job={job_id}: {exc}")
        raise HTTPException(status_code=400, detail=f"Render failed: {exc}")

    _persist_files(job_dir, store_dir)

    return {
        "render_id": job_id,
        "audio_url": f"/api/download/{job_id}/drums.wav",
        "midi_url": f"/api/download/{job_id}/drums.mid",
        "duration": result["duration"],
    }
