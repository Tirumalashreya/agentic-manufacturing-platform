#!/usr/bin/env bash
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cleanup() {
  echo "Shutting down..."
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "Starting Enterprise APS Backend on http://127.0.0.1:8080..."
(cd backend && ./.venv/bin/uvicorn app.main:app --port 8080) &

sleep 2

echo "Starting Enterprise APS Frontend on http://localhost:3002..."
(cd frontend && npx vite --port 3002) &

wait
