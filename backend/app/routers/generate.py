import os
import re
import uuid
import shutil
import threading
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from typing import Optional
from sqlalchemy.orm import Session

from pipelines.midi_generator import generate_from_prompt
from pipelines.post_processor import post_process_midi
from pipelines.midi_analyzer import analyze_midi
from database import get_db, SessionLocal, User, Generation
from middleware.auth import get_current_user
from .jobs import set_job, update_job, try_start, queue_position

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")
MIDI_STORE = Path("/app/data/midi")


@router.post("/generate")
async def generate(
    audio: Optional[UploadFile] = File(None),
    source_url: Optional[str] = Form(None),
    prompt: str = Form(""),
    genre: str = Form("pop"),
    tempo: int = Form(120),
    key: str = Form("Am"),
    mode: str = Form("text"),
    lyrics: str = Form(""),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start async MIDI generation. Returns job_id immediately; poll /api/status/{job_id}."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Monthly limit of {current_user.usage_limit} reached",
        )

    job_id = str(uuid.uuid4())[:8]

    # Read audio bytes before spawning thread (UploadFile is not thread-safe)
    audio_content: Optional[bytes] = None
    audio_suffix = ".webm"
    if audio:
        audio_content = await audio.read()
        audio_suffix = Path(audio.filename or "input.webm").suffix or ".webm"

    # Increment usage eagerly so concurrent requests don't exceed limits
    current_user.usage_count += 1
    db.commit()

    set_job(job_id, {"status": "processing", "progress": 0})

    args = (job_id, audio_content, audio_suffix, source_url, prompt, genre, tempo, key, mode, lyrics, current_user.id)
    started = try_start(job_id, _run_generate, args)

    if not started:
        pos = queue_position(job_id)
        update_job(job_id, {
            "status": "queued",
            "progress": 0,
            "queue_position": pos,
            "message": f"Server is busy. You're #{pos} in queue.",
        })

    return {"job_id": job_id, "status": "queued" if not started else "processing"}


def _run_generate(
    job_id: str,
    audio_content: Optional[bytes],
    audio_suffix: str,
    source_url: Optional[str],
    prompt: str,
    genre: str,
    tempo: int,
    key: str,
    mode: str,
    lyrics: str,
    user_id: str,
) -> None:
    db = SessionLocal()
    try:
        update_job(job_id, {"status": "generating_audio", "progress": 20})

        job_dir = UPLOAD_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        raw_audio_path: Optional[str] = None
        if audio_content:
            saved = job_dir / f"input{audio_suffix}"
            saved.write_bytes(audio_content)
            raw_audio_path = str(saved)

        full_prompt = _build_prompt(genre, tempo, key, prompt)

        provider = os.environ.get("MIDI_GEN_PROVIDER", "auto")
        has_replicate = bool(os.environ.get("REPLICATE_API_TOKEN"))
        has_minimax = bool(os.environ.get("MINIMAX_API_KEY"))
        use_api = provider == "api" or (provider == "auto" and (has_replicate or has_minimax))
        provider_used = "mock"
        if use_api and provider != "mock":
            if lyrics.strip() and has_minimax:
                provider_used = "minimax"
            elif has_replicate:
                provider_used = "musicgen"

        print(f"[generate] job={job_id} provider={provider_used} genre={genre} tempo={tempo} key={key}")

        output_midi_path = str(job_dir / "output.mid")
        vocal_audio_path: Optional[str] = None

        try:
            output_midi_path, vocal_audio_path = generate_from_prompt(
                prompt=full_prompt,
                output_path=output_midi_path,
                genre=genre,
                tempo=tempo,
                key=key,
                lyrics=lyrics,
                audio_path=raw_audio_path,
            )
        except Exception as e:
            err_str = str(e).lower()
            if any(w in err_str for w in ("replicate", "rate limit", "timeout", "model")):
                msg = "Music generation service is temporarily busy. Please try again in a minute."
            else:
                msg = f"Generation failed. Please try again."
            print(f"[generate] error job={job_id}: {e}")
            update_job(job_id, {"status": "error", "message": msg})
            return

        update_job(job_id, {"status": "separating_stems", "progress": 50})

        try:
            final_path = post_process_midi(output_midi_path, str(job_dir / "final.mid"), tempo=tempo, key=key)
            output_midi_path = final_path
        except Exception:
            pass

        update_job(job_id, {"status": "transcribing", "progress": 80})

        output_filename = Path(output_midi_path).name

        try:
            analysis = analyze_midi(output_midi_path)
        except Exception:
            analysis = {"tempo": tempo, "duration": 0, "time_signature": "4/4", "key": key, "tracks": []}

        # Find generated audio file (MP3 produced by MusicGen/MiniMax before MIDI extraction)
        generated_audio_path: Optional[str] = None
        for mp3 in job_dir.glob("*.mp3"):
            # Exclude the vocal stem which is handled separately
            if vocal_audio_path and str(mp3) == vocal_audio_path:
                continue
            if "input" not in mp3.name:
                generated_audio_path = str(mp3)
                break

        # Persist to mounted data volume so files survive container restarts
        try:
            MIDI_STORE.mkdir(parents=True, exist_ok=True)
            store_dir = MIDI_STORE / job_id
            store_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(output_midi_path, store_dir / output_filename)
            if generated_audio_path and Path(generated_audio_path).exists():
                shutil.copy2(generated_audio_path, store_dir / Path(generated_audio_path).name)
            if vocal_audio_path and Path(vocal_audio_path).exists():
                shutil.copy2(vocal_audio_path, store_dir / Path(vocal_audio_path).name)
        except Exception as e:
            print(f"[generate] persist failed job={job_id}: {e}")

        try:
            gen = Generation(
                id=job_id,
                user_id=user_id,
                mode=mode,
                genre=genre,
                tempo=tempo,
                key=key,
                prompt=prompt,
                midi_filename=output_filename,
                tracks_count=len(analysis.get("tracks", [])),
                duration=analysis.get("duration", 0.0),
                time_signature=analysis.get("time_signature", "4/4"),
                replicate_cost=0.0,
            )
            db.add(gen)
            db.commit()
        except Exception as e:
            print(f"[generate] DB error job={job_id}: {e}")

        vocal_audio_url: Optional[str] = None
        if vocal_audio_path and Path(vocal_audio_path).exists():
            vocal_audio_url = f"/api/download/{job_id}/{Path(vocal_audio_path).name}"

        audio_url: Optional[str] = None
        if generated_audio_path and Path(generated_audio_path).exists():
            audio_url = f"/api/download/{job_id}/{Path(generated_audio_path).name}"

        result = {
            "job_id": job_id,
            "midi_url": f"/api/download/{job_id}/{output_filename}",
            "audio_url": audio_url,
            "vocal_audio_url": vocal_audio_url,
            "preview_url": None,
            "provider": provider_used,
            "genre": genre,
            "tempo": analysis.get("tempo") or tempo,
            "key": analysis.get("key") or key,
            "duration": analysis.get("duration", 0),
            "time_signature": analysis.get("time_signature", "4/4"),
            "tracks": analysis.get("tracks", []),
        }

        update_job(job_id, {"status": "complete", "progress": 100, "result": result})

    except Exception as e:
        print(f"[generate] unexpected error job={job_id}: {e}")
        update_job(job_id, {"status": "error", "message": "An unexpected error occurred. Please try again."})
    finally:
        db.close()


