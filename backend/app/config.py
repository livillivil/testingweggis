"""
KMC-GIS-SERVER Runtime Configuration & Docker Swarm Secrets Engine (backend/app/config.py)
Adheres strictly to:
1. Docker "Build Once, Run Anywhere" (12-Factor App) — zero baked secrets or URLs in images.
2. Docker Swarm Secrets Golden Practice Rules:
   - Secrets are mounted at runtime via encrypted Swarm Raft log onto an in-memory tmpfs at `/run/secrets/<secret_name>`
     with least-privilege ownership (`uid=10001, gid=10001, mode=0400`).
   - Services receive `<VAR>_FILE=/run/secrets/<secret_name>` instead of plaintext environment variables.
   - Resolution hierarchy:
       1) Path in `<ENV_VAR>_FILE` (e.g. `POSTGRES_PASSWORD_FILE=/run/secrets/kmc_postgres_password`)
       2) Default Swarm tmpfs path `/run/secrets/<secret_name>`
       3) Plaintext `<ENV_VAR>` fallback (only when `ENFORCE_SWARM_SECRETS` is not enabled)
   - Trailing CR/LF (`\\r\\n`) from secret files are stripped safely without mutating internal characters.
   - Secret values are never logged or exposed in `repr()` or API responses.
"""

import os
import stat
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus

SWARM_SECRETS_DIR = Path(os.getenv("SWARM_SECRETS_DIR", "/run/secrets"))


def _strip_secret_newlines(raw: str) -> str:
    """Strips only trailing CR/LF characters added by POSIX tools or echo."""
    return raw.rstrip("\r\n")


def _mask_secret(value: str) -> str:
    """Redacts secret content for safe diagnostics."""
    clean = _strip_secret_newlines(value or "")
    if not clean:
        return "<empty>"
    if len(clean) <= 8:
        return "********"
    return f"{clean[:2]}{'*' * 12}{clean[-2:]} (len={len(clean)})"


_SECRET_ENV_HINTS: Dict[str, str] = {
    "kmc_postgres_password": "POSTGRES_PASSWORD_FILE",
    "kmc_redis_password": "REDIS_PASSWORD_FILE",
    "kmc_jwt_secret_key": "SECRET_KEY_FILE",
    "kmc_admin_password": "ADMIN_PASSWORD_FILE",
    "kmc_master_admin_password": "MASTER_ADMIN_PASSWORD_FILE",
    "kmc_geoserver_admin_password": "GEOSERVER_ADMIN_PASSWORD_FILE",
}


def read_swarm_secret(
    secret_name: str,
    env_var: str,
    default: str = "",
    required: bool = False,
) -> str:
    """
    Reads a secret following Docker Swarm Golden Practice priority:
    1. `<ENV_VAR>_FILE` path (e.g. `POSTGRES_PASSWORD_FILE=/run/secrets/kmc_postgres_password`)
    2. `/run/secrets/<secret_name>` in-memory tmpfs mount
    3. `<ENV_VAR>` environment variable (local development only)

    No secret value is ever invented, written, or defaulted: a missing secret is
    a configuration error, not something the process should paper over.
    """
    file_env_key = f"{env_var}_FILE"
    explicit_file_path = os.getenv(file_env_key, "").strip()
    default_secret_path = SWARM_SECRETS_DIR / secret_name

    # 1. Explicit *_FILE path
    if explicit_file_path:
        path_obj = Path(explicit_file_path)
        if path_obj.is_file():
            return _strip_secret_newlines(path_obj.read_text(encoding="utf-8"))

    # 2. Standard /run/secrets/<secret_name> path
    if default_secret_path.is_file():
        return _strip_secret_newlines(default_secret_path.read_text(encoding="utf-8"))

    # 3. Environment variable (explicit local-development escape hatch)
    env_val = os.getenv(env_var, "")
    if env_val:
        if os.getenv("ENFORCE_SWARM_SECRETS", "false").lower() in ("1", "true", "yes"):
            raise RuntimeError(
                f"[SWARM SECRET ENFORCED] '{secret_name}' must come from a secret file; "
                f"plaintext '{env_var}' is rejected while ENFORCE_SWARM_SECRETS=true. "
                f"Mount the secret at '{explicit_file_path or default_secret_path}'."
            )
        return _strip_secret_newlines(env_val)

    if required:
        raise RuntimeError(
            f"[SWARM SECRET MISSING] Required secret '{secret_name}' not found at "
            f"'{explicit_file_path or default_secret_path}' and no '{env_var}' fallback provided. "
            f"Run './scripts/manage-swarm-secrets.sh init-local' (local Compose) or "
            f"'./scripts/manage-swarm-secrets.sh init-swarm v1' (Swarm)."
        )

    return default


