import os
import uuid
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from typing import Optional
from sqlalchemy.orm import Session

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
    lyrics: str = Form(""),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Generate MIDI from text prompt, voice recording, or lyrics.

    Routing:
    - lyrics provided + MINIMAX_API_KEY → MiniMax Music (vocal track)
    - audio provided + REPLICATE_API_TOKEN → MusicGen Melody
    - text only + REPLICATE_API_TOKEN → MusicGen
    - no API keys → mock generator (Demo Mode)
    """
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Monthly limit of {current_user.usage_limit} reached",
        )

    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Determine provider mode for response metadata
    provider = os.environ.get('MIDI_GEN_PROVIDER', 'auto')
    has_replicate = bool(os.environ.get('REPLICATE_API_TOKEN'))
    has_minimax = bool(os.environ.get('MINIMAX_API_KEY'))
    use_api = provider == 'api' or (provider == 'auto' and (has_replicate or has_minimax))
    provider_used = 'mock'
    if use_api and provider != 'mock':
        if lyrics.strip() and has_minimax:
            provider_used = 'minimax'
        elif has_replicate:
            provider_used = 'musicgen'

    # Save raw audio if provided (voice recording or hummed melody)
    raw_audio_path: Optional[str] = None
    if audio:
        suffix = Path(audio.filename or 'input.webm').suffix or '.webm'
        saved_audio = job_dir / f"input{suffix}"
        content = await audio.read()
        saved_audio.write_bytes(content)
        raw_audio_path = str(saved_audio)

    # Build generation prompt
    full_prompt = _build_prompt(genre, tempo, key, prompt)

    # Generate MIDI
    output_midi_path = str(job_dir / "output.mid")
    vocal_audio_path: Optional[str] = None

    print(f"[generate] job={job_id} provider={provider_used} genre={genre} tempo={tempo} key={key}")

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
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    # Post-process
    try:
        final_path = post_process_midi(output_midi_path, str(job_dir / "final.mid"), tempo=tempo, key=key)
        output_midi_path = final_path
    except Exception:
        pass

    output_filename = Path(output_midi_path).name

    # Analyze
    try:
        analysis = analyze_midi(output_midi_path)
    except Exception:
        analysis = {"tempo": tempo, "duration": 0, "time_signature": "4/4", "key": key, "tracks": []}

    # Record generation
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

    # Build vocal audio URL if we have a vocal stem
    vocal_audio_url: Optional[str] = None
    if vocal_audio_path and Path(vocal_audio_path).exists():
        vocal_filename = Path(vocal_audio_path).name
        vocal_audio_url = f"/api/download/{job_id}/{vocal_filename}"

    return {
        "job_id": job_id,
        "midi_url": f"/api/download/{job_id}/{output_filename}",
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


def _build_prompt(genre: str, tempo: int, key: str, user_prompt: str) -> str:
    parts = [f"A {genre.replace('-', ' ').title()} track", f"at {tempo} BPM", f"in the key of {key}"]
    if user_prompt.strip():
        parts.append(f"with {user_prompt.strip()}")
    return ", ".join(parts) + "."
