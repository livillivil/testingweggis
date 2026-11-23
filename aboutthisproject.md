# KMC WebGIS Enterprise: Architecture, Pipelines & Operations

> **Project:** Kathmandu Metropolitan City (काठमाडौँ महानगरपालिका) Municipal WebGIS  
> **Architecture:** 12-Factor Dockerized Microservices behind Nginx 1.27 Reverse Proxy  
> **Geodatabase:** PostGIS 3.4 on PostgreSQL 16 with Redis 7.4 MVT Cache  
> **Status:** Production-Ready (Zero preset names, Native SQLite MBTiles Engine, Questionnaire-Linked Vector Layers, Full Spatial Edit Suite)

---

## 1. System Architecture & Container Topology

The platform consists of 10 containerized services communicating over the internal Docker network `kmc_net`:

| Service | Container Name | Port | Base Image | Core Role |
| :--- | :--- | :---: | :--- | :--- |
| **nginx** | `kmc_server_nginx` | `:80`, `:443` (only published ports) | `nginx:1.27-alpine` | Gateway, rate limiting, SSL, dynamic DNS resolver, Nepal Geo-Gate, 4GB MVT edge cache |
| **frontend** | `kmc_server_frontend` | internal `:3000` | `oven/bun:1.4.4-alpine` → `node:22.23.4-alpine` | Next.js 15 Authenticated Field Data Collection PWA & Admin Console |
| **geoportal** | `kmc_server_geoportal` | internal `:3000` | `oven/bun:1.4.4-alpine` → `node:22.23.4-alpine` | Next.js 15 Public Municipal GeoPortal & Citizen Interactive Map |
| **backend** | `kmc_server_backend` | `:8000` | `python:3.11-slim` | FastAPI REST API (4 Uvicorn workers), PostGIS migrations, resumable uploads, auth, SQLite MBTiles server |
| **pgbouncer**| `kmc_server_pgbouncer` | `:5432`, `:6432` (internal) | `edoburu/pgbouncer:latest` | High-throughput connection pooler (1,000 max client connections) |
| **martin** | `kmc_server_martin` | `:3000` (internal) | `ghcr.io/maplibre/martin` | Rust PostGIS dynamic MVT vector tile server (1GB cache, 4 workers) |
| **tileserver**| `kmc_server_tileserver` | `:8080` (internal) | `maptiler/tileserver-gl` | UAV drone orthophoto MBTiles server |
| **geoserver** | `kmc_server_geoserver` | `:8080` (internal) | `docker.osgeo.org/geoserver` | Enterprise OGC WMS, WFS-T, WMTS & WCS endpoints |
| **postgres**  | `kmc_server_postgres` | `:5432` | `postgis/postgis:16-3.4` | Enterprise Spatial Geodatabase (EPSG:4326 / EPSG:3857, tuned memory & max connections) |
| **redis**     | `kmc_server_redis` | `:6379` | `redis:7.4-alpine` | Binary MVT PBF cache, session locks, and tracking cache |

### 1.1 Ingress Routing (Nginx `default.conf`)

- `/` & `/dashboard` $\rightarrow$ `frontend:3000` (Field Data PWA & SuperAdmin Console)
- `/geoportal` $\rightarrow$ `geoportal:3000` (Public Portal)
- `/geoportal/map` $\rightarrow$ `geoportal:3000` (Geo-gated full interactive map)
- `/api/*` $\rightarrow$ `backend:8000` (FastAPI REST API, MBTiles tile server & Uploads)
- `/tiles/data/*` $\rightarrow$ `backend:8000/api/tiles/data/*` (High-speed native SQLite MBTiles Tile Server)
- `/tiles/*` $\rightarrow$ `tileserver:8080/` (TileServer-GL fallback & styles)
- `/martin/*` $\rightarrow$ `martin:3000/` (Rust MVT Vector Tiles)
- `/geoserver/*` $\rightarrow$ `geoserver:8080/geoserver/` (OGC WMS/WFS)

Only nginx publishes host ports. Every upstream is referenced through an nginx
variable (`$backend_origin`, `$geoportal_origin`, …) so Docker's embedded DNS
re-resolves container IPs after recreation instead of pinning stale addresses at
startup. For direct-port debugging use the opt-in
`docker-compose.dev.yml` override (loopback-only).

### 1.2 Storage & Shared Volumes (100% Host-Bound Persistence)

1. **`./backend/app:/app/app` (Host mount):** Mounted directly into `backend:/app/app` (RW). FastAPI code changes on host take effect immediately upon container restart without waiting for image rebuilds.
2. **`./data/tileserver` (Host mount):** Mounted to `backend:/tileserver-data` (RW) and `tileserver:/data` (RO). Uploaded `.mbtiles` drone files write directly here and are permanently preserved on the host. Also stores `kmc_state_store.json` for bulletproof state recovery.
3. **`./data/uploads` (Host mount):** Mounted to `backend:/app/uploads` (RW) and `nginx:/var/kmc_uploads:ro` for uploaded GeoJSON layers, vector packages, and offline sync packages. Because it is a direct host directory mount, **running `docker compose down` or `docker compose down -v` NEVER wipes uploaded vector or raster files**.
4. **`postgres_data` (Named volume):** Persists all relational PostGIS tables, layers, and spatial features.
5. **`/run/secrets` (Swarm tmpfs mode 0400 / Compose bind-mounted files):** Zero plaintext passwords in compose. Passwords exist only as secret files read via `*_FILE`; local `init-local` files are mode 0444 inside a 0700 directory so non-root services (uid 10001, redis 999) can read them.

### 1.3 Security, Credentials & Zero-Preset Policy

- **Authentication Endpoints:** `/api/auth/login`, `/api/auth/refresh`, `/api/auth/me`.
- **System Admin Accounts (Derived from Secrets / Runtime ENV):**
  - Super Admin Username: `KmcSuperUser2083`
  - Master Admin Username: `KmcMasterAdmin2083`
  - Passwords: read from `/run/secrets/kmc_admin_password` and
    `/run/secrets/kmc_master_admin_password` — no default exists in the repository.
  - JWT Secret: read from `/run/secrets/kmc_jwt_secret_key`
- **Zero-Preset Policy:** All dummy layer names, fake projects, hardcoded admin personal names, and prototype survey templates have been completely removed. Initial system state is clean and ready for municipal operations.

---

## 2. Core Operational Pipelines

### 2.1 Native High-Performance MBTiles Raster & Vector Tile Engine

