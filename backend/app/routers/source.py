import os
import shutil
import uuid
import threading
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from typing import Optional
from sqlalchemy.orm import Session

from pipelines.audio_download import download_audio
from pipelines.separator import separate_stems
from pipelines.transcriber import transcribe_audio
from pipelines.midi_analyzer import analyze_midi
from database import get_db, SessionLocal, User, Generation
from middleware.auth import get_current_user
from .jobs import set_job, update_job, try_start, queue_position

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")
MIDI_STORE = Path("/app/data/midi")
STEM_PROGRAMS = {"vocals": 0, "bass": 33, "drums": 0, "other": 4, "guitar": 25, "piano": 0}
REPLICATE_DEMUCS_COST = 0.02


@router.post("/source")
async def extract_source(
    url: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    start_time: Optional[float] = Form(None),
    end_time: Optional[float] = Form(None),
    genre: str = Form("pop"),
    tempo: int = Form(120),
    key: str = Form("Am"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Async stem extraction. Accepts either a URL or uploaded audio file."""
    if not url and not file:
        raise HTTPException(status_code=400, detail="Provide either a URL or an audio file.")

    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} reached")

    job_id = str(uuid.uuid4())[:8]

    file_content: Optional[bytes] = None
    file_suffix = ".mp3"
    if file:
        file_content = await file.read()
        file_suffix = Path(file.filename or "upload.mp3").suffix or ".mp3"

    current_user.usage_count += 1
    db.commit()

    set_job(job_id, {"status": "processing", "progress": 0})

    args = (job_id, url, file_content, file_suffix, start_time, end_time, genre, tempo, key, current_user.id)
    started = try_start(job_id, _run_source, args)

    if not started:
        pos = queue_position(job_id)
        update_job(job_id, {
            "status": "queued",
            "progress": 0,
            "queue_position": pos,
            "message": f"Server is busy. You're #{pos} in queue.",
        })

    return {"job_id": job_id, "status": "queued" if not started else "processing"}


def _run_source(
    job_id: str,
    url: Optional[str],
    file_content: Optional[bytes],
    file_suffix: str,
    start_time: Optional[float],
    end_time: Optional[float],
    genre: str,
    tempo: int,
    key: str,
    user_id: str,
) -> None:
    db = SessionLocal()
    try:
        update_job(job_id, {"status": "downloading", "progress": 10})

        job_dir = UPLOAD_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        separator_provider = os.environ.get("SEPARATOR_PROVIDER", "mock")
        audio_path = str(job_dir / "source_audio.wav")

        if file_content:
            # Direct file upload — skip yt-dlp entirely
            uploaded = job_dir / f"upload{file_suffix}"
            uploaded.write_bytes(file_content)
            audio_path = str(uploaded)
        elif separator_provider != "mock" and url:
            try:
                audio_path = download_audio(url, str(job_dir), start_time=start_time, end_time=end_time)
            except RuntimeError as e:
                update_job(job_id, {"status": "error", "message": str(e)})
                return
            except Exception as e:
                update_job(job_id, {"status": "error", "message": f"Download failed: {e}"})
                return

        update_job(job_id, {"status": "separating_stems", "progress": 30})

        try:
            stems = separate_stems(audio_path, str(job_dir))
        except Exception as e:
            update_job(job_id, {"status": "error", "message": f"Stem separation failed: {e}"})
            return

        update_job(job_id, {"status": "transcribing", "progress": 60})

        stem_midis: dict = {}
        all_tracks: list = []
        replicate_cost = REPLICATE_DEMUCS_COST if separator_provider == "api" else 0.0

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
                # Skip failed stems rather than aborting the whole job
                print(f"[source] stem {stem_name} failed job={job_id}: {ex}")
                stem_midis[stem_name] = {"error": str(ex)}

        # Persist MIDI files
        try:
            MIDI_STORE.mkdir(parents=True, exist_ok=True)
            store_dir = MIDI_STORE / job_id
            store_dir.mkdir(parents=True, exist_ok=True)
            for mid_file in job_dir.glob("*.mid"):
                shutil.copy2(mid_file, store_dir / mid_file.name)
        except Exception as e:
            print(f"[source] persist failed job={job_id}: {e}")

        try:
            gen = Generation(
                id=job_id,
                user_id=user_id,
                mode="source",
                genre=genre or "unknown",
                tempo=tempo or 120,
                key=key or "Am",
                prompt=url or "file_upload",
                midi_filename="",
                tracks_count=len(all_tracks),
                replicate_cost=replicate_cost,
            )
            db.add(gen)
            db.commit()
        except Exception as e:
            print(f"[source] DB error job={job_id}: {e}")

        result = {
            "job_id": job_id,
            "stems": stem_midis,
            "tracks": all_tracks,
            "tempo": tempo,
            "key": key,
        }

        update_job(job_id, {"status": "complete", "progress": 100, "result": result})

    except Exception as e:
        print(f"[source] unexpected error job={job_id}: {e}")
        update_job(job_id, {"status": "error", "message": "An unexpected error occurred. Please try again."})
    finally:
        db.close()
