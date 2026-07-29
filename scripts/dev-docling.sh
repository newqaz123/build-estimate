#!/usr/bin/env bash
# Start the local Docling sidecar on 127.0.0.1:5001, or reuse a healthy instance.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="127.0.0.1"
PORT="5001"
HEALTH_URL="http://${HOST}:${PORT}/health"
UVICORN="${ROOT}/.venv-docling/bin/uvicorn"

if [[ ! -x "$UVICORN" ]]; then
	echo "error: missing Docling venv uvicorn at ${UVICORN}" >&2
	echo "Create it with the project py-sidecar/.venv-docling setup before running dev:docling." >&2
	exit 1
fi

port_in_use() {
	lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

health_ok() {
	curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

if port_in_use; then
	if health_ok; then
		echo "Docling sidecar already running on ${HOST}:${PORT} (healthy)."
		curl -fsS --max-time 2 "$HEALTH_URL"
		echo
		exit 0
	fi
	echo "error: port ${PORT} is already in use, but ${HEALTH_URL} is not healthy." >&2
	echo "Inspect with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN" >&2
	echo "Stop the stale process, then re-run: npm run dev:docling" >&2
	exit 48
fi

cd "$ROOT"
exec "$UVICORN" --app-dir py-sidecar main:app --host "$HOST" --port "$PORT"
