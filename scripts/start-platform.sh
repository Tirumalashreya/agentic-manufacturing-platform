#!/usr/bin/env bash
# ==============================================================================
# Enterprise Agentic Manufacturing Platform - Local Multi-Service Launcher
# ==============================================================================
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "================================================================="
echo " Starting Enterprise Agentic Manufacturing & O2C Platform"
echo "================================================================="

# Trap INT and TERM signals to kill all child processes gracefully
cleanup() {
  echo ""
  echo "Shutting down all platform services..."
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 1. Order Service (Port 4001)
echo "[1/5] Starting Order Service (Port 4001)..."
(cd services/order-service && npx tsx src/index.ts) &

# 2. Scheduling Service (Port 4005)
echo "[2/5] Starting Scheduling Service (Port 4005)..."
(cd services/scheduling-service && npx tsx src/index.ts) &

# 3. Agent Orchestrator (Port 8000)
echo "[3/5] Starting Agent Orchestrator (Port 8000)..."
if [ -d "services/agent-orchestrator/.venv" ]; then
  (cd services/agent-orchestrator && source .venv/bin/activate && uvicorn app.main:app --port 8000) &
else
  (cd services/agent-orchestrator && uvicorn app.main:app --port 8000) &
fi

# Wait for core backend services to initialize
sleep 2

# 4. Commercial Sales Portal (Port 3000)
echo "[4/5] Starting Commercial Sales Portal (http://localhost:3000)..."
(cd frontend && npm run dev) &

# 5. APS Master Planning & Shop Floor Portal (Port 3001)
echo "[5/5] Starting APS & Plant Operations Portal (http://localhost:3001)..."
(cd web && npm run dev) &

echo "================================================================="
echo " All platform services are active!"
echo "   - Commercial Sales Portal : http://localhost:3000"
echo "   - Plant APS & Gantt Portal: http://localhost:3001"
echo "   - Agent Orchestrator API  : http://localhost:8000"
echo "   - Scheduling Service API  : http://localhost:4005"
echo "   - Order Service API       : http://localhost:4001"
echo " Press Ctrl+C to stop all services."
echo "================================================================="

wait