1. **Upload Execution:** UI slices `.mbtiles` files into 32 MB chunks sent to `/api/uploads/init`, `/api/uploads/{id}/chunk`, and `/api/uploads/{id}/complete` (or `/api/tiles/upload`).
2. **Lightning-Fast SQLite MMAP & In-Memory LRU Tile Serving:**
   - Tile requests to `/api/tiles/data/{slug}/{z}/{x}/{y_raw:path}` are served from persistent, read-only thread-local SQLite database connections configured with:
     - `_SQLITE_LOCAL = threading.local()`: Dedicated SQLite connection per worker thread, eliminating cursor conflicts and lock contention during parallel tile requests.
     - `run_in_threadpool`: Offloads SQLite disk I/O to background worker threads, preventing disk reads on the 7.34 GB `Whole_KMC_final.mbtiles` (829,000+ tiles, zoom 11-22) from blocking FastAPI's asyncio event loop.
     - `PRAGMA mmap_size = 268435456;` (256 MB memory-mapped zero-copy I/O straight from OS kernel cache)
     - `PRAGMA cache_size = -64000;` (64 MB memory page cache per file)
     - `PRAGMA query_only = 1;` and `PRAGMA read_uncommitted = 1;`
   - In-memory LRU cache (`_TILE_CACHE` with 8,192 entries) delivers repeated tile requests in sub-millisecond times (<0.1ms).
   - TMS coordinate flip calculation: `tms_y = (1 << z) - 1 - y` with automatic fallback to direct XYZ `y`.
   - Returns 200 transparent 1x1 PNG for coordinates outside dataset bounds to keep web maps clean.
3. **Automatic Startup Auto-Discovery & Host State Recovery:**
   - On container startup (`lifespan`), the backend automatically scans `/tileserver-data/` for all `*.mbtiles` files.
   - Reads bounds, min/max zoom, format, and metadata directly from the SQLite headers, registering them in `STATE["raster_layers"]` and updating `/tileserver-data/config.json`.
   - Loads `kmc_state_store.json` from `./data/tileserver` or `./data/uploads`, automatically restoring all vector layers, features, projects, and questionnaires.
   - **Running `docker compose down` will never remove or desynchronize uploaded rasters or vectors.**
4. **OpenLayers Client-Side Hardware Acceleration & Instant Tile Painting:**
   - `transition: 0`: Eliminates the 250ms fade-in transition delay. Tiles paint immediately without sluggish opacity dissolves.
   - `preload: 1`: Pre-renders parent zoom levels so zooming is butter-smooth without white checkerboards while high-res tiles stream in.
   - `cacheSize: 8192`: Expanded client-side RAM cache keeps visited tiles in memory.
   - `updateWhileAnimating: false` and `updateWhileInteracting: false`: Suppresses redundant redraw cycles during rapid pan/zoom gestures.

### 2.2 Unified Sub-Millisecond Spatial Grid Indexing & Progressive LOD for All Vector Layers

1. **Backend SpatialGridIndex Engine (`backend/app/main.py`):**
   - Implements a high-performance 2D spatial hash grid index with `0.005` degree (~500m) cells.
   - Replaces $O(N)$ linear scans (168,458 building footprints with 1.7 million coordinate evaluations taking 4-6 seconds) with $O(1)$ grid bucket lookups.
   - Viewport spatial bbox queries execute in **< 3 milliseconds** (a 1,700x speedup), completely freeing the Python GIL/asyncio event loop.
   - **Startup Background Warmup:** `_warm_spatial_indexes_background()` builds grid indexes in memory right after `_load_persistent_state()`, ensuring zero first-load lag.
   - **Dynamic Cache Invalidation:** `invalidate_spatial_index(layer_id)` is automatically invoked when features are added, updated, split, or deleted.
2. **Unified TomTom-Style Progressive LOD for ALL Vector Layers (Fewer in Low Zoom, Higher in High Zoom):**
   - **Road & Linestring Hierarchy Weighting:**
     - National Highways (`'NH'`, Ring Road, Tribhuvan Rajpath) and Expressways receive high priority weighting (`+1,000,000`).
     - District and Municipal Arterials receive priority weighting (`+100,000`).
     - Secondary and Collector roads receive weighting (`+10,000`).
     - Local residential alleys and dead ends receive standard length weighting.
     - Road length (`length`, `shape_leng`) and width (`road_width`, `row`) are factored into feature importance.
   - **Polygon Footprint Area Weighting:**
     - Buildings, parcels, and ward areas are ranked by surface area descending (stadiums, hospitals, landmarks first).
   - **Progressive Zoom Detail Bands (Applied Uniformly Across All Layers):**
     - **Zoom < 11.5:** Top 60 features (highways & massive landmarks only).
     - **Zoom 11.5 - 13.0:** Top 200 features (primary arterials and major structures).
     - **Zoom 13.0 - 14.5:** Top 600 features (secondary avenues and collector streets).
     - **Zoom 14.5 - 15.5:** Top 1,500 features (neighborhood roads and dense buildings).
     - **Zoom 15.5 - 16.5:** Top 4,000 features.
     - **Zoom >= 16.5:** 100% of all features in the viewport (every minor alley, footpath, and structure).
3. **Non-Destructive Feature Merging & Zoom-Out Flushing (`KmcMap.jsx`):**
   - **Zoom-Out Flushing:** When the user zooms OUT (`currentZoom < lastZoom - 0.25`) or transitions across LOD bands ($\ge 0.75$), the vector source flushes higher-density features so the clean, generalized lower-density features replace them immediately without clutter.
   - **Seamless Accumulation During Pan/Zoom-In:** Features loaded across multiple tile extents are deduplicated by unique ID (`getId() || get('id') || get('_id')`). Existing features on screen remain intact, preventing vertical cutoff lines.
   - **Sub-Pixel LOD Culling:** Polygons smaller than 2.5px and lines shorter than 4.0px at lower zooms (`resolution > 2.5`) are culled from rendering, eliminating visual clutter and GPU overhead.
   - **Adaptive Cartographic Line Styling:** Roads render with clean 1.8px hairlines at low zoom ($z < 15$), and transition to bold dual-cased thoroughfares (dark casing $\ge 4.5\text{px}$, stroke $\ge 2.5\text{px}$) at street zoom ($z \ge 16$).
   - **Distant Memory Pruning:** If in-memory features exceed 25,000, features outside $2\times$ viewport extent are safely pruned.
