# काठमाडौँ महानगरपालिका | KMC Enterprise WebGIS, Field Data Collection PWA & Public GeoPortal

An end-to-end, installable **offline-first PWA municipal WebGIS**: field data
collection workbench, public open geospatial portal, and a unified central
enterprise geodatabase for **Kathmandu Metropolitan City (32 wards)**.

The repository has exactly **one architecture and one source tree per app**:
two Next.js 15 frontends (`frontend/`, `geoportal/`) and a FastAPI + PostGIS
backend, orchestrated by Docker Compose behind an Nginx gateway.

---

## 1. What the platform does

| Audience | Surface | Capability |
| :--- | :--- | :--- |
| Field surveyors | `frontend/` at `/` | Authenticated offline-first PWA: HOT/FMTM task grids (6 grid modes), GPS double-geofence, questionnaire-linked vector capture, full QGIS-style edit suite (move/extend/delete vertex, split, merge, link, snapping, undo/redo), house numbering, sync engine |
| GIS administrators | `frontend/` at `/dashboard` | Municipal data hub: projects & collectors, layer/raster catalog, field-visibility config, questionnaire studio, tasking manager, validator QA, Swarm security console |
| Citizens / public | `geoportal/` at `/geoportal` | Open municipal geoportal: ward analytics, layer catalog, metadata, Nepal geo-gated interactive map |
| Integrators | `backend/` at `/api` | REST API, native SQLite MBTiles tile engine, MVT via Martin, OGC WMS/WFS-T via GeoServer, offline region-clipped bundles |

---

## 2. Architecture

```
                        ┌──────────────────────────── Nginx 1.27 (kmc_server_nginx, :80/:443)
                        │  /                -> frontend:3000        (field PWA + admin console)
                        │  /geoportal       -> geoportal:3000       (public portal, basePath /geoportal)
                        │  /geoportal/map   -> geo-gated interactive map
                        │  /api/*           -> backend:8000         (FastAPI, 4 Uvicorn workers)
                        │  /tiles/data/*    -> backend:8000         (native MBTiles SQLite engine)
                        │  /tiles/*         -> tileserver:8080      (TileServer-GL fallback, edge-cached)
                        │  /martin/*        -> martin:3000          (Rust MVT, edge-cached 4GB)
                        │  /geoserver/*     -> geoserver:8080       (OGC WMS / WFS-T / WMTS)
                        └───────┬───────────────┬───────────────┬──────────────────
                                │               │               │
                            PgBouncer        Redis 7.4      data/ (host-bound
                        (1000 client pool)  (MVT cache,     persistence:
                                │            task locks)    mbtiles, uploads)
                         PostGIS 16-3.4
                         (geodatabase)
```

Ten services, one `kmc_net` bridge network. **Only nginx publishes host
ports** — every other service is reachable exclusively through the gateway
(`expose:` only, never `ports:`).

### Services and secret grants

| Service | Container | Secrets mounted at `/run/secrets/*` | Canonical URL |
| :--- | :--- | :--- | :--- |
| Nginx gateway | `kmc_server_nginx` | — | `http://localhost` (:80 / :443) |
| Field PWA / admin | `kmc_server_frontend` | — | `http://localhost/` |
| Public GeoPortal | `kmc_server_geoportal` | — | `http://localhost/geoportal` |
| FastAPI backend | `kmc_server_backend` | `kmc_postgres_password`, `kmc_redis_password`, `kmc_jwt_secret_key`, `kmc_admin_password`, `kmc_master_admin_password` | `http://localhost/api/health` (docs are disabled unless `ENABLE_API_DOCS=true`) |
| PgBouncer Pooler | `kmc_server_pgbouncer` | `kmc_postgres_password` | internal `pgbouncer:5432` |
| PostGIS 3.4 | `kmc_server_postgres` | `kmc_postgres_password` | internal `postgres:5432` |
| Redis 7.4 | `kmc_server_redis` | `kmc_redis_password` | internal `redis:6379` |
| Martin (MVT) | `kmc_server_martin` | `kmc_postgres_password` | `http://localhost/martin/` |
| TileServer-GL | `kmc_server_tileserver` | — | `http://localhost/tiles/` |
| GeoServer | `kmc_server_geoserver` | `kmc_geoserver_admin_password` | `http://localhost/geoserver/` |

`frontend`, `geoportal` and `tileserver` receive **zero** secrets
(least-privilege isolation).

