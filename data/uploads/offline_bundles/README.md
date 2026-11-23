# KMC-GIS-SERVER Offline Survey Bundles Directory

Region-clipped offline survey packages (`.gpkg` / `.pmtiles` / vector + questionnaire
manifests) produced by FastAPI `/api/offline/package` and streamed to field devices
through Nginx `X-Accel-Redirect` at the internal location `/internal_offline_bundles/`
(see `nginx/default.conf`).

Files here are runtime output and are excluded from version control.
