#!/usr/bin/env bash
# Start the local Docling sidecar on 127.0.0.1:5001, or reuse a healthy instance.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="127.0.0.1"
PORT="5001"
HEALTH_URL="http://${HOST}:${PORT}/health"
UVICORN="${ROOT}/.venv-docling/bin/uvicorn"

port_in_use() {
	lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

# Validate that the response body identifies Docling — not just HTTP 2xx.
# An unrelated service on 5001 must not be silently reused.
health_ok() {
	local body
	body="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)" || return 1
	[[ "$body" == *'"status":"ok"'* && "$body" == *'"parser":"docling"'* ]]
}

# Reuse a valid already-running sidecar before requiring a local venv.
if port_in_use; then
	if health_ok; then
		echo "Docling sidecar already running on ${HOST}:${PORT} (healthy)."
		curl -fsS --max-time 2 "$HEALTH_URL"
		echo
		exit 0
	fi
	echo "error: port ${PORT} is already in use, but ${HEALTH_URL} is not healthy Docling." >&2
	echo "Inspect with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN" >&2
	echo "Stop the stale process, then re-run: npm run dev:docling" >&2
	exit 48
fi

# Only check the venv after confirming we actually need to start a new process.
if [[ ! -x "$UVICORN" ]]; then
	echo "error: missing Docling venv uvicorn at ${UVICORN}" >&2
	echo "Create it with the project py-sidecar/.venv-docling setup before running dev:docling." >&2
	exit 1
fi

cd "$ROOT"
exec "$UVICORN" --app-dir py-sidecar main:app --host "$HOST" --port "$PORT"
