# `data/` — Host-Bound Runtime Geodata (never source code)

Everything under `data/` is **runtime state produced by the running stack**, not
part of the repository. `.gitignore` excludes it (only the `README.md` /
`.gitkeep` placeholders are kept) and `.dockerignore` keeps it out of image
build contexts.

| Path | Owner | Mounted at | Contents |
| :--- | :--- | :--- | :--- |
| `data/tileserver/` | backend (RW) / tileserver (RO) | `/tileserver-data`, `/data` | Uploaded UAV orthophoto `.mbtiles`, generated `config.json`, generated `kmc_state_store.json` state recovery file |
| `data/tileserver/temp/` | backend | `/tileserver-data/temp` (`TMPDIR`) | Atomic staging for large raster uploads |
| `data/uploads/layers/` | backend (RW) / nginx (RO) | `/app/uploads`, `/var/kmc_uploads` | Uploaded vector GeoJSON / survey layer packages |
| `data/uploads/offline_bundles/` | backend / nginx | `/var/kmc_uploads/offline_bundles` | Region-clipped offline survey packages served through `X-Accel-Redirect` |
| `data/geoserver/` | geoserver | `/opt/geoserver_data` | GeoServer data directory |
| `data/postgres/` | postgres | `/var/lib/postgresql/data` | PostGIS cluster data directory (Swarm profile) |

## Why this matters

The persistence doctrine is *host-bound durability*: `docker compose down` (even
with `-v`) must never delete uploaded municipal data. Because these directories
are bind-mounted from the host, the files survive container recreation — which is
exactly why they must not be committed, copied into images, or treated as
fixtures.

Seed/base data that genuinely belongs to the project lives in the application
itself (`frontend/public/wards.geojson`, `geoportal/public/wards.geojson`) or in
PostGIS migrations — never in `data/`.

---

## Migrating from pre-consolidation named volumes (optional)

Older revisions of this stack kept the same data in Docker **named volumes**
instead of host folders. If your host still has them, they contain municipal data
that the current `docker-compose.yml` will not see:

| Legacy volume | Current destination |
| :--- | :--- |
| `kmc_gis_server_pg_data` | named volume `kmc_gis_server_postgres_data` |
| `kmc_gis_server_uploads_data` (27 MB+) | host folder `./data/uploads` |
| `kmc_gis_server_upload_data` | host folder `./data/uploads` |
| `kmc_gis_server_tileserver_data` | host folder `./data/tileserver` |

Check first:

```bash
docker volume ls | grep kmc
```

Migrate the uploaded layers (named volume → host folder, idempotent copy):

```bash
docker run --rm -v kmc_gis_server_uploads_data:/from \
  -v "$PWD/data/uploads:/to" alpine sh -c "cp -a /from/. /to/"
```

Migrate the PostGIS cluster (named volume → named volume):

```bash
docker run --rm -v kmc_gis_server_pg_data:/from \
  -v kmc_gis_server_postgres_data:/to alpine sh -c "cp -a /from/. /to/"
```

That old cluster was initialized with the password that used to be hardcoded in
`docker-compose.yml`. After copying, start PostGIS with that legacy value first,
rotate it to the new generated secret, and only then bring up the rest:

```bash
printf '%s' 'kmc_gis_prod_2026_secure' > secrets/kmc_postgres_password.txt   # legacy value
docker compose up -d postgres
NEW=$(openssl rand -base64 36 | tr -d '\r\n')
docker compose exec postgres psql -U kmc_user -d kmc_gis \
  -c "ALTER USER kmc_user WITH PASSWORD '$NEW';"
printf '%s' "$NEW" > secrets/kmc_postgres_password.txt
docker compose down
```

Never run `docker volume rm kmc_gis_server_pg_data` until the copy has been
verified against a working stack — there is no other copy of that data.
