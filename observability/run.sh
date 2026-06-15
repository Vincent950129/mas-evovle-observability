#!/usr/bin/env bash
# Launch the Evolve Observability server.
#
# Usage:
#   ./run.sh                  # http://0.0.0.0:8765
#   PORT=9000 ./run.sh        # custom port
#   HOST=127.0.0.1 ./run.sh   # bind to localhost only

set -euo pipefail

cd "$(dirname "$0")"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8765}"
RELOAD_FLAG=""
if [[ "${RELOAD:-0}" == "1" ]]; then
  RELOAD_FLAG="--reload --reload-dir backend --reload-dir frontend"
fi

echo "Starting Evolve Observability on http://${HOST}:${PORT}"
exec python3 -m uvicorn backend.app:app --host "${HOST}" --port "${PORT}" ${RELOAD_FLAG}