For direct-port debugging only, layer the opt-in override — it binds
loopback-only ports and never changes the canonical URLs:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
# frontend http://127.0.0.1:3000 · geoportal http://127.0.0.1:3001/geoportal
# backend  http://127.0.0.1:8000/api/health · postgres 127.0.0.1:5432
# (API docs at /api/docs only when ENABLE_API_DOCS=true)
```

---

## 3. Repository layout

```
backend/app/            FastAPI application (main.py, config.py, db.py, models.py,
                        spatial_grid.py, routers/offline.py)
frontend/               Next.js 15 field PWA + admin console (standalone build)
geoportal/              Next.js 15 public GeoPortal (standalone build, basePath /geoportal)
nginx/                  default.conf — ingress, rate limiting, X-Accel-Redirect, geo-gate
scripts/                manage-swarm-secrets.sh, fetch-kmc-media.ts
secrets/                local secret files (git-ignored; only README.md is tracked)
data/                   host-bound runtime geodata (git-ignored, see data/README.md)
_archive/               retired AI Studio Vite preview mirror (not part of the product)
docker-compose.yml      local stack (file-backed secrets, single ingress)
docker-compose.dev.yml  optional loopback-only debug ports (127.0.0.1)
docker-compose.swarm.yml production Swarm stack (Raft-encrypted external secrets)
aboutthisproject.md     deep architecture / operational notes and resolved-issue log
```

Each app owns its `package.json`, `bun.lock`, `.dockerignore`, Next.js config
and exactly **one** Dockerfile:

| App | Build base | Runtime base | Gate |
| :--- | :--- | :--- | :--- |
| `frontend/` | `oven/bun:1.4.4-alpine` | `node:22.23.4-alpine` | `bun audit` |
| `geoportal/` | `oven/bun:1.4.4-alpine` | `node:22.23.4-alpine` | `bun audit` |

Dependencies are installed from the committed `bun.lock`
(`bun install --frozen-lockfile`), `next-auth` is pinned exactly to
`5.0.0-beta.32`, and the audit stage fails the build on any known
vulnerability. The runner image contains only the standalone Next.js server
(non-root `nextjs`, no Bun, no dev dependencies).

---

## 4. Quick start

### Prerequisites

* Docker Desktop / Docker Engine with Compose v2
* Bash (Git Bash or WSL on Windows) for the secret bootstrap script

### 1. Provision secrets (mandatory — the stack will not start without them)

```bash
./scripts/manage-swarm-secrets.sh init-local     # or: npm run secrets:init
cp .env.example .env
```

This generates 256-bit random values into `./secrets/*.txt` (`chmod 444` inside
a `0700` directory so the non-root backend/redis users can read the Compose
bind mounts, git-ignored, never baked into an image). No password is hardcoded
anywhere in the repository.

### 2. Build and start

```bash
docker compose config -q          # or: npm run config  (validates the model)
docker compose build              # frontend + geoportal: bun install → bun audit → next build
docker compose up -d              # or: npm run up
```

Both Next.js builds abort if `bun audit` reports a vulnerability, and both run
on the mandated `oven/bun:1.4.4-alpine` → `node:22.23.4-alpine` pair.

### 3. Open

| Surface | URL |
| :--- | :--- |
| Field PWA / admin console | <http://localhost> |
| Public GeoPortal | <http://localhost/geoportal> |
| Geo-gated public map | <http://localhost/geoportal/map> |
| FastAPI docs | `/api/docs` (only when `ENABLE_API_DOCS=true`; 404 by default) |
| Martin catalog | <http://localhost/martin/catalog> |
| GeoServer | <http://localhost/geoserver/web/> |
| Nginx health | <http://localhost/nginx-health> |

### Production Docker Swarm

```bash
./scripts/manage-swarm-secrets.sh init-swarm v1
SECRET_VERSION=v1 docker stack deploy -c docker-compose.swarm.yml kmc-gis
./scripts/manage-swarm-secrets.sh rotate kmc_jwt_secret_key v1 v2   # zero downtime
```

---

## 5. Runtime configuration (no secrets baked at build time)

* **Frontend / GeoPortal** — `docker-entrypoint.sh` writes
  `/app/public/runtime-config.js` (`window.__KMC_RUNTIME_CONFIG__`) at container
  start from `API_URL`, `TILE_URL`, `GEOPORTAL_URL`, `APP_ENV`. The same image
  runs in any environment.
* **Backend** — `backend/app/config.py` resolves every credential from
  `/run/secrets/<name>` → `<VAR>_FILE` → explicit `<VAR>` (local dev only) and
  **fails fast** when a required secret is absent. It never invents a fallback.
* **GeoPortal basePath** — the public portal is served under `/geoportal`, so its
  manifest, service worker, icons and media all carry that prefix
  (`geoportal/public/videos/kmc-poster.jpg` → `/geoportal/videos/kmc-poster.jpg`).

---

## 6. Data persistence

All municipal data lives on the host and survives `docker compose down -v`:

| Host path | Mounted into | Contents |
| :--- | :--- | :--- |
| `./data/tileserver` | backend `/tileserver-data` (RW), tileserver `/data` (RO) | uploaded `.mbtiles`, generated `config.json` / `kmc_state_store.json` |
| `./data/uploads` | backend `/app/uploads` (RW), nginx `/var/kmc_uploads` (RO) | uploaded vector layers + offline bundles |
| `./data/postgres` | postgres | PostGIS data directory (Swarm profile) |
| `./data/geoserver` | geoserver | GeoServer data directory |

These directories are runtime state: `.gitignore` and `.dockerignore` both
exclude them. See [data/README.md](data/README.md).

---

## 7. Development

```bash
npm test             # frontend: geometry engine, questionnaire schema, Swarm secrets, spatial engine
npm run test:backend # backend: task-grid, attribution and questionnaire<->layer rules (runs in the image)
npm run config       # validate the Compose model (fails if secret files are missing)
npm run verify       # config + frontend tests
```

The frontend suites live next to the code they cover
(`frontend/src/lib/*.test.js`, `frontend/utils/spatialEngine.test.js`) and run
in-process (`--test-isolation=none`) so they also work in restricted shells.
The backend suite needs no host Python — `scripts/test-backend.sh` mounts
`backend/app` and `backend/tests` into the built image and runs `unittest`.

### Field-collection rules enforced by the API

These are deliberately **not** only enforced in the browser:

| Rule | Where |
| :--- | :--- |
| A DataCollector may only submit/create inside a task grid **assigned to them** (`assigned_to`), and the grid id is stamped on the record and feature | `_resolve_collector_grid()` in `backend/app/main.py` |
| A questionnaire record is written only to the vector layer the questionnaire is **linked to** (explicit `layer_id`, never a guessed fallback) | `_resolve_record_layer()` |
| Records/features are attributed to the authenticated caller (bearer token), never to the bootstrap admin | `resolve_request_user()` |
| Draft → submit is idempotent: one record per `record_id`, one feature per record | `submit_or_draft_record()` / `_upsert_record_feature()` |
| Linking a questionnaire to a layer synchronises the layer's editable field schema | `update_layer()` / `_questionnaire_fields_config()` |

### Vertex editing engine (ताने / बिस्तार / मेट्ने)

`frontend/src/lib/geometryEditing.js` is the single, unit-tested implementation of
vertex operations. It understands polygon rings and holes, MultiPolygon /
MultiLineString parts, the duplicated closing coordinate, and the minimum valid
vertex counts, so an edit can never produce invalid geometry:

* **ताने (Move)** drags existing vertices only — OpenLayers vertex *insertion* is
  disabled on the Modify interaction, so dragging an edge no longer adds points.
* **बिस्तार (Extend)** inserts a vertex next to the selected one, in the correct
  ring/part, and only when the click is near the feature.
* **मेट्ने (Delete)** removes the tapped vertex with ring-aware guards and
  bilingual feedback; the closing duplicate maps to the last real vertex.

Admin console basics: `ADMIN_USERNAME` (default `KmcSuperUser2083`) and the
password from `./secrets/kmc_admin_password.txt`.

Master control (top-most account, above every `SuperAdmin`): `MASTER_ADMIN_USERNAME`
(default `KmcMasterAdmin2083`) and the password from
`./secrets/kmc_master_admin_password.txt`. The master account is the only one that
can permanently wipe uploaded storage and switch the public GeoPortal off.

---

## 8. Security posture

* **No plaintext credentials** in `environment:`, Compose files, images, or code.
  Local Compose uses file-backed secrets; Swarm uses Raft-encrypted external
  secrets with `mode: 0400` (backend `10001:10001`, Redis `999:1000`, other
  consumers root-read at container start).
* **Least privilege** — each container receives only the secrets it needs.
* **Fail closed** — missing secret file = startup error, not a default password.
* **Reported honestly** — `/api/system/swarm-secrets` derives
  `golden_practice_compliant` from the observed mounts instead of asserting it.

---

## 9. Notes

* `aboutthisproject.md` is the deep dive: container topology, tile engine,
  spatial indexing, LOD streaming, edit pipeline, and the resolved-issue log.
* `_archive/README.md` documents the retired AI Studio Vite preview tree that
  used to shadow these apps, and how to recover anything from it.
* TLS is an opt-in overlay: drop certificates into `nginx/ssl/` and run
  `docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d`
  (see `nginx/ssl/README.md`). Plain HTTP remains available on `HOST_PORT`.
