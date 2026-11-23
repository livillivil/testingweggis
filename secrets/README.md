# KMC-GIS-SERVER Secrets Directory (`./secrets`)

This directory holds the local runtime secret files that `docker-compose.yml`
declares in its top-level `secrets:` block. Compose mounts each file read-only
at `/run/secrets/<secret_name>` inside the authorized containers; services read
them through `<VAR>_FILE` indirection, never through a plaintext environment
variable.

Provision them once:

```bash
./scripts/manage-swarm-secrets.sh init-local   # or: npm run secrets:init
```

## Golden Practice Security Guarantees

1. **Never baked into Docker images** — every `.dockerignore` excludes `secrets/`
   from its build context ("Build Once, Run Anywhere").
2. **Never committed to Git** — `.gitignore` ignores `secrets/*` and keeps only
   this README. No secret value lives in the repository, in `docker-compose.yml`,
   or in backend code.
3. **No trailing newlines** — generated with 256-bit entropy
   (`openssl rand -base64 36 | tr -d '\r\n'`) and `chmod 444` inside a `0700`
   directory. Compose file secrets are bind mounts that keep host permissions,
   so 0444 is required for the non-root backend (10001) and redis (999) users
   to read them while the private directory still blocks other host accounts.
4. **Fail fast, never default** — if a file is missing, `docker compose up`
   stops with a clear error instead of booting with a known password.
5. **Production Docker Swarm** — `docker-compose.swarm.yml` uses
   `external: true` secrets created directly in the encrypted Swarm Manager Raft
   log (`./scripts/manage-swarm-secrets.sh init-swarm v1`); those secrets never
   touch host disk and are mounted with `mode: 0400`.

Required files: `kmc_postgres_password.txt`, `kmc_redis_password.txt`,
`kmc_jwt_secret_key.txt`, `kmc_admin_password.txt`,
`kmc_master_admin_password.txt`, `kmc_geoserver_admin_password.txt`.