def parse_prompt(prompt: str) -> dict:
    """Extract genre/tempo/key from a natural language prompt. Used by frontend-facing parse endpoint too."""
    result: dict = {"genre": None, "tempo": None, "key": None}

    bpm_match = re.search(r"\b(\d{2,3})\s*(?:bpm)\b", prompt, re.IGNORECASE)
    if not bpm_match:
        bpm_match = re.search(r"\bat\s+(\d{2,3})\b", prompt, re.IGNORECASE)
    if bpm_match:
        bpm = int(bpm_match.group(1))
        if 60 <= bpm <= 220:
            result["tempo"] = bpm

    key_match = re.search(
        r"\b(?:in\s+(?:the\s+key\s+of\s+)?|key\s+of\s+)([A-G][b#]?m?)\b", prompt, re.IGNORECASE
    )
    if not key_match:
        key_match = re.search(r"\b([A-G][b#]?m)\b", prompt)
    if key_match:
        result["key"] = key_match.group(1)

    genre_map = [
        ("edm", ["edm", "electronic dance"]),
        ("house", ["tech house", "deep house", "progressive house", "house"]),
        ("trap", ["trap", "drill"]),
        ("lo-fi-hip-hop", ["lo-fi", "lofi", "lo fi", "chillhop", "chill hop"]),
        ("hip-hop", ["hip hop", "hip-hop", "hiphop", "rap"]),
        ("drum-and-bass", ["drum and bass", "dnb", "d&b", "drum & bass"]),
        ("synthwave", ["synthwave", "retrowave", "outrun", "80s synth"]),
        ("pop", ["pop"]),
        ("rock", ["rock", "indie rock", "alt rock"]),
        ("jazz", ["jazz", "bebop", "swing"]),
        ("ambient", ["ambient", "atmospheric"]),
        ("r-and-b", ["r&b", "rnb", "r and b", "soul"]),
        ("classical", ["classical", "orchestral"]),
    ]
    lower = prompt.lower()
    for genre_id, keywords in genre_map:
        if any(kw in lower for kw in keywords):
            result["genre"] = genre_id
            break

    return result


def _build_prompt(genre: str, tempo: int, key: str, user_prompt: str) -> str:
    parts = [f"A {genre.replace('-', ' ').title()} track", f"at {tempo} BPM", f"in the key of {key}"]
    if user_prompt.strip():
        parts.append(f"with {user_prompt.strip()}")
    return ", ".join(parts) + "."
