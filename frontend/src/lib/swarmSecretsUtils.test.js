import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSecretContent,
  maskSecretValue,
  resolveSwarmSecret,
  buildDatabaseUrlsFromSecrets,
  validateSecretStrength,
  generateSwarmRotationPlan,
  GOLDEN_SWARM_SECRETS_CATALOG,
} from './swarmSecretsUtils.js';

test('sanitizeSecretContent strips trailing CR/LF newlines without modifying internal characters', () => {
  assert.equal(sanitizeSecretContent('KmcSwarm!Secret#2026\n'), 'KmcSwarm!Secret#2026');
  assert.equal(sanitizeSecretContent('KmcSwarm!Secret#2026\r\n'), 'KmcSwarm!Secret#2026');
  assert.equal(sanitizeSecretContent('  internal spaces kept  \r\n\n'), '  internal spaces kept  ');
});

test('resolveSwarmSecret prioritizes *_FILE (/run/secrets/...) over plaintext env vars', () => {
  const result = resolveSwarmSecret({
    secretName: 'kmc_postgres_password',
    envVarName: 'POSTGRES_PASSWORD',
    env: {
      POSTGRES_PASSWORD_FILE: '/run/secrets/kmc_postgres_password',
      POSTGRES_PASSWORD: 'plaintext-ignored-value',
    },
    files: {
      '/run/secrets/kmc_postgres_password': 'SwarmTmpfsSecretValue!99\n',
    },
    strictProduction: true,
  });

  assert.equal(result.value, 'SwarmTmpfsSecretValue!99');
  assert.equal(result.source, 'file_env_var');
  assert.equal(result.resolvedPath, '/run/secrets/kmc_postgres_password');
  assert.equal(result.warnings.length, 0);
  assert.ok(!result.maskedPreview.includes('SwarmTmpfsSecretValue'));
});

test('resolveSwarmSecret falls back to default /run/secrets/<secret_name> when *_FILE is not set', () => {
  const result = resolveSwarmSecret({
    secretName: 'kmc_jwt_secret_key',
    envVarName: 'SECRET_KEY',
    env: {},
    files: {
      '/run/secrets/kmc_jwt_secret_key': '7f9a8b2c4d6e1f3a5b7c9d0e2f4a6b8c9d1e3f5a\r\n',
    },
    strictProduction: true,
  });

  assert.equal(result.value, '7f9a8b2c4d6e1f3a5b7c9d0e2f4a6b8c9d1e3f5a');
  assert.equal(result.source, 'swarm_secret_dir');
  assert.equal(result.resolvedPath, '/run/secrets/kmc_jwt_secret_key');
});

test('resolveSwarmSecret rejects plaintext env fallback when strictProduction is enabled', () => {
  assert.throws(
    () =>
      resolveSwarmSecret({
        secretName: 'kmc_redis_password',
        envVarName: 'REDIS_PASSWORD',
        env: {
          REDIS_PASSWORD: 'PlaintextEnvPassword',
        },
        files: {},
        strictProduction: true,
      }),
    /SWARM GOLDEN PRACTICE VIOLATION/
  );
});

test('buildDatabaseUrlsFromSecrets URL-encodes special characters in Swarm password and masks preview', () => {
  const urls = buildDatabaseUrlsFromSecrets({
    user: 'kmc_user',
    passwordSecret: 'P@ss:w0rd/Swarm#2026!\n',
    host: 'postgres',
    port: 5432,
    db: 'kmc_gis',
  });

  assert.equal(
    urls.asyncpgUrl,
    'postgresql+asyncpg://kmc_user:P%40ss%3Aw0rd%2FSwarm%232026!@postgres:5432/kmc_gis'
  );
  assert.equal(
    urls.libpqUrl,
    'postgresql://kmc_user:P%40ss%3Aw0rd%2FSwarm%232026!@postgres:5432/kmc_gis'
  );
  assert.equal(
    urls.maskedUrl,
    'postgresql+asyncpg://kmc_user:********@postgres:5432/kmc_gis'
  );
});

test('validateSecretStrength enforces minimum length and rejects placeholder strings', () => {
  const weak = validateSecretStrength('CHANGE_ME_PASSWORD', 24);
  assert.equal(weak.valid, false);
  assert.ok(weak.reasons.length >= 1);

  const strong = validateSecretStrength('k9#mP2$vL8@nQ5!xR4&zW7*tY1^cB6%hF3', 24);
  assert.equal(strong.valid, true);
  assert.equal(strong.reasons.length, 0);
});

test('generateSwarmRotationPlan blocks automated rotation for stateful datastore credentials', () => {
  const pgSpec = GOLDEN_SWARM_SECRETS_CATALOG[0];
  const plan = generateSwarmRotationPlan(pgSpec);

  assert.equal(plan.previousVersion, 'v1');
  assert.equal(plan.nextVersion, 'v2');
  assert.equal(plan.externalSecretNamePrev, 'kmc_postgres_password_v1');
  assert.equal(plan.externalSecretNameNext, 'kmc_postgres_password_v2');
  assert.equal(plan.stateful, true);
  assert.ok(plan.commands.some((cmd) => cmd.includes('docker secret create kmc_postgres_password_v2 -')));
  assert.ok(plan.commands.some((cmd) => cmd.includes('MANUAL STEP REQUIRED')));
  assert.ok(!plan.commands.some((cmd) => cmd.includes('docker service update')));
});

test('generateSwarmRotationPlan rotates stateless services with their real file grants', () => {
  const redisPlan = generateSwarmRotationPlan(GOLDEN_SWARM_SECRETS_CATALOG[1]);
  assert.equal(redisPlan.stateful, true);
  assert.ok(!redisPlan.commands.some((cmd) => cmd.includes('docker service update')));

  const jwtPlan = generateSwarmRotationPlan(GOLDEN_SWARM_SECRETS_CATALOG[2]);
  assert.equal(jwtPlan.stateful, false);
  assert.ok(jwtPlan.commands.some((cmd) => cmd.includes('target=kmc_jwt_secret_key,uid=10001,gid=10001,mode=0400')));
  assert.equal(maskSecretValue('short'), '********');
});
