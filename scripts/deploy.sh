#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== VoxMIDI Deploy ==="
echo "Root: $ROOT"

# Step 1: Build frontend
echo ""
echo "→ Building frontend..."
cd "$ROOT/frontend"
npm install
npm run build
echo "✓ Frontend built → frontend/dist/"

# Step 2: Build + start Docker stack
echo ""
echo "→ Building Docker images..."
cd "$ROOT"
docker compose -f docker-compose.prod.yml build --no-cache

echo ""
echo "→ Starting production stack..."
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "✓ Done! Containers running:"
docker compose -f docker-compose.prod.yml ps

echo ""
echo "Check logs with: docker compose -f docker-compose.prod.yml logs -f"
