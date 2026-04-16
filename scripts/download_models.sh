#!/bin/bash
set -e

MODEL_DIR="${HOME}/.cache/voxmidi/models"
mkdir -p "$MODEL_DIR"

echo "📥 Downloading MIDI-LLM model from HuggingFace..."
if [ ! -d "$MODEL_DIR/MIDI-LLM_Llama-3.2-1B" ]; then
    pip install huggingface_hub --quiet
    python -c "
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='slseanwu/MIDI-LLM_Llama-3.2-1B',
    local_dir='$MODEL_DIR/MIDI-LLM_Llama-3.2-1B',
)
print('✅ MIDI-LLM downloaded')
"
else
    echo "  ✅ MIDI-LLM already downloaded"
fi

echo "📥 Downloading FluidR3_GM SoundFont..."
SOUNDFONT_DIR="${HOME}/.cache/voxmidi/soundfonts"
mkdir -p "$SOUNDFONT_DIR"
if [ ! -f "$SOUNDFONT_DIR/FluidR3_GM.sf2" ]; then
    wget -q "https://keymusician01.s3.amazonaws.com/FluidR3_GM.zip" -O /tmp/FluidR3_GM.zip
    unzip -o /tmp/FluidR3_GM.zip -d "$SOUNDFONT_DIR"
    rm /tmp/FluidR3_GM.zip
    echo "  ✅ SoundFont downloaded"
else
    echo "  ✅ SoundFont already downloaded"
fi

echo "📥 Pre-downloading Demucs model (htdemucs_ft)..."
python -c "
import torch
try:
    from demucs.pretrained import get_model
    model = get_model('htdemucs_ft')
    print('✅ Demucs model cached')
except Exception as e:
    print(f'⚠️  Demucs will download on first use: {e}')
" 2>/dev/null || echo "  ⚠️  Demucs not installed yet (will download at runtime)"

echo ""
echo "✅ All models ready!"
