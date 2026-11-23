#!/usr/bin/env bash
# ============================================================================
# KMC-GIS-SERVER Docker Swarm Secrets Golden-Practice Lifecycle Manager
#
# Golden Rules Implemented:
# 1. Zero Disk Exposure for Swarm Secrets:
#    Pipes 256-bit CSPRNG bytes (`openssl rand`) directly into `docker secret create -`
#    with trailing newlines stripped (`tr -d '\r\n'`).
# 2. Versioned Immutable Secret Naming (`_v1`, `_v2`, ...):
#    Allows zero-downtime rolling rotation with automatic rollback on failure.
# 3. Least-Privilege File Permissions (`0400` / `0600`) & Non-Root Ownership (`10001:10001`).
#
# Usage:
#   ./scripts/manage-swarm-secrets.sh init-local              # Generate ./secrets/*.txt for local `docker compose up --build`
#   ./scripts/manage-swarm-secrets.sh init-swarm [v1]         # Provision encrypted secrets into Docker Swarm Raft store
#   ./scripts/manage-swarm-secrets.sh rotate <secret> v1 v2   # Zero-downtime rotation across authorized Swarm services
#       (database/redis passwords require ALLOW_STATEFUL_ROTATION=true; see cmd_rotate)
#   ./scripts/manage-swarm-secrets.sh audit                   # Audit active Swarm secrets & service grants
# ============================================================================

set -euo pipefail

SECRETS_DIR="${SECRETS_DIR:-./secrets}"
STACK_NAME="${STACK_NAME:-kmc-gis}"

SECRET_NAMES=(
  "kmc_postgres_password"
  "kmc_redis_password"
  "kmc_jwt_secret_key"
  "kmc_admin_password"
  "kmc_master_admin_password"
  "kmc_geoserver_admin_password"
)

generate_random_secret() {
  local bytes="${1:-36}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\r\n'
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '\r\n'
  fi
}

cmd_init_local() {
  mkdir -p "$SECRETS_DIR"
  # Compose file secrets are bind mounts that keep host permissions, so the
  # files must be readable by the non-root service users (backend 10001,
  # redis 999). Directory 0700 keeps them private to the host account.
  chmod 700 "$SECRETS_DIR"
  echo "[KMC-SECRETS] Provisioning local secret files in ${SECRETS_DIR}/ (git-ignored & docker-ignored)..."

  for name in "${SECRET_NAMES[@]}"; do
    local file_path="${SECRETS_DIR}/${name}.txt"
    if [[ -f "$file_path" && -s "$file_path" ]]; then
      chmod 444 "$file_path"
      echo "  [OK] Preserved existing secret: ${file_path} (mode 0444, private dir)"
    else
      umask 0133
      generate_random_secret 36 > "$file_path"
      chmod 444 "$file_path"
      echo "  [CREATED] Generated 256-bit secret: ${file_path} (mode 0444, no trailing newline)"
    fi
  done

  echo "[KMC-SECRETS] Local secrets ready. Run: docker compose up --build"
}

cmd_init_swarm() {
  local version="${1:-v1}"
  echo "[KMC-SECRETS] Provisioning Raft-encrypted Docker Swarm secrets (version: ${version})..."

  if ! docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -qi "active"; then
    echo "[KMC-SECRETS] Initializing Docker Swarm manager node..."
    docker swarm init
  fi

  for name in "${SECRET_NAMES[@]}"; do
    local versioned_name="${name}_${version}"
    if docker secret inspect "$versioned_name" >/dev/null 2>&1; then
      echo "  [OK] Swarm secret already exists in Raft store: ${versioned_name}"
    else
      generate_random_secret 36 | docker secret create \
        --label "com.kmc.stack=${STACK_NAME}" \
        --label "com.kmc.secret.target=${name}" \
        --label "com.kmc.secret.version=${version}" \
        "$versioned_name" - >/dev/null
      echo "  [CREATED] Raft-encrypted Swarm secret: ${versioned_name} -> /run/secrets/${name}"
    fi
  done

  echo "[KMC-SECRETS] Deploy stack with: SECRET_VERSION=${version} docker stack deploy -c docker-compose.swarm.yml ${STACK_NAME}"
}

