#!/usr/bin/env bash
# Render the LinkedIn video from the repo root: serves the repo, captures frames, encodes the MP4.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${PORT:-8770}"
[ -d social/video/node_modules ] || npm install --prefix social/video
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
sleep 2
node social/video/render.mjs "http://localhost:$PORT/social/video/index.html" social/claude-adoption-video.mp4
