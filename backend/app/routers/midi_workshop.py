"""MIDI Workshop endpoints — AI-generated and reference-based MIDI creation."""

import os
import uuid
import asyncio
import functools
from pathlib import Path
from fastapi import APIRouter, Form, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse

router = APIRouter()

UPLOAD_DIR = Path("/tmp/voxmidi")


def _new_job_dir():
    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / f"workshop_{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_id, job_dir


@router.post("/workshop/generate")
async def workshop_generate(
    prompt: str = Form(""),
    genre: str = Form(""),
    melody_audio: UploadFile = File(None),
):
    """
    Generate a multi-track MIDI file from a text description.
    Optionally accepts a melody audio file (hummed/sung) to generate accompaniment around.
    """
    from pipelines.anticipatory_generator import generate_midi
    from pipelines.transcriber import transcribe_audio

    job_id, job_dir = _new_job_dir()

    melody_midi_path = None

    # If melody audio provided, transcribe it first
    if melody_audio and melody_audio.filename:
        audio_path = job_dir / "melody_input.webm"
        content = await melody_audio.read()
        audio_path.write_bytes(content)

        try:
            melody_midi_path = transcribe_audio(
                str(audio_path), str(job_dir), output_name="melody_transcribed.mid"
            )
        except Exception as e:
            print(f"[workshop] Melody transcription failed: {e}")

    # Generate MIDI
    try:
        loop = asyncio.get_event_loop()
        midi_path = await loop.run_in_executor(
            None,
            functools.partial(
                generate_midi,
                prompt=prompt,
                genre=genre,
                job_dir=str(job_dir),
                melody_midi_path=melody_midi_path,
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
        print(f"[workshop] Generation failed: {e}")
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.post("/workshop/reference")
async def workshop_reference(
    audio: UploadFile = File(...),
):
    """
    Convert a reference audio file to multi-track MIDI.
    Pipeline: audio → stem separation → per-stem transcription → combined MIDI.
    """
    from pipelines.anticipatory_generator import reference_to_midi

    job_id, job_dir = _new_job_dir()

    # Save uploaded audio
    audio_path = job_dir / f"reference.{audio.filename.split('.')[-1] if audio.filename else 'mp3'}"
    content = await audio.read()
    audio_path.write_bytes(content)

    try:
        loop = asyncio.get_event_loop()
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
        print(f"[workshop] Reference conversion failed: {e}")
        return JSONResponse(status_code=500, content={"detail": str(e)})


@router.get("/workshop/download/{job_id}/{filename}")
async def workshop_download(job_id: str, filename: str):
    """Download a generated MIDI file."""
    file_path = UPLOAD_DIR / f"workshop_{job_id}" / filename
    if not file_path.exists():
        return JSONResponse(status_code=404, content={"detail": "File not found"})
    return FileResponse(
        str(file_path),
        media_type="audio/midi",
        filename=filename,
    )
