import assert from 'node:assert';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE_URL = 'http://localhost';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const masterPass = fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim();
const adminPass = fs.readFileSync('secrets/kmc_admin_password.txt', 'utf8').trim();

console.log('================================================================');
console.log('KMC ENTERPRISE PLATFORM FULL E2E TEST SUITE');
console.log('================================================================');

let masterToken = '';
let superToken = '';
let masterUser = null;
let superUser = null;

const results = {
  geoportal: { passed: 0, failed: 0, details: [] },
  adminAuth: { passed: 0, failed: 0, details: [] },
  userManagement: { passed: 0, failed: 0, details: [] },
  layerManagement: { passed: 0, failed: 0, details: [] },
  fieldCollection: { passed: 0, failed: 0, details: [] },
  houseNumbering: { passed: 0, failed: 0, details: [] },
  chunkedUpload: { passed: 0, failed: 0, details: [] },
  browserE2E: { passed: 0, failed: 0, details: [] },
};

function record(category, testName, passed, detail = '') {
  if (passed) {
    results[category].passed++;
    console.log(`  ✓ [${category}] ${testName}`);
  } else {
    results[category].failed++;
    console.error(`  ✗ [${category}] ${testName}: ${detail}`);
  }
  results[category].details.push({ testName, passed, detail });
}

// -------------------------------------------------------------
// 1. Admin Authentication
// -------------------------------------------------------------
async function testAuth() {
  console.log('\n--- 1. Testing Admin / SuperUser Authentication ---');
  
  // MasterAdmin Login
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'KmcMasterAdmin2083', password: masterPass }),
    });
    assert.strictEqual(res.status, 200, `Status was ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.role, 'MasterAdmin', 'Role must be MasterAdmin');
    assert(data.access_token, 'Access token missing');
    masterToken = data.access_token;
    masterUser = data.user;
    record('adminAuth', 'KmcMasterAdmin2083 login', true);
  } catch (err) {
    record('adminAuth', 'KmcMasterAdmin2083 login', false, err.message);
  }

  // SuperUser Login
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'KmcSuperUser2083', password: adminPass }),
    });
    assert.strictEqual(res.status, 200, `Status was ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.role, 'SuperAdmin', 'Role must be SuperAdmin');
    assert(data.access_token, 'Access token missing');
    superToken = data.access_token;
    superUser = data.user;
    record('adminAuth', 'KmcSuperUser2083 login', true);
  } catch (err) {
    record('adminAuth', 'KmcSuperUser2083 login', false, err.message);
  }

  // Invalid Login Rejection
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'KmcMasterAdmin2083', password: 'WrongPassword999!' }),
    });
    assert.strictEqual(res.status, 401, 'Invalid password must return 401');
    record('adminAuth', 'Reject invalid password', true);
  } catch (err) {
    record('adminAuth', 'Reject invalid password', false, err.message);
  }
}