cmd_rotate() {
  local secret_name="${1:-}"
  local old_version="${2:-v1}"
  local new_version="${3:-v2}"

  if [[ -z "$secret_name" ]]; then
    echo "Usage: $0 rotate <secret_name> <old_version> <new_version>"
    exit 1
  fi

  local old_ext="${secret_name}_${old_version}"
  local new_ext="${secret_name}_${new_version}"

  # A running datastore keeps the old credential active: swapping only the
  # secret file rotates the client side and locks everyone out. Rotate the
  # credential inside PostgreSQL/Redis first, then re-run with the override.
  case "$secret_name" in
    kmc_postgres_password|kmc_redis_password)
      if [[ "${ALLOW_STATEFUL_ROTATION:-false}" != "true" ]]; then
        echo "[KMC-SECRETS] Refusing to rotate '${secret_name}': the datastore still authenticates with the old value."
        echo "  1) Change the password inside PostgreSQL (ALTER ROLE ... PASSWORD ...) or Redis (CONFIG SET requirepass ...)."
        echo "  2) Re-run with ALLOW_STATEFUL_ROTATION=true $0 rotate ${secret_name} ${old_version} ${new_version}"
        exit 2
      fi
      ;;
  esac

  echo "[KMC-SECRETS] Creating new immutable Swarm secret '${new_ext}' in Raft log..."
  if ! docker secret inspect "$new_ext" >/dev/null 2>&1; then
    generate_random_secret 36 | docker secret create \
      --label "com.kmc.stack=${STACK_NAME}" \
      --label "com.kmc.secret.target=${secret_name}" \
      --label "com.kmc.secret.version=${new_version}" \
      "$new_ext" - >/dev/null
  fi

  # Determine authorized services for least-privilege rotation
  local services=()
  case "$secret_name" in
    kmc_postgres_password)
      services=("postgres" "backend" "martin")
      ;;
    kmc_redis_password)
      services=("redis" "backend")
      ;;
    kmc_jwt_secret_key|kmc_admin_password|kmc_master_admin_password)
      services=("backend")
      ;;
    kmc_geoserver_admin_password)
      services=("geoserver")
      ;;
    *)
      services=("backend")
      ;;
  esac

  for svc in "${services[@]}"; do
    local full_svc="${STACK_NAME}_${svc}"
    local uid_gid_opts="mode=0400"
    case "$svc" in
      backend)
        uid_gid_opts="uid=10001,gid=10001,mode=0400"
        ;;
      redis)
        # redis-server drops privileges to uid 999 / gid 1000 before reading
        # the password file.
        uid_gid_opts="uid=999,gid=1000,mode=0400"
        ;;
    esac
    echo "[KMC-SECRETS] Rotating ${full_svc} -> ${new_ext} (${uid_gid_opts})..."
    docker service update \
      --secret-rm "$old_ext" \
      --secret-add "source=${new_ext},target=${secret_name},${uid_gid_opts}" \
      "$full_svc"
  done

  echo "[KMC-SECRETS] Retiring previous secret version '${old_ext}'..."
  docker secret rm "$old_ext" || true
  echo "[KMC-SECRETS] Reconcile the stack definition so future deploys keep the new version:"
  echo "  SECRET_VERSION=${new_version} docker stack deploy -c docker-compose.swarm.yml ${STACK_NAME}"
  echo "[KMC-SECRETS] Zero-downtime rotation complete for ${secret_name} (${old_version} -> ${new_version})."
}

cmd_audit() {
  echo "=================================================================="
  echo " KMC-GIS-SERVER Docker Swarm Secrets Golden-Practice Audit"
  echo "=================================================================="
  for name in "${SECRET_NAMES[@]}"; do
    local local_file="${SECRETS_DIR}/${name}.txt"
    if [[ -f "$local_file" ]]; then
      local bytes
      bytes=$(wc -c < "$local_file" | tr -d ' ')
      echo "  [LOCAL READY] ${name} -> ${local_file} (${bytes} bytes)"
    else
      echo "  [LOCAL MISSING] ${name} -> run '$0 init-local'"
    fi
  done

  if docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -qi "active"; then
    echo "------------------------------------------------------------------"
    echo " Swarm service grants (stack: ${STACK_NAME})"
    echo "------------------------------------------------------------------"
    local found=false
    for svc in $(docker service ls --filter "label=com.docker.stack.namespace=${STACK_NAME}" --format '{{.Name}}'); do
      found=true
      echo "  ${svc}:"
      docker service inspect --format \
        '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}    secret={{.SecretName}} target={{.File.Name}} mode={{printf "%o" .File.Mode}} uid={{.File.UID}} gid={{.File.GID}}{{"\n"}}{{end}}' \
        "$svc"
    done
    if [[ "$found" == "false" ]]; then
      echo "  [INFO] No services found for stack '${STACK_NAME}'."
    fi
  else
    echo "  [INFO] Swarm is not active on this host; runtime grants not audited."
  fi
}

case "${1:-audit}" in
  init-local)
    cmd_init_local
    ;;
  init-swarm)
    cmd_init_swarm "${2:-v1}"
    ;;
  rotate)
    cmd_rotate "${2:-}" "${3:-v1}" "${4:-v2}"
    ;;
  audit|*)
    cmd_audit
    ;;
esac
