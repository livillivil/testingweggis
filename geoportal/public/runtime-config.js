// Runtime configuration fallback for local development; overwritten at container startup by docker-entrypoint.sh
window.__KMC_RUNTIME_CONFIG__ = window.__KMC_RUNTIME_CONFIG__ || {
  API_URL: "/api",
  TILE_URL: "/tiles",
  GEOPORTAL_URL: "/geoportal",
  APP_ENV: "development"
};
