# VoxMIDI — Status v0.2.0

## What's working

### Auth (Clerk)
- **Dev mode** (`DEV_MODE=true`, no `VITE_CLERK_PUBLISHABLE_KEY`): app loads with no auth, all APIs use a `dev` user
- **Prod mode**: Clerk gates all routes; users sign in at `/sign-in`; sidebar shows avatar + usage badge
- JWT verified via Clerk JWKS endpoint (cached 1 hour)
- New users auto-created in SQLite on first sign-in

### Backend APIs
| Endpoint | Status | Notes |
|---|---|---|
| `POST /api/generate` | **Real** | text/voice modes; tracks usage |
| `POST /api/source` | **Real** | yt-dlp + Replicate Demucs (~$0.02/run) |
| `POST /api/transform` | **Real** | mock MIDI-LLM |
| `POST /api/transcribe` | **Real** | basic-pitch ONNX, CPU-only |
| `GET /api/usage` | **Real** | monthly count/limit/reset |
| `GET /api/library` | **Real** | SQLite, per-user |
| `GET /api/presets` | **Real** | 9 genre presets |
| `GET /api/download/{job_id}/{file}` | **Real** | serves MIDI files |

### MIDI Generation
- **Provider**: `MIDI_GEN_PROVIDER=mock` (no text-to-MIDI model on Replicate as of 2026-04)
- Genre-aware mock: EDM, Trap, Lo-fi, Synthwave, Jazz, Ambient, Pop/Rock
- Structure-aware: intro → build → drop sections per genre
- Sets correct GM program numbers and channel 9 for drums

### Stem Separation
- **Provider**: `SEPARATOR_PROVIDER=api` (Replicate Demucs)
- Falls back to mock when provider=mock (for local dev)
- YouTube download via yt-dlp (from venv), no system PATH dependency

### Frontend
- Clerk auth with `SignedIn`/`SignedOut` guards — dev mode bypasses entirely
- Library page pulls from server (`/api/library`) instead of localStorage
- Settings shows account info (Clerk), usage stats (/api/usage), export preferences
- Usage badge in sidebar: "X/50" updates on each page load
- Builds clean: `✓ 2054 modules` zero errors

### Database
- SQLite at `backend/data/voxmidi.db`
- `User`: id (Clerk sub), email, name, usage_count, usage_limit (50), usage_reset_month
- `Generation`: per-request record with mode, genre, tempo, key, cost, duration
- Monthly usage auto-resets when month changes

---

## Environment variables

### `backend/.env`
```
TRANSCRIBER_PROVIDER=local          # basic-pitch ONNX on CPU
SEPARATOR_PROVIDER=api              # Replicate Demucs ($0.02/run)
MIDI_GEN_PROVIDER=mock              # no MIDI-LLM on Replicate yet
REPLICATE_API_TOKEN=r8_...          # your Replicate token
VLLM_URL=http://localhost:8000      # for future MIDI-LLM self-hosting
CLERK_SECRET_KEY=sk_live_...        # from Clerk dashboard → API Keys
DEV_MODE=true                       # set false in production
DRUMS_PROVIDER=auto                 # AI drums: fal when FAL_KEY is set, else a free local preview (mock)
FAL_DRUMS_MODEL=fal-ai/stable-audio-25/audio-to-audio  # model used for AI drums (about $0.20 per render)
```

### `frontend/.env`
```
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...  # from Clerk dashboard → API Keys
```
Leave blank for dev mode (no auth required).

---

## Deploy to Hetzner

### One-time server setup
```bash
# On fresh Ubuntu 22.04/24.04 VPS:
bash scripts/server-setup.sh
```

### Copy env files from Mac
```bash
scp backend/.env root@YOUR_IP:/opt/voxmidi/backend/.env
scp frontend/.env root@YOUR_IP:/opt/voxmidi/frontend/.env
```

### Edit production env values on server
```bash
# backend/.env:
DEV_MODE=false
CLERK_SECRET_KEY=sk_live_...   # production key from Clerk

# frontend/.env:
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
```

### Deploy
```bash
cd /opt/voxmidi
git clone https://github.com/YOURUSER/voxmidi.git .  # or git pull
bash scripts/deploy.sh
```

`deploy.sh` does:
1. `npm install && npm run build` in `frontend/`
2. `docker compose -f docker-compose.prod.yml build`
3. `docker compose -f docker-compose.prod.yml up -d`

### Add DNS
In Cloudflare (or your DNS provider):
- `A` record: `voxmidi.yourdomain.com` → `YOUR_SERVER_IP`
- Enable Cloudflare proxy (orange cloud) for DDoS protection + real IP headers

### Test
```bash
curl https://voxmidi.yourdomain.com/api/health
# → {"status":"ok","version":"0.2.0","dev_mode":"false"}
```

---

## Adding users
- Clerk dashboard → Users → Invite or share sign-up URL
- To restrict to allowlist: Clerk dashboard → User Management → Restrictions → Enable email allowlist

## Checking usage and costs
```bash
# Usage per user (dev mode):
curl http://localhost:8080/api/usage

# Replicate costs:
# Each /api/source call with SEPARATOR_PROVIDER=api costs ~$0.02 (Demucs)
# Tracked in Generation.replicate_cost column in voxmidi.db
sqlite3 backend/data/voxmidi.db \
  "SELECT user_id, SUM(replicate_cost), COUNT(*) FROM generations GROUP BY user_id;"
```

---

## Roadmap

### MIDI-LLM (real text-to-MIDI)
No public Replicate model exists. Options:
1. **Self-host via vLLM**: Get a GPU server, run `slseanwu/MIDI-LLM_Llama-3.2-1B` via vLLM, set `MIDI_GEN_PROVIDER=local` + `VLLM_URL=http://your-gpu-server:8000`
2. **Deploy to Replicate**: Requires building a Cog model from [github.com/slSeanWU/MIDI-LLM](https://github.com/slSeanWU/MIDI-LLM) on a GPU machine

### Audio preview
- `preview_url` returns `null` — wire up FluidSynth rendering to generate MP3 previews

### HTTPS / TLS
- nginx.prod.conf serves HTTP only — Cloudflare handles TLS termination
- If not using Cloudflare: add certbot + Let's Encrypt to server-setup.sh

### Piano roll in library
- Server library currently shows metadata only (no note-level data stored)
- To add: store track JSON in Generation table, return in /api/library response
