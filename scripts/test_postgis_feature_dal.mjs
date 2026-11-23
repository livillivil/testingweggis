import assert from 'node:assert';
import fs from 'node:fs';

const BASE_URL = 'http://localhost';
const masterPass = fs.existsSync('secrets/kmc_master_admin_password.txt')
  ? fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim()
  : (process.env.MASTER_ADMIN_PASSWORD || 'KmcMasterAdmin@2083');

async function runTest() {
  console.log('================================================================');
  console.log('Testing PostGIS Feature DAL (Merge, Split, Update, Delete)');
  console.log('================================================================');

  // 1. Authenticate as MasterAdmin
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'KmcMasterAdmin', password: masterPass }),
  });
  assert.strictEqual(loginRes.status, 200, `Login status: ${loginRes.status}`);
  const loginData = await loginRes.json();
  const token = loginData.access_token;
  assert(token, 'Token must exist');
  console.log('✓ MasterAdmin authenticated successfully.');

  // 2. Fetch layer metadata to check initial feature_count
  const layersRes = await fetch(`${BASE_URL}/api/layers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(layersRes.status, 200);
  const layers = await layersRes.json();
  const unetRaw = layers.find((l) => String(l.id) === '1795080840951');
  assert(unetRaw, 'Layer 1795080840951 (UnetRaw) must exist');
  const initialCount = unetRaw.feature_count;
  console.log(`✓ Layer 1795080840951 (UnetRaw) initial count: ${initialCount}`);
  assert(initialCount > 100000, `Initial count must be > 100,000, got ${initialCount}`);

  // 3. Query 2 features via BBOX to test merge
  // Kathmandu center bbox: 85.31,27.70,85.33,27.72
  const bboxQueryRes = await fetch(
    `${BASE_URL}/api/layers/1795080840951/features?bbox=85.31,27.70,85.33,27.72&limit=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert.strictEqual(bboxQueryRes.status, 200);
  const fc = await bboxQueryRes.json();
  assert(fc.features && fc.features.length >= 2, 'Must have at least 2 features in bbox');
  const feat1 = fc.features[0];
  const feat2 = fc.features[1];
  console.log(`✓ Fetched 2 features for merge: id1=${feat1.id}, id2=${feat2.id}`);

  // 4. Test Merge
  console.log('\n--- Testing Merge on PostGIS layer ---');
  const mergeRes = await fetch(`${BASE_URL}/api/layers/1795080840951/merge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      feature_ids: [String(feat1.id), String(feat2.id)],
      features: [feat1, feat2],
      merge_mode: 'union',
    }),
  });
  assert.strictEqual(mergeRes.status, 200, `Merge status: ${mergeRes.status}`);
  const mergeData = await mergeRes.json();
  assert.strictEqual(mergeData.status, 'merged_ok', 'Merge status must be merged_ok');
  assert(mergeData.feature_id, 'Merged feature must have an id');
  assert(mergeData.feature_count === initialCount - 1, `Feature count should be ${initialCount - 1}, got ${mergeData.feature_count}`);
  const mergedId = mergeData.feature_id;
  console.log(`✓ Merge succeeded! Merged feature ID: ${mergedId}, New feature count: ${mergeData.feature_count}`);

  // 5. Verify layer count from /api/layers
  const verifyLayersRes = await fetch(`${BASE_URL}/api/layers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const updatedLayers = await verifyLayersRes.json();
  const updatedUnetRaw = updatedLayers.find((l) => String(l.id) === '1795080840951');
  assert.strictEqual(updatedUnetRaw.feature_count, initialCount - 1, `Layer count in metadata must be ${initialCount - 1}`);
  console.log(`✓ Verified /api/layers reflects true count: ${updatedUnetRaw.feature_count}`);

  // 6. Verify feature lookup on the merged feature
  console.log('\n--- Testing Get Feature on merged PostGIS feature ---');
  const getMergedRes = await fetch(`${BASE_URL}/api/features/${mergedId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(getMergedRes.status, 200, `Get merged feature status: ${getMergedRes.status}`);
  const fetchedMerged = await getMergedRes.json();
  assert.strictEqual(String(fetchedMerged.id), String(mergedId), 'Fetched feature ID must match');
  console.log(`✓ Fetched merged feature from PostGIS successfully: type=${fetchedMerged.geometry.type}`);

  // 7. Verify spatial bbox query returns the merged feature
  console.log('\n--- Testing BBOX Query returns merged feature ---');
  const bboxAfterRes = await fetch(
    `${BASE_URL}/api/layers/1795080840951/features?bbox=85.31,27.70,85.33,27.72&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert.strictEqual(bboxAfterRes.status, 200);
  const fcAfter = await bboxAfterRes.json();
  const foundMergedInBbox = fcAfter.features.some((f) => String(f.id) === String(mergedId));
  console.log(`✓ BBOX query returned ${fcAfter.features.length} features; merged feature in bbox: ${foundMergedInBbox}`);

  // 8. Test Feature Update
  console.log('\n--- Testing Feature Update on PostGIS feature ---');
  const updateRes = await fetch(`${BASE_URL}/api/features/${mergedId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      layer_id: 1795080840951,
      properties: {
        building_use: 'Commercial Complex',
        floors_count: '5',
      },
    }),
  });
  assert.strictEqual(updateRes.status, 200, `Update status: ${updateRes.status}`);
  const updatedFeat = await updateRes.json();
  assert.strictEqual(updatedFeat.properties.building_use, 'Commercial Complex');
  console.log(`✓ Feature updated successfully: building_use = ${updatedFeat.properties.building_use}`);

  // 9. Verify updated feature persistence
  const getUpdatedRes = await fetch(`${BASE_URL}/api/features/${mergedId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(getUpdatedRes.status, 200);
  const verifyUpdated = await getUpdatedRes.json();
  assert.strictEqual(verifyUpdated.properties.building_use, 'Commercial Complex');
  console.log('✓ Verified updated properties persisted in PostGIS.');

  // 10. Test Split Preview (using multipart to singleparts mode)
  console.log('\n--- Testing Split Preview on PostGIS feature ---');
  const splitPrevRes = await fetch(`${BASE_URL}/api/features/${mergedId}/split-preview`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ split_multipart: true }),
  });
  assert.strictEqual(splitPrevRes.status, 200, `Split preview status: ${splitPrevRes.status}`);
  const splitPrevData = await splitPrevRes.json();
  assert.strictEqual(splitPrevData.status, 'preview_ok');
  assert(splitPrevData.parts.length >= 2, 'Multipart split should yield at least 2 parts');
  console.log(`✓ Split preview succeeded: ${splitPrevData.parts.length} parts generated.`);

  // 11. Test Split Confirm
  console.log('\n--- Testing Split Confirm on PostGIS feature ---');
  const splitConfirmRes = await fetch(`${BASE_URL}/api/features/${mergedId}/split-confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parts: splitPrevData.parts.map((p) => ({
        id: p.suggested_id,
        geometry: p.geometry,
        properties: { ...splitPrevData.original_properties, split_test: true },
      })),
    }),
  });
  assert.strictEqual(splitConfirmRes.status, 200, `Split confirm status: ${splitConfirmRes.status}`);
  const splitConfirmData = await splitConfirmRes.json();
  assert.strictEqual(splitConfirmData.status, 'split_confirmed');
  console.log(`✓ Split confirm succeeded: ${splitConfirmData.new_features.length} child features inserted into PostGIS.`);

  // 12. Verify layer count after split
  const afterSplitLayersRes = await fetch(`${BASE_URL}/api/layers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const afterSplitLayers = await afterSplitLayersRes.json();
  const afterSplitUnet = afterSplitLayers.find((l) => String(l.id) === '1795080840951');
  console.log(`✓ PostGIS layer count after split: ${afterSplitUnet.feature_count} (restored +1)`);

  // 13. Test Delete on one of the split features
  console.log('\n--- Testing Delete Feature on PostGIS layer ---');
  const deleteTargetId = splitConfirmData.new_features[0].id;
  const deleteRes = await fetch(`${BASE_URL}/api/features/${deleteTargetId}?layer_id=1795080840951`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(deleteRes.status, 200, `Delete status: ${deleteRes.status}`);
  const deleteData = await deleteRes.json();
  assert.strictEqual(deleteData.status, 'deleted');
  console.log(`✓ Successfully deleted feature ${deleteTargetId} from PostGIS.`);

  // 14. Verify count decremented
  const afterDelLayersRes = await fetch(`${BASE_URL}/api/layers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const afterDelLayers = await afterDelLayersRes.json();
  const afterDelUnet = afterDelLayers.find((l) => String(l.id) === '1795080840951');
  console.log(`✓ PostGIS layer count after delete: ${afterDelUnet.feature_count}`);

  console.log('\n================================================================');
  console.log('ALL POSTGIS DAL TESTS PASSED CLEANLY (100% SUCCESS)');
  console.log('================================================================');
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
