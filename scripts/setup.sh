#!/bin/bash
set -e

echo "╔══════════════════════════════════════╗"
echo "║         VoxMIDI Setup Script         ║"
echo "╚══════════════════════════════════════╝"

# Check for NVIDIA GPU
if ! nvidia-smi &>/dev/null; then
    echo "⚠️  No NVIDIA GPU detected. MIDI-LLM and Demucs will be slow on CPU."
fi

# Install Docker if needed
if ! command -v docker &>/dev/null; then
    echo "📦 Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
fi

# Install NVIDIA Container Toolkit if GPU available
if nvidia-smi &>/dev/null && ! dpkg -l | grep -q nvidia-container-toolkit; then
    echo "🎮 Installing NVIDIA Container Toolkit..."
    distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
        sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
    sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
    sudo nvidia-ctk runtime configure --runtime=docker
    sudo systemctl restart docker
fi

# Download models
echo "📥 Downloading models..."
./scripts/download_models.sh

echo ""
echo "✅ Setup complete! Run: docker compose up -d"
echo "   Then visit http://localhost"
