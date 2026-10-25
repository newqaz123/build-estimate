#!/usr/bin/env bash
# Create .venv-docling and install the pinned Docling sidecar (macOS / Linux).
#   bash scripts/setup-docling.sh          # runtime + dev (pytest) deps
#   PYTHON=python3.12 bash scripts/setup-docling.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
VENV="${ROOT}/.venv-docling"

version="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
case "$version" in
	3.11|3.12|3.13) ;;
	*) echo "error: Python 3.11-3.13 required (found ${version} at $(command -v "$PYTHON"))." >&2; exit 1 ;;
esac

if [[ ! -x "${VENV}/bin/python" ]]; then
	"$PYTHON" -m venv "$VENV"
fi
"${VENV}/bin/python" -m pip install --upgrade pip

# Linux: use the CPU torch wheels (the default index ships CUDA builds, ~3 GB).
# macOS wheels on PyPI are already CPU/MPS-only.
extra=()
if [[ "$(uname -s)" == "Linux" ]]; then
	extra=(--extra-index-url https://download.pytorch.org/whl/cpu)
fi
"${VENV}/bin/python" -m pip install "${extra[@]}" -r "${ROOT}/py-sidecar/requirements-dev.txt"

# Fetch layout/table/OCR models once and fail loudly if OCR cannot start.
(cd "${ROOT}/py-sidecar" && "${VENV}/bin/python" warmup.py)
echo "Done. Start the sidecar with: npm run dev:docling"
