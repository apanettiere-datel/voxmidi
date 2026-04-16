#!/bin/bash
# Run this ONCE on a fresh Hetzner VPS (Ubuntu 22.04/24.04)
# Usage: bash server-setup.sh
set -e

echo "=== VoxMIDI Server Setup ==="

# System updates
apt-get update && apt-get upgrade -y

# Install Docker
echo "→ Installing Docker..."
curl -fsSL https://get.docker.com | sh
apt-get install -y docker-compose-plugin

# Install Node.js 20 (for frontend build on server)
echo "→ Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verify
docker --version
docker compose version
node --version
npm --version

echo ""
echo "✓ Server setup complete."
echo ""
echo "Next steps:"
echo "  1. Clone your repo:"
echo "     git clone https://github.com/YOURUSER/voxmidi.git /opt/voxmidi"
echo ""
echo "  2. Copy your .env files from your Mac:"
echo "     scp backend/.env root@YOUR_IP:/opt/voxmidi/backend/.env"
echo "     scp frontend/.env root@YOUR_IP:/opt/voxmidi/frontend/.env"
echo ""
echo "  3. Deploy:"
echo "     cd /opt/voxmidi && bash scripts/deploy.sh"
echo ""
echo "  4. Add Cloudflare DNS:"
echo "     A record: voxmidi.yourdomain.com → YOUR_SERVER_IP"
echo "     Enable Cloudflare proxy (orange cloud)"
echo ""
echo "  5. Visit https://voxmidi.yourdomain.com"