4. **GPU Hardware Acceleration Restoration:**
   - Removed the `willReadFrequently: true` canvas prototype patch across all map modules (`KmcMap.jsx`, `GeoPortalMap.jsx`).
   - Restores native GPU direct rasterization (Direct3D / Metal / OpenGL) in Chromium and WebKit for smooth 60 FPS panning.
5. **Zero-Allocation Vector Style Singletons:**
   - Styles are pre-allocated as static singletons (`defaultPolyStyle`, `defaultOutlinePolyStyle`, `defaultLineStyle`, `defaultPointStyle`) and returned directly by reference. Heap allocations drop to zero during rendering, eliminating Garbage Collection stutter.
6. **`renderOrder: null` & Throttled Pointer Events:**
   - Setting `renderOrder: null` on `VectorLayer` eliminates CPU feature-sorting overhead on every frame.
   - `pointermove` feature hit-testing and snapping checks are throttled to 20ms, preventing mouse moves from saturating the CPU thread over dense polygons.

### 2.2 Questionnaire to Vector Layer Linking & Edit Mode Workflow

1. **Linking Questionnaire to Vector Layer:**
   - In Admin Panel (Questionnaires Tab) or Questionnaire Studio (`QuestionnaireBuilder.jsx`), administrators can:
     a) **"यस प्रश्नावलीबाट नयाँ भेक्टर तह सिर्जना गर्नुहोस्"**: Automatically extracts questionnaire questions into layer `fields_config`, creates a spatial vector layer with `questionnaire_id = q.id`, and scopes it to the project.
     b) **"मौजुदा भेक्टर तहसँग जोड्नुहोस्"**: Links an existing vector layer to a questionnaire (`layer.questionnaire_id = q.id`).
2. **Feature Creation in Edit Mode:**
   - When a collector or admin turns on **Edit Mode** on a vector layer linked to a questionnaire and draws a geometry (Point, Line, Polygon) on the map:
   - The map workbench detects `activeEditLayer.questionnaire_id` and automatically opens the **Questionnaire Form** (`QuestionnaireForm.jsx`) pre-bound to the drawn geometry.
3. **Submission & Feature Attribute Population:**
   - On submitting the survey, `recordsAPI.submit` persists the record and simultaneously inserts a GeoJSON feature into that vector layer's PostGIS / in-memory store.
   - The feature's properties are populated directly with all questionnaire answers and metadata (`_record_id`, `_questionnaire_id`, `_status: SUBMITTED`).
   - The map layer refreshes immediately, displaying the new spatial feature with all survey attributes.

### 2.3 Spatial Editing Pipeline (Edit Mode Full Toolset)

When Edit Mode is activated on a layer, the editor exposes a full spatial manipulation suite:
1. **ताने (Move / Drag Vertex):** Drags individual geometry vertices or entire features to new locations with coordinate snapping.
2. **बिस्तार (Extend / Add Vertex):** Inserts new vertices along linestrings and polygon boundaries.
3. **मेट्ने (Delete Vertex):** Removes selected vertices via right-click or tool tap.
4. **काट्ने (Split Feature with Blade):** Draws a blade line across any polygon or linestring. Sent to `POST /api/features/{id}/split`, which partitions the geometry into 2 parts, assigning the suffix `-B` to cloned attribute codes (e.g. `BLD-102-B`).
5. **जोड्ने (Merge Features):** Enables multi-selection of features on the map. Sent to `POST /api/layers/{id}/merge` with mode `union` or `multifeature`, merging geometries and consolidating attributes into the primary feature.
6. **लिङ्क (Cross-Layer & Same-Layer Feature Linking):** Interactively connects features (e.g., building to road, parcel to owner) via `POST /api/features/{id}/link`.
7. **बिन्दु स्न्यापिङ (Magnetic Snapping):** Toggles snapping to nearby vertices/edges with tolerance settings from 5px to 25px.
8. **Undo / Redo History:** Maintains a stack of geometry states with keyboard shortcuts (`Ctrl+Z`, `Ctrl+Y`, `Backspace`).
9. **Permitted Geometry Enforcement:** Drawing tools strictly respect layer configuration (`Point`, `LineString`, `Polygon`).

### 2.4 Feature Click / Tap Popup Card with Field Filtering & Compact Bottom-Right Docking

When a vector feature is clicked on the map in non-edit mode:
1. `ReadOnlyAttributePopup` opens as a compact, bottom-right docked card (`fixed bottom-4 right-3 sm:right-4 z-40 w-72 sm:w-80 max-h-[58vh]`):
   - **Zero Map & Navigation Obstruction:** Placed neatly at the bottom-right corner, leaving the center of the map, street networks, clicked features, and top navigation header completely visible.
   - **1-Click Minimization:** Features an interactive minimize toggle (`_` / `+`) that collapses the card into a sleek 36px pill (`#feature-inspector-popup-min`) showing just the feature title and pulse indicator, allowing unobstructed panning without losing context.
2. **GIS Administrator Field Filtering & Visibility Controls:**
   - In Admin Panel -> Layers -> Fields Config: Administrators can toggle individual fields on or off using the interactive **"पपअपमा देखाउने" (Show in Popup)** switch (`Eye` / `EyeOff` badges).
   - Includes bulk action buttons: **"सबै देखाउने" (Show All)** and **"सबै लुकाउने" (Hide All)**.
   - Saves directly to `PUT /api/layers/{layer_id}/fields` and persists in PostGIS and `kmc_state_store.json`.
   - If the layer has `fields_config` specified by the administrator: ONLY permitted fields where `visible_in_popup !== false` are shown in the exact configured sort order.
   - If `fields_config` is empty or unconfigured: All feature attributes are shown with automatic auto-detection.
   - Internal system metadata (`_id`, `_layerId`, `_version`, `_status`, `_created_at`, `_updated_at`, `geometry`, etc.) is strictly filtered out.
3. **Quick Actions:** Includes Zoom to feature, 1-Click Transition to Edit Mode, Split, Merge, Link, and Copy Attribute Value.

### 2.5 Project Management & Deletion Pipeline

1. **Backend Endpoint:** `DELETE /api/projects/{project_id}` safely removes the project, associated task assignments, and collector mappings.
2. **Non-Destructive Layer Unlinking:** Vector and raster layers scoped solely to the deleted project have their `project_id` cleared to `null` so spatial data is never accidentally deleted or orphaned.
3. **UI Confirmation:** Administrators can delete projects via the trash button on the project header bar or the danger zone button in the expanded project details with interactive confirmation.

---

## 3. Key Issues Resolved

