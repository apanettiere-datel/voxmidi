import uuid
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from typing import Optional
from sqlalchemy.orm import Session

from pipelines.transcriber import transcribe_audio
from pipelines.midi_generator import generate_from_prompt
from pipelines.post_processor import post_process_midi
from pipelines.midi_analyzer import analyze_midi
from database import get_db, User, Generation
from middleware.auth import get_current_user

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")


@router.post("/generate")
async def generate(
    audio: Optional[UploadFile] = File(None),
    source_url: Optional[str] = Form(None),
    prompt: str = Form(""),
    genre: str = Form("edm"),
    tempo: int = Form(128),
    key: str = Form("Am"),
    mode: str = Form("text"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Main generation endpoint. Handles voice, source, and text-only modes."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {current_user.usage_limit} reached")

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    melody_midi_path = None

    # Step 1: Handle audio input (voice mode)
    if mode == "voice" and audio:
        audio_path = job_dir / "input.wav"
        content = await audio.read()
        audio_path.write_bytes(content)
        melody_midi_path = transcribe_audio(str(audio_path), str(job_dir))

    # Step 2: Build prompt for MIDI generator
    full_prompt = build_prompt(genre, tempo, key, prompt)

    # Step 3: Generate MIDI
    output_midi_path = str(job_dir / "output.mid")
    try:
        generate_from_prompt(
            prompt=full_prompt,
            output_path=output_midi_path,
            conditioning_midi=melody_midi_path,
            genre=genre,
            tempo=tempo,
            key=key,
        )
    except Exception as e:
        if melody_midi_path:
            output_midi_path = melody_midi_path
        else:
            raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    # Step 4: Post-process
    try:
        final_path = post_process_midi(output_midi_path, str(job_dir / "final.mid"), tempo=tempo, key=key)
        output_midi_path = final_path
    except Exception:
        pass

    output_filename = Path(output_midi_path).name

    # Step 5: Analyze
    try:
        analysis = analyze_midi(output_midi_path)
    except Exception:
        analysis = {"tempo": tempo, "duration": 0, "time_signature": "4/4", "key": key, "tracks": []}

    # Record generation + increment usage
    gen = Generation(
        id=job_id,
        user_id=current_user.id,
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
    current_user.usage_count += 1
    db.commit()

    return {
        "job_id": job_id,
        "midi_url": f"/api/download/{job_id}/{output_filename}",
        "preview_url": None,
        "genre": genre,
        "tempo": analysis.get("tempo") or tempo,
        "key": analysis.get("key") or key,
        "duration": analysis.get("duration", 0),
        "time_signature": analysis.get("time_signature", "4/4"),
        "tracks": analysis.get("tracks", []),
    }


def build_prompt(genre: str, tempo: int, key: str, user_prompt: str) -> str:
    parts = [f"A {genre.replace('-', ' ').title()} track", f"at {tempo} BPM", f"in the key of {key}"]
    if user_prompt.strip():
        parts.append(f"with {user_prompt.strip()}")
    return ", ".join(parts) + "."
