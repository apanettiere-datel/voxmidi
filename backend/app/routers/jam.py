"""Jam endpoint -- generate accompaniment stems from a riff audio file."""

import json as _json
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from sqlalchemy.orm import Session

from database import get_db, SessionLocal, User, Generation
from middleware.auth import get_current_user
from .jobs import set_job, update_job, try_start, queue_position, get_job
from .generate import UPLOAD_DIR, MIDI_STORE, _persist_files

from pipelines.accompanist import run_accompaniment, VALID_PARTS

router = APIRouter()


@router.post("/jam")
async def jam(
    riff: UploadFile = File(...),
    beatbox: Optional[UploadFile] = File(None),
    parts: str = Form("[]"),
    style_prompt: str = Form(""),
    preset: str = Form(""),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start async jam accompaniment. Returns job_id immediately; poll /api/status/{job_id}."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Monthly limit of {current_user.usage_limit} reached",
        )

    # Validate parts JSON
    try:
        parts_list = _json.loads(parts)
        if not isinstance(parts_list, list):
            raise ValueError("parts must be a JSON array")
    except (ValueError, _json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid parts JSON: {exc}")

    unknown = [p for p in parts_list if p not in VALID_PARTS]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown part id(s): {unknown}. Valid: {sorted(VALID_PARTS)}",
        )

    job_id = str(uuid.uuid4())[:8]

    # Read file bytes before backgrounding (UploadFile stream closes after response)
    riff_content = await riff.read()
    riff_suffix = Path(riff.filename or "riff.webm").suffix or ".webm"

    beatbox_content: Optional[bytes] = None
    beatbox_suffix = ".webm"
    if beatbox:
        beatbox_content = await beatbox.read()
        beatbox_suffix = Path(beatbox.filename or "beatbox.webm").suffix or ".webm"

    current_user.usage_count += 1
    db.commit()

    set_job(job_id, {"status": "processing", "progress": 0})

    args = (
        job_id,
        riff_content,
        riff_suffix,
        beatbox_content,
        beatbox_suffix,
        parts_list,
        style_prompt,
        preset,
        current_user.id,
    )
    started = try_start(job_id, _run_jam, args)

    if not started:
        pos = queue_position(job_id)
        update_job(job_id, {
            "status": "queued",
            "progress": 0,
            "queue_position": pos,
            "message": f"Server is busy. You're #{pos} in queue.",
        })

    return {"job_id": job_id, "status": "queued" if not started else "processing"}


def _run_jam(
    job_id: str,
    riff_content: bytes,
    riff_suffix: str,
    beatbox_content: Optional[bytes],
    beatbox_suffix: str,
    parts_list: list,
    style_prompt: str,
    preset: str,
    user_id: str,
) -> None:
    db = SessionLocal()
    store_dir = MIDI_STORE / job_id
    try:
        update_job(job_id, {"status": "generating_audio", "progress": 10})

        job_dir = UPLOAD_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        riff_path = job_dir / f"riff{riff_suffix}"
        riff_path.write_bytes(riff_content)

        beatbox_path: Optional[str] = None
        if beatbox_content:
            bp = job_dir / f"beatbox{beatbox_suffix}"
            bp.write_bytes(beatbox_content)
            beatbox_path = str(bp)

        update_job(job_id, {"status": "generating_audio", "progress": 30})

        print(f"[jam] job={job_id} parts={parts_list} style_prompt={style_prompt!r} preset={preset!r}")

        try:
            result = run_accompaniment(
                riff_path=str(riff_path),
                beatbox_path=beatbox_path,
                parts=parts_list,
                style_prompt=style_prompt,
                preset=preset,
                job_id=job_id,
                job_dir=job_dir,
            )
        except Exception as e:
            print(f"[jam] pipeline error job={job_id}: {e}")
            import traceback; traceback.print_exc()
            update_job(job_id, {"status": "error", "message": "Jam generation failed. Please try again."})
            return

        if get_job(job_id) and get_job(job_id).get("status") == "cancelled":
            return

        _persist_files(job_dir, store_dir)

        try:
            gen = Generation(
                id=job_id,
                user_id=user_id,
                mode="jam",
                genre="",
                tempo=int(result.get("tempo", 0)),
                key=result.get("key", ""),
                prompt=style_prompt,
                midi_filename="jam_combined.mid",
                tracks_count=len(result.get("tracks", [])),
                duration=result.get("duration", 0.0),
                time_signature="4/4",
                replicate_cost=0.0,
            )
            db.add(gen)
            db.commit()
        except Exception as e:
            print(f"[jam] DB error job={job_id}: {e}")

        update_job(job_id, {"status": "complete", "progress": 100, "result": result})
        print(f"[jam] job={job_id} complete")

    except Exception as e:
        print(f"[jam] unexpected error job={job_id}: {e}")
        import traceback; traceback.print_exc()
        update_job(job_id, {"status": "error", "message": "An unexpected error occurred. Please try again."})
    finally:
        db.close()
