/**
 * KMC-GIS-SERVER Docker Swarm Secrets Golden-Practice Engine
 * Pure logic utilities for:
 * 1. Resolving secrets with strict priority: /run/secrets/<name> -> *_FILE -> env fallback
 * 2. Stripping trailing CR/LF (\r\n) without mutating internal secret bytes
 * 3. Constructing URL-encoded DATABASE_URL / REDIS_URL at runtime from Swarm secrets
 * 4. Auditing Swarm secret mounts, least-privilege service grants, file permissions (0400),
 *    and generating zero-downtime immutable secret rotation commands (v1 -> v2).
 */

export const GOLDEN_SWARM_SECRETS_CATALOG = [
  {
    id: 'postgres_password',
    secretName: 'kmc_postgres_password',
    envVarName: 'POSTGRES_PASSWORD',
    fileEnvVarName: 'POSTGRES_PASSWORD_FILE',
    targetPath: '/run/secrets/kmc_postgres_password',
    version: 'v1',
    uid: '10001',
    gid: '10001',
    mode: '0400',
    services: ['postgres', 'backend', 'martin'],
    descriptionNe: 'PostgreSQL 16 + PostGIS 3.4 मुख्य डाटाबेस पासवर्ड',
    descriptionEn: 'Primary PostGIS 3.4 geodatabase password mounted on in-memory tmpfs',
    minLength: 24,
  },
  {
    id: 'redis_password',
    secretName: 'kmc_redis_password',
    envVarName: 'REDIS_PASSWORD',
    fileEnvVarName: 'REDIS_PASSWORD_FILE',
    targetPath: '/run/secrets/kmc_redis_password',
    version: 'v1',
    uid: '10001',
    gid: '10001',
    mode: '0400',
    services: ['redis', 'backend'],
    descriptionNe: 'Redis 7.4 MVT बाइनरी क्यास र टास्क लक पासवर्ड',
    descriptionEn: 'Redis 7.4 MVT tile cache & distributed task lock authentication secret',
    minLength: 24,
  },
  {
    id: 'jwt_secret_key',
    secretName: 'kmc_jwt_secret_key',
    envVarName: 'SECRET_KEY',
    fileEnvVarName: 'SECRET_KEY_FILE',
    targetPath: '/run/secrets/kmc_jwt_secret_key',
    version: 'v1',
    uid: '10001',
    gid: '10001',
    mode: '0400',
    services: ['backend'],
    descriptionNe: 'FastAPI HS256 JWT टोकन हस्ताक्षर गोप्य कुञ्जी (२५६-बिट)',
    descriptionEn: 'FastAPI 256-bit cryptographic signing key for JWT access & refresh tokens',
    minLength: 32,
  },
  {
    id: 'admin_password',
    secretName: 'kmc_admin_password',
    envVarName: 'ADMIN_PASSWORD',
    fileEnvVarName: 'ADMIN_PASSWORD_FILE',
    targetPath: '/run/secrets/kmc_admin_password',
    version: 'v1',
    uid: '10001',
    gid: '10001',
    mode: '0400',
    services: ['backend'],
    descriptionNe: 'प्रारम्भिक SuperAdmin प्रशासक खाता बुटस्ट्र्याप पासवर्ड',
    descriptionEn: 'Initial SuperAdmin bootstrap credential injected only into backend container',
    minLength: 16,
  },
  {
    id: 'master_admin_password',
    secretName: 'kmc_master_admin_password',
    envVarName: 'MASTER_ADMIN_PASSWORD',
    fileEnvVarName: 'MASTER_ADMIN_PASSWORD_FILE',
    targetPath: '/run/secrets/kmc_master_admin_password',
    version: 'v1',
    uid: '10001',
    gid: '10001',
    mode: '0400',
    services: ['backend'],
    descriptionNe: 'मास्टर प्रशासक (MasterAdmin) बुटस्ट्र्याप पासवर्ड — सर्वोच्च अधिकार',
    descriptionEn: 'MasterAdmin bootstrap credential — highest-privilege account',
    minLength: 16,
  },
  {
    id: 'geoserver_admin_password',
    secretName: 'kmc_geoserver_admin_password',
    envVarName: 'GEOSERVER_ADMIN_PASSWORD',
    fileEnvVarName: 'GEOSERVER_ADMIN_PASSWORD_FILE',
    targetPath: '/run/secrets/kmc_geoserver_admin_password',
    version: 'v1',
    uid: '0',
    gid: '0',
    mode: '0400',
    services: ['geoserver'],
    descriptionNe: 'GeoServer OGC (WMS/WFS-T) प्रशासक पासवर्ड',
    descriptionEn: 'GeoServer enterprise OGC service administration password',
    minLength: 16,
  },
];

