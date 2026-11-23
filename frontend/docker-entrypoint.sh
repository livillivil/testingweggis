#!/bin/sh
set -e

# ============================================================
# KMC-GIS-SERVER Frontend Runtime Config Entrypoint
# "Build Once, Run Anywhere" — Generates /app/public/runtime-config.js
# at container startup from runtime environment variables.
# Never bakes NEXT_PUBLIC_* or secrets into the Docker image at build time.
# ============================================================

cat <<EOF > /app/public/runtime-config.js
window.__KMC_RUNTIME_CONFIG__ = {
  API_URL: "${API_URL:-/api}",
  TILE_URL: "${TILE_URL:-/tiles}",
  GEOPORTAL_URL: "${GEOPORTAL_URL:-/geoportal}",
  APP_ENV: "${APP_ENV:-production}"
};
EOF

exec "$@"
