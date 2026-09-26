import os
import re
import uuid
import json as _json
import shutil
import asyncio
import tempfile
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from typing import Optional
from sqlalchemy import update
from sqlalchemy.orm import Session

from pipelines.midi_generator import generate_from_prompt
from pipelines.post_processor import post_process_midi
from pipelines.midi_analyzer import analyze_midi
from database import get_db, SessionLocal, User, Generation, Preset
from middleware.auth import get_current_user
from .jobs import set_job, update_job, try_start, queue_position, cancel_job, get_job, claim_refund

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")
MIDI_STORE = Path("/app/data/midi")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# Job ids are short: 8 hex chars, optionally prefixed (sep_, ext_, concat_, workshop_)
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def valid_job_id(job_id: str) -> bool:
    return bool(job_id) and _JOB_ID_RE.fullmatch(job_id) is not None


def require_job_id(job_id: str, field: str = "job_id") -> str:
    """400 unless job_id has the shape of an id we issue (no separators or dots)."""
    if not valid_job_id(job_id):
        raise HTTPException(status_code=400, detail=f"{field}: not a valid job id")
    return job_id


def safe_job_file(base: Path, dir_name: str, filename: str) -> Optional[Path]:
    """
    Resolve base/dir_name/filename, or None if the names are not plain
    single path segments or the result is not a regular file inside base.
    """
    if not valid_job_id(dir_name) or not filename or len(filename) > 255 \
            or filename.startswith(".") or ".." in filename \
            or any(c in filename for c in "/\\") or any(ord(c) < 32 for c in filename):
        return None
    try:
        root = base.resolve()
        path = (base / dir_name / filename).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return path


def charge_song(db: Session, user: User) -> None:
    """Charge one song only if the user is under their limit, in one statement,
    so two concurrent requests can't both slip under it. Raises 429 otherwise."""
    result = db.execute(
        update(User)
        .where(User.id == user.id, User.usage_count < User.usage_limit)
        .values(usage_count=User.usage_count + 1)
    )
    db.commit()
    if result.rowcount != 1:
        raise HTTPException(status_code=429, detail=f"Monthly limit of {user.usage_limit} reached")


def refund_song(job_id: str) -> None:
    """Give back the song charged for job_id. Safe to call from every failure
    and cancel path: claim_refund hands out the refund at most once per job."""
    user_id = claim_refund(job_id)
    if not user_id:
        return
    from database import SessionLocal as _SessionLocal
    db = _SessionLocal()
    try:
        db.execute(update(User).where(User.id == user_id, User.usage_count > 0).values(usage_count=User.usage_count - 1))
        db.commit()
        print(f"[generate] refunded job={job_id} user={user_id}")
    except Exception as e:
        print(f"[generate] refund failed job={job_id}: {e}")
    finally:
        db.close()


def _queued(job_id: str) -> None:
    pos = queue_position(job_id)
    update_job(job_id, {
        "status": "queued",
        "progress": 0,
        "queue_position": pos,
        "message": f"Server is busy. You're #{pos} in queue.",
    })