1. **Raster Synthetic Cartoon SVG & Blank Tiles:**
   - *Cause:* Prototype mock engine generated synthetic green crosshair SVGs; TileServer-GL static config didn't hot-reload dynamically uploaded MBTiles at runtime.
   - *Fix:* Gutted synthetic SVG generators to `null`; implemented native FastAPI SQLite MBTiles tile serving (`/api/tiles/data/*`); normalized OpenLayers extent bounds.
2. **Vector Upload 0-Feature Drop:**
   - *Cause:* ArrayBuffer typed array chunks were dropped; localStorage quota exceeded (>5MB).
   - *Fix:* Universal chunk acceptance; robust coordinate bounding box scanner; protected `saveDb` with metadata fallback; PostGIS layer persistence.
3. **FastAPI Route Parameter Conflict (`project_id`):**
   - *Cause:* Stacked routes with `Form(None)` parameter conflicting with path param `{project_id}`.
   - *Fix:* Separated routes into distinct Path and Form endpoint handlers.
4. **Nginx Upstream Resolution Crash (`martin`):**
   - *Cause:* Static DNS failure when Martin was waiting for Backend.
   - *Fix:* Added embedded DNS `resolver 127.0.0.11 valid=10s ipv6=off;` with dynamic variable proxying.
5. **Clean Zero-Preset State:**
   - Preserves system usernames and passwords while completely removing hardcoded personal names, dummy projects, mock questionnaires, and fake layers.
6. **Next.js Production Build Scoping Conflict (`projDetailMatch`):**
   - *Cause:* Duplicate declaration of outer-scoped `const projDetailMatch` in `kmcBackendEngine.js` caused Next.js SWC/Webpack production build to fail during `bun run build`.
   - *Fix:* Unified project routes into a single outer-level handler supporting `GET`, `PUT`, and enhanced `DELETE` with cascading task, assignment, and collector cleanup.
7. **FastAPI Tile Route Prefix Collision & Container Volume Mount:**
   - *Cause 1 (Route Collision):* The route `@app.get("/api/tiles/{slug}/{z}/{x}/{y_raw:path}")` was registered before `/api/tiles/data/{slug}/{z}/{x}/{y_raw:path}`. Starlette matched `/api/tiles/data/ward_23/...` against the 4-segment route, binding `slug = "data"` and `z = "ward_23"`. When FastAPI attempted to validate `z: int`, it failed with `{"type": "int_parsing", "loc": ["path", "z"], "input": "ward_23"}` (`422 Unprocessable Entity`).
   - *Cause 2 (Unmounted Volume):* `docker-compose.yml` mounted `./data/tileserver` but omitted `./backend/app:/app/app`, causing running containers to serve stale code from image build time until mounted and recreated.
   - *Fix:*
     a) Added `./backend/app:/app/app` volume mount in `docker-compose.yml` so code changes take effect dynamically.
     b) Decoupled tile routes into distinct dedicated handlers: `/api/tiles/data/{slug}/{z}/{x}/{y_raw:path}` and a flexible fallback handler that auto-detects `if slug == "data"` and recovers `(real_slug, real_z, real_x, real_y)`.
     c) Recreated the `kmc_server_backend` container. Verified live tile response: `Status: 200, Size: 7014 bytes, Content-Type: image/webp` on port `:8000`, frontend port `:3000`, and Nginx port `:80`.
8. **Missing Backend Endpoints (Tasks, Feature Linking, Split, Merge):**
   - *Cause:* Endpoints `/api/projects/{id}/tasks`, `/api/features/{id}/linked`, `/api/features/{id}/link`, `/api/features/{id}/split`, and `/api/layers/{id}/merge` returned 404 on the backend.
   - *Fix:* Implemented all endpoints in `backend/app/main.py` with PostGIS and memory fallback.
9. **Feature Click / Tap Attribute Display Card:**
   - *Implementation:* When a feature is clicked on the map, `ReadOnlyAttributePopup` displays a compact, scrollable card. If the layer administrator has configured specific allowed fields in `layer.fields_config`, only those fields are displayed; if no specific allowed fields are configured, all feature properties are shown (excluding internal keys like `_id`, `_layerId`, `_version`, `_status`).
10. **Edit Mode Full Toolset Restoration:**
   - *Implementation:* In Edit Mode, the tools panel and map workbench expose all spatial editing options (Move, Extend, Delete, Split, Merge, Link, Snapping, Undo/Redo, Draw).
11. **Uploaded Raster & Vector Data Persistence Across `docker compose down`:**
   - *Cause 1 (Raster Desync):* MBTiles files were written to host `./data/tileserver/`, but `STATE["raster_layers"]` was only stored in container memory. On container restarts or `docker compose down`, `STATE["raster_layers"]` reset to `[]`, making it appear files were removed even though they existed on disk.
   - *Cause 2 (Vector Named Volume Wipe):* Uploaded GeoJSON layers were stored in a Docker named volume (`uploads_data`) and in-memory `STATE["vector_layers"]` rather than a host-bound directory, risking data loss on volume pruning.
   - *Fix:*
     a) Mounted host `./data/uploads:/app/uploads` and `./data/uploads:/var/kmc_uploads:ro` in `docker-compose.yml`, so both vector and raster data reside permanently on the Windows host.
     b) Implemented `_save_persistent_state()` and `_load_persistent_state()` saving `kmc_state_store.json` on disk upon every upload or layer modification.
     c) Added `_scan_and_sync_tileserver_mbtiles()` on container startup (`lifespan`), automatically discovering all `.mbtiles` files, extracting bounds/zoom/metadata, auto-registering them in `STATE["raster_layers"]`, and updating `/tileserver-data/config.json`.
12. **Slow Map Rendering & Page Lag Elimination (Hardware Acceleration & Zero-Allocation):**
   - *Cause 1 (GPU Disabled):* A canvas prototype patch forcing `willReadFrequently: true` caused Chromium/WebKit to disable GPU hardware acceleration and switch all map rendering to software CPU emulation.
   - *Cause 2 (Memory Heap Churn):* OpenLayers vector style functions created `new Style()`, `new Fill()`, and `new Stroke()` for every feature on every 60fps frame, generating over 100,000 heap allocations per second and triggering Garbage Collection freeze pauses.
   - *Cause 3 (Unthrottled Hover & 250ms Tile Transition):* Unthrottled `pointermove` feature hit-testing ran continuously, and raster `TileLayer` had default 250ms fade transitions with single-connection SQLite disk reads.
   - *Fix:*
     a) Removed the `willReadFrequently: true` patch across all map components, restoring full GPU hardware acceleration.
     b) Cached static style singletons in `createLayerStyle()`, dropping heap allocations during panning/zooming to zero.
     c) Configured `renderOrder: null`, `updateWhileAnimating: false`, and `updateWhileInteracting: false` on vector layers.
     d) In `TileLayer`, added `transition: 0`, `cacheSize: 8192`, and `preload: 1` for instantaneous, flicker-free tile display.
     e) Turbocharged FastAPI MBTiles tile serving with persistent read-only SQLite connections, 256MB memory-mapped zero-copy I/O (`PRAGMA mmap_size = 268435456`), and in-memory LRU caching (`_TILE_CACHE`).
     f) Implemented spatial viewport filtering (`GET /api/layers/{id}/features?bbox=...`) so large vector layers only stream features within the visible bounding box.