const INSECURE_PLACEHOLDER_PATTERNS = [
  'change_me',
  'password',
  'default',
  'secret',
  '123456',
  'admin123',
];

/**
 * Strips only trailing \r and \n added by POSIX files or `echo` while preserving
 * intentional spaces or characters inside the secret payload.
 */
export function sanitizeSecretContent(rawContent) {
  if (typeof rawContent !== 'string') return '';
  return rawContent.replace(/[\r\n]+$/, '');
}

export function maskSecretValue(secret) {
  const clean = sanitizeSecretContent(secret);
  if (!clean) return '<empty>';
  if (clean.length <= 8) return '********';
  return `${clean.slice(0, 2)}${'*'.repeat(12)}${clean.slice(-2)} (len=${clean.length})`;
}

/**
 * Resolves a secret following the Docker Swarm Golden Practice hierarchy:
 * 1. Explicit `<ENV_VAR>_FILE` path (e.g. `POSTGRES_PASSWORD_FILE=/run/secrets/kmc_postgres_password`)
 * 2. Default Swarm tmpfs path `/run/secrets/<secret_name>`
 * 3. Plaintext `<ENV_VAR>` fallback (permitted in local dev; rejected when strictProduction=true)
 */
export function resolveSwarmSecret({
  secretName,
  envVarName,
  env = {},
  files = {},
  strictProduction = false,
}) {
  const fileEnvVarName = `${envVarName}_FILE`;
  const customFilePath = env[fileEnvVarName]?.trim();
  const defaultSwarmPath = `/run/secrets/${secretName}`;
  const warnings = [];

  // Priority 1: Explicit *_FILE environment variable pointing to tmpfs secret
  if (customFilePath && files[customFilePath] !== undefined) {
    const clean = sanitizeSecretContent(files[customFilePath] || '');
    if (!customFilePath.startsWith('/run/secrets/')) {
      warnings.push(
        `${fileEnvVarName} points to '${customFilePath}' outside standard in-memory '/run/secrets/' tmpfs mount.`
      );
    }
    return {
      value: clean,
      source: 'file_env_var',
      resolvedPath: customFilePath,
      maskedPreview: maskSecretValue(clean),
      warnings,
    };
  }

  // Priority 2: Standard /run/secrets/<secretName> tmpfs path
  if (files[defaultSwarmPath] !== undefined) {
    const clean = sanitizeSecretContent(files[defaultSwarmPath] || '');
    return {
      value: clean,
      source: 'swarm_secret_dir',
      resolvedPath: defaultSwarmPath,
      maskedPreview: maskSecretValue(clean),
      warnings,
    };
  }

  // Priority 3: Plaintext environment variable fallback
  const plaintextFallback = env[envVarName];
  if (plaintextFallback !== undefined && plaintextFallback !== '') {
    const clean = sanitizeSecretContent(plaintextFallback);
    if (strictProduction) {
      throw new Error(
        `[SWARM GOLDEN PRACTICE VIOLATION] Plaintext environment variable '${envVarName}' is forbidden when ENFORCE_SWARM_SECRETS=true. Mount '/run/secrets/${secretName}' and set '${fileEnvVarName}'.`
      );
    }
    warnings.push(
      `Using plaintext environment fallback for '${envVarName}'. In production Swarm, mount '/run/secrets/${secretName}' instead.`
    );
    return {
      value: clean,
      source: 'plaintext_env_fallback',
      resolvedPath: null,
      maskedPreview: maskSecretValue(clean),
      warnings,
    };
  }

  if (strictProduction) {
    throw new Error(
      `[SWARM SECRET MISSING] Required secret '${secretName}' not found at '${customFilePath || defaultSwarmPath}'.`
    );
  }

  return {
    value: '',
    source: 'missing',
    resolvedPath: null,
    maskedPreview: '<missing>',
    warnings: [`Secret '${secretName}' (${envVarName}) is not configured.`],
  };
}

/**
 * Builds an async SQLAlchemy PostGIS URL and standard libpq URL from Swarm secrets
 * with strict RFC 3986 percent-encoding of credentials.
 */
