import assert from 'node:assert';
import fs from 'node:fs';

const BASE_URL = 'http://localhost';

// Read secrets (fallback to local dev defaults if not initialized)
const adminPass = fs.existsSync('secrets/kmc_admin_password.txt')
  ? fs.readFileSync('secrets/kmc_admin_password.txt', 'utf8').trim()
  : (process.env.ADMIN_PASSWORD || 'KmcSuperAdmin@2083');
const masterPass = fs.existsSync('secrets/kmc_master_admin_password.txt')
  ? fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim()
  : (process.env.MASTER_ADMIN_PASSWORD || 'KmcMasterAdmin@2083');

console.log('--- Starting KMC Enterprise E2E Verification Suite ---');

async function testHealthAndRuntime() {
  console.log('\n[1] Testing Health, Nginx & Runtime Config...');
  const resHealth = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(resHealth.status, 200, 'Health check must return 200');
  const healthData = await resHealth.json();
  console.log('✓ /api/health OK:', healthData.status, 'PostGIS:', healthData.postgis_version);

  const resNginx = await fetch(`${BASE_URL}/nginx-health`);
  assert.strictEqual(resNginx.status, 200, 'Nginx health must return 200');
  console.log('✓ /nginx-health OK');

  const resRuntime = await fetch(`${BASE_URL}/api/runtime-config`);
  assert.strictEqual(resRuntime.status, 200, 'Runtime config must return 200');
  const runtimeData = await resRuntime.json();
  console.log('✓ /api/runtime-config OK: Sovereign Gateway =', runtimeData.gateway_mode || 'standard');
}

async function testPublicGeoportal() {
  console.log('\n[2] Testing Public Geoportal (Endpoints, Search, Basemaps, Visibility Rules)...');
  
  // Test landing page HTTP 200
  const resLanding = await fetch(`${BASE_URL}/geoportal`);
  assert.strictEqual(resLanding.status, 200, '/geoportal must return 200');
  const htmlLanding = await resLanding.text();
  assert(htmlLanding.includes('html') || htmlLanding.includes('<!DOCTYPE'), 'Landing page must be HTML');
  console.log('✓ /geoportal landing page returns 200 OK');

  // Test map page HTTP 200
  const resMap = await fetch(`${BASE_URL}/geoportal/map`);
  assert.strictEqual(resMap.status, 200, '/geoportal/map must return 200');
  console.log('✓ /geoportal/map returns 200 OK');

  // Test Catalog API
  const resCatalog = await fetch(`${BASE_URL}/api/geoportal/catalog`);
  assert.strictEqual(resCatalog.status, 200, '/api/geoportal/catalog must return 200');
  const catalog = await resCatalog.json();
  console.log(`✓ /api/geoportal/catalog OK: ${catalog.layers?.length || 0} vector layers, ${catalog.mbtiles?.length || 0} raster layers`);

  // Verify public visibility rules: all layers returned in catalog MUST be published=true or public
  if (catalog.layers && catalog.layers.length > 0) {
    for (const l of catalog.layers) {
      assert(l.published !== false, `Layer ${l.id} in public catalog must not be unpublished`);
    }
    console.log('✓ Public visibility rules verified: no unpublished/hidden layers leak into public catalog');
  }

  // Test Geoportal landing stats
  const resStats = await fetch(`${BASE_URL}/api/geoportal/landing-stats`);
  assert.strictEqual(resStats.status, 200, '/api/geoportal/landing-stats must return 200');
  const stats = await resStats.json();
  console.log('✓ /api/geoportal/landing-stats OK:', stats);

  // Test Basemap / TileServer endpoint
  const resTiles = await fetch(`${BASE_URL}/tiles/`);
  console.log(`✓ /tiles/ basemap proxy status: ${resTiles.status}`);
}

async function run() {
  try {
    await testHealthAndRuntime();
    await testPublicGeoportal();
    console.log('\n--- Initial Geoportal & Health Tests Passed! ---');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

run();