@router.post("/generate")
async def generate(
    audio: Optional[UploadFile] = File(None),
    piano_melody: Optional[UploadFile] = File(None),
    voice_audio: Optional[UploadFile] = File(None),
    source_url: Optional[str] = Form(None),
    prompt: str = Form(""),
    genre: str = Form(""),
    tempo: int = Form(0),
    key: str = Form(""),
    mode: str = Form("text"),
    lyrics: str = Form(""),
    chord_progression: str = Form(""),
    advanced_dirty: str = Form("false"),
    vocal_mode: str = Form("hum"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start async generation. Returns job_id immediately; poll /api/status/{job_id}."""
    job_id = str(uuid.uuid4())[:8]
    is_advanced_dirty = advanced_dirty.lower() in ("true", "1", "yes")

    audio_content: Optional[bytes] = None
    audio_suffix = ".webm"
    if audio:
        audio_content = await audio.read()
        audio_suffix = Path(audio.filename or "input.webm").suffix or ".webm"

    piano_melody_content: Optional[bytes] = None
    if piano_melody:
        piano_melody_content = await piano_melody.read()

    voice_audio_content: Optional[bytes] = None
    if voice_audio:
        voice_audio_content = await voice_audio.read()

    for name, data in (("audio", audio_content), ("piano_melody", piano_melody_content), ("voice_audio", voice_audio_content)):
        if data is not None and len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail=f"{name}: keep uploads under 25 MB")

    charge_song(db, current_user)

    set_job(job_id, {"status": "processing", "progress": 0, "_owner": current_user.id, "_charged": current_user.id})

    args = (
        job_id, audio_content, audio_suffix, piano_melody_content,
        source_url, prompt, genre, tempo, key, mode, lyrics,
        chord_progression, current_user.id, is_advanced_dirty,
        vocal_mode, voice_audio_content,
    )
    started = try_start(job_id, _run_generate, args)

    if not started:
        _queued(job_id)

    return {"job_id": job_id, "status": "queued" if not started else "processing"}


def _persist_files(job_dir: Path, store_dir: Path) -> None:
    """Copy all files from job_dir to persistent store."""
    try:
        MIDI_STORE.mkdir(parents=True, exist_ok=True)
        store_dir.mkdir(parents=True, exist_ok=True)
        for src in job_dir.iterdir():
            if src.is_file():
                dest = store_dir / src.name
                if not dest.exists() or src.stat().st_mtime > dest.stat().st_mtime:
                    shutil.copy2(src, dest)
    except Exception as e:
        print(f"[generate] persist failed: {e}")


def _run_generate(
    job_id: str,
    audio_content: Optional[bytes],
    audio_suffix: str,
    piano_melody_content: Optional[bytes],
    source_url: Optional[str],
    prompt: str,
    genre: str,
    tempo: int,
    key: str,
    mode: str,
    lyrics: str,
    chord_progression: str,
    user_id: str,
    advanced_dirty: bool = False,
    vocal_mode: str = "hum",
    voice_audio_content: Optional[bytes] = None,
) -> None:
    db = SessionLocal()
    store_dir = MIDI_STORE / job_id
    try:
        update_job(job_id, {"status": "generating_audio", "progress": 15})

        job_dir = UPLOAD_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        raw_audio_path: Optional[str] = None
        if audio_content:
            saved = job_dir / f"input{audio_suffix}"
            saved.write_bytes(audio_content)
            raw_audio_path = str(saved)

        piano_melody_path: Optional[str] = None
        if piano_melody_content:
            piano_saved = job_dir / "piano_melody.wav"
            piano_saved.write_bytes(piano_melody_content)
            piano_melody_path = str(piano_saved)

        voice_audio_path: Optional[str] = None
        if voice_audio_content:
            voice_saved = job_dir / "voice_reference.webm"
            voice_saved.write_bytes(voice_audio_content)
            voice_audio_path = str(voice_saved)

        chord_list: list = []
        if chord_progression.strip():
            try:
                chord_list = _json.loads(chord_progression)
            except Exception:
                pass

        # Build MiniMax prompt
        if advanced_dirty:
            minimax_prompt = _build_prompt(genre, tempo, key, prompt)
        else:
            minimax_prompt = prompt

        has_minimax = bool(os.environ.get("MINIMAX_API_KEY"))
        provider_used = "minimax" if has_minimax else "mock"

        print(f"[generate] job={job_id} provider={provider_used} genre={genre} tempo={tempo} key={key} mode={mode} vocal_mode={vocal_mode} advanced_dirty={advanced_dirty}")

        output_midi_path = str(job_dir / "output.mid")

        try:
            midi_path, vocal_path, audio_path = generate_from_prompt(
                prompt=minimax_prompt,
                output_path=output_midi_path,
                genre=genre,
                tempo=tempo,
                key=key,
                lyrics=lyrics,
                audio_path=raw_audio_path,
                chord_progression=chord_list if chord_list else None,
                piano_melody_path=piano_melody_path,
                mode=mode,
                voice_audio_path=voice_audio_path,
            )
            output_midi_path = midi_path
        except Exception as e:
            err_str = str(e).lower()
            if "access ended" in err_str or "no longer available" in err_str:
                msg = "MiniMax has discontinued music generation for this account. A new provider is being wired up; song generation is down until then."
            elif any(w in err_str for w in ("minimax", "api", "key", "rate", "timeout", "403", "401", "429")):
                msg = "Music generation service is temporarily unavailable. Please try again in a moment."
            else:
                msg = "Generation failed. Please try again."
            print(f"[generate] Phase 1 error job={job_id}: {e}")
            import traceback; traceback.print_exc()
            update_job(job_id, {"status": "error", "message": msg})
            refund_song(job_id)
            return

        if get_job(job_id) and get_job(job_id).get("status") == "cancelled":
            refund_song(job_id)
            return

        try:
            final_path = post_process_midi(output_midi_path, str(job_dir / "final.mid"), tempo=tempo, key=key)
            output_midi_path = final_path
        except Exception:
            pass

        try:
            analysis = analyze_midi(output_midi_path)
        except Exception:
            analysis = {"tempo": tempo, "duration": 0, "time_signature": "4/4", "key": key, "tracks": []}

        output_filename = Path(output_midi_path).name

        generated_audio_path = audio_path
        if not generated_audio_path or not Path(generated_audio_path).exists():
            for name in ("minimax_audio.mp3",):
                p = job_dir / name
                if p.exists():
                    generated_audio_path = str(p)
                    break

        audio_url: Optional[str] = None
        if generated_audio_path and Path(generated_audio_path).exists():
            audio_url = f"/api/download/{job_id}/{Path(generated_audio_path).name}"

        _persist_files(job_dir, store_dir)

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

        final_result = {
            "job_id": job_id,
            "midi_url": f"/api/download/{job_id}/{output_filename}",
            "audio_url": audio_url,
            "vocal_audio_url": None,
            "stems": {},
            "preview_url": None,
            "provider": provider_used,
            "genre": genre,
            "tempo": analysis.get("tempo") or tempo,
            "key": analysis.get("key") or key,
            "duration": analysis.get("duration", 0),
            "time_signature": analysis.get("time_signature", "4/4"),
            "tracks": analysis.get("tracks", []),
            "prompt": prompt,
            "versions": [],
        }

        update_job(job_id, {"status": "complete", "progress": 100, "result": final_result})
        print(f"[generate] job={job_id} complete")

    except Exception as e:
        print(f"[generate] unexpected error job={job_id}: {e}")
        import traceback; traceback.print_exc()
        update_job(job_id, {"status": "error", "message": "An unexpected error occurred. Please try again."})
        refund_song(job_id)
    finally:
        db.close()


_AUDIO_NAMES = ("musicgen_audio.mp3", "minimax_audio.mp3", "full_mix.mp3", "full_mix.wav")


@router.post("/separate/{job_id}")
async def separate_stems_endpoint(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Trigger on-demand stem separation for a completed job (works for in-memory and library entries)."""
    require_job_id(job_id)
    sep_job_id = f"sep_{job_id}"

    existing = get_job(sep_job_id)
    if existing:
        return {"sep_job_id": sep_job_id, "status": existing.get("status", "unknown")}

    # Find audio file: check persistent store first, then /tmp
    audio_path: Optional[Path] = None
    for base in (MIDI_STORE, UPLOAD_DIR):
        store_dir = base / job_id
        if not store_dir.exists():
            continue
        for name in _AUDIO_NAMES:
            p = store_dir / name
            if p.exists():
                audio_path = p
                break
        if not audio_path:
            for p in sorted(store_dir.iterdir()):
                if p.is_file() and p.suffix in (".mp3", ".wav") and \
                   not any(p.name.startswith(s) for s in ("vocals.", "bass.", "drums.", "other.", "vocal_")):
                    audio_path = p
                    break
        if audio_path:
            break

    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio file not found")

    # Ensure job entry exists in memory (needed by _run_separate to update result)
    if not get_job(job_id):
        set_job(job_id, {"status": "complete", "progress": 100, "_owner": current_user.id, "result": {
            "audio_url": f"/api/download/{job_id}/{audio_path.name}"
        }})

    set_job(sep_job_id, {"status": "separating_stems", "progress": 0, "_owner": current_user.id})

    # Through the shared queue so separation counts against MAX_CONCURRENT
    started = try_start(sep_job_id, _run_separate, (sep_job_id, job_id, str(audio_path)))
    if not started:
        _queued(sep_job_id)
        return {"sep_job_id": sep_job_id, "status": "queued"}

    return {"sep_job_id": sep_job_id, "status": "separating_stems"}


def _run_separate(sep_job_id: str, original_job_id: str, audio_path: str) -> None:
    store_dir = MIDI_STORE / original_job_id
    job_dir = UPLOAD_DIR / original_job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        update_job(sep_job_id, {"status": "separating_stems", "progress": 20})
        from pipelines.separator import separate_stems
        stems_dict = separate_stems(audio_path, str(job_dir))

        stem_urls: dict = {}
        for stem_name, stem_path in stems_dict.items():
            sp = Path(stem_path)
            if sp.exists() and str(stem_path).endswith(".mp3"):
                stem_urls[stem_name] = f"/api/download/{original_job_id}/{sp.name}"

        _persist_files(job_dir, store_dir)
        print(f"[separate] sep_job={sep_job_id} complete: {list(stem_urls.keys())}")

        # Update the original job result with stems
        original_job = get_job(original_job_id)
        if original_job and original_job.get("result"):
            merged_result = {**original_job["result"], "stems": stem_urls}
            update_job(original_job_id, {"status": "complete", "progress": 100, "result": merged_result})

        update_job(sep_job_id, {"status": "complete", "progress": 100, "result": {"stems": stem_urls}})

    except Exception as e:
        print(f"[separate] failed sep_job={sep_job_id}: {e}")
        import traceback; traceback.print_exc()
        update_job(sep_job_id, {
            "status": "error",
            "message": "Stem separation failed. You can still use the full mix audio.",
        })


@router.post("/cancel/{job_id}")
async def cancel_generation(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Cancel a running or queued generation job."""
    job = get_job(job_id)
    if not job or job.get("_owner") != current_user.id:
        raise HTTPException(status_code=404, detail="Job not found")
    was_queued = queue_position(job_id) > 0
    cancelled = cancel_job(job_id)
    if cancelled and was_queued:
        # Never started, so no worker will see the cancel and refund it
        refund_song(job_id)
    return {"cancelled": cancelled, "job_id": job_id}


@router.post("/analyze-audio")
async def analyze_audio_endpoint(
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Detect BPM and key from uploaded audio using librosa."""
    from pipelines.transcriber import _ensure_wav
    from pipelines.midi_generator import _analyze_reference_audio

    content = await audio.read()
    if not content:
        raise HTTPException(status_code=400, detail="audio: the file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="audio: keep uploads under 25 MB")
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    loop = asyncio.get_running_loop()
    # A private dir per request: _ensure_wav writes its converted copy next to the input
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / f"audio{suffix}"
        tmp_path.write_bytes(content)
        try:
            wav_path = await loop.run_in_executor(None, _ensure_wav, str(tmp_path))
        except Exception as e:
            print(f"[analyze-audio] undecodable upload: {e}")
            raise HTTPException(status_code=400, detail="audio: could not read this file as audio")
        try:
            tempo_f, key_str, _ = await loop.run_in_executor(None, _analyze_reference_audio, wav_path)
        except Exception as e:
            print(f"[analyze-audio] failed: {e}")
            raise HTTPException(status_code=500, detail="Audio analysis failed")
        return {"tempo": round(tempo_f), "key": key_str}


@router.get("/presets")
async def get_presets(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    presets = db.query(Preset).filter(Preset.user_id == current_user.id).order_by(Preset.created_at.desc()).all()
    return [{"id": p.id, "name": p.name, "genre": p.genre, "tempo": p.tempo, "key": p.key, "prompt_prefix": p.prompt_prefix} for p in presets]


@router.post("/presets")
async def create_preset(
    name: str = Form(...),
    genre: str = Form("pop"),
    tempo: int = Form(120),
    key: str = Form("Am"),
    prompt_prefix: str = Form(""),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    preset = Preset(user_id=current_user.id, name=name, genre=genre, tempo=tempo, key=key, prompt_prefix=prompt_prefix)
    db.add(preset)
    db.commit()
    return {"id": preset.id, "name": preset.name, "genre": preset.genre, "tempo": preset.tempo, "key": preset.key, "prompt_prefix": preset.prompt_prefix}


@router.delete("/presets/{preset_id}")
async def delete_preset(
    preset_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    preset = db.query(Preset).filter(Preset.id == preset_id, Preset.user_id == current_user.id).first()
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    db.delete(preset)
    db.commit()
    return {"deleted": True}


@router.post("/extend/{job_id}")
async def extend_generation(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Extend a completed generation by continuing from the last 10 seconds."""
    require_job_id(job_id)
    ext_job_id = f"ext_{job_id}"
    existing = get_job(ext_job_id)
    if existing and existing.get("_owner") == current_user.id and \
            existing.get("status") not in ("complete", "error", "cancelled"):
        # Already extending this job: don't charge a second song for it
        return {"ext_job_id": ext_job_id, "status": existing.get("status", "processing")}

    audio_path: Optional[Path] = None
    for base in (MIDI_STORE, UPLOAD_DIR):
        store_dir = base / job_id
        if not store_dir.exists():
            continue
        for name in _AUDIO_NAMES:
            p = store_dir / name
            if p.exists():
                audio_path = p
                break
        if audio_path:
            break

    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio not found for this job")

    gen = db.query(Generation).filter(Generation.id == job_id).first()

    charge_song(db, current_user)

    ext_args = (ext_job_id, str(audio_path), gen.prompt if gen else "", gen.genre if gen else "pop",
                gen.tempo if gen else 120, gen.key if gen else "Am", current_user.id, job_id)
    set_job(ext_job_id, {"status": "processing", "progress": 0, "_owner": current_user.id, "_charged": current_user.id})
    # Through the shared queue so extends count against MAX_CONCURRENT
    started = try_start(ext_job_id, _run_extend, ext_args)
    if not started:
        _queued(ext_job_id)
        return {"ext_job_id": ext_job_id, "status": "queued"}
    return {"ext_job_id": ext_job_id, "status": "processing"}


def _run_extend(ext_job_id: str, audio_path: str, prompt: str, genre: str, tempo: int, key: str, user_id: str, parent_job_id: str) -> None:
    import subprocess
    db = SessionLocal()
    try:
        update_job(ext_job_id, {"status": "generating_audio", "progress": 20})
        ap = Path(audio_path)
        ext_dir = UPLOAD_DIR / ext_job_id
        ext_dir.mkdir(parents=True, exist_ok=True)

        # Extract last 10s as reference
        tail_path = str(ext_dir / "tail.mp3")
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-sseof", "-10", "-i", str(ap), "-c:a", "libmp3lame", tail_path],
                check=True, capture_output=True
            )
        except Exception as e:
            print(f"[extend] ffmpeg tail failed: {e}")
            tail_path = str(ap)

        output_midi_path = str(ext_dir / "output.mid")
        from pipelines.midi_generator import generate_from_prompt
        midi_path, _, out_audio = generate_from_prompt(
            prompt=f"Continue this track: {prompt}",
            output_path=output_midi_path,
            genre=genre, tempo=tempo, key=key,
            audio_path=tail_path, mode="source",
        )

        store_dir = MIDI_STORE / ext_job_id
        _persist_files(ext_dir, store_dir)

        try:
            from pipelines.midi_analyzer import analyze_midi
            analysis = analyze_midi(midi_path)
        except Exception:
            analysis = {"tempo": tempo, "duration": 0, "time_signature": "4/4", "key": key, "tracks": []}

        ext_gen = Generation(
            id=ext_job_id, user_id=user_id, mode="text",
            genre=genre, tempo=tempo, key=key, prompt=prompt,
            midi_filename=Path(midi_path).name,
            tracks_count=len(analysis.get("tracks", [])),
            duration=analysis.get("duration", 0.0),
            time_signature=analysis.get("time_signature", "4/4"),
            replicate_cost=0.0, parent_job_id=parent_job_id,
        )
        db.add(ext_gen)
        db.commit()

        audio_url = None
        if out_audio and Path(out_audio).exists():
            audio_url = f"/api/download/{ext_job_id}/{Path(out_audio).name}"

        result = {
            "job_id": ext_job_id, "parent_job_id": parent_job_id,
            "midi_url": f"/api/download/{ext_job_id}/{Path(midi_path).name}",
            "audio_url": audio_url, "vocal_audio_url": None, "stems": {},
            "genre": genre, "tempo": analysis.get("tempo") or tempo,
            "key": analysis.get("key") or key,
            "duration": analysis.get("duration", 0),
            "time_signature": analysis.get("time_signature", "4/4"),
            "tracks": analysis.get("tracks", []), "prompt": prompt, "versions": [],
        }
        update_job(ext_job_id, {"status": "complete", "progress": 100, "result": result})
    except Exception as e:
        print(f"[extend] error: {e}")
        import traceback; traceback.print_exc()
        update_job(ext_job_id, {"status": "error", "message": "Extend failed."})
        refund_song(ext_job_id)
    finally:
        db.close()


@router.post("/concat/{job_id}")
async def concat_generations(
    job_id: str,
    ext_job_id: str = Form(...),
    current_user: User = Depends(get_current_user),
):
    """Concatenate original audio with its extension using ffmpeg."""
    import subprocess
    require_job_id(job_id)
    require_job_id(ext_job_id, "ext_job_id")
    orig_audio: Optional[Path] = None
    ext_audio: Optional[Path] = None
    for base in (MIDI_STORE, UPLOAD_DIR):
        for jid, target in ((job_id, "orig"), (ext_job_id, "ext")):
            d = base / jid
            if not d.exists(): continue
            for name in _AUDIO_NAMES:
                p = d / name
                if p.exists():
                    if target == "orig": orig_audio = p
                    else: ext_audio = p
                    break
        if orig_audio and ext_audio: break

    if not orig_audio or not ext_audio:
        raise HTTPException(status_code=404, detail="Audio files not found")

    out_dir = MIDI_STORE / f"concat_{job_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = str(out_dir / "full_mix.mp3")
    list_file = out_dir / "concat.txt"
    list_file.write_text(f"file '{orig_audio}'\nfile '{ext_audio}'\n")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c:a", "libmp3lame", out_path],
            check=True, capture_output=True
        )
    except subprocess.CalledProcessError as e:
        # The inputs are files we generated, so a failure here is on our side
        print(f"[concat] ffmpeg failed job={job_id}: {e.stderr[-500:] if e.stderr else e}")
        raise HTTPException(status_code=500, detail="Concat failed")
    return {"audio_url": f"/api/download/concat_{job_id}/full_mix.mp3"}


def parse_prompt(prompt: str) -> dict:
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
    parts = []
    if genre:
        parts.append(f"A {genre.replace('-', ' ').title()} track")
    if tempo:
        parts.append(f"at {tempo} BPM")
    if key:
        parts.append(f"in the key of {key}")
    if user_prompt.strip():
        parts.append(user_prompt.strip() if not parts else f"with {user_prompt.strip()}")
    return ", ".join(parts) + "." if parts else user_prompt
