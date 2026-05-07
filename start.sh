#!/bin/bash
set -e
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
  echo "Node.js not found."
  echo "  Linux/Chromebook: sudo apt install nodejs"
  echo "  Mac:              brew install node"
  echo "  Or use Docker:    docker compose up"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --production
fi

mkdir -p logs
echo "MUSH client → http://localhost:3000"
node server.js