def inspect_secret_mount(secret_name: str, env_var: str, services: List[str]) -> Dict[str, Any]:
    """Returns non-sensitive metadata about how a secret is mounted at runtime."""
    file_env_key = f"{env_var}_FILE"
    explicit_file_path = os.getenv(file_env_key, "").strip()
    candidate_path = Path(explicit_file_path) if explicit_file_path else (SWARM_SECRETS_DIR / secret_name)

    source = "unconfigured"
    file_mode = "unknown"
    file_uid = "unknown"
    file_gid = "unknown"
    mounted = False

    if candidate_path.is_file():
        mounted = True
        source = "file:/run/secrets (Swarm/Compose Secret)"
        try:
            st = candidate_path.stat()
            file_mode = oct(stat.S_IMODE(st.st_mode)).replace("0o", "0")
            file_uid = str(st.st_uid)
            file_gid = str(st.st_gid)
        except OSError:
            file_mode = "unknown"
    elif os.getenv(env_var):
        source = "env_fallback (plaintext environment)"

    return {
        "secret_name": secret_name,
        "env_var": env_var,
        "file_env_var": file_env_key,
        "target_path": str(candidate_path),
        "mounted_in_tmpfs": mounted,
        "source": source,
        "mode": file_mode,
        "uid": file_uid,
        "gid": file_gid,
        "version": os.getenv("SECRET_VERSION", "v1"),
        "services": services,
    }


