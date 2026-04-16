from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException
import uuid

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")


@router.post("/preview")
async def preview_midi(midi: UploadFile = File(...)):
    """Render a MIDI file to audio using FluidSynth for browser preview."""
    job_id = str(uuid.uuid4())[:8]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    midi_path = job_dir / "preview.mid"
    content = await midi.read()
    midi_path.write_bytes(content)

    # TODO: integrate FluidSynth rendering
    # wav_path = render_midi_to_audio(str(midi_path), str(job_dir / "preview.wav"))
    # return FileResponse(wav_path, media_type="audio/wav")

    return {"status": "preview not yet implemented", "job_id": job_id}
