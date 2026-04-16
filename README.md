# VoxMIDI

Voice & Audio Source → Editable MIDI for any DAW.

## Quick Start (Local Dev)

### Frontend
```bash
cd frontend
npm install
# Download Catalyst from your Tailwind Plus account
# Unzip and copy JS components into src/components/catalyst/
npm run dev
```

### Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

### Production (EC2)
```bash
# On a g4dn.xlarge with Deep Learning AMI
./scripts/setup.sh
docker compose up -d
```

## Project Structure
```
voxmidi/
├── frontend/          # React + Vite + Tailwind v4 + Catalyst
│   └── src/
│       ├── components/
│       │   ├── catalyst/    ← Drop Catalyst components here
│       │   └── voxmidi/     ← Our custom components
│       ├── pages/           ← Page components (Create, Library, etc.)
│       └── lib/             ← API client, MIDI player, audio utils
├── backend/           # FastAPI + ML pipeline
│   └── app/
│       ├── routers/         ← API endpoints
│       └── pipelines/       ← ML wrappers (Basic Pitch, Demucs, MIDI-LLM)
├── vllm/              # MIDI-LLM inference server
├── nginx/             # Reverse proxy config
└── scripts/           # Setup & deployment scripts
```

## Catalyst Setup

1. Download `catalyst-ui-kit.zip` from your [Tailwind Plus account](https://tailwindui.com)
2. Unzip and copy the `javascript/` (or `typescript/`) folder contents into `frontend/src/components/catalyst/`
3. The app layout in `App.jsx` is pre-wired to import from `@/components/catalyst/`

## Pages

| Page | Route | Description |
|------|-------|-------------|
| Create | `/` | Record voice, paste URL, enter prompts → generate MIDI |
| Library | `/library` | Your saved MIDI generations |
| Sources | `/sources` | Manage audio sources (YouTube bookmarks, uploads) |
| Settings | `/settings` | API config, model settings, export preferences |