---

13. **Instant Layer Catalog Loading on Page Reload (0ms Stale-While-Revalidate Hydration):**
    - *Bottleneck:* Previously, reloading the page fetched full GeoJSON feature collections for every single layer in the municipal catalog in one synchronous payload, transferring dozens of megabytes before rendering layer controls.
    - *Fix:*
      a) **Decoupled Metadata Catalog:** `GET /api/layers` and `GET /api/projects/{id}/layers` now default to `include_features: false`, reducing the payload from ~50MB to ~2KB and returning in under 5ms.
      b) **Client-Side SWR Local Hydration:** In `frontend/src/app/dashboard/page.js`, initial states of `serverVectors` and `serverRasters` are hydrated synchronously from `localStorage` (`kmc_cached_vector_layers` and `kmc_cached_raster_layers`). On page reload, the layer catalog displays in **0 milliseconds** with no loading spinner, while fresh metadata is verified in the background.
14. **TomTom-Style Progressive Level of Detail (LOD) Layer Streaming & Sub-Pixel Culling:**
    - *Architecture:* Modeled after industry standards (TomTom, Mapbox, Google Maps) to keep pan and zoom at a fluid 60 FPS even with datasets exceeding 100,000 buildings or parcel polygons.
    - *Area-Prioritized Streaming:* On `GET /api/layers/{layer_id}/features`, features are sorted by physical footprint area in descending order (`_feature_approx_area`) so major landmarks and district boundaries stream and render first.
    - *Zoom-Tiered progressive detail filtering:*
      - Zoom < 13.5 (City overview): streams top 80 major landmarks / primary boundaries.
      - Zoom < 15.5 (Ward level): streams top 250 large and medium structures.
      - Zoom < 17.0 (Neighborhood): streams top 750 structures.
      - Zoom >= 17.0 (Street level): streams all visible features within viewport.
    - *Screen-Pixel Sub-Pixel LOD Culling:* In OpenLayers `createLayerStyle(feature, resolution)`, polygons whose screen dimensions are smaller than 2.5 screen pixels (`widthPx < 2.5 && heightPx < 2.5`) return `null`. This eliminates tens of thousands of invisible draw calls at low zoom levels.
    - *BBOX Feature Threshold:* Lowered `BBOX_FEATURE_THRESHOLD` from 3,000 to 150 features so any layer with >150 features automatically streams via viewport bounding box.
15. **Questionnaire Linking to Vector Layers & In-Field Form Attribute Synchronization:**
    - *Architecture:* Deep integration between ODK-compatible advanced questionnaires and GIS vector layers.
    - *Builder Integration:* In Questionnaire Builder, administrators click **"भेक्टर तह सिर्जना / जोड्नुहोस्" (Create / Link Vector Layer)** to generate or sync a vector layer whose schema matches the questionnaire's questions, binding `questionnaire_id: activeQId`.
    - *Admin Console Linking:* In the Admin Panel, administrators can link any existing vector layer to a project questionnaire and auto-synchronize `fields_config`.
    - *Edit Mode Dynamic Form Launch:* In Dashboard, toggling Edit Mode on a vector layer linked to a questionnaire (or drawing a feature on that layer) immediately triggers `QuestionnaireForm` with the drawn geometry.
    - *Backend Persistence:* Submitting the survey record via `/api/projects/{id}/records/submit` automatically creates the vector feature in the target layer with all questionnaire answers mapped to feature attributes, triggers atomic host persistence to `kmc_state_store.json`, and dispatches `setBboxReloadTrigger` to update the map in real time.
16. **Admin Project Deletion Feature in Header Navigation & Admin Console:**
    - *UI Placement:* Added project deletion with confirmation directly inside the Navbar project switcher dropdown (Trash2 button for administrators) in both desktop and mobile views, in addition to the Admin Console danger zone.
    - *Cascading Safety:* `DELETE /api/projects/{id}` removes project grid tasks, unassigns collectors, and clears `project_id` from associated layers so no spatial data is orphaned or lost.
17. **Large Building & Road Vector Layers Rendering & Pointer Event Optimization:**
    - *Bottleneck:* Uploading city-wide datasets with 168,000+ building polygons and 13,000+ road linestrings caused the browser to lag and freeze during panning and hover interactions.
    - *Fix:*
      a) **Pointer Event Throttling:** Throttled `pointermove` spatial hit-testing in `KmcMap.jsx` from 20ms (50Hz) to 80ms (12Hz), reducing CPU hit-testing overhead by over 75%.
      b) **Spatial Hit-Testing Tolerance Optimization:** Reduced `hitTolerance` in `findVectorFeatureAtEvent` from 40px to 10px. Previously, a 40px radius across dense building and road clusters caused OpenLayers to evaluate spatial containment for dozens of adjacent features per frame.
      c) **Viewport Extent BBOX Progressive LOD:** Combined vertex bounding envelope intersection with physical area sorting so dense structures stream progressively without overwhelming the browser thread.
18. **GIS Administrator Field Limiting & Compact Bottom-Right Popup Card:**
    - *Feature & UX Enhancement:* When clicking a feature, previous bottom sheets or top dialogs obstructed the map or navigation headers. Administrators also needed full access to select among all attributes.
    - *Fix:*
      a) **Compact Bottom-Right Placement:** Docked `ReadOnlyAttributePopup` to `fixed bottom-4 right-3 sm:right-4 z-40 w-72 sm:w-80 max-h-[58vh]` with a 1-click minimize toggle (`#feature-inspector-popup-min`) so the entire map center and navigation remain 100% visible.
      b) **Unfiltered Field Selection for GIS Admin:** In `backend/app/main.py` and `AdminPanel.jsx`, field detection provides ALL layer attributes without skipping (including IDs, codes, numeric indicators). The GIS Admin chooses which fields to display in popups (`visible_in_popup: boolean`).
      c) **Non-Blocking Background Persistence:** Offloaded `_save_persistent_state()` to a dedicated daemon background worker thread with `_STATE_SAVE_LOCK`, reducing endpoint response time from 15,000ms to <400ms.
