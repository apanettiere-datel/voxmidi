"""MIDI Workshop endpoints: AI-generated and reference-based MIDI creation."""

import os
import uuid
import asyncio
import functools
from pathlib import Path
from fastapi import APIRouter, Form, UploadFile, File, Depends, HTTPException
from fastapi.responses import JSONResponse, FileResponse

from database import User
from middleware.auth import get_current_user
from .generate import MAX_UPLOAD_BYTES, safe_job_file, valid_job_id

router = APIRouter()

UPLOAD_DIR = Path("/tmp/voxmidi")
MAX_PROMPT_CHARS = 1000


async def _read_audio_upload(upload: UploadFile, field: str) -> bytes:
    """Read an uploaded audio file, 400 if it is empty, too big or clearly not audio."""
    ctype = (upload.content_type or "").split(";")[0].strip().lower()
    if ctype and not (ctype.startswith("audio/") or ctype.startswith("video/")
                      or ctype == "application/octet-stream"):
        raise HTTPException(status_code=400, detail=f"{field}: must be an audio file")
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail=f"{field}: the file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail=f"{field}: keep uploads under 25 MB")
    return content


async def _check_decodes(path: Path, field: str) -> str:
    """400 unless the file decodes as audio. Returns a soundfile-readable WAV path."""
    from pipelines.transcriber import _ensure_wav
    try:
        return await asyncio.get_running_loop().run_in_executor(None, _ensure_wav, str(path))
    except Exception as e:
        print(f"[workshop] undecodable {field}: {e}")
        raise HTTPException(status_code=400, detail=f"{field}: could not read this file as audio")


def _new_job_dir():
    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / f"workshop_{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_id, job_dir


@router.post("/workshop/generate")
async def workshop_generate(
    prompt: str = Form(""),
    genre: str = Form(""),
    resolution: int = Form(480),
    melody_audio: UploadFile = File(None),
    current_user: User = Depends(get_current_user),
):
    """
    Generate a multi-track MIDI file from a text description.
    Optionally accepts a melody audio file (hummed/sung) to generate accompaniment around.
    """
    from pipelines.anticipatory_generator import generate_midi
    from pipelines.transcriber import transcribe_audio

    if len(prompt) > MAX_PROMPT_CHARS or len(genre) > 100:
        raise HTTPException(status_code=400, detail=f"prompt: keep it under {MAX_PROMPT_CHARS} characters")

    content = None
    if melody_audio and melody_audio.filename:
        content = await _read_audio_upload(melody_audio, "melody_audio")

    job_id, job_dir = _new_job_dir()

    melody_midi_path = None

    # If melody audio provided, transcribe it first
    if content is not None:
        audio_path = job_dir / "melody_input.webm"
        audio_path.write_bytes(content)
        wav_path = await _check_decodes(audio_path, "melody_audio")

        try:
            melody_midi_path = await asyncio.get_running_loop().run_in_executor(None, functools.partial(
                transcribe_audio, wav_path, str(job_dir), output_name="melody_transcribed.mid"
            ))
        except Exception as e:
            print(f"[workshop] Melody transcription failed: {e}")

    # Generate MIDI
    try:
        loop = asyncio.get_running_loop()
        midi_resolution = max(120, min(960, resolution))
        midi_path = await loop.run_in_executor(
            None,
            functools.partial(
                generate_midi,
                prompt=prompt,
                genre=genre,
                job_dir=str(job_dir),
                melody_midi_path=melody_midi_path,
                resolution=midi_resolution,
            ),
        )

        # Analyze the output
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(midi_path)
        tracks = []
        for inst in pm.instruments:
            tracks.append({
                "name": inst.name or ("Drums" if inst.is_drum else f"Track {len(tracks)+1}"),
                "notes": len(inst.notes),
                "is_drum": bool(inst.is_drum),
                "program": int(inst.program),
            })

        tempo_changes = pm.get_tempo_changes()[1]
        detected_tempo = float(tempo_changes[0]) if len(tempo_changes) > 0 else 120.0

        return {
            "job_id": job_id,
            "midi_url": f"/api/workshop/download/{job_id}/workshop_output.mid",
            "tracks": tracks,
            "duration": float(pm.get_end_time()),
            "tempo": detected_tempo,
        }

    except Exception as e:
        print(f"[workshop] Generation failed job={job_id}: {e}")
        return JSONResponse(status_code=500, content={"detail": "MIDI generation failed. Please try again."})


@router.post("/workshop/reference")
async def workshop_reference(
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Convert a reference audio file to multi-track MIDI.
    Pipeline: audio → stem separation → per-stem transcription → combined MIDI.
    """
    from pipelines.anticipatory_generator import reference_to_midi

    content = await _read_audio_upload(audio, "audio")

    job_id, job_dir = _new_job_dir()

    # Save uploaded audio; the suffix comes from the client, so keep it a plain extension
    ext = Path(audio.filename or "").suffix.lstrip(".").lower()
    if not ext.isalnum() or len(ext) > 5:
        ext = "mp3"
    audio_path = job_dir / f"reference.{ext}"
    audio_path.write_bytes(content)
    await _check_decodes(audio_path, "audio")

    try:
        loop = asyncio.get_running_loop()
        midi_path = await loop.run_in_executor(
            None,
            functools.partial(reference_to_midi, str(audio_path), str(job_dir)),
        )

        # Analyze the output
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(midi_path)
        tracks = []
        for inst in pm.instruments:
            tracks.append({
                "name": inst.name or f"Track {len(tracks)+1}",
                "notes": len(inst.notes),
                "is_drum": bool(inst.is_drum),
                "program": int(inst.program),
            })

        return {
            "job_id": job_id,
            "midi_url": f"/api/workshop/download/{job_id}/reference_output.mid",
            "tracks": tracks,
            "duration": float(pm.get_end_time()),
        }

    except Exception as e:
        print(f"[workshop] Reference conversion failed job={job_id}: {e}")
        return JSONResponse(status_code=500, content={"detail": "Reference conversion failed. Please try again."})


@router.get("/workshop/download/{job_id}/{filename}")
async def workshop_download(job_id: str, filename: str):
    """Download a generated MIDI file.

    No auth: the page links here with a plain <a href>. The path is validated
    and must resolve to a file inside this job's workshop dir, else 404.
    """
    file_path = safe_job_file(UPLOAD_DIR, f"workshop_{job_id}", filename) if valid_job_id(job_id) else None
    if file_path is None:
        return JSONResponse(status_code=404, content={"detail": "File not found"})
    return FileResponse(
        str(file_path),
        media_type="audio/midi",
        filename=filename,
    )