export function buildDatabaseUrlsFromSecrets({ user, passwordSecret, host = 'postgres', port = '5432', db = 'kmc_gis' }) {
  const safeUser = (user || '').trim();
  const password = sanitizeSecretContent(passwordSecret || '');
  const safeHost = (host || 'postgres').trim();
  const safePort = String(port || '5432').trim();
  const safeDb = (db || 'kmc_gis').trim();

  if (!safeUser || !password) {
    throw new Error('Cannot construct DATABASE_URL: user and Swarm password secret are required.');
  }

  const encodedUser = encodeURIComponent(safeUser);
  const encodedPass = encodeURIComponent(password);

  return {
    asyncpgUrl: `postgresql+asyncpg://${encodedUser}:${encodedPass}@${safeHost}:${safePort}/${safeDb}`,
    libpqUrl: `postgresql://${encodedUser}:${encodedPass}@${safeHost}:${safePort}/${safeDb}`,
    maskedUrl: `postgresql+asyncpg://${encodedUser}:********@${safeHost}:${safePort}/${safeDb}`,
  };
}

/**
 * Validates that a secret meets golden-practice entropy & length requirements.
 */
export function validateSecretStrength(secretValue, minLength = 24) {
  const clean = sanitizeSecretContent(secretValue);
  const reasons = [];

  if (clean.length < minLength) {
    reasons.push(`Secret length (${clean.length}) is shorter than minimum required (${minLength}).`);
  }

  const lower = clean.toLowerCase();
  for (const pattern of INSECURE_PLACEHOLDER_PATTERNS) {
    if (lower.includes(pattern) && clean.length < 32) {
      reasons.push(`Secret contains insecure placeholder pattern '${pattern}'.`);
      break;
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Increments a version tag (e.g. 'v1' -> 'v2') and generates zero-downtime
 * Docker Swarm secret rotation CLI commands.
 *
 * Grants mirror the real per-service ownership: the backend runs as
 * 10001:10001, redis drops to 999:1000 before reading the file, and the
 * remaining images read the secret as root at container start.
 *
 * PostgreSQL and Redis passwords are stateful: swapping only the secret file
 * locks the datastores out, so those plans stop at the manual step.
 */
const SERVICE_SECRET_GRANTS = {
  backend: { uid: '10001', gid: '10001', mode: '0400' },
  redis: { uid: '999', gid: '1000', mode: '0400' },
};
const STATEFUL_SECRETS = new Set(['kmc_postgres_password', 'kmc_redis_password']);

export function generateSwarmRotationPlan(spec) {
  const currentNum = parseInt(String(spec.version || 'v1').replace(/^v/i, ''), 10) || 1;
  const previousVersion = `v${currentNum}`;
  const nextVersion = `v${currentNum + 1}`;
  const externalSecretNamePrev = `${spec.secretName}_${previousVersion}`;
  const externalSecretNameNext = `${spec.secretName}_${nextVersion}`;
  const stateful = STATEFUL_SECRETS.has(spec.secretName);

  const serviceCommands = stateful
    ? [
        `# MANUAL STEP REQUIRED: change the credential inside the datastore first.`,
        `#   PostgreSQL: ALTER ROLE ... PASSWORD '<new>';`,
        `#   Redis:      CONFIG SET requirepass '<new>';`,
        `# Then re-run: ALLOW_STATEFUL_ROTATION=true ./scripts/manage-swarm-secrets.sh rotate ${spec.secretName} ${previousVersion} ${nextVersion}`,
      ]
    : spec.services.map((svc) => {
        const grant = SERVICE_SECRET_GRANTS[svc] || { uid: '0', gid: '0', mode: '0400' };
        return `docker service update \\\n  --secret-rm ${externalSecretNamePrev} \\\n  --secret-add source=${externalSecretNameNext},target=${spec.secretName},uid=${grant.uid},gid=${grant.gid},mode=${grant.mode} \\\n  kmc-gis_${svc}`;
      });

  const commands = [
    `# 1. Generate 256-bit cryptographically random secret directly into Swarm Raft log (no disk file)`,
    `openssl rand -base64 36 | tr -d '\\r\\n' | docker secret create ${externalSecretNameNext} -`,
    ``,
    stateful
      ? `# 2. Stateful credential — automated service rotation is intentionally blocked`
      : `# 2. Atomically rotate each authorized Swarm service with zero downtime (rolling update + auto-rollback)`,
    ...serviceCommands,
    ``,
    `# 3. Remove the retired secret version after healthchecks pass and redeploy with SECRET_VERSION=${nextVersion}`,
    `docker secret rm ${externalSecretNamePrev}`,
  ];

  return {
    previousVersion,
    nextVersion,
    externalSecretNamePrev,
    externalSecretNameNext,
    stateful,
    commands,
  };
}