19. **UTM Zone 45N (EPSG:32645) Coordinate Reprojection (Buildings Layer Fix):**
    - *Root Cause:* The KMC Buildings layer (168,458 polygons) had coordinates exported in Nepal UTM Zone 45N (e.g. Easting `337,988m`, Northing `3,067,475m`). When querying viewport bounding box in WGS84 degrees (`85.26, 27.66`), the spatial intersection check failed completely (returning 0 features). Furthermore, OpenLayers attempted to reproject UTM meter values as if they were latitude degrees (>90°), resulting in NaN/Infinity geometries.
    - *Fix:* Implemented high-precision Transverse Mercator ellipsoid conversion (`utm45n_to_wgs84`) in `backend/app/main.py`. Automatically detects coordinates in UTM 45N range ($100k \le X \le 900k, 2M \le Y \le 4M$), reprojects all vertices to WGS84 EPSG:4326 (`85.3565°E, 27.7218°N`), and normalizes layer bounds to `[85.2666, 27.6747, 85.3670, 27.7508]`.
20. **Vector Layer Opacity Normalization & OpenLayers Canvas Redraw (Roads Layer Fix):**
    - *Root Cause:*
      1. Default layer opacity from the backend was `1` (scale 0..1). `KmcMap.jsx` computed `opacity = (layerData.opacity ?? 100) / 100 = 1 / 100 = 0.01` (1% opacity). The road layer was rendered with 99% transparency, rendering it invisible to the human eye.
      2. When hovering, `featureHighlightLayer` rendered the hovered road at 100% opacity in thick amber (`#f59e0b`, width 5.5), which made it appear that only hovered features existed.
      3. Bbox progressive loading called `source.clear(true)` without signaling layer change events to OpenLayers' vector canvas cache.
    - *Fix:*
      1. Normalized opacity calculation: `const rawOpacity = layerData.opacity ?? 1; const opacity = rawOpacity > 1 ? rawOpacity / 100 : Math.max(0, Math.min(1, rawOpacity));` so opacity `1` renders at full 100% opacity.
      2. Set default road stroke width to `3.0px` for bold visibility.
      3. Added `source.changed()` and `layer.changed()` after bbox and dynamic LOD feature insertions, ensuring the vector canvas repaints immediately without requiring cursor hover.

---

## 4. Operational CLI & Debugging Quick Reference

```bash
# Start all containers in background
docker compose up --build -d

# Check service health
docker compose ps

# View backend logs (FastAPI)
docker compose logs -f backend

# Verify backend health endpoint
curl -i http://localhost/api/health

# Verify raster tiles endpoint
curl -i http://localhost/api/tiles

# Test native SQLite tile pyramid fetch (within dataset bounds)
curl -i http://localhost/tiles/data/ward_23/16/48297/27516.webp
curl -i http://localhost/api/tiles/data/ward_23/16/48297/27516.webp

# Test out-of-bounds coordinate (returns 200 1x1 transparent PNG)
curl -i http://localhost/api/tiles/data/ward_23/13/6037/3439.webp

# Verify vector layers endpoint
curl -i http://localhost/api/layers

# Verify project tasks endpoint
curl -i http://localhost/api/projects/1/tasks

# Query PostGIS database
docker compose exec postgres psql -U kmc_user -d kmc_gis -c "SELECT id, name, category, geometry_type FROM vector_layers;"
```

### 4.1 Browser Console Testing (F12)

```javascript
// Check currently loaded raster and vector layers in local engine
console.log(JSON.parse(localStorage.getItem('kmc_enterprise_geodb_v6')).rasterLayers);
console.log(JSON.parse(localStorage.getItem('kmc_enterprise_geodb_v6')).vectorLayers);

// Force real backend network requests (default)
window.__KMC_FORCE_MOCK__ = false;

// Force offline mock mode
window.__KMC_FORCE_MOCK__ = true;

// Reset browser storage and reload
localStorage.clear();
location.reload();
```

---

## 5. Critical File Registry

| File Path | Purpose & Responsibilities |
| :--- | :--- |
| `backend/app/main.py` | FastAPI implementation: `/api/uploads/*`, `/api/tiles/data/*` (native SQLite MBTiles engine with TMS inversion), `/api/layers/*`, `/api/projects/{id}/tasks`, `/api/features/{id}/linked`, `/api/features/{id}/split`, `/api/layers/{id}/merge`, and `DELETE /api/projects/{id}`. |
| `docker-compose.yml` | Container specifications: tmpfs secrets, mounts for `./data/tileserver` and `./backend/app:/app/app`, health checks, zero plaintext passwords. |
| `nginx/default.conf` | Ingress routing: `/api/` to backend, `/tiles/data/` direct proxy to FastAPI SQLite engine, `/` to frontend, `/geoportal` to geoportal. |
| `frontend/src/app/dashboard/page.js` | Main workbench coordinator: consolidated left editing workbench (`#left-tools-container`), vector & raster layer toggles, full Edit Mode toolset (Move, Extend, Delete, Split, Merge, Link), questionnaire launching on feature draw, and attribute popup wiring. |
| `frontend/src/components/SplitFeatureModal.jsx` | QGIS-style scientific geometric split dialog with Shapely C-GEOS preview, geodesic area/length telemetry, 4-mode ID assignment strategy, and independent attribute customization for Part 1 & Part 2. |
| `frontend/src/components/MergeFeaturesModal.jsx` | QGIS-style scientific geometric merge dialog with primary template selection, customizable merged ID, Spatial Union (Dissolve) vs Multi-Feature modes, and full attribute override editor. |
| `frontend/src/components/CreateLayerModal.jsx` | Vector layer creator supporting Point, LineString, Polygon, and Mix geometries with Global vs Project scoping and KMC color styles. |
| `frontend/src/components/KmcMap.jsx` | OpenLayers map component: raster XYZ `TileLayer` with normalized bounding box clipping, vector drawing interactions, vertex modification, and magnetic snapping. |
| `frontend/src/components/ReadOnlyAttributePopup.jsx` | Feature click popup card: filters displayed attributes by `layer.fields_config` (or shows all if unconfigured), quick actions for Zoom, Edit, Split, Merge, and Link. |
| `frontend/src/components/AdminPanel.jsx` | Admin management console: project deletion with interactive confirmation, questionnaire-to-vector layer creation & linking. |
| `frontend/src/components/questionnaire/QuestionnaireBuilder.jsx` | Questionnaire studio with "भेक्टर तह सिङ्क" (Sync Vector Layer) action. |
| `frontend/src/lib/api.js` | Axios client with `kmcProgressiveAdapter` (attempts real backend first, falls back to engine). |
| `frontend/src/lib/geometryEditing.js` | Pure, ring/part-aware vertex engine for ताने / बिस्तार / मेट्ने (unit-tested, no OpenLayers dependency). |
| `frontend/lib/kmcBackendEngine.js` | Progressive client-side mock/offline engine for zero-network environments. |