// -------------------------------------------------------------
// 2. Public Geoportal Verification
// -------------------------------------------------------------
async function testPublicGeoportal() {
  console.log('\n--- 2. Testing Public Geoportal ---');

  // Landing page
  try {
    const res = await fetch(`${BASE_URL}/geoportal`);
    assert.strictEqual(res.status, 200);
    record('geoportal', 'Public Geoportal landing page (HTTP 200)', true);
  } catch (err) {
    record('geoportal', 'Public Geoportal landing page (HTTP 200)', false, err.message);
  }

  // Map page
  try {
    const res = await fetch(`${BASE_URL}/geoportal/map`);
    assert.strictEqual(res.status, 200);
    record('geoportal', 'Public Geoportal map viewer (HTTP 200)', true);
  } catch (err) {
    record('geoportal', 'Public Geoportal map viewer (HTTP 200)', false, err.message);
  }

  // Catalog API & Search
  let publicLayers = [];
  try {
    const res = await fetch(`${BASE_URL}/api/geoportal/catalog`);
    assert.strictEqual(res.status, 200);
    const catalog = await res.json();
    assert(Array.isArray(catalog.categories), 'Catalog must contain categories');
    publicLayers = catalog.categories.flatMap((c) => c.layers || []);
    record('geoportal', `Public Geoportal catalog endpoint (${publicLayers.length} active layers)`, true);
  } catch (err) {
    record('geoportal', 'Public Geoportal catalog endpoint', false, err.message);
  }

  // Basemap & TileServer proxy
  try {
    const res = await fetch(`${BASE_URL}/tiles/`);
    assert.strictEqual(res.status, 200);
    record('geoportal', 'Basemap / TileServer proxy endpoint', true);
  } catch (err) {
    record('geoportal', 'Basemap / TileServer proxy endpoint', false, err.message);
  }

  // Public Visibility Rules:
  // Create layer -> update published=false -> verify NOT in public catalog -> update published=true -> verify IS in catalog
  try {
    const hiddenLayerName = `E2E_Visibility_Test_${Date.now()}`;
    const createRes = await fetch(`${BASE_URL}/api/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        name: hiddenLayerName,
        geometry_type: 'Point',
        is_global: true,
      }),
    });
    assert.strictEqual(createRes.status, 200, `Create layer failed with ${createRes.status}`);
    const newLayer = await createRes.json();
    const newLayerId = newLayer.id;

    // Explicitly unpublish layer
    const unpubRes = await fetch(`${BASE_URL}/api/layers/${newLayerId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({ published: false }),
    });
    if (unpubRes.status !== 200) {
      const errText = await unpubRes.text();
      assert.strictEqual(unpubRes.status, 200, `Unpublish failed with ${unpubRes.status}: ${errText}`);
    }

    // Verify absent from anonymous public catalog
    const checkCat = await fetch(`${BASE_URL}/api/geoportal/catalog`);
    const catJson = await checkCat.json();
    const allLayers = (catJson.categories || []).flatMap((c) => c.layers || []);
    const foundUnpublished = allLayers.find((l) => l.id === newLayerId);
    assert(!foundUnpublished, 'Unpublished layer must NOT appear in public geoportal catalog');

    // Re-publish layer
    const pubRes = await fetch(`${BASE_URL}/api/layers/${newLayerId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({ published: true }),
    });
    if (pubRes.status !== 200) {
      const errText = await pubRes.text();
      assert.strictEqual(pubRes.status, 200, `Publish failed with ${pubRes.status}: ${errText}`);
    }

    // Verify present in public catalog
    const checkCat2 = await fetch(`${BASE_URL}/api/geoportal/catalog`);
    const catJson2 = await checkCat2.json();
    const allLayers2 = (catJson2.categories || []).flatMap((c) => c.layers || []);
    const foundPublished = allLayers2.find((l) => l.id === newLayerId);
    assert(foundPublished, 'Published layer MUST appear in public geoportal catalog');

    // Clean up layer
    await fetch(`${BASE_URL}/api/layers/${newLayerId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    await fetch(`${BASE_URL}/api/layers/${newLayerId}/permanent`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });

    record('geoportal', 'Public visibility rules (hidden layers hidden, published layers visible)', true);
  } catch (err) {
    record('geoportal', 'Public visibility rules (hidden layers hidden, published layers visible)', false, err.message);
  }
}

// -------------------------------------------------------------
// 3. User Management (CRUD, Roles, Password Update, Deletion)
// -------------------------------------------------------------
async function testUserManagement() {
  console.log('\n--- 3. Testing User Management (Validator, Data Collector, Dept Head) ---');

  const stamp = Date.now();
  const testUsers = [
    { username: `val_${stamp}`, role: 'Validator', email: `val_${stamp}@kmc.gov.np`, fullName: 'E2E Validator' },
    { username: `col_${stamp}`, role: 'DataCollector', email: `col_${stamp}@kmc.gov.np`, fullName: 'E2E Collector' },
    { username: `dept_${stamp}`, role: 'DepartmentAdmin', email: `dept_${stamp}@kmc.gov.np`, fullName: 'E2E Dept Head' },
  ];

  const createdUserIds = [];

  // Create Users
  for (const u of testUsers) {
    try {
      const res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${masterToken}`,
        },
        body: JSON.stringify({
          username: u.username,
          email: u.email,
          full_name: u.fullName,
          role: u.role,
          password: 'TemporaryInitialPass123!@#',
        }),
      });
      assert.strictEqual(res.status, 200, `User creation failed with ${res.status}`);
      const data = await res.json();
      assert.strictEqual(data.role, u.role);
      assert.strictEqual(data.username, u.username);
      createdUserIds.push(data.id);
      record('userManagement', `Create user with role ${u.role} (${u.username})`, true);
    } catch (err) {
      record('userManagement', `Create user with role ${u.role} (${u.username})`, false, err.message);
    }
  }

  // Verify users in list
  try {
    const listRes = await fetch(`${BASE_URL}/api/users`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    assert.strictEqual(listRes.status, 200);
    const users = await listRes.json();
    for (const uid of createdUserIds) {
      assert(users.some((u) => u.id === uid), `User ${uid} must exist in users list`);
    }
    record('userManagement', 'List all users and verify existence', true);
  } catch (err) {
    record('userManagement', 'List all users and verify existence', false, err.message);
  }

  // Password editing
  if (createdUserIds.length > 0) {
    const testUid = createdUserIds[0];
    const newPass = 'UpdatedSecurePass888!@#';
    try {
      const pwRes = await fetch(`${BASE_URL}/api/users/${testUid}/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${masterToken}`,
        },
        body: JSON.stringify({ new_password: newPass }),
      });
      assert.strictEqual(pwRes.status, 200, `Password change failed with ${pwRes.status}`);

      // Verify login with new password
      const loginCheck = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testUsers[0].username, password: newPass }),
      });
      assert.strictEqual(loginCheck.status, 200, 'Login with updated password must succeed');
      record('userManagement', 'Password update and verified authentication', true);
    } catch (err) {
      record('userManagement', 'Password update and verified authentication', false, err.message);
    }
  }

  // Delete Users
  for (const uid of createdUserIds) {
    try {
      const delRes = await fetch(`${BASE_URL}/api/users/${uid}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${masterToken}` },
      });
      assert.strictEqual(delRes.status, 200, `Deletion failed with ${delRes.status}`);
      record('userManagement', `Delete user ${uid}`, true);
    } catch (err) {
      record('userManagement', `Delete user ${uid}`, false, err.message);
    }
  }
}

// -------------------------------------------------------------
// 4. Vector & Raster Layer Management & Endpoints (OGC, MVT, XYZ)
// -------------------------------------------------------------
async function testLayerManagement() {
  console.log('\n--- 4. Testing Layer Management & OGC/MVT/XYZ Endpoints ---');

  // List existing vector layers
  let layers = [];
  try {
    const res = await fetch(`${BASE_URL}/api/layers`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    assert.strictEqual(res.status, 200);
    layers = await res.json();
    assert(layers.length > 0, 'Should have at least 1 layer');
    record('layerManagement', 'List vector layers', true);
  } catch (err) {
    record('layerManagement', 'List vector layers', false, err.message);
  }

  // Check building polygons layer
  const polyLayer = layers.find((l) => (l.geom_type || l.geometry_type) === 'Polygon');
  if (polyLayer) {
    record('layerManagement', `Verified polygon layer: ${polyLayer.name} (features: ${polyLayer.feature_count})`, true);
  } else {
    record('layerManagement', 'Verified polygon layer', false, 'No polygon layer found');
  }

  // Verify OGC API Features endpoint (/ogc/collections)
  try {
    const ogcRes = await fetch(`${BASE_URL}/ogc/collections`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    assert.strictEqual(ogcRes.status, 200);
    const ogcData = await ogcRes.json();
    assert(Array.isArray(ogcData.collections), 'OGC collections must be array');
    record('layerManagement', `OGC API Features Collections endpoint (/ogc/collections, ${ogcData.collections.length} collections)`, true);

    if (polyLayer) {
      const itemsRes = await fetch(`${BASE_URL}/ogc/collections/${polyLayer.id}/items?limit=5`, {
        headers: { 'Authorization': `Bearer ${masterToken}` },
      });
      assert.strictEqual(itemsRes.status, 200);
      const items = await itemsRes.json();
      assert.strictEqual(items.type, 'FeatureCollection');
      record('layerManagement', `OGC API Features Items query for layer ${polyLayer.id}`, true);
    }
  } catch (err) {
    record('layerManagement', 'OGC API Features endpoints', false, err.message);
  }

  // Verify Martin MVT endpoint
  try {
    const martinRes = await fetch(`${BASE_URL}/martin/vector_features/0/0/0`);
    assert([200, 204].includes(martinRes.status), `Martin status: ${martinRes.status}`);
    const cacheStatus = martinRes.headers.get('x-cache-status') || 'EDGE';
    record('layerManagement', `Martin MVT vector tile serving endpoint (/martin/vector_features/..., cache: ${cacheStatus})`, true);
  } catch (err) {
    record('layerManagement', 'Martin MVT vector tile serving endpoint', false, err.message);
  }

  // Verify XYZ Raster Tile endpoint
  try {
    const tilesRes = await fetch(`${BASE_URL}/api/tiles`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    assert.strictEqual(tilesRes.status, 200);
    const tiles = await tilesRes.json();
    record('layerManagement', `Raster tile packages list (${tiles.length} packages)`, true);
  } catch (err) {
    record('layerManagement', 'Raster tile packages list', false, err.message);
  }
}

// -------------------------------------------------------------
// 5. Field Data Collection (AOI, Grid, Questionnaire, Form Inputs)
// -------------------------------------------------------------
async function testFieldDataCollection() {
  console.log('\n--- 5. Testing Field Data Collection Platform ---');

  let testProjectId = null;
  let testProjectLayerId = null;

  // Create test project
  try {
    const projRes = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        name: `E2E Survey Project ${Date.now()}`,
        description: 'Automated E2E field collection project',
        ward: 4,
      }),
    });
    assert.strictEqual(projRes.status, 200);
    const proj = await projRes.json();
    testProjectId = proj.id;
    record('fieldCollection', `Create field project (ID: ${testProjectId})`, true);
  } catch (err) {
    record('fieldCollection', 'Create field project', false, err.message);
  }

  if (!testProjectId) return;

  // Create project-bound vector layer
  try {
    const pLayerRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}/layers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        name: 'Project Field Survey Layer',
        geometry_type: 'Point',
        editable_by_collectors: true,
        fields_config: [
          { name: 'building_use', label: 'Building Use', type: 'text', access_level: 'public' },
          { name: 'floors_count', label: 'Floors', type: 'number', access_level: 'public' },
        ],
      }),
    });
    assert.strictEqual(pLayerRes.status, 200);
    const pLayer = await pLayerRes.json();
    testProjectLayerId = pLayer.id;
    record('fieldCollection', `Create project vector layer (ID: ${testProjectLayerId})`, true);
  } catch (err) {
    record('fieldCollection', 'Create project vector layer', false, err.message);
  }

  // AOI assignment
  const sampleAOI = {
    type: 'Polygon',
    coordinates: [
      [
        [85.304, 27.700],
        [85.310, 27.700],
        [85.310, 27.705],
        [85.304, 27.705],
        [85.304, 27.700],
      ],
    ],
  };

  try {
    const aoiRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}/boundary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        boundary_geojson: sampleAOI,
        aoi_mode: 'drawn_polygon',
      }),
    });
    assert.strictEqual(aoiRes.status, 200);
    const aoiData = await aoiRes.json();
    assert.strictEqual(aoiData.status, 'ok');
    record('fieldCollection', `Set project AOI boundary (${Math.round(aoiData.aoi_area_sqm)} sq m)`, true);
  } catch (err) {
    record('fieldCollection', 'Set project AOI boundary', false, err.message);
  }

  // Generate grid boundaries
  try {
    const gridRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}/generate-grid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        grid_type: 'HEXAGON',
        grid_size_m: 200,
      }),
    });
    if (gridRes.status !== 200) {
      const errText = await gridRes.text();
      assert.strictEqual(gridRes.status, 200, `generate-grid failed with ${gridRes.status}: ${errText}`);
    }
    const gridData = await gridRes.json();
    assert(gridData.tasks_created > 0, 'Grid generation must create tasks');

    // Fetch generated task grid cells
    const tasksRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}/tasks`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    if (tasksRes.status !== 200) {
      const errText = await tasksRes.text();
      assert.strictEqual(tasksRes.status, 200, `tasks list failed with ${tasksRes.status}: ${errText}`);
    }
    const tasksData = await tasksRes.json();
    const taskFeatures = tasksData.features || (Array.isArray(tasksData) ? tasksData : []);
    assert(taskFeatures.length > 0, 'Tasks list must not be empty');
    record('fieldCollection', `Generate task grid boundaries (${gridData.tasks_created} hexagon cells generated and queried)`, true);
  } catch (err) {
    record('fieldCollection', 'Generate task grid boundaries', false, err.message);
  }

  // Questionnaire builder: create structured questionnaire
  let questionnaireId = null;
  try {
    const qRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}/questionnaires`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        title: 'Municipal Building Inspection Questionnaire',
        description: 'Standard field survey questionnaire for ward infrastructure',
        schema_definition: {
          sections: [
            {
              id: 'sec_general',
              title: 'General Information',
              title_ne: 'सामान्य जानकारी',
            },
          ],
          questions: [
            {
              id: 'q_use',
              name: 'building_use',
              label: 'Building Usage',
              label_ne: 'भवनको उपयोग',
              type: 'text',
              required: true,
              section_id: 'sec_general',
            },
            {
              id: 'q_floors',
              name: 'floors_count',
              label: 'Number of Floors',
              label_ne: 'तल्ला संख्या',
              type: 'number',
              required: true,
              section_id: 'sec_general',
            },
          ],
        },
      }),
    });
    assert.strictEqual(qRes.status, 200);
    const qData = await qRes.json();
    questionnaireId = qData.id;
    // Link the newly created questionnaire to the test layer
    await fetch(`${BASE_URL}/api/layers/${testProjectLayerId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        questionnaire_id: questionnaireId,
      }),
    });
    record('fieldCollection', `Questionnaire builder (Created ID: ${questionnaireId})`, true);
  } catch (err) {
    record('fieldCollection', 'Questionnaire builder', false, err.message);
  }

  // Form input submission & offline sync readiness
  try {
    const formSubmission = {
      project_id: testProjectId,
      questionnaire_id: questionnaireId,
      layer_id: testProjectLayerId,
      answers: {
        building_use: 'residential',
        floors_count: 3,
      },
      geometry: {
        type: 'Point',
        coordinates: [85.305, 27.701],
      },
    };
    const subRes = await fetch(`${BASE_URL}/api/projects/${testProjectId}/records/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify(formSubmission),
    });
    assert.strictEqual(subRes.status, 200);
    const subData = await subRes.json();
    assert(subData.record_id || subData.id, 'Record must be saved with id');
    record('fieldCollection', 'Form input submission and validation', true);
  } catch (err) {
    record('fieldCollection', 'Form input submission and validation', false, err.message);
  }

  // Clean up test project
  try {
    await fetch(`${BASE_URL}/api/projects/${testProjectId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
  } catch (_) {}
}

// -------------------------------------------------------------
// 6. Metric House Numbering & Feature Linking
// -------------------------------------------------------------
async function testHouseNumbering() {
  console.log('\n--- 6. Testing Metric House Numbering & Feature Linking ---');

  // House numbering stats
  try {
    const statsRes = await fetch(`${BASE_URL}/api/house-numbering/stats`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    assert.strictEqual(statsRes.status, 200);
    record('houseNumbering', 'House numbering stats endpoint', true);
  } catch (err) {
    record('houseNumbering', 'House numbering stats endpoint', false, err.message);
  }

  // Metric House Numbering generation test
  let roadLayerId = null;
  let bldgLayerId = null;
  try {
    // 1. Create road layer with fields_config
    const rLayerRes = await fetch(`${BASE_URL}/api/layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${masterToken}` },
      body: JSON.stringify({
        name: 'E2E Road Layer HN',
        geometry_type: 'LineString',
        is_global: true,
        fields_config: [{ name: 'name', label: 'Road Name', type: 'text', access_level: 'public' }],
      }),
    });
    assert.strictEqual(rLayerRes.status, 200, 'Create road layer must return 200');
    const rLayer = await rLayerRes.json();
    roadLayerId = rLayer.id;

    // 2. Create building layer with fields_config
    const bLayerRes = await fetch(`${BASE_URL}/api/layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${masterToken}` },
      body: JSON.stringify({
        name: 'E2E Bldg Layer HN',
        geometry_type: 'Polygon',
        is_global: true,
        fields_config: [{ name: 'name', label: 'Bldg Name', type: 'text', access_level: 'public' }],
      }),
    });
    assert.strictEqual(bLayerRes.status, 200, 'Create building layer must return 200');
    const bLayer = await bLayerRes.json();
    bldgLayerId = bLayer.id;

    const roadFid = `road-hn-${Date.now()}`;
    const b1Fid = `bldg-left-${Date.now()}`;
    const b2Fid = `bldg-right-${Date.now()}`;

    // 3. Add road feature
    const roadFeatRes = await fetch(`${BASE_URL}/api/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${masterToken}` },
      body: JSON.stringify({
        layer_id: roadLayerId,
        id: roadFid,
        geometry: {
          type: 'LineString',
          coordinates: [[85.320, 27.695], [85.325, 27.695]],
        },
        properties: { name: 'Baneshwor E2E Marg' },
      }),
    });
    if (roadFeatRes.status !== 200) {
      const err = await roadFeatRes.text();
      assert.strictEqual(roadFeatRes.status, 200, `roadFeat failed: ${err}`);
    }
    const roadFeat = await roadFeatRes.json();

    // 4. Add building features (Left = Odd, Right = Even)
    const b1Res = await fetch(`${BASE_URL}/api/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${masterToken}` },
      body: JSON.stringify({
        layer_id: bldgLayerId,
        id: b1Fid,
        geometry: {
          type: 'Polygon',
          coordinates: [[[85.321, 27.6952], [85.322, 27.6952], [85.322, 27.6954], [85.321, 27.6954], [85.321, 27.6952]]],
        },
        properties: { name: 'Building Left' },
      }),
    });
    if (b1Res.status !== 200) {
      const err = await b1Res.text();
      assert.strictEqual(b1Res.status, 200, `b1Res failed: ${err}`);
    }
    const b1Feat = await b1Res.json();

    const b2Res = await fetch(`${BASE_URL}/api/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${masterToken}` },
      body: JSON.stringify({
        layer_id: bldgLayerId,
        id: b2Fid,
        geometry: {
          type: 'Polygon',
          coordinates: [[[85.321, 27.6946], [85.322, 27.6946], [85.322, 27.6948], [85.321, 27.6948], [85.321, 27.6946]]],
        },
        properties: { name: 'Building Right' },
      }),
    });
    if (b2Res.status !== 200) {
      const err = await b2Res.text();
      assert.strictEqual(b2Res.status, 200, `b2Res failed: ${err}`);
    }
    const b2Feat = await b2Res.json();

    // 5. Run house numbering generator
    const genRes = await fetch(`${BASE_URL}/api/house-numbering/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        road_layer_id: roadLayerId,
        road_feature_id: roadFid,
        building_layer_id: bldgLayerId,
        ward: '4',
        numbering_scheme: 'METRIC',
        interval_m: 5.0,
        start_number: 1,
        prefix: 'W4-',
        max_distance_from_road_m: 100.0,
        save_to_database: false,
      }),
    });

    if (genRes.status !== 200) {
      const err = await genRes.text();
      assert.strictEqual(genRes.status, 200, `House numbering failed with ${genRes.status}: ${err}`);
    }
    const genData = await genRes.json();
    assert(genData.proposals && genData.proposals.length >= 2, 'Must generate proposals for buildings');
    
    // Verify parity
    const leftProp = genData.proposals.find((p) => p.side === 'LEFT');
    const rightProp = genData.proposals.find((p) => p.side === 'RIGHT');
    assert(leftProp, 'Must have proposal on LEFT side');
    assert(rightProp, 'Must have proposal on RIGHT side');
    const leftNum = parseInt(leftProp.house_number.replace('W4-', ''), 10);
    const rightNum = parseInt(rightProp.house_number.replace('W4-', ''), 10);
    assert.strictEqual(leftNum % 2, 1, 'LEFT side house number must be ODD');
    assert.strictEqual(rightNum % 2, 0, 'RIGHT side house number must be EVEN');

    record('houseNumbering', `Metric addressing verified: LEFT=${leftProp.house_number} (Odd), RIGHT=${rightProp.house_number} (Even)`, true);

    // Feature Linking test: link b1Feat to roadFeat
    const linkRes = await fetch(`${BASE_URL}/api/features/${b1Feat.id}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${masterToken}` },
      body: JSON.stringify({
        target_layer_id: roadLayerId,
        target_feature_id: roadFid,
        link_type: 'road_access',
      }),
    });
    if (linkRes.status !== 200) {
      const err = await linkRes.text();
      assert.strictEqual(linkRes.status, 200, `linkRes failed: ${err}`);
    }
    record('houseNumbering', 'Feature linking (Building to Road access link)', true);

    // Clean up temporary layers
    for (const lid of [roadLayerId, bldgLayerId]) {
      await fetch(`${BASE_URL}/api/layers/${lid}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${masterToken}` } });
      await fetch(`${BASE_URL}/api/layers/${lid}/permanent`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${masterToken}` } });
    }
  } catch (err) {
    record('houseNumbering', 'Metric addressing and feature linking', false, err.message);
  }
}

