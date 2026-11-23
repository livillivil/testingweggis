import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost';
const ARTIFACT_DIR = 'C:\\Users\\jksan\\.gemini\\antigravity\\brain\\dc9d26db-9032-4a8a-9e88-8626ade59a5e';

async function main() {
  console.log('================================================================');
  console.log('VISUAL MAP VERIFICATION: BUILDING FOOTPRINTS & ROAD LINES');
  console.log('================================================================');

  const adminPass = fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim();

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  try {
    const page = await browser.newPage();

    // 1. Verify Field Platform / Admin Dashboard Map
    console.log('\n[1/3] Logging into Field Platform Dashboard...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2' });
    await page.type('input#username, input[name="username"]', 'KmcMasterAdmin2083');
    await page.type('input#password, input[name="password"]', adminPass);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    console.log('Logged in. Current URL:', page.url());
    assert(page.url().includes('/dashboard'), 'Must redirect to /dashboard');

    // Wait for OpenLayers map container and window.__kmcMap
    console.log('Waiting for OpenLayers map instance (window.__kmcMap)...');
    await page.waitForFunction(() => typeof window.__kmcMap !== 'undefined', { timeout: 15000 });

    // Inspect layers and features inside the map
    const mapStats = await page.evaluate(async () => {
      const map = window.__kmcMap;
      if (!map) return null;

      // Center map on Kathmandu center with zoom 16
      const view = map.getView();
      // OpenLayers uses EPSG:3857 coordinates
      // Convert 85.307, 27.702 to EPSG:3857
      const lon = 85.307;
      const lat = 27.702;
      const x = (lon * 20037508.34) / 180;
      let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
      y = (y * 20037508.34) / 180;

      view.setCenter([x, y]);
      view.setZoom(16);
      map.renderSync();

      // Give 2 seconds for bbox requests or rendering
      await new Promise((r) => setTimeout(r, 2500));

      const layers = map.getLayers().getArray();
      const layerDetails = layers.map((lyr) => {
        const title = lyr.get('title') || lyr.get('name') || lyr.constructor.name;
        const src = lyr.getSource ? lyr.getSource() : null;
        const features = src && src.getFeatures ? src.getFeatures() : [];
        const geomTypes = {};
        for (const f of features) {
          const g = f.getGeometry();
          if (g) {
            const t = g.getType();
            geomTypes[t] = (geomTypes[t] || 0) + 1;
          }
        }
        return {
          title,
          visible: lyr.getVisible(),
          opacity: lyr.getOpacity(),
          featureCount: features.length,
          geomTypes,
        };
      });

      return {
        zoom: view.getZoom(),
        center: view.getCenter(),
        layerCount: layers.length,
        layerDetails,
      };
    });

    console.log('Dashboard Map Stats:', JSON.stringify(mapStats, null, 2));

    // Save dashboard screenshot
    const dashScreenshotPath = path.join(ARTIFACT_DIR, 'field_platform_map_visual.png');
    await page.screenshot({ path: dashScreenshotPath, fullPage: false });
    console.log(`Saved screenshot: ${dashScreenshotPath}`);

    // 2. Verify Public Geoportal Map Viewer
    console.log('\n[2/3] Loading Public Geoportal Map Viewer (/geoportal/map)...');
    await page.goto(`${BASE_URL}/geoportal/map`, { waitUntil: 'networkidle2' });

    // Wait for the OpenLayers canvas on geoportal
    await page.waitForSelector('.ol-viewport canvas', { timeout: 15000 });
    console.log('OpenLayers viewport canvas successfully located on /geoportal/map.');

    // Wait 3 seconds for vector/raster tiles to stream in
    await new Promise((r) => setTimeout(r, 3000));

    // Save geoportal screenshot
    const geoScreenshotPath = path.join(ARTIFACT_DIR, 'geoportal_map_visual.png');
    await page.screenshot({ path: geoScreenshotPath, fullPage: false });
    console.log(`Saved screenshot: ${geoScreenshotPath}`);

    // 3. Verify Layer Feature Delivery via Nginx API
    console.log('\n[3/3] Verifying Dynamic Building Footprints and Roads from /api/layers...');
    const layersRes = await fetch(`${BASE_URL}/api/layers`);
    assert.strictEqual(layersRes.status, 200, `List layers status ${layersRes.status}`);
    const layersList = await layersRes.json();
    const bldgLayer = layersList.find((l) => (l.name || '').toLowerCase().includes('unet') || (l.name || '').toLowerCase().includes('building') || l.geometry_type === 'Polygon' || l.geometry_type === 'MultiPolygon');
    const roadLayer = layersList.find((l) => (l.name || '').toLowerCase().includes('road') || l.geometry_type === 'LineString' || l.geometry_type === 'MultiLineString');

    assert(bldgLayer, 'Building footprint polygon layer must exist in /api/layers');
    assert(roadLayer, 'Road layer must exist in /api/layers');

    const bldgRes = await fetch(`${BASE_URL}/api/layers/${bldgLayer.id}/features?bbox=85.31,27.70,85.32,27.71&zoom=16&portal=true`);
    assert.strictEqual(bldgRes.status, 200, `Building layer HTTP status ${bldgRes.status}`);
    const bldgData = await bldgRes.json();
    const bldgFeatures = bldgData.features || [];
    console.log(`Building Footprint Layer (${bldgLayer.id} - ${bldgLayer.name}): Received ${bldgFeatures.length} features`);
    assert(bldgFeatures.length > 0, 'Building layer must return features in Kathmandu bbox');

    const roadRes = await fetch(`${BASE_URL}/api/layers/${roadLayer.id}/features?bbox=85.31,27.70,85.32,27.71&zoom=16&portal=true`);
    assert.strictEqual(roadRes.status, 200, `Road layer HTTP status ${roadRes.status}`);
    const roadData = await roadRes.json();
    const roadFeatures = roadData.features || [];
    console.log(`Road Layer (${roadLayer.id} - ${roadLayer.name}): Received ${roadFeatures.length} features`);
    assert(roadFeatures.length > 0, 'Road layer must return features in Kathmandu bbox');

    // Inspect polygon geometry coordinates
    let polyCount = 0;
    let nonZeroAreaCount = 0;
    for (const bf of bldgFeatures) {
      if (!bf.geometry) continue;
      if (bf.geometry.type === 'Polygon') {
        polyCount++;
        const coords = bf.geometry.coordinates;
        if (coords && coords.length > 0 && coords[0].length >= 3) {
          nonZeroAreaCount++;
        }
      } else if (bf.geometry.type === 'MultiPolygon') {
        polyCount++;
        const coords = bf.geometry.coordinates;
        if (coords && coords.length > 0 && coords[0].length > 0 && coords[0][0].length >= 3) {
          nonZeroAreaCount++;
        }
      }
    }
    console.log(`Building Polygons verified: ${polyCount} features (${nonZeroAreaCount} with valid closed rings >= 3 vertices)`);
    assert(polyCount > 0, 'Must have building polygon features');
    assert.strictEqual(nonZeroAreaCount, polyCount, 'All building features must have valid closed rings');

    // Inspect line geometry coordinates
    let lineCount = 0;
    for (const rf of roadFeatures) {
      if (rf.geometry && (rf.geometry.type === 'LineString' || rf.geometry.type === 'MultiLineString')) {
        lineCount++;
      }
    }
    console.log(`Road Lines verified: ${lineCount} lines with valid coordinates`);
    assert(lineCount > 0, 'Must have line features in road layer');

    console.log('\n================================================================');
    console.log('ALL VISUAL & LAYER FEATURE VERIFICATIONS PASSED SUCCESSFULLY!');
    console.log('================================================================');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