class RuntimeSettings:
    """Reads all environment variables and Docker Swarm `/run/secrets/*` mounts dynamically at runtime."""

    def __repr__(self) -> str:
        return (
            f"<RuntimeSettings app_name={self.app_name!r} env={self.app_env!r} "
            f"enforce_swarm_secrets={self.enforce_swarm_secrets!r}>"
        )

    @property
    def app_name(self) -> str:
        return os.getenv("APP_NAME", "KMC-GIS-SERVER")

    @property
    def app_env(self) -> str:
        return os.getenv("APP_ENV", "production")

    @property
    def enforce_swarm_secrets(self) -> bool:
        return os.getenv("ENFORCE_SWARM_SECRETS", "false").lower() in ("1", "true", "yes")

    @property
    def postgres_user(self) -> str:
        # Usernames are not secret material; only the password is file-bound.
        return os.getenv("POSTGRES_USER", "kmc_user")

    @property
    def postgres_password(self) -> str:
        return read_swarm_secret("kmc_postgres_password", "POSTGRES_PASSWORD", required=False)

    @property
    def postgres_host(self) -> str:
        return os.getenv("POSTGRES_HOST", "postgres")

    @property
    def postgres_port(self) -> str:
        return os.getenv("POSTGRES_PORT", "5432")

    @property
    def postgres_db(self) -> str:
        return os.getenv("POSTGRES_DB", "kmc_gis")

    @property
    def db_pool_size(self) -> int:
        return int(os.getenv("DB_POOL_SIZE", "10"))

    @property
    def db_max_overflow(self) -> int:
        return int(os.getenv("DB_MAX_OVERFLOW", "15"))

    @property
    def database_url(self) -> str:
        explicit_url = read_swarm_secret("kmc_database_url", "DATABASE_URL", required=False)
        if explicit_url:
            if explicit_url.startswith("postgresql://"):
                return explicit_url.replace("postgresql://", "postgresql+asyncpg://", 1)
            return explicit_url

        user = self.postgres_user
        password = self.postgres_password
        if not user or not password:
            raise RuntimeError(
                "Runtime database credentials missing: mount /run/secrets/kmc_postgres_password "
                "(POSTGRES_PASSWORD_FILE) or set DATABASE_URL_FILE at container runtime."
            )
        encoded_user = quote_plus(user)
        encoded_pass = quote_plus(password)
        return (
            f"postgresql+asyncpg://{encoded_user}:{encoded_pass}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def redis_password(self) -> str:
        return read_swarm_secret("kmc_redis_password", "REDIS_PASSWORD", required=False)

    @property
    def redis_url(self) -> str:
        explicit = read_swarm_secret("kmc_redis_url", "REDIS_URL", required=False)
        if explicit:
            return explicit
        redis_pass = self.redis_password
        redis_host = os.getenv("REDIS_HOST", "redis")
        redis_port = os.getenv("REDIS_PORT", "6379")
        if redis_pass:
            return f"redis://:{quote_plus(redis_pass)}@{redis_host}:{redis_port}/0"
        return f"redis://{redis_host}:{redis_port}/0"

    @property
    def secret_key(self) -> str:
        key = read_swarm_secret("kmc_jwt_secret_key", "SECRET_KEY", required=True)
        return key

    @property
    def algorithm(self) -> str:
        return os.getenv("ALGORITHM", "HS256")

    @property
    def access_token_expire_minutes(self) -> int:
        return int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))

    @property
    def refresh_token_expire_days(self) -> int:
        return int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

    @property
    def admin_username(self) -> str:
        return os.getenv("ADMIN_USERNAME", "KmcSuperAdmin")

    @property
    def admin_email(self) -> str:
        return os.getenv("ADMIN_EMAIL", "admin@kmc.gov.np")

    @property
    def admin_password(self) -> str:
        return read_swarm_secret("kmc_admin_password", "ADMIN_PASSWORD", default="")

    @property
    def admin_full_name(self) -> str:
        return os.getenv("ADMIN_FULL_NAME", "")

    @property
    def master_admin_username(self) -> str:
        return os.getenv("MASTER_ADMIN_USERNAME", "KmcMasterAdmin")

    @property
    def master_admin_email(self) -> str:
        return os.getenv("MASTER_ADMIN_EMAIL", "master@kmc.gov.np")

    @property
    def master_admin_password(self) -> str:
        return read_swarm_secret("kmc_master_admin_password", "MASTER_ADMIN_PASSWORD", default="")

    @property
    def master_admin_full_name(self) -> str:
        return os.getenv("MASTER_ADMIN_FULL_NAME", "")

    @property
    def tileserver_internal_url(self) -> str:
        return os.getenv("TILESERVER_INTERNAL_URL", "http://tileserver:8080")

    @property
    def martin_internal_url(self) -> str:
        return os.getenv("MARTIN_INTERNAL_URL", "http://martin:3000")

    @property
    def geoserver_internal_url(self) -> str:
        return os.getenv("GEOSERVER_INTERNAL_URL", "http://geoserver:8080/geoserver")

    @property
    def max_upload_size_mb(self) -> int:
        return max(1, int(os.getenv("MAX_UPLOAD_SIZE_MB", "1048576")))

    @property
    def seed_user_password(self) -> str:
        """Optional one-time password applied to freshly seeded staff accounts.

        When unset, every seeded account receives a random unknown password and
        must be reset by an administrator, so no predictable credential ships.
        """
        return read_swarm_secret("kmc_seed_user_password", "SEED_USER_PASSWORD", default="", required=False)

    @property
    def enable_demo_seed(self) -> bool:
        return os.getenv("ENABLE_DEMO_SEED", "false").strip().lower() in ("1", "true", "yes", "on")

    @property
    def default_map_bbox(self) -> List[float]:
        default_bbox = [85.27, 27.66, 85.38, 27.75]
        raw = os.getenv("DEFAULT_MAP_BBOX", "").strip()
        if not raw:
            return list(default_bbox)
        try:
            parts = [float(part.strip()) for part in raw.split(",") if part.strip()]
            if len(parts) == 4:
                return parts
        except ValueError:
            pass
        return list(default_bbox)

    @property
    def public_base_url(self) -> str:
        return os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")

    @property
    def trusted_proxy_cidrs(self) -> str:
        return os.getenv(
            "TRUSTED_PROXY_CIDRS",
            "127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
        ).strip()

    @property
    def enable_api_docs(self) -> bool:
        raw = os.getenv("ENABLE_API_DOCS", "").strip().lower()
        if raw in ("1", "true", "yes", "on"):
            return True
        if raw in ("0", "false", "no", "off"):
            return False
        return self.app_env.strip().lower() not in ("production", "prod")

    @property
    def geo_gate_mode(self) -> str:
        """`enforce` (deny unverifiable), `monitor` (log/annotate only) or `off`."""
        mode = os.getenv("GEO_GATE_MODE", "monitor").strip().lower()
        return mode if mode in ("enforce", "monitor", "off") else "monitor"

    @property
    def geoip_country_db(self) -> str:
        return os.getenv("GEOIP_COUNTRY_DB", "/app/geoip/GeoLite2-Country.mmdb")

    @property
    def geoip_asn_db(self) -> str:
        return os.getenv("GEOIP_ASN_DB", "/app/geoip/GeoLite2-ASN.mmdb")

    @property
    def geoip_blocked_asns(self) -> List[int]:
        raw = os.getenv("GEOIP_BLOCKED_ASNS", "")
        blocked = []
        for part in raw.split(","):
            part = part.strip()
            if part.isdigit():
                blocked.append(int(part))
        return blocked

    @property
    def cors_allow_origins(self) -> List[str]:
        raw = os.getenv("CORS_ALLOW_ORIGINS", "")
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    @property
    def tmpdir(self) -> str:
        return os.getenv("TMPDIR", "/tileserver-data/temp")

    @property
    def upload_dir(self) -> str:
        return os.getenv("UPLOAD_DIR", "/app/uploads")

    def get_swarm_security_posture(self) -> Dict[str, Any]:
        """Returns non-sensitive Docker Swarm Secrets posture metadata for Admin auditing."""
        # Only secrets this backend container is granted can be verified from
        # inside it; other services' secrets (e.g. GeoServer) are enforced by
        # Compose/Swarm at deploy time and reported separately.
        backend_secrets = [
            inspect_secret_mount("kmc_postgres_password", "POSTGRES_PASSWORD", ["postgres", "backend", "martin"]),
            inspect_secret_mount("kmc_redis_password", "REDIS_PASSWORD", ["redis", "backend"]),
            inspect_secret_mount("kmc_jwt_secret_key", "SECRET_KEY", ["backend"]),
            inspect_secret_mount("kmc_admin_password", "ADMIN_PASSWORD", ["backend"]),
            inspect_secret_mount("kmc_master_admin_password", "MASTER_ADMIN_PASSWORD", ["backend"]),
        ]
        external_secrets = [
            inspect_secret_mount("kmc_geoserver_admin_password", "GEOSERVER_ADMIN_PASSWORD", ["geoserver"]),
        ]
        missing = [item["secret_name"] for item in backend_secrets if not item["mounted_in_tmpfs"]]
        return {
            # Derived from the observed mounts — never self-certified as compliant.
            "golden_practice_compliant": not missing,
            "missing_secrets": missing,
            "enforce_swarm_secrets": self.enforce_swarm_secrets,
            "secrets_mount_dir": str(SWARM_SECRETS_DIR),
            "encryption_at_rest": "Swarm Raft Log (AES-GCM-256) + mTLS Node Transport",
            "runtime_filesystem": "Secret files mounted read-only at /run/secrets",
            "file_permissions": "0400 (mounted Swarm) / 0444 (local Compose file mount)",
            "secrets": backend_secrets,
            "external_service_secrets": external_secrets,
        }


settings = RuntimeSettings()