// -------------------------------------------------------------
// 7. Chunked Upload UI & Resilient Upload Pipeline
// -------------------------------------------------------------
async function testChunkedUpload() {
  console.log('\n--- 7. Testing Chunked Upload (100GB+ Resilience, Multi-File, Progress) ---');

  // Simulate a 100GB upload session initialization
  const hugeSizeBytes = 100 * 1024 * 1024 * 1024; // 100 GB in bytes
  let uploadId = null;
  let chunkSize = 5 * 1024 * 1024; // 5MB chunks

  try {
    const initRes = await fetch(`${BASE_URL}/api/uploads/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: JSON.stringify({
        filename: 'Kathmandu_Drone_Survey_Ward4_100GB.mbtiles',
        mime_type: 'application/octet-stream',
        total_size: hugeSizeBytes,
        kind: 'raster',
        name: 'Kathmandu 100GB Drone Survey',
        is_global: true,
      }),
    });
    assert.strictEqual(initRes.status, 200, `Init status: ${initRes.status}`);
    const initData = await initRes.json();
    uploadId = initData.upload_id;
    chunkSize = initData.chunk_size || chunkSize;
    assert(uploadId, 'Upload ID must be returned');
    assert(initData.total_chunks > 1000, '100GB must split into thousands of chunks');
    record('chunkedUpload', `100GB+ session initialization (${initData.total_chunks} chunks computed)`, true);
  } catch (err) {
    record('chunkedUpload', '100GB+ session initialization', false, err.message);
  }

  if (!uploadId) return;

  // Upload sample chunk (chunk index 0)
  try {
    const sampleChunk = Buffer.alloc(1024 * 64, 0x42); // 64KB dummy slice
    const chunkRes = await fetch(`${BASE_URL}/api/uploads/${uploadId}/chunk?index=0&offset=0`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: sampleChunk,
    });
    assert.strictEqual(chunkRes.status, 200);
    record('chunkedUpload', 'Upload chunk with sparse offset writing', true);
  } catch (err) {
    record('chunkedUpload', 'Upload chunk with sparse offset writing', false, err.message);
  }

  // Upload out-of-order chunk (chunk index 5) to verify resume resilience
  try {
    const chunk5Offset = 5 * chunkSize;
    const sampleChunk5 = Buffer.alloc(1024 * 64, 0x55);
    const chunkRes5 = await fetch(`${BASE_URL}/api/uploads/${uploadId}/chunk?index=5&offset=${chunk5Offset}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${masterToken}`,
      },
      body: sampleChunk5,
    });
    assert.strictEqual(chunkRes5.status, 200);
    record('chunkedUpload', 'Out-of-order chunk upload resilience', true);
  } catch (err) {
    record('chunkedUpload', 'Out-of-order chunk upload resilience', false, err.message);
  }

  // Verify status & progress tracking
  try {
    const statusRes = await fetch(`${BASE_URL}/api/uploads/${uploadId}`, {
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.received_chunks_count, 2, 'Must have received 2 chunks');
    assert(statusData.total_chunks > 1000, 'Total chunks preserved');
    record('chunkedUpload', `Progress tracking verified: ${statusData.received_chunks_count} / ${statusData.total_chunks} chunks`, true);
  } catch (err) {
    record('chunkedUpload', 'Progress tracking verified', false, err.message);
  }

  // Clean up aborted upload session
  try {
    await fetch(`${BASE_URL}/api/uploads/${uploadId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${masterToken}` },
    });
    record('chunkedUpload', 'Upload session cleanup', true);
  } catch (err) {
    record('chunkedUpload', 'Upload session cleanup', false, err.message);
  }
}

// -------------------------------------------------------------
// 8. Headless Browser E2E (Puppeteer Chrome Automation)
// -------------------------------------------------------------
async function testBrowserE2E() {
  console.log('\n--- 8. Testing Browser E2E Rendering with Headless Chrome ---');

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,900'],
    });
    record('browserE2E', 'Chrome headless browser launch', true);
  } catch (err) {
    record('browserE2E', 'Chrome headless browser launch', false, err.message);
    return;
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // 8a. Public Geoportal Page
  try {
    await page.goto(`${BASE_URL}/geoportal`, { waitUntil: 'networkidle2', timeout: 15000 });
    const title = await page.title();
    const hasHeader = await page.evaluate(() => {
      return document.body.innerText.includes('काठमाडौं') || document.body.innerText.includes('Kathmandu') || document.body.innerText.includes('GeoPortal');
    });
    assert(hasHeader, 'Geoportal landing page must contain Kathmandu / GeoPortal heading');
    record('browserE2E', `Browser renders /geoportal ("${title}")`, true);
  } catch (err) {
    record('browserE2E', 'Browser renders /geoportal', false, err.message);
  }

  // 8b. Public Geoportal Map Page
  try {
    await page.goto(`${BASE_URL}/geoportal/map`, { waitUntil: 'networkidle2', timeout: 15000 });
    // Check for OpenLayers map viewport canvas or ol-viewport
    await page.waitForSelector('.ol-viewport, canvas, #map', { timeout: 10000 });
    const hasMap = await page.evaluate(() => {
      return document.querySelector('.ol-viewport') !== null || document.querySelector('canvas') !== null;
    });
    assert(hasMap, 'OpenLayers map viewport must be present in DOM');
    record('browserE2E', 'Browser renders OpenLayers map viewer on /geoportal/map', true);
  } catch (err) {
    record('browserE2E', 'Browser renders OpenLayers map viewer on /geoportal/map', false, err.message);
  }

  // 8c. Admin / Field Platform Login Page
  try {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2', timeout: 15000 });
    await page.waitForSelector('input', { timeout: 8000 });
    
    // Fill credentials for KmcMasterAdmin2083
    const inputs = await page.$$('input');
    let usernameInput = null;
    let passwordInput = null;

    for (const input of inputs) {
      const type = await (await input.getProperty('type')).jsonValue();
      const placeholder = (await (await input.getProperty('placeholder')).jsonValue() || '').toLowerCase();
      const name = (await (await input.getProperty('name')).jsonValue() || '').toLowerCase();
      if (type === 'password') {
        passwordInput = input;
      } else if (type === 'text' || placeholder.includes('user') || name.includes('user')) {
        usernameInput = input;
      }
    }

    if (!usernameInput && inputs.length > 0) usernameInput = inputs[0];

    assert(usernameInput, 'Username input not found');
    assert(passwordInput, 'Password input not found');

    await usernameInput.type('KmcMasterAdmin2083');
    await passwordInput.type(masterPass);

    // Submit form
    const submitBtn = await page.$('button[type="submit"]') || (await page.$$('button'))[0];
    assert(submitBtn, 'Submit button not found');
    await submitBtn.click();

    // Wait for navigation / redirect
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    const currentUrl = page.url();
    console.log(`    -> Redirected to: ${currentUrl}`);
    const pageText = await page.evaluate(() => document.body.innerText);
    const loggedIn = pageText.includes('प्रशासक') || pageText.includes('Admin') || pageText.includes('KmcMasterAdmin2083') || currentUrl.includes('dashboard') || currentUrl === `${BASE_URL}/`;
    assert(loggedIn, 'User should be logged in to admin platform');
    record('browserE2E', 'Browser login flow with KmcMasterAdmin2083 and dashboard entry', true);
  } catch (err) {
    record('browserE2E', 'Browser login flow with KmcMasterAdmin2083', false, err.message);
  }

  await browser.close();
}

// -------------------------------------------------------------
// Runner
// -------------------------------------------------------------
async function runAll() {
  await testAuth();
  await testPublicGeoportal();
  await testUserManagement();
  await testLayerManagement();
  await testFieldDataCollection();
  await testHouseNumbering();
  await testChunkedUpload();
  await testBrowserE2E();

  console.log('\n================================================================');
  console.log('SUMMARY OF VERIFICATION RESULTS:');
  console.log('================================================================');
  let totalPassed = 0;
  let totalFailed = 0;
  for (const [cat, res] of Object.entries(results)) {
    console.log(`${cat.padEnd(20)}: ${res.passed} passed, ${res.failed} failed`);
    totalPassed += res.passed;
    totalFailed += res.failed;
  }
  console.log('----------------------------------------------------------------');
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  console.log('================================================================');

  if (totalFailed > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Unhandled test execution error:', err);
  process.exit(1);
});
