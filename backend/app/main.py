import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env for local development.
# In Docker, env vars are injected via docker-compose env_file — dotenv is a no-op there
# because the .env file path resolves to /.env (doesn't exist inside container).
# Use override=False so any env vars already set by Docker take precedence.
_env_file = Path(__file__).parent.parent / '.env'
if _env_file.exists():
    load_dotenv(_env_file, override=False)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import transcribe, generate, source, transform, preview, status as status_router
from routers import user as user_router
from routers import lyrics as lyrics_router
from routers import ai_assist as ai_assist_router
from routers import midi_workshop as midi_workshop_router
from routers import jam as jam_router
from routers import drums as drums_router
from routers import studio as studio_router

UPLOAD_DIR = Path("/tmp/voxmidi")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="VoxMIDI API",
    description="Voice & Audio Source → Editable MIDI",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup():
    init_db()

app.include_router(transcribe.router, prefix="/api")
app.include_router(generate.router, prefix="/api")
app.include_router(source.router, prefix="/api")
app.include_router(status_router.router, prefix="/api")
app.include_router(transform.router, prefix="/api")
app.include_router(preview.router, prefix="/api")
app.include_router(user_router.router, prefix="/api")
app.include_router(lyrics_router.router, prefix="/api")
app.include_router(ai_assist_router.router, prefix="/api")
app.include_router(midi_workshop_router.router, prefix="/api")
app.include_router(jam_router.router, prefix="/api")
app.include_router(drums_router.router, prefix="/api")
app.include_router(studio_router.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.2.0", "dev_mode": os.environ.get("DEV_MODE", "false")}