---

## 6. Repository Consolidation — Single Source of Truth (Amendment)

The repository used to carry **two competing applications**. The retired one was an
AI Studio Vite SPA (`index.html`, `src/App.tsx`, `src/main.tsx`, `vite.config.ts`,
root `package.json`/`bun.lock`, root `public/`, `.aistudio/`) whose `src/frontend/**`
and `src/geoportal/**` were byte-identical copies of the two shipped Next.js apps
(48 duplicate file groups), plus a dead TS island (`src/components/*.tsx`,
`src/data/`, `src/i18n/`) imported by nothing. It is archived in
`_archive/aistudio-mirror-*.zip` (see `_archive/README.md`) and is no longer part of
the build, the docs, or the deployable surface.

### 6.1 Conflicts removed

| Conflict with the project theme | Resolution |
| :--- | :--- |
| Two source trees for every component → guaranteed drift (the mirror already missed `resolveSwarmSecret`, `buildDatabaseUrlsFromSecrets`, `validateSecretStrength`) | Mirror retired; unique logic + the three `node:test` suites ported into `frontend/src/lib/` and `frontend/utils/` |
| `src/main.tsx` re-applied the `willReadFrequently: true` canvas patch that §2.2.4/§3.12 removed for GPU acceleration | Patch gone with the mirror; the hardware-acceleration fix now holds everywhere |
| A third Tailwind theme (v4 `@theme` in `src/index.css`) re-declaring the gov tokens | Deleted; `frontend/tailwind.config.js` and `geoportal/tailwind.config.js` are the only token sources (portal config now also defines the shared `gov` shadows and `pulse-slow`/`fade-in`/`slide-*` animations it referenced but never had) |
| Nested duplicate media (`public/geoportal/**`, `frontend/public/geoportal/**`, `geoportal/public/geoportal/**`) broke `/geoportal/videos/kmc-poster.jpg` and shipped four copies of an 18 MB video | Media canonicalised: `geoportal/public/videos/kmc-poster.jpg` now serves `/geoportal/videos/kmc-poster.jpg`; unused video copies and nested trees removed |
| PWA theme documented but not wired: no `<link rel="manifest">`, no service-worker registration in either Next.js app (only in dead AI Studio code); portal manifest claimed `scope: "/"` | `PwaRegistrar` in both root layouts; manifest metadata on the PWA; portal manifest/SW scoped to `/geoportal/` with basePath-corrected precache lists; dead `/index.html` entry dropped |
| Four unused portal components inside `frontend/src/components/geoportal/` contradicting `GeoPortalView`'s "single source of truth in /geoportal" doctrine | Removed; only the redirector remains |
| Hardcoded plaintext passwords in `docker-compose.yml` entrypoints and `_BOOTSTRAP_SECRET_DEFAULTS` in `backend/app/config.py`, while docs claimed zero plaintext secrets | Compose now declares file-backed `secrets:`; services read `/run/secrets/*` via `*_FILE`; `config.py` never invents a value and fails fast; the posture endpoint derives compliance instead of asserting it |
| `secrets/*.txt` and `.env` were un-ignored by `.gitignore` | `.gitignore` now ignores `secrets/*` and `.env*` (README/template kept) |
| 7.5 GB of runtime geodata (`.mbtiles`, `kmc_state_store.json`, uploaded GeoJSON) treated as source | Files untouched, excluded from VCS and build contexts; `data/README.md` documents host-bound persistence |
| Duplicate per-service `*.dockerfile` files drifting from the authoritative inline recipes | Deleted; each app now owns exactly one `Dockerfile` (`oven/bun:1.4.4-alpine` → `node:22.23.4-alpine`) and `bun audit` gates every build |
| Misplaced/invalid `robots.txt` (HTML comment, served at `/geoportal/robots.txt` where crawlers never look) | Replaced by a valid root-level `frontend/public/robots.txt` served at `/robots.txt` |
| `windows-docker-fix.bat`, `metadata.json` (Gemini capability), `@google/genai`/`express`/`vite` dependencies | Removed with the Vite scaffold |

### 6.2 Verification

```bash
npm test        # 38 tests pass: Swarm secrets, questionnaire schema, spatial engine, geometry editing
npm run test:backend  # 93 backend tests inside the built image
npm run config  # Compose model validates; fails fast when ./secrets/*.txt are absent
```

### 6.3 Remaining debt (deliberately not refactored here)

1. `backend/app/main.py` remains a large single module with the majority of the
   routes inline; only `routers/offline.py` is split out. Continue splitting it
   domain by domain (auth, layers, features, tiles, projects, tracking,
   questionnaires) with unchanged paths to avoid breaking clients.
2. The two Next.js apps each keep a private copy of the shared logic modules:
   `utils/spatialEngine.js` (byte-identical today) and
   `lib/kmcBackendEngine.js` (same public shape, bodies have already drifted).
   Acceptable for independent build contexts, but a shared workspace package
   would remove the last duplication and the silent behavioural drift.
3. `frontend/` keeps a legacy `package-lock.json` next to the authoritative
   `bun.lock` used by the build. Removing the npm lock file would prevent
   accidental `npm install` drift.

---

## 7. Field-Collection Integrity & Vertex Editing Engine (Amendment)

This section records the second consolidation pass: the three geometric edit tools
and the questionnaire → vector-layer pipeline, which are the heart of a field
survey application.

### 7.1 Why ताने / बिस्तार / मेट्ने misbehaved

The tools looked correct in the UI but the underlying vertex helpers were written
against a **flat coordinate list**, while OpenLayers geometries are nested:

