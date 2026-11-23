#!/usr/bin/env bash
# ============================================================================
# KMC-GIS-SERVER — backend field-collection integrity tests
#
# Python is not required on the host: the suite runs inside the built backend
# image with the app and tests mounted read-only.  Covers task-grid assignment
# enforcement, collector attribution, strict questionnaire <-> layer binding,
# idempotent draft/submit and link-time field-schema synchronisation.
#
# Usage: ./scripts/test-backend.sh   (or: npm run test:backend)
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Git Bash (MSYS) rewrites POSIX-looking arguments such as /app/tests into
# Windows paths before they reach the Docker CLI. Mount with a mixed
# (D:/...) host path and disable that rewrite so container paths stay POSIX.
if command -v cygpath >/dev/null 2>&1; then
  ROOT_DIR="$(cygpath -m "$ROOT_DIR")"
  export MSYS_NO_PATHCONV=1
fi

docker compose run --rm --no-deps \
  -e PYTHONPATH=/app \
  -e KMC_DISABLE_STATE_PERSISTENCE=1 \
  -v "$ROOT_DIR/backend/app:/app/app:ro" \
  -v "$ROOT_DIR/backend/tests:/app/tests:ro" \
  --entrypoint python \
  backend -m unittest discover -s /app/tests -v
