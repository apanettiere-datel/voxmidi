import os
import re
import uuid
import json as _json
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
from .jobs import set_job, update_job, try_start, queue_position, cancel_job, get_job

router = APIRouter()
UPLOAD_DIR = Path("/tmp/voxmidi")
MIDI_STORE = Path("/app/data/midi")


@router.post("/generate")
async def generate(
    audio: Optional[UploadFile] = File(None),
    piano_melody: Optional[UploadFile] = File(None),
    source_url: Optional[str] = Form(None),
    prompt: str = Form(""),
    genre: str = Form("pop"),
    tempo: int = Form(120),
    key: str = Form("Am"),
    mode: str = Form("text"),
    lyrics: str = Form(""),
    chord_progression: str = Form(""),
    advanced_dirty: str = Form("false"),
    vocal_mode: str = Form("hum"),
    autotune: int = Form(0),
    reverb: int = Form(0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start async generation. Returns job_id immediately; poll /api/status/{job_id}."""
    if current_user.usage_count >= current_user.usage_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Monthly limit of {current_user.usage_limit} reached",
        )

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

    current_user.usage_count += 1
    db.commit()

    set_job(job_id, {"status": "processing", "progress": 0})

    args = (
        job_id, audio_content, audio_suffix, piano_melody_content,
        source_url, prompt, genre, tempo, key, mode, lyrics,
        chord_progression, current_user.id, is_advanced_dirty,
        vocal_mode, autotune, reverb,
    )
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
    autotune: int = 0,
    reverb: int = 0,
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

        # Add autotune/reverb descriptions for singing mode
        if vocal_mode == "sing":
            vocal_fx = []
            if autotune >= 75:
                vocal_fx.append("with extreme T-Pain style autotune on vocals")
            elif autotune >= 50:
                vocal_fx.append("with heavy autotune effect on vocals")
            elif autotune >= 25:
                vocal_fx.append("with moderate autotune on vocals")
            elif autotune > 0:
                vocal_fx.append("with subtle pitch correction on vocals")
            if reverb >= 75:
                vocal_fx.append("with massive cathedral reverb on vocals")
            elif reverb >= 50:
                vocal_fx.append("with large hall reverb on vocals")
            elif reverb >= 25:
                vocal_fx.append("with moderate room reverb on vocals")
            elif reverb > 0:
                vocal_fx.append("with light vocal reverb")
            if vocal_fx:
                minimax_prompt = minimax_prompt.rstrip(". ") + ", " + ", ".join(vocal_fx)

        has_minimax = bool(os.environ.get("MINIMAX_API_KEY"))
        provider_used = "minimax" if has_minimax else "mock"

        print(f"[generate] job={job_id} provider={provider_used} genre={genre} tempo={tempo} key={key} mode={mode} vocal_mode={vocal_mode} autotune={autotune} reverb={reverb} advanced_dirty={advanced_dirty}")

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
            )
            output_midi_path = midi_path
        except Exception as e:
            err_str = str(e).lower()
            if any(w in err_str for w in ("minimax", "api", "key", "rate", "timeout", "403", "401", "429")):
                msg = "Music generation service is temporarily unavailable. Please try again in a moment."
            else:
                msg = "Generation failed. Please try again."
            print(f"[generate] Phase 1 error job={job_id}: {e}")
            import traceback; traceback.print_exc()
            update_job(job_id, {"status": "error", "message": msg})
            return

        if get_job(job_id) and get_job(job_id).get("status") == "cancelled":
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
    finally:
        db.close()


_AUDIO_NAMES = ("musicgen_audio.mp3", "minimax_audio.mp3", "full_mix.mp3", "full_mix.wav")


@router.post("/separate/{job_id}")
async def separate_stems_endpoint(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Trigger on-demand stem separation for a completed job (works for in-memory and library entries)."""
    sep_job_id = f"sep_{job_id}"

    existing = get_job(sep_job_id)
    if existing:
        return {"sep_job_id": sep_job_id, "status": existing.get("status", "unknown")}

    # Find audio file — check persistent store first, then /tmp
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
        set_job(job_id, {"status": "complete", "progress": 100, "result": {
            "audio_url": f"/api/download/{job_id}/{audio_path.name}"
        }})

    set_job(sep_job_id, {"status": "separating_stems", "progress": 0})

    t = threading.Thread(
        target=_run_separate,
        args=(sep_job_id, job_id, str(audio_path)),
        daemon=True,
    )
    t.start()

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
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    cancelled = cancel_job(job_id)
    return {"cancelled": cancelled, "job_id": job_id}


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
    parts = [f"A {genre.replace('-', ' ').title()} track", f"at {tempo} BPM", f"in the key of {key}"]
    if user_prompt.strip():
        parts.append(f"with {user_prompt.strip()}")
    return ", ".join(parts) + "."