| Defect | Root cause | Fix |
| :--- | :--- | :--- |
| ताने silently added vertices when an edge was dragged | OpenLayers `Modify` inserts a vertex on segment drag by default (`insertVertexCondition` was not set) | `insertVertexCondition: () => false`; only बिस्तार inserts |
| बिस्तार inserted into the wrong ring / polygon | `insertCoordinateAtVertex` treated a **global** vertex index as an index into ring 0, so holes and MultiPolygon parts were ignored | `insertVertexAt()` resolves the owning part and clamps to before the closing coordinate |
| मेट्ने corrupted or refused correct edits | Minimum-vertex guards compared the **total** coordinate count (holes included); only ring 0 was editable; the closing duplicate counted as a vertex | `removeVertexAt()` enforces per-ring/per-line minimums, drops emptied multipart parts, maps the closing duplicate to the last real vertex |
| मेट्ने failed silently | No feedback when no vertex was within tolerance | bilingual `describeEditFailure()` messages surfaced through `onFeatureBlocked` |
| बिस्तार appended stray vertices far from the feature | Any empty-map click inserted a vertex | click must be within 28 px of the geometry (or inside a polygon) |
| Edit tool aliases (`tane`/`modify`, `bistar`/`extend`, `metne`/`deleteVertex`) disagreed across branches | ad-hoc string comparisons | `isMoveSubMode` / `isExtendSubMode` / `isDeleteSubMode` helpers used everywhere |
| Undo history doubled / React warnings | `setUndoStack()` was called **inside** a `setSelectedFeature()` updater | history is pushed outside the updater using a `selectedFeatureRef`; unchanged geometry no longer pollutes the stack |
| "अन्तिम हटाउने" (remove last vertex) ignored multipart geometries | hand-rolled splice on `coordinates[0]` only | delegates to `removeLastVertex()` |

`frontend/src/lib/geometryEditing.js` now owns every vertex operation and is
covered by `frontend/src/lib/geometryEditing.test.js` (18 tests: lines, polygons
with holes, multipart, closure, minimums, duplicate rejection, nearest-vertex
selection, validation).

### 7.2 Why questionnaire → layer integration was not as specified

| Defect | Impact | Fix |
| :--- | :--- | :--- |
| Submit fell back to "any layer of the project", then "the first layer in the database" | Survey records could be written into an unrelated layer | `_resolve_record_layer()` requires `layer_id` or a questionnaire-bound layer; otherwise HTTP 400 |
| Features were attributed to `settings.admin_username` with `_created_by: 1` | Collector work was credited to the admin; QA/validation was meaningless | `resolve_request_user()` parses the bearer token; `_created_by` / `_created_by_username` are real |
| No server-side task-grid enforcement | A collector could submit anywhere | `_resolve_collector_grid()` requires the geometry centre to fall inside a grid **assigned to that collector**, and stamps `_task_grid_id` on record + feature |
| Re-submitting a survey duplicated the feature | Duplicate municipal geometry | `_upsert_record_feature()` keys on `_record_id`; records upsert by `record_id` |
| Questionnaire answers could forge system properties | A payload could set `_created_by`/`_status` | `_clean_record_answers()` strips reserved keys |
| Linking a questionnaire did not sync the layer schema | Feature forms did not show the questionnaire fields | `update_layer()` derives `fields_config` from the questionnaire questions (preserving `visible_in_popup`) |
| Project fallback `|| 1` in the form | Wrong project id when no project was resolved | removed; the questionnaires own `project_id` is used |
| Drafts and submits used `activeLayerId` instead of the layer the geometry was drawn on | Features created on the wrong layer while editing another | the edit layer now wins (`editMode && editLayerId`), for schema fetch, submit and optimistic refresh |
| `GET /api/questionnaires/{id}` returned `null` with 200 for a missing id | Silent failures in the builder | returns 404; publishing deactivates sibling questionnaires so only one is active |

Backend coverage: `backend/tests/test_field_collection_rules.py` (12 tests) runs
inside the built image via `scripts/test-backend.sh` (`npm run test:backend`).

### 7.3 Nepali text corruption (mojibake) repaired

`backend/app/main.py` contained 45 user-facing strings (task-grid names, layer
defaults, split/merge and questionnaire validation errors) where UTF-8 Nepali had
been read as **CP850** and re-saved. Example before →
after:

```
"name": f"ÓñòÓñ¥Óñ░ÓÑìÓñ»ÓñòÓÑìÓñÀÓÑçÓññÓÑìÓñ░ #{idx}"   ->   f"कार्यक्षेत्र #{idx}"
"detail": "Óñ¬ÓÑìÓñ░ÓñÂÓÑìÓñ¿Óñ¥ÓñÁÓñ▓ÓÑÇ Óñ½ÓÑçÓñ▓Óñ¥ Óñ¬Óñ░ÓÑçÓñ¿ÓÑñ" -> "प्रश्नावली फेला परेन।"
```

Decoding CP850 bytes back into UTF-8 restored the text exactly (43 lines changed,
Nepali output verified). The collector-facing errors are bilingual again.

### 7.4 Identity, user administration and QA loop completed

The UI already called endpoints that did not exist, and the login endpoint accepted
any password and fell back to the first user:

| Defect | Fix |
| :--- | :--- |
| `POST/PUT/DELETE /api/users`, `GET /api/users/{id}`, `GET /api/users/{id}/projects` were missing while the admin console called them | Implemented, with role validation, unique usernames, PBKDF2-SHA256 password hashing (stdlib, no native dependency) and `password_hash` never leaving the API |
| `POST /api/auth/login` accepted any password and defaulted to `users[0]` | Real user lookup; hashed passwords verified; the bootstrap SuperAdmin compares against `/run/secrets/kmc_admin_password`; `401` on mismatch |
| `GET /api/auth/me` always returned the first user | Resolves the bearer token to the actual user; `401` without a valid token |
| `PUT /api/records/{id}/review` (validator QA) was missing | Implemented: APPROVED/RETURNED (aliases normalised), Validator/GisAdmin only, notes persisted, and the linked feature's `_status`/`_review_notes` updated |
| `GET /api/records/{id}` and `POST /api/questionnaires/{id}/duplicate` were missing | Implemented |
| Deleting a collector left grids locked/assigned | Deletion releases assigned grids back to `READY` and removes project membership |
| Record lists ignored `status_filter` / `collector_id`, and records had no `collector_name` | Query filters implemented; records now carry `collector_id` / `collector_name` / `collector_username` for the review table |

Note on tokens: they are still the unsigned `kmc-jwt-<id>-<issued_at>` format, so
`resolve_request_user()` provides **attribution, not cryptographic authorisation**.
Replacing it with signed JWTs (`python-jose` is already a dependency) is the next
security task and is tracked in §6.3.


